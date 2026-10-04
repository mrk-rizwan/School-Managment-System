// Slice 11 worker side (contracts/slice-11.md §8): the summary version bump, the section-day
// rollup and its no-lost-update rule, the sweeps' attendance sources, the nightly net, and the
// register deadline job. Rules: R129, R131.
import { Capability } from '@asms/shared';
import { JobRunner } from '../../src/jobs/job-runner';
import {
  AttendanceRollup,
  AttendanceSweeps,
  RegisterDeadlineSweep,
} from '../../src/modules/attendance/attendance-jobs';
import { AttendanceSummaryRepository } from '../../src/repositories/attendance-summary.repository';
import { closeTestDb, type TestSchool } from '../support/schools';
import { createTeacherAssignment, type TestSection } from '../support/students';
import { asSchool, principal as principalWithEmail } from '../messaging/support';
import { at, AttendanceHarness, D, marks, schoolDay } from './harness';

const T = schoolDay();

describe('slice 11 rollup, sweeps and the deadline job (e2e)', () => {
  const h = new AttendanceHarness();
  const db = h.db;
  let rollup: AttendanceRollup;
  let sweeps: AttendanceSweeps;
  let deadline: RegisterDeadlineSweep;
  let summaries: AttendanceSummaryRepository;

  beforeAll(async () => {
    await h.start();
    rollup = h.app.get(AttendanceRollup, { strict: false });
    sweeps = h.app.get(AttendanceSweeps, { strict: false });
    deadline = h.app.get(RegisterDeadlineSweep, { strict: false });
    summaries = h.app.get(AttendanceSummaryRepository, { strict: false });
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });
  beforeEach(() => h.reset());
  afterEach(() => h.restoreClock());

  const summaryOf = (school: TestSchool, section: TestSection, date = T) =>
    db.attendanceDailySummary.findFirst({ where: { schoolId: school.id, sectionId: section.id, date: D(date) } });
  const recompute = (school: TestSchool, section: TestSection, date = T) =>
    asSchool(h.app, school.id, () => rollup.recompute(school.id, section.id, D(date)));

  describe('R131 trigger and rollup', () => {
    it('R131: every mark write bumps its section-day version (the trigger); the rollup recomputes day status and counts and sets computed_version', async () => {
      const school = await h.school();
      const office = await h.caller(school, 'office_staff');
      const section = await h.section(school);
      const kids = [await h.child(school, section), await h.child(school, section), await h.child(school, section)];
      await h.submit(office.cookie, section, { date: T, marks: marks(kids, ['present', 'absent', 'on_leave']) });
      expect(await summaryOf(school, section)).toMatchObject({ version: 1n, computedVersion: 0n, registersExpected: 0 });
      expect(h.rollupJobs).toEqual([expect.objectContaining({ sectionId: section.id, date: T, version: 1n })]);

      expect(await recompute(school, section)).toBe(true);
      expect(await summaryOf(school, section)).toMatchObject({
        version: 1n,
        computedVersion: 1n,
        rosterCount: 3,
        registersRecorded: 1,
        registersExpected: 1,
        present: 1,
        absent: 1,
        onLeave: 1,
        late: 0,
        partial: 0,
      });
      const days = await db.attendanceDayStatus.findMany({ where: { schoolId: school.id }, orderBy: { enrolmentId: 'asc' } });
      expect(days.map((d) => d.status)).toEqual(['present', 'absent', 'on_leave']);

      await h.submit(office.cookie, section, { date: T, reason: 'Late bus', marks: [{ enrolmentId: kids[1]?.enrolmentId.toString(), status: 'late', arrivedAt: '08:45' }] });
      expect((await summaryOf(school, section))?.version).toBe(2n);
      await recompute(school, section);
      expect(await summaryOf(school, section)).toMatchObject({ computedVersion: 2n, late: 1, absent: 0 });
      const late = await db.attendanceDayStatus.findFirst({ where: { schoolId: school.id, enrolmentId: kids[1]?.enrolmentId ?? 0n } });
      expect(late?.firstLateArrivedAt?.toISOString().slice(11, 16)).toBe('08:45');
    });

    it('R131: a write landing during a recompute leaves the row stale (the conditional update matches nothing) and the next job catches it', async () => {
      const school = await h.school();
      const office = await h.caller(school, 'office_staff');
      const section = await h.section(school);
      const kids = [await h.child(school, section)];
      await h.submit(office.cookie, section, { date: T, marks: marks(kids, 'present') });
      await h.submit(office.cookie, section, { date: T, reason: 'Gone home', marks: marks(kids, 'absent') });
      // A recompute that read version 1 completes after version 2 landed: no lost update.
      const stale = await asSchool(h.app, school.id, () =>
        summaries.complete(school.id, section.id, D(T), 1n, { rosterCount: 1, registersRecorded: 1, registersExpected: 1, present: 1, absent: 0, late: 0, onLeave: 0, partial: 0 }, new Date()),
      );
      expect(stale).toBe(false);
      expect(await summaryOf(school, section)).toMatchObject({ version: 2n, computedVersion: 0n });
      await recompute(school, section);
      expect(await summaryOf(school, section)).toMatchObject({ version: 2n, computedVersion: 2n, absent: 1, present: 0 });
    });

    it('R131, plan §4.5: registers_expected is frozen at first computation (period mode: periodsPerDay then)', async () => {
      const school = await h.school({ periodsPerDay: 6 });
      const office = await h.caller(school, 'office_staff');
      const section = await h.section(school, { mode: 'period' });
      const kids = [await h.child(school, section)];
      await h.submit(office.cookie, section, { date: T, period: 1, marks: marks(kids) });
      await recompute(school, section);
      expect((await summaryOf(school, section))?.registersExpected).toBe(6);
      await db.schoolSettings.updateMany({ where: { schoolId: school.id }, data: { periodsPerDay: 8 } });
      await h.submit(office.cookie, section, { date: T, period: 2, marks: marks(kids, 'absent') });
      await recompute(school, section);
      expect(await summaryOf(school, section)).toMatchObject({ registersExpected: 6, registersRecorded: 2, partial: 1 });
    });

    it('§8.5: the rollup job resolves its date by pattern; a bad date or a foreign section is dropped or touches nothing', async () => {
      const school = await h.school();
      const office = await h.caller(school, 'office_staff');
      const section = await h.section(school);
      await h.submit(office.cookie, section, { date: T, marks: marks([await h.child(school, section)]) });
      const runner = h.app.get(JobRunner, { strict: false });
      expect(await runner.attendance('attendance-rollup', { schoolId: school.id.toString(), sectionId: section.id.toString(), date: '2026-02-30' })).toBe('dropped');
      expect(await runner.attendance('attendance-rollup', { schoolId: school.id.toString(), sectionId: section.id.toString() })).toBe('dropped');
      const other = await h.school();
      expect(await runner.attendance('attendance-rollup', { schoolId: other.id.toString(), sectionId: section.id.toString(), date: T })).toBe('done');
      expect((await summaryOf(school, section))?.computedVersion).toBe(0n);
      expect(await runner.attendance('attendance-rollup', { schoolId: school.id.toString(), sectionId: section.id.toString(), date: T })).toBe('done');
      expect((await summaryOf(school, section))?.computedVersion).toBe(1n);
    });
  });

  describe('§8.3 sweeps and the nightly net', () => {
    it('§8.3: the outbox sweep re-enqueues pending alerts due over 2 minutes ago (sweep minute) and stale summaries at their current version', async () => {
      const school = await h.school();
      const office = await h.caller(school, 'office_staff');
      const section = await h.section(school);
      const kid = await h.child(school, section);
      h.clockAt(at(T, '08:00'));
      await h.submit(office.cookie, section, { date: T, marks: marks([kid], 'absent') });
      h.reset();
      const [alert] = await db.attendanceAlert.findMany({ where: { schoolId: school.id } });
      expect(await asSchool(h.app, school.id, () => sweeps.outboxSweep(school.id, at(T, '09:31')))).toEqual({ alerts: 0, rollups: 1 });
      expect(h.rollupJobs).toEqual([expect.objectContaining({ sectionId: section.id, date: T, version: 1n })]);
      h.reset();
      expect(await asSchool(h.app, school.id, () => sweeps.outboxSweep(school.id, at(T, '09:33')))).toEqual({ alerts: 1, rollups: 1 });
      const minute = Math.floor(at(T, '09:33').getTime() / 60_000);
      expect(h.alertJobs).toEqual([expect.objectContaining({ id: alert?.id, sweepMinute: minute })]);
    });

    it('§8.3: the nightly job recomputes stale section-days and every one of the last 7 days, not older', async () => {
      const school = await h.school();
      const office = await h.caller(school, 'office_staff');
      const principal = await h.caller(school, 'principal');
      const recent = await h.section(school);
      const kid = await h.child(school, recent);
      await h.submit(principal.cookie, recent, { date: schoolDay(-2), marks: marks([kid]) });
      await h.submit(principal.cookie, recent, { date: schoolDay(-9), marks: marks([kid]) });
      await recompute(school, recent, schoolDay(-2));
      await recompute(school, recent, schoolDay(-9));
      // Make both look stale-free but wrong, and an old one stale.
      await db.attendanceDailySummary.updateMany({ where: { schoolId: school.id }, data: { present: 0 } });
      await h.submit(office.cookie, recent, { date: T, marks: marks([kid], 'absent') });
      const done = await asSchool(h.app, school.id, () => sweeps.nightly(school.id, at(schoolDay(1), '00:30')));
      expect(done).toBe(2);
      expect((await summaryOf(school, recent, schoolDay(-2)))?.present).toBe(1);
      expect((await summaryOf(school, recent, schoolDay(-9)))?.present).toBe(0);
      expect(await summaryOf(school, recent, T)).toMatchObject({ computedVersion: 1n, absent: 1 });
    });
  });

  describe('R129 the register deadline job', () => {
    async function deadlineSchool() {
      const school = await h.school({ registerDeadlineTime: '10:00' });
      const principal = await principalWithEmail(db, school, { email: true });
      const office = await h.caller(school, 'office_staff', 'Omar Office');
      const revoked = await h.caller(school, 'office_staff', 'Revoked Clerk');
      await db.userCapabilityGrant.create({
        data: { schoolId: school.id, userId: revoked.userId, capabilityKey: Capability.ATTENDANCE_STUDENT_MARK, effect: 'revoke', grantedBy: principal.userId, reason: 'Front desk only' },
      });
      const grantee = await h.caller(school, 'teacher', 'Granted Teacher');
      await db.userCapabilityGrant.create({
        data: { schoolId: school.id, userId: grantee.userId, capabilityKey: Capability.ATTENDANCE_STUDENT_MARK, effect: 'grant', grantedBy: principal.userId, reason: 'Exams officer' },
      });
      const teacher = await h.caller(school, 'teacher', 'Plain Teacher');
      const a = await h.section(school, { className: 'Class 5', sectionName: 'A' });
      const b = await h.section(school, { className: 'Class 6', sectionName: 'B' });
      await createTeacherAssignment(db, school, teacher, { role: 'class_teacher', section: a, startsOn: schoolDay(-30) });
      const cover = await h.caller(school, 'teacher', 'Cara Cover');
      await createTeacherAssignment(db, school, cover, { role: 'cover', section: a, startsOn: T, endsOn: T });
      const kids = [await h.child(school, a), await h.child(school, b)];
      await h.section(school, { className: 'Class 7' }); // empty: never listed
      return { school, principal, office, revoked, grantee, teacher, a, b, kids };
    }

    it('R129: before the deadline nothing; after it one register_unrecorded to the principal, office and grantees (not the revoked clerk, not teachers), naming the sections and the cover; once per day', async () => {
      const ctx = await deadlineSchool();
      const run = (time: string) => asSchool(h.app, ctx.school.id, () => deadline.run(ctx.school.id, at(T, time)));
      expect(await run('09:59')).toBe('before_deadline');
      expect(await run('10:00')).toBe('sent');
      const messages = await db.message.findMany({ where: { schoolId: ctx.school.id, type: 'register_unrecorded' }, orderBy: { staffId: 'asc' } });
      const staffIds = messages.map((m) => m.staffId).sort();
      expect(staffIds).toEqual([ctx.principal.staffId, ctx.office.staffId, ctx.grantee.staffId].sort());
      expect(messages[0]).toMatchObject({ subjectType: 'register_deadline', subjectId: BigInt(T.replaceAll('-', '')) });
      expect(messages[0]?.body).toMatch(/^Iqra Model School: 2 registers not recorded by 10:00 on .*: Class 5 A \(cover: Cara Cover\), Class 6 B$/);
      expect(await run('10:05')).toBe('already_sent');
      expect(await db.message.count({ where: { schoolId: ctx.school.id, type: 'register_unrecorded' } })).toBe(3);
    });

    it('R129: a teaching day with every register recorded sends nothing; a non-teaching day is skipped', async () => {
      const ctx = await deadlineSchool();
      for (const [section, kid] of [[ctx.a, ctx.kids[0]], [ctx.b, ctx.kids[1]]] as const) {
        await h.submit(ctx.office.cookie, section, { date: T, marks: marks(kid ? [kid] : []) });
      }
      expect(await asSchool(h.app, ctx.school.id, () => deadline.run(ctx.school.id, at(T, '11:00')))).toBe('all_recorded');
      const weekday = new Date(`${T}T00:00:00Z`).getUTCDay();
      await db.schoolSettings.updateMany({ where: { schoolId: ctx.school.id }, data: { weeklyOffDays: [weekday] } });
      expect(await asSchool(h.app, ctx.school.id, () => deadline.run(ctx.school.id, at(T, '11:00')))).toBe('not_teaching_day');
    });

    it('R129: the watchers are confirmed through the effective permissions', async () => {
      const ctx = await deadlineSchool();
      const watchers = await asSchool(h.app, ctx.school.id, () => deadline.watchers(ctx.school.id));
      expect(watchers.sort()).toEqual([ctx.principal.staffId, ctx.office.staffId, ctx.grantee.staffId].sort());
    });
  });
});
