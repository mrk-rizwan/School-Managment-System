// Slice 22's fee reminders (phase-3-financial.md §1.1 "Reminder cadence", §3.7; contracts/slice-22.md
// §3): the due reminder once per family per due month (R201), skipped while a pending claim covers
// the family's dues; the overdue reminders on the cadence, at most two a month, oldest debts first
// (R202); the SMS allowance spent family by family and the principals told once (R250); the manual
// send under the same caps. The real AppModule and database; the job body as the worker runs it.
import { NestExpressApplication } from '@nestjs/platform-express';
import type { MessageType } from '@asms/shared';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { createGuardian, isoDay } from '../support/students';
import { db, karachi, pupil, runMonth } from '../fees/charges-support';
import { monthOf, reportsHttp, type ReportsWorld } from './support';

const ym = (iso: string): bigint => BigInt(Number(iso.slice(0, 4)) * 100 + Number(iso.slice(5, 7)));

describe('slice 22: fee reminders (e2e)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);
  const { post, err } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const reminders = (w: ReportsWorld, type?: MessageType) =>
    db().message.findMany({
      where: { schoolId: w.school.id, subjectType: 'fee_reminder', ...(type === undefined ? {} : { type }) },
      orderBy: { id: 'asc' },
    });

  /** A message the school sent earlier (R107's subjects are the cadence's facts). */
  const earlier = (w: ReportsWorld, guardianId: bigint, subjectId: bigint, daysAgo: number) =>
    db().message.create({
      data: {
        schoolId: w.school.id,
        type: 'fee_overdue',
        priority: 'normal',
        subjectType: 'fee_reminder',
        subjectId,
        guardianId,
        body: 'Iqra Model School: Fees overdue.',
        channelPlan: ['sms'],
        status: 'sent',
        finishedAt: new Date(),
        createdAt: new Date(Date.now() - daysAgo * 86_400_000),
      },
    });

  it('R201: a due reminder goes once per family per due month, naming the children and the total; a covering claim skips the family', async () => {
    const w = await h.world();
    await h.manualCharge(w, w.a, 1000, isoDay(2));
    await h.manualCharge(w, w.c, 2000, isoDay(2));
    // A third family whose only charge is due in ten days: outside feeReminderDaysBefore (3).
    const g3 = await createGuardian(db(), w.school, { fullName: 'Sana Ali' });
    const d = await pupil(w.school, w.section, { startedOn: isoDay(0), fullName: 'Daniyal Ali', guardianId: g3.id });
    await h.manualCharge(w, d, 4000, isoDay(10));
    // Zainab's family has a pending claim covering everything it owes.
    await db().studentGuardian.updateMany({ where: { schoolId: w.school.id, studentId: w.c.studentId }, data: { canLogin: true } });
    await db().paymentClaim.create({
      data: {
        schoolId: w.school.id,
        studentId: w.c.studentId,
        guardianId: w.g2,
        method: 'jazzcash',
        claimedAmount: 5000,
        paidOn: new Date(`${isoDay(0)}T00:00:00.000Z`),
        reference: 'JC-5000',
      },
    });

    const first = await h.reminders(w);
    expect(first.due).toEqual(expect.objectContaining({ families: 1 }));
    expect(first.overdue).toEqual(expect.objectContaining({ families: 1 }));
    const due = await reminders(w, 'fee_due_reminder');
    expect(due.map((m) => [m.guardianId, m.subjectId])).toEqual([[w.g1, ym(isoDay(2)) * 10n]]);
    expect(due[0]?.body).toContain('Fee reminder: Rs 7,000 for Hamza Tariq, Hira Tariq is due');
    const overdue = await reminders(w, 'fee_overdue');
    expect(overdue.map((m) => [m.guardianId, m.subjectId])).toEqual([[w.g1, ym(isoDay(0)) * 10n + 1n]]);
    expect(overdue[0]?.body).toContain(`Fees overdue: Rs 6,000 for Hamza Tariq, Hira Tariq, unpaid since`);

    // The next run sends nothing new: the due month's subject exists, the cadence holds.
    const second = await h.reminders(w);
    expect([second.due.families, second.overdue.families]).toEqual([0, 0]);
    expect(await reminders(w)).toHaveLength(2);
    // Audited as the system actor, once per run that reminded someone (A19).
    const audit = await h.audit(w.school, 'fee_reminder.scheduled_sent');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBeNull();
  });

  it('R202: the overdue cadence — every overdueReminderEveryDays, at most two a month', async () => {
    const w = await h.world();
    const month = ym(isoDay(0));
    // Tariq's family was reminded 20 days ago (this month's first), so a second is due now.
    await earlier(w, w.g1, month * 10n + 1n, 20);
    // Nadia's family has had this month's two already.
    await earlier(w, w.g2, month * 10n + 1n, 25);
    await earlier(w, w.g2, month * 10n + 2n, 15);
    const run = await h.reminders(w);
    expect(run.overdue.families).toBe(1);
    const sent = (await reminders(w, 'fee_overdue')).filter((m) => m.createdAt.getTime() > Date.now() - 60_000);
    expect(sent.map((m) => [m.guardianId, m.subjectId])).toEqual([[w.g1, month * 10n + 2n]]);

    // A family reminded 5 days ago waits for the cadence, whatever the month says.
    const w2 = await h.world();
    await earlier(w2, w2.g1, ym(isoDay(-31)) * 10n + 1n, 5);
    const waiting = await h.reminders(w2);
    expect(waiting.overdue.families).toBe(1); // only Nadia's family
    expect((await reminders(w2, 'fee_overdue')).filter((m) => m.guardianId === w2.g1)).toHaveLength(1);
  });

  it('R250: past the SMS allowance the oldest debts keep SMS, the rest go without it, and the principals hear once', async () => {
    const w = await h.world();
    // Older tuition for everyone; Tariq's family pays theirs, so Nadia's debt is the oldest.
    const older = monthOf(-80);
    await runMonth(app, w.school, w.year, older, karachi(`${older}-01`));
    await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId, w.b.studentId], amount: 6000 });
    // Two units: the keypad family's receipt SMS, queued and not yet sent, holds one of them.
    await db().school.update({ where: { id: w.school.id }, data: { smsMonthlyCap: 2 } });

    const run = await h.reminders(w);
    expect(run.overdue).toEqual({ families: 2, smsUnits: 1, enqueued: 1, capped: 1 });
    const [nadia, tariq] = await reminders(w, 'fee_overdue');
    expect(nadia?.guardianId).toBe(w.g2);
    expect(nadia?.channelPlan).toContain('sms');
    // The keypad family had only SMS: suppressed, the reason recorded.
    expect([tariq?.guardianId, tariq?.status, tariq?.suppressedReason]).toEqual([w.g1, 'suppressed', 'cap_reached']);
    const capped = await db().message.findMany({ where: { schoolId: w.school.id, type: 'reminder_sms_capped' } });
    expect(capped.map((m) => m.staffId)).toEqual([w.principal.user.staffId]);
    expect(capped[0]?.body).toContain("1 family could not be reminded by SMS because this month's SMS allowance is used up.");

    // A later run the same day tells the principals nothing new (one per school day).
    await h.manualCharge(w, w.a, 500, isoDay(1));
    await h.reminders(w);
    expect(await db().message.count({ where: { schoolId: w.school.id, type: 'reminder_sms_capped' } })).toBe(1);
  });

  it('R202, R250: on the shared budget the overdue families go first, so a due-only family loses SMS before an old debt does', async () => {
    const w = await h.world();
    // A keypad family whose only charge falls due in two days.
    const g3 = await createGuardian(db(), w.school, { fullName: 'Sana Ali', contactCapability: 'keypad' });
    const d = await pupil(w.school, w.section, { startedOn: isoDay(0), fullName: 'Daniyal Ali', guardianId: g3.id });
    await h.manualCharge(w, d, 4000, isoDay(2));
    await db().school.update({ where: { id: w.school.id }, data: { smsMonthlyCap: 1 } });

    const run = await h.reminders(w);
    expect([run.overdue.smsUnits, run.due.smsUnits, run.due.capped]).toEqual([1, 0, 1]);
    const tariq = (await reminders(w, 'fee_overdue')).find((m) => m.guardianId === w.g1);
    expect(tariq?.channelPlan).toContain('sms');
    const [sana] = await reminders(w, 'fee_due_reminder');
    expect([sana?.guardianId, sana?.status, sana?.suppressedReason]).toEqual([g3.id, 'suppressed', 'cap_reached']);
  });

  it('R250: SMS legs written but not yet sent count against the allowance; an allowance used up before the run tells nobody', async () => {
    const w = await h.world();
    await db().school.update({ where: { id: w.school.id }, data: { smsMonthlyCap: 1 } });
    // One queued message with an always-SMS leg, not yet attempted: it holds the month's last unit.
    await db().message.create({
      data: {
        schoolId: w.school.id,
        type: 'fee_overdue',
        priority: 'normal',
        subjectType: 'fee_reminder',
        subjectId: 1n,
        guardianId: w.g2,
        body: 'Iqra Model School: Fees overdue.',
        channelPlan: ['sms'],
        status: 'queued',
      },
    });
    const run = await h.reminders(w);
    // Both families lose SMS: the keypad one entirely, the WhatsApp one its SMS leg.
    expect([run.overdue.smsUnits, run.overdue.capped]).toEqual([0, 2]);
    const tariq = (await reminders(w, 'fee_overdue')).find((m) => m.guardianId === w.g1 && m.subjectId !== 1n);
    expect([tariq?.status, tariq?.suppressedReason]).toEqual(['suppressed', 'cap_reached']);
    // The allowance was gone before the run: no reminder_sms_capped.
    expect(await db().message.count({ where: { schoolId: w.school.id, type: 'reminder_sms_capped' } })).toBe(0);

    // A school with no SMS allowance at all (cap 0) never hears it either.
    const w2 = await h.world();
    await db().school.update({ where: { id: w2.school.id }, data: { smsMonthlyCap: 0 } });
    const none = await h.reminders(w2);
    expect(none.overdue.capped).toBe(2);
    expect(await db().message.count({ where: { schoolId: w2.school.id, type: 'reminder_sms_capped' } })).toBe(0);
  });

  it('a manual due reminder for a month beyond the next is sent once', async () => {
    const w = await h.world();
    const g3 = await createGuardian(db(), w.school, { fullName: 'Sana Ali', contactCapability: 'keypad' });
    const d = await pupil(w.school, w.section, { startedOn: isoDay(0), fullName: 'Daniyal Ali', guardianId: g3.id });
    await h.manualCharge(w, d, 4000, isoDay(75));
    const send = () => post('/fee-reminders/send', { kind: 'due', studentIds: [d.studentId.toString()] }, w.principal).expect(200);
    expect((await send()).body).toEqual({ families: 1, smsUnits: 1, enqueued: 1, capped: 0 });
    // The second send finds the due month's subject already written: nothing planned, nothing spent.
    expect((await send()).body).toEqual({ families: 0, smsUnits: 0, enqueued: 0, capped: 0 });
    const due = await reminders(w, 'fee_due_reminder');
    expect(due.map((m) => [m.guardianId, m.subjectId])).toEqual([[g3.id, ym(isoDay(75)) * 10n]]);
  });

  it('POST /fee-reminders/send is throttled per user: 5 a minute, then 429', async () => {
    const w = await h.world();
    for (let i = 0; i < 5; i += 1) await post('/fee-reminders/send', { kind: 'overdue' }, w.principal).expect(200);
    const refused = await post('/fee-reminders/send', { kind: 'overdue' }, w.principal);
    expect(refused.status).toBe(429);
  });

  it('POST /fee-reminders/send: charge.campaign.send, at most one target, the same caps, audited', async () => {
    // The refusals in a school of their own: they spend the principal's send budget (5 a minute).
    const w0 = await h.world();
    const send0 = (body: object, by = w0.principal) => post('/fee-reminders/send', body, by);
    await send0({ kind: 'overdue' }, w0.office).expect(403);
    await send0({ kind: 'overdue' }, w0.teacher).expect(403);
    expect(err(await send0({ kind: 'overdue', classId: w0.classId.toString(), studentIds: [w0.c.studentId.toString()] }).expect(422)).error.details?.fields?.[0]?.path).toBe('classId');
    await send0({ kind: 'overdue', sectionId: '999999' }).expect(422);
    await send0({ kind: 'weekly' }).expect(422);

    const w = await h.world();
    const send = (body: object, by = w.principal) => post('/fee-reminders/send', body, by);

    // Zainab's family only.
    const one = (await send({ kind: 'overdue', studentIds: [w.c.studentId.toString()] }).expect(200)).body as { families: number; smsUnits: number; enqueued: number; capped: number };
    expect(one).toEqual({ families: 1, smsUnits: 1, enqueued: 1, capped: 0 });
    expect((await reminders(w, 'fee_overdue')).map((m) => m.guardianId)).toEqual([w.g2]);
    // The class: Tariq's family now; Nadia's waits for the cadence.
    const all = (await send({ kind: 'overdue', classId: w.classId.toString() }).expect(200)).body as { families: number };
    expect(all.families).toBe(1);
    expect((await send({ kind: 'overdue' }).expect(200)).body).toEqual({ families: 0, smsUnits: 0, enqueued: 0, capped: 0 });
    // A manual due reminder takes any upcoming due date.
    await h.manualCharge(w, w.c, 700, isoDay(20));
    expect(((await send({ kind: 'due', sectionId: w.section.id.toString() }).expect(200)).body as { families: number }).families).toBe(1);

    const audit = await h.audit(w.school, 'fee_reminder.sent');
    expect(audit.map((a) => [a.actorUserId, (a.metadata as { kind: string; families: number }).families])).toEqual([
      [w.principal.user.userId, 1],
      [w.principal.user.userId, 1],
      [w.principal.user.userId, 0],
      [w.principal.user.userId, 1],
    ]);
  });
});
