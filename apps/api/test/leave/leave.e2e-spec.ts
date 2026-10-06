// Slice 24 over HTTP (phase-3-financial.md slice 24): leave types, own requests and balances
// (R209), the overlap refusal (R211), decisions with the separation of duties and the sole
// principal (R210, R253), the cover on approval (R212), cancel and end-early (R248), the on-behalf
// request and the staff day sheet's approvedLeave. The real AppModule and database.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ErrorCode, newIdempotencyKey, type SystemRole } from '@asms/shared';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolSession,
  type TestSchoolUser,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createClassWithSection, createTeacherAssignment, day, isoDay } from '../support/students';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;
const db = () => testDb();

type Json = Record<string, unknown>;
interface ErrorBody {
  error: { code: string; details: { reason?: string; balance?: number; leaveRequestId?: string; status?: string; fields?: { path: string }[] } };
}
interface LeaveType {
  id: string;
  name: string;
  code: string;
  daysPerYear: number | null;
  paid: boolean;
  status: string;
  seeded: boolean;
}
interface LeaveRequest {
  id: string;
  staffId: string;
  staffName: string;
  leaveType: { id: string; name: string; code: string; paid: boolean };
  startsOn: string;
  endsOn: string;
  endedEarlyOn: string | null;
  workingDays: number;
  status: string;
  onBehalf: boolean;
  decidedByUserId: string | null;
  decidedByName: string | null;
  selfApproved: boolean;
  coverAssignmentId: string | null;
  coverEndedOn: string | null;
  sectionsNeedingCover: { sectionId: string; classId: string; name: string }[];
  cancelReason: string | null;
}
interface Balance {
  year: number;
  types: { leaveTypeId: string; name: string; entitlement: number | null; used: number; pending: number; balance: number | null }[];
}

