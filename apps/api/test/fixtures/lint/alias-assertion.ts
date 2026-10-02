// Brand forgery through a name the syntax bans cannot see. The type-aware
// no-unsafe-type-assertion rule refuses every narrowing cast, whatever the target is called.
import type { SchoolId as S } from '../../tenancy/school-id';
import type { SchoolId } from '../../tenancy/school-id';

type Local = SchoolId;
interface Repo {
  find(schoolId: SchoolId): void;
}

export function forge(raw: bigint): unknown[] {
  const renamed = raw as S;
  const aliased = raw as Local;
  const viaParameters = raw as Parameters<Repo['find']>[0];
  const angled = <Local>raw;
  return [renamed, aliased, viaParameters, angled];
}

export function brand<T>(value: unknown): T {
  return value as T;
}
