// Slice 11 registers and marks end to end (contracts/slice-11.md §1-§4, §10.1): the dated,
// role-aware scope, the date and period rules, the roster, the submit's diff, window and reason,
// the amend and its history, replays and the two-teacher race. Rules: R118-R125, R174, R175.
import { Client } from 'pg';
import { Capability } from '@asms/shared';
import { ORIGIN } from '../staff/support';
import { createSchoolSession } from '../support/school-session';
import { closeTestDb, type TestSchool } from '../support/schools';
import { createSubject, createTeacherAssignment, type TestSection } from '../support/students';
import {
  AttendanceHarness,
  errorOf,
  fieldsOf,
  marks,
  schoolDay,
} from './harness';

interface Mark {
  id: string;
  enrolmentId: string;
  status: string;
  note: string | null;
  arrivedAt: string | null;
  amended: boolean;
  outcome?: string;
}
interface SubmitResult {
  created: boolean;
  register: { id: string; submittedBy: string; lastAmendedBy: string | null; source: string; mode: string };
  marks: Mark[];
  summary: { roster: number; marked: number; present: number; absent: number };
}
interface RegisterView {
  register: { id: string; teachingDay: boolean } | null;
  teachingDay: boolean;
  roster: { enrolmentId: string; studentFullName: string; rollNo: number | null; onRoster: boolean; mark: Mark | null }[];
  canSubmit: boolean;
  amendable: boolean;
  callerRole: string;
  periodsPerDay: number;
}


