// CLAUDE.md control 4 for the slice-11 raw-SQL repositories (RAW_SQL_FILES in eslint.config.mjs):
// every method, called as school B with school A's ids, reads nothing and changes nothing of
// school A; a write naming another school's parent row is refused by the composite foreign key.
// Control 7 for their student-linked reads: inside school A, a scope that does not reach the
// student returns nothing.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Capability, ErrorCode } from '@asms/shared';
import { mapDatabaseError } from '../../src/common/errors/prisma-errors';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { UserRepository } from '../../src/repositories/user.repository';
import { AttendanceAlertRepository } from '../../src/repositories/attendance-alert.repository';
import { AttendanceMarkRepository } from '../../src/repositories/attendance-mark.repository';
import { AttendanceRegisterRepository } from '../../src/repositories/attendance-register.repository';
import { AttendanceReportRepository } from '../../src/repositories/attendance-report.repository';
import { AttendanceSummaryRepository } from '../../src/repositories/attendance-summary.repository';
import type { Scope } from '../../src/tenancy/scope';
import { createTestApp } from '../core/app';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';
import {
  createClassWithSection,
  createGuardian,
  createSection,
  createStudent,
  createTeacherAssignment,
  enrol,
  linkGuardian,
  type TestSection,
} from '../support/students';
import { withChangeContext } from './support';
import { D, schoolDay } from './harness';

const T = schoolDay(-1);

