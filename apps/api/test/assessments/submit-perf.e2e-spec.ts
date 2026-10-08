// Slice 36 (performance review item 20): POST /assessments/:id/submit-marks for a 60-student
// grid — every entry decided in memory, then one supersede and one insert — must answer within
// 500 ms. Half the rows replace a live mark (superseded), half are new (created). The endpoint is
// warmed once on another test first, so the timed call measures the request, not the first
// compilation of its queries.
//
// Measure it alone, so no other suite shares the database or the CPU:
//   node --experimental-vm-modules node_modules/jest/bin/jest.js test/assessments/submit-perf.e2e-spec.ts --runInBand
import request from 'supertest';
import type { AssessmentSubmitMarksResultDto } from '../../src/modules/assessments/assessments.dto';
import { captureOutbox } from '../diary/support';
import { ORIGIN, StaffHarness, type Caller } from '../staff/support';
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
import { api, entryKey } from './support';

const STUDENTS = 60;
/** Item 20: a 60-row submit within 500 ms. */
const BUDGET_MS = 500;

describe('submit-marks for a 60-student grid (performance)', () => {
  const h = new StaffHarness();
  const db = h.db;

  beforeAll(async () => {
    await h.start();
    captureOutbox(h);
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it(`submits ${STUDENTS} rows within ${BUDGET_MS} ms`, async () => {
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
    const subject = await createSubject(db, school);
    const classSubject = await db.classSubject.create({
      data: { schoolId, academicYearId: year.id, classId: klass.id, subjectId: subject.id, sortOrder: 1 },
    });
    const teacher = await h.caller(school, 'teacher');
    await createTeacherAssignment(db, school, teacher, {
      role: 'subject_teacher',
      subjectId: subject.id,
      section,
      startsOn: isoDay(-60),
    });
    const enrolments: { id: bigint; studentId: bigint }[] = [];
    for (let s = 0; s < STUDENTS; s++) {
      const student = await createStudent(db, school);
      enrolments.push({
        id: (await enrol(db, school, student, section, { startedOn: isoDay(-60), rollNo: s + 1 })).id,
        studentId: student.id,
      });
    }
    const [warm, timed] = await db.assessment.createManyAndReturn({
      data: ['Warm-up', 'Timed'].map((name, t) => ({
        schoolId,
        academicYearId: year.id,
        termId: mid!.id,
        classId: klass.id,
        sectionId: section.id,
        classSubjectId: classSubject.id,
        kind: 'test' as const,
        testType: 'weekly' as const,
        name,
        maxMarks: 50,
        heldOn: day(isoDay(-10 - t)),
        createdBy: teacher.userId,
      })),
      select: { id: true },
    });
    // Half the timed grid already holds a live mark: those rows supersede it.
    const existing = await db.mark.createManyAndReturn({
      data: enrolments.slice(0, STUDENTS / 2).map((e) => ({
        schoolId,
        assessmentId: timed!.id,
        enrolmentId: e.id,
        studentId: e.studentId,
        academicYearId: year.id,
        maxMarks: 50,
        obtained: 10,
        absent: false,
        status: 'live' as const,
        enteredBy: teacher.userId,
        clientEntryKey: entryKey(),
      })),
      select: { id: true, enrolmentId: true },
    });
    const based = new Map(existing.map((m) => [m.enrolmentId, String(m.id)]));
    const submit = (who: Caller, assessmentId: bigint) =>
      request(h.app.getHttpServer())
        .post(api(`/assessments/${assessmentId}/submit-marks`))
        .set('Cookie', who.cookie)
        .set('Origin', ORIGIN)
        .send({
          entries: enrolments.map((e, s) => ({
            enrolmentId: String(e.id),
            obtained: (s * 7) % 51,
            clientEntryKey: entryKey(),
            basedOnMarkId: assessmentId === timed!.id ? (based.get(e.id) ?? null) : null,
          })),
        });

    expect((await submit(teacher, warm!.id)).status).toBe(200);
    const started = performance.now();
    const res = await submit(teacher, timed!.id);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    const outcomes = (res.body as AssessmentSubmitMarksResultDto).entries.map((e) => e.outcome);
    // The seeded half supersedes (or is unchanged where the new mark happens to equal it).
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(STUDENTS / 2);
    expect(outcomes.filter((o) => o === 'superseded').length + outcomes.filter((o) => o === 'unchanged').length).toBe(STUDENTS / 2);
    expect(
      await db.mark.count({ where: { schoolId, assessmentId: timed!.id, status: 'live' } }),
    ).toBe(STUDENTS);
    console.log(`submit-marks of ${STUDENTS} rows: ${Math.round(elapsed)} ms`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
