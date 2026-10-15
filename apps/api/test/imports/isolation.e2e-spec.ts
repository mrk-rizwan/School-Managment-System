// Control 4 / R62 for slice 43 through its repository (contracts/slice-43.md §3): every
// ImportRepository read and write — find, list, the commit lock and stamp, expiry, the
// committed-file lookup and the two student reads — as school A's row seen or changed by school B.
// The table-level floor and the children's composite foreign keys are in
// test/phase5/wave-u-isolation.e2e-spec.ts and wave-u-schema.e2e-spec.ts.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ImportRepository } from '../../src/repositories/import.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, day, enrol } from '../support/students';

const db = () => testDb();

describe('slice 43 tenant isolation', () => {
  let app: NestExpressApplication;
  let imports: ImportRepository;
  let schools: TwoSchools;
  let n = 0;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);

  beforeAll(async () => {
    app = await createTestApp();
    imports = app.get(ImportRepository, { strict: false });
    schools = await createTwoSchools();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** A previewed opening-balances import of `schoolId`, through the repository. */
  const previewOf = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const office = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const year = await createAcademicYear(db(), school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const row = await as(schoolId, () =>
      imports.create(schoolId, {
        kind: 'opening_balances',
        fileHash: (++n).toString(16).padStart(64, 'b'),
        fileName: 'balances.csv',
        rowCount: 1,
        rows: [{ row: 2, admissionNo: 'A-1', amount: 1500 }],
        errors: [],
        errorCount: 0,
        academicYearId: year.id,
        sectionId: null,
        classId: null,
        termId: null,
        dueOn: day('2026-10-10'),
        createdBy: office.userId,
      }),
    );
    return { id: row.id, userId: office.userId, yearId: year.id, fileHash: row.fileHash };
  };

  it('imports: find, list, lock, commit stamp and expiry never cross schools', async () => {
    const made = new Map<bigint, Awaited<ReturnType<typeof previewOf>>>();
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const p = await previewOf(schoolId);
        made.set(p.id, p);
        return p.id;
      },
      read: (schoolId, id) => as(schoolId, () => imports.find(schoolId, id)),
      list: async (schoolId) => (await as(schoolId, () => imports.list(schoolId, {}, { skip: 0, take: 50 }))).rows,
      write: async (schoolId, id) => {
        const locked = await as(schoolId, () => imports.lockPreviewed(schoolId, id));
        const stamped = await as(schoolId, () => imports.markCommitted(schoolId, id, made.get(id)?.userId ?? 0n, new Date()));
        const expired = await as(schoolId, () => imports.expire(schoolId, new Date(Date.now() + 86_400_000), new Date(), id));
        return (locked ? 1 : 0) + stamped + expired.length;
      },
      snapshot: (row) => (row as { status: string }).status,
    });
  });

  it('imports: the committed-file lookup and the student reads see only the school’s own rows', async () => {
    const { a, b } = schools;
    const p = await previewOf(a.id);
    await as(a.id, () => imports.markCommitted(a.id, p.id, p.userId, new Date()));
    expect(await as(a.id, () => imports.committedWithHash(a.id, 'opening_balances', p.fileHash))).toBe(p.id);
    expect(await as(b.id, () => imports.committedWithHash(b.id, 'opening_balances', p.fileHash))).toBeNull();

    const school = { id: a.id, shortCode: '' };
    const year = await createAcademicYear(db(), school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const section = await createSection(db(), school, await createClass(db(), school, year));
    const student = await createStudent(db(), school, { admittedOn: '2026-04-01' });
    await enrol(db(), school, student, section, { startedOn: '2026-04-01' });
    expect([...(await as(a.id, () => imports.knownAdmissionNos(a.id, [student.admissionNo])))]).toEqual([student.admissionNo]);
    expect([...(await as(b.id, () => imports.knownAdmissionNos(b.id, [student.admissionNo])))]).toEqual([]);
    expect((await as(a.id, () => imports.openingBalanceRoster(a.id, year.id))).map((r) => r.admissionNo)).toEqual([student.admissionNo]);
    expect(await as(b.id, () => imports.openingBalanceRoster(b.id, year.id))).toEqual([]);
    expect((await as(a.id, () => imports.studentNames(a.id, [student.id]))).size).toBe(1);
    expect((await as(b.id, () => imports.studentNames(b.id, [student.id]))).size).toBe(0);
  });
});
