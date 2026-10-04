// Audiences (contracts/slice-14.md §4): the shape rules (§4.1), the scope rules (§4.2, R144) and
// resolution to persons once each (§4.3, R145). Shared by create, patch, send, the preview, the
// scheduled job and the holiday notice.
import { Injectable } from '@nestjs/common';
import {
  AUDIENCE_ROLES,
  audiencesProblem,
  ErrorCode,
  normaliseAudiences,
  ROLE_AUDIENCE_KINDS,
  SCHOOL_WIDE_AUDIENCE_KINDS,
  type AudienceInput,
  type AudienceKind,
  type AudienceRole,
} from '@asms/shared';
import { ApiException, fieldRefused } from '../../common/errors/api-exception';
import { ContactResolver } from '../../messaging/contacts';
import {
  AnnouncementAudienceRepository,
  type AudienceRow,
  type GuardianLink,
  type StudentFilter,
} from '../../repositories/announcement-audience.repository';
import type { MessagePerson } from '../../repositories/message.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { classArchived } from '../academics/academics.shared';

/** One validated, normalised audience item. Roles are stored for every kind (both by default). */
export type AudienceItem = AudienceRow;

const includes = <T extends string>(list: readonly T[], value: string): value is T =>
  list.some((item) => item === value);

const takesRoles = (kind: AudienceKind): boolean => includes(ROLE_AUDIENCE_KINDS, kind);
export const isSchoolWide = (kind: AudienceKind): boolean => includes(SCHOOL_WIDE_AUDIENCE_KINDS, kind);

/** The path a §4.1 refusal names. */
function problemPath(index: number | null, reason: string): string {
  if (index === null) return 'audiences';
  if (reason === 'target_forbidden' || reason === 'target_required') return `audiences[${index}].targetId`;
  if (reason === 'roles_forbidden' || reason === 'roles_empty') return `audiences[${index}].roles`;
  return `audiences[${index}]`;
}

const PROBLEM_MESSAGES: Readonly<Record<string, string>> = {
  empty: 'audiences must have at least one item',
  too_many: 'audiences may have at most 20 items',
  everyone_not_alone: 'everyone combines with nothing',
  target_forbidden: 'targetId is not taken by this kind',
  target_required: 'targetId is required for this kind',
  roles_forbidden: 'roles are taken only by class, section and student',
  roles_empty: 'roles must hold one or two distinct values',
  duplicate: 'the same target appears twice; merge its roles',
};

/** §4.1: the shape rules (422 INVALID_VALUE), then the normalised, typed items. */
export function parseAudiences(audiences: readonly AudienceInput[]): AudienceItem[] {
  const problem = audiencesProblem(audiences);
  if (problem !== null) {
    throw fieldRefused(
      problemPath(problem.index, problem.reason),
      ErrorCode.INVALID_VALUE,
      PROBLEM_MESSAGES[problem.reason] ?? 'audiences are invalid',
    );
  }
  return normaliseAudiences(audiences).map((a) => ({
    kind: a.kind,
    targetId: a.targetId === undefined ? null : BigInt(a.targetId),
    roles: a.roles ?? [...AUDIENCE_ROLES],
  }));
}

/** The items as the API returns them (§2.2): roles `[]` for kinds that take none. */
export const rolesOf = (item: Pick<AudienceItem, 'kind' | 'roles'>): AudienceRole[] =>
  takesRoles(item.kind) ? item.roles : [];

/** What the sender's capability reaches today (§1.2). */
export interface SenderReach {
  /** Today's bound scope over the two keys (canAny). */
  scope: Scope;
  /** announcement.send.school is held. */
  school: boolean;
}

const targetNotFound = (index: number) =>
  fieldRefused(`audiences[${index}].targetId`, ErrorCode.REFERENCE_NOT_FOUND, 'The target does not exist.');

const sectionInScope = (scope: Scope, sectionId: bigint): boolean =>
  scope.kind === 'all' || (scope.kind === 'sections' && scope.ids.includes(sectionId));

/**
 * The §4.2 scope rules. `refuse` (create, patch, send now): the broad kinds without `.school` are
 * 403 before any target is read, then each item in order (422 one body for absent, another
 * school's or out of scope; 409 for a visible target that cannot be reached). `drop` (the
 * scheduled job, §5.6 step 2): an item that would be refused is dropped and counted.
 */
