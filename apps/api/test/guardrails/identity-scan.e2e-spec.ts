// R16 (plan §5 slice 8): no identity number (13 digits, or #####-#######-#) in any log line, URL,
// audit row, idempotency row or response after the flows that handle CNIC and B-Form numbers.
//
// One app, one run through every such flow: the platform issuing a principal login, school login
// (failed and successful, dashed and plain), staff create and issue-login, office reset,
// forgot-password, guardian create and lookup, admission with a replay, student lookup, student
// and guardian issue-login and their logins, and a search URL carrying a dashed number. Then:
//   - every captured log line and every response body is checked for the exact digits used,
//     plain and dashed, and for both generic patterns;
//   - audit_log, platform_audit_log and idempotency_keys are scanned WHOLE (every school any
//     suite ever wrote, since tests never truncate), as text, for both patterns. The 64-hex
//     request_hash is excluded from the pattern scan only (hex holds a 13-digit run by chance
//     about one time in 23) and is still searched for the exact digits.
import { randomBytes } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { MESSAGE_TYPES, type MessageSubjectType, type MessageType } from '@asms/shared';
import { JobRunner } from '../../src/jobs/job-runner';
import { NotificationService } from '../../src/messaging/notification.service';
import {
  composeAnnouncement,
  holidayCancellationText,
  holidayNoticeText,
  renderMessage,
  renderBillingTierMissing,
  renderWhatsAppSessionDown,
  smsTextOf,
  type RenderContext,
  type Rendered,
} from '../../src/messaging/templates';
import { Mailer } from '../../src/modules/auth/mailer';
import {
  asSchool,
  connectedNumber,
  guardian,
  messagingApp,
  messagingSchool,
  tx,
  type FakeDrivers,
} from '../messaging/support';
import { createTestApp } from '../core/app';
import { signedInPlatformAdmin } from '../support/platform';
import { randomIdentityDigits, testIdentityHash } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createClassWithSection, randomPhone, type TestSection } from '../support/students';
import { FakeMailer, nextIp, ORIGIN, sessionCookieOf } from '../school-auth/support';

