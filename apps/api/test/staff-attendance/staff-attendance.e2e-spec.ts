// Staff attendance end to end (contracts/slice-12.md; R133-R136): the day sheet, submit and
// amend with their refusals and audit, the database's own R133/R134 triggers, the working-day
// rule, the markable set, the history arithmetic, the two history routes and the insert race.
import { Client } from 'pg';
import { Capability, ErrorCode, weekdayOf } from '@asms/shared';
import { summariseDatabaseError } from '../../src/common/errors/prisma-errors';
import { withChangeContext } from '../attendance/support';
import { errorOf, schoolDay, StaffHarness, type Caller } from '../staff/support';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';

interface Mark {
  id: string;
  staffId: string;
  date: string;
  status: string;
  note: string | null;
  markedBy: string;
  markedByName: string | null;
  amended: boolean;
  lastAmendedAt: string | null;
  lastAmendedByName: string | null;
  outcome?: string;
}
interface SubmitResult {
  date: string;
  workingDay: boolean;
  marks: Mark[];
  summary: Record<string, number>;
}
interface DayRow {
  staffId: string;
  fullName: string;
  staffStatus: string;
  mark: Mark | null;
}
interface Day {
  date: string;
  workingDay: boolean;
  employed: boolean;
  status: string | null;
  note?: string | null;
  markedByName?: string | null;
  amended: boolean;
}
interface History {
  staffId: string;
  workingDays: number;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
  unrecorded: number;
  days: Day[];
}

const api = (path: string) => `/api/v1${path}`;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Past dates (today − 1 … today − 60) that are not Sundays, newest first. */
const PAST_WEEKDAYS = Array.from({ length: 60 }, (_, i) => schoolDay(-(i + 1))).filter(
  (d) => weekdayOf(d) !== 0,
);
const workday = (n: number): string => {
  const d = PAST_WEEKDAYS[n];
  if (!d) throw new Error('no such workday');
  return d;
};
/** The constraint a refused write names (the trigger's DETAIL 'constraint: <name>'). */
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => 'accepted',
    (error: unknown) => summariseDatabaseError(error)?.constraint,
  );
const LAST_SUNDAY = Array.from({ length: 7 }, (_, i) => schoolDay(-(i + 1))).find(
  (d) => weekdayOf(d) === 0,
) as string;

