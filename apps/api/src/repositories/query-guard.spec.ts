import { Prisma } from './generated/prisma/client';
import { NON_TENANT_TABLES } from '../../test/guardrails/schema-checks';
import {
  assertQueryAllowed,
  deriveScalarFields,
  deriveTenantModels,
  NON_TENANT_MODELS,
  QueryGuardError,
  TENANT_MODELS,
} from './query-guard';

// No tenant model exists until slice 1, so the tenant rules are exercised against a stand-in
// model name. The derivation itself is checked against the real generated client below.
const tenant = new Set(['Student']);
const check =
  (operation: string, args: unknown, model = 'Student') =>
  () =>
    assertQueryAllowed(model, operation, args, tenant);

describe('query guard (R76)', () => {
  it('derives tenant models from the generated client; schools is not one', () => {
    expect(TENANT_MODELS.has('School')).toBe(false);
  });

  it('derives a tenant model from any XScalarFieldEnum carrying schoolId, minus the non-tenant list', () => {
    const namespace = {
      StudentScalarFieldEnum: { id: 'id', schoolId: 'schoolId', name: 'name' },
      FeeHeadScalarFieldEnum: { id: 'id', schoolId: 'schoolId' },
      PlatformUserScalarFieldEnum: { id: 'id', email: 'email' },
      PlatformAuditLogScalarFieldEnum: { id: 'id', schoolId: 'schoolId' },
      SchoolScalarFieldEnum: { id: 'id', name: 'name' },
      NotAModelEnum: { schoolId: 'schoolId' },
      SortOrder: { asc: 'asc', desc: 'desc' },
    };
    expect([...deriveTenantModels(namespace)].sort()).toEqual(['FeeHead', 'Student']);
    expect(deriveTenantModels({ SchoolScalarFieldEnum: { id: 'id' } }).size).toBe(0);
  });

  it("the schema guard's non-tenant table allowlist is derived from NON_TENANT_MODELS", () => {
    expect([...NON_TENANT_TABLES].sort()).toEqual(
      [...Object.values(NON_TENANT_MODELS), '_prisma_migrations'].sort(),
    );
  });

  it('allows a tenant query that filters on a defined schoolId', () => {
    expect(check('findFirst', { where: { schoolId: 1n, id: 2n } })).not.toThrow();
    expect(
      check('findMany', { where: { schoolId: 1n, OR: [{ name: 'a' }, { name: 'b' }] } }),
    ).not.toThrow();
    expect(check('count', { where: { schoolId: 1n } })).not.toThrow();
    expect(check('updateMany', { where: { schoolId: 1n }, data: { name: 'x' } })).not.toThrow();
  });

  it('accepts the schoolId_id compound key used by update, delete and upsert', () => {
    const where = { schoolId_id: { schoolId: 1n, id: 2n } };
    expect(check('update', { where, data: { name: 'x' } })).not.toThrow();
    expect(check('delete', { where })).not.toThrow();
    expect(check('upsert', { where, create: { schoolId: 1n }, update: {} })).not.toThrow();
  });

  it.each([
    ['findMany', undefined],
    ['findMany', {}],
    ['findFirst', { where: { id: 2n } }],
    ['findFirst', { where: { schoolId: null, id: 2n } }],
    ['findFirst', { where: { schoolId: { in: [1n, 2n] } } }],
    ['findFirst', { where: { OR: [{ schoolId: 1n }, { id: 2n }] } }],
    ['updateMany', { where: { id: 2n }, data: {} }],
    ['deleteMany', {}],
    ['update', { where: { schoolId_id: { id: 2n } }, data: {} }],
    ['aggregate', { _count: true }],
    ['groupBy', { by: ['name'] }],
  ])('throws on %s without a defined schoolId in where (%p)', (operation, args) => {
    expect(check(operation, args)).toThrow(QueryGuardError);
  });

  it('throws on findUnique and findUniqueOrThrow on a tenant model, even with schoolId', () => {
    const args = { where: { schoolId_id: { schoolId: 1n, id: 2n } } };
    expect(check('findUnique', args)).toThrow(/findFirst/);
    expect(check('findUniqueOrThrow', args)).toThrow(QueryGuardError);
  });

  it('requires schoolId in data on every create form', () => {
    expect(check('create', { data: { schoolId: 1n, name: 'x' } })).not.toThrow();
    expect(check('createMany', { data: [{ schoolId: 1n }, { schoolId: 1n }] })).not.toThrow();
    expect(check('create', { data: { name: 'x' } })).toThrow(QueryGuardError);
    expect(check('create', { data: { schoolId: undefined } })).toThrow(QueryGuardError);
    expect(check('createMany', { data: [{ schoolId: 1n }, { name: 'x' }] })).toThrow(
      QueryGuardError,
    );
    expect(check('createManyAndReturn', { data: [{ name: 'x' }] })).toThrow(QueryGuardError);
    expect(
      check('upsert', { where: { schoolId: 1n, id: 2n }, create: { name: 'x' }, update: {} }),
    ).toThrow(/create has no defined schoolId/);
  });

  it('throws on an undefined anywhere in where, for tenant and non-tenant models alike', () => {
    expect(check('findFirst', { where: { schoolId: 1n, id: undefined } })).toThrow(
      /where\.id is undefined/,
    );
    expect(check('findFirst', { where: { schoolId: 1n, id: { in: [1n, undefined] } } })).toThrow(
      /where\.id\.in\[1\]/,
    );
    expect(
      check('findFirst', { where: { schoolId: 1n, AND: [{ name: { equals: undefined } }] } }),
    ).toThrow(QueryGuardError);
    expect(check('findFirst', { where: { shortCode: undefined } }, 'School')).toThrow(
      /where\.shortCode/,
    );
  });

  it.each([
    [
      'update',
      'data',
      { where: { schoolId_id: { schoolId: 1n, id: 2n } }, data: { schoolId: 3n } },
    ],
    ['updateMany', 'data', { where: { schoolId: 1n }, data: { name: 'x', schoolId: 3n } }],
    ['updateManyAndReturn', 'data', { where: { schoolId: 1n }, data: { schoolId: 1n } }],
    [
      'update',
      'data',
      { where: { schoolId: 1n, id: 2n }, data: { school: { create: { name: 'x' } } } },
    ],
    [
      'upsert',
      'update',
      { where: { schoolId: 1n, id: 2n }, create: { schoolId: 1n }, update: { schoolId: 3n } },
    ],
  ])('refuses to change the tenant key in %s %s', (operation, part, args) => {
    expect(check(operation, args)).toThrow(new RegExp(`${part}\\.school(Id)? would move the row`));
  });

  describe('non-tenant models cannot reach tenant rows', () => {
    const school = (operation: string, args: unknown) => check(operation, args, 'School');

    it('refuses include, a relation select and _count of a relation', () => {
      expect(school('findMany', { include: { students: true } })).toThrow(/include/);
      expect(school('findFirst', { where: { id: 1n }, include: {} })).toThrow(/include/);
      expect(
        school('findMany', { select: { id: true, students: { select: { id: true } } } }),
      ).toThrow(/select\.students selects a relation/);
      expect(school('findMany', { select: { _count: { select: { students: true } } } })).toThrow(
        /select\._count/,
      );
    });

    it('refuses a nested write in data, createMany rows, and upsert create / update', () => {
      expect(
        school('create', { data: { name: 'x', students: { create: { name: 'y' } } } }),
      ).toThrow(/data\.students is a nested write/);
      expect(school('createMany', { data: [{ name: 'x' }, { group: { create: {} } }] })).toThrow(
        /data\.group/,
      );
      expect(
        school('update', { where: { id: 1n }, data: { students: { updateMany: {} } } }),
      ).toThrow(QueryGuardError);
      expect(
        school('upsert', { where: { id: 1n }, create: { students: { create: {} } }, update: {} }),
      ).toThrow(/create\.students/);
      expect(
        school('upsert', {
          where: { id: 1n },
          create: {},
          update: { students: { deleteMany: {} } },
        }),
      ).toThrow(/update\.students/);
    });

    it('allows scalar selects, scalar writes, Dates and atomic number operations', () => {
      expect(school('findMany', { select: { id: true, name: true, _count: true } })).not.toThrow();
      expect(
        school('update', {
          where: { id: 1n },
          data: { name: 'x', updatedAt: new Date(), counter: { increment: 1 } },
        }),
      ).not.toThrow();
      expect(school('createMany', { data: [{ name: 'x' }, { name: 'y' }] })).not.toThrow();
    });

    it("allows an object as the value of the model's own scalar (Json) field", () => {
      const audit = (args: unknown) => check('create', args, 'PlatformAuditLog');
      expect(
        audit({ data: { action: 'school.created', metadata: { shortCode: 'abc', changes: {} } } }),
      ).not.toThrow();
      expect(audit({ data: { action: 'x', metadata: {} } })).not.toThrow();
    });

    it('still refuses a relation write beside a Json field, and objects on unknown models', () => {
      expect(
        check('create', { data: { metadata: {}, school: { create: { name: 'x' } } } }, 'PlatformAuditLog'),
      ).toThrow(/data\.school is a nested write/);
      expect(
        check('create', { data: { actor: { create: { email: 'x' } } } }, 'PlatformAuditLog'),
      ).toThrow(/data\.actor is a nested write/);
      // `metadata` is a scalar of PlatformAuditLog, not of School: on School it is still refused.
      expect(school('create', { data: { name: 'x', metadata: { create: {} } } })).toThrow(
        /data\.metadata is a nested write/,
      );
      expect(check('create', { data: { metadata: {} } }, 'NoSuchModel')).toThrow(
        /data\.metadata is a nested write/,
      );
    });

    it('derives scalar fields from every XScalarFieldEnum', () => {
      const fields = deriveScalarFields({
        PlatformAuditLogScalarFieldEnum: { id: 'id', metadata: 'metadata' },
        SortOrder: { asc: 'asc' },
      });
      expect([...fields.keys()]).toEqual(['PlatformAuditLog']);
      expect([...(fields.get('PlatformAuditLog') ?? [])]).toEqual(['id', 'metadata']);
    });
  });

  it('leaves the other rules on non-tenant models to their own repositories', () => {
    expect(check('findUnique', { where: { id: 1n } }, 'School')).not.toThrow();
    expect(check('findMany', {}, 'School')).not.toThrow();
  });

  it('treats Dates and other class instances as values, not filters', () => {
    expect(
      check('findMany', { where: { schoolId: 1n, createdAt: { gte: new Date() } } }),
    ).not.toThrow();
  });

  it('reads the generated client by the names the derivation expects', () => {
    // A generator change that renames XScalarFieldEnum would make TENANT_MODELS silently empty.
    expect('SchoolScalarFieldEnum' in Prisma).toBe(true);
    for (const model of Object.values(Prisma.ModelName)) {
      expect(Object.hasOwn(Prisma, `${model}ScalarFieldEnum`)).toBe(true);
    }
  });

  describe('class instances are inspected, never skipped', () => {
    class Patch {
      name = 'x';
      constructor(readonly schoolId: bigint) {}
    }
    class InheritedSchool {
      get schoolId(): bigint {
        return 3n;
      }
    }
    class Where {
      id = 2n;
      get schoolId(): bigint {
        return 1n;
      }
    }
    class NestedWrite {
      name = 'x';
      students = { create: { name: 'y' } };
    }
    class RelationSelect {
      id = true;
      students = { select: { id: true } };
    }
    class Include {
      include = { students: true };
    }
    class HiddenWrite {
      get create(): object {
        return {};
      }
    }

    it('refuses a tenant-key change carried by a class instance, own or inherited', () => {
      const where = { schoolId: 1n, id: 2n };
      expect(check('update', { where, data: new Patch(3n) })).toThrow(/data\.schoolId would move/);
      expect(check('update', { where, data: new InheritedSchool() })).toThrow(/data\.schoolId/);
      expect(check('upsert', { where, create: { schoolId: 1n }, update: new Patch(3n) })).toThrow(
        /update\.schoolId/,
      );
    });

    it('requires schoolId as an own data property, not a getter', () => {
      expect(check('findFirst', { where: new Where() })).toThrow(/where has no defined schoolId/);
      expect(check('create', { data: new InheritedSchool() })).toThrow(/data has no defined/);
    });

    it('refuses relations and nested writes on non-tenant models carried by class instances', () => {
      const school = (operation: string, args: unknown) => check(operation, args, 'School');
      expect(school('update', { where: { id: 1n }, data: new NestedWrite() })).toThrow(
        /data\.students is a nested write/,
      );
      expect(school('findMany', { select: new RelationSelect() })).toThrow(/select\.students/);
      expect(school('findMany', new Include())).toThrow(/include is not allowed/);
      expect(
        school('update', { where: { id: 1n }, data: { students: new HiddenWrite() } }),
      ).toThrow(/data\.students is a nested write/);
    });

    it('walks class instances for undefined filters', () => {
      class Filter {
        name = undefined;
      }
      expect(check('findFirst', { where: { schoolId: 1n, AND: [new Filter()] } })).toThrow(
        /where\.AND\[0\]\.name is undefined/,
      );
    });

    it('still treats Dates, Decimals and bytes as values in a non-tenant write', () => {
      expect(
        check(
          'update',
          {
            where: { id: 1n },
            data: {
              at: new Date(),
              amount: new Prisma.Decimal(1),
              secret: new Uint8Array([1]),
              details: Prisma.DbNull,
            },
          },
          'School',
        ),
      ).not.toThrow();
    });
  });
});
