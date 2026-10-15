// Phase 5 slice 42 (contracts/slice-42.md §2.3-§2.5, §3; R334-R338): the student profile in the
// caller's scope (404 outside it, dues and documents only with their own keys), the staff report
// (attendance, leave taken, the contract's standing with "expired, not ended" and ending within 60
// days), the attendance discrepancies (both kinds, a recorded arrival clearing a mixed day), and
// the result reports' CSV — each export the rows shown, audited, costing five.
import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { withChangeContext } from '../attendance/support';
import { captureOutbox } from '../diary/support';
import { StaffHarness } from '../staff/support';
import { closeTestDb } from '../support/schools';
import { day, isoDay } from '../support/students';
import { api, markMidTerm, openSheet, resultRoom, sheetVerb, type ResultRoom } from '../results/support';
import { csvGet, expectCsvHeaders, parseCsv } from './support';

interface Profile {
  studentId: string;
  fullName: string;
  current: { className: string; sectionName: string } | null;
  attendance: { dateFrom: string; dateTo: string; percentage: number | null; present: number; absent: number } | null;
  latestResult: { resultId: string; termName: string | null; percentBp: number | null; position: number | null; classPosition: number | null } | null;
  dues: { outstanding: number; advance: number; cleared: boolean } | null;
  documents: { complete: boolean; items: { type: string; status: string }[] } | null;
  transport: unknown;
}

interface StaffRow {
  staffId: string;
  fullName: string;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  attendancePercent: number | null;
  leaveTakenDays: number;
  contractStatus: string;
  contractType: string | null;
  contractEndsOn: string | null;
  contractEndingSoon: boolean;
}

interface Discrepancy {
  kind: string;
  date: string;
  studentName: string | null;
  sectionName: string;
  period: number | null;
  presentPeriods: number[];
  absentPeriods: number[];
  amendments: number | null;
}

