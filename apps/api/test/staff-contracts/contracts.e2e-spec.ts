// Slice 39 over HTTP (phase-5-extended.md rule 35, §5 slice 39; contracts/slice-39.md): one live
// contract, permanent without an end (R318), renew atomicity, end with a reason, end employment
// ending the contract, the expiry job's once-only warnings at 30 and 7 days in school time (R319),
// expiry changing nothing (R320), the structure reference and the scan's streaming permissions
// (R321), and another school's ids (404). The real AppModule and database, with the school's
// clock fixed at 10 October 2026 (SchoolClock overridden).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ErrorCode, newIdempotencyKey, type SystemRole } from '@asms/shared';
import { SchoolClock } from '../../src/common/school-clock';
import { ContractExpiryWarn, contractNoticeSubjectId } from '../../src/modules/people/staff/contract-expiry.job';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp } from '../core/app';
import { png } from '../documents/fixtures';
import { asSchool } from '../messaging/support';
import { fixedClock, karachi } from '../payroll/support';
import { createSchoolSession, createSchoolUser, type TestSchoolSession, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;
const db = () => testDb();

interface ErrorBody {
  error: { code: string; details: { staffId?: string; contractId?: string; fields?: { path: string; code: string }[] } | null };
}
interface Contract {
  id: string;
  staffId: string;
  staffName: string;
  type: string;
  startsOn: string;
  endsOn: string | null;
  status: string;
  daysLeft: number | null;
  salaryStructureId: string | null;
  hasDocument: boolean;
  documentMime: string | null;
  note: string | null;
  endedOn: string | null;
  endReason: string | null;
  endedByName: string | null;
}
interface PageOf<T> {
  data: T[];
  total: number;
}

describe('slice 39: staff contracts (e2e)', () => {
  let app: NestExpressApplication;
  const clock = fixedClock('2026-10-10');
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: SchoolClock, useValue: clock.value }] });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  type Session = TestSchoolSession & { user: TestSchoolUser; school: TestSchool };
  const newSchool = async (): Promise<TestSchool> => {
    const school = await createSchool();
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    return school;
  };
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
  const create = (s: Session, staffId: bigint, body: object, key = newIdempotencyKey()) =>
    post(`/staff/${staffId}/contracts`, body, s, { 'Idempotency-Key': key });
  const created = async (s: Session, staffId: bigint, body: object): Promise<Contract> => {
    const res = await create(s, staffId, body);
    expect(res.status).toBe(201);
    return res.body as Contract;
  };
  const fixedTerm = (startsOn: string, endsOn: string, extra: object = {}) => ({ type: 'fixed_term', startsOn, endsOn, ...extra });
  const err = (res: request.Response) => res.body as ErrorBody;
  const field = (res: request.Response) => err(res).error.details?.fields?.[0];
  const audits = (school: TestSchool, action: string) =>
    db().auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });
  const row = (school: TestSchool, id: string) => db().staffContract.findFirst({ where: { schoolId: school.id, id: BigInt(id) } });
  const stage = async (s: Session): Promise<string> => {
    const res = await http().post(`${API}/uploads`).set('Cookie', s.cookie).set('Origin', ORIGIN).attach('file', await png(), 'scan.png');
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };
  const warn = (schoolId: SchoolId, now: Date) =>
    asSchool(app, schoolId, () => app.get(ContractExpiryWarn, { strict: false }).run(schoolId, now));
  const warnings = (school: TestSchool) =>
    db().message.findMany({
      where: { schoolId: school.id, type: 'contract_expiring' },
      orderBy: { id: 'asc' },
      select: { subjectId: true, staffId: true, body: true },
    });

  // ------------------------------------------------------------------------------- R318

  it('R318: create, replay, one live contract, permanent has no end, others need one; teacher 403', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school, 'Rabia Teacher');
    const staffId = teacher.user.staffId;

    const key = newIdempotencyKey();
    const body = fixedTerm('2026-01-01', '2026-12-31', { note: 'Science post, one year' });
    const first = (await create(principal, staffId, body, key).expect(201)).body as Contract;
    expect([first.type, first.status, first.endsOn, first.daysLeft, first.note, first.staffName]).toEqual([
      'fixed_term',
      'live',
      '2026-12-31',
      82,
      'Science post, one year',
      'Rabia Teacher',
    ]);
    const replay = await create(principal, staffId, body, key).expect(200);
    expect([replay.headers['idempotency-replayed'], (replay.body as Contract).id]).toEqual(['true', first.id]);

    const second = await create(principal, staffId, { type: 'permanent', startsOn: '2027-01-01' });
    expect([second.status, err(second).error.code, err(second).error.details?.contractId]).toEqual([
      409,
      ErrorCode.STAFF_CONTRACT_LIVE_EXISTS,
      first.id,
    ]);

    const other = await signIn('teacher', school);
    const permanentWithEnd = await create(principal, other.user.staffId, { type: 'permanent', startsOn: '2026-01-01', endsOn: '2026-12-31' });
    expect([permanentWithEnd.status, field(permanentWithEnd)]).toEqual([422, { path: 'endsOn', code: ErrorCode.STAFF_CONTRACT_END_REQUIRED, message: expect.any(String) }]);
    const probationWithout = await create(principal, other.user.staffId, { type: 'probation', startsOn: '2026-01-01' });
    expect([probationWithout.status, field(probationWithout)?.code]).toEqual([422, ErrorCode.STAFF_CONTRACT_END_REQUIRED]);
    const backwards = await create(principal, other.user.staffId, fixedTerm('2026-05-01', '2026-04-30'));
    expect([backwards.status, field(backwards)?.path]).toEqual([422, 'endsOn']);
    const permanent = await created(principal, other.user.staffId, { type: 'permanent', startsOn: '2026-01-01' });
    expect([permanent.endsOn, permanent.daysLeft, permanent.status]).toEqual([null, null, 'live']);

    // Only staff.contract.manage (principal by default) reaches the routes.
    const office = await signIn('office_staff', school);
    for (const s of [teacher, office]) {
      expect((await get(`/staff/${staffId}/contracts`, s)).status).toBe(403);
      expect((await create(s, staffId, { type: 'permanent', startsOn: '2026-01-01' })).status).toBe(403);
      expect((await post(`/staff-contracts/${first.id}/end`, { endedOn: '2026-10-10', reason: 'Ending early' }, s)).status).toBe(403);
    }
    const list = (await get(`/staff/${staffId}/contracts`, principal).expect(200)).body as PageOf<Contract>;
    expect(list.data.map((c) => c.id)).toEqual([first.id]);
    expect((await audits(school, 'staff_contract.created')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ staffId: staffId.toString(), type: 'fixed_term', endsOn: '2026-12-31', hasDocument: false }),
      expect.objectContaining({ staffId: other.user.staffId.toString(), type: 'permanent', endsOn: null }),
    ]);
  });

  it('R318: renew ends the current on its last day and opens the next from the day after, in one transaction', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school);
    const current = await created(principal, teacher.user.staffId, fixedTerm('2026-01-01', '2026-12-31'));

    // Refused after the end is written: the end rolls back with it.
    const badUpload = await post(`/staff-contracts/${current.id}/renew`, fixedTerm('2027-01-01', '2027-12-31', { stagedUploadId: '999999999' }), principal);
    expect([badUpload.status, field(badUpload)?.path]).toEqual([422, 'stagedUploadId']);
    const badEnd = await post(`/staff-contracts/${current.id}/renew`, { type: 'permanent', startsOn: '2027-01-01', endsOn: '2027-12-31' }, principal);
    expect([badEnd.status, field(badEnd)?.code]).toEqual([422, ErrorCode.STAFF_CONTRACT_END_REQUIRED]);
    expect((await row(school, current.id))?.endedAt).toBeNull();
    // The next starts the day after.
    const gap = await post(`/staff-contracts/${current.id}/renew`, fixedTerm('2027-01-05', '2027-12-31'), principal);
    expect([gap.status, field(gap)?.path]).toEqual([422, 'startsOn']);

    const next = (await post(`/staff-contracts/${current.id}/renew`, { type: 'permanent', startsOn: '2027-01-01' }, principal).expect(201))
      .body as Contract;
    expect([next.type, next.startsOn, next.status]).toEqual(['permanent', '2027-01-01', 'upcoming']);
    const ended = await row(school, current.id);
    expect([ended?.endReason, ended?.endedOn?.toISOString().slice(0, 10), ended?.endedBy]).toEqual(['renewed', '2026-12-31', principal.user.userId]);
    const list = (await get(`/staff/${teacher.user.staffId}/contracts`, principal).expect(200)).body as PageOf<Contract>;
    expect(list.data.map((c) => [c.id, c.status])).toEqual([
      [next.id, 'upcoming'],
      [current.id, 'ended'],
    ]);
    // Renewing again, or a permanent contract, is refused.
    const again = await post(`/staff-contracts/${current.id}/renew`, fixedTerm('2027-01-01', '2027-12-31'), principal);
    expect([again.status, err(again).error.code]).toEqual([409, ErrorCode.STAFF_CONTRACT_ENDED]);
    const fromPermanent = await post(`/staff-contracts/${next.id}/renew`, fixedTerm('2027-01-01', '2027-12-31'), principal);
    expect([fromPermanent.status, err(fromPermanent).error.code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    expect((await audits(school, 'staff_contract.renewed')).map((r) => [r.subjectId, r.metadata])).toEqual([
      [BigInt(next.id), expect.objectContaining({ renewedFromId: current.id, type: 'permanent', startsOn: '2027-01-01' })],
    ]);
  });

  it('R318: ending needs a reason and a day inside the contract; then a new contract may start', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school);
    const c = await created(principal, teacher.user.staffId, fixedTerm('2026-03-01', '2026-12-31'));

    const noReason = await post(`/staff-contracts/${c.id}/end`, { endedOn: '2026-10-10' }, principal);
    expect([noReason.status, field(noReason)?.path]).toEqual([422, 'reason']);
    const before = await post(`/staff-contracts/${c.id}/end`, { endedOn: '2026-02-28', reason: 'Mutual agreement' }, principal);
    expect([before.status, field(before)?.path]).toEqual([422, 'endedOn']);
    const after = await post(`/staff-contracts/${c.id}/end`, { endedOn: '2027-01-01', reason: 'Mutual agreement' }, principal);
    expect([after.status, field(after)?.path]).toEqual([422, 'endedOn']);

    const ended = (await post(`/staff-contracts/${c.id}/end`, { endedOn: '2026-10-31', reason: 'Mutual agreement' }, principal).expect(200))
      .body as Contract;
    expect([ended.status, ended.endedOn, ended.endReason, ended.daysLeft]).toEqual(['ended', '2026-10-31', 'Mutual agreement', null]);
    const twice = await post(`/staff-contracts/${c.id}/end`, { endedOn: '2026-10-31', reason: 'Mutual agreement' }, principal);
    expect([twice.status, err(twice).error.code]).toEqual([409, ErrorCode.STAFF_CONTRACT_ENDED]);
    // Ending a contract changes nothing else: the staff member is still active.
    expect((await db().staff.findFirst({ where: { schoolId: school.id, id: teacher.user.staffId } }))?.status).toBe('active');
    await created(principal, teacher.user.staffId, { type: 'probation', startsOn: '2026-11-01', endsOn: '2027-01-31' });
    expect((await audits(school, 'staff_contract.ended')).map((r) => [r.reason, r.metadata])).toEqual([
      ['Mutual agreement', expect.objectContaining({ endedOn: '2026-10-31', via: 'end' })],
    ]);
  });

  it('R318: end employment ends the live contract in the same transaction (reason left); an expired one on its own last day', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const live = await signIn('teacher', school);
    const expired = await signIn('teacher', school);
    const liveContract = await created(principal, live.user.staffId, fixedTerm('2026-01-01', '2026-12-31'));
    const expiredContract = await created(principal, expired.user.staffId, fixedTerm('2026-01-01', '2026-09-30'));

    await post(`/staff/${live.user.staffId}/change-status`, { status: 'left', reason: 'Resigned to move city' }, principal).expect(200);
    await post(`/staff/${expired.user.staffId}/change-status`, { status: 'left', reason: 'Contract not renewed' }, principal).expect(200);
    const a = await row(school, liveContract.id);
    const b = await row(school, expiredContract.id);
    expect([a?.endReason, a?.endedOn?.toISOString().slice(0, 10)]).toEqual(['left', '2026-10-10']);
    expect([b?.endReason, b?.endedOn?.toISOString().slice(0, 10)]).toEqual(['left', '2026-09-30']);
    expect((await audits(school, 'staff_contract.ended')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ via: 'end_employment', endedOn: '2026-10-10' }),
      expect.objectContaining({ via: 'end_employment', endedOn: '2026-09-30' }),
    ]);
    expect((await audits(school, 'staff.status_changed'))[0]?.metadata).toEqual(expect.objectContaining({ contractEndedId: liveContract.id }));
    // A left staff member gets no new contract until re-hired.
    const refused = await create(principal, live.user.staffId, { type: 'permanent', startsOn: '2026-11-01' });
    expect([refused.status, err(refused).error.code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
  });

  // ------------------------------------------------------------------------- R319, R320

  it('R319: the job warns at 30 and again at 7 days, once each, to every principal, in school time; nothing on the day', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    await signIn('principal', school);
    const teacher = await signIn('teacher', school, 'Kamran Teacher');
    const c = await created(principal, teacher.user.staffId, fixedTerm('2026-01-01', '2026-11-09'));

    // 9 October 20:00 UTC is 10 October 01:00 in Karachi: 30 days left in school time (31 in UTC).
    const evening = new Date('2026-10-09T20:00:00.000Z');
    expect(await warn(school.id, new Date('2026-10-09T18:00:00.000Z'))).toBe(0);
    expect(await warn(school.id, evening)).toBe(1);
    expect(await warn(school.id, evening)).toBe(0);
    expect(await warn(school.id, karachi('2026-10-20'))).toBe(0);
    let rows = await warnings(school);
    expect(rows.map((m) => m.subjectId)).toEqual([contractNoticeSubjectId(BigInt(c.id), 'first'), contractNoticeSubjectId(BigInt(c.id), 'first')]);
    expect(rows[0]?.body).toContain("Kamran Teacher's contract ends on");
    expect(rows[0]?.body).toContain('(30 days left)');

    expect(await warn(school.id, karachi('2026-11-02'))).toBe(1);
    expect(await warn(school.id, karachi('2026-11-03'))).toBe(0);
    expect(await warn(school.id, karachi('2026-11-09'))).toBe(0);
    expect(await warn(school.id, karachi('2026-11-10'))).toBe(0);
    rows = await warnings(school);
    expect(rows).toHaveLength(4);
    expect(rows[2]?.body).toContain('(7 days left)');
    const stamped = await row(school, c.id);
    expect([stamped?.warned30At, stamped?.warned7At].every((v) => v instanceof Date)).toBe(true);
  });

  it('R319 (fix round): contractWarningDays is read and written through the settings, 1-90, and the job warns by it', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school, 'Kamran Teacher');
    const patchSettings = (body: object, s: { cookie: string } = principal) =>
      http().patch(`${API}/school/settings`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);
    const read = async () => ((await get('/school/settings', principal).expect(200)).body as { contractWarningDays: number }).contractWarningDays;
    expect(await read()).toBe(30);
    for (const bad of [0, 91, 30.5, '45']) {
      const res = await patchSettings({ contractWarningDays: bad });
      expect([bad, res.status, field(res)?.path]).toEqual([bad, 422, 'contractWarningDays']);
    }
    expect((await patchSettings({ contractWarningDays: 45 }, teacher)).status).toBe(403);
    await patchSettings({ contractWarningDays: 45 }).expect(200);
    expect(await read()).toBe(45);
    expect((await audits(school, 'school_settings.updated')).length).toBe(1);

    // 45 days before 2026-11-24 is 2026-10-10: the first warning goes out today, not at 30.
    const c = await created(principal, teacher.user.staffId, fixedTerm('2026-01-01', '2026-11-24'));
    expect(await warn(school.id, karachi('2026-10-09'))).toBe(0);
    expect(await warn(school.id, karachi('2026-10-10'))).toBe(1);
    expect((await warnings(school)).map((m) => m.subjectId)).toEqual([contractNoticeSubjectId(BigInt(c.id), 'first')]);
    expect((await warnings(school))[0]?.body).toContain('(45 days left)');
  });

  it('R319: a contract added inside the 7-day window gets one warning; permanent and ended contracts none', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const short = await signIn('teacher', school);
    const permanent = await signIn('teacher', school);
    const ended = await signIn('teacher', school);
    const c = await created(principal, short.user.staffId, fixedTerm('2026-09-01', '2026-10-15'));
    await created(principal, permanent.user.staffId, { type: 'permanent', startsOn: '2026-01-01' });
    const e = await created(principal, ended.user.staffId, fixedTerm('2026-01-01', '2026-10-20'));
    await post(`/staff-contracts/${e.id}/end`, { endedOn: '2026-10-10', reason: 'Ended early by agreement' }, principal).expect(200);

    expect(await warn(school.id, karachi('2026-10-10'))).toBe(1);
    expect(await warn(school.id, karachi('2026-10-11'))).toBe(0);
    expect((await warnings(school)).map((m) => m.subjectId)).toEqual([contractNoticeSubjectId(BigInt(c.id), 'second')]);
    expect((await row(school, c.id))?.warned30At).toBeNull();
  });

  it('R320: a contract past its end and not ended is "expired" and changes nothing; the ending list includes it', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school);
    const soon = await signIn('teacher', school);
    const past = await created(principal, teacher.user.staffId, fixedTerm('2026-01-01', '2026-10-01'));
    const ending = await created(principal, soon.user.staffId, fixedTerm('2026-01-01', '2026-11-05'));
    await created(principal, (await signIn('teacher', school)).user.staffId, fixedTerm('2026-01-01', '2027-06-30'));
    expect([past.status, past.daysLeft]).toEqual(['expired', -9]);
    expect(await warn(school.id, karachi('2026-10-10'))).toBe(1);
    expect((await row(school, past.id))?.endedAt).toBeNull();
    expect((await db().staff.findFirst({ where: { schoolId: school.id, id: teacher.user.staffId } }))?.status).toBe('active');
    const list = (await get('/staff-contracts?endsBy=2026-11-09', principal).expect(200)).body as PageOf<Contract>;
    expect(list.data.map((c) => [c.id, c.status])).toEqual([
      [past.id, 'expired'],
      [ending.id, 'live'],
    ]);
    expect((await get('/staff-contracts', principal)).status).toBe(422);
  });

  // ------------------------------------------------------------------------------- R321

  it('R321: the structure at the start, no pay; the scan streams only under staff.contract.manage or to its owner', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school);
    const colleague = await signIn('teacher', school);
    const office = await signIn('office_staff', school);
    const structure = await post(
      `/staff/${teacher.user.staffId}/salary-structure`,
      { basic: 50_000, components: [], effectiveFrom: '2026-01-01', reason: 'Appointment terms' },
      principal,
      { 'Idempotency-Key': newIdempotencyKey() },
    ).expect(201);
    const structureId = (structure.body as { id: string }).id;
    const otherStructure = await post(
      `/staff/${colleague.user.staffId}/salary-structure`,
      { basic: 40_000, components: [], effectiveFrom: '2026-01-01', reason: 'Appointment terms' },
      principal,
      { 'Idempotency-Key': newIdempotencyKey() },
    ).expect(201);
    const wrong = await create(principal, teacher.user.staffId, fixedTerm('2026-02-01', '2026-12-31', { salaryStructureId: (otherStructure.body as { id: string }).id }));
    expect([wrong.status, field(wrong)?.path]).toEqual([422, 'salaryStructureId']);

    const scan = await stage(principal);
    const c = await created(principal, teacher.user.staffId, fixedTerm('2026-02-01', '2026-12-31', { stagedUploadId: scan, note: 'Internal note' }));
    expect([c.salaryStructureId, c.hasDocument, c.documentMime]).toEqual([structureId, true, 'image/png']);
    expect(Object.keys(c).filter((k) => /basic|amount|salary(?!StructureId)/i.test(k))).toEqual([]);
    // A staged upload is consumed once.
    const reused = await create(principal, colleague.user.staffId, fixedTerm('2026-02-01', '2026-12-31', { stagedUploadId: scan }));
    expect([reused.status, field(reused)?.path]).toEqual([422, 'stagedUploadId']);

    const file = await get(`/staff-contracts/${c.id}/document`, principal).buffer(true).expect(200);
    expect([file.headers['content-type'], file.headers['x-content-type-options'], file.headers['content-security-policy'], file.headers['cache-control']]).toEqual([
      'image/png',
      'nosniff',
      'sandbox',
      'no-store',
    ]);
    expect(file.headers['content-disposition']).toContain(`contract-${c.id}.png`);
    for (const s of [office, colleague, teacher]) expect((await get(`/staff-contracts/${c.id}/document`, s)).status).toBe(403);

    // The owner: their live contract without note or structure, and its scan.
    const mine = (await get('/me/staff/contract', teacher).expect(200)).body as { current: Record<string, unknown> };
    expect(mine.current).toEqual({ id: c.id, type: 'fixed_term', startsOn: '2026-02-01', endsOn: '2026-12-31', status: 'live', hasDocument: true });
    await get('/me/staff/contract/document', teacher).buffer(true).expect(200);
    expect(((await get('/me/staff/contract', colleague).expect(200)).body as { current: null }).current).toBeNull();
    await get('/me/staff/contract/document', colleague).expect(404);
    expect((await audits(school, 'staff_contract.document_viewed')).map((r) => [r.actorUserId, r.metadata])).toEqual([
      [principal.user.userId, expect.objectContaining({ staffId: teacher.user.staffId.toString(), own: false })],
      [teacher.user.userId, expect.objectContaining({ own: true })],
    ]);
  });

  it('another school: every route answers 404 for the contract and the staff member', async () => {
    const school = await newSchool();
    const principal = await signIn('principal', school);
    const teacher = await signIn('teacher', school);
    const scan = await stage(principal);
    const c = await created(principal, teacher.user.staffId, fixedTerm('2026-01-01', '2026-12-31', { stagedUploadId: scan }));
    const other = await signIn('principal', await newSchool());

    await get(`/staff/${teacher.user.staffId}/contracts`, other).expect(404);
    expect((await create(other, teacher.user.staffId, { type: 'permanent', startsOn: '2026-01-01' })).status).toBe(404);
    await post(`/staff-contracts/${c.id}/renew`, fixedTerm('2027-01-01', '2027-12-31'), other).expect(404);
    await post(`/staff-contracts/${c.id}/end`, { endedOn: '2026-10-10', reason: 'Probe of another school' }, other).expect(404);
    await get(`/staff-contracts/${c.id}/document`, other).expect(404);
    expect(((await get('/staff-contracts?endsBy=2027-12-31', other).expect(200)).body as PageOf<Contract>).total).toBe(0);
    expect((await row(school, c.id))?.endedAt).toBeNull();
  });
});