const PATTERN = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
/** Every log line of every app in this file (see the second app's note). */
const fileLogs: string[] = [];
const dashed = (d: string) => `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;

describe('R16: identity numbers never reach logs, responses, audit or idempotency rows', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let section: TestSection;
  const logs = fileLogs;
  const bodies: string[] = [];
  const used: string[] = [];
  const db = testDb();
  const http = () => request(app.getHttpServer());

  const digits = () => {
    const d = randomIdentityDigits();
    used.push(d);
    return d;
  };
  const keep = (res: request.Response) => {
    bodies.push(res.text);
    return res;
  };
  const post = async (path: string, body: object, cookie?: string, headers: Record<string, string> = {}) => {
    const req = http().post(`/api/v1${path}`).set('Origin', ORIGIN).set('X-Forwarded-For', nextIp());
    if (cookie) req.set('Cookie', cookie);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return keep(await req.send(body));
  };
  const get = async (path: string, cookie: string) =>
    keep(await http().get(`/api/v1${path}`).set('Cookie', cookie));
  const login = (username: string, password: string) =>
    post('/auth/login', { schoolCode: school.shortCode, username, password });

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [{ provide: Mailer, useValue: new FakeMailer() }],
      logStream: { write: (line: string) => void logs.push(line) },
    });
    school = await createSchool({ status: 'trial' });
    await db.schoolCounter.create({ data: { schoolId: school.id, name: 'admission_no', value: 0n } });
    await db.schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: true } });
    ({ section } = await createClassWithSection(db, school));
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R16: runs every identity-number flow (each step succeeds, so the scan below is not vacuous)', async () => {
    // Platform issues the principal login (platform_audit_log and audit_log).
    const admin = await signedInPlatformAdmin();
    const principalCnic = digits();
    const issued = keep(
      await http()
        .post(`/api/v1/platform/schools/${school.id}/issue-principal-login`)
        .set('Cookie', admin.cookie)
        .set('Origin', ORIGIN)
        .send({ fullName: 'Nadia Principal', cnic: dashed(principalCnic), phone: '0300 1234567' }),
    );
    expect(issued.status).toBe(201);

    // School login: a failure, then success with the dashed username and the default password.
    expect((await login(principalCnic, 'not-the-password')).status).toBe(401);
    const signedIn = await login(dashed(principalCnic), principalCnic);
    expect(signedIn.status).toBe(200);
    const principal = sessionCookieOf(signedIn);
    // Rule 24 (R225): user.account.manage is inert until the default password is changed (which
    // first needs a verified email, rule 12); this scan is about identity numbers, so the change is
    // recorded directly.
    const changed = await db.user.updateMany({
      where: { schoolId: school.id, usernameHash: testIdentityHash(principalCnic) },
      data: { passwordIsDefault: false },
    });
    expect(changed.count).toBe(1);

    // Staff: create with a dashed CNIC, a duplicate refusal, issue-login, login, office reset.
    const staffCnic = digits();
    const staff = await post('/staff', { fullName: 'Rabia Khan', phone: '03001234567', cnic: dashed(staffCnic) }, principal);
    expect(staff.status).toBe(201);
    const duplicate = await post('/staff', { fullName: 'Rabia Again', phone: '03001234568', cnic: staffCnic }, principal);
    expect(duplicate.status).toBe(409);
    const staffId = (staff.body as { id: string }).id;
    const staffLogin = await post(`/staff/${staffId}/issue-login`, { systemRole: 'office_staff' }, principal);
    expect(staffLogin.status).toBe(201);
    const staffUserId = (staffLogin.body as { id: string }).id;
    expect((await login(staffCnic, staffCnic)).status).toBe(200);
    const reset = await post(`/users/${staffUserId}/reset-password`, { reason: 'Forgot it', clearEmail: false }, principal);
    expect(reset.status).toBe(200);
    expect((await post('/auth/forgot-password', { schoolCode: school.shortCode, username: dashed(staffCnic) })).status).toBe(202);

    // Guardians: create, a duplicate refusal, lookup by CNIC.
    const guardianCnic = digits();
    const guardian = await post('/guardians', { fullName: 'Ahmed Khan', cnic: dashed(guardianCnic), phone: randomPhone(), contactCapability: 'whatsapp' }, principal);
    expect(guardian.status).toBe(201);
    expect((await post('/guardians', { fullName: 'Ahmed Again', cnic: guardianCnic, contactCapability: 'keypad' }, principal)).status).toBe(409);
    const lookup = await post('/guardians/lookup', { cnic: dashed(guardianCnic) }, principal);
    expect(lookup.status).toBe(200);

    // Admission with a new guardian and a B-Form, replayed with the same key; student lookup.
    const bForm = digits();
    const parentCnic = digits();
    const admission = {
      student: { fullName: `Ali ${randomBytes(3).toString('hex')}`, gender: 'male', dateOfBirth: '2018-03-01', bForm: dashed(bForm) },
      guardians: [
        {
          newGuardian: { fullName: 'Imran Raza', cnic: dashed(parentCnic), phone: randomPhone(), contactCapability: 'whatsapp' },
          relationship: 'father',
          isPrimaryContact: true,
          isFeePayer: true,
          canLogin: true,
        },
      ],
      enrolment: { classId: section.classId.toString(), sectionId: section.id.toString() },
    };
    const key = `adm_${randomBytes(12).toString('base64url')}`;
    const admitted = await post('/admissions', admission, principal, { 'Idempotency-Key': key });
    expect(admitted.status).toBe(201);
    const replay = await post('/admissions', admission, principal, { 'Idempotency-Key': key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const result = admitted.body as { student: { id: string }; guardianLinks: { guardianId: string }[] };
    expect((await post('/students/lookup', { bForm }, principal)).status).toBe(200);

    // Student and guardian logins issued, then used.
    expect((await post(`/students/${result.student.id}/issue-login`, {}, principal)).status).toBe(201);
    expect((await login(bForm, bForm)).status).toBe(200);
    const parentId = result.guardianLinks[0]?.guardianId ?? '';
    expect((await post(`/guardians/${parentId}/issue-login`, {}, principal)).status).toBe(201);
    expect((await login(dashed(parentCnic), parentCnic)).status).toBe(200);

    // A search URL carrying a dashed number: refused, and its request line scrubbed in the log.
    expect((await get(`/users?q=${dashed(staffCnic)}`, principal)).status).toBe(422);
    expect((await get(`/guardians?q=${guardianCnic}`, principal)).status).toBe(422);

    // Lists the office reads every day.
    for (const path of ['/users', '/staff', '/guardians', '/students']) {
      expect((await get(path, principal)).status).toBe(200);
    }
    expect(used).toHaveLength(5);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('R16: no captured log line holds an identity number', () => {
    const all = logs.join('\n');
    for (const d of used) {
      expect(all).not.toContain(d);
      expect(all).not.toContain(dashed(d));
    }
    const hits = logs.filter((l) => PATTERN.test(l));
    expect(hits).toEqual([]);
    // Not vacuous: request URLs are logged, and the two search URLs reached the log masked.
    expect(logs.filter((l) => l.includes('/api/v1/users?q=[id]') || l.includes('/api/v1/guardians?q=[id]'))).not.toEqual([]);
  });

  it('R111 (slice 9): the scanner gains the phone pattern: no captured log line holds a phone number', () => {
    // Phones were sent in this run's bodies (staff, guardians, admission); none reaches the logs.
    expect(logs.filter((l) => /\+?92[0-9]{10}|(?<![0-9])03[0-9]{9}(?![0-9])/.test(l))).toEqual([]);
  });

  it('R16: no response body holds an identity number', () => {
    const all = bodies.join('\n');
    for (const d of used) {
      expect(all).not.toContain(d);
      expect(all).not.toContain(dashed(d));
    }
    expect(bodies.filter((b) => PATTERN.test(b))).toEqual([]);
  });

  describe('the stored trails, whole tables', () => {
    let pg: Client;

    beforeAll(async () => {
      pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
    });

    afterAll(async () => {
      await pg.end();
    });

    /** Each row of `table` as JSON text, optionally without some columns. */
    async function rowsAsText(table: string, without: string[] = []): Promise<string[]> {
      const drop = without.map((c) => ` - '${c}'`).join('');
      const res = await pg.query<{ row: string }>(`SELECT (to_jsonb(t)${drop})::text AS row FROM ${table} t`);
      return res.rows.map((r) => r.row);
    }

    it.each(['audit_log', 'platform_audit_log', 'idempotency_keys'])(
      'R16: %s holds none of the identity numbers this run sent',
      async (table) => {
        const rows = (await rowsAsText(table)).join('\n');
        expect(rows.length).toBeGreaterThan(0);
        for (const d of used) {
          expect(rows).not.toContain(d);
          expect(rows).not.toContain(dashed(d));
        }
      },
    );

    it.each([
      ['audit_log', []],
      ['platform_audit_log', []],
      ['idempotency_keys', ['request_hash']],
    ])('R16: no row of %s matches an identity-number pattern', async (table, without) => {
      const hits = (await rowsAsText(table, without)).filter((row) => PATTERN.test(row));
      expect(hits).toEqual([]);
    });

    it('R16: this run wrote the rows the scan relies on', async () => {
      const audit = await pg.query<{ action: string }>(
        'SELECT action FROM audit_log WHERE school_id = $1 ORDER BY id',
        [school.id.toString()],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'staff.created',
          'user.principal_login_issued',
          'user.login_issued',
          'user.office_reset',
          'guardian.created',
          'student.admitted',
        ]),
      );
      const platform = await pg.query('SELECT 1 FROM platform_audit_log WHERE school_id = $1', [school.id.toString()]);
      expect(platform.rowCount).toBeGreaterThan(0);
      const keys = await pg.query('SELECT 1 FROM idempotency_keys WHERE school_id = $1', [school.id.toString()]);
      expect(keys.rowCount).toBe(1);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// Slice 17 (plan §6 slice 17, §9): the R16 scan, with the phone pattern, extended to every message
// template, the messages and message_deliveries tables (provider error text included), push
// payloads and the worker's own log lines. The mobile log sink has its own scan
// (apps/mobile/src/platform/log-sink.spec.tsx).

/** The phone pattern, spaced and dashed forms included (as the mobile scrubber's). */
const PHONE = /(\+?92[\s-]?|(?<![0-9])0)3[0-9]{2}[\s-]?[0-9]{3}[\s-]?[0-9]{4}(?![0-9])/;
const leaks = (text: string) => PATTERN.test(text) || PHONE.test(text);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** PATTERN and PHONE as Postgres regular expressions, for the whole-table scans. */
const ID_SQL = '[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]';
const PHONE_SQL = '(\\+?92[ -]?|(^|[^0-9])0)3[0-9]{2}[ -]?[0-9]{3}[ -]?[0-9]{4}([^0-9]|$)';
/** The rows of `table` (every school) whose `text` expression matches either pattern. */
async function leakingRows(pg: Client, table: string, text: string): Promise<number> {
  const res = await pg.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} t WHERE ${text} ~ $1 OR ${text} ~ $2`, [ID_SQL, PHONE_SQL]);
  return Number(res.rows[0]?.n);
}

