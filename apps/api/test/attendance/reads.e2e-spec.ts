// Slice 11 reads (contracts/slice-11.md §10, §1.4): a student's attendance on the staff route and
// the two /me routes, the reports, and the percentage report's SQL against the shared function on
// seeded data. Rules: R128, R130, R131, R164, R165, R167.
import { randomInt } from 'node:crypto';
import { Capability, type AttendanceStatus } from '@asms/shared';
import { AttendanceRollup } from '../../src/modules/attendance/attendance-jobs';
import { closeTestDb, type TestSchool } from '../support/schools';
import { createTeacherAssignment, type TestSection } from '../support/students';
import { guardianLogin, studentLogin } from '../diary/support';
import { asSchool } from '../messaging/support';
import { AttendanceHarness, D, errorOf, fieldsOf, marks, schoolDay, type Child } from './harness';

interface StudentAttendance {
  studentId: string;
  percentage: number | null;
  countedDays: number;
  teachingDays: number;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
  partial: number;
  excludedLeaveDays: number;
  unrecorded: number;
  days: { date: string; teachingDay: boolean; enrolled: boolean; status: string | null; value: number | null; periods: unknown[] }[];
}
interface PercentageRow {
  studentId: string;
  percentage: number | null;
  countedDays: number;
  teachingDays: number;
  sectionName: string | null;
}

/** Every key a StudentAttendanceDto may carry (R165: no note, teacher, alert or other student). */
const STUDENT_ATTENDANCE_KEYS = [
  'studentId', 'dateFrom', 'dateTo', 'percentage', 'countedDays', 'teachingDays', 'present', 'absent',
  'late', 'onLeave', 'partial', 'excludedLeaveDays', 'unrecorded', 'days',
].sort();
const DAY_KEYS = ['date', 'teachingDay', 'enrolled', 'status', 'value', 'periods'].sort();
const PERIOD_KEYS = ['period', 'status', 'arrivedAt'].sort();

