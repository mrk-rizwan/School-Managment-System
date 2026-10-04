import { Injectable } from '@nestjs/common';
import { Capability, type SystemRole } from '@asms/shared';
import { CapabilityGrantRepository } from '../../repositories/capability-grant.repository';
import {
  CustomRoleRepository,
  type UserCustomRole,
} from '../../repositories/custom-role.repository';
import {
  StudentGuardianRepository,
  type GuardianChildLink,
} from '../../repositories/student-guardian.repository';
import { TeacherAssignmentRepository } from '../../repositories/teacher-assignment.repository';
import { UserRepository, type UserStatusValue } from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import type { DatedScope, Scope } from '../../tenancy/scope';
import {
  datedScopeAll,
  datedScopeSections,
  scopeAll,
  scopeSections,
  scopeStudents,
} from '../../tenancy/scope.mint';
import { notFound } from '../../common/errors/api-exception';
import { SchoolClock } from '../../common/school-clock';
import {
  capabilityOrder,
  effectivePermissions,
  type EffectiveLine,
  type GrantInput,
} from './effective-permissions';
import { notAssignedOnDate } from './access.errors';

/** The school roles a session can carry (contract slice-2 §4.1 `SchoolRole`). */
export const SCHOOL_ROLES = ['principal', 'office_staff', 'teacher', 'parent', 'student'] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

/** Which kinds of person the user currently is (contract §1.1 "Capacity"). */
export interface Capacities {
  /** staff_id set, staff active, at least one live role row (system or custom). */
  staff: boolean;
  /** guardian_id set (plan §6 stance). */
  guardian: boolean;
  /** student_id set, the student `active`, and student login enabled for the school (slice 6). */
  student: boolean;
}

/**
 * Everything authorisation needs about one user, computed from the database on every request
 * and never cached (R69).
 */
export interface UserAccess {
  userId: bigint;
  status: UserStatusValue;
  staffId: bigint | null;
  guardianId: bigint | null;
  /** users.student_id; the student capacity also needs the student active (Capacities.student). */
  studentId: bigint | null;
  capacities: Capacities;
  /** Live system-role rows, whatever the staff status (the users screen shows them). */
  systemRoles: readonly SystemRole[];
  /** The same rows with their user_roles ids, in assignment order (the permissions view). */
  systemRoleRows: readonly { userRoleId: bigint; systemRole: SystemRole }[];
  /** Live custom-role rows, whatever the staff status. */
  customRoles: readonly UserCustomRole[];
  /** Live grant and revoke rows. */
  grants: readonly GrantInput[];
  /** effectivePermissions() for this user, in registry order: empty without staff capacity (R59). */
  lines: readonly EffectiveLine[];
  /** Effective capabilities: exactly the keys of `lines`. */
  capabilities: ReadonlySet<Capability>;
}

/**
 * The ordinary row scope of a dated scope (contracts/slice-10.md §7.2), for a student-linked
 * repository call: school-wide stays school-wide, otherwise the sections held on that date.
 */
export function rowScope(dated: DatedScope): Scope {
  return dated.kind === 'all' ? scopeAll() : scopeSections([...dated.sections.keys()]);
}