describe('slice 24: staff leave (e2e)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  type Session = TestSchoolSession & { user: TestSchoolUser; school: TestSchool };
  const signIn = async (systemRole: SystemRole, school: TestSchool, fullName?: string): Promise<Session> => {
    const user = await createSchoolUser(db(), school, { systemRole, ...(fullName ? { fullName } : {}) });
    return { ...(await createSchoolSession(db(), school, user)), user, school };
  };
  const get = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const post = (path: string, body: object, s: { cookie: string }, headers: Record<string, string> = {}) => {
    const req = http().post(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(body);
  };
  const keyed = (path: string, body: object, s: { cookie: string }, key = newIdempotencyKey()) =>
    post(path, body, s, { 'Idempotency-Key': key });
  const err = (res: request.Response) => res.body as ErrorBody;
  const auditRows = (schoolId: bigint, action: string) =>
    db().auditLog.findMany({ where: { schoolId, action }, orderBy: { id: 'asc' } });

  /** A school whose every day is a staff working day, with its three seeded leave types. */
  const leaveSchool = async () => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10, weeklyOffDays: [] } });
    await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
    const principal = await signIn('principal', school, 'Nadia Principal');
    const types = (await get('/leave-types', principal).expect(200)).body as { data: LeaveType[] };
    const byCode = (code: string) => types.data.find((t) => t.code === code)!;
    return { school, principal, casual: byCode('casual'), sick: byCode('sick'), unpaid: byCode('unpaid') };
  };
  const ask = (s: Session, leaveTypeId: string, from: number, to: number, key?: string) =>
    keyed('/me/staff/leave-requests', { leaveTypeId, startsOn: isoDay(from), endsOn: isoDay(to), reason: 'Family wedding' }, s, key);

  // ---------------------------------------------------------------------------- leave types

  it('R209: the three seeded types; create, name taken, unpaid never paid, archive; teachers read only', async () => {
    const { principal } = await leaveSchool();
    const teacher = await signIn('teacher', principal.school);
    const list = (await get('/leave-types', teacher).expect(200)).body as { data: LeaveType[] };
    expect(list.data.map((t) => [t.name, t.code, t.daysPerYear, t.paid, t.seeded])).toEqual([
      ['Casual leave', 'casual', 10, true, true],
      ['Sick leave', 'sick', 10, true, true],
      ['Unpaid leave', 'unpaid', null, false, true],
    ]);
    await post('/leave-types', { name: 'Hajj leave', code: 'other', paid: true }, teacher).expect(403);
    const created = await post('/leave-types', { name: 'Hajj leave', code: 'other', daysPerYear: 30, paid: true }, principal).expect(201);
    expect((created.body as LeaveType).seeded).toBe(false);
    const taken = await post('/leave-types', { name: 'hajj LEAVE', code: 'other', paid: false }, principal);
    expect([taken.status, err(taken).error.code]).toEqual([409, ErrorCode.LEAVE_TYPE_NAME_TAKEN]);
    const unpaid = await post('/leave-types', { name: 'Unpaid two', code: 'unpaid', paid: true }, principal);
    expect([unpaid.status, err(unpaid).error.details.fields?.[0]?.path]).toEqual([422, 'paid']);
    const id = (created.body as LeaveType).id;
    const archived = await post(`/leave-types/${id}/archive`, { reason: 'Not offered' }, principal).expect(200);
    expect((archived.body as LeaveType).status).toBe('archived');
    // An archived type refuses new requests.
    const refused = await ask(teacher, id, 1, 1);
    expect([refused.status, err(refused).error.code]).toEqual([409, ErrorCode.LEAVE_TYPE_ARCHIVED]);
    await post(`/leave-types/${id}/archive`, { reason: 'Again' }, principal).expect(200);
    expect((await auditRows(principal.school.id, 'leave_type.archived')).length).toBe(1);
    expect((await auditRows(principal.school.id, 'leave_type.created')).map((r) => r.metadata)).toEqual([
      { name: 'Hajj leave', code: 'other', daysPerYear: 30, paid: true },
    ]);
  });

  // --------------------------------------------------------------------- own requests, balance

  it('R209, R211: a request freezes its working days; the balance holds pending days; overlap and balance refused; replay', async () => {
    const { principal, casual, unpaid } = await leaveSchool();
    const teacher = await signIn('teacher', principal.school, 'Rabia Teacher');
    const key = newIdempotencyKey();
    const first = await ask(teacher, casual.id, 3, 5, key).expect(201);
    const req = first.body as LeaveRequest;
    expect([req.status, req.workingDays, req.onBehalf, req.staffName]).toEqual(['pending', 3, false, 'Rabia Teacher']);
    // The same key and body replays.
    const replay = await ask(teacher, casual.id, 3, 5, key).expect(200);
    expect([replay.headers['idempotency-replayed'], (replay.body as LeaveRequest).id]).toEqual(['true', req.id]);

    const overlap = await ask(teacher, unpaid.id, 5, 6);
    expect([overlap.status, err(overlap).error.code, err(overlap).error.details.leaveRequestId]).toEqual([409, ErrorCode.LEAVE_OVERLAPS, req.id]);
    // 3 pending + 8 > 10.
    const over = await ask(teacher, casual.id, 10, 17);
    expect([over.status, err(over).error.code, err(over).error.details.balance]).toEqual([409, ErrorCode.LEAVE_BALANCE_EXCEEDED, 7]);
    // Unpaid leave has no limit.
    await ask(teacher, unpaid.id, 10, 30).expect(201);

    // Dates: at most 7 days back, end after start, 60 days at most.
    expect((await ask(teacher, casual.id, -8, -8)).status).toBe(422);
    expect((await ask(teacher, casual.id, 40, 39)).status).toBe(422);
    expect((await ask(teacher, unpaid.id, 40, 100)).status).toBe(422);

    const balance = (await get('/me/staff/leave-balance', teacher).expect(200)).body as Balance;
    const row = balance.types.find((t) => t.leaveTypeId === casual.id)!;
    // Some of days 3..5 may fall in next year at the year's end; only this year's count here.
    if (isoDay(5).slice(0, 4) === isoDay(0).slice(0, 4)) {
      expect([row.entitlement, row.used, row.pending, row.balance]).toEqual([10, 0, 3, 10]);
    }

    const mine = (await get('/me/staff/leave-requests', teacher).expect(200)).body as { data: LeaveRequest[]; total: number };
    expect(mine.total).toBe(2);
    // Another staff member's request is 404 on the own route.
    const other = await signIn('teacher', principal.school);
    await get(`/me/staff/leave-requests/${req.id}`, other).expect(404);
    await get(`/me/staff/leave-requests/${req.id}`, teacher).expect(200);
    // Teachers reach no approver route.
    await get('/leave-requests', teacher).expect(403);
    // leave_requested reached the principal, not the requester.
    const messages = await db().message.findMany({ where: { schoolId: principal.school.id, type: 'leave_requested', subjectId: BigInt(req.id) } });
    expect(messages.map((m) => m.staffId)).toEqual([principal.user.staffId]);
    expect(messages[0]?.body).toContain('Rabia Teacher');
  });

  it('R211: two overlapping requests racing: one is created, the other is LEAVE_OVERLAPS; the constraint holds underneath', async () => {
    const { school, principal, unpaid } = await leaveSchool();
    const teacher = await signIn('teacher', school);
    const results = await Promise.all([ask(teacher, unpaid.id, 2, 4), ask(teacher, unpaid.id, 3, 6)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.map((r) => (r.status === 409 ? err(r).error.code : 'created')).sort()).toEqual([ErrorCode.LEAVE_OVERLAPS, 'created']);
    const winner = results.find((r) => r.status === 201)!.body as LeaveRequest;
    // A direct overlapping insert is refused by leave_requests_live_excl.
    await expect(
      db().leaveRequest.create({
        data: {
          schoolId: school.id, staffId: teacher.user.staffId, leaveTypeId: BigInt(unpaid.id), startsOn: day(winner.endsOn),
          endsOn: day(winner.endsOn), workingDays: 1, reason: 'Direct', requestedBy: principal.user.userId,
        },
      }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------- decisions and cover

  it('R212: approving with a cover creates the slice-10 cover row; /me of the cover shows it; cancel before start ends it', async () => {
    const { school, principal, casual } = await leaveSchool();
    const teacher = await signIn('teacher', school, 'Class Teacher');
    const coverer = await signIn('teacher', school, 'Cover Teacher');
    const { section } = await createClassWithSection(db(), school);
    const ct = await createTeacherAssignment(db(), school, teacher.user, { role: 'class_teacher', section, startsOn: isoDay(-30) });

    const req = (await ask(teacher, casual.id, 0, 2).expect(201)).body as LeaveRequest;
    expect(req.sectionsNeedingCover.map((s) => s.sectionId)).toEqual([section.id.toString()]);

    // The cover must be for a class-teacher section of the person, and not the person.
    const wrong = await post(`/leave-requests/${req.id}/approve`, { cover: { sectionId: '999999', coverStaffId: coverer.user.staffId.toString() } }, principal);
    expect([wrong.status, err(wrong).error.details.fields?.[0]?.path]).toEqual([422, 'cover.sectionId']);
    const self = await post(`/leave-requests/${req.id}/approve`, { cover: { sectionId: section.id.toString(), coverStaffId: teacher.user.staffId.toString() } }, principal);
    expect(self.status).toBe(422);

    const approved = await post(
      `/leave-requests/${req.id}/approve`,
      { reason: 'Enjoy', cover: { sectionId: section.id.toString(), coverStaffId: coverer.user.staffId.toString() } },
      principal,
    ).expect(200);
    const body = approved.body as LeaveRequest;
    expect([body.status, body.decidedByName, body.selfApproved, body.sectionsNeedingCover]).toEqual(['approved', 'Nadia Principal', false, []]);
    const cover = await db().teacherAssignment.findFirstOrThrow({ where: { schoolId: school.id, id: BigInt(body.coverAssignmentId!) } });
    expect([cover.role, cover.staffId, cover.sectionId, cover.coversAssignmentId, cover.startsOn, cover.endsOn]).toEqual([
      'cover', coverer.user.staffId, section.id, ct.id, day(isoDay(0)), day(isoDay(2)),
    ]);
    const me = (await get('/me', coverer).expect(200)).body as { assignments: { sectionId: string | null; role: string }[] };
    expect(me.assignments).toContainEqual(expect.objectContaining({ sectionId: section.id.toString(), role: 'cover' }));
    // A second decision on a moved row.
    const again = await post(`/leave-requests/${req.id}/reject`, { reason: 'Changed my mind' }, principal);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.LEAVE_NOT_PENDING]);
    // leave_decided reached the staff member.
    expect(await db().message.count({ where: { schoolId: school.id, type: 'leave_decided', staffId: teacher.user.staffId } })).toBe(1);
    // Started today: cancelling is refused.
    const started = await post(`/me/staff/leave-requests/${req.id}/cancel`, { reason: 'Back early' }, teacher);
    expect([started.status, err(started).error.code]).toEqual([409, ErrorCode.LEAVE_STARTED]);

    // A future approved leave with a cover: cancelling it voids the cover.
    const later = (await ask(teacher, casual.id, 20, 21).expect(201)).body as LeaveRequest;
    const laterApproved = (
      await post(`/leave-requests/${later.id}/approve`, { cover: { sectionId: section.id.toString(), coverStaffId: coverer.user.staffId.toString() } }, principal).expect(200)
    ).body as LeaveRequest;
    const cancelled = await post(`/me/staff/leave-requests/${later.id}/cancel`, { reason: 'Plans changed' }, teacher).expect(200);
    expect([(cancelled.body as LeaveRequest).status, (cancelled.body as LeaveRequest).cancelReason]).toEqual(['cancelled', 'Plans changed']);
    const voided = await db().teacherAssignment.findFirstOrThrow({ where: { schoolId: school.id, id: BigInt(laterApproved.coverAssignmentId!) } });
    expect(voided.voidedAt).not.toBeNull();
    // A voided cover never counted: no day it ended on.
    expect((cancelled.body as LeaveRequest).coverEndedOn).toBeNull();
    // Cancelled frees the dates.
    await ask(teacher, casual.id, 20, 21).expect(201);
    expect((await auditRows(school.id, 'leave_request.cancelled')).map((r) => [r.actorUserId, r.reason])).toEqual([
      [teacher.user.userId, 'Plans changed'],
    ]);
  });

  it('R248: end-early ends the leave and its cover the same day and frees the later dates; the day sheet shows the leave', async () => {
    const { school, principal, casual } = await leaveSchool();
    const teacher = await signIn('teacher', school);
    const coverer = await signIn('teacher', school);
    const { section } = await createClassWithSection(db(), school);
    await createTeacherAssignment(db(), school, teacher.user, { role: 'class_teacher', section, startsOn: isoDay(-30) });
    const req = (await ask(teacher, casual.id, 0, 4).expect(201)).body as LeaveRequest;
    const approved = (
      await post(`/leave-requests/${req.id}/approve`, { cover: { sectionId: section.id.toString(), coverStaffId: coverer.user.staffId.toString() } }, principal).expect(200)
    ).body as LeaveRequest;

    // The day sheet (office) shows the approved leave and writes no mark.
    const sheet = (await get(`/staff-attendance?date=${isoDay(0)}`, principal).expect(200)).body as {
      data: { staffId: string; mark: unknown; approvedLeave: { leaveRequestId: string; typeName: string } | null }[];
    };
    const row = sheet.data.find((r) => r.staffId === teacher.user.staffId.toString())!;
    expect([row.mark, row.approvedLeave]).toEqual([null, { leaveRequestId: req.id, typeName: 'Casual leave' }]);
    expect(sheet.data.find((r) => r.staffId === coverer.user.staffId.toString())?.approvedLeave).toBeNull();

    const badDay = await post(`/leave-requests/${req.id}/end-early`, { endedOn: isoDay(4), reason: 'Back' }, principal);
    expect(badDay.status).toBe(422);
    const ended = await post(`/leave-requests/${req.id}/end-early`, { endedOn: isoDay(1), reason: 'Came back early' }, principal).expect(200);
    expect([(ended.body as LeaveRequest).status, (ended.body as LeaveRequest).endedEarlyOn, (ended.body as LeaveRequest).coverEndedOn]).toEqual([
      'ended_early',
      isoDay(1),
      isoDay(1),
    ]);
    const cover = await db().teacherAssignment.findFirstOrThrow({ where: { schoolId: school.id, id: BigInt(approved.coverAssignmentId!) } });
    expect(cover.endsOn).toEqual(day(isoDay(1)));
    // The later dates are free again.
    await ask(teacher, casual.id, 2, 4).expect(201);
    // Not twice.
    const twice = await post(`/leave-requests/${req.id}/end-early`, { endedOn: isoDay(0), reason: 'Again' }, principal);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    expect((await auditRows(school.id, 'leave_request.ended_early')).length).toBe(1);

    // The trigger refuses an end-early with no actor in the change context (fail-closed).
    const another = (await ask(teacher, casual.id, 30, 31).expect(201)).body as LeaveRequest;
    await post(`/leave-requests/${another.id}/approve`, {}, principal).expect(200);
    await expect(
      db().leaveRequest.updateMany({ where: { schoolId: school.id, id: BigInt(another.id) }, data: { status: 'ended_early', endedEarlyOn: day(isoDay(30)) } }),
    ).rejects.toThrow(/leave_requests_actor_required/);
  });

  // ------------------------------------------------------------------ separation of duties

  it('R210, R253: nobody decides their own leave, except the sole principal approving theirs (self_approved)', async () => {
    const { school, principal, casual } = await leaveSchool();
    // Sole principal: approves own, recorded self_approved; rejecting own is still refused.
    const own = (await ask(principal, casual.id, 1, 1).expect(201)).body as LeaveRequest;
    // No other approver exists, so nobody was told.
    expect(await db().message.count({ where: { schoolId: school.id, type: 'leave_requested', subjectId: BigInt(own.id) } })).toBe(0);
    const selfApproved = await post(`/leave-requests/${own.id}/approve`, {}, principal).expect(200);
    expect((selfApproved.body as LeaveRequest).selfApproved).toBe(true);
    expect((await auditRows(school.id, 'leave_request.approved')).map((r) => (r.metadata as Json).selfApproved)).toEqual([true]);
    const ownReject = (await ask(principal, casual.id, 3, 3).expect(201)).body as LeaveRequest;
    const refusedReject = await post(`/leave-requests/${ownReject.id}/reject`, { reason: 'Not now' }, principal);
    expect([refusedReject.status, err(refusedReject).error.code]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN]);

    // A second principal: no exception any more, in the service and in the trigger.
    const second = await signIn('principal', school);
    const mine = (await ask(principal, casual.id, 5, 5).expect(201)).body as LeaveRequest;
    const refused = await post(`/leave-requests/${mine.id}/approve`, {}, principal);
    expect([refused.status, err(refused).error.code, err(refused).error.details.reason]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN, 'own_leave']);
    await expect(
      db().leaveRequest.updateMany({
        where: { schoolId: school.id, id: BigInt(mine.id) },
        data: { status: 'approved', decidedBy: principal.user.userId, decidedAt: new Date(), selfApproved: true },
      }),
    ).rejects.toThrow(/leave_requests_not_self/);
    // The colleague decides it.
    await post(`/leave-requests/${mine.id}/approve`, {}, second).expect(200);
  });

  it('R210: an approver records leave on behalf; it stays pending and is decided by someone; a reject needs a reason', async () => {
    const { school, principal, sick } = await leaveSchool();
    const teacher = await signIn('teacher', school);
    const recorded = await keyed('/leave-requests', { staffId: teacher.user.staffId.toString(), leaveTypeId: sick.id, startsOn: isoDay(-2), endsOn: isoDay(-1), reason: 'Phoned in sick' }, principal).expect(201);
    const req = recorded.body as LeaveRequest;
    expect([req.status, req.onBehalf, req.workingDays]).toEqual(['pending', true, 2]);
    // Not for oneself through this route.
    const own = await keyed('/leave-requests', { staffId: principal.user.staffId.toString(), leaveTypeId: sick.id, startsOn: isoDay(1), endsOn: isoDay(1), reason: 'Mine' }, principal);
    expect([own.status, err(own).error.details.fields?.[0]?.path]).toEqual([422, 'staffId']);
    // Another school's staff id is unknown here.
    const elsewhere = await createSchool();
    const stranger = await createSchoolUser(db(), elsewhere, { systemRole: 'teacher' });
    const foreign = await keyed('/leave-requests', { staffId: stranger.staffId.toString(), leaveTypeId: sick.id, startsOn: isoDay(1), endsOn: isoDay(1), reason: 'Foreign' }, principal);
    expect([foreign.status, err(foreign).error.details.fields?.[0]?.path]).toEqual([422, 'staffId']);

    await post(`/leave-requests/${req.id}/reject`, {}, principal).expect(422);
    const rejected = await post(`/leave-requests/${req.id}/reject`, { reason: 'Use casual leave' }, principal).expect(200);
    expect((rejected.body as LeaveRequest).status).toBe('rejected');
    expect((await auditRows(school.id, 'leave_request.rejected')).map((r) => r.reason)).toEqual(['Use casual leave']);
    expect((await auditRows(school.id, 'leave_request.created')).map((r) => [r.actorUserId, (r.metadata as Json).onBehalf])).toEqual([
      [principal.user.userId, true],
    ]);
    // The approvers' list filters by status and staff.
    const list = (await get(`/leave-requests?status=rejected&staffId=${teacher.user.staffId}`, principal).expect(200)).body as { data: LeaveRequest[] };
    expect(list.data.map((r) => r.id)).toEqual([req.id]);
    // staff.view reads the member's requests and balance.
    const staffList = (await get(`/staff/${teacher.user.staffId}/leave-requests`, principal).expect(200)).body as { total: number };
    expect(staffList.total).toBe(1);
    await get(`/staff/${stranger.staffId}/leave-balance`, principal).expect(404);
    const bal = (await get(`/staff/${teacher.user.staffId}/leave-balance?year=${isoDay(0).slice(0, 4)}`, principal).expect(200)).body as Balance;
    expect(bal.types.map((t) => t.name)).toEqual(['Casual leave', 'Sick leave', 'Unpaid leave']);
  });

  it('R209: approval re-checks the balance against approved days; a joiner mid-year gets a pro-rated entitlement', async () => {
    const { school, principal, casual } = await leaveSchool();
    const teacher = await signIn('teacher', school);
    const year = Number(isoDay(0).slice(0, 4));
    // Requested on the full entitlement; by the decision the person's join date says 1 day.
    const req = (await ask(teacher, casual.id, 1, 3).expect(201)).body as LeaveRequest;
    const requestYear = req.startsOn.slice(0, 4);
    await db().staff.updateMany({ where: { schoolId: school.id, id: teacher.user.staffId }, data: { joinedOn: day(`${requestYear}-11-01`) } });
    const refused = await post(`/leave-requests/${req.id}/approve`, {}, principal);
    expect([refused.status, err(refused).error.code, err(refused).error.details.balance]).toEqual([409, ErrorCode.LEAVE_BALANCE_EXCEEDED, 1]);
    // Joined on 1 July: 6 of 12 months, 5 casual days.
    await db().staff.updateMany({ where: { schoolId: school.id, id: teacher.user.staffId }, data: { joinedOn: day(`${year}-07-01`) } });
    const bal = (await get(`/me/staff/leave-balance?year=${year}`, teacher).expect(200)).body as Balance;
    expect(bal.types.find((t) => t.leaveTypeId === casual.id)?.entitlement).toBe(5);
    // A second year bound: before the join year nothing is entitled.
    const before = (await get(`/me/staff/leave-balance?year=${year - 1}`, teacher).expect(200)).body as Balance;
    expect(before.types.find((t) => t.leaveTypeId === casual.id)?.entitlement).toBe(0);
    await get('/me/staff/leave-balance?year=20x6', teacher).expect(422);
  });
  it('fix round: approving with a cover needs class.manage, refused before any write; without a cover it approves', async () => {
    const { school, principal, casual } = await leaveSchool();
    const office = await signIn('office_staff', school);
    await db().userCapabilityGrant.create({
      data: { schoolId: school.id, userId: office.user.userId, capabilityKey: 'staff.leave.approve', effect: 'grant', grantedBy: principal.user.userId, reason: 'Test grant' },
    });
    const teacher = await signIn('teacher', school);
    const coverer = await signIn('teacher', school);
    const { section } = await createClassWithSection(db(), school);
    await createTeacherAssignment(db(), school, teacher.user, { role: 'class_teacher', section, startsOn: isoDay(-30) });
    const req = (await ask(teacher, casual.id, 2, 3).expect(201)).body as LeaveRequest;
    const before = await db().teacherAssignment.count({ where: { schoolId: school.id } });
    const refused = await post(`/leave-requests/${req.id}/approve`, { cover: { sectionId: section.id.toString(), coverStaffId: coverer.user.staffId.toString() } }, office);
    expect([refused.status, err(refused).error.code, err(refused).error.details.reason]).toEqual([403, ErrorCode.PERMISSION_DENIED, 'cover_needs_class_manage']);
    // Nothing written: still pending, no cover row.
    expect((await db().leaveRequest.findFirstOrThrow({ where: { schoolId: school.id, id: BigInt(req.id) } })).status).toBe('pending');
    expect(await db().teacherAssignment.count({ where: { schoolId: school.id } })).toBe(before);
    const approved = await post(`/leave-requests/${req.id}/approve`, {}, office).expect(200);
    expect([(approved.body as LeaveRequest).status, (approved.body as LeaveRequest).coverAssignmentId]).toEqual(['approved', null]);
  });

  it('fix round: staff.view reads a member’s requests without reason or decisionReason; the owner and approvers keep them', async () => {
    const { school, principal, casual } = await leaveSchool();
    const office = await signIn('office_staff', school);
    const teacher = await signIn('teacher', school);
    const req = (await ask(teacher, casual.id, 2, 3).expect(201)).body as LeaveRequest;
    await post(`/leave-requests/${req.id}/reject`, { reason: 'Exams that week' }, principal).expect(200);
    const viewed = (await get(`/staff/${teacher.user.staffId}/leave-requests`, office).expect(200)).body as { data: Json[] };
    expect(viewed.data).toHaveLength(1);
    expect(viewed.data[0]).not.toHaveProperty('reason');
    expect(viewed.data[0]).not.toHaveProperty('decisionReason');
    expect(viewed.data[0]).toMatchObject({ id: req.id, status: 'rejected' });
    const own = (await get(`/me/staff/leave-requests/${req.id}`, teacher).expect(200)).body as Json;
    expect([own.reason, own.decisionReason]).toEqual(['Family wedding', 'Exams that week']);
    const approver = (await get(`/leave-requests/${req.id}`, principal).expect(200)).body as Json;
    expect([approver.reason, approver.decisionReason]).toEqual(['Family wedding', 'Exams that week']);
  });

  it('fix round, R248: an end early dated in the past ends a begun cover yesterday and says so in coverEndedOn', async () => {
    const { school, principal, casual } = await leaveSchool();
    const teacher = await signIn('teacher', school);
    const coverer = await signIn('teacher', school);
    const { section } = await createClassWithSection(db(), school);
    const ct = await createTeacherAssignment(db(), school, teacher.user, { role: 'class_teacher', section, startsOn: isoDay(-30) });
    const req = (await ask(teacher, casual.id, -3, 2).expect(201)).body as LeaveRequest;
    await post(`/leave-requests/${req.id}/approve`, {}, principal).expect(200);
    // A cover that began with the leave (as one approved on its first day would have).
    const cover = await createTeacherAssignment(db(), school, coverer.user, {
      role: 'cover', section, startsOn: isoDay(-3), endsOn: isoDay(2), coversAssignmentId: ct.id,
    });
    await db().leaveRequest.updateMany({ where: { schoolId: school.id, id: BigInt(req.id) }, data: { coverAssignmentId: cover.id } });
    const ended = (await post(`/leave-requests/${req.id}/end-early`, { endedOn: isoDay(-2), reason: 'Came back early' }, principal).expect(200)).body as LeaveRequest;
    expect([ended.endedEarlyOn, ended.coverEndedOn]).toEqual([isoDay(-2), isoDay(-1)]);
    expect((await db().teacherAssignment.findFirstOrThrow({ where: { schoolId: school.id, id: cover.id } })).endsOn).toEqual(day(isoDay(-1)));
  });
});