describe('R16 (slice 17): every message template, rendered with realistic values', () => {
  const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
  const ctx = (subjectType: MessageSubjectType, body?: string): RenderContext => ({
    schoolName: SCHOOL,
    timezone: 'Asia/Karachi',
    subjectType,
    ...(body === undefined ? {} : { body }),
  });
  const child = { studentName: 'Muhammad Abdul Rehman Siddiqui Qureshi', className: 'Class Ten', sectionName: 'Blue' };
  const announcement = composeAnnouncement(
    SCHOOL,
    'Parent-teacher meeting',
    'Meet the class teacher on Saturday from 9 to 12. Bring the report card.',
  );

  // One entry per type, typed so that a new MessageType fails to compile until it is rendered here.
  /**
   * Phase 3 types whose templates their own slices write (phase-3-financial.md §3.6). Each still
   * refuses to render; once a slice writes its template it leaves this set and is scanned above.
   */
  const TEMPLATE_PENDING = new Set<MessageType>([]);

  const RENDERED: { [K in MessageType]: () => Rendered[] } = {
    absence_alert: () => [renderMessage('absence_alert', { ...child, date: day('2026-10-05') }, ctx('attendance_alert'))],
    late_advice: () => [
      renderMessage('late_advice', { ...child, date: day('2026-10-05'), arrivedAt: '08:42' }, ctx('attendance_alert')),
      renderMessage('late_advice', { ...child, date: day('2026-10-05'), arrivedAt: null }, ctx('attendance_alert')),
    ],
    attendance_corrected: () =>
      (['present', 'late', 'partial', 'on_leave', 'absent'] as const).map((status) =>
        renderMessage(
          'attendance_corrected',
          { ...child, date: day('2026-10-05'), status, arrivedAt: status === 'late' ? '09:05' : null },
          ctx('attendance_alert'),
        ),
      ),
    announcement_urgent: () => [renderMessage('announcement_urgent', {}, ctx('announcement', announcement))],
    announcement_normal: () => [renderMessage('announcement_normal', {}, ctx('announcement', announcement))],
    holiday_notice: () => [
      renderMessage(
        'holiday_notice',
        { name: 'Quaid-e-Azam Day and Christmas', startsOn: day('2026-12-24'), endsOn: day('2026-12-26'), reopensOn: day('2026-12-28') },
        ctx('holiday'),
      ),
      renderMessage('holiday_notice', { name: 'Iqbal Day', startsOn: day('2026-11-09'), endsOn: day('2026-11-09') }, ctx('holiday_cancellation')),
    ],
    diary_posted: () => [
      renderMessage(
        'diary_posted',
        {
          className: 'Class Five',
          sectionName: 'A',
          subjectName: 'Mathematics',
          date: day('2026-10-05'),
          topic: 'Pages 12 to 14, exercise 4',
          dueOn: day('2026-10-07'),
        },
        ctx('diary_entry'),
      ),
    ],
    remark_posted: () => [
      renderMessage('remark_posted', { studentName: child.studentName, category: 'behaviour', date: day('2026-10-05') }, ctx('remark')),
    ],
    register_unrecorded: () => [
      renderMessage(
        'register_unrecorded',
        {
          date: day('2026-10-05'),
          deadlineTime: '10:00',
          sections: Array.from({ length: 7 }, (_, i) => ({
            className: `Class ${i + 1}`,
            sectionName: 'A',
            coverStaffName: i === 0 ? 'Rabia Khan' : null,
          })),
        },
        ctx('register_deadline'),
      ),
    ],
    sms_cap_reached: () => [renderMessage('sms_cap_reached', { cap: 5000, nextMonthStart: day('2026-11-01') }, ctx('sms_cap'))],
    messaging_test: () => [
      renderMessage('messaging_test', { senderName: 'Nadia Principal', time: new Date('2026-10-05T04:30:00Z') }, ctx('messaging_test')),
    ],
    // Not sent through renderMessage (no messages row): the platform alert.
    whatsapp_session_down: () => [
      renderWhatsAppSessionDown({ schoolName: SCHOOL, schoolId: 4821n, at: new Date('2026-10-05T04:30:00Z'), errorCode: 'logged_out' }),
    ],
    cover_assigned: () => [
      renderMessage(
        'cover_assigned',
        { className: 'Class Ten', sectionName: 'Blue', startsOn: day('2026-10-05'), endsOn: day('2026-10-09') },
        ctx('teacher_assignment'),
      ),
    ],
    // Phase 3: no template yet (TEMPLATE_PENDING); the slice that writes one renders it here.
    // Slice 19 (contracts/slice-19.md §6): the family's total and children's names; never an id.
    fee_charged: () => [
      renderMessage(
        'fee_charged',
        {
          label: 'October 2026 fees',
          total: 12_500,
          children: ['Muhammad Abdul Rehman Siddiqui', 'Ayesha Siddiqa Rehman'],
          dueOn: day('2026-10-10'),
        },
        ctx('charge_run'),
      ),
    ],
    // Slice 22 (contracts/slice-22.md §4): the family's total, the children's names and a date.
    fee_due_reminder: () => [
      renderMessage(
        'fee_due_reminder',
        { total: 12_500, children: ['Muhammad Abdul Rehman Siddiqui', 'Ayesha Siddiqa Rehman'], dueOn: day('2026-10-10') },
        ctx('fee_reminder'),
      ),
    ],
    fee_overdue: () => [
      renderMessage(
        'fee_overdue',
        { overdue: 12_500, children: ['Muhammad Abdul Rehman Siddiqui', 'Ayesha Siddiqa Rehman'], since: day('2026-09-10') },
        ctx('fee_reminder'),
      ),
    ],
    // Slice 20 (contracts/slice-20.md §6): the receipt's label, amounts and children's names.
    receipt_issued: () => [
      renderMessage(
        'receipt_issued',
        {
          receiptLabel: '1234/Session 2026-27 April intake',
          amount: 12_500,
          children: ['Muhammad Abdul Rehman Siddiqui', 'Ayesha Siddiqa Rehman'],
          yearName: 'Session 2026-27 April intake',
          balance: 3_000,
        },
        ctx('receipt'),
      ),
    ],
    // Slice 21 (contracts/slice-21.md §5): the child's name, the amount and the office's reason.
    payment_claim_rejected: () => [
      renderMessage(
        'payment_claim_rejected',
        {
          studentName: 'Muhammad Abdul Rehman Siddiqui',
          amount: 12_500,
          paidOn: day('2026-10-05'),
          reason: 'The slip shows a different account; please pay to the account on the fees page and send the new slip.',
        },
        ctx('payment_claim'),
      ),
    ],
    payment_claim_submitted: () => [
      renderMessage('payment_claim_submitted', { studentName: 'Muhammad Abdul Rehman Siddiqui' }, ctx('payment_claim')),
    ],
    handover_shortfall: () => [
      renderMessage('handover_shortfall', { collectorName: 'Muhammad Abdul Rehman Siddiqui' }, ctx('cash_handover')),
    ],
    reminder_sms_capped: () => [renderMessage('reminder_sms_capped', { families: 42 }, ctx('fee_reminder'))],
    concession_requested: () => [
      renderMessage(
        'concession_requested',
        { studentName: 'Muhammad Abdul Rehman Siddiqui', requesterName: 'Office Clerk' },
        ctx('concession'),
      ),
    ],
    concession_decided: () =>
      (['approved', 'rejected', 'ended'] as const).map((decision) =>
        renderMessage('concession_decided', { studentName: 'Muhammad Abdul Rehman Siddiqui', decision }, ctx('concession')),
      ),
    // Slice 23: the recorder's name is a staff name, the category a code; never an amount.
    expense_approval_requested: () => [
      renderMessage(
        'expense_approval_requested',
        { expenseNo: 1234, category: 'daily_purchases', recorderName: 'Muhammad Abdul Rehman Siddiqui' },
        ctx('expense'),
      ),
    ],
    expense_decided: () =>
      (['approved', 'rejected'] as const).map((decision) =>
        renderMessage('expense_decided', { expenseNo: 1234, decision }, ctx('expense')),
      ),
    // Slice 24 (contracts/slice-24.md §5).
    leave_requested: () => [
      renderMessage(
        'leave_requested',
        { staffName: 'Muhammad Abdul Rehman Siddiqui', typeName: 'Casual leave', startsOn: day('2026-10-12'), endsOn: day('2026-10-14'), workingDays: 3 },
        ctx('leave_request'),
      ),
    ],
    leave_decided: () =>
      (['approved', 'rejected'] as const).map((decision) =>
        renderMessage(
          'leave_decided',
          { typeName: 'Sick leave', startsOn: day('2026-10-12'), endsOn: day('2026-10-12'), decision },
          ctx('leave_request'),
        ),
      ),
    // Slice 25 (contracts/slice-25.md §7): no amount (R238).
    payslip_ready: () => [renderMessage('payslip_ready', { yearMonth: '2026-09' }, ctx('payslip'))],
    // Slice 26 (contracts/slice-26.md §5).
    platform_invoice_issued: () => [
      renderMessage('platform_invoice_issued', { invoiceNo: 'INV-2026-00042', yearMonth: '2026-10', dueOn: day('2026-10-10') }, ctx('platform_invoice')),
    ],
    platform_invoice_overdue: () =>
      [false, true].map((suspensionEligible) =>
        renderMessage(
          'platform_invoice_overdue',
          { invoiceNo: 'INV-2026-00042', yearMonth: '2026-10', dueOn: day('2026-10-10'), suspensionEligible },
          ctx('platform_invoice'),
        ),
      ),
    // Not sent through renderMessage (no messages row): the platform alert.
    billing_tier_missing: () => [
      renderBillingTierMissing({
        yearMonth: '2026-10',
        skipped: [
          { schoolId: 4821n, schoolName: SCHOOL, reason: 'no_metrics' },
          { schoolId: 4822n, schoolName: 'Iqra Model School', reason: 'no_band' },
        ],
      }),
    ],
    // Phase 4 (phase-4-academic.md §3.5): name, term, percentage and grade only.
    result_published: () => [
      renderMessage('result_published', { studentName: 'Muhammad Abdul Rehman Siddiqui', termName: 'Mid-term', percentBp: 10000, grade: 'A+' }, ctx('result')),
      renderMessage('result_published', { studentName: 'Hira Tariq', termName: 'Annual', percentBp: null, grade: null }, ctx('result')),
    ],
    result_revised: () => [
      renderMessage('result_revised', { studentName: 'Muhammad Abdul Rehman Siddiqui', termName: 'Final', percentBp: 4000, grade: 'E' }, ctx('result')),
    ],
    test_marked: () => [
      renderMessage('test_marked', { studentName: 'Hira Tariq', testName: 'Unit 4 weekly test' }, ctx('assessment')),
    ],
  };

  it.each(MESSAGE_TYPES.filter((type) => !TEMPLATE_PENDING.has(type)).map((type) => [type]))('R16: %s holds no identity number or phone in its title or body', (type) => {
    const rendered = RENDERED[type]();
    expect(rendered.length).toBeGreaterThan(0);
    for (const { title, body } of rendered) {
      expect(body.length).toBeGreaterThan(0);
      expect([title, body, smsTextOf(body, true)].filter(leaks)).toEqual([]);
    }
  });

  it('R16: every type still pending a template refuses to render (so none is sent unscanned)', () => {
    for (const type of TEMPLATE_PENDING) {
      expect(() => renderMessage(type, {}, ctx('receipt'))).toThrow('written by its own slice');
    }
  });

  it('R16: the holiday announcement texts and a composed announcement hold none either', () => {
    const holiday = { name: 'Eid ul Fitr', startsOn: day('2027-03-10'), endsOn: day('2027-03-12'), reopensOn: day('2027-03-15') };
    const texts = [holidayNoticeText(SCHOOL, holiday), holidayCancellationText(SCHOOL, holiday)].flatMap((t) => [t.title, t.body]);
    expect([...texts, announcement].filter(leaks)).toEqual([]);
  });
});

