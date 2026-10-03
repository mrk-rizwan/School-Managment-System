// Inspect-only checks run before every model operation on the Prisma client (plan §3.2, R76).
// They never rewrite arguments: a guard that silently added the filter would hide the bug it
// exists to report.
import { Prisma } from './generated/prisma/client';

/**
 * Models without a tenant key, or (PlatformAuditLog) with a nullable one, and their tables. The
 * schema guard's table allowlist (test/guardrails/schema-checks.ts) is derived from this map, so
 * the two cannot drift apart.
 */
export const NON_TENANT_MODELS: Readonly<Record<string, string>> = {
  School: 'schools',
  SchoolGroup: 'school_groups',
  PlatformUser: 'platform_users',
  PlatformSession: 'platform_sessions',
  PlatformAuditLog: 'platform_audit_log',
};

const SCALAR_FIELD_ENUM = 'ScalarFieldEnum';

/**
 * Derived, not listed: every generated model with a `schoolId` field is a tenant model unless it
 * is named above, so a new tenant table is guarded the moment it is generated. A table that
 * forgets `school_id` altogether is caught by the schema guard test instead.
 */
export function deriveTenantModels(namespace: object): ReadonlySet<string> {
  return new Set(
    Object.entries(namespace)
      .filter(
        ([key, fields]) =>
          key.endsWith(SCALAR_FIELD_ENUM) &&
          typeof fields === 'object' &&
          fields !== null &&
          'schoolId' in fields,
      )
      .map(([key]) => key.slice(0, -SCALAR_FIELD_ENUM.length))
      .filter((model) => !Object.hasOwn(NON_TENANT_MODELS, model)),
  );
}

export const TENANT_MODELS = deriveTenantModels(Prisma);

/**
 * Each generated model's scalar field names, from its XScalarFieldEnum. A scalar field's value is
 * never a relation write, even when it is an object (a Json column such as
 * PlatformAuditLog.metadata), so the non-tenant relation check skips these keys.
 */
export function deriveScalarFields(
  namespace: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const fields = new Map<string, ReadonlySet<string>>();
  for (const [key, value] of Object.entries(namespace)) {
    if (!key.endsWith(SCALAR_FIELD_ENUM) || typeof value !== 'object' || value === null) continue;
    fields.set(key.slice(0, -SCALAR_FIELD_ENUM.length), new Set(Object.keys(value)));
  }
  return fields;
}

const SCALAR_FIELDS = deriveScalarFields(Prisma);
const NO_FIELDS: ReadonlySet<string> = new Set();

export class QueryGuardError extends Error {
  override readonly name = 'QueryGuardError';
}

type Args = Record<string, unknown>;

/**
 * Any non-null object is inspected, class instances included: skipping what is not a plain
 * object would let an argument built from a class slip past every check below (fail-open).
 */
const isObject = (value: unknown): value is Args => typeof value === 'object' && value !== null;

/** Scalar values that Prisma accepts as objects: they are values, not filters or nested writes. */
const isValueObject = (value: unknown): boolean =>
  value instanceof Date ||
  ArrayBuffer.isView(value) ||
  Prisma.Decimal.isDecimal(value) ||
  value === Prisma.DbNull ||
  value === Prisma.JsonNull ||
  value === Prisma.AnyNull;

/**
 * A bigint held as the object's own data property. A getter, or a value inherited from a
 * prototype, could answer the guard with one value and Prisma with another.
 */
function ownBigint(value: Args, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'bigint';
}

// Prisma drops an `undefined` filter silently, so `{ id: undefined }` would match the first row.
// Walks every object and array; Dates, Decimals and byte arrays are values, not filters.
function assertNoUndefined(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item: unknown, i) => {
      if (item === undefined) throw new QueryGuardError(`${path}[${i}] is undefined`);
      assertNoUndefined(item, `${path}[${i}]`);
    });
    return;
  }
  if (!isObject(value) || isValueObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) throw new QueryGuardError(`${path}.${key} is undefined`);
    assertNoUndefined(child, `${path}.${key}`);
  }
}

