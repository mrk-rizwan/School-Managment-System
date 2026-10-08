// §7.2 for result approval: a section of 60 students × 12 subjects × 15 tests (and the 12 exams),
// every mark entered. Approving it — the four reads of slice 31 under the sheet's row lock, the
// composition in memory, 60 results and 720 subjects in two inserts, the publication — must finish
// within 2 s, the request's answer included. Each student carries 20 days of attendance (the
// term's aggregate is one of the reads), and the endpoint is warmed once on another section's
// sheet first, so the timed call measures the request, not the first compilation of its queries.
//
// Measure it alone, so no other suite shares the database or the CPU:
//   node --experimental-vm-modules node_modules/jest/bin/jest.js test/results/approve-perf.e2e-spec.ts --runInBand
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { captureOutbox } from '../diary/support';
import { StaffHarness } from '../staff/support';
import { closeTestDb, createSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createStudent,
  createSubject,
  createTeacherAssignment,
  day,
  enrol,
  isoDay,
} from '../support/students';
import { api, entryKey, openSheet, sheetVerb } from './support';

const STUDENTS = 60;
const SUBJECTS = 12;
const TESTS = 15;
/** §7.2: approve a 60 × 12 × 15 section within 2 s. */
const BUDGET_MS = 2_000;

describe('§7.2: approving a 60-student section (performance)', () => {
  const h = new StaffHarness();
  const db = h.db;

  beforeAll(async () => {
    await h.start();
    captureOutbox(h);
    jest
      .spyOn(h.app.get(OutboxDispatcher, { strict: false }), 'resultNotifyAfterCommit')
      .mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.app.close();
    await closeTestDb();
  });

  it(`approves ${STUDENTS} × ${SUBJECTS} × ${TESTS} within ${BUDGET_MS} ms`, async () => {
    const school = await createSchool();
    const schoolId = school.id;
    await db.schoolSettings.create({ data: { schoolId, feeDueDay: 10 } });
    const year = await createAcademicYear(db, school);
    await db.$executeRaw`SELECT asms_seed_year_results(${schoolId}::bigint, ${year.id}::bigint)`;
    const [mid] = await db.academicTerm.findMany({
      where: { schoolId, academicYearId: year.id },
      orderBy: { sortOrder: 'asc' },
    });
    const klass = await createClass(db, school, year);
    const section = await createSection(db, school, klass);
    const principal = await h.caller(school, 'principal');
    const teacher = await h.caller(school, 'teacher');
    await createTeacherAssignment(db, school, teacher, {
      role: 'class_teacher',
      section,
      startsOn: isoDay(-60),
    });
    const classSubjects: bigint[] = [];
    for (let i = 0; i < SUBJECTS; i++) {
      const subject = await createSubject(db, school);
      classSubjects.push(
        (
          await db.classSubject.create({
            data: {
              schoolId,
              academicYearId: year.id,
              classId: klass.id,
              subjectId: subject.id,
              sortOrder: i,
            },
          })
        ).id,
      );
    }
    const enrolments: { id: bigint; studentId: bigint }[] = [];
    for (let s = 0; s < STUDENTS; s++) {
      const student = await createStudent(db, school);
      enrolments.push({
        id: (await enrol(db, school, student, section, { startedOn: isoDay(-60), rollNo: s + 1 }))
          .id,
        studentId: student.id,
      });
    }
    const assessments = await db.assessment.createManyAndReturn({
      data: classSubjects.flatMap((classSubjectId, i) => [
        ...Array.from({ length: TESTS }, (_, t) => ({
          schoolId,
          academicYearId: year.id,
          termId: mid!.id,
          classId: klass.id,
          sectionId: section.id,
          classSubjectId,
          kind: 'test' as const,
          testType: 'weekly' as const,
          name: `T${i}-${t}`,
          maxMarks: 10 + t * 5,
          heldOn: day(isoDay(-50 + t * 3)),
          createdBy: principal.userId,
        })),
        {
          schoolId,
          academicYearId: year.id,
          termId: mid!.id,
          classId: klass.id,
          sectionId: section.id,
          classSubjectId,
          kind: 'exam' as const,
          testType: null,
          name: `Exam ${i}`,
          maxMarks: 100,
          heldOn: mid!.endsOn,
          createdBy: principal.userId,
        },
      ]),
      select: { id: true, maxMarks: true },
    });
    await db.mark.createMany({
      data: assessments.flatMap((a, k) =>
        enrolments.map((e, s) => ({
          schoolId,
          assessmentId: a.id,
          enrolmentId: e.id,
          studentId: e.studentId,
          academicYearId: year.id,
          maxMarks: a.maxMarks,
          obtained: (s * 7 + k * 3) % (a.maxMarks + 1),
          absent: false,
          status: 'live' as const,
          enteredBy: principal.userId,
          clientEntryKey: entryKey(),
        })),
      ),
    });
    expect(await db.mark.count({ where: { schoolId } })).toBe(STUDENTS * SUBJECTS * (TESTS + 1));
    // Twenty school days of attendance per student.
    await db.attendanceDayStatus.createMany({
      data: enrolments.flatMap((e, s) =>
        Array.from({ length: 20 }, (_, d) => {
          const status = (s + d) % 7 === 0 ? ('absent' as const) : ('present' as const);
          return {
            schoolId,
            enrolmentId: e.id,
            studentId: e.studentId,
            sectionId: section.id,
            date: day(isoDay(-(d + 1))),
            status,
            periodsRecorded: 1,
            periodsPresent: status === 'present' ? 1 : 0,
            periodsLate: 0,
            periodsAbsent: status === 'absent' ? 1 : 0,
            periodsLeave: 0,
          };
        }),
      ),
    });

    // The warm-up: another section of one student, its exams marked, approved the same way.
    const warmSection = await createSection(db, school, klass, { name: 'Warm' });
    await createTeacherAssignment(db, school, teacher, {
      role: 'class_teacher',
      section: warmSection,
      startsOn: isoDay(-60),
    });
    const warmStudent = await createStudent(db, school);
    const warmEnrolment = await enrol(db, school, warmStudent, warmSection, {
      startedOn: isoDay(-60),
      rollNo: 1,
    });
    const warmExams = await db.assessment.createManyAndReturn({
      data: classSubjects.map((classSubjectId, i) => ({
        schoolId,
        academicYearId: year.id,
        termId: mid!.id,
        classId: klass.id,
        sectionId: warmSection.id,
        classSubjectId,
        kind: 'exam' as const,
        testType: null,
        name: `Warm exam ${i}`,
        maxMarks: 100,
        heldOn: mid!.endsOn,
        createdBy: principal.userId,
      })),
      select: { id: true },
    });
    await db.mark.createMany({
      data: warmExams.map((a) => ({
        schoolId,
        assessmentId: a.id,
        enrolmentId: warmEnrolment.id,
        studentId: warmStudent.id,
        academicYearId: year.id,
        maxMarks: 100,
        obtained: 50,
        absent: false,
        status: 'live' as const,
        enteredBy: principal.userId,
        clientEntryKey: entryKey(),
      })),
    });
    const { body: warmSheet } = await openSheet(h, teacher, warmSection.id, mid!.id);
    expect((await sheetVerb(h, warmSheet.id, 'submit', teacher)).status).toBe(200);
    expect((await sheetVerb(h, warmSheet.id, 'approve', principal)).status).toBe(200);

    const { body: sheet } = await openSheet(h, teacher, section.id, mid!.id);
    expect((await sheetVerb(h, sheet.id, 'submit', teacher)).status).toBe(200);
    const started = performance.now();
    const res = await h.send(
      'post',
      api(`/result-sheets/${sheet.id}/approve`),
      {},
      principal.cookie,
    );
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(await db.result.count({ where: { schoolId, sheetId: BigInt(sheet.id) } })).toBe(STUDENTS);
    expect(
      await db.resultSubject.count({ where: { schoolId, result: { is: { sheetId: BigInt(sheet.id) } } } }),
    ).toBe(STUDENTS * SUBJECTS);
    console.log(`approve ${STUDENTS} × ${SUBJECTS} × ${TESTS}: ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, 180_000);
});
