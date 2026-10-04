import type { Capability, CapabilityScope } from '@asms/shared';
import type { MeDto } from '../api/contracts';

// Where a capability reaches (contracts/slice-14.md §8): `all` is a school-wide source (a
// principal or office default, a custom role, a grant); `assigned_sections` is the teacher
// default, whose rows come from today's assignments (rule 13). Null when the key is not held.
// The breadth only — never a reason to show a control the server would refuse.

type Source = Pick<MeDto, 'capabilities'> & { capabilityScopes?: MeDto['capabilityScopes'] };

export const holds = (me: Pick<MeDto, 'capabilities'>, capability: Capability): boolean =>
  me.capabilities.includes(capability);

export function scopeOf(me: Source, capability: Capability): CapabilityScope | null {
  if (!holds(me, capability)) return null;
  // A /me cached before slice 14 has no scopes: the narrower reading, never the wider.
  const entry = (me.capabilityScopes ?? []).find((s) => s.capability === capability);
  return entry?.scope ?? 'assigned_sections';
}

/** True when the key is held school-wide. */
export const schoolWide = (me: Source, capability: Capability): boolean =>
  scopeOf(me, capability) === 'all';