describe('R334-R338: the student profile, the staff report, attendance discrepancies, result report CSV (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  const HELD = isoDay(-5);

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

  /** 6-A's Mid-term marked, submitted and approved (published). */
  async function publishSixA(r: ResultRoom): Promise<string> {
    await markMidTerm(h, r, HELD);
    const { body: sheet } = await openSheet(h, r.classTeacher, r.sixA.id, r.midTermId);
    expect((await sheetVerb(h, sheet.id, 'submit', r.classTeacher)).status).toBe(200);
    expect((await sheetVerb(h, sheet.id, 'approve', r.principal)).status).toBe(200);
    return sheet.id;
  }

  it('R334, R338: the profile composes the scoped reads; 404 outside the scope; dues and documents only with their keys; a GET writes nothing', async () => {
    const r = await resultRoom(h);
    await publishSixA(r);
    const before = await db.auditLog.count({ where: { schoolId: r.school.id } });
    const read = async (who: { cookie: string }, studentId: bigint) => {
      const res = await h.get(api(`/students/${studentId}/profile`), who.cookie);
      return { status: res.status, body: res.body as Profile, text: res.text };
    };
    const principal = await read(r.principal, r.child1.id);
    expect(principal.status).toBe(200);
    const live = await db.result.findFirstOrThrow({
      where: { schoolId: r.school.id, enrolmentId: r.enrolment1, termId: r.midTermId, supersededAt: null },
    });
    expect(principal.body).toMatchObject({
      studentId: String(r.child1.id),
      fullName: 'Zara Khan',
      current: { className: 'Six', sectionName: 'A' },
      latestResult: { resultId: String(live.id), termName: 'Mid-term', percentBp: live.percentBp, position: live.position, classPosition: null },
      dues: { outstanding: 0, advance: 0, cleared: true },
      transport: null,
    });
    expect(principal.body.attendance?.dateTo).toBe(isoDay(0));
    expect(principal.body.documents?.items.map((i) => i.status)).toEqual(principal.body.documents?.items.map(() => 'missing'));
    // No identity number on the page.
    expect(principal.text).not.toMatch(/[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/);

    // The class teacher of 6-A: their own pupil, but no dues (finance keys are never a teacher's);
    // the documents section follows document.view.
    const teacher = await read(r.classTeacher, r.child1.id);
    expect(teacher.status).toBe(200);
    expect(teacher.body.dues).toBeNull();
    const teacherHoldsDocuments = SYSTEM_ROLE_DEFAULTS.teacher.includes(Capability.DOCUMENT_VIEW);
    expect(teacher.body.documents === null).toBe(!teacherHoldsDocuments);
    // R338: a pupil of 6-B is outside the class teacher's scope (404); another school's is 404.
    expect((await read(r.classTeacher, r.childB.id)).status).toBe(404);
    const other = await resultRoom(h);
    expect((await read(r.principal, other.child1.id)).status).toBe(404);
    expect((await h.get(api(`/students/${r.child1.id}/profile?format=csv`), r.principal.cookie)).status).toBe(422);
    expect(await db.auditLog.count({ where: { schoolId: r.school.id } })).toBe(before);
  });

  it('R337, R336: the staff report — attendance, leave taken, the contract standing — and its CSV', async () => {
    const r = await resultRoom(h);
    const schoolId = r.school.id;
    const by = r.principal.userId;
    // Bilal (Maths): three present, one late, one absent, one on leave; two days of approved leave.
    const marks: [number, 'present' | 'late' | 'absent' | 'on_leave'][] = [
      [-6, 'present'],
      [-5, 'present'],
      [-4, 'present'],
      [-3, 'late'],
      [-2, 'absent'],
      [-1, 'on_leave'],
    ];
    for (const [offset, status] of marks) {
      await db.staffAttendance.create({ data: { schoolId, staffId: r.mathsTeacher.staffId, date: day(isoDay(offset)), status, markedBy: by } });
    }
    const casual = await db.leaveType.create({ data: { schoolId, name: 'Casual', code: 'casual', daysPerYear: 10, paid: true } });
    await db.leaveRequest.create({
      data: {
        schoolId,
        staffId: r.mathsTeacher.staffId,
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
    // Contracts: Bilal's ends in 30 days (ending soon); Erum's ended its term 3 days ago and was
    // never ended (the warning); Ayesha is permanent; Hina's was ended; the office has none.
    const contract = (staffId: bigint, type: 'permanent' | 'fixed_term' | 'probation', endsOn: string | null, ended = false) =>
      db.staffContract.create({
        data: {
          schoolId,
          staffId,
          type,
          startsOn: day(isoDay(-200)),
          endsOn: endsOn === null ? null : day(endsOn),
          createdBy: by,
          ...(ended ? { endedAt: new Date(), endedBy: by, endReason: 'Moved city', endedOn: day(isoDay(-10)) } : {}),
        },
      });
    await contract(r.mathsTeacher.staffId, 'fixed_term', isoDay(30));
    await contract(r.englishTeacher.staffId, 'probation', isoDay(-3));
    await contract(r.classTeacher.staffId, 'permanent', null);
    await contract(r.bTeacher.staffId, 'fixed_term', isoDay(100), true);

    const from = isoDay(-30);
    const path = `/staff-reports/summary?from=${from}&to=${isoDay(0)}`;
    const res = await h.get(api(`${path}&limit=50`), r.office.cookie);
    expect(res.status).toBe(200);
    const body = res.body as { from: string; to: string; data: StaffRow[]; total: number };
    const row = (name: string) => body.data.find((x) => x.fullName === name);
    expect(row('Bilal Maths')).toMatchObject({
      present: 3,
      late: 1,
      absent: 1,
      onLeave: 1,
      attendancePercent: 80,
      leaveTakenDays: 2,
      contractStatus: 'live',
      contractType: 'fixed_term',
      contractEndsOn: isoDay(30),
      contractEndingSoon: true,
    });
    expect(row('Erum English')).toMatchObject({ contractStatus: 'expired_not_ended', contractEndingSoon: false, attendancePercent: null });
    expect(row('Ayesha Class')).toMatchObject({ contractStatus: 'live', contractEndsOn: null, contractEndingSoon: false });
    expect(row('Hina Bsection')).toMatchObject({ contractStatus: 'ended' });
    expect(row('Omar Office')).toMatchObject({ contractStatus: 'none', contractType: null });
    expect(body.data.map((x) => x.fullName)).toEqual([...body.data.map((x) => x.fullName)].sort((a, b) => a.localeCompare(b)));
    // The name filter, and the window outside Bilal's marks.
    const filtered = (await h.get(api(`${path}&staffName=bilal`), r.office.cookie)).body as { data: StaffRow[]; total: number };
    expect([filtered.total, filtered.data.map((x) => x.fullName)]).toEqual([1, ['Bilal Maths']]);
    const earlier = (await h.get(api(`/staff-reports/summary?from=${isoDay(-90)}&to=${isoDay(-60)}&staffName=bilal`), r.office.cookie)).body as {
      data: StaffRow[];
    };
    expect(earlier.data[0]).toMatchObject({ present: 0, attendancePercent: null, leaveTakenDays: 0 });

    // CSV: the rows shown, the standing as words; audited as a staff_report export.
    const csv = await csvGet(h.app, `${path}&format=csv`, r.office.cookie);
    expectCsvHeaders(csv, 'staff-summary');
    const [header, ...records] = parseCsv(csv.text);
    expect(header?.[0]).toBe('Staff');
    expect(records.map((x) => x[0])).toEqual(body.data.map((x) => x.fullName));
    expect(records.find((x) => x[0] === 'Erum English')?.[9]).toBe('Expired, not ended');
    const exported = await db.auditLog.findFirstOrThrow({ where: { schoolId, action: 'staff_report.exported' } });
    expect(exported.metadata).toMatchObject({ report: 'staff-summary', rowCount: body.total, filters: { from, to: isoDay(0) } });

    // R338: staff.view; a window over a year is 422.
    expect((await h.get(api(path), r.classTeacher.cookie)).status).toBe(SYSTEM_ROLE_DEFAULTS.teacher.includes(Capability.STAFF_VIEW) ? 200 : 403);
    expect((await h.get(api(`/staff-reports/summary?from=2025-01-01&to=2026-06-01`), r.office.cookie)).status).toBe(422);
  });

  it('R335, R336: discrepancies — a mixed day without an arrival, a register amended more than once — newest first, and the CSV', async () => {
    const r = await resultRoom(h);
    const schoolId = r.school.id;
    const by = r.principal.userId;
    const register = async (section: { id: bigint; classId: bigint; academicYearId: bigint }, date: string, period: number) =>
      db.attendanceRegister.create({
        data: {
          schoolId,
          sectionId: section.id,
          classId: section.classId,
          academicYearId: section.academicYearId,
          date: day(date),
          period,
          mode: 'period',
          submittedBy: by,
          source: 'web',
        },
      });
    const mark = (reg: { id: bigint; date: Date; period: number }, enrolmentId: bigint, status: 'present' | 'absent' | 'late') =>
      db.attendanceMark.create({ data: { schoolId, registerId: reg.id, enrolmentId, date: reg.date, period: reg.period, status } });

    // Two days ago: Sara (6-B) present in period 1, absent in 2 — listed. Zara (6-A) late in 1,
    // absent in 2, but her arrival was recorded — not listed. Ali present in both — not listed.
    const d2 = isoDay(-2);
    const b1 = await register(r.sixB, d2, 1);
    const b2 = await register(r.sixB, d2, 2);
    await mark(b1, r.enrolmentB, 'present');
    await mark(b2, r.enrolmentB, 'absent');
    const a1 = await register(r.sixA, d2, 1);
    const a2 = await register(r.sixA, d2, 2);
    const zaraLate = await mark(a1, r.enrolment1, 'late');
    await mark(a2, r.enrolment1, 'absent');
    await mark(a1, r.enrolment2, 'present');
    await mark(a2, r.enrolment2, 'present');
    await db.attendanceArrival.create({ data: { schoolId, markId: zaraLate.id, arrivedAt: new Date('1970-01-01T09:40:00Z'), recordedBy: by } });
    // Three days ago: 6-A period 3 amended twice (listed); period 4 once (not listed).
    const d3 = isoDay(-3);
    const a3 = await register(r.sixA, d3, 3);
    const twice = await mark(a3, r.enrolment1, 'absent');
    const a4 = await register(r.sixA, d3, 4);
    const once = await mark(a4, r.enrolment1, 'absent');
    for (const [id, status] of [
      [twice.id, 'present'],
      [twice.id, 'late'],
      [once.id, 'present'],
    ] as const) {
      await withChangeContext(db, by, 'Register corrected', (t) => t.attendanceMark.updateMany({ where: { schoolId, id }, data: { status } }));
    }
    // An amendment is an event, not a change row: period 5 corrected once for two students (two
    // change rows, one amendment, not listed); period 6 corrected twice for two students (four
    // change rows, two amendments, listed with 2).
    const a5 = await register(r.sixA, d3, 5);
    const a6 = await register(r.sixA, d3, 6);
    const pair5 = [(await mark(a5, r.enrolment1, 'absent')).id, (await mark(a5, r.enrolment2, 'absent')).id];
    const pair6 = [(await mark(a6, r.enrolment1, 'absent')).id, (await mark(a6, r.enrolment2, 'absent')).id];
    const correctBoth = (ids: bigint[], status: 'present' | 'late') =>
      withChangeContext(db, by, 'Register corrected', (t) => t.attendanceMark.updateMany({ where: { schoolId, id: { in: ids } }, data: { status } }));
    await correctBoth(pair5, 'present');
    await correctBoth(pair6, 'present');
    await correctBoth(pair6, 'late');
    expect(await db.attendanceMarkChange.count({ where: { schoolId, markId: { in: [...pair5, ...pair6] } } })).toBe(6);

    const path = `/attendance-reports/discrepancies?from=${isoDay(-10)}&to=${isoDay(0)}`;
    const res = await h.get(api(path), r.principal.cookie);
    expect(res.status).toBe(200);
    const page = res.body as { data: Discrepancy[]; total: number };
    expect(page.total).toBe(3);
    expect(page.data).toEqual([
      expect.objectContaining({ kind: 'mixed_day', date: d2, studentName: 'Sara Malik', sectionName: 'B', period: null, presentPeriods: [1], absentPeriods: [2], amendments: null }),
      expect.objectContaining({ kind: 'amended_register', date: d3, studentName: null, sectionName: 'A', period: 3, presentPeriods: [], absentPeriods: [], amendments: 2 }),
      expect.objectContaining({ kind: 'amended_register', date: d3, studentName: null, sectionName: 'A', period: 6, presentPeriods: [], absentPeriods: [], amendments: 2 }),
    ]);
    const onlyAmended = (await h.get(api(`${path}&kind=amended_register`), r.principal.cookie)).body as { total: number };
    expect(onlyAmended.total).toBe(2);
    // Paging past the end still reports the total.
    expect(((await h.get(api(`${path}&page=4&limit=1`), r.principal.cookie)).body as { data: unknown[]; total: number })).toMatchObject({ data: [], total: 3 });

    const csv = await csvGet(h.app, `${path}&format=csv`, r.principal.cookie);
    expectCsvHeaders(csv, 'attendance-discrepancies');
    const records = parseCsv(csv.text);
    expect(records).toEqual([
      ['Date', 'Discrepancy', 'Class', 'Section', 'Student', 'Period', 'Present periods', 'Absent periods', 'Amendments'],
      [d2, 'Present and absent on one day', 'Six', 'B', 'Sara Malik', '', '1', '2', ''],
      [d3, 'Register amended more than once', 'Six', 'A', '', '3', '', '', '2'],
      [d3, 'Register amended more than once', 'Six', 'A', '', '6', '', '', '2'],
    ]);
    expect((await db.auditLog.findFirstOrThrow({ where: { schoolId, action: 'attendance_report.exported' } })).metadata).toMatchObject({
      report: 'attendance-discrepancies',
      rowCount: 3,
    });

    // R338 and the window: attendance.student.view_all; at most 92 days.
    expect((await h.get(api(path), r.classTeacher.cookie)).status).toBe(403);
    expect((await h.get(api(`/attendance-reports/discrepancies?from=${isoDay(-100)}&to=${isoDay(0)}`), r.principal.cookie)).status).toBe(422);
  });

  it('R336: the section summary and subject report CSV hold the tables shown', async () => {
    const r = await resultRoom(h);
    const sheetId = await publishSixA(r);
    const summaryPath = `/result-reports/section-summary?sheetId=${sheetId}`;
    const summary = (await h.get(api(summaryPath), r.principal.cookie)).body as { subjects: { subjectName: string; assessed: number }[] };
    const summaryCsv = await csvGet(h.app, `${summaryPath}&format=csv`, r.principal.cookie);
    expectCsvHeaders(summaryCsv, 'section-summary');
    const [sHeader, ...sRows] = parseCsv(summaryCsv.text);
    expect(sHeader).toEqual(['Subject', 'Assessed', 'Passed', 'Failed', 'Average percent', 'Grades']);
    expect(sRows.map((x) => [x[0], x[1]])).toEqual(summary.subjects.map((s) => [s.subjectName, String(s.assessed)]));

    const subjectPath = `/result-reports/subject?termId=${r.midTermId}&classSubjectId=${r.maths.classSubjectId}`;
    const subject = (await h.get(api(subjectPath), r.principal.cookie)).body as { sections: { sectionName: string }[] };
    const subjectCsv = await csvGet(h.app, `${subjectPath}&format=csv`, r.principal.cookie);
    expectCsvHeaders(subjectCsv, 'subject-report');
    expect(parseCsv(subjectCsv.text).slice(1).map((x) => x[0])).toEqual(subject.sections.map((s) => s.sectionName));
    const exports = await db.auditLog.findMany({ where: { schoolId: r.school.id, action: 'result_report.exported' }, orderBy: { id: 'asc' } });
    expect(exports.map((e) => (e.metadata as { report: string }).report)).toEqual(['section-summary', 'subject-report']);
  });
});
