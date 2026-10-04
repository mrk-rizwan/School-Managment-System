import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { AudienceKind, AudienceRole, StudentStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// The tenant table announcement_audiences (contracts/slice-14.md §4, §11 item 3), the target reads
// of the §4.2 scope rules and the set-based reads of §4.3's resolution. A draft's audience rows
// are replaced on PATCH (decision 12); the other announcement tables are append-only.

export interface AudienceRow {
  kind: AudienceKind;
  /** The one target column the kind names, or null for a broad kind. */
  targetId: bigint | null;
  roles: AudienceRole[];
}

export interface AudienceRowWithName extends AudienceRow {
  announcementId: bigint;
  targetName: string | null;
}

/** A guardian's live link to a student, as resolution reads it. */
export interface GuardianLink {
  guardianId: bigint;
  studentId: bigint;
}

/** Which students a resolution read covers. */
export type StudentFilter =
  | { kind: 'all' }
  /** Enrolled on `on` in one of the sections (slice 11 §3.1's predicate). */
  | { kind: 'sections'; sectionIds: readonly bigint[]; on: Date }
  /** Enrolled on `on` in any section of the class. */
  | { kind: 'class'; classId: bigint; on: Date }
  | { kind: 'ids'; studentIds: readonly bigint[] };

type TargetColumns = Pick<
  Prisma.AnnouncementAudienceUncheckedCreateInput,
  'classId' | 'sectionId' | 'studentId' | 'guardianId' | 'staffId'
>;

/** The one target column a kind names (CHECK announcement_audiences_target_check). */
function targetColumns(kind: AudienceKind, id: bigint | null): TargetColumns {
  if (id === null) return {};
  switch (kind) {
    case 'class':
      return { classId: id };
    case 'section':
      return { sectionId: id };
    case 'student':
      return { studentId: id };
    case 'guardian':
      return { guardianId: id };
    case 'staff_member':
      return { staffId: id };
    default:
      return {};
  }
}

const ROW_SELECT = {
  announcementId: true,
  kind: true,
  classId: true,
  sectionId: true,
  studentId: true,
  guardianId: true,
  staffId: true,
  roles: true,
} satisfies Prisma.AnnouncementAudienceSelect;

type Row = Prisma.AnnouncementAudienceGetPayload<{ select: typeof ROW_SELECT }>;

const targetOf = (row: Row): bigint | null =>
  row.classId ?? row.sectionId ?? row.studentId ?? row.guardianId ?? row.staffId;

/** The student condition of a filter: active, and enrolled on the date in the sections. */
function studentsWhere(filter: StudentFilter, activeOnly: boolean): Prisma.StudentWhereInput {
  const status = activeOnly ? { status: 'active' as const } : {};
  switch (filter.kind) {
    case 'all':
      return status;
    case 'ids':
      return { ...status, id: { in: [...filter.studentIds] } };
    case 'sections':
    case 'class':
      return {
        ...status,
        enrolments: {
          some: {
            ...(filter.kind === 'class'
              ? { classId: filter.classId }
              : { sectionId: { in: [...filter.sectionIds] } }),
            startedOn: { lte: filter.on },
            OR: [{ endedOn: null }, { endedOn: { gte: filter.on } }],
          },
        },
      };
  }
}

@Injectable()
export class AnnouncementAudienceRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  // ------------------------------------------------------------------------- audience rows

  /** The whole set, replaced: a draft's audience is a form field (decision 12). */
  async replace(schoolId: SchoolId, announcementId: bigint, rows: readonly AudienceRow[]): Promise<void> {
    await this.txHost.tx.announcementAudience.deleteMany({ where: { schoolId, announcementId } });
    await this.txHost.tx.announcementAudience.createMany({
      data: rows.map((row) => ({
        schoolId,
        announcementId,
        kind: row.kind,
        roles: row.roles,
        ...targetColumns(row.kind, row.targetId),
      })),
    });
  }

  /** The audiences of these announcements with their targets' display names, two reads per kind at most. */
  async forAnnouncements(schoolId: SchoolId, announcementIds: readonly bigint[]): Promise<AudienceRowWithName[]> {
    if (announcementIds.length === 0) return [];
    const rows = await this.txHost.tx.announcementAudience.findMany({
      where: { schoolId, announcementId: { in: [...announcementIds] } },
      select: ROW_SELECT,
      orderBy: { id: 'asc' },
    });
    const names = await this.namesOf(
      schoolId,
      rows.map((row) => ({ kind: row.kind, targetId: targetOf(row) })),
    );
    return rows.map((row) => {
      const targetId = targetOf(row);
      return {
        announcementId: row.announcementId,
        kind: row.kind,
        targetId,
        roles: row.roles,
        targetName: targetId === null ? null : (names.get(`${row.kind}:${targetId}`) ?? null),
      };
    });
  }

  /**
   * The display names of targets (AudienceDto.targetName), keyed `<kind>:<id>`: the class name,
   * "{class} {section}", the student's, guardian's or staff member's full name. One read per kind.
   */
  async namesOf(
    schoolId: SchoolId,
    targets: readonly { kind: AudienceKind; targetId: bigint | null }[],
  ): Promise<Map<string, string>> {
    const ids = (kind: AudienceKind): bigint[] => [
      ...new Set(targets.flatMap((t) => (t.kind === kind && t.targetId !== null ? [t.targetId] : []))),
    ];
    const names = new Map<string, string>();
    const tx = this.txHost.tx;
    const classIds = ids('class');
    if (classIds.length > 0) {
      for (const c of await tx.class.findMany({ where: { schoolId, id: { in: classIds } }, select: { id: true, name: true } })) {
        names.set(`class:${c.id}`, c.name);
      }
    }
    const sectionIds = ids('section');
    if (sectionIds.length > 0) {
      const sections = await tx.section.findMany({
        where: { schoolId, id: { in: sectionIds } },
        select: { id: true, name: true, class: { select: { name: true } } },
      });
      for (const s of sections) names.set(`section:${s.id}`, `${s.class.name} ${s.name}`);
    }
    const studentIds = ids('student');
    if (studentIds.length > 0) {
      for (const s of await tx.student.findMany({ where: { schoolId, id: { in: studentIds } }, select: { id: true, fullName: true } })) {
        names.set(`student:${s.id}`, s.fullName);
      }
    }
    const guardianIds = ids('guardian');
    if (guardianIds.length > 0) {
      for (const g of await tx.guardian.findMany({ where: { schoolId, id: { in: guardianIds } }, select: { id: true, fullName: true } })) {
        names.set(`guardian:${g.id}`, g.fullName);
      }
    }
    const staffIds = ids('staff_member');
    if (staffIds.length > 0) {
      for (const s of await tx.staff.findMany({ where: { schoolId, id: { in: staffIds } }, select: { id: true, fullName: true } })) {
        names.set(`staff_member:${s.id}`, s.fullName);
      }
    }
    return names;
  }

  // ------------------------------------------------------------------- §4.2 target reads

  /** A class with its live (non-archived) section ids; null when absent in this school. */
  async classTarget(
    schoolId: SchoolId,
    id: bigint,
  ): Promise<{ archived: boolean; liveSectionIds: bigint[] } | null> {
    const row = await this.txHost.tx.class.findFirst({ where: { schoolId, id }, select: { status: true } });
    if (!row) return null;
    const sections = await this.txHost.tx.section.findMany({
      where: { schoolId, classId: id, deletedAt: null },
      select: { id: true },
    });
    return { archived: row.status === 'archived', liveSectionIds: sections.map((s) => s.id) };
  }

  async sectionTarget(schoolId: SchoolId, id: bigint): Promise<{ archived: boolean } | null> {
    const row = await this.txHost.tx.section.findFirst({ where: { schoolId, id }, select: { deletedAt: true } });
    return row && { archived: row.deletedAt !== null };
  }

  /** The student when inside `scope` (slice-6 §1's student.view rule), else null. */
  studentTarget(schoolId: SchoolId, scope: Scope, id: bigint): Promise<{ status: StudentStatus } | null> {
    return this.txHost.tx.student.findFirst({
      where: { schoolId, id, AND: [studentInScope(scope)] },
      select: { status: true },
    });
  }

  /**
   * The guardian when it has a live link to a student inside `scope` (§4.2), with its merge
   * state; null otherwise (absent, another school's or out of scope: one answer).
   */
  async guardianTarget(
    schoolId: SchoolId,
    scope: Scope,
    id: bigint,
  ): Promise<{ merged: boolean; mergedIntoId: bigint | null } | null> {
    const row = await this.txHost.tx.guardian.findFirst({
      where: {
        schoolId,
        id,
        studentLinks: { some: { schoolId, endedAt: null, student: { is: studentInScope(scope) } } },
      },
      select: { status: true, mergedIntoId: true },
    });
    return row && { merged: row.status === 'merged', mergedIntoId: row.mergedIntoId };
  }

  staffTarget(schoolId: SchoolId, id: bigint): Promise<{ status: 'active' | 'suspended' | 'left' } | null> {
    return this.txHost.tx.staff.findFirst({ where: { schoolId, id }, select: { status: true } });
  }

  // --------------------------------------------------------------- §4.3 resolution reads

  /**
   * Live links (ended_at null) from guardians not merged to the filter's students; `activeOnly`
   * also requires the student to be active (every kind but a named student, decision 4).
   */
  async guardianLinks(schoolId: SchoolId, filter: StudentFilter, activeOnly: boolean): Promise<GuardianLink[]> {
    return this.txHost.tx.studentGuardian.findMany({
      where: {
        schoolId,
        endedAt: null,
        guardian: { is: { status: 'active' } },
        student: { is: studentsWhere(filter, activeOnly) },
      },
      select: { guardianId: true, studentId: true },
      orderBy: [{ guardianId: 'asc' }, { studentId: 'asc' }],
    });
  }

  /** Active students of the filter with an active login (the caller checks student_login_enabled). */
  async reachableStudents(schoolId: SchoolId, filter: StudentFilter): Promise<bigint[]> {
    const rows = await this.txHost.tx.student.findMany({
      where: { schoolId, ...studentsWhere(filter, true), user: { is: { status: 'active' } } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** Active staff: all, or among `ids`. */
  async activeStaff(schoolId: SchoolId, ids?: readonly bigint[]): Promise<bigint[]> {
    const rows = await this.txHost.tx.staff.findMany({
      where: { schoolId, status: 'active', ...(ids === undefined ? {} : { id: { in: [...ids] } }) },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /**
   * §4.3 dedupe steps 1 and 2: the staff among `staffIds` who are one of `guardianIds` by login
   * (users.guardian_id and users.staff_id on one row) or by identity hash (equal cnic_hash).
   */
  async staffWhoAreGuardians(
    schoolId: SchoolId,
    staffIds: readonly bigint[],
    guardianIds: readonly bigint[],
  ): Promise<{ byUser: Set<bigint>; byIdentity: Set<bigint> }> {
    const byUser = new Set<bigint>();
    const byIdentity = new Set<bigint>();
    if (staffIds.length === 0 || guardianIds.length === 0) return { byUser, byIdentity };
    const tx = this.txHost.tx;
    const users = await tx.user.findMany({
      where: { schoolId, staffId: { in: [...staffIds] }, guardianId: { in: [...guardianIds] } },
      select: { staffId: true },
    });
    for (const u of users) if (u.staffId !== null) byUser.add(u.staffId);
    const staff = await tx.staff.findMany({
      where: { schoolId, id: { in: [...staffIds] }, cnicHash: { not: null } },
      select: { id: true, cnicHash: true },
    });
    const hashes = staff.flatMap((s) => (s.cnicHash === null ? [] : [s.cnicHash]));
    if (hashes.length > 0) {
      const guardians = await tx.guardian.findMany({
        where: { schoolId, id: { in: [...guardianIds] }, cnicHash: { in: hashes } },
        select: { cnicHash: true },
      });
      const guardianHashes = new Set(guardians.map((g) => g.cnicHash));
      for (const s of staff) if (!byUser.has(s.id) && guardianHashes.has(s.cnicHash)) byIdentity.add(s.id);
    }
    return { byUser, byIdentity };
  }
}