/**
 * Effective permissions (plan §3.4, contracts/slice-7.md §1): system roles, custom roles, grants
 * and revokes through the pure effectivePermissions(); teacher scope from assignments (slice 4).
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly users: UserRepository,
    private readonly customRoles: CustomRoleRepository,
    private readonly grants: CapabilityGrantRepository,
    private readonly assignments: TeacherAssignmentRepository,
    private readonly studentGuardians: StudentGuardianRepository,
    private readonly clock: SchoolClock,
  ) {}

  /** The user's access, or null if the user does not exist in this school. */
  async load(schoolId: SchoolId, userId: bigint): Promise<UserAccess | null> {
    const row = await this.users.findAccess(schoolId, userId);
    if (!row) return null;
    // Sequential statements (§3.3); a user with no staff link has no role or grant rows to read.
    const customRoles =
      row.staffId === null ? [] : await this.customRoles.liveForUser(schoolId, userId);
    const grants =
      row.staffId === null
        ? []
        : (await this.grants.activeForUser(schoolId, userId)).map((g) => ({
            grantId: g.id,
            capabilityKey: g.capabilityKey,
            effect: g.effect,
          }));
    const staff =
      row.staffId !== null &&
      row.staffStatus === 'active' &&
      row.systemRoles.length + customRoles.length > 0;
    // R59: a user whose staff record is not active has no staff capability, whatever is stored.
    const lines = effectivePermissions({
      staffCapacity: staff,
      systemRoles: row.systemRoles,
      customRoles,
      grants,
    });
    return {
      userId: row.id,
      status: row.status,
      staffId: row.staffId,
      guardianId: row.guardianId,
      studentId: row.studentId,
      capacities: {
        staff,
        guardian: row.guardianId !== null,
        // contracts/slice-6.md §9: no capability; the role only (rule 13, roles are fixed).
        student:
          row.studentId !== null && row.studentStatus === 'active' && row.studentLoginEnabled,
      },
      systemRoles: row.systemRoles,
      systemRoleRows: row.systemRoleRows,
      customRoles,
      grants,
      lines,
      capabilities: new Set(lines.map((line) => line.capability)),
    };
  }

  /** Any active capacity at all: without one, login fails and sessions are refused (R71). */
  hasAnyCapacity(access: UserAccess): boolean {
    const { staff, guardian, student } = access.capacities;
    return staff || guardian || student;
  }

  /** The roles a session carries, from active capacities only (MeDto.roles). */
  roles(access: UserAccess): SchoolRole[] {
    const roles: SchoolRole[] = access.capacities.staff ? [...access.systemRoles] : [];
    if (access.capacities.guardian) roles.push('parent');
    if (access.capacities.student) roles.push('student');
    return roles;
  }

  /** Effective capabilities in registry order. */
  sortedCapabilities(access: UserAccess): Capability[] {
    return [...access.capabilities].sort(capabilityOrder);
  }

  holds(access: UserAccess, capability: Capability): boolean {
    return access.capabilities.has(capability);
  }

  /**
   * R14: every capability `target` holds or would hold is held by `actor`. The target side reads
   * its live role rows whatever its staff status: a suspended teacher has no effective
   * capability (R59), but reinstating it restores them, so an office clerk must not be able to
   * reset or disable it while it is suspended when they could not while it is active.
   */
  isSubset(target: UserAccess, actor: UserAccess): boolean {
    const dormant = effectivePermissions({
      staffCapacity: true,
      systemRoles: target.systemRoles,
      customRoles: target.customRoles,
      grants: target.grants,
    }).map((line) => line.capability);
    return [...target.capabilities, ...dormant].every((key) => actor.capabilities.has(key));
  }

  /**
   * A refusal (null) or the row scope the capability gives (plan §3.4, R79): the teacher's
   * sections when it comes only from the teacher default (contracts/slice-4.md §1), school-wide
   * from any other source (principal or office default, custom role, grant: slice-7 §1). An empty section list means no rows,
   * never no filter.
   */
  can(schoolId: SchoolId, access: UserAccess, capability: Capability): Promise<Scope | null> {
    return this.canAny(schoolId, access, [capability]);
  }

  /**
   * Any-of over several capabilities (@RequireCapability with more than one key): a refusal
   * (null) when none is held, else the widest scope: school-wide if any held key has a school-wide
   * source, otherwise the teacher's sections (read once).
   */
  async canAny(
    schoolId: SchoolId,
    access: UserAccess,
    capabilities: readonly Capability[],
  ): Promise<Scope | null> {
    // R59: no staff capacity, no capability, whatever rows are stored.
    if (!access.capacities.staff) return null;
    const held = capabilities.filter((key) => access.capabilities.has(key));
    if (held.length === 0) return null;
    const teacherOnly = new Set(
      access.lines.filter((l) => l.scope === 'assigned_sections').map((l) => l.capability),
    );
    const schoolWide = held.some((key) => !teacherOnly.has(key));
    return schoolWide ? scopeAll() : scopeSections(await this.teacherSections(schoolId, access));
  }

  /**
   * Dated, role-aware scope (R175, contracts/slice-10.md §7.2): null when the caller does not hold
   * `capability` (no staff capacity counts as not held, R59); school-wide when it has a
   * school-wide source (as canAny); otherwise the sections the caller holds a role in **on `on`**,
   * with the roles. An empty map means no rows. The route decorator gates the route; this gates
   * the row on the row's own date. Distinct from the synchronous `scopeOf(session)` (today's guard
   * scope), which is unchanged.
   */
  async scopeOf(
    session: SchoolSessionContext,
    { capability, on }: { capability: Capability; on: Date },
  ): Promise<DatedScope | null> {
    const { access, schoolId } = session;
    if (!access.capacities.staff || !access.capabilities.has(capability)) return null;
    const teacherOnly = access.lines.some(
      (line) => line.capability === capability && line.scope === 'assigned_sections',
    );
    if (!teacherOnly) return datedScopeAll(on);
    const sections =
      access.staffId === null
        ? new Map()
        : await this.assignments.sectionsOn(schoolId, access.staffId, on);
    return datedScopeSections(on, sections);
  }

  /**
   * The refusal of a dated, role-aware read or write whose dated scope does not reach the section
   * (main-thread ruling 2026-10-04): 403 not_assigned_on_date when the caller has ever held an
   * assignment reaching it (the section is theirs on other dates, so 404 would hide nothing), else
   * 404, the same body as absent. Used by attendance registers (slice-11 §1.2) and diary writes
   * (slice-13 §1.3) alike.
   */
  async refuseOutsideDate(session: SchoolSessionContext, sectionId: bigint): Promise<never> {
    const { staffId } = session.access;
    if (staffId !== null && (await this.assignments.everAssigned(session.schoolId, staffId, sectionId))) {
      throw notAssignedOnDate();
    }
    throw notFound();
  }

  /**
   * The row scope of a @RequireCapacity route (contracts/slice-13.md §1.2), bound by the access
   * guard exactly as a capability scope is. The caller's capacity was checked by the guard.
   */
  async capacityScope(
    schoolId: SchoolId,
    access: UserAccess,
    capacity: 'guardian' | 'student',
  ): Promise<Scope> {
    if (capacity === 'student') {
      // Student capacity already requires the student active and student login enabled.
      return scopeStudents(access.studentId === null ? [] : [access.studentId]);
    }
    return (await this.guardianChildren(schoolId, access)).scope;
  }

  /**
   * The guardian's children (R163): live links with `can_login`, the guardian not merged, whatever
   * the child's enrolment or status (R164). One read per request, never cached (R69). No guardian
   * capacity, or no such link: an empty scope, which matches no row.
   */
  async guardianChildren(
    schoolId: SchoolId,
    access: UserAccess,
  ): Promise<{ scope: Scope; children: GuardianChildLink[] }> {
    const children =
      access.capacities.guardian && access.guardianId !== null
        ? await this.studentGuardians.liveLoginChildren(schoolId, access.guardianId)
        : [];
    return { scope: scopeStudents(children.map((c) => c.studentId)), children };
  }

  /**
   * R53, R54: the sections of the caller's teacher assignments active today in the school's time
   * zone, computed per request (R69). History follows the section: the rows are read by date, so
   * a teacher reassigned from tomorrow keeps the section today and loses it tomorrow.
   */
  private async teacherSections(schoolId: SchoolId, access: UserAccess): Promise<bigint[]> {
    if (access.staffId === null) return [];
    return this.assignments.activeSectionIds(
      schoolId,
      access.staffId,
      await this.clock.today(schoolId),
    );
  }
}
