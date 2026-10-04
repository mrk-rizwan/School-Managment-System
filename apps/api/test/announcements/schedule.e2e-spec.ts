// Scheduled announcements (contracts/slice-14.md §5.1, §5.5 step 3, §5.6, §5.7; R146): the
// delayed job, the outbox sweep's recovery, edits and cancels before firing, the creator's scope
// on the firing day, and a fire with nobody to tell.
import { JobRunner } from '../../src/jobs/job-runner';
import { AnnouncementDispatch } from '../../src/modules/announcements/announcement-dispatch';
import { AnnouncementSendJob, MAX_SEND_FAILURES } from '../../src/modules/announcements/announcement-send.job';
import { asSchool } from '../messaging/support';
import { closeTestDb } from '../support/schools';
import { isoDay } from '../support/students';
import { AnnouncementHarness, announcement, campus, type Announcement, type Campus } from './support';

const MINUTE = 60_000;

describe('announcements: scheduled send (e2e)', () => {
  const h = new AnnouncementHarness();
  const db = h.db;
  let job: AnnouncementSendJob;

  beforeAll(async () => {
    await h.start();
    job = h.app.get(AnnouncementSendJob, { strict: false });
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const fire = (c: Campus, id: string, at: Date) =>
    asSchool(h.app, c.school.id, () => job.run(c.school.id, BigInt(id), at));
  const row = (c: Campus, id: string) =>
    db.announcement.findFirst({ where: { schoolId: c.school.id, id: BigInt(id) } });
  const sendsFor = (id: string) => h.sends.filter((s) => s.job.id === BigInt(id)).map((s) => s.job);
  async function scheduled(c: Campus, audiences: object[], cookie = c.principal.cookie, inMinutes = 5) {
    const at = new Date(Date.now() + inMinutes * MINUTE);
    const draft = await h.draft(announcement(audiences, { scheduledAt: at.toISOString() }), cookie);
    const res = await h.sendNow(draft.id, cookie);
    expect(res.body).toMatchObject({ status: 'scheduled', recipientCount: 0 });
    return { draft: res.body as Announcement, at: new Date(draft.scheduledAt ?? '') };
  }

  it('R146: a scheduled send enqueues a job delayed to its time and fires then, not before; it is audited once, at scheduling', async () => {
    const c = await campus(h);
    const { draft, at } = await scheduled(c, [{ kind: 'parents' }]);
    expect(sendsFor(draft.id)).toEqual([{ id: BigInt(draft.id), scheduledAt: at }]);
    // A second send of a scheduled row is a retry: 200 unchanged, no new job.
    expect((await h.sendNow(draft.id, c.principal.cookie)).body).toMatchObject({ status: 'scheduled' });
    expect(sendsFor(draft.id)).toHaveLength(1);
    expect(await fire(c, draft.id, new Date(at.getTime() - 1000))).toBe('skipped');
    expect(await fire(c, draft.id, at)).toBe('sent');
    expect(await row(c, draft.id)).toMatchObject({ status: 'sent', recipientCount: 2, scheduledAt: at });
    expect(await db.message.count({ where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(draft.id) } })).toBe(2);
    // A replayed job finds its claim false.
    expect(await fire(c, draft.id, new Date(at.getTime() + MINUTE))).toBe('skipped');
    expect(
      (await db.auditLog.findMany({ where: { schoolId: c.school.id, subjectId: BigInt(draft.id), subjectType: 'announcement' }, orderBy: { id: 'asc' } })).map(
        (a) => a.action,
      ),
    ).toEqual(['announcement.created', 'announcement.scheduled']);
  });

  it('R146: the job runner resolves the payload and runs the job; a forged payload is dropped', async () => {
    const c = await campus(h);
    const { draft, at } = await scheduled(c, [{ kind: 'parents' }], c.principal.cookie, 1.5);
    const runner = h.app.get(JobRunner, { strict: false });
    expect(
      await runner.messaging('announcement-send', { schoolId: String(c.school.id), announcementId: draft.id }, new Date(at.getTime() + 1000)),
    ).toBe('done');
    expect((await row(c, draft.id))?.status).toBe('sent');
    expect(await runner.messaging('announcement-send', { schoolId: String(c.school.id), announcementId: draft.id, extra: '1' })).toBe('dropped');
  });

  it('R146: a lost job is recovered by the outbox sweep a minute after its time', async () => {
    const c = await campus(h);
    const { draft, at } = await scheduled(c, [{ kind: 'parents' }]);
    const sweep = (now: Date) => asSchool(h.app, c.school.id, () => job.sweep(c.school.id, now));
    expect(await sweep(new Date(at.getTime() + 30_000))).toBe(0);
    expect(await sweep(new Date(at.getTime() + 2 * MINUTE))).toBe(1);
    expect(sendsFor(draft.id).at(-1)).toEqual({
      id: BigInt(draft.id),
      scheduledAt: at,
      sweepMinute: Math.floor((at.getTime() + 2 * MINUTE) / MINUTE),
    });
    expect(await fire(c, draft.id, new Date(at.getTime() + 2 * MINUTE))).toBe('sent');
    expect(await sweep(new Date(at.getTime() + 4 * MINUTE))).toBe(0);
  });

  it('R146: edited before firing (a new time makes the old job a no-op); null returns it to draft; cancelled never fires', async () => {
    const c = await campus(h);
    const { draft, at } = await scheduled(c, [{ kind: 'parents' }]);
    const later = new Date(at.getTime() + 10 * MINUTE);
    const edit = await h.patch(`/announcements/${draft.id}`, { title: 'Sports day moved', scheduledAt: later.toISOString() }, c.principal.cookie);
    expect(edit.body).toMatchObject({ status: 'scheduled', title: 'Sports day moved', scheduledAt: later.toISOString() });
    expect(sendsFor(draft.id).at(-1)).toEqual({ id: BigInt(draft.id), scheduledAt: later });
    expect(await fire(c, draft.id, at)).toBe('skipped'); // the old job
    expect(await fire(c, draft.id, later)).toBe('sent');
    const [message] = await db.message.findMany({ where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(draft.id) } });
    expect(message?.title).toBe('Sports day moved');

    const second = await scheduled(c, [{ kind: 'parents' }]);
    const unscheduled = await h.patch(`/announcements/${second.draft.id}`, { scheduledAt: null }, c.principal.cookie);
    expect(unscheduled.body).toMatchObject({ status: 'draft', scheduledAt: null });
    expect(await fire(c, second.draft.id, second.at)).toBe('skipped');

    const third = await scheduled(c, [{ kind: 'parents' }]);
    expect((await h.post(`/announcements/${third.draft.id}/cancel`, { reason: 'Rained off' }, c.principal.cookie)).body).toMatchObject({ status: 'cancelled' });
    expect(await fire(c, third.draft.id, third.at)).toBe('skipped');
    expect(await db.message.count({ where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(third.draft.id) } })).toBe(0);
  });

  it('R146: a creator who lost scope before firing has the item dropped (logged, not refused); nobody left ends sent with 0', async () => {
    const c = await campus(h);
    const { draft, at } = await scheduled(c, [{ kind: 'section', targetId: String(c.sectionA.id) }], c.teacher.cookie);
    await db.teacherAssignment.updateMany({
      where: { schoolId: c.school.id, staffId: c.teacher.staffId },
      data: { endsOn: new Date(`${isoDay(-1)}T00:00:00.000Z`) },
    });
    h.logs.length = 0;
    expect(await fire(c, draft.id, at)).toBe('sent');
    expect(await row(c, draft.id)).toMatchObject({ status: 'sent', recipientCount: 0 });
    expect(h.logs.some((line) => line.includes('"droppedAudiences":1'))).toBe(true);
    // The job writes no audit row: it has no actor.
    expect(await db.auditLog.count({ where: { schoolId: c.school.id, action: 'announcement.sent' } })).toBe(0);
  });

  it('§5.6: the claim uses the job’s due time, so a worker clock a little behind Redis’s still fires it', async () => {
    const c = await campus(h);
    const { draft, at } = await scheduled(c, [{ kind: 'parents' }]);
    const runner = h.app.get(JobRunner, { strict: false });
    const payload = { schoolId: String(c.school.id), announcementId: draft.id };
    // Without the due time a worker 500 ms behind finds nothing due.
    expect(await fire(c, draft.id, new Date(at.getTime() - 500))).toBe('skipped');
    expect(await runner.messaging('announcement-send', payload, new Date(at.getTime() - 500), at)).toBe('done');
    expect(await row(c, draft.id)).toMatchObject({ status: 'sent', recipientCount: 2 });
  });

  it('§4.2: scheduling re-checks the sender’s scope (an assignment ended since is 422; nothing scheduled)', async () => {
    const c = await campus(h);
    const at = new Date(Date.now() + 5 * MINUTE);
    const draft = await h.draft(announcement([{ kind: 'section', targetId: String(c.sectionA.id) }], { scheduledAt: at.toISOString() }), c.teacher.cookie);
    await db.teacherAssignment.updateMany({
      where: { schoolId: c.school.id, staffId: c.teacher.staffId },
      data: { endsOn: new Date(`${isoDay(-1)}T00:00:00.000Z`) },
    });
    const res = await h.sendNow(draft.id, c.teacher.cookie);
    expect(res.status).toBe(422);
    expect((await row(c, draft.id))?.status).toBe('draft');
    expect(sendsFor(draft.id)).toEqual([]);
  });

  it('§5.6: a send now whose job was lost is recovered by the sweep a minute later', async () => {
    const c = await campus(h);
    const draft = await h.draft(announcement([{ kind: 'parents' }]), c.principal.cookie);
    expect((await h.sendNow(draft.id, c.principal.cookie)).body).toMatchObject({ status: 'sending' });
    const sentAt = (await row(c, draft.id))?.updatedAt ?? new Date();
    const sweep = (now: Date) => asSchool(h.app, c.school.id, () => job.sweep(c.school.id, now));
    expect(await sweep(new Date(sentAt.getTime() + 30_000))).toBe(0);
    expect(await sweep(new Date(sentAt.getTime() + 2 * MINUTE))).toBe(1);
    expect(sendsFor(draft.id).at(-1)).toMatchObject({ id: BigInt(draft.id), sweepMinute: Math.floor((sentAt.getTime() + 2 * MINUTE) / MINUTE) });
    expect(await h.deliver(c.school.id, draft.id)).toBe('sent');
    expect(await sweep(new Date(sentAt.getTime() + 4 * MINUTE))).toBe(0);
  });

  it('decision 25: a send that keeps failing stops after five attempts: back to draft, flagged, audited; a new send clears it', async () => {
    const c = await campus(h);
    const { draft, at } = await scheduled(c, [{ kind: 'parents' }]);
    const deliver = jest.spyOn(h.app.get(AnnouncementDispatch, { strict: false }), 'deliver').mockRejectedValue(new Error('boom'));
    try {
      for (let attempt = 1; attempt < MAX_SEND_FAILURES; attempt++) {
        await expect(asSchool(h.app, c.school.id, () => job.fire(c.school.id, BigInt(draft.id), at))).rejects.toThrow('boom');
        expect(await row(c, draft.id)).toMatchObject({ status: 'scheduled', sendFailures: attempt, sendFailedAt: null });
      }
      await expect(asSchool(h.app, c.school.id, () => job.fire(c.school.id, BigInt(draft.id), at))).rejects.toThrow('boom');
    } finally {
      deliver.mockRestore();
    }
    const stopped = await row(c, draft.id);
    expect(stopped).toMatchObject({ status: 'draft', sendFailures: MAX_SEND_FAILURES });
    expect(stopped?.sendFailedAt).not.toBeNull();
    expect(await db.message.count({ where: { schoolId: c.school.id, subjectType: 'announcement', subjectId: BigInt(draft.id) } })).toBe(0);
    const [audit] = await db.auditLog.findMany({ where: { schoolId: c.school.id, action: 'announcement.send_failed', subjectId: BigInt(draft.id) } });
    expect(audit).toMatchObject({ actorUserId: c.principal.userId, metadata: { attempts: MAX_SEND_FAILURES, fromStatus: 'scheduled' } });
    // The sender sees it; the sweep leaves it alone.
    const shown = (await h.read(`/announcements/${draft.id}`, c.principal.cookie)).body as Announcement;
    expect(shown).toMatchObject({ status: 'draft', sendFailedAt: expect.any(String) });
    expect(await asSchool(h.app, c.school.id, () => job.sweep(c.school.id, new Date(at.getTime() + 10 * MINUTE)))).toBe(0);
    // Sending again (its time is still ahead: scheduled again) clears the flag, and this time it goes.
    expect((await h.sendNow(draft.id, c.principal.cookie)).body).toMatchObject({ status: 'scheduled', sendFailedAt: null });
    expect(await row(c, draft.id)).toMatchObject({ sendFailures: 0, sendFailedAt: null });
    expect(await fire(c, draft.id, at)).toBe('sent');
  });

  it('decision 25: a send now that keeps failing goes back to draft from sending (the trigger allows only that way out)', async () => {
    const c = await campus(h);
    const draft = await h.draft(announcement([{ kind: 'parents' }]), c.principal.cookie);
    await h.sendNow(draft.id, c.principal.cookie);
    for (let attempt = 1; attempt <= MAX_SEND_FAILURES; attempt++) {
      expect(await asSchool(h.app, c.school.id, () => job.recordFailure(c.school.id, BigInt(draft.id), new Date()))).toBe(
        attempt < MAX_SEND_FAILURES ? 'counted' : 'gave_up',
      );
    }
    expect(await row(c, draft.id)).toMatchObject({ status: 'draft', sentAt: null, recipientCount: 0 });
    // Nothing else may leave `sending` for `draft`.
    const other = await h.draft(announcement([{ kind: 'parents' }]), c.principal.cookie);
    await h.sendNow(other.id, c.principal.cookie);
    await expect(db.announcement.updateMany({ where: { schoolId: c.school.id, id: BigInt(other.id) }, data: { status: 'draft' } })).rejects.toThrow(
      /frozen/,
    );
  });
});