describe('slice 11 registers (e2e)', () => {
  const h = new AttendanceHarness();
  const db = h.db;

  beforeAll(() => h.start());
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });
  beforeEach(() => h.reset());
  afterEach(() => h.restoreClock());

  /** A school with a principal, office clerk, a class teacher of a daily section and three children. */
  async function fresh(opts: Parameters<AttendanceHarness['school']>[0] = {}) {
    const school = await h.school(opts);
    const principal = await h.caller(school, 'principal', 'Nadia Principal');
    const office = await h.caller(school, 'office_staff', 'Omar Office');
    const teacher = await h.caller(school, 'teacher', 'Tariq Teacher');
    const section = await h.section(school);
    await createTeacherAssignment(db, school, teacher, { role: 'class_teacher', section, startsOn: schoolDay(-30) });
    const children = [
      await h.child(school, section, { fullName: 'Zara Khan', rollNo: 2 }),
      await h.child(school, section, { fullName: 'Ali Raza', rollNo: 1 }),
      await h.child(school, section, { fullName: 'Bilal Ahmed', rollNo: null }),
    ];
    return { school, principal, office, teacher, section, children };
  }

  const view = (cookie: string, section: TestSection, date: string, period = 1) =>
    h.get(`/sections/${section.id}/register?date=${date}&period=${period}`, cookie);

  const changesOf = (school: TestSchool, markId: string) =>
    db.attendanceMarkChange.findMany({ where: { schoolId: school.id, markId: BigInt(markId) }, orderBy: { id: 'asc' } });

  const auditOf = (school: TestSchool, action: string) =>
    db.auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });

  describe('R119 first submit, later submits, idempotency', () => {
    it('R160: Prefer: return=minimal cuts each mark to { id, enrolmentId, outcome } and says so; without it the answer is whole; a replay with it is minimal too', async () => {
      const { teacher, section, children } = await fresh();
      const minimal = { Cookie: teacher.cookie, Origin: ORIGIN, Prefer: 'return=minimal' };
      const first = await h.submit(minimal, section, { date: schoolDay(), marks: marks(children, ['present', 'absent', 'late']) });
      expect([first.status, first.headers['preference-applied']]).toEqual([201, 'return=minimal']);
      expect(first.headers.vary).toMatch(/Prefer/i);
      const body = first.body as SubmitResult;
      expect(Object.keys(body).sort()).toEqual(['alerts', 'created', 'marks', 'register', 'summary']);
      expect(body).toMatchObject({ created: true, summary: { roster: 3, marked: 3, present: 1, absent: 1, late: 1 } });
      expect(body.marks).toEqual(
        children.map((c) => ({ id: expect.stringMatching(/^[1-9][0-9]*$/), enrolmentId: c.enrolmentId.toString(), outcome: 'created' })),
      );

      // The idempotent replay (same marks): 200, still minimal, the same mark ids.
      const replay = await h.submit({ ...minimal, Prefer: 'handling=lenient, return=minimal' }, section, {
        date: schoolDay(),
        marks: marks(children, ['present', 'absent', 'late']),
      });
      expect([replay.status, replay.headers['preference-applied']]).toEqual([200, 'return=minimal']);
      expect((replay.body as SubmitResult).marks).toEqual(body.marks.map((m) => ({ ...m, outcome: 'unchanged' })));
      expect((replay.body as { alerts: unknown }).alerts).toEqual({ absencePending: 0, absenceBackdated: 0, lateAdvicePending: 0, cancelled: 0, corrections: 0 });

      // Without the header: the whole marks, no Preference-Applied.
      const full = await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children, ['present', 'absent', 'late']) });
      expect([full.status, full.headers['preference-applied']]).toEqual([200, undefined]);
      expect((full.body as SubmitResult).marks[0]).toMatchObject({ status: 'present', date: schoolDay(), period: 1, outcome: 'unchanged' });
      expect(JSON.stringify(full.body).length).toBeGreaterThan(JSON.stringify(replay.body).length);
      // Any other preference is ignored.
      const other = await h.submit({ ...minimal, Prefer: 'return=representation' }, section, { date: schoolDay(), marks: marks(children, ['present', 'absent', 'late']) });
      expect([other.headers['preference-applied'], (other.body as SubmitResult).marks[0]]).toEqual([undefined, expect.objectContaining({ status: 'present' })]);
    });

    it('R119: a first submit missing one child is 422 ROSTER_INCOMPLETE naming it, and writes nothing', async () => {
      const { school, teacher, section, children } = await fresh();
      const res = await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children.slice(0, 2)) });
      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'ROSTER_INCOMPLETE',
        details: { missing: [children[2]?.enrolmentId.toString()] },
      });
      expect(await db.attendanceRegister.count({ where: { schoolId: school.id } })).toBe(0);
    });

    it('R119: the first submit is 201 and sets submitted_by/at; a later subset is 200 and sets last_amended_by/at; an identical replay is 200 and writes nothing', async () => {
      const { school, principal, teacher, section, children } = await fresh();
      const first = await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) });
      expect(first.status).toBe(201);
      const created = first.body as SubmitResult;
      expect(created).toMatchObject({
        created: true,
        register: { submittedBy: teacher.userId.toString(), lastAmendedBy: null, source: 'web', mode: 'daily' },
        summary: { roster: 3, marked: 3, present: 3, absent: 0 },
      });
      expect(created.marks.map((m) => m.outcome)).toEqual(['created', 'created', 'created']);
      expect((await auditOf(school, 'attendance_register.submitted')).length).toBe(1);

      const replay = await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) });
      expect(replay.status).toBe(200);
      expect((replay.body as SubmitResult).created).toBe(false);
      expect((replay.body as SubmitResult).marks.map((m) => m.outcome)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      expect(await db.attendanceMarkChange.count({ where: { schoolId: school.id } })).toBe(0);
      expect((await auditOf(school, 'attendance_register.amended')).length).toBe(0);

      const subset = await h.submit(principal.cookie, section, {
        date: schoolDay(),
        reason: 'Came back after the morning check',
        marks: [{ enrolmentId: children[0]?.enrolmentId.toString(), status: 'absent' }],
      });
      expect(subset.status).toBe(200);
      const amended = subset.body as SubmitResult;
      expect(amended.register).toMatchObject({
        submittedBy: teacher.userId.toString(),
        lastAmendedBy: principal.userId.toString(),
      });
      expect(amended.marks).toEqual([expect.objectContaining({ status: 'absent', outcome: 'amended', amended: true })]);
      expect(await db.attendanceMark.count({ where: { schoolId: school.id } })).toBe(3);
      expect(await auditOf(school, 'attendance_register.amended')).toEqual([
        expect.objectContaining({
          actorUserId: principal.userId,
          reason: 'Came back after the morning check',
          metadata: expect.objectContaining({ created: 0, amended: 1, afterWindow: false }) as unknown,
        }),
      ]);
    });

    it('R119: the session channel gives the source: a bearer session records `app`', async () => {
      const { school, teacher, section, children } = await fresh();
      const bearer = await createSchoolSession(db, school, teacher, { channel: 'bearer' });
      const res = await h.submit(bearer.bearer, section, { date: schoolDay(), marks: marks(children) });
      expect(res.status).toBe(201);
      expect((res.body as SubmitResult).register.source).toBe('app');
    });

    it('§4.2 step 1: a repeated enrolment and arrivedAt on a non-late mark are 422 before any read', async () => {
      const { teacher, section, children } = await fresh();
      const c = children[0]?.enrolmentId.toString();
      const dup = await h.submit(teacher.cookie, section, {
        date: schoolDay(),
        marks: [{ enrolmentId: c, status: 'present' }, { enrolmentId: c, status: 'absent' }],
      });
      expect(dup.status).toBe(422);
      expect(fieldsOf(dup)).toEqual([expect.objectContaining({ path: 'marks[1].enrolmentId' })]);
      const arrived = await h.submit(teacher.cookie, section, {
        date: schoolDay(),
        marks: [{ enrolmentId: c, status: 'present', arrivedAt: '08:40' }],
      });
      expect(fieldsOf(arrived)).toEqual([expect.objectContaining({ path: 'marks[0].arrivedAt' })]);
    });
  });

  describe('R122 amendments need a reason and leave history', () => {
    it('R122: a changed mark without a reason is 409 AMENDMENT_REASON_REQUIRED listing it; with a reason a change row holds actor, time and reason', async () => {
      const { school, teacher, section, children } = await fresh();
      const first = (await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) })).body as SubmitResult;
      const changed = marks(children, ['absent', 'present', 'present']);
      const refused = await h.submit(teacher.cookie, section, { date: schoolDay(), marks: changed });
      expect(refused.status).toBe(409);
      expect(errorOf(refused)).toMatchObject({
        code: 'AMENDMENT_REASON_REQUIRED',
        details: {
          amendments: [
            {
              enrolmentId: children[0]?.enrolmentId.toString(),
              markId: first.marks[0]?.id,
              from: 'present',
              to: 'absent',
              noteChanged: false,
            },
          ],
        },
      });
      const ok = await h.submit(teacher.cookie, section, { date: schoolDay(), marks: changed, reason: 'Misread the row' });
      expect(ok.status).toBe(200);
      expect(await changesOf(school, first.marks[0]?.id ?? '')).toEqual([
        expect.objectContaining({ oldStatus: 'present', newStatus: 'absent', changedBy: teacher.userId, reason: 'Misread the row' }),
      ]);
    });

    it('R122: a note-only change is an amendment (needs a reason, writes history)', async () => {
      const { school, teacher, section, children } = await fresh();
      const first = (await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) })).body as SubmitResult;
      const noted = [{ enrolmentId: children[0]?.enrolmentId.toString(), status: 'present', note: 'Left at noon' }];
      expect(errorOf(await h.submit(teacher.cookie, section, { date: schoolDay(), marks: noted })).details).toEqual({
        amendments: [expect.objectContaining({ noteChanged: true, from: 'present', to: 'present' })],
      });
      expect((await h.submit(teacher.cookie, section, { date: schoolDay(), marks: noted, reason: 'Add a note' })).status).toBe(200);
      expect(await changesOf(school, first.marks[0]?.id ?? '')).toEqual([
        expect.objectContaining({ oldNote: null, newNote: 'Left at noon', reason: 'Add a note' }),
      ]);
    });

    it('R122: a direct UPDATE without the transaction-local actor is refused by the database', async () => {
      const { teacher, section, children } = await fresh();
      const first = (await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) })).body as SubmitResult;
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      try {
        await expect(
          pg.query(`UPDATE attendance_marks SET status = 'absent' WHERE id = $1`, [first.marks[0]?.id]),
        ).rejects.toMatchObject({ constraint: 'attendance_mark_changes_actor_required' });
        // An update that changes nothing needs no actor (a replay is free).
        await pg.query(`UPDATE attendance_marks SET status = 'present' WHERE id = $1`, [first.marks[0]?.id]);
      } finally {
        await pg.end();
      }
    });

    it('§4.5: GET /attendance-marks/:id/changes pages the history newest first with the changer name', async () => {
      const { principal, teacher, section, children } = await fresh();
      const first = (await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) })).body as SubmitResult;
      const id = first.marks[0]?.id ?? '';
      await h.post(`/attendance-marks/${id}/amend`, { fromStatus: 'present', status: 'absent', reason: 'Gone home sick' }, teacher.cookie);
      await h.post(`/attendance-marks/${id}/amend`, { fromStatus: 'absent', status: 'late', arrivedAt: '09:10', reason: 'Back after the doctor' }, principal.cookie);
      const res = await h.get(`/attendance-marks/${id}/changes?limit=1`, teacher.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        total: 2,
        data: [
          {
            markId: id,
            fromStatus: 'absent',
            toStatus: 'late',
            toArrivedAt: '09:10',
            fromArrivedAt: null,
            changedByName: 'Nadia Principal',
            reason: 'Back after the doctor',
          },
        ],
      });
    });
  });

  describe('§4.3 amend', () => {
    it('R125: a stale fromStatus is 409 STALE_STATUS with the current status; the same status is a 200 no-write replay', async () => {
      const { school, teacher, section, children } = await fresh();
      const first = (await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) })).body as SubmitResult;
      const id = first.marks[0]?.id ?? '';
      const ok = await h.post(`/attendance-marks/${id}/amend`, { fromStatus: 'present', status: 'absent', reason: 'Not in class' }, teacher.cookie);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: 'absent', amended: true });
      const stale = await h.post(`/attendance-marks/${id}/amend`, { fromStatus: 'present', status: 'on_leave', reason: 'Leave note' }, teacher.cookie);
      expect(stale.status).toBe(409);
      expect(errorOf(stale)).toMatchObject({ code: 'STALE_STATUS', details: { currentStatus: 'absent' } });
      const same = await h.post(`/attendance-marks/${id}/amend`, { fromStatus: 'present', status: 'absent', reason: 'Again' }, teacher.cookie);
      expect(same.status).toBe(200);
      expect(await changesOf(school, id)).toHaveLength(1);
      expect((await auditOf(school, 'attendance_mark.amended')).length).toBe(1);
    });

    it('§4.3: arrivedAt needs status late; a change away from late clears it; note null clears', async () => {
      const { teacher, section, children } = await fresh();
      const first = (await h.submit(teacher.cookie, section, {
        date: schoolDay(),
        marks: [
          { enrolmentId: children[0]?.enrolmentId.toString(), status: 'late', arrivedAt: '08:20', note: 'Bus' },
          ...marks(children.slice(1)),
        ],
      })).body as SubmitResult;
      const id = first.marks[0]?.id ?? '';
      const bad = await h.post(`/attendance-marks/${id}/amend`, { fromStatus: 'late', status: 'present', arrivedAt: '08:30', reason: 'x y z' }, teacher.cookie);
      expect(fieldsOf(bad)).toEqual([expect.objectContaining({ path: 'arrivedAt', code: 'INVALID_VALUE' })]);
      const res = await h.post(`/attendance-marks/${id}/amend`, { fromStatus: 'late', status: 'present', note: null, reason: 'Was on time' }, teacher.cookie);
      expect(res.body).toMatchObject({ status: 'present', arrivedAt: null, note: null });
    });
  });

  describe('R118 R121 R124 dates, periods and the roster', () => {
    it('R118: a write on a weekly-off day or a published holiday is 409 NOT_A_TEACHING_DAY; a read says teachingDay false', async () => {
      const weekday = new Date(`${schoolDay(-1)}T00:00:00Z`).getUTCDay();
      const { school, principal, teacher, section, children } = await fresh({ weeklyOffDays: [weekday] });
      const off = await h.submit(teacher.cookie, section, { date: schoolDay(-1), marks: marks(children) });
      expect(off.status).toBe(409);
      expect(errorOf(off).code).toBe('NOT_A_TEACHING_DAY');
      const read = await view(teacher.cookie, section, schoolDay(-1));
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ teachingDay: false, register: null, amendable: false, canSubmit: true });

      await db.holiday.create({
        data: {
          schoolId: school.id,
          startsOn: new Date(`${schoolDay(-2)}T00:00:00Z`),
          endsOn: new Date(`${schoolDay(-2)}T00:00:00Z`),
          name: 'Closure',
          kind: 'school',
          status: 'published',
          publishedAt: new Date(),
          publishedBy: principal.userId,
        },
      });
      expect(errorOf(await h.submit(teacher.cookie, section, { date: schoolDay(-2), marks: marks(children) })).code).toBe(
        'NOT_A_TEACHING_DAY',
      );
    });

    it('R121: daily mode takes period 1 only; period mode 1..periodsPerDay; a read of period 10 after the setting dropped to 8 is 200', async () => {
      const { school, principal, teacher, section, children } = await fresh({ periodsPerDay: 10 });
      const daily = await h.submit(teacher.cookie, section, { date: schoolDay(), period: 2, marks: marks(children) });
      expect(fieldsOf(daily)).toEqual([expect.objectContaining({ path: 'period', code: 'INVALID_VALUE' })]);

      const periodSection = await h.section(school, { mode: 'period' });
      const kids = [await h.child(school, periodSection)];
      expect((await h.submit(principal.cookie, periodSection, { date: schoolDay(), period: 10, marks: marks(kids) })).status).toBe(201);
      await db.schoolSettings.updateMany({ where: { schoolId: school.id }, data: { periodsPerDay: 8 } });
      const over = await h.submit(principal.cookie, periodSection, { date: schoolDay(), period: 9, marks: marks(kids) });
      expect(fieldsOf(over)).toEqual([expect.objectContaining({ path: 'period' })]);
      const read = await view(principal.cookie, periodSection, schoolDay(), 10);
      expect(read.status).toBe(200);
      expect((read.body as RegisterView).register).not.toBeNull();
      expect((read.body as RegisterView).periodsPerDay).toBe(8);
      const shape = await view(principal.cookie, periodSection, schoolDay(), 13);
      expect(shape.status).toBe(422);
    });

    it('R124: a future date and a date outside the academic year are 422 on date', async () => {
      const { principal, section, children } = await fresh();
      const future = await h.submit(principal.cookie, section, { date: schoolDay(1), marks: marks(children) });
      expect(fieldsOf(future)).toEqual([expect.objectContaining({ path: 'date', code: 'INVALID_VALUE' })]);
      const before = await h.submit(principal.cookie, section, { date: schoolDay(-200), marks: marks(children) });
      expect(fieldsOf(before)).toEqual([expect.objectContaining({ path: 'date', code: 'INVALID_VALUE' })]);
    });

    it('R124: an enrolment not on the roster is 422 REFERENCE_NOT_FOUND and the request writes nothing (all or nothing)', async () => {
      const { school, principal, section, children } = await fresh();
      const elsewhere = await h.section(school);
      const outsider = await h.child(school, elsewhere);
      const late = await h.child(school, section, { startedOn: schoolDay(-1) });
      const res = await h.submit(principal.cookie, section, {
        date: schoolDay(-2),
        marks: [...marks(children), ...marks([outsider, late])],
      });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toEqual([
        expect.objectContaining({ path: 'marks[3].enrolmentId', code: 'REFERENCE_NOT_FOUND' }),
        expect.objectContaining({ path: 'marks[4].enrolmentId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(await db.attendanceRegister.count({ where: { schoolId: school.id } })).toBe(0);
      expect(await db.attendanceMark.count({ where: { schoolId: school.id } })).toBe(0);
    });

    it('R124: a child suspended from day d is on the roster of d−1 and off it from d (status read by date); a later reactivation returns them', async () => {
      const { school, principal, section, children } = await fresh();
      const [suspended] = children;
      await db.studentStatusChange.create({
        data: {
          schoolId: school.id,
          studentId: suspended?.studentId ?? 0n,
          fromStatus: 'active',
          toStatus: 'suspended',
          changedBy: principal.userId,
          effectiveOn: new Date(`${schoolDay(-3)}T00:00:00Z`),
        },
      });
      await db.studentStatusChange.create({
        data: {
          schoolId: school.id,
          studentId: suspended?.studentId ?? 0n,
          fromStatus: 'suspended',
          toStatus: 'active',
          changedBy: principal.userId,
          effectiveOn: new Date(`${schoolDay(-1)}T00:00:00Z`),
        },
      });
      const onRoster = async (date: string) =>
        ((await view(principal.cookie, section, date)).body as RegisterView).roster.map((r) => r.enrolmentId);
      const id = suspended?.enrolmentId.toString();
      expect(await onRoster(schoolDay(-4))).toContain(id);
      expect(await onRoster(schoolDay(-3))).not.toContain(id);
      expect(await onRoster(schoolDay(-2))).not.toContain(id);
      expect(await onRoster(schoolDay(-1))).toContain(id);
      // The suspended day's first submit needs only the other two.
      expect((await h.submit(principal.cookie, section, { date: schoolDay(-3), marks: marks(children.slice(1)) })).status).toBe(201);
    });

    it("R124: an exit's effectiveOn is still a day on roll (ended_on is the last day in force)", async () => {
      const { school, principal, section } = await fresh();
      const leaver = await h.child(school, section, { endedOn: schoolDay(-2) });
      const roster = async (date: string) =>
        ((await view(principal.cookie, section, date)).body as RegisterView).roster.map((r) => r.enrolmentId);
      expect(await roster(schoolDay(-2))).toContain(leaver.enrolmentId.toString());
      expect(await roster(schoolDay(-1))).not.toContain(leaver.enrolmentId.toString());
    });

    it('R124, R174: a marked child who later falls off the roster stays on that register (onRoster false) and can still be amended', async () => {
      const { school, principal, section, children } = await fresh();
      await h.submit(principal.cookie, section, { date: schoolDay(-2), marks: marks(children) });
      const [gone] = children;
      await db.studentStatusChange.create({
        data: {
          schoolId: school.id,
          studentId: gone?.studentId ?? 0n,
          fromStatus: 'active',
          toStatus: 'suspended',
          changedBy: principal.userId,
          effectiveOn: new Date(`${schoolDay(-2)}T00:00:00Z`),
        },
      });
      const read = (await view(principal.cookie, section, schoolDay(-2))).body as RegisterView;
      expect(read.roster.find((r) => r.enrolmentId === gone?.enrolmentId.toString())).toMatchObject({
        onRoster: false,
        mark: expect.objectContaining({ status: 'present' }) as unknown,
      });
      const res = await h.submit(principal.cookie, section, {
        date: schoolDay(-2),
        reason: 'Was absent before the suspension',
        marks: [{ enrolmentId: gone?.enrolmentId.toString(), status: 'absent' }],
      });
      expect(res.status).toBe(200);
    });

    it('R174, §1.6: a submit waits for a section change holding the student row, then reads the new roster (the child dated out is refused)', async () => {
      const { school, principal, section, children } = await fresh();
      const [moving] = children;
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      try {
        await pg.query('BEGIN');
        // What the change-section route holds while it probes the last mark: the student row.
        await pg.query('UPDATE students SET updated_at = updated_at WHERE school_id = $1 AND id = $2', [school.id, moving?.studentId]);
        let settled = false;
        const submit = h
          .submit(principal.cookie, section, { date: schoolDay(), marks: marks(children) })
          .finally(() => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        await pg.query(
          `UPDATE enrolments SET status = 'left', ended_on = $3::date WHERE school_id = $1 AND id = $2`,
          [school.id, moving?.enrolmentId, schoolDay(-1)],
        );
        await pg.query('COMMIT');
        const res = await submit;
        expect(res.status).toBe(422);
        expect(fieldsOf(res)).toEqual([expect.objectContaining({ path: 'marks[0].enrolmentId', code: 'REFERENCE_NOT_FOUND' })]);
      } finally {
        await pg.end();
      }
    });

    it('R124: the roster is ordered by roll number (nulls last), then name', async () => {
      const { principal, section } = await fresh();
      const read = (await view(principal.cookie, section, schoolDay())).body as RegisterView;
      expect(read.roster.map((r) => r.studentFullName)).toEqual(['Ali Raza', 'Zara Khan', 'Bilal Ahmed']);
      expect(read).toMatchObject({ register: null, canSubmit: true, amendable: true, callerRole: 'all' });
    });
  });

  describe('R120 R175 the dated, role-aware scope', () => {
    it('R120, R175: a subject teacher is 403 subject_teacher_daily_mode in daily mode and may submit in period mode', async () => {
      const { school, children, section } = await fresh();
      const subject = await createSubject(db, school);
      const st = await h.caller(school, 'teacher');
      await createTeacherAssignment(db, school, st, { role: 'subject_teacher', subjectId: subject.id, section, startsOn: schoolDay(-30) });
      const daily = await h.submit(st.cookie, section, { date: schoolDay(), marks: marks(children) });
      expect(daily.status).toBe(403);
      expect(errorOf(daily)).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'subject_teacher_daily_mode' } });
      const read = await view(st.cookie, section, schoolDay());
      expect(read.body).toMatchObject({ canSubmit: false, callerRole: 'subject_teacher', amendable: false });

      const periodSection = await h.section(school, { mode: 'period' });
      const kids = [await h.child(school, periodSection)];
      await createTeacherAssignment(db, school, st, {
        role: 'subject_teacher',
        subjectId: subject.id,
        section: periodSection,
        startsOn: schoolDay(-30),
      });
      expect((await h.submit(st.cookie, periodSection, { date: schoolDay(), period: 3, marks: marks(kids) })).status).toBe(201);
    });

    it('R120, R132, R175: a cover inside its dates writes; the day after it ends the register is 403 not_assigned_on_date', async () => {
      const { school, section, children } = await fresh();
      const cover = await h.caller(school, 'teacher', 'Cara Cover');
      await createTeacherAssignment(db, school, cover, { role: 'cover', section, startsOn: schoolDay(-2), endsOn: schoolDay(-1) });
      expect((await h.submit(cover.cookie, section, { date: schoolDay(-1), marks: marks(children) })).status).toBe(201);
      expect((await view(cover.cookie, section, schoolDay(-1))).body).toMatchObject({ callerRole: 'cover', canSubmit: true });
      const after = await h.submit(cover.cookie, section, { date: schoolDay(), marks: marks(children) });
      expect(after.status).toBe(403);
      expect(errorOf(after)).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'not_assigned_on_date' } });
      const read = await view(cover.cookie, section, schoolDay());
      expect(errorOf(read)).toMatchObject({ code: 'PERMISSION_DENIED', details: { reason: 'not_assigned_on_date' } });
    });

    it('R175: a teacher whose assignment starts after the date is 403 not_assigned_on_date for that date; a section never assigned is 404', async () => {
      const { school, section, children } = await fresh();
      const newcomer = await h.caller(school, 'teacher');
      const other = await h.section(school);
      await createTeacherAssignment(db, school, newcomer, { role: 'class_teacher', section: other, startsOn: schoolDay() });
      const kids = [await h.child(school, other)];
      const before = await h.submit(newcomer.cookie, other, { date: schoolDay(-1), marks: marks(kids) });
      expect(before.status).toBe(403);
      expect(errorOf(before).details).toEqual({ reason: 'not_assigned_on_date' });
      expect((await h.submit(newcomer.cookie, other, { date: schoolDay(), marks: marks(kids) })).status).toBe(201);
      // A section the teacher holds nothing in is 404 on every date.
      expect((await h.submit(newcomer.cookie, section, { date: schoolDay(), marks: marks(children) })).status).toBe(404);
    });

    it('R120: the principal and office staff (all scope) submit any section', async () => {
      const { school, principal, office, section, children } = await fresh();
      expect((await h.submit(office.cookie, section, { date: schoolDay(), marks: marks(children) })).status).toBe(201);
      const other = await h.section(school);
      expect((await h.submit(principal.cookie, other, { date: schoolDay(), marks: marks([await h.child(school, other)]) })).status).toBe(201);
    });

    it('R130: attendance.student.view_all alone reads every register (viewer) and the submit is 403 at the decorator', async () => {
      const { school, principal, section, children } = await fresh();
      await h.submit(principal.cookie, section, { date: schoolDay(), marks: marks(children) });
      const viewer = await h.caller(school, 'teacher');
      for (const [key, effect] of [
        [Capability.ATTENDANCE_STUDENT_VIEW_ALL, 'grant'],
        [Capability.ATTENDANCE_STUDENT_MARK, 'revoke'],
      ] as const) {
        await db.userCapabilityGrant.create({
          data: { schoolId: school.id, userId: viewer.userId, capabilityKey: key, effect, grantedBy: principal.userId, reason: 'Inspector' },
        });
      }
      const read = await view(viewer.cookie, section, schoolDay());
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ callerRole: 'viewer', canSubmit: false, amendable: false });
      const write = await h.submit(viewer.cookie, section, { date: schoolDay(), marks: marks(children) });
      expect(write.status).toBe(403);
      expect(errorOf(write).details).toBeNull();
    });

    it('§1.1: a section of another school is 404 with the same body as a missing one', async () => {
      const { principal, children } = await fresh();
      const { section: foreign } = await fresh();
      const a = await h.submit(principal.cookie, foreign, { date: schoolDay(), marks: marks(children) });
      const b = await h.submit(principal.cookie, { id: 999_999_999_999n }, { date: schoolDay(), marks: marks(children) });
      expect(a.status).toBe(404);
      const { code, message, details } = errorOf(b);
      expect(errorOf(a)).toEqual({ code, message, details, requestId: expect.any(String) as unknown });
    });
  });

  describe('R123 R125 the window and replays', () => {
    it('R123: a teacher past the window is 409 ATTENDANCE_LOCKED on a first submit, a later submit, an amend and an arrival', async () => {
      const { school, principal, teacher, section, children } = await fresh({ windowDays: 2 });
      const lockedFirst = await h.submit(teacher.cookie, section, { date: schoolDay(-3), marks: marks(children) });
      expect(lockedFirst.status).toBe(409);
      expect(errorOf(lockedFirst)).toMatchObject({ code: 'ATTENDANCE_LOCKED', details: { date: schoolDay(-3), windowDays: 2 } });

      // Recorded by the principal (all scope, never locked), audited afterWindow.
      const first = await h.submit(principal.cookie, section, { date: schoolDay(-3), marks: marks(children, ['absent', 'present', 'present']) });
      expect(first.status).toBe(201);
      expect((await auditOf(school, 'attendance_register.submitted'))[0]?.metadata).toMatchObject({ afterWindow: true });
      const result = first.body as SubmitResult;

      const later = await h.submit(teacher.cookie, section, {
        date: schoolDay(-3),
        reason: 'Correcting',
        marks: [{ enrolmentId: children[1]?.enrolmentId.toString(), status: 'absent' }],
      });
      expect(errorOf(later).code).toBe('ATTENDANCE_LOCKED');
      const amend = await h.post(`/attendance-marks/${result.marks[1]?.id}/amend`, { fromStatus: 'present', status: 'absent', reason: 'Correcting' }, teacher.cookie);
      expect(errorOf(amend).code).toBe('ATTENDANCE_LOCKED');
      const arrival = await h.post('/attendance-arrivals', { studentId: children[0]?.studentId.toString(), date: schoolDay(-3), arrivedAt: '09:00' }, teacher.cookie);
      expect(errorOf(arrival).code).toBe('ATTENDANCE_LOCKED');

      // The principal amends after the window with a reason: 200, audited afterWindow.
      const ok = await h.post(`/attendance-marks/${result.marks[1]?.id}/amend`, { fromStatus: 'present', status: 'absent', reason: 'Parent called' }, principal.cookie);
      expect(ok.status).toBe(200);
      expect((await auditOf(school, 'attendance_mark.amended'))[0]).toMatchObject({
        reason: 'Parent called',
        metadata: expect.objectContaining({ afterWindow: true, from: 'present', to: 'absent' }) as unknown,
      });
      expect((await view(teacher.cookie, section, schoolDay(-3))).body).toMatchObject({ canSubmit: true, amendable: false });
    });

    it('R125: an identical replay is 200 and writes no history after the window too (an outbox always clears)', async () => {
      const { school, principal, teacher, section, children } = await fresh({ windowDays: 0 });
      await h.submit(principal.cookie, section, { date: schoolDay(-1), marks: marks(children) });
      const replay = await h.submit(teacher.cookie, section, { date: schoolDay(-1), marks: marks(children) });
      expect(replay.status).toBe(200);
      expect(await db.attendanceMarkChange.count({ where: { schoolId: school.id } })).toBe(0);
      const differs = await h.submit(teacher.cookie, section, { date: schoolDay(-1), reason: 'x y z', marks: marks(children, 'absent') });
      expect(errorOf(differs).code).toBe('ATTENDANCE_LOCKED');
    });

    it('R125, decision 6: two teachers submitting the first register at once — one 201, the other 409 AMENDMENT_REASON_REQUIRED naming the differences; no duplicate marks', async () => {
      const { school, teacher, section, children } = await fresh();
      const cover = await h.caller(school, 'teacher');
      await createTeacherAssignment(db, school, cover, { role: 'cover', section, startsOn: schoolDay(-1), endsOn: schoolDay() });
      const [a, b] = await Promise.all([
        h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children, 'present') }),
        h.submit(cover.cookie, section, { date: schoolDay(), marks: marks(children, ['absent', 'present', 'present']) }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(errorOf(loser).code).toBe('AMENDMENT_REASON_REQUIRED');
      expect((errorOf(loser).details as { amendments: unknown[] }).amendments).toHaveLength(1);
      expect(await db.attendanceRegister.count({ where: { schoolId: school.id } })).toBe(1);
      expect(await db.attendanceMark.count({ where: { schoolId: school.id } })).toBe(3);
    });

    it('R125: two identical first submits at once — one 201, one 200 replay', async () => {
      const { school, teacher, office, section, children } = await fresh();
      const [a, b] = await Promise.all([
        h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) }),
        h.submit(office.cookie, section, { date: schoolDay(), marks: marks(children) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(await db.attendanceMark.count({ where: { schoolId: school.id } })).toBe(3);
    });
  });

  describe('R129 the registers console (GET /attendance-registers)', () => {
    it('R129: lists every section with a roster for the date, live, with teachers and the recorded filter; a teacher sees only their sections', async () => {
      const { school, principal, teacher, section, children } = await fresh();
      const cover = await h.caller(school, 'teacher', 'Cara Cover');
      await createTeacherAssignment(db, school, cover, { role: 'cover', section, startsOn: schoolDay(), endsOn: schoolDay() });
      const empty = await h.section(school, { className: 'Empty' });
      const other = await h.section(school, { className: 'ZZ Other' });
      await h.child(school, other);
      void empty;

      const unrecorded = await h.get(`/attendance-registers?date=${schoolDay()}&recorded=false`, principal.cookie);
      expect(unrecorded.status).toBe(200);
      const rows = unrecorded.body as { data: { sectionId: string }[]; total: number };
      expect(rows.total).toBe(2);
      expect(rows.data.find((r) => r.sectionId === section.id.toString())).toMatchObject({
        recorded: false,
        rosterCount: 3,
        registersExpected: 1,
        classTeacherStaffId: teacher.staffId.toString(),
        classTeacherName: 'Tariq Teacher',
        coverStaffIds: [cover.staffId.toString()],
        coverStaffName: 'Cara Cover',
      });

      await h.submit(teacher.cookie, section, { date: schoolDay(), marks: marks(children) });
      const after = await h.get(`/attendance-registers?date=${schoolDay()}&recorded=false`, principal.cookie);
      expect((after.body as { total: number }).total).toBe(1);
      const recorded = await h.get(`/attendance-registers?date=${schoolDay()}&recorded=true`, principal.cookie);
      expect((recorded.body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({
          sectionId: section.id.toString(),
          registersRecorded: 1,
          submittedByName: 'Tariq Teacher',
          declaredHolidayAfter: false,
        }),
      ]);
      const mine = await h.get(`/attendance-registers?date=${schoolDay()}`, teacher.cookie);
      expect((mine.body as { data: { sectionId: string }[] }).data.map((r) => r.sectionId)).toEqual([section.id.toString()]);
      expect((await h.get(`/attendance-registers?date=${schoolDay(1)}`, principal.cookie)).status).toBe(422);
    });
  });

  it('R16, R111: no response body of this suite carries an identity number', () => {
    for (const body of h.bodies) expect(body).not.toMatch(/[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/);
  });
});

