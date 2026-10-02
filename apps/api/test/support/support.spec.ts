// Proves the test support itself: the factories create distinct real schools, and
// expectIsolated passes an isolated store and fails a leaky one. No tenant table exists until
// slice 1, so the stores here are in memory.
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated, type IsolationProbe } from './isolation';
import { closeTestDb, createTwoSchools, testDb, uniqueShortCode } from './schools';

afterAll(closeTestDb);

describe('two-school factory', () => {
  it('creates two distinct, persisted schools', async () => {
    const { a, b } = await createTwoSchools();
    expect(a.id).not.toBe(b.id);
    const rows = await testDb().school.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.map((r) => r.shortCode).sort()).toEqual([a.shortCode, b.shortCode].sort());
  });

  it('generates short codes that satisfy the schools.short_code format', () => {
    for (let i = 0; i < 200; i++) expect(uniqueShortCode()).toMatch(/^[a-z0-9]{3,12}$/);
  });
});

describe('expectIsolated', () => {
  interface Row {
    id: number;
    schoolId: SchoolId;
    name: string;
  }

  function store(leaky: {
    read?: boolean;
    list?: boolean;
    write?: boolean;
  }): IsolationProbe<number> {
    const rows: Row[] = [];
    const visible = (schoolId: SchoolId, leak = false) =>
      rows.filter((r) => leak || r.schoolId === schoolId);
    return {
      // Promise.resolve rather than async: the in-memory store has nothing to await.
      create: (schoolId) => {
        rows.push({ id: rows.length + 1, schoolId, name: 'original' });
        return Promise.resolve(rows.length);
      },
      read: (schoolId, id) =>
        Promise.resolve(visible(schoolId, leaky.read).find((r) => r.id === id) ?? null),
      list: (schoolId) => Promise.resolve(visible(schoolId, leaky.list)),
      write: (schoolId, id) => {
        const hits = visible(schoolId, leaky.write).filter((r) => r.id === id);
        hits.forEach((r) => (r.name = 'changed'));
        return Promise.resolve(hits.length);
      },
      snapshot: (row) => ({ ...(row as Row) }),
    };
  }

  it('passes an isolated store', async () => {
    await expectIsolated(await createTwoSchools(), store({}));
  });

  it.each([['read'], ['list'], ['write']] as const)(
    'fails a store that leaks on %s',
    async (leak) => {
      await expect(
        expectIsolated(await createTwoSchools(), store({ [leak]: true })),
      ).rejects.toThrow();
    },
  );
});
