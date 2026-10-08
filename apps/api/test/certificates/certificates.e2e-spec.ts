// Slice 34: certificates (phase-4-academic.md §1.1 rule 29, §7.1, R289-R293; contracts/slice-34.md).
// Numbers per type, gapless under concurrent issues; the leaving certificate's status and dues
// gates; bodies as snapshots; the B-Form only in the leaving print view, audited; voids by a
// principal only; the register; isolation through the repository; and R16 over every response,
// log line, body and audit row of the file. The real AppModule and database.
import { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import type request from 'supertest';
import { newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { randomIdentityDigits } from '../support/school-session';
import { closeTestDb, testDb } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createGuardian,
  createSection,
  createStudent,
  enrol,
  isoDay,
  linkGuardian,
} from '../support/students';
import { reportsHttp, type ReportsWorld } from '../finance-reports/support';
import { ORIGIN } from '../payments/payments-support';

interface Certificate {
  id: string;
  studentId: string;
  studentName: string;
  type: string;
  number: number;
  label: string;
  issueNo: number;
  reissueOfId: string | null;
  academicYearId: string | null;
  title: string;
  duesStatus: string;
  reason: string | null;
  issuedOn: string;
  issuedByName: string;
  printedCount: number;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  body?: {
    studentName: string;
    fatherName: string | null;
    className: string | null;
    sectionName: string | null;
    academicYearName: string | null;
    attendedTo: string | null;
    enrolments: unknown[];
    conduct: string | null;
    signatoryName: string;
  };
}

const PATTERN = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
const dashed = (d: string) => `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;

describe('slice 34: certificates (e2e)', () => {
  let app: NestExpressApplication;
  const logs: string[] = [];
  const bodies: string[] = [];
  const used: string[] = [];
  const h = reportsHttp(() => app);
  const db = testDb;

  /** Records every response's text for the R16 scan at the end of the file. */
  const keep = (req: request.Test): request.Test => req.on('response', (res: request.Response) => void bodies.push(res.text));
  const get = (path: string, by: { cookie: string }) => keep(h.get(path, by));
  const post = (path: string, body: object, by: { cookie: string }, key?: string) => keep(h.post(path, body, by, key));
  const issue = (studentId: bigint, body: object, by: { cookie: string }, key = newIdempotencyKey()) =>
    post(`/students/${studentId}/certificates`, body, by, key);
  const cert = (res: request.Response) => res.body as Certificate;
  const settingsPatch = (w: ReportsWorld, body: object) =>
    keep(h.http().patch('/api/v1/school/settings').set('Cookie', w.principal.cookie).set('Origin', ORIGIN).send(body));

  /** A withdrawn student with a known B-Form, a father, and an enrolment in the world's section. */
  async function leaver(w: ReportsWorld, opts: { left?: boolean; fullName?: string } = {}) {
    const bForm = randomIdentityDigits();
    used.push(bForm);
    const student = await createStudent(db(), w.school, {
      bForm,
      fullName: opts.fullName ?? 'Ayesha Siddiqui',
      gender: 'female',
      admittedOn: w.year.startsOn,
      status: opts.left === false ? 'active' : 'withdrawn',
    });
    const father = await createGuardian(db(), w.school, { fullName: 'Imran Siddiqui', cnic: null });
    await linkGuardian(db(), w.school, student, { id: father.id }, { relationship: 'father' });
    await enrol(db(), w.school, student, w.section, {
      startedOn: w.year.startsOn,
      ...(opts.left === false ? {} : { status: 'left', endedOn: isoDay(-1) }),
    });
    return { studentId: student.id, bForm };
  }

  beforeAll(async () => {
    app = await createTestApp({ logStream: { write: (line: string) => void logs.push(line) } });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R289: numbers are gapless per type under concurrent issues; a void never frees one; a reissue keeps it with issueNo + 1 and prints DUPLICATE', async () => {
    const w = await h.world();
    // Two issues at once from two clerks: the counter's row lock orders them, no gap, no clash.
    const [one, two] = await Promise.all([
      issue(w.a.studentId, { type: 'character', conduct: 'Good' }, w.office),
      issue(w.b.studentId, { type: 'character', conduct: 'Good' }, w.principal),
    ]);
    expect([one?.status, two?.status]).toEqual([201, 201]);
    expect([cert(one).number, cert(two).number].sort()).toEqual([1, 2]);
    expect([cert(one).label, cert(two).label].sort()).toEqual(['CC-0001', 'CC-0002']);
    // Another type has its own sequence (an academic certificate needs a published result since
    // wave P, test/results/report-cards.e2e-spec.ts; `other` stands in here).
    const sports = cert((await issue(w.a.studentId, { type: 'other', title: 'Sports Certificate' }, w.office).expect(201)));
    expect([sports.label, sports.issueNo, sports.duesStatus]).toEqual(['OC-0001', 1, 'not_required']);

    // A void keeps the number: the next character certificate is 3.
    await post(`/certificates/${cert(two).id}/void`, { reason: 'Issued in error' }, w.principal).expect(200);
    const three = cert((await issue(w.c.studentId, { type: 'character' }, w.office).expect(201)));
    expect(three.label).toBe('CC-0003');

    // A reissue: same number, issue 2, the original named, DUPLICATE on the print.
    const original = cert(one);
    const again = cert(
      (await post(`/certificates/${original.id}/reissue`, { reason: 'Original lost by the family' }, w.office, newIdempotencyKey()).expect(201)),
    );
    expect([again.label, again.issueNo, again.reissueOfId, again.studentId, again.reason]).toEqual([
      original.label,
      2,
      original.id,
      original.studentId,
      'Original lost by the family',
    ]);
    const page = (await get(`/certificates/${again.id}/print`, w.office).expect(200)).text;
    expect(page).toContain('DUPLICATE');
    expect(page).toContain(original.label);
    expect((await get(`/certificates/${original.id}/print`, w.office).expect(200)).text).not.toContain('DUPLICATE');
    // A reissue of the reissue is issue 3.
    const third = cert((await post(`/certificates/${again.id}/reissue`, { reason: 'Lost again' }, w.office, newIdempotencyKey()).expect(201)));
    expect([third.label, third.issueNo]).toEqual([original.label, 3]);

    const [issued] = await h.audit(w.school, 'certificate.reissued');
    expect([issued?.subjectType, issued?.subjectId?.toString(), issued?.reason]).toEqual(['certificate', again.id, 'Original lost by the family']);
    expect(await h.audit(w.school, 'certificate.issued')).toHaveLength(4);
  });

  it('a keyed issue replays: same key and body → 200 Idempotency-Replayed with the same certificate; another body → 409', async () => {
    const w = await h.world();
    const key = newIdempotencyKey();
    const first = (await issue(w.a.studentId, { type: 'character' }, w.office, key).expect(201));
    const replay = (await issue(w.a.studentId, { type: 'character' }, w.office, key).expect(200));
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(cert(replay).id).toBe(cert(first).id);
    expect(h.err((await issue(w.a.studentId, { type: 'academic' }, w.office, key).expect(409))).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await issue(w.a.studentId, { type: 'character' }, w.office, 'short').then((r) => r.status === 422 || Promise.reject(new Error('key not refused')));
    expect(await h.audit(w.school, 'certificate.issued')).toHaveLength(1);
  });

  it('R290: the leaving certificate needs a student who left, and dues cleared or overridden; dues_status records which', async () => {
    const w = await h.world();
    // Hamza is still active: refused before dues are read.
    const notLeft = (await issue(w.a.studentId, { type: 'leaving' }, w.office).expect(409));
    expect(h.err(notLeft).error).toEqual(
      expect.objectContaining({ code: 'CERTIFICATE_STUDENT_NOT_LEFT', details: { studentId: w.a.studentId.toString() } }),
    );
    // Withdrawn through the status route; he still owes this year's 3,000.
    await post(`/students/${w.a.studentId}/change-status`, { status: 'withdrawn', reason: 'Family moved to Lahore', effectiveOn: isoDay(0) }, w.office).expect(200);
    const blocked = (await issue(w.a.studentId, { type: 'leaving' }, w.office).expect(409));
    expect(h.err(blocked).error).toEqual(expect.objectContaining({ code: 'CERTIFICATE_DUES_BLOCK', details: { outstanding: 3000 } }));
    expect(await h.audit(w.school, 'certificate.issued')).toHaveLength(0);

    // The principal overrides (slice 22): the certificate issues, recording the override.
    await post(`/students/${w.a.studentId}/dues-clearance/override`, { reason: 'Leaving for abroad' }, w.principal).expect(200);
    const overridden = cert((await issue(w.a.studentId, { type: 'leaving', conduct: 'Good' }, w.office).expect(201)));
    expect([overridden.label, overridden.duesStatus, overridden.reason]).toEqual(['LC-0001', 'override', 'Leaving for abroad']);

    // Hira pays and transfers: cleared.
    await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.b.studentId], amount: 3000 });
    await post(`/students/${w.b.studentId}/change-status`, { status: 'transferred', reason: 'Joining another school', effectiveOn: isoDay(0) }, w.office).expect(200);
    const cleared = cert((await issue(w.b.studentId, { type: 'leaving' }, w.office).expect(201)));
    expect([cleared.label, cleared.duesStatus, cleared.reason]).toEqual(['LC-0002', 'cleared', null]);
    const [row] = await h.audit(w.school, 'certificate.issued');
    expect(row?.metadata).toEqual(expect.objectContaining({ type: 'leaving', label: 'LC-0001', duesStatus: 'override' }));
    expect(row?.reason).toBe('Leaving for abroad');

    // Other types never read dues: an active student who owes gets a character certificate.
    expect(cert((await issue(w.c.studentId, { type: 'character' }, w.office).expect(201))).duesStatus).toBe('not_required');
  });

  it('R291: bodies are snapshots; a reissue copies the original; a certificate for a student who left in a closed year prints', async () => {
    const w = await h.world();
    const s = await leaver(w);
    const issued = cert((await issue(s.studentId, { type: 'leaving', conduct: 'Excellent', remarks: 'A diligent student' }, w.office).expect(201)));
    expect(issued.body).toEqual(
      expect.objectContaining({
        studentName: 'Ayesha Siddiqui',
        fatherName: 'Imran Siddiqui',
        className: expect.any(String),
        sectionName: expect.any(String),
        attendedTo: isoDay(-1),
        conduct: 'Excellent',
      }),
    );
    expect(issued.body?.enrolments).toHaveLength(1);
    // The signatory defaulted to the active principal's name at this first issue (§1.1).
    const settings = (await get('/school/settings', w.principal).expect(200)).body as { certificateSignatoryName: string | null };
    expect(settings.certificateSignatoryName).not.toBeNull();
    expect(issued.body?.signatoryName).toBe(settings.certificateSignatoryName);
    // The default is a settings change like any other: audited as PATCH /school/settings is.
    const defaulted = await h.audit(w.school, 'school_settings.updated');
    expect(defaulted).toHaveLength(1);
    expect(defaulted[0]?.metadata).toEqual({
      changes: { certificateSignatoryName: { from: null, to: settings.certificateSignatoryName } },
    });
    expect(defaulted[0]?.actorUserId).not.toBeNull();
    expect(((await h.audit(w.school, 'certificate.issued'))[0]?.metadata as { signatoryDefaulted: boolean }).signatoryDefaulted).toBe(true);

    // A later rename changes nothing issued; the reissue carries the body as issued.
    await db().student.updateMany({ where: { schoolId: w.school.id, id: s.studentId }, data: { fullName: 'Ayesha Khan' } });
    const read = cert((await get(`/certificates/${issued.id}`, w.office).expect(200)));
    expect([read.body?.studentName, read.studentName]).toEqual(['Ayesha Siddiqui', 'Ayesha Khan']);
    const reissued = cert((await post(`/certificates/${issued.id}/reissue`, { reason: 'Damaged copy' }, w.office, newIdempotencyKey()).expect(201)));
    expect(reissued.body).toEqual(issued.body);
    expect(reissued.duesStatus).toBe(issued.duesStatus);
    expect((await get(`/certificates/${reissued.id}/print`, w.office).expect(200)).text).toContain('Ayesha Siddiqui');

    // A student who left years ago, in a closed year: named explicitly, and it prints.
    const old = await createAcademicYear(db(), w.school, { name: 'Session 2023-24', startsOn: isoDay(-900), endsOn: isoDay(-560), status: 'closed' });
    const oldClass = await createClass(db(), w.school, old);
    const oldSection = await createSection(db(), w.school, oldClass);
    const alumnus = await createStudent(db(), w.school, { admittedOn: isoDay(-900), status: 'alumni', fullName: 'Bilal Ahmed' });
    await enrol(db(), w.school, alumnus, oldSection, { startedOn: isoDay(-900), status: 'completed', endedOn: isoDay(-560) });
    const past = cert(
      (await issue(alumnus.id, { type: 'leaving', academicYearId: old.id.toString() }, w.office).expect(201)),
    );
    expect([past.academicYearId, past.duesStatus, past.body?.academicYearName]).toEqual([old.id.toString(), 'cleared', 'Session 2023-24']);
    const printed = (await get(`/certificates/${past.id}/print`, w.office).expect(200)).text;
    expect(printed).toContain('Bilal Ahmed');
    expect(printed).toContain('Completed the final class');
    // A year the student was never in is refused.
    const wrongYear = (await issue(alumnus.id, { type: 'character', academicYearId: w.year.id.toString() }, w.office).expect(422));
    expect(h.err(wrongYear).error.details?.fields?.[0]).toEqual(expect.objectContaining({ path: 'academicYearId', code: 'REFERENCE_NOT_FOUND' }));
  });

  it('R292: the B-Form prints only on a non-voided leaving certificate with the setting on, audited with identityPrinted; never in JSON', async () => {
    const w = await h.world();
    const s = await leaver(w);
    const leaving = cert((await issue(s.studentId, { type: 'leaving' }, w.office).expect(201)));
    const character = cert((await issue(s.studentId, { type: 'character' }, w.office).expect(201)));

    const page = await get(`/certificates/${leaving.id}/print`, w.office).expect(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.text).toContain(dashed(s.bForm));
    expect(page.text).not.toMatch(/<script/i);
    expect((await get(`/certificates/${character.id}/print`, w.office).expect(200)).text).not.toContain(dashed(s.bForm));

    // The setting off: no number on the leaving certificate either.
    await settingsPatch(w, { certificateShowIdentityNo: false }).expect(200);
    expect((await get(`/certificates/${leaving.id}/print`, w.office).expect(200)).text).not.toContain(dashed(s.bForm));
    await settingsPatch(w, { certificateShowIdentityNo: true }).expect(200);

    // Voided: no number, and the page says VOID.
    await post(`/certificates/${leaving.id}/void`, { reason: 'Wrong class printed' }, w.principal).expect(200);
    const voidPage = (await get(`/certificates/${leaving.id}/print`, w.office).expect(200)).text;
    expect(voidPage).toContain('VOID');
    expect(voidPage).not.toContain(dashed(s.bForm));

    const printed = await h.audit(w.school, 'certificate.printed');
    expect(printed.map((r) => (r.metadata as { identityPrinted: boolean }).identityPrinted)).toEqual([true, false, false, false]);
    expect(printed[0]?.metadata).toEqual({ certificateId: leaving.id, issueNo: 1, identityPrinted: true });
    expect(cert(await get(`/certificates/${leaving.id}`, w.office)).printedCount).toBe(3);
    // No JSON route carries it.
    for (const path of [`/certificates/${leaving.id}`, `/certificates?studentId=${s.studentId}`, `/students/${s.studentId}/certificates`]) {
      const res = await get(path, w.office).expect(200);
      expect(res.text).not.toMatch(PATTERN);
    }
  });

  it('R293: only a principal voids; voided rows are listed as such; a voided certificate cannot be voided again or reissued', async () => {
    const w = await h.world();
    const c = cert((await issue(w.a.studentId, { type: 'character' }, w.office).expect(201)));
    const refused = (await post(`/certificates/${c.id}/void`, { reason: 'Issued in error' }, w.office).expect(403));
    expect(h.err(refused).error.details).toEqual({ reason: 'principal_required' });
    await post(`/certificates/${c.id}/void`, { reason: 'x' }, w.principal).expect(422);
    const voided = cert((await post(`/certificates/${c.id}/void`, { reason: 'Issued in error' }, w.principal).expect(200)));
    expect([voided.voidedAt !== null, voided.voidReason, voided.voidedByName !== null]).toEqual([true, 'Issued in error', true]);
    expect(h.err((await post(`/certificates/${c.id}/void`, { reason: 'Again' }, w.principal).expect(409))).error.code).toBe('CERTIFICATE_VOIDED');
    expect(
      h.err((await post(`/certificates/${c.id}/reissue`, { reason: 'Lost' }, w.office, newIdempotencyKey()).expect(409))).error,
    ).toEqual(expect.objectContaining({ code: 'CERTIFICATE_VOIDED', details: { certificateId: c.id } }));
    const [audit] = await h.audit(w.school, 'certificate.voided');
    expect([audit?.subjectId?.toString(), audit?.reason]).toEqual([c.id, 'Issued in error']);

    const valid = cert((await issue(w.a.studentId, { type: 'character' }, w.office).expect(201)));
    const list = (q: string) => (get(`/certificates${q}`, w.office)).then((r) => (r.body as { data: Certificate[]; total: number }));
    expect((await list('?voided=true')).data.map((x) => x.id)).toEqual([c.id]);
    expect((await list('?voided=false')).data.map((x) => x.id)).toEqual([valid.id]);
    const all = await list('');
    expect(all.data.map((x) => x.id)).toEqual([valid.id, c.id]);
    expect(all.data[1]?.voidedAt).not.toBeNull();
    expect((await list('?type=leaving')).total).toBe(0);
    expect((await list(`?issuedFrom=${isoDay(1)}`)).total).toBe(0);
    // The student's list: summaries, no body.
    const mine = (await get(`/students/${w.a.studentId}/certificates`, w.office).expect(200)).body as { data: Certificate[] };
    expect(mine.data.map((x) => [x.id, x.body])).toEqual([
      [valid.id, undefined],
      [c.id, undefined],
    ]);
    // Wave N review: the summary carries no dues status and no reason (a student.view reader).
    for (const row of mine.data) {
      expect(row).not.toHaveProperty('duesStatus');
      expect(row).not.toHaveProperty('reason');
    }
  });

  it('wave N review: voiding any issue voids the number; a voided number is never reissued; the audit lists the issues', async () => {
    const w = await h.world();
    const original = cert((await issue(w.a.studentId, { type: 'character' }, w.office).expect(201)));
    const duplicate = cert(
      (await post(`/certificates/${original.id}/reissue`, { reason: 'Lost by the family' }, w.office, newIdempotencyKey()).expect(201)),
    );
    const other = cert((await issue(w.b.studentId, { type: 'character' }, w.office).expect(201)));
    // Voiding the original voids the duplicate in the same statement.
    await post(`/certificates/${original.id}/void`, { reason: 'Issued to the wrong student' }, w.principal).expect(200);
    const dup = cert(await get(`/certificates/${duplicate.id}`, w.office).expect(200));
    expect([dup.voidedAt !== null, dup.voidReason]).toEqual([true, 'Issued to the wrong student']);
    expect(cert(await get(`/certificates/${other.id}`, w.office).expect(200)).voidedAt).toBeNull();
    const [audit] = await h.audit(w.school, 'certificate.voided');
    expect(audit?.metadata).toEqual({ label: original.label, issueNo: 1, issueNos: '1, 2' });
    expect(await h.audit(w.school, 'certificate.voided')).toHaveLength(1);
    // Neither issue can be reissued or voided again.
    for (const id of [original.id, duplicate.id]) {
      const again = await post(`/certificates/${id}/reissue`, { reason: 'Lost' }, w.office, newIdempotencyKey()).expect(409);
      expect(h.err(again).error).toEqual(expect.objectContaining({ code: 'CERTIFICATE_VOIDED', details: { certificateId: id } }));
      await post(`/certificates/${id}/void`, { reason: 'Again' }, w.principal).expect(409);
    }
    // A void through the duplicate stamps the original too.
    const second = cert((await issue(w.c.studentId, { type: 'other', title: 'Debate Certificate' }, w.office).expect(201)));
    const secondDup = cert((await post(`/certificates/${second.id}/reissue`, { reason: 'Damaged' }, w.office, newIdempotencyKey()).expect(201)));
    await post(`/certificates/${secondDup.id}/void`, { reason: 'Wrong year' }, w.principal).expect(200);
    expect(cert(await get(`/certificates/${second.id}`, w.office).expect(200)).voidedAt).not.toBeNull();
    const voids = await h.audit(w.school, 'certificate.voided');
    expect(voids.map((r) => r.metadata)).toContainEqual({ label: second.label, issueNo: 2, issueNos: '1, 2' });
  });

  it('wave N review: a cross-site browser request for a print view is 403 ORIGIN_REJECTED; same-origin and a typed address print', async () => {
    const w = await h.world();
    const c = cert((await issue(w.a.studentId, { type: 'character' }, w.office).expect(201)));
    for (const site of ['cross-site', 'same-site']) {
      const refused = await get(`/certificates/${c.id}/print`, w.office).set('Sec-Fetch-Site', site).expect(403);
      expect(h.err(refused).error.code).toBe('ORIGIN_REJECTED');
    }
    for (const site of ['same-origin', 'none']) await get(`/certificates/${c.id}/print`, w.office).set('Sec-Fetch-Site', site).expect(200);
    // Refused before the print is counted or audited.
    expect(cert(await get(`/certificates/${c.id}`, w.office)).printedCount).toBe(2);
    expect(await h.audit(w.school, 'certificate.printed')).toHaveLength(2);
  });

  it('wave N review: an "other" certificate reads "is a student" while enrolled and "was a student" after leaving', async () => {
    const w = await h.world();
    const current = cert((await issue(w.a.studentId, { type: 'other', title: 'Sports Certificate' }, w.office).expect(201)));
    const currentPage = (await get(`/certificates/${current.id}/print`, w.office).expect(200)).text;
    expect(currentPage).toMatch(/, is a student of this school/);
    expect(currentPage).not.toMatch(/is ?was/);
    const s = await leaver(w);
    const past = cert((await issue(s.studentId, { type: 'other', title: 'Sports Certificate' }, w.office).expect(201)));
    const pastPage = (await get(`/certificates/${past.id}/print`, w.office).expect(200)).text;
    expect(pastPage).toMatch(/, was a student of this school/);
    expect(pastPage).not.toMatch(/is ?was/);
  });

  it('refusals: other needs a title; a teacher holds no certificate.issue; a teacher outside the student scope reads 404', async () => {
    const w = await h.world();
    const noTitle = (await issue(w.a.studentId, { type: 'other' }, w.office).expect(422));
    expect(h.err(noTitle).error.details?.fields?.[0]?.path).toBe('title');
    const other = cert((await issue(w.a.studentId, { type: 'other', title: 'Sports Certificate', remarks: 'First in the 100 metres' }, w.office).expect(201)));
    expect([other.label, other.title]).toEqual(['OC-0001', 'Sports Certificate']);
    // Wave N review: a title only on `other`, and never a leaving certificate's.
    for (const body of [
      { type: 'character', title: 'Character and Conduct' },
      { type: 'leaving', title: 'School Leaving Certificate' },
      { type: 'other', title: 'School LEAVING Certificate' },
      { type: 'other', title: 'Leaver certificate' },
    ]) {
      const refused = await issue(w.a.studentId, body, w.office).expect(422);
      expect(h.err(refused).error.details?.fields?.[0]).toEqual(expect.objectContaining({ path: 'title', code: 'INVALID_VALUE' }));
    }
    await issue(w.a.studentId, { type: 'character', remarks: 'Call 0300 1234567' }, w.office).then((r) => expect(r.status).toBe(422));
    await issue(w.a.studentId, { type: 'character', schoolId: '1' }, w.office).then((r) => expect(r.status).toBe(422));

    await get('/certificates', w.teacher).expect(403);
    await issue(w.a.studentId, { type: 'character' }, w.teacher).then((r) => expect(r.status).toBe(403));
    // student.view with no assigned section: the student is outside the scope.
    await get(`/students/${w.a.studentId}/certificates`, w.teacher).expect(404);
  });

  it('isolation: another school’s certificate or student is 404 on every route', async () => {
    const w = await h.world();
    const other = await h.world({ name: 'Other School' });
    const theirs = cert((await issue(other.a.studentId, { type: 'character' }, other.office).expect(201)));
    await get(`/certificates/${theirs.id}`, w.principal).expect(404);
    await get(`/certificates/${theirs.id}/print`, w.principal).expect(404);
    await post(`/certificates/${theirs.id}/void`, { reason: 'Not ours' }, w.principal).expect(404);
    await post(`/certificates/${theirs.id}/reissue`, { reason: 'Not ours' }, w.principal, newIdempotencyKey()).expect(404);
    await issue(other.a.studentId, { type: 'character' }, w.office).then((r) => expect(r.status).toBe(404));
    await get(`/students/${other.a.studentId}/certificates`, w.office).expect(404);
    expect(((await get('/certificates', w.principal)).body as { total: number }).total).toBe(0);
  });

  it('§1.1 settings: the signatory and the B-Form switch are PATCHable school settings, audited; null clears the signatory', async () => {
    const w = await h.world();
    type Settings = { certificateSignatoryName: string | null; certificateShowIdentityNo: boolean };
    const before = (await get('/school/settings', w.principal).expect(200)).body as Settings;
    expect(before).toEqual(expect.objectContaining({ certificateSignatoryName: null, certificateShowIdentityNo: true }));
    const after = (await settingsPatch(w, { certificateSignatoryName: '  Mrs Farah   Naz ', certificateShowIdentityNo: false }).expect(200)).body as Settings;
    expect(after).toEqual(expect.objectContaining({ certificateSignatoryName: 'Mrs Farah Naz', certificateShowIdentityNo: false }));
    const [row] = await h.audit(w.school, 'school_settings.updated');
    expect(row?.metadata).toEqual({
      changes: {
        certificateSignatoryName: { from: null, to: 'Mrs Farah Naz' },
        certificateShowIdentityNo: { from: true, to: false },
      },
    });
    // The set name is what the next certificate signs with; nothing defaults over it.
    const c = cert(await issue(w.a.studentId, { type: 'character' }, w.office).expect(201));
    expect(c.body?.signatoryName).toBe('Mrs Farah Naz');
    expect(((await h.audit(w.school, 'certificate.issued'))[0]?.metadata as { signatoryDefaulted: boolean }).signatoryDefaulted).toBe(false);
    await settingsPatch(w, { certificateSignatoryName: '35201-2345671-1' }).expect(422);
    await settingsPatch(w, { certificateSignatoryName: '' }).expect(422);
    await settingsPatch(w, { certificateShowIdentityNo: null }).expect(422);
    expect(((await settingsPatch(w, { certificateSignatoryName: null }).expect(200)).body as Settings).certificateSignatoryName).toBeNull();
    // The office holds certificate.issue but not school.settings.manage.
    await keep(h.http().patch('/api/v1/school/settings').set('Cookie', w.office.cookie).set('Origin', ORIGIN).send({ certificateShowIdentityNo: true })).expect(403);
  });

  it('R16: no identity number in any response or log line of this file, any certificate body, or any certificate audit row', async () => {
    expect(used.length).toBeGreaterThan(0);
    for (const text of [...bodies, ...logs]) {
      for (const digits of used) {
        // The print views are the one place the dashed B-Form may appear (R292); JSON never.
        if (text.startsWith('<!doctype html>')) continue;
        expect(text).not.toContain(digits);
        expect(text).not.toContain(dashed(digits));
      }
    }
    expect(bodies.filter((t) => !t.startsWith('<!doctype html>')).some((t) => PATTERN.test(t))).toBe(false);
    expect(logs.some((line) => used.some((d) => line.includes(d) || line.includes(dashed(d))))).toBe(false);
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      // Whole tables, every school any suite wrote.
      const bodiesHit = await pg.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM certificates WHERE body::text ~ '[0-9]{13}' OR body::text ~ '[0-9]{5}-[0-9]{7}-[0-9]'`,
      );
      expect(bodiesHit.rows[0]?.n).toBe('0');
      const auditHit = await pg.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log WHERE action LIKE 'certificate.%'
            AND (metadata::text ~ '[0-9]{13}' OR coalesce(reason, '') ~ '[0-9]{13}' OR metadata::text ~ '[0-9]{5}-[0-9]{7}-[0-9]')`,
      );
      expect(auditHit.rows[0]?.n).toBe('0');
    } finally {
      await pg.end();
    }
  });
});
