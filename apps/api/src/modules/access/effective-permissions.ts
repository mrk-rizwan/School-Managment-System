import {
  Capability,
  SYSTEM_ROLE_DEFAULTS,
  type CapabilityScope,
  type CustomRoleStatus,
  type GrantEffect,
  type SystemRole,
} from '@asms/shared';

// contracts/slice-7.md §1 (R50, R52, R59, R79). Pure: no database, no clock. The only computation
// of a user's capabilities; can(), GET /me and GET /users/:id/permissions all read it (R58).

/** A live custom-role row of the user, with the role's live keys as stored (unchecked strings). */
export interface CustomRoleInput {
  customRoleId: bigint;
  name: string;
  status: CustomRoleStatus;
  capabilityKeys: readonly string[];
}

/** An active (not ended) grant or revoke row of the user. */
export interface GrantInput {
  grantId: bigint;
  capabilityKey: string;
  effect: GrantEffect;
}

export interface PermissionInputs {
  /** No staff_id, staff not active, or no live role row: the result is empty (R59). */
  staffCapacity: boolean;
  systemRoles: readonly SystemRole[];
  customRoles: readonly CustomRoleInput[];
  grants: readonly GrantInput[];
}

export type CapabilitySource =
  | { kind: 'system_role'; systemRole: SystemRole }
  | { kind: 'custom_role'; customRoleId: bigint; name: string }
  | { kind: 'grant'; grantId: bigint };

export interface EffectiveLine {
  capability: Capability;
  sources: CapabilitySource[];
  /** `assigned_sections` when every source is the teacher system role (R79). */
  scope: CapabilityScope;
}

const ALL: readonly Capability[] = Object.values(Capability);
/** Registry order of §7, and the lookup that drops unknown keys (never object indexing). */
const ORDER: ReadonlyMap<string, number> = new Map(ALL.map((key, i) => [key, i]));
const KNOWN: ReadonlyMap<string, Capability> = new Map(ALL.map((key) => [key, key]));

/**
 * A key that may come from a custom role or a grant row: a registry key other than role.manage
 * (R45). Anything else stored in the database is ignored on read.
 */
export function delegableCapability(key: string): Capability | undefined {
  const capability = KNOWN.get(key);
  return capability === undefined || capability === Capability.ROLE_MANAGE ? undefined : capability;
}

export const capabilityOrder = (a: Capability, b: Capability): number =>
  (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0);

/** The delegable keys among stored `keys`, distinct, in registry order; anything else dropped. */
export function delegableCapabilities(keys: Iterable<string>): Capability[] {
  const found = new Set<Capability>();
  for (const key of keys) {
    const capability = delegableCapability(key);
    if (capability) found.add(capability);
  }
  return [...found].sort(capabilityOrder);
}

/**
 * Effective = (∪ defaults of live roles) − active revokes ∪ active grants (R50). Archived custom
 * roles contribute nothing (R52); a revoke removes a default only, so an active grant of the same
 * key wins. Lines in registry order.
 */
export function effectivePermissions(input: PermissionInputs): EffectiveLine[] {
  if (!input.staffCapacity) return [];
  const defaults = new Map<Capability, CapabilitySource[]>();
  const addDefault = (capability: Capability, source: CapabilitySource) => {
    defaults.set(capability, [...(defaults.get(capability) ?? []), source]);
  };
  for (const systemRole of input.systemRoles) {
    for (const capability of SYSTEM_ROLE_DEFAULTS[systemRole]) {
      addDefault(capability, { kind: 'system_role', systemRole });
    }
  }
  for (const role of input.customRoles) {
    if (role.status !== 'active') continue;
    for (const capability of delegableCapabilities(role.capabilityKeys)) {
      addDefault(capability, { kind: 'custom_role', customRoleId: role.customRoleId, name: role.name });
    }
  }
  const lines = new Map(defaults);
  for (const grant of input.grants) {
    const capability = delegableCapability(grant.capabilityKey);
    if (capability && grant.effect === 'revoke') lines.delete(capability);
  }
  for (const grant of input.grants) {
    const capability = delegableCapability(grant.capabilityKey);
    if (!capability || grant.effect !== 'grant') continue;
    // Grant wins over a revoke of the same key; a revoked default is not listed as a source.
    const sources = lines.get(capability) ?? [];
    lines.set(capability, [...sources, { kind: 'grant', grantId: grant.grantId }]);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => capabilityOrder(a, b))
    .map(([capability, sources]) => ({
      capability,
      sources,
      scope: sources.every((s) => s.kind === 'system_role' && s.systemRole === 'teacher')
        ? 'assigned_sections'
        : 'all',
    }));
}
