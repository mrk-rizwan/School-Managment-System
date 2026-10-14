// Slice 38 over HTTP (phase-5-extended.md R310-R317; contracts/slice-38.md): drafts, edits and the
// status edges, publish (the invitation and the campaign), the duty scope matrix (rule 32),
// participation, the collection duty's payments with their money identities, cancel with money,
// the report with tagged expenses, the family list and the read filters. The real AppModule; the
// campaign's charges are written by running the charge-run job as the worker does.
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability, ErrorCode, newIdempotencyKey } from '@asms/shared';
import { JobRunner } from '../../src/jobs/job-runner';
import { JOB } from '../../src/messaging/queues';
import { createTestApp } from '../core/app';
import { guardianLogin, studentLogin } from '../diary/support';
import { db, financeSchool, pupil, type Pupil } from '../fees/charges-support';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createTeacherAssignment,
  isoDay,
  type TestSection,
} from '../support/students';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;

type Caller = TestSchoolUser & { cookie: string };

interface EventBody {
  id: string;
  status: string;
  charge: { amount: number; dueOn: string } | null;
  sections: { sectionId: string }[];
  duties: { id: string; staffId: string; duty: string; endedAt: string | null }[];
  myDuties: string[];
  announcementId: string | null;
  cancelAnnouncementId: string | null;
  campaignId: string | null;
  campaignStatus: string | null;
}
interface RosterBody {
  rows: { studentId: string; participation: string | null; charge: { chargeId: string; amount: number; outstanding: number; status: string } | null }[];
}
interface PaymentBody {
  id: string;
  method: string;
  amount: number;
  allocatedAmount: number;
  unallocatedAmount: number;
  recordedByUserId: string;
  payerName: string;
  receipt: { lines: { chargeId: string | null; amount: number }[] } | null;
}
interface ErrorBody {
  error: { code: string; details: (Record<string, unknown> & { fields?: { path: string; code: string }[] }) | null };
}

interface World {
  school: TestSchool;
  principal: Caller;
  office: Caller;
  /** Holds a collection duty on the main event. */
  collector: Caller;
  /** Class teacher of A. */
  classTeacher: Caller;
  outsider: Caller;
  yearId: bigint;
  a: TestSection;
  b: TestSection;
  c: TestSection;
  /** In A, B and C. */
  pa: Pupil;
  pb: Pupil;
  pc: Pupil;
}

