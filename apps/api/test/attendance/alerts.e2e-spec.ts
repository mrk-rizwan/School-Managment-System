// Slice 11 alerts and arrivals end to end (contracts/slice-11.md §4.4, §6, §7): the writer's
// alert rows, the processor, the timing table, corrections and their cap, recipients, the three
// guardian contact capabilities from submit to delivery rows, the gate's arrival, holidays after
// the fact, and the alert-row lock shared by the amend path and the sender. Rules: R126, R167, R168.
import { Client } from 'pg';
import { JobRunner } from '../../src/jobs/job-runner';
import { MessageProcessor } from '../../src/messaging/message-processor';
import { AttendanceAlertProcessor } from '../../src/modules/attendance/attendance-alerts';
import { closeTestDb, type TestSchool } from '../support/schools';
import { createTeacherAssignment, linkGuardian, type TestSection } from '../support/students';
import { asSchool, connectedNumber, guardian } from '../messaging/support';
import { at, AttendanceHarness, errorOf, marks, schoolDay, type Caller, type Child } from './harness';

const T = schoolDay();
const Y = schoolDay(-1);

interface Alerts {
  absencePending: number;
  absenceBackdated: number;
  lateAdvicePending: number;
  cancelled: number;
  corrections: number;
}

describe('slice 11 alerts and arrivals (e2e)', () => {
  const h = new AttendanceHarness();
  const db = h.db;
  let alertProcessor: AttendanceAlertProcessor;
  let messageProcessor: MessageProcessor;

  beforeAll(async () => {
    await h.start();
    alertProcessor = h.app.get(AttendanceAlertProcessor, { strict: false });
    messageProcessor = h.app.get(MessageProcessor, { strict: false });
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });
  beforeEach(() => h.reset());
  afterEach(() => h.restoreClock());

  async function fresh(opts: Parameters<AttendanceHarness['school']>[0] = {}, childOpts: Parameters<AttendanceHarness['child']>[2] = {}) {
    const school = await h.school(opts);
    const principal = await h.caller(school, 'principal', 'Nadia Principal');
    const office = await h.caller(school, 'office_staff', 'Gate Office');
    const teacher = await h.caller(school, 'teacher');
    const section = await h.section(school, { className: 'Class 5', sectionName: 'A' });
    await createTeacherAssignment(db, school, teacher, { role: 'class_teacher', section, startsOn: schoolDay(-30) });
    const child = await h.child(school, section, { fullName: 'Ayesha Siddiqui', ...childOpts });
    return { school, principal, office, teacher, section, child };
  }

  const alertsOf = (school: TestSchool, child: Child) =>
    db.attendanceAlert.findMany({ where: { schoolId: school.id, studentId: child.studentId }, orderBy: { id: 'asc' } });
  const messagesOf = (school: TestSchool, guardianId: bigint) =>
    db.message.findMany({ where: { schoolId: school.id, guardianId }, orderBy: { id: 'asc' } });
  const runAlert = (school: TestSchool, alertId: bigint, now: Date) =>
    asSchool(h.app, school.id, () => alertProcessor.run(school.id, alertId, now));

  /** The child's register at `time` on `date`, as the class teacher. */
  async function register(
    ctx: { teacher: Caller; section: TestSection; child: Child },
    status: string,
    date = T,
    time = '08:00',
  ) {
    h.clockAt(at(date === T ? T : date, time));
    if (date !== T) h.clockAt(at(T, time));
    const res = await h.submit(ctx.teacher.cookie, ctx.section, { date, marks: marks([ctx.child], status) });
    expect(res.status).toBe(201);
    return (res.body as { marks: { id: string }[]; alerts: Alerts });
  }

  describe('R126 the timing table (absence alert time 09:30)', () => {
    it('R126: absent at 08:00 → one absence row due 09:30, enqueued after commit; at 09:30 one absence_alert is sent', async () => {
      const ctx = await fresh();
      const { alerts } = await register(ctx, 'absent');
      expect(alerts).toEqual({ absencePending: 1, absenceBackdated: 0, lateAdvicePending: 0, cancelled: 0, corrections: 0 });
      const [row] = await alertsOf(ctx.school, ctx.child);
      expect(row).toMatchObject({ kind: 'absence', seq: 1, status: 'pending', dueAt: at(T, '09:30') });
      expect(h.alertJobs).toEqual([expect.objectContaining({ id: row?.id, dueAt: at(T, '09:30') })]);
      expect(h.rollupJobs).toEqual([expect.objectContaining({ sectionId: ctx.section.id, date: T })]);

      expect(await runAlert(ctx.school, row?.id ?? 0n, at(T, '09:29'))).toBe('none');
      expect(await runAlert(ctx.school, row?.id ?? 0n, at(T, '09:30'))).toBe('sent');
      const messages = await messagesOf(ctx.school, ctx.child.guardianId);
      expect(messages).toEqual([
        expect.objectContaining({ type: 'absence_alert', subjectType: 'attendance_alert', subjectId: row?.id }),
      ]);
      expect(messages[0]?.body).toMatch(/^Iqra Model School: Ayesha Siddiqui \(Class 5 A\) is absent today, \w{3} \d{1,2} \w{3}\. Contact the school if unexpected\.$/);
      expect((await alertsOf(ctx.school, ctx.child))[0]?.status).toBe('sent');
    });

    it('R126: a replayed job sends exactly once (the claim finds the row no longer pending)', async () => {
      const ctx = await fresh();
      await register(ctx, 'absent');
      const [row] = await alertsOf(ctx.school, ctx.child);
      expect(await runAlert(ctx.school, row?.id ?? 0n, at(T, '09:31'))).toBe('sent');
      expect(await runAlert(ctx.school, row?.id ?? 0n, at(T, '09:32'))).toBe('none');
      expect(await messagesOf(ctx.school, ctx.child.guardianId)).toHaveLength(1);
    });

    it.each([
      ['09:20', '09:50'],
      ['14:00', '14:30'],
    ])('R126: absent at %s → due %s (now + 30 minutes)', async (time, due) => {
      const ctx = await fresh();
      await register(ctx, 'absent', T, time);
      expect((await alertsOf(ctx.school, ctx.child))[0]?.dueAt).toEqual(at(T, due));
    });

    it("R126: yesterday's register marked absent creates the row as cancelled:backdated and sends nothing", async () => {
      const ctx = await fresh();
      const { alerts } = await register(ctx, 'absent', Y);
      expect(alerts).toMatchObject({ absencePending: 0, absenceBackdated: 1 });
      expect(await alertsOf(ctx.school, ctx.child)).toEqual([
        expect.objectContaining({ kind: 'absence', status: 'cancelled', cancelReason: 'backdated' }),
      ]);
      expect(h.alertJobs).toEqual([]);
    });

    it('R126, R168: an arrival at 08:40 cancels the absence alert and (late advice on) a late_advice goes at 09:30 with the time', async () => {
      const ctx = await fresh({ lateAdviceEnabled: true });
      await register(ctx, 'absent');
      h.clockAt(at(T, '08:40'));
      const arrival = await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' }, ctx.office.cookie);
      expect(arrival.status).toBe(200);
      const rows = await alertsOf(ctx.school, ctx.child);
      expect(rows).toEqual([
        expect.objectContaining({ kind: 'absence', status: 'cancelled', cancelReason: 'mark_changed' }),
        expect.objectContaining({ kind: 'late', status: 'pending', dueAt: at(T, '09:30') }),
      ]);
      expect(await runAlert(ctx.school, rows[0]?.id ?? 0n, at(T, '09:30'))).toBe('none');
      expect(await runAlert(ctx.school, rows[1]?.id ?? 0n, at(T, '09:30'))).toBe('sent');
      const [message] = await messagesOf(ctx.school, ctx.child.guardianId);
      expect(message).toMatchObject({ type: 'late_advice', subjectId: rows[1]?.id });
      expect(message?.body).toMatch(/Ayesha Siddiqui \(Class 5 A\) arrived late today, .* at 08:40\.$/);
    });

    it('R126: with late advice off, an arrival at 08:40 cancels the absence alert and nothing is sent', async () => {
      const ctx = await fresh({ lateAdviceEnabled: false });
      await register(ctx, 'absent');
      h.clockAt(at(T, '08:40'));
      await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' }, ctx.office.cookie);
      expect(await alertsOf(ctx.school, ctx.child)).toEqual([
        expect.objectContaining({ kind: 'absence', status: 'cancelled', cancelReason: 'mark_changed' }),
      ]);
    });

    it('R126: an arrival at 10:00 after the 09:30 alert is a correction, not a late advice: "now marked late (arrived 10:00)"', async () => {
      const ctx = await fresh({ lateAdviceEnabled: true });
      await register(ctx, 'absent');
      const [absence] = await alertsOf(ctx.school, ctx.child);
      await runAlert(ctx.school, absence?.id ?? 0n, at(T, '09:30'));
      h.clockAt(at(T, '10:00'));
      await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '10:00' }, ctx.office.cookie);
      const rows = await alertsOf(ctx.school, ctx.child);
      expect(rows.map((r) => [r.kind, r.seq, r.status])).toEqual([
        ['absence', 1, 'sent'],
        ['corrected', 1, 'pending'],
      ]);
      expect(rows[1]?.dueAt).toEqual(at(T, '10:00'));
      expect(await runAlert(ctx.school, rows[1]?.id ?? 0n, at(T, '10:00'))).toBe('sent');
      const sent = await messagesOf(ctx.school, ctx.child.guardianId);
      expect(sent.map((m) => m.type)).toEqual(['absence_alert', 'attendance_corrected']);
      expect(sent[1]?.body).toMatch(/Correction for Ayesha Siddiqui \(Class 5 A\), .*: now marked late \(arrived 10:00\)\.$/);
    });
  });

  describe('R126 corrections, reversals and caps', () => {
    it('R126: absent → present before it was sent cancels it; absent again takes seq 2', async () => {
      const ctx = await fresh();
      const { marks: [mark] } = await register(ctx, 'absent');
      const amend = (from: string, to: string) =>
        h.post(`/attendance-marks/${mark?.id}/amend`, { fromStatus: from, status: to, reason: 'Teacher corrected' }, ctx.teacher.cookie);
      await amend('absent', 'present');
      await amend('present', 'absent');
      expect((await alertsOf(ctx.school, ctx.child)).map((r) => [r.kind, r.seq, r.status, r.cancelReason])).toEqual([
        ['absence', 1, 'cancelled', 'mark_changed'],
        ['absence', 2, 'pending', null],
      ]);
    });

    it('R126: after a sent alert every real change is one corrected notice (a pending one debounces), capped at three with correctionsCapped', async () => {
      const ctx = await fresh();
      const { marks: [mark] } = await register(ctx, 'absent');
      const [absence] = await alertsOf(ctx.school, ctx.child);
      await runAlert(ctx.school, absence?.id ?? 0n, at(T, '09:30'));
      h.clockAt(at(T, '10:00'));
      let current = 'absent';
      const flip = async (to: string) => {
        const res = await h.post(`/attendance-marks/${mark?.id}/amend`, { fromStatus: current, status: to, reason: 'Office corrected' }, ctx.principal.cookie);
        expect(res.status).toBe(200);
        current = to;
      };
      const processPending = async () => {
        for (const row of await alertsOf(ctx.school, ctx.child)) {
          if (row.status === 'pending') await runAlert(ctx.school, row.id, at(T, '10:05'));
        }
      };
      await flip('present');
      await flip('on_leave'); // debounced: the pending correction will state the day when sent
      expect((await alertsOf(ctx.school, ctx.child)).filter((r) => r.kind === 'corrected')).toHaveLength(1);
      await processPending();
      expect((await messagesOf(ctx.school, ctx.child.guardianId)).at(-1)?.body).toMatch(/now marked on leave\.$/);
      await flip('absent'); // the reversal: a further corrected notice stating absent
      await processPending();
      expect((await messagesOf(ctx.school, ctx.child.guardianId)).at(-1)?.body).toMatch(/now marked absent\.$/);
      await flip('present');
      await processPending();
      type Roster = { roster: { alert: { absence: string; corrections: number; correctionsCapped: boolean } }[] };
      const alertState = async () =>
        ((await h.get(`/sections/${ctx.section.id}/register?date=${T}&period=1`, ctx.principal.cookie)).body as Roster)
          .roster[0]?.alert;
      // Three sent and none refused yet: not capped.
      expect(await alertState()).toMatchObject({ absence: 'sent', corrections: 3, correctionsCapped: false });
      await flip('absent'); // a fourth would be sent: capped
      const corrected = (await alertsOf(ctx.school, ctx.child)).filter((r) => r.kind === 'corrected');
      expect(corrected.map((r) => [r.seq, r.status, r.cappedAt !== null])).toEqual([
        [1, 'sent', false],
        [2, 'sent', false],
        [3, 'sent', true],
      ]);
      const audit = await db.auditLog.findMany({
        where: { schoolId: ctx.school.id, action: 'attendance_mark.amended' },
        orderBy: { id: 'asc' },
      });
      expect(audit.at(-1)?.metadata).toMatchObject({ correctionCapped: true });
      expect(await alertState()).toMatchObject({ absence: 'sent', corrections: 3, correctionsCapped: true });
      // The absence alert and three corrections; the refused fourth sent nothing.
      expect((await messagesOf(ctx.school, ctx.child.guardianId)).map((m) => m.type)).toEqual([
        'absence_alert',
        'attendance_corrected',
        'attendance_corrected',
        'attendance_corrected',
      ]);
    });

    it('R126: a fourth absence row of a child-day is refused and recorded as the cap on the third', async () => {
      const ctx = await fresh();
      const { marks: [mark] } = await register(ctx, 'absent');
      let current = 'absent';
      const flip = async (to: string) => {
        const res = await h.post(`/attendance-marks/${mark?.id}/amend`, { fromStatus: current, status: to, reason: 'Teacher corrected' }, ctx.teacher.cookie);
        expect(res.status).toBe(200);
        current = to;
      };
      for (const to of ['present', 'absent', 'present', 'absent', 'present']) await flip(to);
      const absences = () => alertsOf(ctx.school, ctx.child).then((rows) => rows.filter((r) => r.kind === 'absence'));
      expect((await absences()).map((r) => [r.seq, r.status, r.cappedAt !== null])).toEqual([
        [1, 'cancelled', false],
        [2, 'cancelled', false],
        [3, 'cancelled', false],
      ]);
      await flip('absent'); // seq 4 would be due: refused
      expect((await absences()).map((r) => [r.seq, r.cappedAt !== null])).toEqual([
        [1, false],
        [2, false],
        [3, true],
      ]);
      const roster = (await h.get(`/sections/${ctx.section.id}/register?date=${T}&period=1`, ctx.principal.cookie)).body as {
        roster: { alert: { correctionsCapped: boolean } }[];
      };
      expect(roster.roster[0]?.alert.correctionsCapped).toBe(true);
    });

    it('R126: the processor re-reads the day — an absence row whose day turned late is cancelled and (late advice on) a late advice is sent as its own row', async () => {
      const ctx = await fresh({ lateAdviceEnabled: true });
      await register(ctx, 'absent');
      const [absence] = await alertsOf(ctx.school, ctx.child);
      // A race the writer did not see: the mark changed under a direct, audited-by-trigger update.
      await withActor(ctx.principal.userId, `UPDATE attendance_marks SET status = 'late', arrived_at = '08:50'
                                             WHERE school_id = ${ctx.school.id} AND enrolment_id = ${ctx.child.enrolmentId}`);
      expect(await runAlert(ctx.school, absence?.id ?? 0n, at(T, '09:30'))).toBe('cancelled');
      expect((await alertsOf(ctx.school, ctx.child)).map((r) => [r.kind, r.status, r.cancelReason])).toEqual([
        ['absence', 'cancelled', 'mark_changed'],
        ['late', 'sent', null],
      ]);
      expect((await messagesOf(ctx.school, ctx.child.guardianId)).map((m) => m.type)).toEqual(['late_advice']);
    });
  });

  describe('R126 recipients, resolved at send time', () => {
    it('R126: primary contacts only; with no primary, every live guardian with a login or a phone; none left → cancelled:link_ended', async () => {
      const ctx = await fresh();
      const second = await guardian(db, ctx.school, { phone: null });
      await linkGuardian(db, ctx.school, { id: ctx.child.studentId }, second, { isPrimaryContact: false, relationship: 'mother' });
      await register(ctx, 'absent');
      const [row] = await alertsOf(ctx.school, ctx.child);
      await runAlert(ctx.school, row?.id ?? 0n, at(T, '09:30'));
      expect(await messagesOf(ctx.school, ctx.child.guardianId)).toHaveLength(1);
      expect(await messagesOf(ctx.school, second.id)).toHaveLength(0);

      // No primary: the one with a phone is told; the one with neither login nor phone is not.
      const other = await fresh();
      await db.studentGuardian.updateMany({ where: { schoolId: other.school.id }, data: { isPrimaryContact: false } });
      const silent = await guardian(db, other.school, { phone: null });
      await linkGuardian(db, other.school, { id: other.child.studentId }, silent, { isPrimaryContact: false, relationship: 'mother' });
      await register(other, 'absent');
      const [r2] = await alertsOf(other.school, other.child);
      await runAlert(other.school, r2?.id ?? 0n, at(T, '09:30'));
      expect(await messagesOf(other.school, other.child.guardianId)).toHaveLength(1);
      expect(await messagesOf(other.school, silent.id)).toHaveLength(0);

      // Every link ended before the alert was due.
      const third = await fresh();
      await register(third, 'absent');
      await db.studentGuardian.updateMany({ where: { schoolId: third.school.id }, data: { endedAt: new Date() } });
      const [r3] = await alertsOf(third.school, third.child);
      expect(await runAlert(third.school, r3?.id ?? 0n, at(T, '09:30'))).toBe('cancelled');
      expect((await alertsOf(third.school, third.child))[0]).toMatchObject({ status: 'cancelled', cancelReason: 'link_ended' });
    });

    it.each([
      ['keypad', { capability: 'keypad' as const }, ['sms']],
      ['whatsapp', { capability: 'whatsapp' as const }, ['whatsapp']],
      ['smartphone_data without a device', { capability: 'smartphone_data' as const, guardianLogin: true }, ['sms']],
    ])('R126, rule 17: a %s guardian — from submit to delivery rows', async (_label, childOpts, channels) => {
      const ctx = await fresh({}, childOpts);
      await connectedNumber(db, ctx.school);
      await register(ctx, 'absent');
      const [row] = await alertsOf(ctx.school, ctx.child);
      expect(await runAlert(ctx.school, row?.id ?? 0n, at(T, '09:30'))).toBe('sent');
      const [message] = await messagesOf(ctx.school, ctx.child.guardianId);
      expect(message?.type).toBe('absence_alert');
      await asSchool(h.app, ctx.school.id, () => messageProcessor.run(ctx.school.id, message?.id ?? 0n, at(T, '09:31')));
      const deliveries = await db.messageDelivery.findMany({ where: { schoolId: ctx.school.id, messageId: message?.id ?? 0n } });
      expect(deliveries.map((d) => d.channel)).toEqual(expect.arrayContaining(channels));
      expect(deliveries.every((d) => d.channel !== 'push')).toBe(true);
      expect(h.drivers.calls.map((c) => c.channel)).toEqual(expect.arrayContaining(channels));
    });
  });

  // Plan §9 (phase gate): each contact capability from a register submit to its delivery rows for
  // the late advice and the corrected notice. Both types are `normal` priority and in the SMS
  // allow-list default (packages/shared MESSAGE_TYPE_TABLE; schema default of
  // school_settings.sms_allowed_types, register item 22). Expected legs follow
  // src/messaging/routing.ts planChannels; `in_app` never writes a delivery row, so it is left out.
  describe('plan §9, rule 17: late advice and corrected notice reach each capability (R106, R126)', () => {
    type ChildOpts = Parameters<AttendanceHarness['child']>[2];
    type Row = [channel: string, status: string, error: string | null];
    const accepted = (channel: string): Row => [channel, 'accepted', null];
    const cases: [label: string, childOpts: ChildOpts, external: string[], rows: Row[]][] = [
      // routing.ts guardian_keypad, normal: sms(true) — SMS is the only leg.
      ['keypad', { capability: 'keypad' }, ['sms'], [accepted('sms')]],
      // routing.ts guardian_whatsapp, normal, W (number connected, phone held): whatsapp, then the
      // after-failure sms* (isAfterFailureSms). WhatsApp was accepted, so sms* is never attempted.
      ['whatsapp', { capability: 'whatsapp' }, ['whatsapp', 'sms'], [accepted('whatsapp')]],
      // routing.ts guardian_smartphone_data, normal, no live device: push(D) absent, sms(!D) — SMS.
      ['smartphone_data without a device', { capability: 'smartphone_data', guardianLogin: true }, ['sms'], [accepted('sms')]],
      // routing.ts guardian_smartphone_data, normal, live device: push(D); sms(!D) is not planned.
      ['smartphone_data with a device', { capability: 'smartphone_data', device: true }, ['push'], [accepted('push')]],
    ];

    const deliveriesOf = async (school: TestSchool, messageId: bigint): Promise<Row[]> =>
      (await db.messageDelivery.findMany({ where: { schoolId: school.id, messageId }, orderBy: { id: 'asc' } }))
        .map((d) => [d.channel, d.status, d.errorCode]);
    const deliver = (school: TestSchool, messageId: bigint, now: Date) =>
      asSchool(h.app, school.id, () => messageProcessor.run(school.id, messageId, now));
    const externalPlan = (plan: readonly string[]) => plan.filter((c) => c !== 'in_app');

    it('the school settings default allows SMS for late_advice and attendance_corrected (register item 22)', async () => {
      const school = await h.school();
      const settings = await db.schoolSettings.findFirst({ where: { schoolId: school.id } });
      expect(settings?.smsAllowedTypes).toEqual(expect.arrayContaining(['late_advice', 'attendance_corrected']));
    });

    it.each(cases)(
      'R126: a %s guardian — absent at 08:00, alert at 09:30, arrival at 10:00 → attendance_corrected delivery rows',
      async (_label, childOpts, external, expected) => {
        const ctx = await fresh({ lateAdviceEnabled: true }, childOpts);
        await connectedNumber(db, ctx.school);
        await register(ctx, 'absent');
        const [absence] = await alertsOf(ctx.school, ctx.child);
        expect(await runAlert(ctx.school, absence?.id ?? 0n, at(T, '09:30'))).toBe('sent');
        const [absenceMessage] = await messagesOf(ctx.school, ctx.child.guardianId);
        expect(await deliver(ctx.school, absenceMessage?.id ?? 0n, at(T, '09:31'))).toBe('finished');

        h.clockAt(at(T, '10:00'));
        const arrival = await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '10:00' }, ctx.office.cookie);
        expect(arrival.status).toBe(200);
        const corrected = (await alertsOf(ctx.school, ctx.child)).find((r) => r.kind === 'corrected');
        expect(await runAlert(ctx.school, corrected?.id ?? 0n, at(T, '10:00'))).toBe('sent');
        const messages = await messagesOf(ctx.school, ctx.child.guardianId);
        expect(messages.map((m) => m.type)).toEqual(['absence_alert', 'attendance_corrected']);
        const message = messages[1];
        expect(message?.priority).toBe('normal');
        expect(externalPlan(message?.channelPlan ?? [])).toEqual(external);

        h.drivers.calls.length = 0;
        expect(await deliver(ctx.school, message?.id ?? 0n, at(T, '10:01'))).toBe('finished');
        expect(await deliveriesOf(ctx.school, message?.id ?? 0n)).toEqual(expected);
        expect(h.drivers.calls.map((c) => c.channel)).toEqual(expected.map(([channel]) => channel));
        expect(h.drivers.of('sms').every((c) => /now marked late \(arrived 10:00\)\.$/.test(c.text ?? ''))).toBe(true);
        expect((await db.message.findFirst({ where: { schoolId: ctx.school.id, id: message?.id ?? 0n } }))?.status).toBe('sent');
      },
    );

    it.each(cases)(
      'R126: a %s guardian — absent at 08:00, arrival at 08:40 (late advice on) → late_advice delivery rows at 09:30',
      async (_label, childOpts, external, expected) => {
        const ctx = await fresh({ lateAdviceEnabled: true }, childOpts);
        await connectedNumber(db, ctx.school);
        await register(ctx, 'absent');
        h.clockAt(at(T, '08:40'));
        const arrival = await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' }, ctx.office.cookie);
        expect(arrival.status).toBe(200);
        const rows = await alertsOf(ctx.school, ctx.child);
        expect(rows.map((r) => [r.kind, r.status])).toEqual([
          ['absence', 'cancelled'],
          ['late', 'pending'],
        ]);
        expect(await runAlert(ctx.school, rows[1]?.id ?? 0n, at(T, '09:30'))).toBe('sent');
        const messages = await messagesOf(ctx.school, ctx.child.guardianId);
        expect(messages.map((m) => m.type)).toEqual(['late_advice']);
        const message = messages[0];
        expect(message?.priority).toBe('normal');
        expect(externalPlan(message?.channelPlan ?? [])).toEqual(external);

        expect(await deliver(ctx.school, message?.id ?? 0n, at(T, '09:31'))).toBe('finished');
        expect(await deliveriesOf(ctx.school, message?.id ?? 0n)).toEqual(expected);
        expect(h.drivers.calls.map((c) => c.channel)).toEqual(expected.map(([channel]) => channel));
        expect(h.drivers.of('sms').every((c) => /arrived late today, .* at 08:40\.$/.test(c.text ?? ''))).toBe(true);
      },
    );

    it('R106: a WhatsApp guardian whose WhatsApp leg fails permanently gets the corrected notice by the after-failure SMS', async () => {
      const ctx = await fresh({}, { capability: 'whatsapp' });
      await connectedNumber(db, ctx.school);
      await register(ctx, 'absent');
      const [absence] = await alertsOf(ctx.school, ctx.child);
      await runAlert(ctx.school, absence?.id ?? 0n, at(T, '09:30'));
      const [absenceMessage] = await messagesOf(ctx.school, ctx.child.guardianId);
      await deliver(ctx.school, absenceMessage?.id ?? 0n, at(T, '09:31'));

      h.clockAt(at(T, '10:00'));
      await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '10:00' }, ctx.office.cookie);
      const corrected = (await alertsOf(ctx.school, ctx.child)).find((r) => r.kind === 'corrected');
      await runAlert(ctx.school, corrected?.id ?? 0n, at(T, '10:00'));
      const message = (await messagesOf(ctx.school, ctx.child.guardianId))[1];
      expect(message?.type).toBe('attendance_corrected');
      h.drivers.failWhatsApp('not_on_whatsapp'); // permanent for WhatsApp (legs.ts PERMANENT_FAILURES)
      expect(await deliver(ctx.school, message?.id ?? 0n, at(T, '10:01'))).toBe('finished');
      expect(await deliveriesOf(ctx.school, message?.id ?? 0n)).toEqual([
        ['whatsapp', 'failed', 'not_on_whatsapp'],
        accepted('sms'),
      ]);
    });

    it('R109: with late_advice removed from the allow list, a keypad guardian gets one suppressed (not_allowed) SMS row and no SMS', async () => {
      const ctx = await fresh({ lateAdviceEnabled: true }, { capability: 'keypad' });
      await db.schoolSettings.updateMany({
        where: { schoolId: ctx.school.id },
        data: { smsAllowedTypes: ['absence_alert', 'attendance_corrected', 'announcement_urgent', 'holiday_notice'] },
      });
      await register(ctx, 'absent');
      h.clockAt(at(T, '08:40'));
      await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' }, ctx.office.cookie);
      const late = (await alertsOf(ctx.school, ctx.child)).find((r) => r.kind === 'late');
      expect(await runAlert(ctx.school, late?.id ?? 0n, at(T, '09:30'))).toBe('sent');
      const [message] = await messagesOf(ctx.school, ctx.child.guardianId);
      // routing.ts: the keypad SMS leg fails only predicate A and is the only external leg, so the
      // plan is empty and the leg is recorded as suppressed: not_allowed (slice-9 §7.4).
      expect(message).toMatchObject({ type: 'late_advice', status: 'suppressed', suppressedReason: 'not_allowed' });
      expect(externalPlan(message?.channelPlan ?? [])).toEqual([]);
      const deliveries = await db.messageDelivery.findMany({ where: { schoolId: ctx.school.id, messageId: message?.id ?? 0n } });
      expect(deliveries.map((d) => [d.channel, d.status, d.suppressedReason])).toEqual([['sms', 'suppressed', 'not_allowed']]);
      expect(h.drivers.of('sms')).toEqual([]);
    });
  });

  describe('R168 the gate', () => {
    it('R168: an arrival on a first-absent day makes the mark late with arrivedAt, the automatic reason and an arrivals row; a replay is 200 and writes nothing', async () => {
      const ctx = await fresh();
      const { marks: [mark] } = await register(ctx, 'absent');
      const body = { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' };
      const res = await h.post('/attendance-arrivals', body, ctx.office.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: mark?.id, status: 'late', arrivedAt: '08:40', amended: true });
      const changes = await db.attendanceMarkChange.findMany({ where: { schoolId: ctx.school.id } });
      expect(changes).toEqual([
        expect.objectContaining({ oldStatus: 'absent', newStatus: 'late', reason: 'Arrived at 08:40', changedBy: ctx.office.userId }),
      ]);
      expect(await db.attendanceArrival.count({ where: { schoolId: ctx.school.id } })).toBe(1);
      expect((await h.post('/attendance-arrivals', body, ctx.office.cookie)).status).toBe(200);
      expect(await db.attendanceArrival.count({ where: { schoolId: ctx.school.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { schoolId: ctx.school.id, action: 'attendance_mark.arrival_recorded' } })).toBe(1);
    });

    it('R168: a present, late (other time) or unrecorded first mark is 409 ARRIVAL_NOT_ABSENT with its status', async () => {
      const ctx = await fresh();
      const none = await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' }, ctx.office.cookie);
      expect(errorOf(none)).toMatchObject({ code: 'ARRIVAL_NOT_ABSENT', details: { status: null } });
      await register(ctx, 'present');
      const present = await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' }, ctx.office.cookie);
      expect(errorOf(present)).toMatchObject({ code: 'ARRIVAL_NOT_ABSENT', details: { status: 'present' } });
      const outsider = await h.caller(ctx.school, 'teacher');
      const hidden = await h.post('/attendance-arrivals', { studentId: ctx.child.studentId.toString(), date: T, arrivedAt: '08:40' }, outsider.cookie);
      expect(hidden.status).toBe(404);
    });

    it('R168, R127: only the lowest-period mark changes; a second absent period stays and the day derives partial', async () => {
      const school = await h.school({ periodsPerDay: 4 });
      const office = await h.caller(school, 'office_staff');
      const section = await h.section(school, { mode: 'period' });
      const child = await h.child(school, section);
      for (const period of [1, 2]) {
        expect((await h.submit(office.cookie, section, { date: T, period, marks: marks([child], 'absent') })).status).toBe(201);
      }
      await h.post('/attendance-arrivals', { studentId: child.studentId.toString(), date: T, arrivedAt: '09:05' }, office.cookie);
      const rows = await db.attendanceMark.findMany({ where: { schoolId: school.id }, orderBy: { period: 'asc' } });
      expect(rows.map((r) => [r.period, r.status])).toEqual([
        [1, 'late'],
        [2, 'absent'],
      ]);
      const result = (await h.get(`/students/${child.studentId}/attendance?dateFrom=${T}&dateTo=${T}`, office.cookie)).body as {
        days: { periods: { period: number; status: string; arrivedAt: string | null }[] }[];
      };
      expect(result.days[0]?.periods).toEqual([
        { period: 1, status: 'late', arrivedAt: '09:05' },
        { period: 2, status: 'absent', arrivedAt: null },
      ]);
    });
  });

  describe('R167 holidays after the fact', () => {
    it('R167: publishing a holiday over a recorded day cancels its pending alerts (holiday), keeps the register and flags the console; cancelling restores the day', async () => {
      const ctx = await fresh();
      await register(ctx, 'absent');
      const created = await h.post('/holidays', { startsOn: T, name: 'Rain closure', kind: 'school' }, ctx.principal.cookie);
      expect(created.status).toBe(201);
      const id = (created.body as { id: string }).id;
      expect((await h.post(`/holidays/${id}/publish`, {}, ctx.principal.cookie)).status).toBe(200);
      expect(await alertsOf(ctx.school, ctx.child)).toEqual([
        expect.objectContaining({ status: 'cancelled', cancelReason: 'holiday' }),
      ]);
      expect(await db.attendanceRegister.count({ where: { schoolId: ctx.school.id } })).toBe(1);
      const console = await h.get(`/attendance-registers?date=${T}&recorded=true`, ctx.principal.cookie);
      expect((console.body as { data: unknown[] }).data).toEqual([expect.objectContaining({ declaredHolidayAfter: true })]);
      const read = await h.get(`/sections/${ctx.section.id}/register?date=${T}&period=1`, ctx.principal.cookie);
      expect(read.body).toMatchObject({ teachingDay: false, amendable: false, register: expect.objectContaining({ teachingDay: false }) as unknown });
      const resubmit = await h.submit(ctx.principal.cookie, ctx.section, { date: T, marks: marks([ctx.child], 'present'), reason: 'x y z' });
      expect(errorOf(resubmit).code).toBe('NOT_A_TEACHING_DAY');

      expect((await h.post(`/holidays/${id}/cancel`, { reason: 'Weather cleared' }, ctx.principal.cookie)).status).toBe(200);
      const after = await h.get(`/attendance-registers?date=${T}&recorded=true`, ctx.principal.cookie);
      expect((after.body as { data: unknown[] }).data).toEqual([expect.objectContaining({ declaredHolidayAfter: false })]);
      // Cancelled alerts are not revived.
      expect((await alertsOf(ctx.school, ctx.child))[0]?.status).toBe('cancelled');
    });

    it('R167: a holiday published after the listener missed it is caught at send time (cancelled:holiday)', async () => {
      const ctx = await fresh();
      await register(ctx, 'absent');
      await db.holiday.create({
        data: { schoolId: ctx.school.id, startsOn: new Date(`${T}T00:00:00Z`), endsOn: new Date(`${T}T00:00:00Z`), name: 'Sudden', kind: 'public', status: 'published', publishedAt: new Date(), publishedBy: ctx.principal.userId },
      });
      const [row] = await alertsOf(ctx.school, ctx.child);
      expect(await runAlert(ctx.school, row?.id ?? 0n, at(T, '09:30'))).toBe('cancelled');
      expect((await alertsOf(ctx.school, ctx.child))[0]?.cancelReason).toBe('holiday');
    });
  });

  describe('§1.6 the alert row lock (R126: locked by both the sender and the amend path)', () => {
    it('R126: an amend waits for a sender holding the child-day alert lock, then sees it sent and writes a correction', async () => {
      const ctx = await fresh();
      const { marks: [mark] } = await register(ctx, 'absent');
      const [row] = await alertsOf(ctx.school, ctx.child);
      const pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      try {
        await pg.query('BEGIN');
        await pg.query('SELECT id FROM attendance_alerts WHERE school_id = $1 AND id = $2 FOR UPDATE', [ctx.school.id, row?.id]);
        h.clockAt(at(T, '09:40'));
        let settled = false;
        const amend = h
          .post(`/attendance-marks/${mark?.id}/amend`, { fromStatus: 'absent', status: 'present', reason: 'Was in the library' }, ctx.teacher.cookie)
          .finally(() => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        await pg.query(`UPDATE attendance_alerts SET status = 'sent', updated_at = now() WHERE school_id = $1 AND id = $2`, [ctx.school.id, row?.id]);
        await pg.query('COMMIT');
        expect((await amend).status).toBe(200);
      } finally {
        await pg.end();
      }
      expect((await alertsOf(ctx.school, ctx.child)).map((r) => [r.kind, r.status])).toEqual([
        ['absence', 'sent'],
        ['corrected', 'pending'],
      ]);
    });
  });

  it('R113: a job payload naming school B with an alert of school A touches nothing', async () => {
    const a = await fresh();
    await register(a, 'absent');
    const [row] = await alertsOf(a.school, a.child);
    const b = await h.school();
    const runner = h.app.get(JobRunner, { strict: false });
    expect(await runner.attendance('attendance-alert', { schoolId: b.id.toString(), alertId: row?.id.toString() }, at(T, '10:00'))).toBe('done');
    expect((await alertsOf(a.school, a.child))[0]?.status).toBe('pending');
    expect(await runner.attendance('attendance-alert', { schoolId: a.school.id.toString(), alertId: 'x' })).toBe('dropped');
    expect(await runner.attendance('attendance-alert', { schoolId: a.school.id.toString(), alertId: row?.id.toString() }, at(T, '10:00'))).toBe('done');
    expect((await alertsOf(a.school, a.child))[0]?.status).toBe('sent');
  });

  /** A statement with the transaction-local actor and reason set, as ChangeContextRepository does. */
  async function withActor(actor: bigint, sql: string): Promise<void> {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      await pg.query('BEGIN');
      await pg.query(`SELECT set_config('asms.actor_user_id', $1, true), set_config('asms.change_reason', 'test race', true)`, [actor.toString()]);
      await pg.query(sql);
      await pg.query('COMMIT');
    } finally {
      await pg.end();
    }
  }
});
