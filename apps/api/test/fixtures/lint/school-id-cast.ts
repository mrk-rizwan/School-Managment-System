import type { SchoolId } from '../../tenancy/school-id';

export function casts(body: { schoolId: string }): unknown[] {
  const a = BigInt(body.schoolId) as SchoolId;
  const b = BigInt(body.schoolId) as unknown as SchoolId;
  const c = <SchoolId>BigInt(body.schoolId);
  const d = [BigInt(body.schoolId)] as SchoolId[];
  return [a, b, c, d];
}