describe('slice 38: events and PTM (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const http = () => request(app.getHttpServer());
  const get = (path: string, c: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', c.cookie);
  const post = (path: string, body: object, c: { cookie: string }, key?: string) => {
    const req = http().post(`${API}${path}`).set('Cookie', c.cookie).set('Origin', ORIGIN);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const patch = (path: string, body: object, c: { cookie: string }) =>
    http().patch(`${API}${path}`).set('Cookie', c.cookie).set('Origin', ORIGIN).send(body);
  const err = (res: request.Response) => (res.body as ErrorBody).error;
  const fieldPaths = (res: request.Response) => (err(res).details?.fields ?? []).map((f) => f.path);

  const signIn = async (school: TestSchool, systemRole: 'principal' | 'office_staff' | 'teacher'): Promise<Caller> => {
    const user = await createSchoolUser(db(), school, { systemRole });
    return { ...user, cookie: (await createSchoolSession(db(), school, user)).cookie };
  };

  const grant = (to: TestSchoolUser, by: TestSchoolUser, capability: Capability) =>
    db().userCapabilityGrant.create({
      data: { schoolId: to.schoolId, userId: to.userId, capabilityKey: capability, effect: 'grant', grantedBy: by.userId, reason: 'Test grant' },
    });

  const audit = (school: TestSchool, action: string) =>
    db().auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });

  /** 09:00 in Karachi, `offset` days from today. */
  const at = (offset: number, hour = 9) => `${isoDay(offset)}T${String(hour).padStart(2, '0')}:00:00+05:00`;

  async function world(): Promise<World> {
    const fs = await financeSchool();
    const school = fs.school;
    await db().schoolSettings.updateMany({ where: { schoolId: school.id }, data: { studentLoginEnabled: true } });
    const principal = await signIn(school, 'principal');
    const office = await signIn(school, 'office_staff');
    const collector = await signIn(school, 'teacher');
    const classTeacher = await signIn(school, 'teacher');
    const outsider = await signIn(school, 'teacher');
    const year = await createAcademicYear(db(), school);
    const klass = await createClass(db(), school, year);
    const a = await createSection(db(), school, klass, { name: 'A' });
    const b = await createSection(db(), school, klass, { name: 'B' });
    const c = await createSection(db(), school, klass, { name: 'C' });
    await createTeacherAssignment(db(), school, classTeacher, { role: 'class_teacher', section: a, startsOn: isoDay(-30) });
    const pa = await pupil(school, a, { startedOn: isoDay(-60), fullName: 'Ayesha Khan' });
    const pb = await pupil(school, b, { startedOn: isoDay(-60), fullName: 'Bilal Ahmed' });
    const pc = await pupil(school, c, { startedOn: isoDay(-60), fullName: 'Cyrus Malik' });
    return { school, principal, office, collector, classTeacher, outsider, yearId: year.id, a, b, c, pa, pb, pc };
  }

  const draftBody = (w: World, extra: object = {}) => ({
    academicYearId: w.yearId.toString(),
    type: 'ptm',
    title: 'Parent-teacher meeting',
    startsAt: at(7),
    endsAt: at(7, 12),
    venue: 'School hall',
    details: 'Meet the class teachers.',
    sectionIds: [w.a.id.toString(), w.b.id.toString()],
    ...extra,
  });

  const create = async (w: World, extra: object = {}, by: Caller = w.principal): Promise<EventBody> => {
    const res = await post('/events', draftBody(w, extra), by, newIdempotencyKey());
    if (res.status !== 201) throw new Error(`create refused ${res.status}: ${res.text}`);
    return res.body as EventBody;
  };

  /** Runs the campaign's queued run as the worker does: its charges exist afterwards. */
  const runCampaign = async (w: World, campaignId: string) => {
    const run = await db().chargeRun.findFirstOrThrow({ where: { schoolId: w.school.id, campaignId: BigInt(campaignId) } });
    expect(await app.get(JobRunner, { strict: false }).messaging(JOB.chargeRun, { schoolId: w.school.id.toString(), runId: run.id.toString() })).toBe('done');
  };

  /** A published, charged event with a collection duty for `w.collector` and its charges written. */
  const chargedEvent = async (w: World, amount = 500): Promise<EventBody> => {
    const event = await create(w, { charge: { amount } });
    await post(`/events/${event.id}/duties`, { staffId: w.collector.staffId.toString(), duty: 'collection' }, w.principal).expect(201);
    const published = (await post(`/events/${event.id}/publish`, {}, w.principal).expect(200)).body as EventBody;
    await runCampaign(w, published.campaignId!);
    return published;
  };

  const chargeOf = (w: World, campaignId: string, studentId: bigint) =>
    db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, campaignId: BigInt(campaignId), studentId, kind: 'campaign' } });

  const pay = (w: World, eventId: string, by: Caller, studentId: bigint, amount: number, key = newIdempotencyKey()) =>
    post(`/events/${eventId}/payments`, { studentId: studentId.toString(), amount, receivedOn: isoDay() }, by, key);

  // ---------------------------------------------------------------------- drafts (R310, R316)

  it('R310, R316: a draft is created, replayed, edited while draft and checked; staff without the key never see it', async () => {
    const w = await world();
    const key = newIdempotencyKey();
    const created = await post('/events', draftBody(w), w.principal, key).expect(201);
    const event = created.body as EventBody;
    expect([event.status, event.sections.length, event.charge, event.announcementId, event.campaignId]).toEqual(['draft', 2, null, null, null]);
    const replay = await post('/events', draftBody(w), w.principal, key).expect(200);
    expect([replay.headers['idempotency-replayed'], (replay.body as EventBody).id]).toEqual(['true', event.id]);

    // Checks: a section of another year, a section twice, an end before the start, a start outside the year.
    const otherYear = await createAcademicYear(db(), w.school, { startsOn: isoDay(200), endsOn: isoDay(500), status: 'planned' });
    const otherSection = await createSection(db(), w.school, await createClass(db(), w.school, otherYear));
    const foreign = await post('/events', draftBody(w, { sectionIds: [otherSection.id.toString()] }), w.principal, newIdempotencyKey());
    expect([foreign.status, fieldPaths(foreign)]).toEqual([422, ['sectionIds[0]']]);
    const twice = await post('/events', draftBody(w, { sectionIds: [w.a.id.toString(), w.a.id.toString()] }), w.principal, newIdempotencyKey());
    expect([twice.status, fieldPaths(twice)]).toEqual([422, ['sectionIds[1]']]);
    const backwards = await post('/events', draftBody(w, { endsAt: at(6) }), w.principal, newIdempotencyKey());
    expect([backwards.status, fieldPaths(backwards)]).toEqual([422, ['endsAt']]);
    const outside = await post('/events', draftBody(w, { startsAt: at(400), endsAt: at(400, 12) }), w.principal, newIdempotencyKey());
    expect([outside.status, fieldPaths(outside)]).toEqual([422, ['startsAt']]);
    const noOffset = await post('/events', draftBody(w, { startsAt: `${isoDay(7)}T09:00:00` }), w.principal, newIdempotencyKey());
    expect([noOffset.status, fieldPaths(noOffset)]).toEqual([422, ['startsAt']]);

    // Edit: the sections replaced, the title, a charge set then removed.
    const edited = (await patch(`/events/${event.id}`, { title: 'Annual PTM', sectionIds: [w.c.id.toString()], charge: { amount: 300 } }, w.principal).expect(200))
      .body as EventBody;
    expect([edited.sections.map((s) => s.sectionId), edited.charge?.amount, edited.charge?.dueOn]).toEqual([[w.c.id.toString()], 300, isoDay(7)]);
    const cleared = (await patch(`/events/${event.id}`, { charge: null, sectionIds: [] }, w.principal).expect(200)).body as EventBody;
    expect([cleared.charge, cleared.sections]).toEqual([null, []]);
    expect((await audit(w.school, 'event.created')).length).toBe(1);
    expect((await audit(w.school, 'event.updated')).map((r) => (r.metadata as { fields: string }).fields)).toEqual([
      'title,chargeAmount,chargeDueOn,sectionIds',
      'chargeAmount,chargeDueOn,sectionIds',
    ]);

    // No section: publish refused.
    const empty = await post(`/events/${event.id}/publish`, {}, w.principal);
    expect([empty.status, err(empty).code]).toEqual([409, ErrorCode.EVENT_NO_SECTIONS]);

    // A teacher without holiday.manage: no drafts, no writes.
    expect((await get(`/events/${event.id}`, w.outsider)).status).toBe(404);
    const list = (await get('/events?status=draft', w.outsider).expect(200)).body as { total: number };
    expect(list.total).toBe(0);
    expect((await post('/events', draftBody(w), w.outsider, newIdempotencyKey())).status).toBe(403);
  });

  it('R310: a charge needs both campaign keys and the Event head; the due date is never before today', async () => {
    const w = await world();
    // The office holds charge.create but not charge.campaign.send; given holiday.manage it still may not charge.
    await grant(w.office, w.principal, Capability.HOLIDAY_MANAGE);
    const refused = await post('/events', draftBody(w, { charge: { amount: 500 } }), w.office, newIdempotencyKey());
    expect([refused.status, err(refused).code]).toEqual([403, ErrorCode.PERMISSION_DENIED]);
    await post('/events', draftBody(w), w.office, newIdempotencyKey()).expect(201);
    const past = await post('/events', draftBody(w, { charge: { amount: 500, dueOn: isoDay(-1) } }), w.principal, newIdempotencyKey());
    expect([past.status, fieldPaths(past)]).toEqual([422, ['charge.dueOn']]);
    await db().feeHead.updateMany({ where: { schoolId: w.school.id, category: 'event' }, data: { status: 'archived', archivedAt: new Date(), archivedBy: w.principal.userId, archiveReason: 'Not used' } });
    const noHead = await post('/events', draftBody(w, { charge: { amount: 500 } }), w.principal, newIdempotencyKey());
    expect([noHead.status, fieldPaths(noHead)]).toEqual([422, ['charge']]);
  });

  // ---------------------------------------------------------------------------- publish (R310)

  it('R310: publish writes the invitation to the sections and the campaign (concessions off), and freezes the content', async () => {
    const w = await world();
    const event = await create(w, { charge: { amount: 500 } });
    const published = (await post(`/events/${event.id}/publish`, {}, w.principal).expect(200)).body as EventBody;
    expect([published.status, published.announcementId !== null, published.campaignId !== null, published.campaignStatus]).toEqual([
      'published',
      true,
      true,
      'generating',
    ]);
    const invitation = await db().announcement.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt(published.announcementId!) } });
    expect([invitation.category, invitation.status, invitation.title]).toEqual(['event', 'sending', 'Parent-teacher meeting']);
    expect(invitation.body).toContain('Fee Rs');
    const audiences = await db().announcementAudience.findMany({ where: { schoolId: w.school.id, announcementId: invitation.id }, orderBy: { id: 'asc' } });
    expect(audiences.map((a) => [a.kind, a.sectionId])).toEqual([
      ['section', w.a.id],
      ['section', w.b.id],
    ]);
    const campaign = await db().chargeCampaign.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt(published.campaignId!) } });
    const head = await db().feeHead.findFirstOrThrow({ where: { schoolId: w.school.id, id: campaign.feeHeadId } });
    expect([campaign.applyConcessions, campaign.amount, campaign.dueOn.toISOString().slice(0, 10), head.category]).toEqual([false, 500, isoDay(7), 'event']);
    for (const action of ['event.published', 'charge_campaign.created', 'charge_campaign.generate_requested']) {
      expect((await audit(w.school, action)).length).toBe(1);
    }

    await runCampaign(w, published.campaignId!);
    const charges = await db().charge.findMany({ where: { schoolId: w.school.id, campaignId: campaign.id }, orderBy: { studentId: 'asc' } });
    expect(charges.map((c) => [c.studentId, c.amount])).toEqual([
      [w.pa.studentId, 500],
      [w.pb.studentId, 500],
    ]);
    // GET /charges?campaignId= lists exactly them.
    const listed = (await get(`/charges?campaignId=${campaign.id}`, w.principal).expect(200)).body as { total: number };
    expect(listed.total).toBe(2);

    // Frozen: no edit, no second publish.
    const edit = await patch(`/events/${event.id}`, { title: 'Moved' }, w.principal);
    expect([edit.status, err(edit).code]).toEqual([409, ErrorCode.EVENT_NOT_DRAFT]);
    const again = await post(`/events/${event.id}/publish`, {}, w.principal);
    expect([again.status, err(again).code]).toEqual([409, ErrorCode.EVENT_NOT_DRAFT]);
  });

  // ------------------------------------------------------------------- duty scope matrix (R311)

  it('R311: the duty scope matrix — a duty holder reaches only their event; a class teacher only their section; /payments stays refused', async () => {
    const w = await world();
    const mine = await chargedEvent(w);
    const other = await chargedEvent(w);
    // The collector's duty is on `mine` only: end the one chargedEvent gave them on `other`.
    const otherDuty = (await get(`/events/${other.id}`, w.principal).expect(200)).body as EventBody;
    await post(`/event-duties/${otherDuty.duties[0]!.id}/end`, { reason: 'Moved to the other event' }, w.principal).expect(200);
    // A repeated end answers unchanged and writes nothing; a second live duty of the kind is refused.
    await post(`/event-duties/${otherDuty.duties[0]!.id}/end`, { reason: 'Moved to the other event' }, w.principal).expect(200);
    expect([(await audit(w.school, 'event_duty.added')).length, (await audit(w.school, 'event_duty.ended')).length]).toEqual([2, 1]);
    const twice = await post(`/events/${mine.id}/duties`, { staffId: w.collector.staffId.toString(), duty: 'collection' }, w.principal);
    expect([twice.status, err(twice).code]).toEqual([409, ErrorCode.EVENT_DUTY_EXISTS]);

    const matrix: [string, Caller, string, number][] = [
      ['GET', w.collector, `/events/${mine.id}/participation`, 200],
      ['GET', w.collector, `/events/${other.id}/participation`, 404],
      ['GET', w.classTeacher, `/events/${mine.id}/participation`, 200],
      ['GET', w.outsider, `/events/${mine.id}/participation`, 404],
      ['GET', w.principal, `/events/${mine.id}/participation`, 200],
      ['GET', w.collector, `/events/${mine.id}/payments`, 200],
      ['GET', w.collector, `/events/${other.id}/payments`, 200],
      ['GET', w.outsider, `/events/${mine.id}/payments`, 404],
      ['GET', w.collector, '/payments', 403],
      ['GET', w.collector, `/payments?eventId=${mine.id}`, 403],
      ['GET', w.collector, `/charges?campaignId=${mine.campaignId}`, 403],
      ['GET', w.collector, `/guardians/${w.pa.guardianId}/dues`, 403],
      ['GET', w.collector, `/events/${mine.id}/report`, 403],
    ];
    for (const [, caller, path, status] of matrix) {
      expect([path, (await get(path, caller)).status]).toEqual([path, status]);
    }
    // Payments: the collector on their event only; an outsider never; /payments refused.
    expect((await pay(w, mine.id, w.collector, w.pa.studentId, 100)).status).toBe(201);
    expect((await pay(w, other.id, w.collector, w.pa.studentId, 100)).status).toBe(404);
    expect((await pay(w, mine.id, w.outsider, w.pa.studentId, 100)).status).toBe(404);
    const counter = await post('/payments', { academicYearId: w.yearId.toString(), payerGuardianId: w.pa.guardianId.toString(), studentIds: [w.pa.studentId.toString()], amount: 100, method: 'cash', receivedOn: isoDay() }, w.collector, newIdempotencyKey());
    expect(counter.status).toBe(403);

    // The class teacher sees only A's rows; the collector the whole roster.
    const ct = (await get(`/events/${mine.id}/participation`, w.classTeacher).expect(200)).body as RosterBody;
    expect(ct.rows.map((r) => r.studentId)).toEqual([w.pa.studentId.toString()]);
    const all = (await get(`/events/${mine.id}/participation`, w.collector).expect(200)).body as RosterBody;
    expect(all.rows.map((r) => r.studentId).sort()).toEqual([w.pa.studentId.toString(), w.pb.studentId.toString()].sort());
    const outOfSection = await post(`/events/${mine.id}/record-participation`, { rows: [{ studentId: w.pb.studentId.toString(), status: 'attended' }] }, w.classTeacher);
    expect([outOfSection.status, fieldPaths(outOfSection)]).toEqual([422, ['rows[0].studentId']]);
    const bSection = await get(`/events/${mine.id}/participation?sectionId=${w.b.id}`, w.classTeacher);
    expect(bSection.status).toBe(404);

    // The duty holder sees only their own duty on the event; mine=true lists their events.
    const asCollector = (await get(`/events/${mine.id}`, w.collector).expect(200)).body as EventBody;
    expect([asCollector.duties.length, asCollector.myDuties]).toEqual([1, ['collection']]);
    const listed = (await get('/events?mine=true', w.collector).expect(200)).body as { data: { id: string }[] };
    expect(listed.data.map((e) => e.id)).toEqual([mine.id]);
    const ctListed = (await get('/events?mine=true', w.classTeacher).expect(200)).body as { data: { id: string }[] };
    expect(ctListed.data.map((e) => e.id).sort()).toEqual([mine.id, other.id].sort());
  });

  // ------------------------------------------------------------------------ participation (R312)

  it('security L2 (fix round): roster dues only for the collection duty, an events holder or payment.record', async () => {
    const w = await world();
    const event = await chargedEvent(w);
    // The outsider registers (no money key); the office supervises (payment.record by default).
    await post(`/events/${event.id}/duties`, { staffId: w.outsider.staffId.toString(), duty: 'registration' }, w.principal).expect(201);
    await post(`/events/${event.id}/duties`, { staffId: w.office.staffId.toString(), duty: 'supervision' }, w.principal).expect(201);
    const charges = async (c: Caller) => {
      const body = (await get(`/events/${event.id}/participation`, c).expect(200)).body as RosterBody;
      expect(body.rows.length).toBeGreaterThan(0);
      return body.rows.map((r) => r.charge?.amount ?? null);
    };
    for (const [who, c, sees] of [
      ['collector', w.collector, true],
      ['principal', w.principal, true],
      ['office', w.office, true],
      ['registration officer', w.outsider, false],
      ['class teacher', w.classTeacher, false],
    ] as const) {
      const amounts = await charges(c);
      expect([who, amounts.every((a) => (sees ? a === 500 : a === null))]).toEqual([who, true]);
    }
    // A registration officer's write answers the roster without the money too.
    const recorded = await post(`/events/${event.id}/record-participation`, { rows: [{ studentId: w.pa.studentId.toString(), status: 'attended' }] }, w.outsider);
    expect([recorded.status, (recorded.body as RosterBody).rows.every((r) => r.charge === null)]).toEqual([200, true]);
  });

  it('R312: participation is recorded per student while published, unchanged rows are not rewritten, frozen at completion', async () => {
    const w = await world();
    const event = await create(w);
    await post(`/events/${event.id}/duties`, { staffId: w.collector.staffId.toString(), duty: 'registration' }, w.principal).expect(201);
    const draft = await post(`/events/${event.id}/record-participation`, { rows: [{ studentId: w.pa.studentId.toString(), status: 'attended' }] }, w.collector);
    expect(draft.status).toBe(404);
    await post(`/events/${event.id}/publish`, {}, w.principal).expect(200);

    const body = { rows: [{ studentId: w.pa.studentId.toString(), status: 'attended' }, { studentId: w.pb.studentId.toString(), status: 'absent' }] };
    const first = (await post(`/events/${event.id}/record-participation`, body, w.collector).expect(200)).body as RosterBody;
    expect(first.rows.map((r) => r.participation).sort()).toEqual(['absent', 'attended']);
    await post(`/events/${event.id}/record-participation`, body, w.collector).expect(200);
    expect((await audit(w.school, 'event_participation.recorded')).map((r) => (r.metadata as { changed: number }).changed)).toEqual([2]);
    // Edited in place by the class teacher of A.
    await post(`/events/${event.id}/record-participation`, { rows: [{ studentId: w.pa.studentId.toString(), status: 'excused' }] }, w.classTeacher).expect(200);
    expect(await db().eventParticipation.count({ where: { schoolId: w.school.id, eventId: BigInt(event.id) } })).toBe(2);
    // A student off the roster; a student named twice.
    const off = await post(`/events/${event.id}/record-participation`, { rows: [{ studentId: w.pc.studentId.toString(), status: 'attended' }] }, w.collector);
    expect([off.status, fieldPaths(off)]).toEqual([422, ['rows[0].studentId']]);
    // A holder without a duty reads but does not record.
    expect((await post(`/events/${event.id}/record-participation`, body, w.principal)).status).toBe(403);

    const completed = (await post(`/events/${event.id}/complete`, {}, w.principal).expect(200)).body as EventBody;
    expect(completed.status).toBe('completed');
    expect((await audit(w.school, 'event.completed')).length).toBe(1);
    const frozen = await post(`/events/${event.id}/record-participation`, body, w.collector);
    expect([frozen.status, err(frozen).code]).toEqual([409, ErrorCode.EVENT_NOT_PUBLISHED]);
    const twice = await post(`/events/${event.id}/complete`, {}, w.principal);
    expect([twice.status, err(twice).code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    const cancel = await post(`/events/${event.id}/cancel`, { reason: 'Too late' }, w.principal);
    expect([cancel.status, err(cancel).code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
  });

  // --------------------------------------------------------------------- event payments (R317)

  it('R317: an event payment settles only that child event charge, cash, in the collector custody; remainder and own child refused', async () => {
    const w = await world();
    const event = await chargedEvent(w);
    // A tuition charge for the same child, older: an event payment never touches it.
    const fsHeads = await db().feeHead.findFirstOrThrow({ where: { schoolId: w.school.id, category: 'fine' } });
    const enrolment = await db().enrolment.findFirstOrThrow({ where: { schoolId: w.school.id, studentId: w.pa.studentId } });
    const fine = await db().charge.create({
      data: {
        schoolId: w.school.id, enrolmentId: enrolment.id, studentId: w.pa.studentId, academicYearId: w.yearId, feeHeadId: fsHeads.id,
        headFrequency: 'ad_hoc', kind: 'manual', grossAmount: 300, concessionAmount: 0, amount: 300, description: 'Library fine',
        dueOn: new Date(`${isoDay(-30)}T00:00:00.000Z`), createdBy: w.principal.userId,
      },
    });

    const tooMuch = await pay(w, event.id, w.collector, w.pa.studentId, 501);
    expect([tooMuch.status, err(tooMuch).code, err(tooMuch).details?.outstanding]).toEqual([409, ErrorCode.EVENT_PAYMENT_EXCEEDS_CHARGE, 500]);
    const noCharge = await pay(w, event.id, w.collector, w.pc.studentId, 100);
    expect([noCharge.status, fieldPaths(noCharge)]).toEqual([422, ['studentId']]);

    const key = newIdempotencyKey();
    const res = await pay(w, event.id, w.collector, w.pa.studentId, 200, key);
    expect(res.status).toBe(201);
    const payment = res.body as PaymentBody;
    const charge = await chargeOf(w, event.campaignId!, w.pa.studentId);
    // Σ allocations + unallocated = amount, all of it on the event charge.
    expect([payment.method, payment.amount, payment.allocatedAmount, payment.unallocatedAmount, payment.recordedByUserId]).toEqual([
      'cash', 200, 200, 0, w.collector.userId.toString(),
    ]);
    expect(payment.receipt?.lines.map((l) => [l.chargeId, l.amount])).toEqual([[charge.id.toString(), 200]]);
    expect([charge.allocatedAmount, charge.status]).toEqual([200, 'open']);
    expect((await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: fine.id } })).allocatedAmount).toBe(0);
    const replay = await pay(w, event.id, w.collector, w.pa.studentId, 200, key);
    expect([replay.status, replay.headers['idempotency-replayed'], (replay.body as PaymentBody).id]).toEqual([200, 'true', payment.id]);
    for (const action of ['event_payment.recorded', 'payment.recorded']) expect((await audit(w.school, action)).length).toBe(1);

    // The rest settles it; anything more is refused.
    await pay(w, event.id, w.collector, w.pa.studentId, 300).expect(201);
    const settled = await pay(w, event.id, w.collector, w.pa.studentId, 1);
    expect([settled.status, err(settled).details?.outstanding]).toEqual([409, 0]);

    // Never for the collector's own child (no exception).
    await db().user.updateMany({ where: { schoolId: w.school.id, id: w.collector.userId }, data: { guardianId: w.pb.guardianId } });
    const own = await pay(w, event.id, w.collector, w.pb.studentId, 100);
    expect([own.status, err(own).code]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN]);
    await db().user.updateMany({ where: { schoolId: w.school.id, id: w.collector.userId }, data: { guardianId: null } });

    // Lists: the collector's own rows; the office every row; /payments?eventId= for payment.record.
    await pay(w, event.id, w.office, w.pb.studentId, 100).expect(201);
    const own2 = (await get(`/events/${event.id}/payments`, w.collector).expect(200)).body as { total: number };
    const all = (await get(`/events/${event.id}/payments`, w.office).expect(200)).body as { total: number };
    const filtered = (await get(`/payments?eventId=${event.id}`, w.office).expect(200)).body as { total: number };
    expect([own2.total, all.total, filtered.total]).toEqual([2, 3, 3]);

    // Custody and handover as Phase 3: the collector hands over 500 without payment.record.
    const custody = (await get('/me/staff/custody', w.collector).expect(200)).body as { cashInHand: number };
    expect(custody.cashInHand).toBe(500);
    const handover = (await post('/me/staff/cash-handovers', {}, w.collector).expect(201)).body as { expectedAmount: number };
    expect(handover.expectedAmount).toBe(500);
    expect((await post('/me/staff/cash-handovers', {}, w.outsider)).status).toBe(403);
  });

  it("R317 (fix round): the event receipt's balance is the child's whole year, arrears included", async () => {
    const w = await world();
    const event = await chargedEvent(w);
    const fineHead = await db().feeHead.findFirstOrThrow({ where: { schoolId: w.school.id, category: 'fine' } });
    const enrolment = await db().enrolment.findFirstOrThrow({ where: { schoolId: w.school.id, studentId: w.pa.studentId } });
    await db().charge.create({
      data: {
        schoolId: w.school.id, enrolmentId: enrolment.id, studentId: w.pa.studentId, academicYearId: w.yearId, feeHeadId: fineHead.id,
        headFrequency: 'ad_hoc', kind: 'manual', grossAmount: 1300, concessionAmount: 0, amount: 1300, description: 'Arrears',
        dueOn: new Date(`${isoDay(-30)}T00:00:00.000Z`), createdBy: w.principal.userId,
      },
    });
    // Pays the whole trip: the event charge is settled, the 1,300 arrears still owe.
    await pay(w, event.id, w.collector, w.pa.studentId, 500).expect(201);
    const [message] = await db().message.findMany({ where: { schoolId: w.school.id, type: 'receipt_issued' } });
    expect(message?.body).toContain('Balance for');
    expect(message?.body).toContain('Rs 1,300.');
  });

  // ------------------------------------------------------------------------ cancel (R313)

  it('R313: cancel voids unpaid charges, credits a part-paid one (its money the child advance), needs the principal, and sends a notice', async () => {
    const w = await world();
    const event = await chargedEvent(w);
    await pay(w, event.id, w.collector, w.pa.studentId, 200).expect(201);

    // A holder with charge.create who is not the principal: refused, nothing written.
    await grant(w.office, w.principal, Capability.HOLIDAY_MANAGE);
    const notPrincipal = await post(`/events/${event.id}/cancel`, { reason: 'Rain' }, w.office);
    expect([notPrincipal.status, err(notPrincipal).details?.reason]).toEqual([403, 'principal_required']);
    expect((await chargeOf(w, event.campaignId!, w.pb.studentId)).status).toBe('open');

    const cancelled = (await post(`/events/${event.id}/cancel`, { reason: 'Rain' }, w.principal).expect(200)).body as EventBody;
    expect([cancelled.status, cancelled.cancelAnnouncementId !== null, cancelled.campaignStatus]).toEqual(['cancelled', true, 'cancelled']);
    const unpaid = await chargeOf(w, event.campaignId!, w.pb.studentId);
    expect([unpaid.status, unpaid.voidReason]).toEqual(['voided', 'Rain']);
    const paid = await chargeOf(w, event.campaignId!, w.pa.studentId);
    expect([paid.status, paid.allocatedAmount, paid.creditedAmount]).toEqual(['settled', 0, 500]);
    // The 200 paid is now the child's advance; no cash moved; the payment's identity holds.
    const payment = await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id, recordedBy: w.collector.userId } });
    const live = await db().paymentAllocation.aggregate({ where: { schoolId: w.school.id, paymentId: payment.id, reversedAt: null }, _sum: { amount: true } });
    expect([payment.amount, payment.unallocatedAmount, payment.advanceForStudentId, payment.status, live._sum.amount ?? 0]).toEqual([
      200, 200, w.pa.studentId, 'verified', 0,
    ]);
    const notice = await db().announcement.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt(cancelled.cancelAnnouncementId!) } });
    expect([notice.category, notice.title]).toEqual(['event', 'Cancelled: Parent-teacher meeting']);
    for (const action of ['event.cancelled', 'charge.voided', 'charge.adjusted', 'charge_campaign.cancelled']) {
      expect([action, (await audit(w.school, action)).length]).toEqual([action, 1]);
    }
    // Final: no second cancel, no payment.
    const again = await post(`/events/${event.id}/cancel`, { reason: 'Rain' }, w.principal);
    expect([again.status, err(again).code]).toEqual([409, ErrorCode.ILLEGAL_STATUS_TRANSITION]);
    const late = await pay(w, event.id, w.collector, w.pa.studentId, 100);
    expect([late.status, err(late).code]).toEqual([409, ErrorCode.EVENT_NOT_PUBLISHED]);

    // A draft cancels with no notice; an unpaid charged event needs no principal.
    const draft = await create(w);
    const plain = (await post(`/events/${draft.id}/cancel`, { reason: 'Not needed' }, w.office).expect(200)).body as EventBody;
    expect([plain.status, plain.cancelAnnouncementId]).toEqual(['cancelled', null]);
  });

  it('R313 (fix round): a paid late fee on an event charge is credited on cancel (its money the advance) and needs the principal', async () => {
    const w = await world();
    const event = await chargedEvent(w);
    const target = await chargeOf(w, event.campaignId!, w.pb.studentId);
    const fineHead = await db().feeHead.findFirstOrThrow({ where: { schoolId: w.school.id, category: 'fine' } });
    const fee = await db().charge.create({
      data: {
        schoolId: w.school.id, enrolmentId: target.enrolmentId, studentId: w.pb.studentId, academicYearId: w.yearId, feeHeadId: fineHead.id,
        headFrequency: 'ad_hoc', kind: 'late_fee', lateFeeForChargeId: target.id, period: isoDay().slice(0, 7), grossAmount: 100,
        concessionAmount: 0, amount: 100, description: 'Late fee', dueOn: new Date(`${isoDay(-30)}T00:00:00.000Z`), createdBy: w.principal.userId,
      },
    });
    // The counter pays the oldest first: the late fee, in full; the event charge is untouched.
    const paid = await post(
      '/payments',
      { academicYearId: w.yearId.toString(), payerGuardianId: w.pb.guardianId.toString(), studentIds: [w.pb.studentId.toString()], amount: 100, method: 'cash', receivedOn: isoDay() },
      w.office,
      newIdempotencyKey(),
    );
    expect(paid.status).toBe(201);
    const before = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: fee.id } });
    expect([before.status, before.allocatedAmount, (await chargeOf(w, event.campaignId!, w.pb.studentId)).allocatedAmount]).toEqual(['settled', 100, 0]);

    // Money only on the late fee still needs the principal; nothing is written.
    await grant(w.office, w.principal, Capability.HOLIDAY_MANAGE);
    const notPrincipal = await post(`/events/${event.id}/cancel`, { reason: 'Rain' }, w.office);
    expect([notPrincipal.status, err(notPrincipal).details?.reason]).toEqual([403, 'principal_required']);
    expect((await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: fee.id } })).creditedAmount).toBe(0);

    await post(`/events/${event.id}/cancel`, { reason: 'Rain' }, w.principal).expect(200);
    const after = await db().charge.findFirstOrThrow({ where: { schoolId: w.school.id, id: fee.id } });
    expect([after.status, after.allocatedAmount, after.creditedAmount]).toEqual(['settled', 0, 100]);
    expect((await chargeOf(w, event.campaignId!, w.pb.studentId)).status).toBe('voided');
    const payment = await db().payment.findFirstOrThrow({ where: { schoolId: w.school.id, id: BigInt((paid.body as PaymentBody).id) } });
    expect([payment.unallocatedAmount, payment.advanceForStudentId]).toEqual([100, w.pb.studentId]);
    // Two charges voided (A's and B's event charges), one credited (the late fee).
    const [cancelled] = await audit(w.school, 'event.cancelled');
    expect([(cancelled?.metadata as { voided: number }).voided, (cancelled?.metadata as { credited: number }).credited]).toEqual([2, 1]);
  });

  // ---------------------------------------------------------------- report and tags (R314)

  it('R314: the report counts live allocations and the recorded or approved expenses tagged, a late bill too', async () => {
    const w = await world();
    const event = await chargedEvent(w);
    await pay(w, event.id, w.collector, w.pa.studentId, 500).expect(201);
    await pay(w, event.id, w.office, w.pb.studentId, 150).expect(201);
    await post(`/events/${event.id}/record-participation`, { rows: [{ studentId: w.pa.studentId.toString(), status: 'attended' }] }, w.collector).expect(200);

    const expense = async (amount: number) => {
      const res = await post('/expenses', { category: 'other', amount, spentOn: isoDay(), description: 'Tea and snacks', method: 'cash' }, w.office, newIdempotencyKey());
      if (res.status !== 201) throw new Error(`expense refused ${res.status}: ${res.text}`);
      return (res.body as { id: string }).id;
    };
    const small = await expense(1000);
    const voided = await expense(800);
    await post(`/expenses/${voided}/void`, { reason: 'Entered twice' }, w.office).expect(200);
    const big = await expense(9000); // above the threshold: pending approval, not counted

    const tagged = (await post(`/expenses/${small}/tag-event`, { eventId: event.id }, w.office).expect(200)).body as { eventId: string };
    expect(tagged.eventId).toBe(event.id);
    await post(`/expenses/${small}/tag-event`, { eventId: event.id }, w.office).expect(200);
    await post(`/expenses/${big}/tag-event`, { eventId: event.id }, w.office).expect(200);
    const stale = await post(`/expenses/${voided}/tag-event`, { eventId: event.id }, w.office);
    expect([stale.status, err(stale).code]).toEqual([409, ErrorCode.STALE_STATUS]);
    const draft = await create(w);
    const draftTag = await post(`/expenses/${await expense(100)}/tag-event`, { eventId: draft.id }, w.office);
    expect([draftTag.status, err(draftTag).code]).toEqual([409, ErrorCode.EVENT_NOT_PUBLISHED]);
    const moved = await post(`/expenses/${small}/tag-event`, { eventId: draft.id }, w.office);
    expect([moved.status, err(moved).code]).toEqual([409, ErrorCode.EXPENSE_EVENT_TAGGED]);
    expect((await audit(w.school, 'expense.event_tagged')).length).toBe(2);
    const byEvent = (await get(`/expenses?eventId=${event.id}`, w.office).expect(200)).body as { total: number };
    expect(byEvent.total).toBe(2);

    type Report = { participants: Record<string, number>; collections: Record<string, number>; expenses: { count: number; total: number }; net: number };
    const report = (await get(`/events/${event.id}/report`, w.principal).expect(200)).body as Report;
    expect(report.participants).toEqual({ roster: 2, attended: 1, absent: 0, excused: 0, unrecorded: 1 });
    expect(report.collections).toEqual({ chargeCount: 2, charged: 1000, collected: 650, outstanding: 350 });
    expect([report.expenses, report.net]).toEqual([{ count: 1, total: 1000 }, -350]);

    // A late bill tagged after completion appears.
    await post(`/events/${event.id}/complete`, {}, w.principal).expect(200);
    const late = await expense(400);
    await post(`/expenses/${late}/tag-event`, { eventId: event.id }, w.office).expect(200);
    const after = (await get(`/events/${event.id}/report`, w.principal).expect(200)).body as Report;
    expect([after.expenses, after.net]).toEqual([{ count: 2, total: 1400 }, -750]);
    // A draft has no report.
    const none = await get(`/events/${draft.id}/report`, w.principal);
    expect([none.status, err(none).code]).toEqual([409, ErrorCode.EVENT_NOT_PUBLISHED]);
  });

  // ------------------------------------------------------------------------------ family (R315)

  it("R315: a family sees published events of its child's sections, with the child's own charge only", async () => {
    const w = await world();
    const event = await chargedEvent(w);
    await create(w); // a draft of the same sections: never shown
    await db().studentGuardian.updateMany({ where: { schoolId: w.school.id }, data: { canLogin: true } });
    const parentA = await guardianLogin(db(), w.school, { id: w.pa.guardianId, cnic: null });
    const parentC = await guardianLogin(db(), w.school, { id: w.pc.guardianId, cnic: null });
    await pay(w, event.id, w.collector, w.pa.studentId, 200).expect(201);

    type Mine = { total: number; data: { id: string; charge: { amount: number; outstanding: number } | null }[] };
    const a = (await get(`/me/children/${w.pa.studentId}/events`, parentA).expect(200)).body as Mine;
    expect(a.data.map((e) => [e.id, e.charge])).toEqual([[event.id, { amount: 500, outstanding: 300, status: 'open' }]]);
    expect(Object.keys(a.data[0]!)).not.toContain('duties');
    const c = (await get(`/me/children/${w.pc.studentId}/events`, parentC).expect(200)).body as Mine;
    expect(c.total).toBe(0);
    // Another family's child is 404.
    expect((await get(`/me/children/${w.pa.studentId}/events`, parentC)).status).toBe(404);
    // The student's own login.
    const studentRow = await db().student.findFirstOrThrow({ where: { schoolId: w.school.id, id: w.pb.studentId } });
    const student = await studentLogin(db(), w.school, { id: studentRow.id, bForm: null });
    const own = (await get('/me/student/events', student).expect(200)).body as Mine;
    expect(own.data.map((e) => [e.id, e.charge?.outstanding])).toEqual([[event.id, 500]]);
  });
});
