// Type-checked by test/guardrails/lint-boundaries.spec.ts at a path in src/modules/platform. The
// line after every `// !` must be a compile error, and nothing else: fromPlatformSchool takes only
// the branded row SchoolRepository.create returns.
import type { SchoolRecord } from '../../repositories/platform/school.repository';
import type { CreatedSchoolRow } from '../../tenancy/school-id';
import { fromPlatformSchool } from '../../tenancy/school-id.mint';

export function mint(created: CreatedSchoolRow, read: SchoolRecord, routeParam: bigint): unknown[] {
  const fromCreated = fromPlatformSchool(created);
  // !
  const fromParam = fromPlatformSchool({ id: routeParam });
  // !
  const fromRead = fromPlatformSchool(read);
  // !
  const fromLiteral = fromPlatformSchool({ id: 1n, name: 'Any' });
  return [fromCreated, fromParam, fromRead, fromLiteral];
}
