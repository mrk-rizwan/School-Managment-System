// R296 (as far as slice 31 reaches), R270, R273, R275, R276, R277: the scripted section. Twelve
// subjects; tests of mixed sizes; a student who moved from 6-B to 6-A mid-term (their 6-B marks
// count, §0.25); a mid-term joiner (only the exams apply); a student who left (not on the sheet,
// A9); an unexcused absence (counts 0) and excused ones (left out); a subject not assessed for one
// student; a subject teacher who is a guardian of a student on the sheet (own-child flag). The
// class teacher submits, the principal approves; every stored figure equals the shared pure
// functions over what was entered; the attendance equals GET /students/:id/attendance; the
// messages are counted per family and student login; then the final sheet composes the
// published terms (R275). Corrections and withholding are slice 32.
import {
  ErrorCode,
  composeFinal,
  composeResult,
  composeSubject,
  DEFAULT_GRADE_BANDS,
  positions,
  type ExamMarkInput,
  type ResultFigures,
  type TestMarkInput,
} from '@asms/shared';
import type { ResultSheetDetailDto } from '../../src/modules/results/results.dto';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { ResultNotifyJob } from '../../src/modules/results/result-notify.job';
import { captureOutbox, studentLogin } from '../diary/support';
import { errorOf, StaffHarness, type Caller } from '../staff/support';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createGuardian,
  createSection,
  createStudent,
  createSubject,
  createTeacherAssignment,
  day,
  enrol,
  isoDay,
  linkGuardian,
  type TestSection,
} from '../support/students';
import { api, createTest, enterMarks, entryKey, openSheet, sheetVerb } from './support';

const SUBJECTS = 12;
/** Index of the subject with no tests (Drawing): exam only. */
const DRAWING = SUBJECTS - 1;
const WEIGHTS = { test: 20, exam: 80 };

/** A deterministic mark out of `max` for student `s` on assessment number `a`. */
const markFor = (s: number, a: number, max: number): number => (s * 7 + a * 13 + 5) % (max + 1);

interface Student {
  key: string;
  id: bigint;
  /** The 6-A enrolment (on the sheet), when there is one. */
  enrolmentA: bigint | null;
  enrolmentB: bigint | null;
}

