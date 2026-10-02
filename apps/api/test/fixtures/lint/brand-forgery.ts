// Type-correct ways to forge a brand. The line after every `// !` must be reported, nothing else.
import type * as Tenancy from '../../tenancy/school-id';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';

// Ambient declarations are themselves refused: they are unchecked claims.
// !
declare const Body: () => ParameterDecorator;
// !
declare function parse<T>(value: unknown): T;
// !
declare function tag<T>(strings: TemplateStringsArray): T;
// !
declare const Box: new <T>(value: unknown) => { value: T };
const raw: unknown = 1n;
const one = 1;

// !
export const qualified = raw as Tenancy.SchoolId;
// !
export const never: SchoolId = raw as never;
// !
export const doubled: bigint = one as unknown as bigint;
// !
export const angled = <bigint>(<unknown>one);
// !
export const viaGeneric = parse<SchoolId>(raw);
// !
export const viaGenericScope = parse<{ s: Scope }>(raw);
// !
export const viaNew = new Box<SchoolId>(raw);
// !
export const viaTag = tag<SchoolId>`x`;
// !
export const viaInstantiation = parse<SchoolId>;

// !
export function isSchoolId(value: unknown): value is SchoolId {
  return typeof value === 'bigint';
}
// !
export function assertScope(value: unknown): asserts value is Scope {
  if (typeof value !== 'object') throw new Error('not a scope');
}

// !
export function overload(value: bigint): SchoolId;
export function overload(value: unknown): unknown {
  return value;
}

// !
declare const ambient: SchoolId;
export const leaked = ambient;

export class Dto {
  // !
  schoolId!: SchoolId;
}

export class Controller {
  // !
  list(@Body() body: { schoolId: SchoolId }): SchoolId {
    return body.schoolId;
  }
}
