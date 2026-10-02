// R60: the migrated test database satisfies the tenant schema conventions. Run
// `pnpm db:test:deploy` first; the test reads the catalog of whatever is migrated there.
import { Client } from 'pg';
import {
  checkExpectedObjects,
  checkSchema,
  EXPECTED_OBJECTS,
  SCHOOL_ID_IMMUTABLE_FUNCTION,
  tenantModelTables,
} from './schema-checks';

describe('schema guard (R60)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });

  afterAll(() => db.end());

  it('runs against a migrated database', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schools'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('has the school_id immutability trigger function', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1`,
      [SCHOOL_ID_IMMUTABLE_FUNCTION],
    );
    expect(rows).toHaveLength(1);
  });

  it('finds no violations in the migrated schema', async () => {
    expect(await checkSchema(db)).toEqual([]);
  });

  it('maps tenant models to tables through schema.prisma', () => {
    const schema = `
      model Student {
        id       BigInt @id
        schoolId BigInt @map("school_id")
        @@map("students")
      }
      model FeeHead {
        id       BigInt @id
        schoolId BigInt
      }`;
    expect([...tenantModelTables(schema, new Set(['Student', 'FeeHead']))].sort()).toEqual([
      'FeeHead',
      'students',
    ]);
  });

  it('finds every named hand-written index, constraint and trigger', async () => {
    expect(await checkExpectedObjects(db, EXPECTED_OBJECTS)).toEqual([]);
  });

  // Self-test: plants one of each violation in a throwaway schema inside a transaction that is
  // always rolled back, and proves each check reports it.
  describe('detects violations', () => {
    let violations: string[];
    let missing: string[];
    let moveError: unknown;

    beforeAll(async () => {
      await db.query('BEGIN');
      try {
        await db.query(`
          CREATE SCHEMA guard_selftest;
          SET LOCAL search_path TO guard_selftest;
          CREATE TABLE schools (id bigserial PRIMARY KEY);
          CREATE TABLE no_tenant (id bigserial PRIMARY KEY, name text);
          CREATE TABLE nullable_tenant (id bigserial PRIMARY KEY, school_id bigint REFERENCES schools (id));
          CREATE UNIQUE INDEX nullable_tenant_school_id_id_key ON nullable_tenant (school_id, id);
          CREATE TABLE parents (
            id bigserial PRIMARY KEY,
            school_id bigint NOT NULL REFERENCES schools (id) ON DELETE RESTRICT ON UPDATE RESTRICT
          );
          CREATE UNIQUE INDEX parents_school_id_id_key ON parents (school_id, id);
          CREATE TRIGGER parents_school_id_immutable BEFORE UPDATE ON parents
            FOR EACH ROW EXECUTE FUNCTION public.${SCHOOL_ID_IMMUTABLE_FUNCTION}();
          -- Conforming except that its unique key on (school_id, id) is not really one.
          CREATE TABLE expr_key (
            id bigserial PRIMARY KEY,
            school_id bigint NOT NULL REFERENCES schools (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
            name text
          );
          CREATE UNIQUE INDEX expr_key_school_id_name_id_key ON expr_key (school_id, lower(name), id);
          CREATE INDEX expr_key_name_idx ON expr_key (lower(name), school_id);
          CREATE TRIGGER expr_key_school_id_immutable BEFORE UPDATE ON expr_key
            FOR EACH ROW EXECUTE FUNCTION public.${SCHOOL_ID_IMMUTABLE_FUNCTION}();
          CREATE TABLE include_key (
            id bigserial PRIMARY KEY,
            school_id bigint NOT NULL REFERENCES schools (id) ON DELETE RESTRICT ON UPDATE RESTRICT
          );
          CREATE UNIQUE INDEX include_key_school_id_key ON include_key (school_id) INCLUDE (id);
          CREATE TRIGGER include_key_school_id_immutable BEFORE UPDATE ON include_key
            FOR EACH ROW EXECUTE FUNCTION public.${SCHOOL_ID_IMMUTABLE_FUNCTION}();
          -- Conforming except that school_id points nowhere.
          CREATE TABLE unanchored (id bigserial PRIMARY KEY, school_id bigint NOT NULL);
          CREATE UNIQUE INDEX unanchored_school_id_id_key ON unanchored (school_id, id);
          CREATE TRIGGER unanchored_school_id_immutable BEFORE UPDATE ON unanchored
            FOR EACH ROW EXECUTE FUNCTION public.${SCHOOL_ID_IMMUTABLE_FUNCTION}();
          CREATE TABLE children (
            id bigserial PRIMARY KEY,
            school_id bigint NOT NULL,
            parent_id bigint,
            created_by bigint,
            name text,
            CONSTRAINT children_school_fkey FOREIGN KEY (school_id) REFERENCES schools (id) ON UPDATE CASCADE,
            CONSTRAINT children_parent_fkey FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE,
            CONSTRAINT children_parent_nullify_fkey FOREIGN KEY (school_id, parent_id)
              REFERENCES parents (school_id, id) ON DELETE SET NULL
          );
          CREATE UNIQUE INDEX children_school_id_id_key ON children (school_id, id);
          CREATE INDEX children_school_id_parent_id_idx ON children (school_id, parent_id);
          CREATE INDEX children_name_idx ON children (name);
          -- Only an AFTER trigger: too late to refuse the change.
          CREATE TRIGGER children_school_id_after AFTER UPDATE ON children
            FOR EACH ROW EXECUTE FUNCTION public.${SCHOOL_ID_IMMUTABLE_FUNCTION}();
          INSERT INTO schools (id) VALUES (1), (2);
          INSERT INTO parents (school_id) VALUES (1);
        `);
        await db.query('SAVEPOINT move');
        moveError = await db.query('UPDATE parents SET school_id = 2').then(
          () => undefined,
          (error: unknown) => error,
        );
        await db.query('ROLLBACK TO SAVEPOINT move');
        // Every planted tenant table is "mapped" except no_tenant, plus one that does not exist.
        violations = await checkSchema(
          db,
          'guard_selftest',
          new Set([
            'nullable_tenant',
            'parents',
            'expr_key',
            'include_key',
            'unanchored',
            'children',
            'ghost_table',
          ]),
        );
        missing = await checkExpectedObjects(
          db,
          [
            { kind: 'index', table: 'children', name: 'children_name_idx', definition: 'WHERE' },
            { kind: 'constraint', table: 'children', name: 'children_status_check' },
            { kind: 'trigger', table: 'children', name: 'children_audit' },
          ],
          'guard_selftest',
        );
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it.each([
      ['no_tenant: needs school_id bigint NOT NULL'],
      ['nullable_tenant: needs school_id bigint NOT NULL'],
      ['no_tenant: needs a unique index on exactly (school_id, id)'],
      ['children.created_by: an *_id / *_by column must be a foreign key'],
      [
        'children_parent_fkey: a foreign key between tenant tables must pair school_id with school_id',
      ],
      ['children_parent_fkey: no index on children leads with (parent_id)'],
      ['children_parent_fkey: ON DELETE CASCADE is not allowed (rule 4: never hard-delete)'],
      [
        'children_parent_nullify_fkey: ON DELETE SET NULL is not allowed (rule 4: never hard-delete)',
      ],
      ['children_school_fkey: ON UPDATE CASCADE is not allowed (rule 4: never hard-delete)'],
      ['children_name_idx: an index on a tenant table must lead with school_id'],
      ['no_tenant: needs a foreign key (school_id) REFERENCES schools (id)'],
      ['unanchored: needs a foreign key (school_id) REFERENCES schools (id)'],
      [`no_tenant: needs a BEFORE UPDATE row trigger calling ${SCHOOL_ID_IMMUTABLE_FUNCTION}()`],
      [`children: needs a BEFORE UPDATE row trigger calling ${SCHOOL_ID_IMMUTABLE_FUNCTION}()`],
      // An expression column and an INCLUDE column must not satisfy the (school_id, id) key.
      ['expr_key: needs a unique index on exactly (school_id, id)'],
      ['include_key: needs a unique index on exactly (school_id, id)'],
      ['expr_key_name_idx: an index on a tenant table must lead with school_id'],
      // The database's tenant tables must be exactly the query guard's tenant models.
      ['no_tenant: a tenant table that no tenant model maps; the query guard never sees it'],
      ['ghost_table: mapped by a tenant model but not a tenant table in the database'],
    ])('%s', (violation) => {
      expect(violations).toContain(violation);
    });

    it('reports nothing for the table that follows the conventions', () => {
      expect(violations.filter((v) => v.startsWith('parents'))).toEqual([]);
    });

    it('reports each planted table only for what was planted', () => {
      expect(violations.filter((v) => /^(expr_key|include_key|unanchored)[:_]/.test(v))).toEqual([
        'expr_key: needs a unique index on exactly (school_id, id)',
        'include_key: needs a unique index on exactly (school_id, id)',
        'unanchored: needs a foreign key (school_id) REFERENCES schools (id)',
        'expr_key_name_idx: an index on a tenant table must lead with school_id',
      ]);
    });

    it('the trigger function refuses to move a row to another school', () => {
      expect(moveError).toMatchObject({
        code: '23514',
        message: 'school_id is immutable on parents',
      });
    });

    it('reports a missing or changed named object', () => {
      expect(missing).toEqual([
        expect.stringMatching(/^index children\.children_name_idx has changed/),
        'constraint children.children_status_check is missing',
        'trigger children.children_audit is missing',
      ]);
    });

    it('left nothing behind', async () => {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_namespace WHERE nspname = 'guard_selftest'`,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
