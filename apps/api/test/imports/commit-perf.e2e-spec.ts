// Slice 43's budget (phase-5-extended.md §7.2): a past-results commit of 60 rows × 12 subjects in
// at most 3 s — 12 exams, 720 marks, the sheet, 60 results with 720 subject rows. Run alone (one
// worker, nothing else on the database), as the budgets are measured.
import { StaffHarness } from '../staff/support';
import { closeTestDb, createSchool } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, createSubject, enrol, isoDay } from '../support/students';
import { csv, importsHttp, type ImportDetail } from './support';

describe('slice 43: past-results commit budget (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  const x = importsHttp(() => h.app);

  beforeAll(async () => {
    await h.start();
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it('§7.2: 60 rows × 12 subjects commit in at most 3 s', async () => {
    const school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const year = await createAcademicYear(db, school);
    await db.$executeRaw`SELECT asms_seed_year_results(${school.id}::bigint, ${year.id}::bigint)`;
    const klass = await createClass(db, school, year, { name: 'Nine' });
    const section = await createSection(db, school, klass, { name: 'A' });
    const names: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const subject = await createSubject(db, school, { name: `Subject ${String.fromCharCode(64 + i)}` });
      await db.classSubject.create({
        data: { schoolId: school.id, academicYearId: year.id, classId: klass.id, subjectId: subject.id, sortOrder: i, examMaxMarks: 100 },
      });
      names.push(`Subject ${String.fromCharCode(64 + i)}`);
    }
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 60; i++) {
      const student = await createStudent(db, school, { fullName: `Pupil ${i}` });
      await enrol(db, school, student, section, { startedOn: isoDay(-30), rollNo: i + 1 });
      rows.push([student.admissionNo, ...names.map((_, j) => (i * 7 + j * 13) % 101)]);
    }
    const principal = await h.caller(school, 'principal');
    const mid = await db.academicTerm.findFirstOrThrow({ where: { schoolId: school.id, academicYearId: year.id }, orderBy: { sortOrder: 'asc' } });
    const preview = await x.preview(
      'past-results',
      { sectionId: section.id.toString(), termId: mid.id.toString() },
      csv(['admission_no', ...names], ...rows),
      principal.cookie,
    );
    expect([preview.status, (preview.body as ImportDetail).errorCount]).toEqual([201, 0]);

    const started = Date.now();
    const res = await x.commit((preview.body as ImportDetail).id, principal.cookie);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    console.log(`past-results commit 60 × 12: ${elapsed} ms`);
    expect(await db.mark.count({ where: { schoolId: school.id } })).toBe(720);
    expect(await db.result.count({ where: { schoolId: school.id } })).toBe(60);
    expect(await db.resultSubject.count({ where: { schoolId: school.id } })).toBe(720);
    expect(elapsed).toBeLessThanOrEqual(3000);
  });
});