// Accepts `{ schoolId }` and the compound unique keys `{ schoolId_id: { schoolId, id } }` that
// update / delete / upsert use. A bare bigint is required: no operators, no null.
function hasSchoolId(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (ownBigint(value, 'schoolId')) return true;
  return Object.entries(value).some(
    ([key, compound]) =>
      key.startsWith('schoolId_') && isObject(compound) && ownBigint(compound, 'schoolId'),
  );
}

// The tenant key and the relation Prisma would generate for it. Changing either moves the row
// to another school; a database trigger refuses it too (asms_forbid_school_id_change).
const TENANT_KEYS = ['schoolId', 'school'];

// Prisma's atomic number operations: the only object values allowed in a non-tenant write.
const ATOMIC_OPERATIONS = new Set(['increment', 'decrement', 'multiply', 'divide']);

// `in` sees inherited keys and getters as well as own properties.
function assertTenantUnchanged(at: string, part: string, value: unknown): void {
  if (!isObject(value)) return;
  const key = TENANT_KEYS.find((k) => k in value);
  if (key) throw new QueryGuardError(`${at}: ${part}.${key} would move the row to another school`);
}

/**
 * A non-tenant model (schools, platform tables) must not become a path into tenant rows: no
 * `include`, no relation `select`, no nested write. Relation filters are prevented by the schema
 * rule that non-tenant models declare no relation to a tenant model (test/guardrails). An object
 * under one of the model's scalar field names is that field's value (a Json column), not a
 * nested write; an unknown model has no scalar fields, so every object in its writes is refused.
 */
function assertNoRelations(at: string, model: string, args: Args): void {
  const { include, select, data, create, update } = args;
  const scalars = SCALAR_FIELDS.get(model) ?? NO_FIELDS;
  if (include !== undefined) throw new QueryGuardError(`${at}: include is not allowed`);
  if (isObject(select)) {
    for (const [key, value] of Object.entries(select)) {
      if (isObject(value)) throw new QueryGuardError(`${at}: select.${key} selects a relation`);
    }
  }
  const parts: [string, unknown][] = [
    ['data', data],
    ['create', create],
    ['update', update],
  ];
  for (const [part, value] of parts) {
    const rows: unknown[] = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      if (!isObject(row)) continue;
      for (const [key, field] of Object.entries(row)) {
        if (scalars.has(key) || !isObject(field) || isValueObject(field)) continue;
        const keys = Object.keys(field);
        if (keys.length === 0 || !keys.every((op) => ATOMIC_OPERATIONS.has(op))) {
          throw new QueryGuardError(`${at}: ${part}.${key} is a nested write`);
        }
      }
    }
  }
}

/** Throws QueryGuardError if the operation could read or write outside one school. */
export function assertQueryAllowed(
  model: string | undefined,
  operation: string,
  args: unknown,
  tenantModels: ReadonlySet<string> = TENANT_MODELS,
): void {
  const all: Args = isObject(args) ? args : {};
  const { where, data, create, update } = all;
  if (where !== undefined) assertNoUndefined(where, 'where');
  if (model === undefined) return;
  const at = `${model}.${operation}`;

  if (!tenantModels.has(model)) {
    assertNoRelations(at, model, all);
    return;
  }

  if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
    throw new QueryGuardError(
      `${at}: use findFirst with schoolId; a bare unique lookup crosses tenants`,
    );
  }
  if (operation.startsWith('create')) {
    const rows: unknown[] = Array.isArray(data) ? data : [data];
    if (!rows.every(hasSchoolId)) throw new QueryGuardError(`${at}: data has no defined schoolId`);
    return;
  }
  if (!hasSchoolId(where)) throw new QueryGuardError(`${at}: where has no defined schoolId`);
  if (operation.startsWith('update')) assertTenantUnchanged(at, 'data', data);
  if (operation === 'upsert') {
    if (!hasSchoolId(create)) throw new QueryGuardError(`${at}: create has no defined schoolId`);
    assertTenantUnchanged(at, 'update', update);
  }
}
