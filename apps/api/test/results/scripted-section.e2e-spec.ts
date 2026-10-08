// R296 (as far as slice 31 reaches), R270, R273, R275, R276, R277: the scripted section. Twelve
// subjects; tests of mixed sizes; a student who moved from 6-B to 6-A mid-term (their 6-B marks
// count, §0.25); a mid-term joiner (only the exams apply); a student who left (not on the sheet,
// A9); an unexcused absence (counts 0) and excused ones (left out); a subject not assessed for one
// student; a subject teacher who is a guardian of a student on the sheet (own-child flag). The
// class teacher submits, the principal approves; every stored figure equals the shared pure
// functions over what was entered; the attendance equals GET /students/:id/attendance; the
// messages are counted per family and student login. Slice 36 completes R296: the Annual term is
// held too (an unexcused exam absence composed to 0, term remarks on the card, own-child flags for
// the remark author, the submitter and the approver, a withheld card that still tells the family
// and is released by a payment), the final composes both terms (R275), and a correction after
// publication re-ranks the section and re-composes the final — every stored figure asserted
// against the shared pure functions.
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
import type { MarkCorrectionDto } from '../../src/modules/assessments/mark-corrections.dto';
import type { MyChildResultsDto } from '../../src/modules/results/my-results.dto';
import type { ResultDto, ResultSheetDetailDto } from '../../src/modules/results/results.dto';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { ResultNotifyJob } from '../../src/modules/results/result-notify.job';
import { captureOutbox, guardianLogin, studentLogin } from '../diary/support';
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
import { api, createTest, enterMarks, entryKey, openSheet, postKeyed, sheetVerb } from './support';

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

  it('stores exactly what the shared functions give, tells every family once, and composes the final (R277: attendance on the result equals GET /students/:id/attendance)', async () => {
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
    type Expected = ResultFigures & { key: string; figures: ReturnType<typeof composeSubject>[] };
    /** A term's figures by the pure functions, over the marks entered (R270). */
    const expectedOf = (
      termTests: readonly (typeof tests)[number][],
      examFor: (i: number) => { id: bigint; maxMarks: number },
      marks: ReadonlyMap<string, number | 'absent'>,
    ): Expected[] => onSheet.map((s) => {
      const figures = subjects.map((_, i) => {
        const testInputs: TestMarkInput[] = termTests
          .filter((t) => t.subject === i && marks.has(`${s.key}|${t.id}`))
          .map((t) => {
            const v = marks.get(`${s.key}|${t.id}`)!;
            return {
              obtained: v === 'absent' ? null : v,
              max: t.max,
              absent: v === 'absent',
              excused: false,
              applicable: true,
            };
          });
        const exam = examFor(i);
        const v = marks.get(`${s.key}|${exam.id}`);
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
    /** Every stored row of a term equals the pure functions' figures, positions included. */
    const expectStored = (
      rows: readonly { studentId: bigint; enrolmentId: bigint; totalObtained: number; totalMax: number; percentBp: number | null; grade: string | null; passed: boolean | null; failedSubjects: number; position: number | null; positionOf: number | null; subjects: { testBp: number | null; examBp: number | null; percentBp: number | null; obtained: number | null; max: number; status: string }[] }[],
      want: readonly Expected[],
    ) => {
      const wantRanks = positions(want);
      expect(rows).toHaveLength(want.length);
      for (const [i, s] of onSheet.entries()) {
        const row = rows.find((r) => r.studentId === s.id)!;
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
          totalObtained: want[i]!.totalObtained,
          totalMax: want[i]!.totalMax,
          percentBp: want[i]!.percentBp,
          grade: want[i]!.grade,
          passed: want[i]!.passed,
          failedSubjects: want[i]!.failedSubjects.length,
          position: wantRanks[i]!.position,
          positionOf: wantRanks[i]!.positionOf,
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
          want[i]!.figures.map((x) => ({
            testBp: x.testBp,
            examBp: x.examBp,
            percentBp: x.percentBp,
            obtained: x.obtained,
            max: x.max,
            status: x.status,
          })),
        );
      }
    };
    const midExam = (i: number) => examOf(sixA, i);
    const expected = expectedOf(tests, midExam, entered);
    const stored = await db.result.findMany({
      where: { schoolId: school.id, sheetId: BigInt(sheet.id) },
      include: { subjects: { orderBy: { sortOrder: 'asc' } } },
    });
    expectStored(stored, expected);
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

    // ---------------------------------------------------------------------------- the Annual term
    // Slice 36 (R296): the second term is held. Its exams (dated its last day, ahead of today) are
    // entered for every 6-A student; S3 is absent from Subject B's exam and not excused: it counts
    // 0, and with no Annual test the subject composes to 0 — assessed, printed "Ab".
    expect(
      (await h.send('post', api(`/terms/${annual!.id}/set-up-exams`), {}, principal.cookie)).status,
    ).toBe(200);
    const annualExams = await db.assessment.findMany({
      where: { schoolId: school.id, termId: annual!.id, kind: 'exam', sectionId: sixA.id },
    });
    const annualExam = (i: number) =>
      annualExams.find((e) => e.classSubjectId === subjects[i]!.classSubjectId)!;
    const annualEntered = new Map<string, number | 'absent'>();
    // An exams clerk (office, granted marks.enter: school-wide) enters them, Subject A aside: the
    // principal has used most of the minute's marks writes (60 a user).
    const clerk = await h.caller(school, 'office_staff', 'Exams Clerk');
    await db.userCapabilityGrant.create({
      data: {
        schoolId: school.id,
        userId: clerk.userId,
        capabilityKey: 'marks.enter',
        effect: 'grant',
        grantedBy: principal.userId,
        reason: 'Annual exam entry',
      },
    });
    for (let i = 0; i < SUBJECTS; i++) {
      const exam = annualExam(i);
      const rows: [bigint, number | 'absent'][] = [];
      for (const [k, s] of onSheet.entries()) {
        const value: number | 'absent' =
          s.key === 'S3' && i === 1 ? 'absent' : markFor(k + 3, 200 + i, exam.maxMarks);
        annualEntered.set(`${s.key}|${exam.id}`, value);
        rows.push([s.enrolmentA!, value]);
      }
      await enterMarks(h, exam.id, i === 0 ? parentTeacher : clerk, rows);
    }

    // The family of S2 owes a charge, and the school withholds cards until dues are cleared (R282):
    // the result message still goes out (rule 28); a payment releases the card.
    await db.$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
    const office = await h.caller(school, 'office_staff', 'Omar Office');
    const tuition = await db.feeHead.findFirstOrThrow({
      where: { schoolId: school.id, category: 'tuition' },
    });
    expect(
      (
        await postKeyed(
          h,
          api('/charges'),
          {
            enrolmentId: String(st('S2').enrolmentA),
            feeHeadId: String(tuition.id),
            amount: 2500,
            dueOn: isoDay(0),
            description: 'Tuition',
          },
          office.cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await h.send(
          'patch',
          api(`/academic-years/${year.id}/result-settings`),
          { withholdCardForDues: true },
          principal.cookie,
        )
      ).status,
    ).toBe(200);
    await db.studentGuardian.updateMany({
      where: { schoolId: school.id, studentId: s2.id, guardianId: whatsapp.id },
      data: { canLogin: true },
    });
    const s2Parent = await guardianLogin(db, school, whatsapp);

    // Own-child flags (R276): the class teacher and the principal are guardians of S4 as well.
    for (const [user, name] of [
      [classTeacher, 'S4 Mother'],
      [principal, 'S4 Uncle'],
    ] as const) {
      const guardian = await createGuardian(db, school, { fullName: name });
      await linkGuardian(db, school, s4, guardian, {
        isPrimaryContact: false,
        isFeePayer: false,
        relationship: 'other',
      });
      await db.user.updateMany({
        where: { schoolId: school.id, id: user.userId },
        data: { guardianId: guardian.id },
      });
    }

    const { body: annualSheet } = await openSheet(h, classTeacher, sixA.id, annual!.id);
    const remarks: Record<string, string> = {
      S1: 'A steady, careful worker.',
      S4: 'Works hard in every subject.',
    };
    expect(
      (
        await h.send(
          'patch',
          api(`/result-sheets/${annualSheet.id}`),
          {
            remarks: Object.entries(remarks).map(([key, remark]) => ({
              enrolmentId: String(st(key).enrolmentA),
              remark,
            })),
          },
          classTeacher.cookie,
        )
      ).status,
    ).toBe(200);
    expect((await sheetVerb(h, annualSheet.id, 'submit', classTeacher)).status).toBe(200);
    const annualApproved = await sheetVerb(h, annualSheet.id, 'approve', principal);
    expect(annualApproved.status).toBe(200);
    expect((annualApproved.body as ResultSheetDetailDto).status).toBe('published');
    const annualStored = await db.result.findMany({
      where: { schoolId: school.id, sheetId: BigInt(annualSheet.id) },
      include: { subjects: { orderBy: { sortOrder: 'asc' } } },
    });
    expectStored(annualStored, expectedOf([], annualExam, annualEntered));
    const annualOf = (key: string) => annualStored.find((r) => r.studentId === st(key).id)!;
    expect(annualOf('S3').subjects.find((x) => x.subjectName === 'Subject B')).toMatchObject({
      status: 'assessed',
      percentBp: 0,
      obtained: 0,
      examAbsent: true,
      examExcused: false,
    });
    // The remark is on the card; S3's absence prints "Ab".
    const card = (await h.get(api(`/results/${annualOf('S1').id}`), principal.cookie))
      .body as ResultDto;
    expect(card.remark).toBe(remarks.S1);
    const s3Print = await h.get(api(`/results/${annualOf('S3').id}/print`), principal.cookie);
    expect(s3Print.text).toContain('Subject B <span class="marker">Ab</span>');
    // R276: S4's row names the mark author, the remark author, the submitter and the approver.
    expect(annualOf('S4').ownChildFlags).toEqual([
      { userId: String(parentTeacher.userId), role: 'mark_author' },
      { userId: String(classTeacher.userId), role: 'remark_author' },
      { userId: String(classTeacher.userId), role: 'submitter' },
      { userId: String(principal.userId), role: 'approver' },
    ]);
    expect(
      onSheet
        .filter((s) => s.key !== 'S4')
        .every((s) => (annualOf(s.key).ownChildFlags as unknown[]).length === 0),
    ).toBe(true);

    // R273 with R282: the withheld family is still told; their card waits for the payment.
    expect(await job.run(school.id, { sheetId: BigInt(annualSheet.id) })).toBe(4);
    expect(
      await db.message.count({
        where: { schoolId: school.id, type: 'result_published', guardianId: whatsapp.id },
      }),
    ).toBe(2);
    const s2Results = () => h.get(api(`/me/children/${s2.id}/results`), s2Parent.cookie);
    const s2Card = () =>
      h.get(api(`/me/children/${s2.id}/results/${annualOf('S2').id}`), s2Parent.cookie);
    expect((await s2Results()).body as MyChildResultsDto).toMatchObject({
      withheld: true,
      outstanding: 2500,
    });
    expect((await s2Card()).body).toMatchObject({ withheld: true, result: null });
    expect(
      (
        await postKeyed(
          h,
          api('/payments'),
          {
            academicYearId: String(year.id),
            payerGuardianId: String(whatsapp.id),
            studentIds: [String(s2.id)],
            amount: 2500,
            method: 'cash',
            receivedOn: isoDay(0),
          },
          office.cookie,
        )
      ).status,
    ).toBe(201);
    expect((await s2Results()).body).toMatchObject({ withheld: false });
    expect(((await s2Card()).body as { result: ResultDto | null }).result?.id).toBe(
      String(annualOf('S2').id),
    );

    // ---------------------------------------------------------------------------- R275
    // Both terms held: the final composes them by their weights (composeFinal).
    const finalOpen = await openSheet(h, principal, sixA.id, null);
    expect(finalOpen.status).toBe(201);
    const final = await sheetVerb(h, finalOpen.body.id, 'approve', principal);
    expect(final.status).toBe(200);
    /** The live final rows equal composeFinal over each student's live term rows. */
    const expectFinal = async () => {
      const live = await db.result.findMany({
        where: { schoolId: school.id, academicYearId: year.id, supersededAt: null },
        include: { subjects: true },
      });
      const finals = live.filter((r) => r.termId === null);
      expect(finals).toHaveLength(onSheet.length);
      const wants = onSheet.map((s) => {
        const termRow = (termId: bigint) =>
          live.find((r) => r.studentId === s.id && r.termId === termId)!;
        return composeFinal({
          terms: [mid!, annual!].map((t) => ({
            weight: t.weight,
            held: true,
            subjects: termRow(t.id).subjects.map((x) => ({
              key: String(x.classSubjectId),
              percentBp: x.percentBp,
              max: x.max,
            })),
          })),
          bands: DEFAULT_GRADE_BANDS,
          passRule: 'all_subjects',
          passPercent: 40,
        });
      });
      const wantRanks = positions(wants);
      for (const [i, s] of onSheet.entries()) {
        expect(finals.find((r) => r.studentId === s.id)).toMatchObject({
          percentBp: wants[i]!.percentBp,
          totalObtained: wants[i]!.totalObtained,
          totalMax: wants[i]!.totalMax,
          grade: wants[i]!.grade,
          passed: wants[i]!.passed,
          failedSubjects: wants[i]!.failedSubjects.length,
          position: wantRanks[i]!.position,
          positionOf: wantRanks[i]!.positionOf,
          termId: null,
        });
      }
      return finals;
    };
    const finalsBefore = await expectFinal();
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
      { termId: String(annual!.id), weight: annual!.weight, held: true },
    ]);

    // ---------------------------------------------------------------------------- R280, R296
    // A correction after publication: Subject A's Mid-term exam (asked for by its teacher) of the
    // first student whose new mark moves a position. The principal approves: the Mid-term's
    // version 2 is written, re-ranked, and the published final re-composed in the same step.
    const before = positions(expected).map((p) => p.position);
    const examA = midExam(0);
    let chosen: { key: string; value: number; marks: Map<string, number | 'absent'> } | null =
      null;
    for (const s of onSheet.filter((x) => x.key !== 'S4')) {
      for (const value of [examA.maxMarks, 0]) {
        if (entered.get(`${s.key}|${examA.id}`) === value) continue;
        const marks = new Map(entered).set(`${s.key}|${examA.id}`, value);
        const after = positions(expectedOf(tests, midExam, marks)).map((p) => p.position);
        if (after.some((p, k) => p !== before[k])) {
          chosen = { key: s.key, value, marks };
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen) throw new Error('no single correction moves a position');
    const examMark = await db.mark.findFirstOrThrow({
      where: {
        schoolId: school.id,
        assessmentId: examA.id,
        studentId: st(chosen.key).id,
        status: 'live',
      },
    });
    const asked = await postKeyed(
      h,
      api(`/marks/${examMark.id}/correct`),
      { obtained: chosen.value, reason: 'Paper re-totalled' },
      parentTeacher.cookie,
    );
    expect(asked.status).toBe(201);
    const decided = await h.send(
      'post',
      api(`/mark-corrections/${(asked.body as MarkCorrectionDto).id}/approve`),
      {},
      principal.cookie,
    );
    expect(decided.status).toBe(200);
    const midLive = await db.result.findMany({
      where: { schoolId: school.id, termId: mid!.id, supersededAt: null },
      include: { subjects: { orderBy: { sortOrder: 'asc' } } },
    });
    expect(midLive.every((r) => r.sheetId !== BigInt(sheet.id))).toBe(true);
    expectStored(midLive, expectedOf(tests, midExam, chosen.marks));
    const finalsAfter = await expectFinal();
    expect(finalsAfter.every((r) => finalsBefore.every((b) => b.id !== r.id))).toBe(true);
  });
});
