// Control 4 / R62 for the slice-31 tables: a row written as school A is invisible to, and
// unwritable by, school B, through the repositories the results module uses (with a scope that
// reaches the section, so only the tenant key keeps the rows apart).
import { createMarksFixture, type MarksFixture } from '../academics/assessment-fixture';
import { expectIsolated, sectionsMarksScope } from '../support/isolation';
import { closeTestDb, createTwoSchools } from '../support/schools';
import { createResult, createSheet, moveSheet } from './fixture';
import { resultRepositories } from './support';

describe('result sheets tenant isolation', () => {
  afterAll(() => closeTestDb());

  const scopeOf = (f: MarksFixture) =>
    sectionsMarksScope(
      'read',
      new Date('2026-05-10T00:00:00Z'),
      new Map([[f.sectionId, { classTeacher: true, cover: false, subjectIds: [] }]]),
    );
  const page = { skip: 0, take: 50, sort: '-updatedAt' as const };

  it('result_sheets', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const scope = scopeOf(f);
    const repos = await resultRepositories();
    try {
      await expectIsolated(schools, {
        create: async () => (await createSheet(f)).id,
        read: (schoolId, id) => repos.sheets.find(schoolId, scope, id),
        list: async (schoolId) => (await repos.sheets.list(schoolId, scope, {}, page)).rows,
        write: (schoolId, id) =>
          repos.sheets.submit(schoolId, id, {
            submittedBy: f.userId,
            submittedAt: new Date(),
            submittedUnderAssignmentId: null,
          }),
        snapshot: (row) => (row as { status: string } | null)?.status ?? null,
      });
    } finally {
      await repos.close();
    }
  });

  it('result_sheet_remarks', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const sheet = await createSheet(f);
    const repos = await resultRepositories();
    const asRows = async (schoolId: Parameters<typeof repos.sheets.remarks>[0]) =>
      (await repos.sheets.remarks(schoolId, sheet.id)).map((r) => ({ ...r, id: r.enrolmentId }));
    try {
      await expectIsolated(schools, {
        create: async (schoolId) => {
          await repos.sheets.writeRemarks(schoolId, sheet.id, f.userId, [
            { enrolmentId: f.enrolmentId, remark: 'Works hard.' },
          ]);
          return f.enrolmentId;
        },
        read: async (schoolId, id) => (await asRows(schoolId)).find((r) => r.id === id) ?? null,
        list: asRows,
        write: async (schoolId, id) =>
          (
            await repos.sheets.writeRemarks(schoolId, sheet.id, f.userId, [
              { enrolmentId: id, remark: 'Taken over.' },
            ])
          ).length,
        snapshot: (row) => (row as { remark: string } | null)?.remark ?? null,
      });
    } finally {
      await repos.close();
    }
  });

  it('result_sheet_locks', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const sheet = await createSheet(f);
    await moveSheet(f, sheet.id, 'submitted');
    const repos = await resultRepositories();
    const locked = async (schoolId: Parameters<typeof repos.sheets.find>[0], studentId: bigint) =>
      (
        await repos.assessments.sheetLockedStudents(
          schoolId,
          { classId: f.classId, termId: f.midTermId },
          [studentId],
        )
      ).has(studentId)
        ? studentId
        : null;
    try {
      await expectIsolated(schools, {
        create: async (schoolId) => {
          await repos.sheets.lockSubmission(schoolId, sheet.id, {
            testIds: [],
            studentIds: [f.studentId],
            at: new Date(),
          });
          return f.studentId;
        },
        read: locked,
        write: (schoolId) => repos.sheets.releaseSubmission(schoolId, sheet.id, new Date()),
        snapshot: (row) => row,
      });
    } finally {
      await repos.close();
    }
  });

  it('results', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const scope = scopeOf(f);
    const sheet = await createSheet(f);
    await moveSheet(f, sheet.id, 'approved');
    const repos = await resultRepositories();
    try {
      await expectIsolated(schools, {
        create: async () => (await createResult(f, sheet.id)).id,
        read: async (schoolId, id) =>
          (await repos.results.forSheet(schoolId, scope, sheet.id)).find((r) => r.id === id) ??
          null,
        list: (schoolId) => repos.results.forSheet(schoolId, scope, sheet.id),
        write: (schoolId) => repos.results.supersedeSheetRows(schoolId, sheet.id, new Date()),
        snapshot: (row) => (row as { supersededAt: Date | null } | null)?.supersededAt ?? null,
      });
    } finally {
      await repos.close();
    }
  });

  it('result_subjects', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const scope = scopeOf(f);
    const sheet = await createSheet(f);
    await moveSheet(f, sheet.id, 'approved');
    const repos = await resultRepositories();
    const subjects = async (schoolId: Parameters<typeof repos.results.forSheet>[0]) =>
      (await repos.results.forSheet(schoolId, scope, sheet.id)).flatMap((r) =>
        r.subjects.map((s) => ({ ...s, id: r.id })),
      );
    try {
      await expectIsolated(schools, {
        create: async () => (await createResult(f, sheet.id)).id,
        read: async (schoolId, id) => (await subjects(schoolId)).find((s) => s.id === id) ?? null,
        list: subjects,
      });
    } finally {
      await repos.close();
    }
  });
});