describe('slice 11 reads (e2e)', () => {
  const h = new AttendanceHarness();
  const db = h.db;
  let rollup: AttendanceRollup;

  beforeAll(async () => {
    await h.start();
    rollup = h.app.get(AttendanceRollup, { strict: false });
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });
  beforeEach(() => h.reset());
  afterEach(() => h.restoreClock());

  const recompute = (school: TestSchool, sectionId: bigint, date: string) =>
    asSchool(h.app, school.id, () => rollup.recompute(school.id, sectionId, D(date)));
  const studentRange = (from: number, to: number) => `dateFrom=${schoolDay(from)}&dateTo=${schoolDay(to)}`;

  describe('§10.4 a student’s attendance', () => {
    it('R128, R167: days, values and the percentage come from the materialised rows and the calendar now; a holiday declared after excludes the day and cancelling it restores it', async () => {
      const school = await h.school({ lateCountsAs: 'half_day' });
      const principal = await h.caller(school, 'principal');
      const section = await h.section(school);
      const kid = await h.child(school, section);
      const statuses: [number, AttendanceStatus][] = [[-4, 'present'], [-3, 'late'], [-2, 'absent'], [-1, 'on_leave']];
      for (const [offset, status] of statuses) {
        await h.submit(principal.cookie, section, { date: schoolDay(offset), marks: marks([kid], status) });
        await recompute(school, section.id, schoolDay(offset));
      }
      const read = async () =>
        (await h.get(`/students/${kid.studentId}/attendance?${studentRange(-5, 1)}`, principal.cookie)).body as StudentAttendance;
      const before = await read();
      expect(before).toMatchObject({
        percentage: 50, // (1 + 0.5 + 0) / 3, on_leave excused
        countedDays: 3,
        teachingDays: 7, // -5 .. +1: no weekly-off day, enrolled throughout (a future day is unrecorded)
        unrecorded: 3,
        excludedLeaveDays: 1,
        present: 1,
        late: 1,
        absent: 1,
      });
      expect(before.days).toHaveLength(7);
      expect(before.days.find((d) => d.date === schoolDay(-3))).toMatchObject({ status: 'late', value: 0.5, teachingDay: true, enrolled: true });
      expect(before.days.find((d) => d.date === schoolDay(-1))).toMatchObject({ status: 'on_leave', value: null });
      expect(before.days.find((d) => d.date === schoolDay(-5))).toMatchObject({ status: null, value: null, periods: [] });

      // A holiday published over the absent day: no stored change, the day leaves both sides.
      const created = await h.post('/holidays', { startsOn: schoolDay(-2), name: 'Flood', kind: 'school' }, principal.cookie);
      const id = (created.body as { id: string }).id;
      await h.post(`/holidays/${id}/publish`, {}, principal.cookie);
      const during = await read();
      expect(during).toMatchObject({ percentage: 75, countedDays: 2 });
      expect(during.days.find((d) => d.date === schoolDay(-2))).toMatchObject({ teachingDay: false, status: 'absent', value: null });
      await h.post(`/holidays/${id}/cancel`, { reason: 'Recorded by mistake' }, principal.cookie);
      expect((await read()).percentage).toBe(50);
    });

    it('R128: no recorded day is a null percentage ("no recorded days")', async () => {
      const school = await h.school();
      const principal = await h.caller(school, 'principal');
      const kid = await h.child(school, await h.section(school));
      const res = await h.get(`/students/${kid.studentId}/attendance?${studentRange(-3, 0)}`, principal.cookie);
      expect(res.body).toMatchObject({ percentage: null, countedDays: 0, teachingDays: 4, unrecorded: 4 });
    });

    it('§10.4: dateTo before dateFrom or more than 365 days after it is 422 on dateTo', async () => {
      const school = await h.school();
      const principal = await h.caller(school, 'principal');
      const kid = await h.child(school, await h.section(school));
      for (const q of [`dateFrom=${schoolDay()}&dateTo=${schoolDay(-1)}`, `dateFrom=${schoolDay(-366)}&dateTo=${schoolDay()}`]) {
        const res = await h.get(`/students/${kid.studentId}/attendance?${q}`, principal.cookie);
        expect(fieldsOf(res)).toEqual([expect.objectContaining({ path: 'dateTo' })]);
      }
    });
  });

  describe('R130 R164 R165 who reads what', () => {
    async function family() {
      const school = await h.school();
      const principal = await h.caller(school, 'principal');
      const teacher = await h.caller(school, 'teacher');
      const mine = await h.section(school);
      const other = await h.section(school);
      await createTeacherAssignment(db, school, teacher, { role: 'class_teacher', section: mine, startsOn: schoolDay(-30) });
      const child = await h.child(school, mine, { canLogin: true });
      const sibling = await h.child(school, other);
      await h.submit(principal.cookie, mine, {
        date: schoolDay(-1),
        marks: [{ enrolmentId: child.enrolmentId.toString(), status: 'late', arrivedAt: '08:40', note: 'Doctor visit for Ayesha' }],
      });
      await recompute(school, mine.id, schoolDay(-1));
      return { school, principal, teacher, mine, other, child, sibling };
    }

    it('R130: a teacher reads the attendance of students in their scope only (404 otherwise)', async () => {
      const { teacher, child, sibling } = await family();
      expect((await h.get(`/students/${child.studentId}/attendance?${studentRange(-2, 0)}`, teacher.cookie)).status).toBe(200);
      expect((await h.get(`/students/${sibling.studentId}/attendance?${studentRange(-2, 0)}`, teacher.cookie)).status).toBe(404);
    });

    it('R130, R163, R165: a guardian reads only linked can_login children, the same DTO with no note or teacher; an ended link is gone on the next request; a non-active child stays readable while linked (R164)', async () => {
      const { school, child, sibling } = await family();
      const parent = await guardianLogin(db, school, { id: child.guardianId, cnic: null });
      const res = await h.get(`/me/children/${child.studentId}/attendance?${studentRange(-2, 0)}`, parent.cookie);
      expect(res.status).toBe(200);
      const body = res.body as StudentAttendance;
      expect(Object.keys(body).sort()).toEqual(STUDENT_ATTENDANCE_KEYS);
      for (const day of body.days) {
        expect(Object.keys(day).sort()).toEqual(DAY_KEYS);
        for (const period of day.periods) expect(Object.keys(period as object).sort()).toEqual(PERIOD_KEYS);
      }
      expect(res.text).not.toMatch(/Doctor visit|note|Teacher|submittedBy|alert/i);
      expect(body.days.find((d) => d.date === schoolDay(-1))?.periods).toEqual([{ period: 1, status: 'late', arrivedAt: '08:40' }]);

      expect((await h.get(`/me/children/${sibling.studentId}/attendance?${studentRange(-2, 0)}`, parent.cookie)).status).toBe(404);
      await db.student.updateMany({ where: { schoolId: school.id, id: child.studentId }, data: { status: 'suspended' } });
      expect((await h.get(`/me/children/${child.studentId}/attendance?${studentRange(-2, 0)}`, parent.cookie)).status).toBe(200);
      await db.studentGuardian.updateMany({ where: { schoolId: school.id, studentId: child.studentId }, data: { endedAt: new Date() } });
      const gone = await h.get(`/me/children/${child.studentId}/attendance?${studentRange(-2, 0)}`, parent.cookie);
      expect(gone.status).toBe(404);
      expect(errorOf(gone).code).toBe('NOT_FOUND');
    });

    it('R130: a guardian link without can_login gives no read', async () => {
      const { school, sibling } = await family();
      const parent = await guardianLogin(db, school, { id: sibling.guardianId, cnic: null });
      expect((await h.get(`/me/children/${sibling.studentId}/attendance?${studentRange(-2, 0)}`, parent.cookie)).status).toBe(404);
    });

    it('R130: a student reads only themself; staff routes are 403 for them', async () => {
      const { school, child } = await family();
      const me = await studentLogin(db, school, { id: child.studentId, bForm: null });
      const res = await h.get(`/me/student/attendance?${studentRange(-2, 0)}`, me.cookie);
      expect(res.status).toBe(200);
      expect((res.body as StudentAttendance).studentId).toBe(child.studentId.toString());
      expect(Object.keys(res.body as object).sort()).toEqual(STUDENT_ATTENDANCE_KEYS);
      expect((await h.get(`/students/${child.studentId}/attendance?${studentRange(-2, 0)}`, me.cookie)).status).toBe(403);
      expect((await h.get(`/me/children/${child.studentId}/attendance?${studentRange(-2, 0)}`, me.cookie)).status).toBe(403);
    });

    it('R130: attendance.student.view_all reads every report; a teacher without it is 403 on the school-wide reports', async () => {
      const { school, principal, teacher } = await family();
      for (const path of ['absentees', 'late', 'percentage']) {
        const q = path === 'percentage' ? studentRange(-2, 0) : `date=${schoolDay(-1)}`;
        expect((await h.get(`/attendance-reports/${path}?${q}`, principal.cookie)).status).toBe(200);
        expect((await h.get(`/attendance-reports/${path}?${q}`, teacher.cookie)).status).toBe(403);
      }
      const viewer = await h.caller(school, 'teacher');
      await db.userCapabilityGrant.create({
        data: { schoolId: school.id, userId: viewer.userId, capabilityKey: Capability.ATTENDANCE_STUDENT_VIEW_ALL, effect: 'grant', grantedBy: principal.userId, reason: 'Inspector' },
      });
      expect((await h.get(`/attendance-reports/late?date=${schoolDay(-1)}`, viewer.cookie)).status).toBe(200);
    });
  });

  describe('§10.2 §10.3 reports', () => {
    it('§10.3: /absentees lists absent, partial and on_leave (filterable); /late lists late with the first arrival and the alert state', async () => {
      const school = await h.school({ periodsPerDay: 3 });
      const principal = await h.caller(school, 'principal');
      const daily = await h.section(school, { className: 'A' });
      const kids = [await h.child(school, daily, { fullName: 'Absent Kid' }), await h.child(school, daily, { fullName: 'Leave Kid' }), await h.child(school, daily, { fullName: 'Late Kid' })];
      await h.submit(principal.cookie, daily, {
        date: schoolDay(-1),
        marks: [
          { enrolmentId: kids[0]?.enrolmentId.toString(), status: 'absent' },
          { enrolmentId: kids[1]?.enrolmentId.toString(), status: 'on_leave' },
          { enrolmentId: kids[2]?.enrolmentId.toString(), status: 'late', arrivedAt: '08:20' },
        ],
      });
      const period = await h.section(school, { className: 'B', mode: 'period' });
      const partial = await h.child(school, period, { fullName: 'Partial Kid' });
      await h.submit(principal.cookie, period, { date: schoolDay(-1), period: 1, marks: marks([partial], 'present') });
      await h.submit(principal.cookie, period, { date: schoolDay(-1), period: 2, marks: marks([partial], 'absent') });
      await recompute(school, daily.id, schoolDay(-1));
      await recompute(school, period.id, schoolDay(-1));

      const absentees = (await h.get(`/attendance-reports/absentees?date=${schoolDay(-1)}`, principal.cookie)).body as { data: { fullName: string; status: string; alert: unknown }[]; total: number };
      expect(absentees.data.map((r) => [r.fullName, r.status])).toEqual([
        ['Absent Kid', 'absent'],
        ['Leave Kid', 'on_leave'],
        ['Partial Kid', 'partial'],
      ]);
      expect(absentees.data[0]?.alert).toMatchObject({ absence: 'cancelled', absenceCancelReason: 'backdated' });
      const onlyPartial = (await h.get(`/attendance-reports/absentees?date=${schoolDay(-1)}&status=partial`, principal.cookie)).body as { total: number };
      expect(onlyPartial.total).toBe(1);
      const late = (await h.get(`/attendance-reports/late?date=${schoolDay(-1)}`, principal.cookie)).body as { data: { fullName: string; arrivedAt: string | null }[] };
      expect(late.data).toEqual([expect.objectContaining({ fullName: 'Late Kid', arrivedAt: '08:20' })]);
      expect((await h.get(`/attendance-reports/late?date=${schoolDay(-1)}&status=late`, principal.cookie)).status).toBe(422);
    });

    it('§10.2, R131: daily summaries in a range ≤ 92 days, with stale, unrecorded and teachingDay', async () => {
      const school = await h.school();
      const principal = await h.caller(school, 'principal');
      const section = await h.section(school);
      const kids = [await h.child(school, section), await h.child(school, section)];
      await h.submit(principal.cookie, section, { date: schoolDay(-1), marks: marks(kids, ['present', 'absent']) });
      const q = `dateFrom=${schoolDay(-2)}&dateTo=${schoolDay()}`;
      const stale = (await h.get(`/attendance-reports/daily-summary?${q}`, principal.cookie)).body as { data: object[] };
      expect(stale.data).toEqual([expect.objectContaining({ stale: true, computedAt: null, registersExpected: 0 })]);
      await recompute(school, section.id, schoolDay(-1));
      const fresh = (await h.get(`/attendance-reports/daily-summary?${q}`, principal.cookie)).body as { data: object[] };
      expect(fresh.data).toEqual([
        expect.objectContaining({ date: schoolDay(-1), stale: false, present: 1, absent: 1, unrecorded: 0, rosterCount: 2, teachingDay: true, registersExpected: 1 }),
      ]);
      const tooLong = await h.get(`/attendance-reports/daily-summary?dateFrom=${schoolDay(-92)}&dateTo=${schoolDay()}`, principal.cookie);
      expect(fieldsOf(tooLong)).toEqual([expect.objectContaining({ path: 'dateTo' })]);
    });
  });

  describe('R128 the percentage report: SQL against the shared function', () => {
    it('R128: on seeded data (periods, partial days, late arrivals, leave, a holiday, a weekly-off day, a mid-range section change) the SQL agrees with the shared function for every student under every setting', async () => {
      const offDay = new Date(`${schoolDay(-6)}T00:00:00Z`).getUTCDay();
      const school = await h.school({ weeklyOffDays: [offDay], periodsPerDay: 3, lateCutoffTime: '08:30' });
      const principal = await h.caller(school, 'principal');
      const daily = await h.section(school, { className: 'P Daily' });
      const period = await h.section(school, { className: 'P Period', mode: 'period' });
      const kids: { child: Child; section: TestSection }[] = [];
      for (let i = 0; i < 4; i++) kids.push({ child: await h.child(school, daily), section: daily });
      for (let i = 0; i < 4; i++) kids.push({ child: await h.child(school, period), section: period });
      // A child who moved from the daily to the period section 3 days ago (enrolments do not overlap).
      const mover = await h.child(school, daily, { endedOn: schoolDay(-4) });
      const moved = await db.enrolment.create({
        data: { schoolId: school.id, studentId: mover.studentId, academicYearId: period.academicYearId, classId: period.classId, sectionId: period.id, startedOn: D(schoolDay(-3)), status: 'active' },
      });
      await db.holiday.create({
        data: { schoolId: school.id, startsOn: D(schoolDay(-8)), endsOn: D(schoolDay(-8)), name: 'Holiday', kind: 'public', status: 'published', publishedAt: new Date(), publishedBy: principal.userId },
      });
      const pick = (): AttendanceStatus => (['present', 'present', 'absent', 'late', 'on_leave'] as const)[randomInt(0, 5)] ?? 'present';
      const arrived = () => `0${randomInt(7, 10)}:${randomInt(10, 60)}`.slice(-5);
      const mark = (child: Child | { enrolmentId: bigint }, status: AttendanceStatus) =>
        ({ enrolmentId: child.enrolmentId.toString(), status, ...(status === 'late' ? { arrivedAt: arrived() } : {}) });

      for (let offset = -12; offset <= -1; offset++) {
        const date = schoolDay(offset);
        if (offset === -6 || offset === -8) continue; // the weekly-off day and the holiday
        const dailyKids = [...kids.filter((k) => k.section === daily).map((k) => k.child), ...(offset <= -4 ? [mover] : [])];
        if (offset !== -10) await h.submit(principal.cookie, daily, { date, marks: dailyKids.map((c) => mark(c, pick())) });
        const periodKids: (Child | { enrolmentId: bigint })[] = [...kids.filter((k) => k.section === period).map((k) => k.child), ...(offset >= -3 ? [{ enrolmentId: moved.id }] : [])];
        for (let p = 1; p <= randomInt(1, 4); p++) {
          await h.submit(principal.cookie, period, { date, period: p, marks: periodKids.map((c) => mark(c, pick())) });
        }
        await recompute(school, daily.id, date);
        await recompute(school, period.id, date);
      }
      // Recorded on the weekly-off day before it became one would still be excluded: none here.

      const settings = [
        { lateCountsAs: 'present', leaveCountsAs: 'excused' },
        { lateCountsAs: 'half_day', leaveCountsAs: 'absent' },
        { lateCountsAs: 'absent_after_cutoff', leaveCountsAs: 'excused' },
        { lateCountsAs: 'absent_after_cutoff', leaveCountsAs: 'absent' },
      ] as const;
      const q = studentRange(-14, 0);
      for (const s of settings) {
        await db.schoolSettings.updateMany({ where: { schoolId: school.id }, data: s });
        const report = (await h.get(`/attendance-reports/percentage?${q}&limit=50`, principal.cookie)).body as { data: PercentageRow[]; total: number };
        expect(report.total).toBe(9);
        for (const row of report.data) {
          const own = (await h.get(`/students/${row.studentId}/attendance?${q}`, principal.cookie)).body as StudentAttendance;
          expect({ settings: s, studentId: row.studentId, percentage: row.percentage, countedDays: row.countedDays, teachingDays: row.teachingDays }).toEqual({
            settings: s,
            studentId: row.studentId,
            percentage: own.percentage,
            countedDays: own.countedDays,
            teachingDays: own.teachingDays,
          });
        }
      }
      expect(
        ((await h.get(`/attendance-reports/percentage?${q}&sectionId=${period.id}`, principal.cookie)).body as { total: number }).total,
      ).toBe(5);
      const below = (await h.get(`/attendance-reports/percentage?${q}&below=100&sort=-percentage`, principal.cookie)).body as { data: PercentageRow[] };
      const values = below.data.map((r) => r.percentage ?? -1);
      expect(values).toEqual([...values].sort((a, b) => b - a));
    });
  });
});
