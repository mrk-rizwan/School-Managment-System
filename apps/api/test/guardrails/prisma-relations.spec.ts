// Non-tenant models must not be a route into tenant rows (security review M2). Prisma requires a
// back-relation on both sides, so a tenant model declaring `school School` gives School a relation
// field to that tenant table, reachable by include, select or a relation filter from platform code
// that holds no SchoolId. So:
//   - a relation between a tenant model and School is allowed only if BOTH sides carry @ignore:
//     Prisma's migration diff then knows the FK (school_id) REFERENCES schools (id), and the
//     generated client has neither field (see the schema.prisma header);
//   - no other non-tenant model relates to a tenant model, ignored or not.
// The FK itself is checked in the database by the schema guard. The query guard refuses include,
// relation select and nested writes on non-tenant models as well.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NON_TENANT_MODELS } from '../../src/repositories/query-guard';
import { parseModels } from './schema-checks';

/** `Model.field` for every field line carrying the @ignore attribute (comments stripped). */
function ignoredFields(schema: string): ReadonlySet<string> {
  const ignored = new Set<string>();
  for (const [, model, body] of schema.matchAll(/^[ \t]*model\s+(\w+)\s*\{([\s\S]*?)^[ \t]*\}/gm)) {
    for (const raw of (body ?? '').split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      const field = /^(\w+)\s+\w+/.exec(line)?.[1];
      if (field && /(^|\s)@ignore(\s|$)/.test(line)) ignored.add(`${model}.${field}`);
    }
  }
  return ignored;
}

/** Violations of the relation rules above, as readable strings. */
function relationViolations(
  schema: string,
  nonTenant: Readonly<Record<string, string>> = NON_TENANT_MODELS,
): string[] {
  const models = parseModels(schema);
  const ignored = ignoredFields(schema);
  const modelNames = new Set(models.map((m) => m.name));
  const isNonTenant = (name: string) => Object.hasOwn(nonTenant, name);
  const tenant = new Set(
    models
      .filter((m) => !isNonTenant(m.name) && m.fields.some((f) => f.name === 'schoolId'))
      .map((m) => m.name),
  );
  /** True when `from` has a field of type `to` and every such field carries @ignore. */
  const ignoredSide = (from: string, to: string): boolean => {
    const fields = models.find((m) => m.name === from)?.fields.filter((f) => f.type === to) ?? [];
    return fields.length > 0 && fields.every((f) => ignored.has(`${from}.${f.name}`));
  };
  const ignoredBothWays = (tenantModel: string) =>
    ignoredSide(tenantModel, 'School') && ignoredSide('School', tenantModel);

  const violations: string[] = [];
  for (const model of models) {
    if (isNonTenant(model.name) && model.table !== nonTenant[model.name]) {
      violations.push(
        `${model.name}: maps to ${model.table ?? '(no @@map)'}, NON_TENANT_MODELS says ${nonTenant[model.name]}`,
      );
    }
    for (const field of model.fields.filter((f) => modelNames.has(f.type))) {
      if (isNonTenant(model.name) && tenant.has(field.type)) {
        if (model.name !== 'School' || !ignoredBothWays(field.type)) {
          violations.push(
            `${model.name}.${field.name}: a non-tenant model must not relate to tenant model ${field.type}` +
              (model.name === 'School' ? ' unless both sides carry @ignore' : ''),
          );
        }
      }
      if (tenant.has(model.name) && field.type === 'School' && !ignoredBothWays(model.name)) {
        violations.push(
          `${model.name}.${field.name}: a tenant model's relation to School must carry @ignore on both sides`,
        );
      }
    }
  }
  return violations;
}

describe('Prisma relations between tenant and non-tenant models', () => {
  it('prisma/schema.prisma follows the rules', () => {
    const schema = readFileSync(join(resolve(__dirname, '../..'), 'prisma/schema.prisma'), 'utf8');
    expect(parseModels(schema).map((m) => m.name)).toContain('School');
    expect(relationViolations(schema)).toEqual([]);
  });

  it('the real schema does declare the ignored tenant relations (the rule is not vacuous)', () => {
    const schema = readFileSync(join(resolve(__dirname, '../..'), 'prisma/schema.prisma'), 'utf8');
    expect([...ignoredFields(schema)].sort()).toEqual(
      expect.arrayContaining(['School.schoolSettings', 'SchoolSettings.school']),
    );
  });

  it('detects each violation in a planted schema', () => {
    const planted = `
      model School {
        id       BigInt    @id
        students Student[] // back-relation, not ignored
        fees     Fee[]     @ignore
        books    Book[]    @ignore
        @@map("schools")
      }
      model PlatformUser {
        id     BigInt @id
        staff  Staff? @relation(fields: [id], references: [id]) @ignore
        @@map("platform_users")
      }
      model SchoolGroup {
        id BigInt @id
        @@map("groups")
      }
      model Student {
        id       BigInt @id
        schoolId BigInt @map("school_id")
        school   School @relation(fields: [schoolId], references: [id])
        @@map("students")
      }
      model Fee {
        id       BigInt @id
        schoolId BigInt
        school   School @relation(fields: [schoolId], references: [id]) // @ignore in a comment
      }
      model Book {
        id       BigInt @id
        schoolId BigInt
        school   School @relation(fields: [schoolId], references: [id]) @ignore
      }
      model Staff {
        id       BigInt        @id
        schoolId BigInt
        user     PlatformUser?
        guardian Student?      @relation(fields: [schoolId, id], references: [schoolId, id])
      }
    `;
    expect(relationViolations(planted)).toEqual([
      'School.students: a non-tenant model must not relate to tenant model Student unless both sides carry @ignore',
      'School.fees: a non-tenant model must not relate to tenant model Fee unless both sides carry @ignore',
      'PlatformUser.staff: a non-tenant model must not relate to tenant model Staff',
      'SchoolGroup: maps to groups, NON_TENANT_MODELS says school_groups',
      "Student.school: a tenant model's relation to School must carry @ignore on both sides",
      "Fee.school: a tenant model's relation to School must carry @ignore on both sides",
    ]);
  });
});