describe('R296: the scripted section (slice 31)', () => {
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

  it('stores exactly what the shared functions give, tells every family once, and composes the final', async () => {
    // ---------------------------------------------------------------------------- the school
    const school: TestSchool = await createSchool();
    await db.schoolSettings.create({
      data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true },
    });
    const year = await createAcademicYear(db, school);
    await db.$executeRaw`SELECT asms_seed_year_results(${school.id}::bigint, ${year.id}::bigint)`;
    const [mid, annual] = await db.academicTerm.findMany({
      where: { schoolId: school.id, academicYearId: year.id },
      orderBy: { sortOrder: 'asc' },
    });
    const klass = await createClass(db, school, year, { name: 'Seven' });
    const sixA: TestSection = await createSection(db, school, klass, { name: 'A' });
    const sixB: TestSection = await createSection(db, school, klass, { name: 'B' });
    const subjects: { id: bigint; classSubjectId: bigint; name: string }[] = [];
    for (let i = 0; i < SUBJECTS; i++) {
      const name = i === DRAWING ? 'Drawing' : `Subject ${String.fromCharCode(65 + i)}`;
      const subject = await createSubject(db, school, { name });
      const cs = await db.classSubject.create({
        data: {
          schoolId: school.id,
          academicYearId: year.id,
          classId: klass.id,
          subjectId: subject.id,
          sortOrder: i + 1,
          examMaxMarks: i % 2 === 0 ? 100 : 75,
        },
      });
      subjects.push({ id: subject.id, classSubjectId: cs.id, name });
    }
    const principal = await h.caller(school, 'principal', 'Nadia Principal');
    const classTeacher = await h.caller(school, 'teacher', 'Ayesha Class');
    const parentTeacher: Caller = await h.caller(school, 'teacher', 'Kamran Parent');
    const started = isoDay(-30);
    await createTeacherAssignment(db, school, classTeacher, {
      role: 'class_teacher',
      section: sixA,
      startsOn: started,
    });
    await createTeacherAssignment(db, school, parentTeacher, {
      role: 'subject_teacher',
      subjectId: subjects[0]!.id,
      section: sixA,
      startsOn: started,
    });

    // ---------------------------------------------------------------------------- students
    const students: Student[] = [];
    const add = async (
      key: string,
      plan: { a?: [string, string | null]; b?: [string, string] },
      roll: number,
    ) => {
      const s = await createStudent(db, school, { fullName: `Student ${key}` });
      const enrolmentB = plan.b
        ? (
            await enrol(db, school, s, sixB, {
              startedOn: plan.b[0],
              endedOn: plan.b[1],
              status: 'completed',
              rollNo: roll,
            })
          ).id
        : null;
      const enrolmentA = plan.a
        ? (
            await enrol(db, school, s, sixA, {
              startedOn: plan.a[0],
              endedOn: plan.a[1],
              status: plan.a[1] === null ? 'active' : 'left',
              rollNo: roll,
            })
          ).id
        : null;
      students.push({ key, id: s.id, enrolmentA, enrolmentB });
      return s;
    };
    const s1 = await add('S1', { a: [started, null] }, 1);
    const s2 = await add('S2', { a: [started, null] }, 2);
    const s3 = await add('S3', { a: [started, null] }, 3);
    const s4 = await add('S4', { a: [started, null] }, 4);
    await add('S5', { b: [started, isoDay(-10)], a: [isoDay(-9), null] }, 5); // moved from 6-B
    await add('S6', { a: [isoDay(-3), null] }, 6); // joined mid-term
    await add('S7', { a: [started, isoDay(-5)] }, 7); // left: not on the sheet
    // Families: keypad (fee payer) + the student's own login, WhatsApp, smartphone; S4's guardian
    // is the subject teacher of Subject A (one login, both capacities).
    const keypad = await createGuardian(db, school, {
      fullName: 'Keypad Family',
      contactCapability: 'keypad',
    });
    await linkGuardian(db, school, s1, keypad);
    await studentLogin(db, school, s1);
    const whatsapp = await createGuardian(db, school, {
      fullName: 'WhatsApp Family',
      contactCapability: 'whatsapp',
    });
    await linkGuardian(db, school, s2, whatsapp);
    const smart = await createGuardian(db, school, {
      fullName: 'Smart Family',
      contactCapability: 'smartphone_data',
    });
    await linkGuardian(db, school, s3, smart);
    const teacherParent = await createGuardian(db, school, { fullName: 'Kamran Parent' });
    await linkGuardian(db, school, s4, teacherParent);
    await db.user.updateMany({
      where: { schoolId: school.id, id: parentTeacher.userId },
      data: { guardianId: teacherParent.id },
    });
    const st = (key: string) => students.find((x) => x.key === key)!;

    // ---------------------------------------------------------------------------- assessments
    expect(
      (await h.send('post', api(`/terms/${mid!.id}/set-up-exams`), {}, principal.cookie)).status,
    ).toBe(200);
    const exams = await db.assessment.findMany({
      where: { schoolId: school.id, termId: mid!.id, kind: 'exam' },
    });
    const examOf = (section: TestSection, i: number) =>
      exams.find(
        (e) => e.sectionId === section.id && e.classSubjectId === subjects[i]!.classSubjectId,
      )!;
    /** Every test the term holds, with who it applies to. */
    const tests: {
      id: bigint;
      subject: number;
      max: number;
      section: 'A' | 'B';
      heldOn: string;
      n: number;
    }[] = [];
    let n = 0;
    for (let i = 0; i < SUBJECTS; i++) {
      if (i === DRAWING) continue;
      const who = i === 0 ? parentTeacher : principal;
      for (const [heldOn, max] of [
        [isoDay(-20), 10],
        [isoDay(-6), 50],
      ] as const) {
        const id = BigInt(
          await createTest(h, who, {
            classSubjectId: subjects[i]!.classSubjectId,
            sectionId: sixA.id,
            maxMarks: max,
            heldOn,
            name: `T${++n}`,
          }),
        );
        tests.push({ id, subject: i, max, section: 'A', heldOn, n });
      }
    }
    const bTest = BigInt(
      await createTest(h, principal, {
        classSubjectId: subjects[0]!.classSubjectId,
        sectionId: sixB.id,
        maxMarks: 20,
        heldOn: isoDay(-15),
        name: 'B weekly',
      }),
    );
    tests.push({ id: bTest, subject: 0, max: 20, section: 'B', heldOn: isoDay(-15), n: n + 1 });

    /** Who sits a test: an enrolment of its section in force on held_on (the grid). */
    const plans: Record<string, Partial<Record<'A' | 'B', [string, string | null]>>> = {
      S1: { A: [started, null] },
      S2: { A: [started, null] },
      S3: { A: [started, null] },
      S4: { A: [started, null] },
      S5: { B: [started, isoDay(-10)], A: [isoDay(-9), null] },
      S6: { A: [isoDay(-3), null] },
      S7: { A: [started, isoDay(-5)] },
    };
    const sits = (s: Student, t: (typeof tests)[number]): bigint | null => {
      const range = plans[s.key]?.[t.section];
      if (!range || t.heldOn < range[0] || (range[1] !== null && t.heldOn > range[1])) return null;
      return t.section === 'A' ? s.enrolmentA : s.enrolmentB;
    };
    /** What each student got on each test: a mark, or 'absent' (S3's first Subject B test). */
    const entered = new Map<string, number | 'absent'>();
    for (const t of tests) {
      const rows: [bigint, number | 'absent'][] = [];
      for (const [i, s] of students.entries()) {
        const enrolmentId = sits(s, t);
        if (enrolmentId === null) continue;
        const value: number | 'absent' =
          s.key === 'S3' && t.subject === 1 && t.max === 10 ? 'absent' : markFor(i, t.n, t.max);
        entered.set(`${s.key}|${t.id}`, value);
        rows.push([enrolmentId, value]);
      }
      const who = t.subject === 0 && t.section === 'A' ? parentTeacher : principal;
      await enterMarks(h, t.id, who, rows);
    }
    // Exams (today): every 6-A student on the roster; S2 absent on Drawing, S4 absent on Subject C.
    for (let i = 0; i < SUBJECTS; i++) {
      const exam = examOf(sixA, i);
      const rows: [bigint, number | 'absent'][] = [];
      for (const [k, s] of students.entries()) {
        if (s.key === 'S7' || s.enrolmentA === null) continue;
        const value: number | 'absent' =
          (s.key === 'S2' && i === DRAWING) || (s.key === 'S4' && i === 2)
            ? 'absent'
            : markFor(k, 100 + i, exam.maxMarks);
        entered.set(`${s.key}|${exam.id}`, value);
        rows.push([s.enrolmentA, value]);
      }
      await enterMarks(h, exam.id, i === 0 ? parentTeacher : principal, rows);
    }
    // Excusals by the principal (result.approve): S2's Drawing exam, S4's Subject C exam.
    const excused = new Set<string>();
    for (const [key, i] of [
      ['S2', DRAWING],
      ['S4', 2],
    ] as const) {
      const exam = examOf(sixA, i);
      const mark = await db.mark.findFirst({
        where: {
          schoolId: school.id,
          assessmentId: exam.id,
          studentId: st(key).id,
          status: 'live',
        },
      });
      const res = await h.send(
        'post',
        api(`/marks/${mark!.id}/excuse`),
        { reason: 'Medical certificate' },
        principal.cookie,
      );
      expect(res.status).toBe(200);
      excused.add(`${key}|${exam.id}`);
    }
    // Attendance for S1 over the term (R277): five present, three absent, one late.
    const statuses = [
      'present',
      'absent',
      'present',
      'present',
      'absent',
      'present',
      'late',
      'absent',
      'present',
    ] as const;
    for (const [k, status] of statuses.entries()) {
      const date = isoDay(-(k + 1));
      await db.attendanceDayStatus.create({
        data: {
          schoolId: school.id,
          enrolmentId: st('S1').enrolmentA!,
          studentId: st('S1').id,
          sectionId: sixA.id,
          date: day(date),
          status,
          periodsRecorded: 1,
          periodsPresent: status === 'present' ? 1 : 0,
          periodsLate: status === 'late' ? 1 : 0,
          periodsAbsent: status === 'absent' ? 1 : 0,
          periodsLeave: 0,
        },
      });
    }

    // ---------------------------------------------------------------------------- the sheet
    const { body: sheet } = await openSheet(h, classTeacher, sixA.id, mid!.id);
    const preview = sheet.preview;
    expect(preview.map((p) => p.fullName)).toEqual([
      'Student S1',
      'Student S2',
      'Student S3',
      'Student S4',
      'Student S5',
      'Student S6',
    ]);
    expect((await sheetVerb(h, sheet.id, 'submit', classTeacher)).status).toBe(200);

    // §2.4 (the slice-31 review): the submission locks S5's 6-B marks too. The 6-B test S5 sat
    // is stamped locked (the sheet holds it); S5's mark on the 6-B exam, whatever its section, is
    // locked through the roster — while 6-B's own sheet is still a draft.
    const changeS5 = (assessmentId: bigint, value: number, basedOnMarkId: bigint | null) =>
      h.send(
        'post',
        api(`/assessments/${assessmentId}/submit-marks`),
        {
          entries: [
            {
              enrolmentId: String(st('S5').enrolmentB),
              obtained: value,
              clientEntryKey: entryKey(),
              basedOnMarkId: basedOnMarkId === null ? null : String(basedOnMarkId),
            },
          ],
        },
        principal.cookie,
      );
    const liveMarkOf = async (assessmentId: bigint) =>
      (
        await db.mark.findFirst({
          where: { schoolId: school.id, assessmentId, studentId: st('S5').id, status: 'live' },
        })
      )?.id ?? null;
    const s5Test = await liveMarkOf(bTest);
    expect(s5Test).not.toBeNull();
    expect(
      (await db.assessment.findFirst({ where: { schoolId: school.id, id: bTest } }))?.lockedAt,
    ).not.toBeNull();
    const locks = await db.resultSheetLock.findMany({
      where: { schoolId: school.id, sheetId: BigInt(sheet.id), releasedAt: null },
    });
    expect(locks.map((l) => l.assessmentId)).toContain(bTest);
    expect(locks.map((l) => l.studentId)).toContain(st('S5').id);
    const lockedTest = await changeS5(bTest, 1, s5Test);
    expect(lockedTest.status).toBe(409);
    expect(errorOf(lockedTest).code).toBe(ErrorCode.ASSESSMENT_LOCKED);
    // The 6-B exam of Subject A, dated while S5 was in 6-B so S5 is on its grid; the exam itself
    // is not locked (6-B's sheet is open), S5's mark on it is.
    const bExam = examOf(sixB, 0);
    expect(
      (
        await h.send(
          'patch',
          api(`/assessments/${bExam.id}`),
          { heldOn: isoDay(-12) },
          principal.cookie,
        )
      ).status,
    ).toBe(200);
    const lockedExam = await changeS5(bExam.id, 40, null);
    expect(lockedExam.status).toBe(409);
    expect(errorOf(lockedExam).code).toBe(ErrorCode.ASSESSMENT_LOCKED);
    expect(await liveMarkOf(bExam.id)).toBeNull();

    const approved = await sheetVerb(h, sheet.id, 'approve', principal);
    expect(approved.status).toBe(200);
    expect((approved.body as ResultSheetDetailDto).status).toBe('published');
    // After publication only the correction path (slice 32) may change them: the ordinary path
    // is refused.
    for (const attempt of [await changeS5(bTest, 2, s5Test), await changeS5(bExam.id, 41, null)]) {
      expect(attempt.status).toBe(409);
      expect(errorOf(attempt).code).toBe(ErrorCode.ASSESSMENT_LOCKED);
    }

    // ---------------------------------------------------------------------------- R270
    const onSheet = students.filter((s) => s.key !== 'S7');
    const expected: (ResultFigures & {
      key: string;
      figures: ReturnType<typeof composeSubject>[];
    })[] = onSheet.map((s) => {
      const figures = subjects.map((_, i) => {
        const testInputs: TestMarkInput[] = tests
          .filter((t) => t.subject === i && entered.has(`${s.key}|${t.id}`))
          .map((t) => {
            const v = entered.get(`${s.key}|${t.id}`)!;
            return {
              obtained: v === 'absent' ? null : v,
              max: t.max,
              absent: v === 'absent',
              excused: false,
              applicable: true,
            };
          });
        const exam = examOf(sixA, i);
        const v = entered.get(`${s.key}|${exam.id}`);
        const examInput: ExamMarkInput | null =
          v === undefined
            ? null
            : {
                obtained: v === 'absent' ? null : v,
                max: exam.maxMarks,
                absent: v === 'absent',
                excused: excused.has(`${s.key}|${exam.id}`),
              };
        return composeSubject({
          tests: testInputs,
          exam: examInput,
          weights: WEIGHTS,
          max: exam.maxMarks,
        });
      });
      const result = composeResult({
        subjects: figures.map((f, i) => ({ key: String(i), ...f })),
        bands: DEFAULT_GRADE_BANDS,
        passRule: 'all_subjects',
        passPercent: 40,
      });
      return { key: s.key, ...result, figures };
    });
    const ranks = positions(expected);
    const stored = await db.result.findMany({
      where: { schoolId: school.id, sheetId: BigInt(sheet.id) },
      include: { subjects: { orderBy: { sortOrder: 'asc' } } },
    });
    expect(stored).toHaveLength(6);
    for (const [i, s] of onSheet.entries()) {
      const row = stored.find((r) => r.studentId === s.id)!;
      const want = expected[i]!;
      expect(row.enrolmentId).toBe(s.enrolmentA);
      expect({
        totalObtained: row.totalObtained,
        totalMax: row.totalMax,
        percentBp: row.percentBp,
        grade: row.grade,
        passed: row.passed,
        failedSubjects: row.failedSubjects,
        position: row.position,
        positionOf: row.positionOf,
      }).toEqual({
        totalObtained: want.totalObtained,
        totalMax: want.totalMax,
        percentBp: want.percentBp,
        grade: want.grade,
        passed: want.passed,
        failedSubjects: want.failedSubjects.length,
        position: ranks[i]!.position,
        positionOf: ranks[i]!.positionOf,
      });
      expect(
        row.subjects.map((x) => ({
          testBp: x.testBp,
          examBp: x.examBp,
          percentBp: x.percentBp,
          obtained: x.obtained,
          max: x.max,
          status: x.status,
        })),
      ).toEqual(
        want.figures.map((x) => ({
          testBp: x.testBp,
          examBp: x.examBp,
          percentBp: x.percentBp,
          obtained: x.obtained,
          max: x.max,
          status: x.status,
        })),
      );
    }
    // The scenario's particulars, stated plainly.
    const of = (key: string) => stored.find((r) => r.studentId === st(key).id)!;
    expect(of('S2').subjects.find((x) => x.subjectName === 'Drawing')).toMatchObject({
      status: 'not_assessed',
      percentBp: null,
      obtained: null,
      examExcused: true,
    });
    expect(of('S4').subjects.find((x) => x.subjectName === 'Subject C')).toMatchObject({
      examBp: null,
      examExcused: true,
      status: 'assessed',
    });
    expect(of('S6').subjects.every((x) => x.testBp === null)).toBe(true);
    expect(of('S5').subjects.find((x) => x.subjectName === 'Subject A')?.testBp).toBe(
      expected[4]!.figures[0]!.testBp,
    );
    expect(expected[4]!.figures[0]!.testBp).not.toBeNull();
    // R276: the subject teacher who is S4's guardian flags S4 only.
    expect(of('S4').ownChildFlags).toEqual([
      { userId: String(parentTeacher.userId), role: 'mark_author' },
    ]);
    expect(
      onSheet
        .filter((s) => s.key !== 'S4')
        .every((s) => (of(s.key).ownChildFlags as unknown[]).length === 0),
    ).toBe(true);

    // ---------------------------------------------------------------------------- R277
    const attendance = await h.get(
      api(
        `/students/${st('S1').id}/attendance?dateFrom=${mid!.startsOn.toISOString().slice(0, 10)}&dateTo=${mid!.endsOn.toISOString().slice(0, 10)}`,
      ),
      principal.cookie,
    );
    expect(attendance.status).toBe(200);
    const percentage = (attendance.body as { percentage: number | null }).percentage;
    expect(percentage).not.toBeNull();
    expect(of('S1').attendanceBp).toBe(Math.round(percentage! * 100));
    expect(of('S2').attendanceBp).toBeNull();

    // ---------------------------------------------------------------------------- R273
    const job = h.app.get(ResultNotifyJob);
    expect(await job.run(school.id, { sheetId: BigInt(sheet.id) })).toBe(4);
    const messages = await db.message.findMany({
      where: { schoolId: school.id, type: 'result_published' },
    });
    // S1: the keypad guardian and S1's own login; S2, S3, S4: their guardian. S5 and S6 have no
    // guardian and no login: nobody to tell.
    expect(messages).toHaveLength(5);
    expect(messages.filter((m) => m.guardianId === keypad.id)).toHaveLength(1);
    expect(messages.filter((m) => m.studentId === st('S1').id)).toHaveLength(1);
    for (const m of messages) {
      expect(m.subjectType).toBe('result');
      expect(m.body).toMatch(/Mid-term result is published/);
      expect(m.body).not.toMatch(/position|remark/i);
    }
    expect(messages.find((m) => m.guardianId === keypad.id)?.channelPlan).toContain('sms');
    expect(await job.run(school.id, { sheetId: BigInt(sheet.id) })).toBe(0);

    // ---------------------------------------------------------------------------- R275
    // The Annual term is not held for the class: the final composes the Mid-term alone, its weight
    // renormalised (A6), with the year's attendance.
    expect(
      (
        await h.send(
          'post',
          api(`/terms/${annual!.id}/skip-class`),
          { classId: String(klass.id), reason: 'One term this year' },
          principal.cookie,
        )
      ).status,
    ).toBe(200);
    const finalOpen = await openSheet(h, principal, sixA.id, null);
    expect(finalOpen.status).toBe(201);
    const final = await sheetVerb(h, finalOpen.body.id, 'approve', principal);
    expect(final.status).toBe(200);
    const finals = await db.result.findMany({
      where: { schoolId: school.id, sheetId: BigInt(finalOpen.body.id) },
    });
    for (const s of onSheet) {
      const term = stored.find((r) => r.studentId === s.id)!;
      const want = composeFinal({
        terms: [
          {
            weight: mid!.weight,
            held: true,
            subjects: term.subjects.map((x) => ({
              key: String(x.classSubjectId),
              percentBp: x.percentBp,
              max: x.max,
            })),
          },
          { weight: annual!.weight, held: false, subjects: [] },
        ],
        bands: DEFAULT_GRADE_BANDS,
        passRule: 'all_subjects',
        passPercent: 40,
      });
      expect(finals.find((r) => r.studentId === s.id)).toMatchObject({
        percentBp: want.percentBp,
        totalObtained: want.totalObtained,
        grade: want.grade,
        passed: want.passed,
        termId: null,
      });
    }
    const finalSheet = await db.resultSheet.findFirst({
      where: { schoolId: school.id, id: BigInt(finalOpen.body.id) },
    });
    expect(finalSheet).toMatchObject({
      status: 'published',
      submittedBy: null,
      selfApproved: false,
    });
    expect(finalSheet?.termWeights).toEqual([
      { termId: String(mid!.id), weight: mid!.weight, held: true },
      { termId: String(annual!.id), weight: annual!.weight, held: false },
    ]);
  });
});
