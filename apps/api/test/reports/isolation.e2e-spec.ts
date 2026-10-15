// Control 4 / R62 for slice 42's raw and grouped report reads (contracts/slice-42.md §2.1, §2.4,
// §2.5): FinanceReportRepository.statementLines, AttendanceReportRepository.discrepancies and
// every StaffReportRepository read. School A's figures are taken, School B is then seeded with the
// same kinds of rows inside the same window, and School A's figures must not move; run as School
// A with School B's ids, the id-taking reads return nothing.
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { AttendanceReportRepository } from '../../src/repositories/attendance-report.repository';
import { FinanceReportRepository, type CollectionWindow } from '../../src/repositories/finance-report.repository';
import { StaffReportRepository } from '../../src/repositories/staff-report.repository';
import { withChangeContext } from '../attendance/support';
import { captureOutbox } from '../diary/support';
import { asSchool, tx } from '../messaging/support';
import { resultRoom, type ResultRoom } from '../results/support';
import { StaffHarness } from '../staff/support';
import { closeTestDb } from '../support/schools';
import { day, isoDay } from '../support/students';

describe('slice 42 tenant isolation (statement lines, discrepancies, staff report)', () => {
  const h = new StaffHarness();
  const db = h.db;

  beforeAll(async () => {
    await h.start();
  });
  beforeEach(() => {
    captureOutbox(h);
    jest.spyOn(h.app.get(OutboxDispatcher, { strict: false }), 'resultNotifyAfterCommit').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const run = <T>(r: ResultRoom, fn: () => Promise<T>) => asSchool(h.app, r.school.id, () => tx.run(fn));

  /** Money of every kind the statement reads that a row can carry without a ledger: expenses and an advance. */
  async function seedMoney(r: ResultRoom, amount: number): Promise<void> {
    const schoolId = r.school.id;
    const by = r.principal.userId;
    let no = (await db.expense.count({ where: { schoolId } })) + 1;
    for (const [category, spentOn] of [
      ['water', isoDay(-2)],
      ['stationery', isoDay(-1)],
    ] as const) {
      await db.expense.create({
        data: {
          schoolId,
          expenseNo: no,
          category,
          amount,
          spentOn: day(spentOn),
          description: 'Isolation probe',
          method: 'cash',
          status: 'recorded',
          recordedBy: by,
        },
      });
      no += 1;
    }
    await db.salaryAdvance.create({
      data: {
        schoolId,
        staffId: r.mathsTeacher.staffId,
        amount,
        grantedOn: day(isoDay(-1)),
        recoverFrom: isoDay(31).slice(0, 7),
        instalmentAmount: amount,
        approvedBy: by,
        paidMethod: 'cash',
      },
    });
  }

  /** A mixed day (present in 1, absent in 2, no arrival) and a register amended twice. */
  async function seedAttendance(r: ResultRoom): Promise<void> {
    const schoolId = r.school.id;
    const by = r.principal.userId;
    const register = (date: string, period: number) =>
      db.attendanceRegister.create({
        data: {
          schoolId,
          sectionId: r.sixA.id,
          classId: r.sixA.classId,
          academicYearId: r.sixA.academicYearId,
          date: day(date),
          period,
          mode: 'period',
          submittedBy: by,
          source: 'web',
        },
      });
    const mark = (reg: { id: bigint; date: Date; period: number }, status: 'present' | 'absent') =>
      db.attendanceMark.create({ data: { schoolId, registerId: reg.id, enrolmentId: r.enrolment1, date: reg.date, period: reg.period, status } });
    await mark(await register(isoDay(-2), 1), 'present');
    await mark(await register(isoDay(-2), 2), 'absent');
    const amended = await mark(await register(isoDay(-3), 3), 'absent');
    for (const status of ['present', 'absent'] as const) {
      await withChangeContext(db, by, 'Register corrected', (t) =>
        t.attendanceMark.updateMany({ where: { schoolId, id: amended.id }, data: { status } }),
      );
    }
  }

  /** Staff attendance, approved leave and a contract for the maths teacher. */
  async function seedStaff(r: ResultRoom): Promise<void> {
    const schoolId = r.school.id;
    const by = r.principal.userId;
    const staffId = r.mathsTeacher.staffId;
    for (const [offset, status] of [
      [-3, 'present'],
      [-2, 'absent'],
      [-1, 'late'],
    ] as const) {
      await db.staffAttendance.create({ data: { schoolId, staffId, date: day(isoDay(offset)), status, markedBy: by } });
    }
    const casual = await db.leaveType.create({ data: { schoolId, name: 'Casual', code: 'casual', daysPerYear: 10, paid: true } });
    await db.leaveRequest.create({
      data: {
        schoolId,
        staffId,
        leaveTypeId: casual.id,
        startsOn: day(isoDay(-1)),
        endsOn: day(isoDay(0)),
        workingDays: 2,
        reason: 'Family wedding',
        status: 'approved',
        requestedBy: r.mathsTeacher.userId,
        decidedBy: by,
        decidedAt: new Date(),
      },
    });
    await db.staffContract.create({
      data: { schoolId, staffId, type: 'fixed_term', startsOn: day(isoDay(-200)), endsOn: day(isoDay(30)), createdBy: by },
    });
  }

  it('statementLines: School B money in the window leaves School A lines unchanged, on both bases', async () => {
    const statements = app().get(FinanceReportRepository, { strict: false });
    const a = await resultRoom(h);
    const b = await resultRoom(h);
    await seedMoney(a, 300);
    const window = (basis: 'received' | 'verified'): CollectionWindow => ({
      basis,
      from: day(isoDay(-30)),
      to: day(isoDay(0)),
      startsAt: new Date(Date.now() - 30 * 86_400_000),
      endsBefore: new Date(Date.now() + 86_400_000),
      timezone: 'Asia/Karachi',
    });
    const linesOf = (r: ResultRoom, basis: 'received' | 'verified') =>
      run(r, () => statements.statementLines(r.school.id, window(basis)));
    const sum = (lines: { kind: string; amount: number }[], kind: string) =>
      lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amount, 0);

    const before = { received: await linesOf(a, 'received'), verified: await linesOf(a, 'verified') };
    expect(sum(before.received, 'expense')).toBe(600);
    expect(sum(before.received, 'advance_paid')).toBe(300);

    await seedMoney(b, 7000);
    for (const basis of ['received', 'verified'] as const) {
      const after = await linesOf(a, basis);
      expect(after).toEqual(before[basis]);
      // School B sees its own money only.
      const own = await linesOf(b, basis);
      expect([sum(own, 'expense'), sum(own, 'advance_paid')]).toEqual([14000, 7000]);
    }
  });

  it('discrepancies: School B registers in the window leave School A rows and total unchanged', async () => {
    const reports = app().get(AttendanceReportRepository, { strict: false });
    const a = await resultRoom(h);
    const b = await resultRoom(h);
    await seedAttendance(a);
    const query = { from: day(isoDay(-10)), to: day(isoDay(0)), skip: 0, take: 50 };
    const of = (r: ResultRoom, kind?: 'mixed_day' | 'amended_register') =>
      run(r, () => reports.discrepancies(r.school.id, kind === undefined ? query : { ...query, kind }));

    const before = await of(a);
    expect(before.total).toBe(2);
    expect(before.rows.map((x) => x.kind).sort()).toEqual(['amended_register', 'mixed_day']);

    await seedAttendance(b);
    expect(await of(a)).toEqual(before);
    for (const kind of ['mixed_day', 'amended_register'] as const) {
      expect((await of(a, kind)).total).toBe(1);
    }
    // School B's own rows name only School B's sections.
    const own = await of(b);
    expect(own.total).toBe(2);
    expect(new Set(own.rows.map((x) => x.sectionId))).toEqual(new Set([b.sixA.id]));
  });

  it('staff report: School B staff attendance, leave and contracts leave School A figures unchanged; B ids read as A return nothing', async () => {
    const staff = app().get(StaffReportRepository, { strict: false });
    const a = await resultRoom(h);
    const b = await resultRoom(h);
    await seedStaff(a);
    const from = day(isoDay(-30));
    const to = day(isoDay(0));
    const figures = (r: ResultRoom, ids: bigint[]) =>
      run(r, async () => ({
        members: await staff.members(r.school.id, { from }, { skip: 0, take: 50 }),
        attendance: await staff.attendance(r.school.id, ids, from, to),
        leave: await staff.leaveTaken(r.school.id, ids, from, to),
        contracts: await staff.latestContracts(r.school.id, ids),
      }));
    const aIds = (await db.staff.findMany({ where: { schoolId: a.school.id }, select: { id: true } })).map((s) => s.id);
    const bIds = (await db.staff.findMany({ where: { schoolId: b.school.id }, select: { id: true } })).map((s) => s.id);

    const before = await figures(a, aIds);
    expect(before.attendance.get(a.mathsTeacher.staffId)).toEqual({ present: 1, absent: 1, late: 1, onLeave: 0 });
    expect(before.leave.get(a.mathsTeacher.staffId)).toBe(2);
    expect(before.contracts.get(a.mathsTeacher.staffId)?.type).toBe('fixed_term');

    await seedStaff(b);
    const after = await figures(a, aIds);
    expect(after).toEqual(before);
    expect(after.members.rows.every((m) => aIds.includes(m.id))).toBe(true);
    // School A, asked about School B's staff, reads nothing.
    const crossed = await figures(a, bIds);
    expect([crossed.attendance.size, crossed.leave.size, crossed.contracts.size]).toEqual([0, 0, 0]);
    expect((await figures(b, bIds)).attendance.get(b.mathsTeacher.staffId)).toEqual({ present: 1, absent: 1, late: 1, onLeave: 0 });
  });

  const app = () => h.app;
});