describe('slice 11 attendance repositories: tenant isolation', () => {
  const db = testDb();
  let app: NestExpressApplication;
  let schools: TwoSchools;
  let section: TestSection;
  let studentId: bigint;
  let enrolmentId: bigint;
  let registerId: bigint;
  let markId: bigint;
  let alertId: bigint;
  let allOfB: Scope;
  let registers: AttendanceRegisterRepository;
  let marks: AttendanceMarkRepository;
  let alerts: AttendanceAlertRepository;
  let summaries: AttendanceSummaryRepository;
  let reports: AttendanceReportRepository;
  let permissions: PermissionsService;

  beforeAll(async () => {
    app = await createTestApp();
    registers = app.get(AttendanceRegisterRepository, { strict: false });
    marks = app.get(AttendanceMarkRepository, { strict: false });
    alerts = app.get(AttendanceAlertRepository, { strict: false });
    summaries = app.get(AttendanceSummaryRepository, { strict: false });
    reports = app.get(AttendanceReportRepository, { strict: false });

    schools = await createTwoSchools();
    const { a, b } = schools;
    const principal = await createSchoolUser(db, a, { systemRole: 'principal' });
    ({ section } = await createClassWithSection(db, a));
    const student = await createStudent(db, a, { admittedOn: schoolDay(-30) });
    studentId = student.id;
    enrolmentId = (await enrol(db, a, student, section, { startedOn: schoolDay(-30) })).id;
    const g = await createGuardian(db, a);
    await linkGuardian(db, a, student, g);
    await registers.insertIfAbsent(a.id, {
      sectionId: section.id,
      classId: section.classId,
      academicYearId: section.academicYearId,
      date: D(T),
      period: 1,
      mode: 'daily',
      submittedBy: principal.userId,
      submittedAt: new Date(),
      source: 'web',
    });
    const register = await registers.findView(a.id, section.id, D(T), 1);
    registerId = register?.id ?? 0n;
    await marks.upsertForRegister(a.id, { id: registerId, date: D(T), period: 1 }, [
      { enrolmentId, status: 'late', note: null, arrivedAt: '08:40' },
    ]);
    markId = (await marks.listForRegister(a.id, registerId))[0]?.id ?? 0n;
    await marks.insertArrival(a.id, markId, '08:40', principal.userId, new Date());
    await withChangeContext(db, principal.userId, 'Correction', (tx) =>
      tx.$executeRaw`UPDATE attendance_marks SET status = 'absent', arrived_at = NULL WHERE school_id = ${a.id} AND id = ${markId}`,
    );
    alertId = (
      await alerts.insert(
        a.id,
        { enrolmentId, studentId, date: D(T), kind: 'absence', seq: 1, dueAt: new Date(Date.now() - 600_000), status: 'pending', cancelReason: null },
        new Date(),
      )
    ).id;

    const bPrincipal = await createSchoolUser(db, b, { systemRole: 'principal' });
    permissions = app.get(PermissionsService, { strict: false });
    const access = await permissions.load(b.id, bPrincipal.userId);
    const scope = access && (await permissions.can(b.id, access, Capability.ATTENDANCE_STUDENT_VIEW_ALL));
    if (!scope) throw new Error('no scope for school B');
    allOfB = scope;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('attendance_registers: every read as school B finds nothing of school A; an insert naming A’s section is refused', async () => {
    const { a, b } = schools;
    expect(await registers.findSection(a.id, section.id)).not.toBeNull();
    expect(await registers.findSection(b.id, section.id)).toBeNull();
    expect(await registers.roster(b.id, section.id, D(T), registerId)).toEqual([]);
    expect(await registers.rosterCount(b.id, section.id, D(T))).toBe(0);
    expect(await registers.findView(b.id, section.id, D(T), 1)).toBeNull();
    expect(await registers.lock(b.id, registerId)).toBeNull();
    expect(await registers.lockByNaturalKey(b.id, section.id, D(T), 1)).toBeNull();
    expect(await registers.countForSectionDay(b.id, section.id, D(T))).toBe(0);
    expect(await registers.enrolmentsInForce(b.id, allOfB, studentId, D(T))).toEqual([]);
    expect(await registers.enrolmentsOverlapping(b.id, allOfB, studentId, D(schoolDay(-60)), D(T))).toEqual([]);
    expect((await registers.sectionDays(b.id, allOfB, { date: D(T), sort: 'className', skip: 0, take: 50 })).rows).toEqual([]);
    expect(await registers.rosteredForDeadline(b.id, D(T))).toEqual([]);
    expect(await registers.periodsRecorded(b.id, [section.id], D(T))).toEqual(new Map());
    const users = app.get(UserRepository, { strict: false });
    expect((await users.watcherCandidates(b.id, Capability.ATTENDANCE_STUDENT_MARK)).map((w) => w.userId)).not.toContain(
      (await registers.findView(a.id, section.id, D(T), 1))?.submittedBy,
    );
    await expect(
      registers.insertIfAbsent(b.id, {
        sectionId: section.id,
        classId: section.classId,
        academicYearId: section.academicYearId,
        date: D(T),
        period: 1,
        mode: 'daily',
        submittedBy: 1n,
        submittedAt: new Date(),
        source: 'web',
      }),
    ).rejects.toThrow();
  });

  it('attendance_marks: reads as school B find nothing; an update as B changes nothing; an upsert naming A’s register is refused', async () => {
    const { a, b } = schools;
    expect(await marks.listForRegister(b.id, registerId)).toEqual([]);
    expect(await marks.findById(b.id, markId)).toBeNull();
    expect(await marks.lock(b.id, markId)).toBeNull();
    expect((await marks.childDays(b.id, [studentId], D(T))).size).toBe(0);
    expect(await marks.periodsForStudent(b.id, allOfB, studentId, D(T), D(T))).toEqual([]);
    expect(await marks.lastRecordedOn(b.id, enrolmentId)).toBeNull();
    await marks.update(b.id, markId, { status: 'present', note: null, arrivedAt: null });
    expect((await marks.findById(a.id, markId))?.status).toBe('absent');
    await expect(
      marks.upsertForRegister(b.id, { id: registerId, date: D(T), period: 1 }, [
        { enrolmentId, status: 'present', note: null, arrivedAt: null },
      ]),
    ).rejects.toThrow();
  });

  it('attendance_mark_changes: school B reads none of A’s history', async () => {
    const { a, b } = schools;
    expect((await marks.changes(a.id, markId, '-changedAt', 0, 10)).total).toBe(1);
    expect(await marks.changes(b.id, markId, '-changedAt', 0, 10)).toEqual({ rows: [], total: 0 });
  });

  it('attendance_arrivals: school B finds none of A’s arrivals', async () => {
    const { a, b } = schools;
    expect(await marks.hasArrival(a.id, markId, '08:40')).toBe(true);
    expect(await marks.hasArrival(b.id, markId, '08:40')).toBe(false);
  });

  it('attendance_alerts: school B reads, locks, lists and cancels none of A’s alerts', async () => {
    const { a, b } = schools;
    expect(await alerts.lockChildDays(b.id, [studentId], D(T))).toEqual([]);
    expect(await alerts.findById(b.id, alertId)).toBeNull();
    expect(await alerts.listForChildDays(b.id, allOfB, [studentId], D(T))).toEqual([]);
    expect(await alerts.listDue(b.id, new Date(), 10)).toEqual([]);
    expect(await alerts.recipients(b.id, studentId)).toEqual([]);
    expect(await alerts.subject(b.id, enrolmentId)).toBeNull();
    expect(await alerts.cancelPendingForHoliday(b.id, D(T), D(T), new Date())).toBe(0);
    await alerts.resolve(b.id, alertId, { status: 'sent' }, new Date());
    expect((await alerts.findById(a.id, alertId))?.status).toBe('pending');
    expect(await alerts.listDue(a.id, new Date(), 10)).toEqual([alertId]);
  });

  it('attendance_daily_summary: school B sees no version, no stale row and completes nothing of A', async () => {
    const { a, b } = schools;
    expect(await summaries.version(a.id, section.id, D(T))).not.toBeNull();
    expect(await summaries.version(b.id, section.id, D(T))).toBeNull();
    expect(await summaries.listStale(b.id, 10)).toEqual([]);
    expect(await summaries.listSince(b.id, D(schoolDay(-30)), 10)).toEqual([]);
    const counts = { rosterCount: 9, registersRecorded: 9, registersExpected: 9, present: 9, absent: 0, late: 0, onLeave: 0, partial: 0 };
    expect(await summaries.complete(b.id, section.id, D(T), 1n, counts, new Date())).toBe(false);
    expect((await reports.dailySummaries(b.id, allOfB, { from: D(T), to: D(T), sort: '-date', skip: 0, take: 50 })).rows).toEqual([]);
  });

  it('attendance_day_status: school B reads none of A’s days and cannot write one against A’s enrolment', async () => {
    const { a, b } = schools;
    expect(await summaries.marksOfSectionDay(b.id, section.id, D(T))).toEqual([]);
    await summaries.upsertDayStatus(a.id, section.id, D(T), [
      { enrolmentId, studentId, status: 'absent', recorded: 1, present: 0, late: 0, absent: 1, leave: 0, firstLateArrivedAt: null },
    ], new Date());
    expect(await reports.studentDays(a.id, allOfB, studentId, D(T), D(T))).toHaveLength(1);
    expect(await reports.studentDays(b.id, allOfB, studentId, D(T), D(T))).toEqual([]);
    expect((await reports.dayList(b.id, { date: D(T), statuses: ['absent'], sort: 'className', skip: 0, take: 50 })).rows).toEqual([]);
    const percentage = await reports.percentage(b.id, {
      from: D(T),
      to: D(T),
      weeklyOffDays: [],
      settings: { lateCountsAs: 'present', lateCutoffTime: null, leaveCountsAs: 'excused' },
      sort: 'percentage',
      skip: 0,
      take: 50,
    });
    expect(percentage.rows).toEqual([]);
    await expect(
      summaries.upsertDayStatus(b.id, section.id, D(T), [
        { enrolmentId, studentId, status: 'absent', recorded: 1, present: 0, late: 0, absent: 1, leave: 0, firstLateArrivedAt: null },
      ], new Date()),
    ).rejects.toThrow();
  });

  it('control 7: the student-linked reads return nothing for a scope that does not reach the student', async () => {
    const { a } = schools;
    // A teacher of the student's section, a teacher of another section of the class, and a
    // student capacity scope naming another child.
    const scopeOf = async (user: { userId: bigint }): Promise<Scope> => {
      const access = await permissions.load(a.id, user.userId);
      const scope = access && (await permissions.can(a.id, access, Capability.ATTENDANCE_STUDENT_MARK));
      if (!scope) throw new Error('no mark scope');
      return scope;
    };
    const own = await createSchoolUser(db, a, { systemRole: 'teacher' });
    await createTeacherAssignment(db, a, own, { role: 'class_teacher', section, startsOn: schoolDay(-60) });
    const other = await createSchoolUser(db, a, { systemRole: 'teacher' });
    const otherSection = await createSection(db, a, { id: section.classId, academicYearId: section.academicYearId });
    await createTeacherAssignment(db, a, other, { role: 'class_teacher', section: otherSection, startsOn: schoolDay(-60) });
    const inScope = await scopeOf(own);
    const outOfScope = await scopeOf(other);
    const ownAccess = await permissions.load(a.id, own.userId);
    if (!ownAccess) throw new Error('no access');
    const anotherChild = await permissions.capacityScope(a.id, { ...ownAccess, studentId: studentId + 1_000_000n }, 'student');
    const thisChild = await permissions.capacityScope(a.id, { ...ownAccess, studentId }, 'student');

    const from = D(schoolDay(-60));
    expect(await registers.enrolmentsInForce(a.id, inScope, studentId, D(T))).toHaveLength(1);
    expect(await registers.enrolmentsOverlapping(a.id, inScope, studentId, from, D(T))).toHaveLength(1);
    expect(await marks.periodsForStudent(a.id, inScope, studentId, D(T), D(T))).toHaveLength(1);
    expect(await alerts.listForChildDays(a.id, inScope, [studentId], D(T))).toHaveLength(1);
    expect(await reports.studentDays(a.id, inScope, studentId, D(T), D(T))).toHaveLength(1);
    expect(await reports.studentDays(a.id, thisChild, studentId, D(T), D(T))).toHaveLength(1);
    expect(await marks.periodsForStudent(a.id, thisChild, studentId, D(T), D(T))).toHaveLength(1);
    for (const scope of [outOfScope, anotherChild]) {
      expect(await registers.enrolmentsInForce(a.id, scope, studentId, D(T))).toEqual([]);
      expect(await registers.enrolmentsOverlapping(a.id, scope, studentId, from, D(T))).toEqual([]);
      expect(await marks.periodsForStudent(a.id, scope, studentId, D(T), D(T))).toEqual([]);
      expect(await alerts.listForChildDays(a.id, scope, [studentId], D(T))).toEqual([]);
      expect(await reports.studentDays(a.id, scope, studentId, D(T), D(T))).toEqual([]);
    }
  });

  it('attendance_marks: the natural key (rule 14) refuses a second mark of an enrolment-day-period, mapped to 409 CONCURRENT_UPDATE', async () => {
    const { a } = schools;
    const error: unknown = await db.attendanceMark
      .create({ data: { schoolId: a.id, registerId, enrolmentId, date: D(T), period: 1, status: 'present' } })
      .catch((e: unknown) => e);
    expect(mapDatabaseError(error)).toMatchObject({ status: 409, code: ErrorCode.CONCURRENT_UPDATE });
  });
});
