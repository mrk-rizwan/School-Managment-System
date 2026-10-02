// Non-tenant models must not be a route into tenant rows (security review M2). Prisma requires a
// back-relation on both sides, so a tenant model declaring `school School` would give School a
// relation field to every tenant table, reachable by include, select or a relation filter from
// platform code that holds no SchoolId. So:
//   - a tenant model declares no Prisma relation to School; its FK (school_id) REFERENCES
//     schools (id) is written in the migration SQL and checked by the schema guard;
//   - a non-tenant model declares no relation to a tenant model.
// The query guard refuses include, relation select and nested writes on non-tenant models as well.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NON_TENANT_MODELS } from '../../src/repositories/query-guard';
import { parseModels } from './schema-checks';

/** Violations of the relation rules above, as readable strings. */
function relationViolations(
  schema: string,
  nonTenant: Readonly<Record<string, string>> = NON_TENANT_MODELS,
): string[] {
  const models = parseModels(schema);
  const modelNames = new Set(models.map((m) => m.name));
  const isNonTenant = (name: string) => Object.hasOwn(nonTenant, name);
  const tenant = new Set(
    models
      .filter((m) => !isNonTenant(m.name) && m.fields.some((f) => f.name === 'schoolId'))
      .map((m) => m.name),
  );
  const violations: string[] = [];
  for (const model of models) {
    if (isNonTenant(model.name) && model.table !== nonTenant[model.name]) {
      violations.push(
        `${model.name}: maps to ${model.table ?? '(no @@map)'}, NON_TENANT_MODELS says ${nonTenant[model.name]}`,
      );
    }
    for (const field of model.fields.filter((f) => modelNames.has(f.type))) {
      if (isNonTenant(model.name) && tenant.has(field.type)) {
        violations.push(
          `${model.name}.${field.name}: a non-tenant model must not relate to tenant model ${field.type}`,
        );
      }
      if (tenant.has(model.name) && field.type === 'School') {
        violations.push(
          `${model.name}.${field.name}: a tenant model must not declare a relation to School; write the FK in migration SQL`,
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

  it('detects each violation in a planted schema', () => {
    const planted = `
      model School {
        id       BigInt    @id
        students Student[] // back-relation
        @@map("schools")
      }
      model PlatformUser {
        id     BigInt @id
        staff  Staff? @relation(fields: [id], references: [id])
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
      model Staff {
        id       BigInt        @id
        schoolId BigInt
        user     PlatformUser?
        guardian Student?      @relation(fields: [schoolId, id], references: [schoolId, id])
      }
    `;
    expect(relationViolations(planted)).toEqual([
      'School.students: a non-tenant model must not relate to tenant model Student',
      'PlatformUser.staff: a non-tenant model must not relate to tenant model Staff',
      'SchoolGroup: maps to groups, NON_TENANT_MODELS says school_groups',
      'Student.school: a tenant model must not declare a relation to School; write the FK in migration SQL',
    ]);
  });
});