describe('staff attendance (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;

  interface Fixture {
    school: TestSchool;
    principal: Caller;
    office: Caller;
    teacher: Caller;
  }

  /** A fresh school: principal, an office user granted attendance.staff.manage, a teacher. */
  async function fresh(): Promise<Fixture> {
    const school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const principal = await h.caller(school, 'principal', 'Nadia Principal');
    const office = await h.caller(school, 'office_staff', 'Omar Office');
    await grant(school, office, principal);
    const teacher = await h.caller(school, 'teacher', 'Tariq Teacher');
    return { school, principal, office, teacher };
  }
  const grant = (school: TestSchool, to: Caller, by: Caller) =>
    db.userCapabilityGrant.create({
      data: {
        schoolId: school.id,
        userId: to.userId,
        capabilityKey: Capability.ATTENDANCE_STAFF_MANAGE,
        effect: 'grant',
        grantedBy: by.userId,
        reason: 'Records staff attendance',
      },
    });
  const submit = (cookie: string, body: object) =>
    h.send('post', api('/staff-attendance/submit'), body, cookie);
  const amend = (cookie: string, id: string, body: object) =>
    h.send('post', api(`/staff-attendance/${id}/amend`), body, cookie);
  const rowsOf = (school: TestSchool, date: string) =>
    db.staffAttendance.findMany({ where: { schoolId: school.id, date: day(date) } });
  const auditOf = (school: TestSchool, action: string) =>
    db.auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });
  const publishHoliday = (
    f: Fixture,
    date: string,
    appliesToStaff: boolean,
    status: 'draft' | 'published' = 'published',
  ) =>
    db.holiday.create({
      data: {
        schoolId: f.school.id,
        startsOn: day(date),
        endsOn: day(date),
        name: 'Closure',
        kind: 'school',
        appliesToStaff,
        status,
        ...(status === 'published' ? { publishedAt: new Date(), publishedBy: f.principal.userId } : {}),
      },
    });
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;

  beforeAll(async () => {
    await h.start();
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  // ------------------------------------------------------------------------------- access

  it('§1: the day sheet and writes need attendance.staff.manage; the history needs staff.view', async () => {
    const f = await fresh();
    const date = workday(0);
    const plainOffice = await h.caller(f.school, 'office_staff');
    for (const caller of [f.teacher, plainOffice]) {
      expect((await h.get(api(`/staff-attendance?date=${date}`), caller.cookie)).status).toBe(403);
      const res = await submit(caller.cookie, { date, marks: [{ staffId: String(f.principal.staffId), status: 'present' }] });
      expect(res.status).toBe(403);
    }
    // R135: a teacher without staff.view cannot read another member's history.
    const range = `dateFrom=${workday(5)}&dateTo=${date}`;
    expect((await h.get(api(`/staff/${f.office.staffId}/attendance?${range}`), f.teacher.cookie)).status).toBe(403);
    // Another school's member (and a malformed id) is 404.
    const other = await fresh();
    expect((await h.get(api(`/staff/${other.teacher.staffId}/attendance?${range}`), f.office.cookie)).status).toBe(404);
    expect((await h.get(api(`/staff/abc/attendance?${range}`), f.office.cookie)).status).toBe(404);
    expect((await amend(f.office.cookie, '999999999', { fromStatus: 'present', status: 'absent', reason: 'Fix' })).status).toBe(404);
  });

  // ------------------------------------------------------------------------------- R134

  it('R134: a principal’s payload naming themself is refused whole, nothing written, even with 40 valid items', async () => {
    const f = await fresh();
    const others: Caller[] = [];
    for (let i = 0; i < 40; i++) others.push(await h.caller(f.school, 'teacher'));
    const date = workday(0);
    const res = await submit(f.principal.cookie, {
      date,
      marks: [
        ...others.map((o) => ({ staffId: String(o.staffId), status: 'present' })),
        { staffId: String(f.principal.staffId), status: 'present' },
      ],
    });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: ErrorCode.SELF_ACTION_FORBIDDEN,
      details: { staffId: String(f.principal.staffId) },
    });
    expect(await rowsOf(f.school, date)).toEqual([]);
    expect(await auditOf(f.school, 'staff_attendance.recorded')).toEqual([]);
  });

  it('R134: a second office user can mark the principal; nobody amends their own row', async () => {
    const f = await fresh();
    const date = workday(0);
    const res = await submit(f.office.cookie, {
      date,
      marks: [{ staffId: String(f.principal.staffId), status: 'late', note: 'Traffic' }],
    });
    expect(res.status).toBe(200);
    const [mark] = (res.body as SubmitResult).marks;
    expect(mark).toMatchObject({ status: 'late', note: 'Traffic', outcome: 'created', markedByName: 'Omar Office' });

    // The principal amending their own row is refused (R134), and the row is unchanged.
    const own = await amend(f.principal.cookie, mark!.id, { fromStatus: 'late', status: 'present', reason: 'I was on time' });
    expect(own.status).toBe(409);
    expect(errorOf(own)).toMatchObject({
      code: ErrorCode.SELF_ACTION_FORBIDDEN,
      details: { staffId: String(f.principal.staffId) },
    });
    // The office user's own row is refused to them as well.
    const self = await submit(f.office.cookie, { date, marks: [{ staffId: String(f.office.staffId), status: 'present' }] });
    expect(errorOf(self).code).toBe(ErrorCode.SELF_ACTION_FORBIDDEN);
    // The principal may mark the office user.
    expect((await submit(f.principal.cookie, { date, marks: [{ staffId: String(f.office.staffId), status: 'present' }] })).status).toBe(200);
    const rows = await rowsOf(f.school, date);
    expect(rows.map((r) => r.status).sort()).toEqual(['late', 'present']);
  });

  it('R134: the database refuses a direct INSERT marked by the member’s own login and a direct UPDATE whose actor is that login', async () => {
    const f = await fresh();
    const date = day(workday(1));
    expect(
      await refusal(
        db.staffAttendance.create({
          data: { schoolId: f.school.id, staffId: f.principal.staffId, date, status: 'present', markedBy: f.principal.userId },
        }),
      ),
    ).toBe('staff_attendance_not_self');
    const row = await db.staffAttendance.create({
      data: { schoolId: f.school.id, staffId: f.principal.staffId, date, status: 'present', markedBy: f.office.userId },
    });
    expect(
      await refusal(
        withChangeContext(db, f.principal.userId, 'Correcting myself', (tx) =>
          tx.staffAttendance.updateMany({ where: { schoolId: f.school.id, id: row.id }, data: { status: 'absent' } }),
        ),
      ),
    ).toBe('staff_attendance_not_self');
    expect((await db.staffAttendance.findFirst({ where: { schoolId: f.school.id, id: row.id } }))?.status).toBe('present');
  });

  // ------------------------------------------------------------------------------- R133

  it('R133: one row per member and date: replay unchanged, amendment needs a reason, every change is recorded', async () => {
    const f = await fresh();
    const date = workday(0);
    const staffId = String(f.teacher.staffId);
    const first = await submit(f.office.cookie, { date, marks: [{ staffId, status: 'present' }] });
    expect(first.status).toBe(200);
    const body = first.body as SubmitResult;
    expect(body).toMatchObject({ date, workingDay: true });
    expect(body.summary).toMatchObject({ staff: 3, marked: 1, present: 1, absent: 0, late: 0, onLeave: 0 });
    const markId = body.marks[0]!.id;

    // Identical replay: 200, unchanged, no history, no audit.
    const replay = await submit(f.office.cookie, { date, marks: [{ staffId, status: 'present' }] });
    expect(replay.status).toBe(200);
    expect((replay.body as SubmitResult).marks[0]).toMatchObject({ id: markId, outcome: 'unchanged', amended: false });
    expect(await auditOf(f.school, 'staff_attendance.recorded')).toHaveLength(1);

    // A different status without a reason is refused with the diff.
    const noReason = await submit(f.office.cookie, { date, marks: [{ staffId, status: 'absent', note: 'Sick' }] });
    expect(noReason.status).toBe(409);
    expect(errorOf(noReason)).toMatchObject({
      code: ErrorCode.AMENDMENT_REASON_REQUIRED,
      details: { amendments: [{ staffId, markId, from: 'present', to: 'absent', noteChanged: true }] },
    });

    // With a reason: amended, recorded with actor and reason, audited.
    const withReason = await submit(f.office.cookie, {
      date,
      reason: 'Phoned in sick',
      marks: [{ staffId, status: 'absent', note: 'Sick' }],
    });
    expect(withReason.status).toBe(200);
    expect((withReason.body as SubmitResult).marks[0]).toMatchObject({
      id: markId,
      outcome: 'amended',
      status: 'absent',
      amended: true,
      lastAmendedByName: 'Omar Office',
    });
    const changes = await db.staffAttendanceChange.findMany({ where: { schoolId: f.school.id, staffAttendanceId: BigInt(markId) } });
    expect(changes).toEqual([
      expect.objectContaining({ oldStatus: 'present', newStatus: 'absent', newNote: 'Sick', changedBy: f.office.userId, reason: 'Phoned in sick' }),
    ]);
    const [audit] = await auditOf(f.school, 'staff_attendance.amended');
    expect(audit).toMatchObject({
      actorUserId: f.office.userId,
      subjectType: 'user',
      subjectId: f.office.userId,
      reason: 'Phoned in sick',
      metadata: { date, created: 0, amended: 1, afterWindow: false, staffIds: staffId },
    });
    expect(await rowsOf(f.school, date)).toHaveLength(1);

    // A direct UPDATE without the transaction-local actor is refused by the database.
    expect(
      await refusal(
        db.staffAttendance.updateMany({ where: { schoolId: f.school.id, id: BigInt(markId) }, data: { status: 'late' } }),
      ),
    ).toBe('staff_attendance_changes_actor_required');
    // With an actor but no reason, likewise.
    expect(
      await refusal(
        withChangeContext(db, f.office.userId, null, (tx) =>
          tx.staffAttendance.updateMany({ where: { schoolId: f.school.id, id: BigInt(markId) }, data: { status: 'late' } }),
        ),
      ),
    ).toBe('staff_attendance_changes_reason_required');
  });

  it('R133: amend checks fromStatus (STALE_STATUS), a same-value amend is a 200 with no write, a note can be cleared', async () => {
    const f = await fresh();
    const date = workday(2);
    const res = await submit(f.office.cookie, { date, marks: [{ staffId: String(f.teacher.staffId), status: 'absent', note: 'No call' }] });
    const id = (res.body as SubmitResult).marks[0]!.id;

    const stale = await amend(f.principal.cookie, id, { fromStatus: 'present', status: 'late', reason: 'Arrived late' });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: ErrorCode.STALE_STATUS, details: { currentStatus: 'absent' } });

    const same = await amend(f.principal.cookie, id, { fromStatus: 'present', status: 'absent', reason: 'No change' });
    expect(same.status).toBe(200);
    expect(await auditOf(f.school, 'staff_attendance_mark.amended')).toEqual([]);

    const ok = await amend(f.principal.cookie, id, { fromStatus: 'absent', status: 'late', reason: 'Arrived late', note: null });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id, status: 'late', note: null, amended: true, lastAmendedByName: 'Nadia Principal', markedByName: 'Omar Office' });
    const [audit] = await auditOf(f.school, 'staff_attendance_mark.amended');
    expect(audit).toMatchObject({
      subjectType: 'staff_attendance',
      subjectId: BigInt(id),
      reason: 'Arrived late',
      metadata: { staffId: String(f.teacher.staffId), date, from: 'absent', to: 'late', noteChanged: true, afterWindow: false },
    });
    // A reason is required on amend; a reason with an identity number is refused.
    expect((await amend(f.principal.cookie, id, { fromStatus: 'late', status: 'present' })).status).toBe(422);
    expect((await amend(f.principal.cookie, id, { fromStatus: 'late', status: 'present', reason: 'See 3520112345671' })).status).toBe(422);
  });

  it('R133: a write past the amendment window is allowed and audited afterWindow', async () => {
    const f = await fresh();
    const date = workday(20);
    const staffId = String(f.teacher.staffId);
    await submit(f.office.cookie, { date, marks: [{ staffId, status: 'present' }] });
    const res = await submit(f.office.cookie, { date, reason: 'Register checked', marks: [{ staffId, status: 'on_leave' }] });
    expect(res.status).toBe(200);
    const [audit] = await auditOf(f.school, 'staff_attendance.amended');
    expect(audit?.metadata).toMatchObject({ afterWindow: true });
  });

  // ------------------------------------------------------------------------------- shape and dates

  it('§4.2: shape and date refusals: repeats, future, older than 366 days', async () => {
    const f = await fresh();
    const staffId = String(f.teacher.staffId);
    const repeat = await submit(f.office.cookie, {
      date: workday(0),
      marks: [
        { staffId, status: 'present' },
        { staffId, status: 'absent' },
      ],
    });
    expect(repeat.status).toBe(422);
    expect(fieldsOf(repeat)).toEqual([expect.objectContaining({ path: 'marks[1].staffId', code: ErrorCode.INVALID_VALUE })]);
    expect((await submit(f.office.cookie, { date: workday(0), marks: [] })).status).toBe(422);
    expect((await submit(f.office.cookie, { date: workday(0), schoolId: '1', marks: [{ staffId, status: 'present' }] })).status).toBe(422);
    for (const date of [schoolDay(1), schoolDay(-367)]) {
      const res = await submit(f.office.cookie, { date, marks: [{ staffId, status: 'present' }] });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toEqual([expect.objectContaining({ path: 'date', code: ErrorCode.INVALID_VALUE })]);
    }
    expect((await h.get(api(`/staff-attendance?date=${schoolDay(1)}`), f.office.cookie)).status).toBe(422);
  });

  // ------------------------------------------------------------------------------- R136

  it('R136: a weekly-off day and a published staff holiday are refused with details.reason; teaching-only and draft holidays are not', async () => {
    const f = await fresh();
    const marks = [{ staffId: String(f.teacher.staffId), status: 'present' }];
    const sunday = await submit(f.office.cookie, { date: LAST_SUNDAY, marks });
    expect(sunday.status).toBe(409);
    expect(errorOf(sunday)).toMatchObject({
      code: ErrorCode.NOT_A_TEACHING_DAY,
      message: 'Not a working day for staff.',
      details: { reason: 'weekly_off' },
    });

    await publishHoliday(f, workday(3), true);
    const holiday = await submit(f.office.cookie, { date: workday(3), marks });
    expect(holiday.status).toBe(409);
    expect(errorOf(holiday)).toMatchObject({ code: ErrorCode.NOT_A_TEACHING_DAY, details: { reason: 'staff_holiday' } });

    await publishHoliday(f, workday(4), false);
    expect((await submit(f.office.cookie, { date: workday(4), marks })).status).toBe(200);
    await publishHoliday(f, workday(5), true, 'draft');
    expect((await submit(f.office.cookie, { date: workday(5), marks })).status).toBe(200);
    expect(await rowsOf(f.school, workday(3))).toEqual([]);
  });

  it('R136: a mark on a day later declared a staff holiday stays amendable and is listed but not counted', async () => {
    const f = await fresh();
    const date = workday(1);
    const res = await submit(f.office.cookie, { date, marks: [{ staffId: String(f.teacher.staffId), status: 'absent' }] });
    const id = (res.body as SubmitResult).marks[0]!.id;
    await publishHoliday(f, date, true);
    const fixed = await amend(f.office.cookie, id, { fromStatus: 'absent', status: 'present', reason: 'Was here' });
    expect(fixed.status).toBe(200);
    const history = (await h.get(api(`/staff/${f.teacher.staffId}/attendance?dateFrom=${date}&dateTo=${date}`), f.office.cookie)).body as History;
    expect(history).toMatchObject({ workingDays: 0, present: 0, unrecorded: 0 });
    expect(history.days).toEqual([expect.objectContaining({ date, workingDay: false, status: 'present', amended: true })]);
  });

  // ------------------------------------------------------------------------------- markable set

  it('§3: left, suspended and not-yet-joined members are REFERENCE_NOT_FOUND; a member who left stays on the day they were marked', async () => {
    const f = await fresh();
    const date = workday(2);
    const leaver = await h.caller(f.school, 'teacher', 'Lena Leaver');
    const suspended = await h.caller(f.school, 'teacher', 'Sami Suspended');
    const joiner = await h.caller(f.school, 'teacher', 'Jamil Joiner');
    expect((await submit(f.office.cookie, { date, marks: [{ staffId: String(leaver.staffId), status: 'present' }] })).status).toBe(200);
    await db.staff.updateMany({ where: { schoolId: f.school.id, id: leaver.staffId }, data: { status: 'left', leftOn: day(workday(0)) } });
    await db.staff.updateMany({ where: { schoolId: f.school.id, id: suspended.staffId }, data: { status: 'suspended' } });
    await db.staff.updateMany({ where: { schoolId: f.school.id, id: joiner.staffId }, data: { joinedOn: day(workday(0)) } });

    const res = await submit(f.office.cookie, {
      date,
      marks: [
        { staffId: String(f.teacher.staffId), status: 'present' },
        { staffId: String(leaver.staffId), status: 'absent' },
        { staffId: String(suspended.staffId), status: 'present' },
        { staffId: String(joiner.staffId), status: 'present' },
      ],
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res).map((x) => [x.path, x.code])).toEqual([
      ['marks[1].staffId', ErrorCode.REFERENCE_NOT_FOUND],
      ['marks[2].staffId', ErrorCode.REFERENCE_NOT_FOUND],
      ['marks[3].staffId', ErrorCode.REFERENCE_NOT_FOUND],
    ]);
    // All or nothing: the valid first item was not written either.
    expect((await rowsOf(f.school, date)).map((r) => r.staffId)).toEqual([leaver.staffId]);

    // The sheet: active members joined by the date, plus the leaver marked that day.
    const sheet = (await h.get(api(`/staff-attendance?date=${date}&limit=50`), f.office.cookie)).body as { data: DayRow[]; total: number };
    expect(sheet.data.map((r) => r.fullName)).toEqual(['Lena Leaver', 'Nadia Principal', 'Omar Office', 'Tariq Teacher']);
    expect(sheet.data[0]).toMatchObject({ staffStatus: 'left', mark: { status: 'present' } });
    // A left member's history is still readable by staff.view.
    const history = await h.get(api(`/staff/${leaver.staffId}/attendance?dateFrom=${date}&dateTo=${date}`), f.office.cookie);
    expect(history.status).toBe(200);
    expect((history.body as History).present).toBe(1);
  });

  it('§4.1: the sheet filters by status and unrecorded, searches by name, sorts by status with unrecorded last', async () => {
    const f = await fresh();
    const date = workday(1);
    const extra = await h.caller(f.school, 'teacher', 'Aisha Absent');
    await submit(f.office.cookie, {
      date,
      marks: [
        { staffId: String(extra.staffId), status: 'absent', note: 'Fever' },
        { staffId: String(f.teacher.staffId), status: 'present' },
      ],
    });
    const get = async (query: string) =>
      ((await h.get(api(`/staff-attendance?date=${date}&${query}`), f.office.cookie)).body as { data: DayRow[]; total: number });
    expect((await get('sort=status')).data.map((r) => r.fullName)).toEqual([
      'Tariq Teacher',
      'Aisha Absent',
      'Nadia Principal',
      'Omar Office',
    ]);
    expect((await get('sort=-fullName&limit=1&page=2')).data.map((r) => r.fullName)).toEqual(['Omar Office']);
    expect(await get('status=unrecorded')).toMatchObject({ total: 2 });
    const absent = await get('status=absent');
    expect(absent.data).toEqual([expect.objectContaining({ fullName: 'Aisha Absent', mark: expect.objectContaining({ note: 'Fever' }) })]);
    expect((await get('q=tariq')).data.map((r) => r.fullName)).toEqual(['Tariq Teacher']);
    expect((await h.get(api(`/staff-attendance?date=${date}&q=35201-1234567-1`), f.office.cookie)).status).toBe(422);
  });

  // ------------------------------------------------------------------------------- R135 history

  it('R135: workingDays and unrecorded over a weekly-off day, a staff holiday, a teaching-only holiday and joined_on', async () => {
    const f = await fresh();
    const dateFrom = schoolDay(-20);
    const dateTo = schoolDay(0);
    const joined = workday(12);
    await db.staff.updateMany({ where: { schoolId: f.school.id, id: f.teacher.staffId }, data: { joinedOn: day(joined) } });
    const staffHoliday = workday(6);
    const teachingHoliday = workday(7);
    await publishHoliday(f, staffHoliday, true);
    await publishHoliday(f, teachingHoliday, false);
    const staffId = String(f.teacher.staffId);
    await submit(f.office.cookie, { date: workday(1), marks: [{ staffId, status: 'present' }] });
    await submit(f.office.cookie, { date: workday(2), marks: [{ staffId, status: 'late' }] });
    await submit(f.office.cookie, { date: teachingHoliday, marks: [{ staffId, status: 'on_leave' }] });

    // Expected from first principles: every date in range, Sunday off, the staff holiday off,
    // before joined_on not employed.
    const dates = Array.from({ length: 21 }, (_, i) => schoolDay(-20 + i));
    const expectedWorking = dates.filter((d) => weekdayOf(d) !== 0 && d !== staffHoliday && d >= joined).length;

    const res = await h.get(api(`/staff/${staffId}/attendance?dateFrom=${dateFrom}&dateTo=${dateTo}`), f.office.cookie);
    expect(res.status).toBe(200);
    const history = res.body as History;
    expect(history).toMatchObject({
      staffId,
      workingDays: expectedWorking,
      present: 1,
      late: 1,
      onLeave: 1,
      absent: 0,
      unrecorded: expectedWorking - 3,
    });
    expect(history.days).toHaveLength(21);
    const byDate = new Map(history.days.map((d) => [d.date, d]));
    expect(byDate.get(staffHoliday)).toMatchObject({ workingDay: false, employed: true });
    expect(byDate.get(teachingHoliday)).toMatchObject({ workingDay: true, status: 'on_leave' });
    expect(byDate.get(dateFrom)?.employed).toBe(dateFrom >= joined);
    expect(byDate.get(workday(1))).toMatchObject({ status: 'present', markedByName: 'Omar Office', note: null });

    // A range over 366 days, or backwards, is refused on dateTo.
    for (const q of [`dateFrom=${schoolDay(-400)}&dateTo=${dateTo}`, `dateFrom=${dateTo}&dateTo=${dateFrom}`]) {
      const bad = await h.get(api(`/staff/${staffId}/attendance?${q}`), f.office.cookie);
      expect(bad.status).toBe(422);
      expect(fieldsOf(bad)[0]?.path).toBe('dateTo');
    }
  });

  it('R135: any active staff member reads their own history without note or markedByName; staff.view sees both', async () => {
    const f = await fresh();
    const date = workday(1);
    await submit(f.office.cookie, { date, marks: [{ staffId: String(f.teacher.staffId), status: 'absent', note: 'Did not inform' }] });
    const range = `dateFrom=${date}&dateTo=${date}`;

    const mine = await h.get(api(`/me/staff/attendance?${range}`), f.teacher.cookie);
    expect(mine.status).toBe(200);
    const own = mine.body as History;
    expect(own).toMatchObject({ staffId: String(f.teacher.staffId), absent: 1, workingDays: 1, unrecorded: 0 });
    expect(own.days).toEqual([{ date, workingDay: true, employed: true, status: 'absent', amended: false }]);
    expect(mine.text).not.toContain('Did not inform');
    expect(mine.text).not.toContain('Omar Office');

    const viewed = (await h.get(api(`/staff/${f.teacher.staffId}/attendance?${range}`), f.office.cookie)).body as History;
    expect(viewed.days[0]).toMatchObject({ note: 'Did not inform', markedByName: 'Omar Office' });

    // The principal reads their own (empty) history too.
    const principal = (await h.get(api(`/me/staff/attendance?${range}`), f.principal.cookie)).body as History;
    expect(principal).toMatchObject({ staffId: String(f.principal.staffId), unrecorded: 1 });
  });

  // ------------------------------------------------------------------------------- concurrency

  it('§4.2 step 7: an insert that loses the natural-key race is 409 CONCURRENT_UPDATE; the resubmit is a replay', async () => {
    const f = await fresh();
    const second = await h.caller(f.school, 'office_staff', 'Sara Second');
    await grant(f.school, second, f.principal);
    const date = workday(3);
    const staffId = f.teacher.staffId;
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      // The second office user's insert, uncommitted, holds the natural key.
      await pg.query('BEGIN');
      await pg.query(
        `INSERT INTO staff_attendance (school_id, staff_id, date, status, marked_by) VALUES ($1, $2, $3, 'present', $4)`,
        [f.school.id.toString(), staffId.toString(), date, second.userId.toString()],
      );
      const pending = submit(f.office.cookie, { date, marks: [{ staffId: String(staffId), status: 'present' }] });
      // Wait until the request's insert is blocked on the uncommitted row.
      for (let i = 0; i < 200; i++) {
        const { rows } = await pg.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%staff_attendance%'`,
        );
        if (Number(rows[0]?.n) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await pg.query('COMMIT');
      const lost = await pending;
      expect(lost.status).toBe(409);
      expect(errorOf(lost).code).toBe(ErrorCode.CONCURRENT_UPDATE);
    } finally {
      await pg.end();
    }
    const replay = await submit(f.office.cookie, { date, marks: [{ staffId: String(staffId), status: 'present' }] });
    expect(replay.status).toBe(200);
    expect((replay.body as SubmitResult).marks[0]).toMatchObject({ outcome: 'unchanged', markedByName: 'Sara Second' });
    expect(await rowsOf(f.school, date)).toHaveLength(1);
  });

  it('§4.2: two office users submitting the same day at once leave one row per member', async () => {
    const f = await fresh();
    const second = await h.caller(f.school, 'office_staff');
    await grant(f.school, second, f.principal);
    const date = workday(4);
    const body = { date, marks: [{ staffId: String(f.teacher.staffId), status: 'present' }] };
    const results = await Promise.all([submit(f.office.cookie, body), submit(second.cookie, body)]);
    for (const res of results) {
      expect([200, 409]).toContain(res.status);
      if (res.status === 409) expect(errorOf(res).code).toBe(ErrorCode.CONCURRENT_UPDATE);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(await rowsOf(f.school, date)).toHaveLength(1);
  });

  it('R16: no response body or log line carried an identity number', () => {
    for (const text of [...h.bodies, ...h.logs]) expect(text).not.toMatch(/[0-9]{13}/);
  });
});
