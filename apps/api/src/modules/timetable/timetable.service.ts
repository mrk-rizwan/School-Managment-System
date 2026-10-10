import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, roomKey, timetableClashes } from '@asms/shared';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page } from '../../common/pagination';
import type { ReasonDto } from '../../common/reason.dto';
import { addDays, daysBetween, SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { SchoolSettingsReader } from '../../common/school-settings-reader';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { TimetableReadsRepository, type VersionSpan } from '../../repositories/timetable-reads.repository';
import {
  TimetableRepository,
  type NewSlot,
  type SubstitutionRecord,
  type TimetableSection,
  type VersionRecord,
} from '../../repositories/timetable.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString, yearClosed } from '../academics/academics.shared';
import { CalendarService } from '../calendar/calendar.service';
import type {
  CreateSubstitutionDto,
  CreateTimetableVersionDto,
  ListSubstitutionsQueryDto,
  ListTimetableVersionsQueryDto,
  TimetableSubstitutionDto,
  TimetableVersionDetailDto,
  TimetableVersionDto,
} from './timetable.dto';
import { assignmentDayOf, clashRefusal, toSlotDto, versionStatus, weekdayOf } from './timetable.shared';

// contracts/slice-37.md §2.2-§2.4 (R301-R303, R306): versions and substitutions, written by
// timetable.manage holders. Each keyed create runs in one transaction whose first statement is
// the idempotency claim.

const VERSION_ENDPOINT = 'timetable_versions';
const SUBSTITUTION_ENDPOINT = 'timetable_substitutions';
const VERSION_SUBJECT = 'timetable_version';
const SUBSTITUTION_SUBJECT = 'timetable_substitution';
/** §1: a substitutions list spans at most 92 days. */
const SUBSTITUTION_RANGE_DAYS = 92;

export type VersionCreateOutcome = { replayed: boolean; version: TimetableVersionDetailDto };
export type SubstitutionCreateOutcome = { replayed: boolean; substitution: TimetableSubstitutionDto };

const supersededBy = (versionId: bigint) =>
  new ApiException(
    409,
    ErrorCode.TIMETABLE_VERSION_SUPERSEDED,
    'This section already has a timetable starting on that date or after it. Void it first.',
    { versionId: versionId.toString() },
  );

/**
 * Wave R review: a version change would leave these live substitutions pointing at slots that no
 * longer exist (R304 access, R305, R307 and the substitute's booking would all read them).
 */
const substitutionsExist = (ids: readonly bigint[]) =>
  new ApiException(
    409,
    ErrorCode.TIMETABLE_SUBSTITUTIONS_EXIST,
    'Substitutions are booked on the dates this change affects. Void them first.',
    { substitutionIds: ids.map((id) => id.toString()) },
  );

@Injectable()
export class TimetableService {
  constructor(
    private readonly context: SchoolContext,
    private readonly timetable: TimetableRepository,
    private readonly reads: TimetableReadsRepository,
    private readonly idempotency: IdempotentRequests,
    private readonly calendar: CalendarService,
    private readonly settings: SchoolSettingsReader,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ------------------------------------------------------------------------------ versions

  async listVersions(query: ListTimetableVersionsQueryDto): Promise<Page<TimetableVersionDto>> {
    const schoolId = this.context.schoolId;
    const today = await this.clock.today(schoolId);
    const { rows, total } = await this.timetable.listVersions(schoolId, {
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: BigInt(query.academicYearId) }),
      ...(query.status === undefined ? {} : { status: query.status }),
      today,
      sort: query.sort ?? '-effectiveFrom',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.versionDtos(schoolId, rows, today), query, total);
  }

  async getVersion(id: bigint): Promise<TimetableVersionDetailDto> {
    const schoolId = this.context.schoolId;
    const version = await this.timetable.findVersion(schoolId, id);
    if (!version) throw notFound();
    return this.detail(schoolId, version);
  }

  async createVersion(
    sectionId: bigint,
    dto: CreateTimetableVersionDto,
    rawKey: string | undefined,
  ): Promise<VersionCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, VERSION_ENDPOINT, sectionId, dto, rawKey, (claim) =>
      this.createVersionInTransaction(actor, sectionId, dto, claim),
    );
    if (outcome.replayed) return { replayed: true, version: await this.getVersion(outcome.subjectId) };
    return { replayed: false, version: outcome.value };
  }

  @Transactional()
  private async createVersionInTransaction(
    actor: Actor,
    sectionId: bigint,
    dto: CreateTimetableVersionDto,
    claim: IdempotencyClaim,
  ): Promise<TimetableVersionDetailDto> {
    const recordSubject = await this.idempotency.claim(actor, VERSION_ENDPOINT, claim, VERSION_SUBJECT);
    const { schoolId, userId } = actor;
    if ((dto.slots === undefined) === (dto.copyFromVersionId === undefined)) {
      throw fieldRefused('slots', ErrorCode.INVALID_VALUE, 'Give either slots or copyFromVersionId, not both');
    }
    const section = await this.liveSection(schoolId, sectionId);
    if (section.yearStatus === 'closed') throw yearClosed();
    const today = await this.clock.today(schoolId);
    const effectiveFrom = fromDateString(dto.effectiveFrom);
    if (effectiveFrom < today) {
      throw fieldRefused('effectiveFrom', ErrorCode.INVALID_VALUE, 'effectiveFrom must be today or later');
    }
    if (effectiveFrom < section.yearStartsOn || effectiveFrom > section.yearEndsOn) {
      throw fieldRefused('effectiveFrom', ErrorCode.INVALID_VALUE, 'effectiveFrom must be inside the academic year');
    }
    const settings = await this.settings.read(schoolId);
    const slots = await this.slotsOf(schoolId, section, dto, settings.periodsPerDay);

    // Step 1: a later version blocks (void it first).
    const later = await this.timetable.laterVersion(schoolId, sectionId, effectiveFrom);
    if (later) throw supersededBy(later.id);
    // Wave R review: no live substitution of the section from effectiveFrom on may outlive its slot.
    const orphaned = await this.timetable.liveSubstitutionIds(schoolId, sectionId, effectiveFrom, null);
    if (orphaned.length > 0) throw substitutionsExist(orphaned);
    // Step 2: R302 by the shared function, against the other sections' slots from effectiveFrom on.
    const others = await this.timetable.otherSlotsMeeting(schoolId, sectionId, effectiveFrom, null);
    const [clash] = timetableClashes(
      slots.map((s) => ({ weekday: s.weekday, period: s.period, staffId: s.staffId.toString(), room: s.room })),
      {
        periodsPerDay: settings.periodsPerDay,
        weeklyOffDays: settings.weeklyOffDays,
        others: others.map((o) => ({
          id: o.id.toString(),
          sectionId: o.sectionId.toString(),
          weekday: o.weekday,
          period: o.period,
          staffId: o.staffId.toString(),
          room: o.room,
        })),
      },
    );
    if (clash) throw clashRefusal(clash);
    // Step 3: R303 on effectiveFrom.
    await this.assertAssigned(schoolId, section, slots, effectiveFrom);

    // Step 4: the supersede, in the §3.2 order.
    const predecessor = await this.timetable.lockLiveOn(schoolId, sectionId, effectiveFrom);
    if (predecessor) await this.timetable.setEffectiveTo(schoolId, predecessor.id, addDays(effectiveFrom, -1));
    const version = await this.timetable.createVersion(schoolId, {
      sectionId,
      classId: section.classId,
      academicYearId: section.academicYearId,
      effectiveFrom,
      createdBy: userId,
    });
    await this.timetable.createSlots(schoolId, version, slots);
    await recordSubject(version.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'timetable_version.created',
      subjectType: VERSION_SUBJECT,
      subjectId: version.id,
      metadata: {
        sectionId: sectionId.toString(),
        effectiveFrom: dto.effectiveFrom,
        slots: slots.length,
        supersededVersionId: predecessor?.id.toString() ?? null,
        copiedFromVersionId: dto.copyFromVersionId ?? null,
      },
    });
    return this.detail(schoolId, version);
  }

  /** §2.3: a future version only; restores its predecessor after re-checking clashes. */
  @Transactional()
  async voidVersion(id: bigint, dto: ReasonDto): Promise<TimetableVersionDetailDto> {
    const { schoolId, userId } = this.context.actor();
    const version = await readLocked(
      () => this.timetable.findVersion(schoolId, id),
      (row) => this.timetable.lockUnchanged(schoolId, row),
    );
    if (version.voidedAt !== null) return this.detail(schoolId, version);
    const today = await this.clock.today(schoolId);
    // R301 (wave R review): a version starting today or later may be voided — a same-day
    // correction; the predecessor's restore and its clash re-check cover it.
    if (version.effectiveFrom < today) {
      throw new ApiException(
        409,
        ErrorCode.TIMETABLE_VERSION_NOT_FUTURE,
        'Only a timetable starting today or later can be voided. Make a new one from a later date instead.',
        { versionId: version.id.toString() },
      );
    }
    const orphaned = await this.timetable.liveSubstitutionIds(
      schoolId,
      version.sectionId,
      version.effectiveFrom,
      version.effectiveTo,
    );
    if (orphaned.length > 0) throw substitutionsExist(orphaned);
    const predecessor = await this.timetable.predecessorOf(schoolId, version.sectionId, addDays(version.effectiveFrom, -1));
    if (predecessor) {
      if (!(await this.timetable.lockUnchanged(schoolId, predecessor))) {
        throw new ApiException(409, ErrorCode.CONCURRENT_UPDATE, 'This changed while you were working. Reload and try again.');
      }
      // R301: the predecessor's slots grow back over the voided range; another section may have
      // taken a teacher or room there meanwhile.
      const mine = await this.timetable.slotInputsOf(schoolId, predecessor.id);
      const others = await this.timetable.otherSlotsMeeting(
        schoolId,
        version.sectionId,
        version.effectiveFrom,
        version.effectiveTo,
      );
      const [clash] = timetableClashes(
        mine.map((s) => ({ weekday: s.weekday, period: s.period, staffId: s.staffId.toString(), room: s.room })),
        {
          // The predecessor's own slots already passed the period and off-day rules.
          periodsPerDay: 12,
          weeklyOffDays: [],
          others: others.map((o) => ({
            id: o.id.toString(),
            sectionId: o.sectionId.toString(),
            weekday: o.weekday,
            period: o.period,
            staffId: o.staffId.toString(),
            room: o.room,
          })),
        },
      ).filter((c) => c.kind === 'teacher' || c.kind === 'room');
      if (clash) throw clashRefusal(clash);
    }
    const now = this.clock.now();
    await this.timetable.voidVersion(schoolId, version.id, userId, dto.reason, now);
    if (predecessor) await this.timetable.setEffectiveTo(schoolId, predecessor.id, version.effectiveTo);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'timetable_version.voided',
      subjectType: VERSION_SUBJECT,
      subjectId: version.id,
      reason: dto.reason,
      metadata: {
        sectionId: version.sectionId.toString(),
        effectiveFrom: toDateString(version.effectiveFrom),
        restoredVersionId: predecessor?.id.toString() ?? null,
      },
    });
    const voided = await this.timetable.findVersion(schoolId, version.id);
    if (!voided) throw notFound();
    return this.detail(schoolId, voided);
  }

  // ------------------------------------------------------------------------------ substitutions

  async listSubstitutions(query: ListSubstitutionsQueryDto): Promise<Page<TimetableSubstitutionDto>> {
    const schoolId = this.context.schoolId;
    const from = query.from === undefined ? undefined : fromDateString(query.from);
    const to = query.to === undefined ? undefined : fromDateString(query.to);
    if (from !== undefined && to !== undefined) {
      if (to < from) throw fieldRefused('to', ErrorCode.INVALID_VALUE, 'to must not be before from');
      if (daysBetween(from, to) > SUBSTITUTION_RANGE_DAYS) {
        throw fieldRefused('to', ErrorCode.INVALID_VALUE, `from and to are at most ${SUBSTITUTION_RANGE_DAYS} days apart`);
      }
    }
    const { rows, total } = await this.timetable.listSubstitutions(schoolId, {
      ...(query.sectionId === undefined ? {} : { sectionId: BigInt(query.sectionId) }),
      ...(query.staffId === undefined ? {} : { staffId: BigInt(query.staffId) }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      includeVoided: query.includeVoided ?? false,
      sort: query.sort ?? '-date',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.substitutionDtos(schoolId, rows), query, total);
  }

  async createSubstitution(
    sectionId: bigint,
    dto: CreateSubstitutionDto,
    rawKey: string | undefined,
  ): Promise<SubstitutionCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(
      actor,
      SUBSTITUTION_ENDPOINT,
      sectionId,
      dto,
      rawKey,
      (claim) => this.createSubstitutionInTransaction(actor, sectionId, dto, claim),
    );
    if (outcome.replayed) {
      const row = await this.timetable.findSubstitution(actor.schoolId, outcome.subjectId);
      if (!row) throw notFound();
      return { replayed: true, substitution: await this.substitutionDto(actor.schoolId, row) };
    }
    return { replayed: false, substitution: outcome.value };
  }

  @Transactional()
  private async createSubstitutionInTransaction(
    actor: Actor,
    sectionId: bigint,
    dto: CreateSubstitutionDto,
    claim: IdempotencyClaim,
  ): Promise<TimetableSubstitutionDto> {
    const recordSubject = await this.idempotency.claim(actor, SUBSTITUTION_ENDPOINT, claim, SUBSTITUTION_SUBJECT);
    const { schoolId, userId } = actor;
    const section = await this.liveSection(schoolId, sectionId);
    const date = fromDateString(dto.date);
    if (date < section.yearStartsOn || date > section.yearEndsOn) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date is outside the academic year');
    }
    const today = await this.clock.today(schoolId);
    const settings = await this.settings.read(schoolId);
    if (date < today && daysBetween(date, today) > settings.windowDays) {
      throw fieldRefused('date', ErrorCode.INVALID_VALUE, 'date is before the attendance amendment window');
    }
    if (dto.period > settings.periodsPerDay) {
      throw fieldRefused('period', ErrorCode.INVALID_VALUE, `period must be at most ${settings.periodsPerDay}, the school's periods per day`);
    }
    if (!(await this.calendar.isTeachingDay(schoolId, date))) {
      throw new ApiException(409, ErrorCode.NOT_A_TEACHING_DAY, 'That date is not a teaching day.');
    }
    const staffId = BigInt(dto.staffId);
    if (!(await this.timetable.activeStaffIds(schoolId, [staffId])).has(staffId)) {
      throw fieldRefused('staffId', ErrorCode.REFERENCE_NOT_FOUND, 'No active staff member with that id');
    }
    const at = { sectionId: sectionId.toString(), date: dto.date, period: dto.period };
    const access = await this.reads.periodAccess(schoolId, { sectionId, date, period: dto.period, staffId });
    if (!access.live || access.slotStaffId === null) {
      throw new ApiException(
        409,
        ErrorCode.TIMETABLE_SUBSTITUTION_NOT_TIMETABLED,
        'That period is not on the timetable for that day.',
        at,
      );
    }
    if (access.slotStaffId === staffId) {
      throw new ApiException(
        409,
        ErrorCode.TIMETABLE_SUBSTITUTION_SAME_TEACHER,
        'That teacher already takes this period.',
        at,
      );
    }
    const existing = await this.timetable.liveSubstitutionClash(schoolId, { sectionId, staffId, date, period: dto.period });
    if (existing) {
      throw new ApiException(
        409,
        ErrorCode.TIMETABLE_SUBSTITUTION_EXISTS,
        existing.sectionId === sectionId
          ? 'That period already has a substitution.'
          : 'That teacher already substitutes in that period.',
        { ...at, substitutionId: existing.id.toString() },
      );
    }
    // Rule 33: the substitute is in one place per period — not timetabled elsewhere then, unless
    // a substitution already takes that slot from them.
    const own = (await this.reads.staffSlotsBetween(schoolId, staffId, date, date)).filter(
      (s) => s.weekday === weekdayOf(date) && s.period === dto.period && s.sectionId !== sectionId,
    );
    for (const slot of own) {
      const taken = await this.reads.substitutionsBetween(schoolId, {
        sectionIds: [slot.sectionId],
        from: date,
        to: date,
      });
      if (!taken.some((t) => t.period === dto.period)) {
        throw new ApiException(409, ErrorCode.TIMETABLE_SLOT_CLASH, 'That teacher is timetabled elsewhere in that period.', {
          kind: 'teacher',
          weekday: slot.weekday,
          period: slot.period,
          conflictingSlotId: slot.id.toString(),
        });
      }
    }
    const row = await this.timetable.createSubstitution(schoolId, {
      sectionId,
      classId: section.classId,
      date,
      period: dto.period,
      staffId,
      reason: dto.reason,
      createdBy: userId,
    });
    await recordSubject(row.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'timetable_substitution.created',
      subjectType: SUBSTITUTION_SUBJECT,
      subjectId: row.id,
      reason: dto.reason,
      metadata: {
        sectionId: sectionId.toString(),
        date: dto.date,
        period: dto.period,
        staffId: staffId.toString(),
        regularStaffId: access.slotStaffId.toString(),
      },
    });
    return this.substitutionDto(schoolId, row);
  }

  @Transactional()
  async voidSubstitution(id: bigint, dto: ReasonDto): Promise<TimetableSubstitutionDto> {
    const { schoolId, userId } = this.context.actor();
    const row = await this.timetable.findSubstitution(schoolId, id);
    if (!row) throw notFound();
    if (row.voidedAt === null && (await this.timetable.voidSubstitution(schoolId, id, userId, dto.reason, this.clock.now()))) {
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'timetable_substitution.voided',
        subjectType: SUBSTITUTION_SUBJECT,
        subjectId: row.id,
        reason: dto.reason,
        metadata: { sectionId: row.sectionId.toString(), date: toDateString(row.date), period: row.period },
      });
    }
    const after = await this.timetable.findSubstitution(schoolId, id);
    if (!after) throw notFound();
    return this.substitutionDto(schoolId, after);
  }

  // ------------------------------------------------------------------------------ helpers

  /** A live section (an archived one is 404, as absent). */
  private async liveSection(schoolId: SchoolId, sectionId: bigint): Promise<TimetableSection> {
    const section = await this.timetable.findSection(schoolId, sectionId);
    if (!section || section.deletedAt !== null) throw notFound();
    return section;
  }

  /** §2.2: the request's slots, or the copy source's, each checked against the class and staff. */
  private async slotsOf(
    schoolId: SchoolId,
    section: TimetableSection,
    dto: CreateTimetableVersionDto,
    periodsPerDay: number,
  ): Promise<NewSlot[]> {
    let slots: NewSlot[];
    let path = (i: number, field: string) => `slots[${i}].${field}`;
    if (dto.copyFromVersionId !== undefined) {
      const source = await this.timetable.findVersion(schoolId, BigInt(dto.copyFromVersionId));
      if (!source || source.classId !== section.classId) {
        throw fieldRefused('copyFromVersionId', ErrorCode.REFERENCE_NOT_FOUND, 'No version of this class with that id');
      }
      slots = await this.timetable.slotInputsOf(schoolId, source.id);
      path = () => 'copyFromVersionId';
    } else {
      slots = (dto.slots ?? []).map((s) => ({
        weekday: s.weekday,
        period: s.period,
        classSubjectId: BigInt(s.classSubjectId),
        staffId: BigInt(s.staffId),
        room: s.room === undefined || s.room === null || roomKey(s.room) === null ? null : s.room.trim(),
      }));
    }
    const over = slots.findIndex((s) => s.period > periodsPerDay);
    if (over >= 0) {
      throw fieldRefused(path(over, 'period'), ErrorCode.INVALID_VALUE, `period must be at most ${periodsPerDay}, the school's periods per day`);
    }
    const live = new Set(
      (await this.timetable.liveClassSubjects(schoolId, section.classId, slots.map((s) => s.classSubjectId))).map((c) => c.id),
    );
    const badSubject = slots.findIndex((s) => !live.has(s.classSubjectId));
    if (badSubject >= 0) {
      throw fieldRefused(path(badSubject, 'classSubjectId'), ErrorCode.REFERENCE_NOT_FOUND, "Not a live subject of this section's class");
    }
    const active = await this.timetable.activeStaffIds(schoolId, slots.map((s) => s.staffId));
    const badStaff = slots.findIndex((s) => !active.has(s.staffId));
    if (badStaff >= 0) {
      throw fieldRefused(path(badStaff, 'staffId'), ErrorCode.REFERENCE_NOT_FOUND, 'No active staff member with that id');
    }
    return slots;
  }

  /** R303: each slot's teacher teaches its subject in the section on `on`. */
  private async assertAssigned(schoolId: SchoolId, section: TimetableSection, slots: readonly NewSlot[], on: Date): Promise<void> {
    const subjects = new Map(
      (await this.timetable.liveClassSubjects(schoolId, section.classId, slots.map((s) => s.classSubjectId))).map((c) => [
        c.id,
        c.subjectId,
      ]),
    );
    const assignments = await this.reads.subjectAssignments(schoolId, [section.classId], on, on);
    for (const slot of slots) {
      const subjectId = subjects.get(slot.classSubjectId);
      const held = assignments.some(
        (a) =>
          a.staffId === slot.staffId &&
          a.subjectId === subjectId &&
          (a.sectionId === null || a.sectionId === section.id),
      );
      if (!held) {
        throw new ApiException(
          409,
          ErrorCode.TIMETABLE_TEACHER_NOT_ASSIGNED,
          'The teacher does not teach that subject in this section on that date.',
          { staffId: slot.staffId.toString(), classSubjectId: slot.classSubjectId.toString(), sectionId: section.id.toString() },
        );
      }
    }
  }

  private async detail(schoolId: SchoolId, version: VersionRecord): Promise<TimetableVersionDetailDto> {
    const today = await this.clock.today(schoolId);
    const [dto] = await this.versionDtos(schoolId, [version], today);
    if (!dto) throw notFound();
    const span: VersionSpan = version;
    const slots = await this.reads.slotsOfVersions(schoolId, [span]);
    const on = assignmentDayOf(version, today);
    const assignments = await this.reads.subjectAssignments(schoolId, [version.classId], on, on);
    return { ...dto, slots: slots.map((s) => toSlotDto(s, assignments, on)) };
  }

  private async versionDtos(schoolId: SchoolId, rows: readonly VersionRecord[], today: Date): Promise<TimetableVersionDto[]> {
    if (rows.length === 0) return [];
    const labels = await this.reads.sectionLabels(schoolId, rows.map((r) => r.sectionId));
    const counts = await this.timetable.slotCounts(schoolId, rows.map((r) => r.id));
    const users = await this.timetable.userNames(
      schoolId,
      rows.flatMap((r) => (r.voidedBy === null ? [r.createdBy] : [r.createdBy, r.voidedBy])),
    );
    return rows.map((r) => {
      const label = labels.get(r.sectionId);
      return {
        id: r.id.toString(),
        sectionId: r.sectionId.toString(),
        sectionName: label?.sectionName ?? '',
        classId: r.classId.toString(),
        className: label?.className ?? '',
        academicYearId: r.academicYearId.toString(),
        effectiveFrom: toDateString(r.effectiveFrom),
        effectiveTo: r.effectiveTo === null ? null : toDateString(r.effectiveTo),
        status: versionStatus(r, today),
        slotCount: counts.get(r.id) ?? 0,
        createdByName: users.get(r.createdBy) ?? '',
        createdAt: r.createdAt,
        voidedAt: r.voidedAt,
        voidedByName: r.voidedBy === null ? null : (users.get(r.voidedBy) ?? null),
        voidReason: r.voidReason,
      };
    });
  }

  async substitutionDto(schoolId: SchoolId, row: SubstitutionRecord): Promise<TimetableSubstitutionDto> {
    const [dto] = await this.substitutionDtos(schoolId, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  /** A page of substitutions with names and each one's regular slot (a fixed number of statements). */
  async substitutionDtos(schoolId: SchoolId, rows: readonly SubstitutionRecord[]): Promise<TimetableSubstitutionDto[]> {
    if (rows.length === 0) return [];
    const dates = rows.map((r) => r.date);
    const from = dates.reduce((a, b) => (a < b ? a : b));
    const to = dates.reduce((a, b) => (a > b ? a : b));
    const sectionIds = rows.map((r) => r.sectionId);
    const labels = await this.reads.sectionLabels(schoolId, sectionIds);
    const versions = await this.reads.versionsBetween(schoolId, sectionIds, from, to);
    const slots = await this.reads.slotsOfVersions(schoolId, versions);
    const staff = await this.timetable.staffNames(schoolId, rows.map((r) => r.staffId));
    const users = await this.timetable.userNames(schoolId, rows.map((r) => r.createdBy));
    return rows.map((r) => {
      const version = versions.find(
        (v) => v.sectionId === r.sectionId && v.effectiveFrom <= r.date && (v.effectiveTo === null || v.effectiveTo >= r.date),
      );
      const slot =
        version === undefined
          ? undefined
          : slots.find((s) => s.versionId === version.id && s.weekday === weekdayOf(r.date) && s.period === r.period);
      const label = labels.get(r.sectionId);
      return {
        id: r.id.toString(),
        sectionId: r.sectionId.toString(),
        sectionName: label?.sectionName ?? '',
        classId: r.classId.toString(),
        className: label?.className ?? '',
        date: toDateString(r.date),
        period: r.period,
        staffId: r.staffId.toString(),
        teacherName: staff(r.staffId) ?? '',
        regularStaffId: slot?.staffId.toString() ?? null,
        regularTeacherName: slot?.staffName ?? null,
        subjectName: slot?.subjectName ?? null,
        reason: r.reason,
        createdByName: users.get(r.createdBy) ?? '',
        createdAt: r.createdAt,
        voidedAt: r.voidedAt,
        voidReason: r.voidReason,
      };
    });
  }
}