@Injectable()
export class AudienceRules {
  constructor(private readonly audiences: AnnouncementAudienceRepository) {}

  async check(
    schoolId: SchoolId,
    items: readonly AudienceItem[],
    reach: SenderReach | null,
    mode: 'refuse' | 'drop',
  ): Promise<{ kept: AudienceItem[]; dropped: number }> {
    if (mode === 'refuse') {
      if (reach === null) throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.');
      if (!reach.school && items.some((item) => isSchoolWide(item.kind))) {
        throw new ApiException(
          403,
          ErrorCode.PERMISSION_DENIED,
          'Only a sender who may announce to the whole school can choose this audience.',
          { reason: 'audience_requires_school' },
        );
      }
    }
    const kept: AudienceItem[] = [];
    let index = 0;
    for (const item of items) {
      const refusal = reach === null ? targetNotFound(index) : await this.refusal(schoolId, item, index, reach);
      if (refusal === null) kept.push(item);
      else if (mode === 'refuse') throw refusal;
      index++;
    }
    return { kept, dropped: items.length - kept.length };
  }

  /** Why the sender cannot reach this item today, or null. */
  private async refusal(
    schoolId: SchoolId,
    item: AudienceItem,
    index: number,
    reach: SenderReach,
  ): Promise<ApiException | null> {
    if (isSchoolWide(item.kind) && !reach.school) {
      return new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.', {
        reason: 'audience_requires_school',
      });
    }
    const id = item.targetId;
    if (id === null) return null;
    const { scope } = reach;
    switch (item.kind) {
      case 'class': {
        const klass = await this.audiences.classTarget(schoolId, id);
        if (!klass) return targetNotFound(index);
        if (
          scope.kind !== 'all' &&
          (klass.liveSectionIds.length === 0 || !klass.liveSectionIds.every((s) => sectionInScope(scope, s)))
        ) {
          return targetNotFound(index);
        }
        if (klass.archived) return classArchived();
        if (klass.liveSectionIds.length === 0) return targetNotFound(index);
        return null;
      }
      case 'section': {
        const section = await this.audiences.sectionTarget(schoolId, id);
        if (!section || !sectionInScope(scope, id)) return targetNotFound(index);
        if (section.archived) return new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'This section is archived.');
        return null;
      }
      case 'student': {
        const student = await this.audiences.studentTarget(schoolId, scope, id);
        if (!student) return targetNotFound(index);
        if (student.status === 'withdrawn' || student.status === 'transferred' || student.status === 'alumni') {
          return new ApiException(409, ErrorCode.STUDENT_NOT_ACTIVE, 'This student has left the school.');
        }
        return null;
      }
      case 'guardian': {
        const guardian = await this.audiences.guardianTarget(schoolId, scope, id);
        if (!guardian) return targetNotFound(index);
        if (guardian.merged) {
          return new ApiException(409, ErrorCode.GUARDIAN_MERGED, 'This guardian was merged into another record.', {
            mergedIntoId: guardian.mergedIntoId?.toString() ?? null,
          });
        }
        return null;
      }
      case 'staff_member': {
        const staff = await this.audiences.staffTarget(schoolId, id);
        if (!staff) return targetNotFound(index);
        if (staff.status === 'left') {
          return new ApiException(409, ErrorCode.STAFF_NOT_ACTIVE, 'This staff member is not active.');
        }
        return null;
      }
      default:
        return null;
    }
  }
}

/** One person an announcement resolves to, with the students that put a guardian there. */
export interface ResolvedPerson {
  person: MessagePerson;
  studentIds: bigint[];
}

export interface Resolution {
  /** Guardians by id, then staff by id, then students by id: the dedupe and send order. */
  persons: ResolvedPerson[];
  /** Persons each item contributed before dedupe, in item order. */
  byItem: number[];
  counts: { total: number; guardians: number; staff: number; students: number };
  dedupedByUser: number;
  dedupedByIdentity: number;
}

const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * §4.3 (R145): set-based reads per item on the send date, then dedupe by user and by identity
 * hash (the guardian stays). Phone dedupe is NotificationService's `dedupePhones`. `can_login` is
 * irrelevant (decision 3); "active student" is `status = active` (decision 4) except for a named
 * student.
 */