describe('R16 (slice 17): messages, delivery rows, push payloads and the worker log', () => {
  let app: NestExpressApplication;
  let drivers: FakeDrivers;
  // The file's one log sink (below): nestjs-pino keeps the first app's logger as its root, so
  // this app's out-of-request lines (the worker's) reach the first app's stream, not this one's.
  const logs = fileLogs;
  // The first describe's afterAll closes the shared client; this block opens its own.
  let db: ReturnType<typeof testDb>;
  const subject = () => BigInt(Date.now() % 1_000_000_000) * 100n + BigInt(Math.floor(Math.random() * 100));

  beforeAll(async () => {
    ({ app, drivers } = await messagingApp({ write: (line: string) => void logs.push(line) }));
    db = testDb();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R16: a worker round whose providers fail with text holding phones and identity numbers leaks none of it', async () => {
    const school = await messagingSchool();
    await connectedNumber(db, school);
    const wa = await guardian(db, school, { capability: 'whatsapp', login: true, device: true });
    const keypad = await guardian(db, school, { capability: 'keypad' });
    const cnic = randomIdentityDigits();
    const phones = [wa.phone, keypad.phone].filter((p): p is string => p !== null);
    expect(phones).toHaveLength(2);
    // A phone as a person writes it, split 4-3-4 ("0300 123 4567") or 3-3-4 after the country code.
    const local = (p: string) => p.replace('+92', '0');
    const split = (p: string, sep: string) => [local(p).slice(0, 4), local(p).slice(4, 7), local(p).slice(7)].join(sep);
    const e164Split = (p: string) => `+92 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}`;
    const writtenForms = (p: string) => [local(p), split(p, ' '), split(p, '-'), e164Split(p)];
    const secrets = [cnic, dashed(cnic), ...phones, ...phones.flatMap(writtenForms)];

    // Provider errors as WAHA, Sendpk and FCM word them: the number in every written form, and a
    // CNIC echoed back.
    const providerText = (to: string) =>
      `provider said: ${to} rejected (ref ${dashed(cnic)}, ${cnic}); call ${writtenForms(to).join(' or ')}`;
    jest.spyOn(drivers.whatsapp.waha, 'sendText').mockImplementation((_s, to) => Promise.reject(new Error(providerText(to))));
    jest.spyOn(drivers.sms, 'send').mockImplementation((to) => Promise.reject(new Error(providerText(to))));
    jest.spyOn(drivers.push, 'send').mockImplementation(() => Promise.reject(new Error(providerText(phones[0] ?? ''))));

    const notifications = app.get(NotificationService, { strict: false });
    const id = subject();
    await asSchool(app, school.id, () =>
      tx.run(async () => {
        await notifications.send(school.id, {
          type: 'holiday_notice',
          subject: { type: 'holiday', id },
          recipients: [{ guardianId: wa.id }, { guardianId: keypad.id }],
          vars: { name: 'Iqbal Day', startsOn: day('2026-11-09'), endsOn: day('2026-11-09'), reopensOn: day('2026-11-10') },
        });
        await notifications.send(school.id, {
          type: 'announcement_urgent',
          subject: { type: 'announcement', id },
          recipients: [{ guardianId: wa.id }, { guardianId: keypad.id }],
          vars: {},
          title: 'Early closing',
          body: composeAnnouncement('Iqra Model School', 'Early closing', 'School closes at noon today.'),
        });
      }),
    );
    const messages = await db.message.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
    expect(messages).toHaveLength(4);

    // The worker's own entry point, as BullMQ calls it; then a forged payload with identity-shaped ids.
    const runner = app.get(JobRunner, { strict: false });
    try {
      for (const m of messages) {
        expect(await runner.messaging('message', { schoolId: school.id.toString(), messageId: m.id.toString() })).toBe('done');
      }
      expect(await runner.messaging('message', { schoolId: cnic, messageId: dashed(cnic) })).toBe('dropped');
    } finally {
      jest.restoreAllMocks();
    }

    const deliveries = await db.messageDelivery.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
    // Not vacuous: each provider was reached and threw its text, and each failure has its row.
    const failed = deliveries.filter((d) => d.status === 'failed');
    expect(new Set(failed.map((d) => d.channel))).toEqual(new Set(['whatsapp', 'sms', 'push']));
    expect(failed.every((d) => d.errorCode === 'provider_unavailable')).toBe(true);
    // The processor's "attempt failed unexpectedly" warnings, one per provider that threw.
    const warnings = logs.filter((l) => l.includes('"context":"MessageProcessor"') && l.includes('"errorClass":"Error"'));
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    // Each carries its message; pino writes msg last, after the stack, so a truncated view hides it.
    expect(warnings.filter((l) => !l.trimEnd().endsWith('"msg":"attempt failed unexpectedly"}'))).toEqual([]);

    const stored = JSON.stringify(
      [messages, deliveries.map(({ providerRefHash: _h, pollRef: _p, ...row }) => row)],
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    const workerLog = logs.join('\n');
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(workerLog).not.toContain(secret);
    }
    expect(messages.flatMap((m) => [m.body, m.title ?? '']).filter(leaks)).toEqual([]);
    expect(deliveries.map((d) => d.toMasked ?? '').filter((t) => /[0-9]{7}/.test(t))).toEqual([]);
    expect(logs.filter(leaks)).toEqual([]);
    // The scrubber did the work: the provider text reached the log, masked.
    expect(workerLog).toContain('[phone]');
    expect(workerLog).toContain('[id]');
  });

  it('R16: a push payload carries a title, the body and ids only', async () => {
    const school = await messagingSchool();
    const g = await guardian(db, school, { capability: 'smartphone_data', login: true, device: true });
    drivers.calls.length = 0;
    await asSchool(app, school.id, () =>
      tx.run(() =>
        app.get(NotificationService, { strict: false }).send(school.id, {
          type: 'holiday_notice',
          subject: { type: 'holiday', id: subject() },
          recipients: [{ guardianId: g.id }],
          vars: { name: 'Iqbal Day', startsOn: day('2026-11-09'), endsOn: day('2026-11-09') },
        }),
      ),
    );
    const [message] = await db.message.findMany({ where: { schoolId: school.id } });
    expect(message).toBeDefined();
    const runner = app.get(JobRunner, { strict: false });
    expect(await runner.messaging('message', { schoolId: school.id.toString(), messageId: String(message?.id) })).toBe('done');
    const pushes = drivers.of('push').map((c) => JSON.stringify(c.push));
    expect(pushes).toHaveLength(1);
    expect(pushes.filter(leaks)).toEqual([]);
    expect(pushes[0]).not.toContain(g.phone ?? 'no phone');
  });

  it('R16: no stored message text, delivery row or announcement, whole tables, matches either pattern', async () => {
    // Every school any suite wrote (tests never truncate). subject_id is a polymorphic id (an
    // audit row, YYYYMM, a holiday), not text, so messages are scanned by their text columns.
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      const count = (table: string, text: string) => leakingRows(pg, table, text);
      expect(Number((await pg.query<{ n: string }>('SELECT count(*)::text AS n FROM messages')).rows[0]?.n)).toBeGreaterThan(0);
      expect(await count('messages', `concat_ws(' ', t.body, t.title, t.media_object_key)`)).toBe(0);
      expect(
        await count(
          'message_deliveries',
          `(to_jsonb(t) - 'provider_ref_hash' - 'poll_ref' - 'attempted_at' - 'delivered_at' - 'failed_at')::text`,
        ),
      ).toBe(0);
      expect(await count('announcements', `concat_ws(' ', t.title, t.body, t.cancel_reason, t.attachment_object_key)`)).toBe(0);
    } finally {
      await pg.end();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Phase 3 close (plan §5 slice 28, R16): the whole-table scan widened to every free-text column the
// money tables carry: references, descriptions, payees, reasons, receipt and payslip text, claim
// notes, names a school types. Object keys and MIME types are not free text (a ULID can hold a
// digit run by chance). school_payment_accounts.account_no is left out: a wallet account is a
// phone number by design, and its own CHECK refuses an identity-number shape
// (school_payment_accounts_account_no_check, test/fees/money-guards.e2e-spec.ts).

const PHASE_3_FREE_TEXT: Record<string, string[]> = {
  fee_heads: ['name', 'archive_reason'],
  fee_structures: ['reason'],
  school_payment_accounts: ['title', 'bank_name', 'disable_reason'],
  concessions: ['reason', 'decision_reason', 'end_reason'],
  charge_runs: ['error_code', 'skipped_classes::text'],
  charge_campaigns: ['name', 'description', 'cancel_reason'],
  charges: ['description', 'void_reason', 'waive_reason'],
  payments: ['payer_name', 'reference'],
  payment_reversals: ['reason', 'refund_reference'],
  receipt_lines: ['fee_head_name'],
  cash_handovers: ['note', 'confirm_note', 'shortfall_resolution_reason'],
  payment_claims: ['reference', 'note', 'decision_reason'],
  expenses: ['description', 'payee', 'reference', 'decision_reason', 'void_reason'],
  leave_types: ['name'],
  leave_requests: ['reason', 'decision_reason', 'cancel_reason'],
  salary_structures: ['reason'],
  salary_structure_components: ['name'],
  salary_advances: ['paid_reference', 'write_off_reason'],
  payroll_runs: ['finalise_reason', 'skipped::text'],
  payslips: ['paid_reference'],
  payslip_lines: ['name', 'reason'],
  platform_plans: ['name'],
  platform_subscriptions: ['reason'],
  platform_invoices: ['invoice_no', 'void_reason'],
  platform_payments: ['reference'],
};

describe('R16 (Phase 3): the money tables free text, whole tables', () => {
  let pg: Client;

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    await pg.end();
  });

  it('R16: the SQL patterns catch every written form (so a clean scan is not vacuous)', async () => {
    const matches = async (text: string) => (await pg.query<{ hit: boolean }>('SELECT ($1 ~ $2 OR $1 ~ $3) AS hit', [text, ID_SQL, PHONE_SQL])).rows[0]?.hit;
    for (const text of ['ref 3520212345671', 'CNIC 35202-1234567-1', 'call 03001234567', 'call 0300 123 4567', 'call 0300-123-4567', '+92 300 1234567', '+923001234567']) {
      expect([text, await matches(text)]).toEqual([text, true]);
    }
    for (const text of ['Rs 12,500 for October', 'INV-2026-00042', 'TXN 202610051234', 'Receipt 1234/2026-27']) {
      expect([text, await matches(text)]).toEqual([text, false]);
    }
  });

  it.each(Object.entries(PHASE_3_FREE_TEXT))('R16: no row of %s holds an identity number or phone in its free text', async (table, columns) => {
    const text = `concat_ws(' ', ${columns.map((c) => `t.${c}`).join(', ')})`;
    expect(await leakingRows(pg, table, text)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
// Phase 4 wave P review fixes (R16): the academic free text a person types — a mark correction's
// reason, a sheet's return reason, term remarks, a promotion decision's reason — whole tables,
// and the audit rows of mark corrections and promotion sheets (their reasons and metadata).

const PHASE_4_FREE_TEXT: Record<string, string[]> = {
  marks: ['correction_reason'],
  result_sheets: ['return_reason'],
  result_sheet_remarks: ['remark'],
  results: ['remark'],
  promotion_decisions: ['reason'],
};

describe('R16 (Phase 4): corrections, remarks and promotion reasons, whole tables', () => {
  let pg: Client;

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    await pg.end();
  });

  it.each(Object.entries(PHASE_4_FREE_TEXT))('R16: no row of %s holds an identity number or phone in its free text', async (table, columns) => {
    const text = `concat_ws(' ', ${columns.map((c) => `t.${c}`).join(', ')})`;
    expect(await leakingRows(pg, table, text)).toBe(0);
  });

  it('R16: no mark_correction.* or promotion_sheet.* audit row holds one in its reason or metadata', async () => {
    const res = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log t
        WHERE (t.action LIKE 'mark_correction.%' OR t.action LIKE 'promotion_sheet.%' OR t.action = 'mark.excused')
          AND (concat_ws(' ', t.reason, t.metadata::text) ~ $1)`,
      [ID_SQL],
    );
    expect(Number(res.rows[0]?.n)).toBe(0);
  });
});
