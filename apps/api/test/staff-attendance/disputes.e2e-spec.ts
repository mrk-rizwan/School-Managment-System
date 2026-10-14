// Staff attendance disputes end to end (Phase 5 slice 44, contracts/slice-44.md §2.5-§2.7; R346,
// R347): raise from one's own login with a reason and a key, withdraw, approve (amending the mark
// through the Phase 2 path with the current status as fromStatus; a no-op approval), reject with a
// reason, the decider never the staff member, the messages, Approvals, the day views and isolation.
import request from 'supertest';
import { Capability, ErrorCode, newIdempotencyKey, weekdayOf } from '@asms/shared';
import { errorOf, ORIGIN, schoolDay, StaffHarness, type Caller } from '../staff/support';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';

const api = (path: string) => `/api/v1${path}`;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Recent past days that are not Sundays (the default weekly off). */
const WORKDAYS = Array.from({ length: 30 }, (_, i) => schoolDay(-(i + 1))).filter((d) => weekdayOf(d) !== 0);
const workday = (n: number): string => {
  const d = WORKDAYS[n];
  if (!d) throw new Error('no such workday');
  return d;
};

interface Dispute {
  id: string;
  attendanceId: string;
  staffId: string;
  staffName: string;
  date: string;
  markStatus: string;
  markSource: string;
  requestedStatus: string;
  reason: string;
  status: string;
  decidedByName: string | null;
  decisionReason: string | null;
  withdrawnAt: string | null;
}