@Injectable()
export class AudienceResolver {
  constructor(
    private readonly audiences: AnnouncementAudienceRepository,
    private readonly contacts: ContactResolver,
    private readonly settings: SchoolSettingsRepository,
  ) {}

  async resolve(schoolId: SchoolId, items: readonly AudienceItem[], on: Date): Promise<Resolution> {
    const studentLogins = await this.settings.studentLoginEnabled(schoolId);
    const guardians = new Map<bigint, Set<bigint>>();
    const staff = new Set<bigint>();
    const students = new Set<bigint>();
    const byItem: number[] = [];

    const addLinks = (links: readonly GuardianLink[]): number => {
      const before = new Set<bigint>();
      for (const link of links) {
        before.add(link.guardianId);
        const set = guardians.get(link.guardianId) ?? new Set<bigint>();
        set.add(link.studentId);
        guardians.set(link.guardianId, set);
      }
      return before.size;
    };
    const addAll = (target: Set<bigint>, ids: readonly bigint[]): number => {
      for (const id of ids) target.add(id);
      return ids.length;
    };
    const reachable = (filter: StudentFilter) =>
      studentLogins ? this.audiences.reachableStudents(schoolId, filter) : Promise.resolve([]);

    for (const item of items) {
      const parents = item.roles.includes('parents');
      const pupils = item.roles.includes('students');
      let persons = 0;
      const id = item.targetId;
      switch (item.kind) {
        case 'everyone':
        case 'parents':
        case 'students':
        case 'staff': {
          const all: StudentFilter = { kind: 'all' };
          if (item.kind === 'everyone' || item.kind === 'parents') {
            persons += addLinks(await this.audiences.guardianLinks(schoolId, all, true));
          }
          if (item.kind === 'everyone' || item.kind === 'students') persons += addAll(students, await reachable(all));
          if (item.kind === 'everyone' || item.kind === 'staff') {
            persons += addAll(staff, await this.audiences.activeStaff(schoolId));
          }
          break;
        }
        case 'class':
        case 'section':
        case 'student': {
          if (id === null) break;
          const filter: StudentFilter =
            item.kind === 'class'
              ? { kind: 'class', classId: id, on }
              : item.kind === 'section'
                ? { kind: 'sections', sectionIds: [id], on }
                : { kind: 'ids', studentIds: [id] };
          if (parents) {
            persons += addLinks(await this.audiences.guardianLinks(schoolId, filter, item.kind !== 'student'));
          }
          if (pupils) persons += addAll(students, await reachable(filter));
          break;
        }
        case 'guardian': {
          if (id === null) break;
          // The survivor when merged since the item was chosen (§4.3).
          for (const r of await this.contacts.survivors(schoolId, [{ guardianId: id }])) {
            if ('guardianId' in r) {
              if (!guardians.has(r.guardianId)) guardians.set(r.guardianId, new Set());
              persons++;
            }
          }
          break;
        }
        case 'staff_member':
          if (id !== null) persons += addAll(staff, await this.audiences.activeStaff(schoolId, [id]));
          break;
      }
      byItem.push(persons);
    }

    const guardianIds = [...guardians.keys()].sort(ascending);
    const { byUser, byIdentity } = await this.audiences.staffWhoAreGuardians(schoolId, [...staff], guardianIds);
    const staffIds = [...staff].filter((s) => !byUser.has(s) && !byIdentity.has(s)).sort(ascending);
    const studentIds = [...students].sort(ascending);
    const persons: ResolvedPerson[] = [
      ...guardianIds.map((guardianId) => ({
        person: { guardianId },
        studentIds: [...(guardians.get(guardianId) ?? [])].sort(ascending),
      })),
      ...staffIds.map((staffId) => ({ person: { staffId }, studentIds: [] })),
      ...studentIds.map((studentId) => ({ person: { studentId }, studentIds: [] })),
    ];
    return {
      persons,
      byItem,
      counts: {
        total: persons.length,
        guardians: guardianIds.length,
        staff: staffIds.length,
        students: studentIds.length,
      },
      dedupedByUser: byUser.size,
      dedupedByIdentity: byIdentity.size,
    };
  }
}
