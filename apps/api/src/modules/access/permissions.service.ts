import { Injectable } from '@nestjs/common';
import { Capability, SYSTEM_ROLE_DEFAULTS, type SystemRole } from '@asms/shared';
import { UserRepository, type UserStatusValue } from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import { scopeAll, scopeSections } from '../../tenancy/scope.mint';

/** The school roles a session can carry (contract slice-2 §4.1 `SchoolRole`). */
export const SCHOOL_ROLES = ['principal', 'office_staff', 'teacher', 'parent', 'student'] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

/** Which kinds of person the user currently is (contract §1.1 "Capacity"). */
export interface Capacities {
  /** staff_id set, staff active, at least one live role row. */
  staff: boolean;
  /** guardian_id set (plan §6 stance). */
  guardian: boolean;
  /** Always false until slice 6 adds users.student_id. */
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
  capacities: Capacities;
  /** Live system-role rows, whatever the staff status (the users screen shows them). */
  systemRoles: readonly SystemRole[];
  /** Effective capabilities: empty unless the staff capacity holds (R59). */
  capabilities: ReadonlySet<Capability>;
}

const ALL_CAPABILITIES: readonly Capability[] = Object.values(Capability);
/** Display and comparison order: the registry order of §7. */
const ORDER = new Map(ALL_CAPABILITIES.map((key, i) => [key, i]));

/** Roles whose defaults are school-wide; a teacher's defaults are scoped by assignments. */
const SCHOOL_WIDE_ROLES: readonly SystemRole[] = ['principal', 'office_staff'];

/**
 * Effective permissions (plan §3.4, contract slice-2 §1.1). Slice 2 computes from system roles
 * only; slice 7 adds custom roles and grants, slice 4 adds teacher assignment scope.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly users: UserRepository) {}

  /** The user's access, or null if the user does not exist in this school. */
  async load(schoolId: SchoolId, userId: bigint): Promise<UserAccess | null> {
    const row = await this.users.findAccess(schoolId, userId);
    if (!row) return null;
    const staff =
      row.staffId !== null && row.staffStatus === 'active' && row.systemRoles.length > 0;
    const capabilities = new Set<Capability>();
    // R59: a user whose staff record is not active has no staff capability, whatever is stored.
    if (staff) {
      for (const role of row.systemRoles) {
        for (const key of SYSTEM_ROLE_DEFAULTS[role]) capabilities.add(key);
      }
    }
    return {
      userId: row.id,
      status: row.status,
      staffId: row.staffId,
      guardianId: row.guardianId,
      capacities: { staff, guardian: row.guardianId !== null, student: false },
      systemRoles: row.systemRoles,
      capabilities,
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
    return [...access.capabilities].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
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
    const dormant = target.systemRoles.flatMap((role) => SYSTEM_ROLE_DEFAULTS[role]);
    return [...target.capabilities, ...dormant].every((key) => actor.capabilities.has(key));
  }

  /**
   * A refusal (null) or the row scope the capability gives (plan §3.4, R79): school-wide when it
   * comes from the principal or office-staff defaults; the teacher's sections when it comes only
   * from the teacher default. Teacher assignments arrive in slice 4, so until then a
   * teacher-only capability scopes to no rows (an empty list means no rows, never no filter).
   * Returns a promise so slice 4 can read assignments without changing the signature.
   */
  can(_schoolId: SchoolId, access: UserAccess, capability: Capability): Promise<Scope | null> {
    if (!access.capacities.staff || !access.capabilities.has(capability)) {
      return Promise.resolve(null);
    }
    const schoolWide = access.systemRoles.some(
      (role) => SCHOOL_WIDE_ROLES.includes(role) && SYSTEM_ROLE_DEFAULTS[role].includes(capability),
    );
    return Promise.resolve(schoolWide ? scopeAll() : scopeSections([]));
  }

  /**
   * Any-of over several capabilities (@RequireCapability with more than one key): a refusal
   * (null) when none is held, else the widest scope — school-wide if any one gives it, otherwise
   * the union of the section lists.
   */
  async canAny(
    schoolId: SchoolId,
    access: UserAccess,
    capabilities: readonly Capability[],
  ): Promise<Scope | null> {
    let sections: bigint[] | null = null;
    for (const capability of capabilities) {
      const scope = await this.can(schoolId, access, capability);
      if (scope === null) continue;
      if (scope.kind === 'all') return scope;
      sections = [...(sections ?? []), ...scope.ids];
    }
    return sections === null ? null : scopeSections([...new Set(sections)]);
  }
}