describe('staff attendance disputes (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;

  interface Fixture {
    school: TestSchool;
    principal: Caller;
    office: Caller;
    teacher: Caller;
  }

  async function fresh(): Promise<Fixture> {
    const school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    const principal = await h.caller(school, 'principal', 'Nadia Principal');
    const office = await h.caller(school, 'office_staff', 'Omar Office');
    await db.userCapabilityGrant.create({
      data: {
        schoolId: school.id,
        userId: office.userId,
        capabilityKey: Capability.ATTENDANCE_STAFF_MANAGE,
        effect: 'grant',
        grantedBy: principal.userId,
        reason: 'Records staff attendance',
      },
    });
    const teacher = await h.caller(school, 'teacher', 'Tariq Teacher');
    return { school, principal, office, teacher };
  }

  /** A manual mark by `by` on `date`. */
  const mark = (f: Fixture, staffId: bigint, date: string, status: 'present' | 'absent' | 'late' | 'on_leave', by: Caller) =>
    db.staffAttendance.create({ data: { schoolId: f.school.id, staffId, date: day(date), status, markedBy: by.userId } });

  const raise = (caller: Caller, body: object, key = newIdempotencyKey()) =>
    request(h.app.getHttpServer())
      .post(api('/me/staff/attendance-disputes'))
      .set('Cookie', caller.cookie)
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', key)
      .send(body);
  const decide = (caller: Caller, id: string, verb: 'approve' | 'reject', body: object = {}) =>
    h.send('post', api(`/staff-attendance-disputes/${id}/${verb}`), body, caller.cookie);
  const withdraw = (caller: Caller, id: string) =>
    h.send('post', api(`/me/staff/attendance-disputes/${id}/withdraw`), {}, caller.cookie);
  const auditOf = (school: TestSchool, action: string) =>
    db.auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });
  const messagesOf = (school: TestSchool, type: 'attendance_disputed' | 'attendance_dispute_decided', subjectId: string) =>
    db.message.findMany({ where: { schoolId: school.id, type, subjectId: BigInt(subjectId) }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    await h.start();
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it('R346: raised from the staff member\'s own login with a reason and a key; replayed; one pending per mark', async () => {
    const f = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const key = newIdempotencyKey();
    const body = { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I taught periods one to four' };
    const res = await raise(f.teacher, body, key);
    expect(res.status).toBe(201);
    const dispute = res.body as Dispute;
    expect(dispute).toMatchObject({
      attendanceId: m.id.toString(),
      staffId: f.teacher.staffId.toString(),
      staffName: 'Tariq Teacher',
      date: workday(0),
      markStatus: 'absent',
      markSource: 'manual',
      requestedStatus: 'present',
      status: 'pending',
    });
    const replay = await raise(f.teacher, body, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.body as Dispute).id).toBe(dispute.id);
    const again = await raise(f.teacher, { ...body, reason: 'Second try at this' });
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: ErrorCode.ATTENDANCE_DISPUTE_PENDING_EXISTS, details: { disputeId: dispute.id } });
    // Without a reason, asking for what the mark already says, or another member's mark.
    expect((await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present' })).status).toBe(422);
    const other = await mark(f, f.teacher.staffId, workday(1), 'late', f.office);
    const same = await raise(f.teacher, { attendanceId: other.id.toString(), requestedStatus: 'late', reason: 'Same as the mark' });
    expect(same.status).toBe(422);
    const officeMark = await mark(f, f.office.staffId, workday(0), 'absent', f.principal);
    const notMine = await raise(f.teacher, { attendanceId: officeMark.id.toString(), requestedStatus: 'present', reason: 'Not my mark' });
    expect(notMine.status).toBe(422);
    expect(errorOf(notMine).code).toBe(ErrorCode.VALIDATION_FAILED);
    // Audited; attendance_disputed reached the two holders, never the disputer.
    const audit = await auditOf(f.school, 'attendance_dispute.raised');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: f.teacher.userId, subjectId: BigInt(dispute.id), reason: body.reason });
    const sent = await messagesOf(f.school, 'attendance_disputed', dispute.id);
    expect(sent.map((s) => s.staffId).sort()).toEqual([f.principal.staffId, f.office.staffId].sort());
    expect(sent[0]?.body).toContain('Tariq Teacher');
  });

  it('withdraw: own and pending only', async () => {
    const f = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I was here all day' })).body as Dispute;
    expect((await withdraw(f.office, dispute.id)).status).toBe(404);
    const done = await withdraw(f.teacher, dispute.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'withdrawn' });
    expect((done.body as Dispute).withdrawnAt).not.toBeNull();
    const twice = await withdraw(f.teacher, dispute.id);
    expect(twice.status).toBe(409);
    expect(errorOf(twice)).toMatchObject({ code: ErrorCode.ATTENDANCE_DISPUTE_NOT_PENDING, details: { status: 'withdrawn' } });
    expect((await decide(f.office, dispute.id, 'approve')).status).toBe(409);
    expect(await auditOf(f.school, 'attendance_dispute.withdrawn')).toHaveLength(1);
    // The mark is free for a new dispute.
    expect((await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'late', reason: 'I came at nine' })).status).toBe(201);
  });

  it('R346: approval amends through the Phase 2 path with the CURRENT status as fromStatus and the dispute as reason', async () => {
    const f = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I taught all morning' })).body as Dispute;
    // The office corrects the mark to late meanwhile; the approval still lands, from late.
    const amended = await h.send('post', api(`/staff-attendance/${m.id}/amend`), { fromStatus: 'absent', status: 'late', reason: 'Seen at the gate at nine' }, f.office.cookie);
    expect(amended.status).toBe(200);
    const res = await decide(f.principal, dispute.id, 'approve', { reason: 'The register agrees' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', markStatus: 'present', decidedByName: 'Nadia Principal', decisionReason: 'The register agrees' });
    const changes = await db.staffAttendanceChange.findMany({ where: { schoolId: f.school.id, staffAttendanceId: m.id }, orderBy: { id: 'asc' } });
    expect(changes.map((c) => [c.oldStatus, c.newStatus, c.changedBy, c.reason])).toEqual([
      ['absent', 'late', f.office.userId, 'Seen at the gate at nine'],
      ['late', 'present', f.principal.userId, 'I taught all morning'],
    ]);
    const markAudit = (await auditOf(f.school, 'staff_attendance_mark.amended')).at(-1);
    expect(markAudit?.metadata).toMatchObject({ from: 'late', to: 'present', disputeId: dispute.id });
    const approved = await auditOf(f.school, 'attendance_dispute.approved');
    expect(approved[0]).toMatchObject({ actorUserId: f.principal.userId, reason: 'The register agrees' });
    expect(approved[0]?.metadata).toMatchObject({ amended: true, from: 'late', to: 'present' });
    const told = await messagesOf(f.school, 'attendance_dispute_decided', dispute.id);
    expect(told.map((t) => t.staffId)).toEqual([f.teacher.staffId]);
    expect(told[0]?.body).toContain('approved');
  });

  it('R346: a no-op approval (the mark already says it) is approved and audited, with no amendment', async () => {
    const f = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I was teaching' })).body as Dispute;
    await h.send('post', api(`/staff-attendance/${m.id}/amend`), { fromStatus: 'absent', status: 'present', reason: 'Office corrected it' }, f.office.cookie);
    const res = await decide(f.principal, dispute.id, 'approve');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', markStatus: 'present', decisionReason: null });
    expect(await db.staffAttendanceChange.count({ where: { schoolId: f.school.id, staffAttendanceId: m.id } })).toBe(1);
    expect((await auditOf(f.school, 'attendance_dispute.approved'))[0]?.metadata).toMatchObject({ amended: false });
  });

  it('reject needs a reason; the decision is final and told to the staff member', async () => {
    const f = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I was teaching' })).body as Dispute;
    expect((await decide(f.office, dispute.id, 'reject', {})).status).toBe(422);
    const res = await decide(f.office, dispute.id, 'reject', { reason: 'The gate log shows no entry' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', markStatus: 'absent', decisionReason: 'The gate log shows no entry', decidedByName: 'Omar Office' });
    expect((await decide(f.principal, dispute.id, 'approve')).status).toBe(409);
    expect((await db.staffAttendance.findFirstOrThrow({ where: { schoolId: f.school.id, id: m.id } })).status).toBe('absent');
    expect(await auditOf(f.school, 'attendance_dispute.rejected')).toHaveLength(1);
    expect((await messagesOf(f.school, 'attendance_dispute_decided', dispute.id))[0]?.body).toContain('rejected');
  });

  it('R346: the decider is never the staff member, a principal included; a teacher reaches no decision route', async () => {
    const f = await fresh();
    const m = await mark(f, f.principal.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.principal, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I was in the office' })).body as Dispute;
    const own = await decide(f.principal, dispute.id, 'approve');
    expect(own.status).toBe(409);
    expect(errorOf(own)).toMatchObject({ code: ErrorCode.SELF_ACTION_FORBIDDEN, details: { reason: 'own_attendance' } });
    expect((await decide(f.principal, dispute.id, 'reject', { reason: 'Trying my own' })).status).toBe(409);
    expect((await decide(f.teacher, dispute.id, 'approve')).status).toBe(403);
    expect((await h.get(api('/staff-attendance-disputes'), f.teacher.cookie)).status).toBe(403);
    expect((await decide(f.office, dispute.id, 'approve')).status).toBe(200);
  });

  it('R347: the pending queue appears in Approvals for attendance.staff.manage holders only', async () => {
    const f = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I was teaching' })).body as Dispute;
    const office = await h.get(api('/me/approvals'), f.office.cookie);
    expect(office.body).toMatchObject({ disputes: { count: 1, items: [{ id: dispute.id, status: 'pending' }] } });
    expect((await h.get(api('/me/approvals'), f.teacher.cookie)).body).not.toHaveProperty('disputes');
    const queue = await h.get(api(`/staff-attendance-disputes?status=pending&staffId=${f.teacher.staffId}`), f.office.cookie);
    expect(queue.body).toMatchObject({ total: 1 });
    await decide(f.office, dispute.id, 'reject', { reason: 'No evidence of it' });
    expect((await h.get(api('/me/approvals'), f.office.cookie)).body).toMatchObject({ disputes: { count: 0, items: [] } });
  });

  it('the day views carry the mark id, its source and its dispute', async () => {
    const f = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I was teaching' })).body as Dispute;
    const mine = await h.get(api(`/me/staff/attendance?dateFrom=${workday(0)}&dateTo=${workday(0)}`), f.teacher.cookie);
    expect(mine.status).toBe(200);
    expect((mine.body as { days: unknown[] }).days).toEqual([
      expect.objectContaining({ markId: m.id.toString(), source: 'manual', disputeId: dispute.id, disputeStatus: 'pending', status: 'absent' }),
    ]);
    const sheet = await h.get(api(`/staff-attendance?date=${workday(0)}`), f.office.cookie);
    const row = (sheet.body as { data: { staffId: string; disputeId: string | null; disputeStatus: string | null; punch: unknown; punchConflict: boolean }[] }).data.find(
      (r) => r.staffId === f.teacher.staffId.toString(),
    );
    expect(row).toMatchObject({ disputeId: dispute.id, disputeStatus: 'pending', punch: null, punchConflict: false });
    const listed = await h.get(api('/me/staff/attendance-disputes'), f.teacher.cookie);
    expect(listed.body).toMatchObject({ total: 1, data: [{ id: dispute.id }] });
  });

  it('isolation: another school\'s manager reaches none of it', async () => {
    const f = await fresh();
    const other = await fresh();
    const m = await mark(f, f.teacher.staffId, workday(0), 'absent', f.office);
    const dispute = (await raise(f.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'I was teaching' })).body as Dispute;
    expect((await decide(other.office, dispute.id, 'approve')).status).toBe(404);
    expect((await decide(other.office, dispute.id, 'reject', { reason: 'Not ours at all' })).status).toBe(404);
    expect((await withdraw(other.teacher, dispute.id)).status).toBe(404);
    expect((await h.get(api('/staff-attendance-disputes'), other.office.cookie)).body).toMatchObject({ total: 0 });
    const intruder = await raise(other.teacher, { attendanceId: m.id.toString(), requestedStatus: 'present', reason: 'Someone else mark' });
    expect(intruder.status).toBe(422);
  });
});
