import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability } from '@asms/shared';
import { failureLog } from '../../common/errors/failure-log';
import { todayIn } from '../../common/school-clock';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import { AnnouncementAudienceRepository } from '../../repositories/announcement-audience.repository';
import { AnnouncementRepository } from '../../repositories/announcement.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import type { AfterCommitPrismaAdapter } from '../../tenancy/after-commit';
import type { SchoolId } from '../../tenancy/school-id';
import { PermissionsService } from '../access/permissions.service';
import { AnnouncementDispatch, subjectOf } from './announcement-dispatch';
import type { SenderReach } from './audiences';

// contracts/slice-14.md §5.6 (R146): the worker side of every announcement send, scheduled or
// not. Runs inside QueueTenancy.runAsSchool (src/jobs/job-runner.ts) with a SchoolId. A send now
// and a holiday notice are committed `sending` by their request and delivered here (decision 9,
// reversed in the fix round); a scheduled row is claimed at its time.

const MINUTE_MS = 60_000;
/** The sweep's batch per school (slice-9 §7.9). */
const SWEEP_LIMIT = 500;
/**
 * Failed attempts before the job gives up (decision 25): the sweep re-enqueues a stuck row every
 * 2 minutes once it is a minute old, so five attempts span about ten minutes, enough to ride out
 * a database or Redis restart, and short enough that the principal hears about it the same hour.
 */
export const MAX_SEND_FAILURES = 5;
/**
 * The job's transaction limit. Resolution, the plan and one message, recipient and delivery row
 * per person are written in one transaction, so a crash leaves nothing half sent. A 3,000-person
 * school took 4.4-4.8 s warm on a developer machine (send.e2e-spec.ts and holidays.e2e-spec.ts
 * print the figure) and 23.7 s on a cold run before the fan-out left the request. 120 s is five
 * times that cold run: room for a school twice the size on a slow disk without a timeout turning
 * a slow send into a failed one. It bounds only a stuck job's locks; nothing waits on this
 * transaction but a duplicate job for the same row and a holiday cancel (§6.2).
 */
export const JOB_TRANSACTION_TIMEOUT_MS = 120_000;

const SEND_KEYS = [Capability.ANNOUNCEMENT_SEND_SCHOOL, Capability.ANNOUNCEMENT_SEND_SCOPE];

@Injectable()
export class AnnouncementSendJob {
  private readonly logger = new Logger('AnnouncementSendJob');

  constructor(
    private readonly announcements: AnnouncementRepository,
    private readonly audiences: AnnouncementAudienceRepository,
    private readonly dispatch: AnnouncementDispatch,
    private readonly permissions: PermissionsService,
    private readonly outbox: OutboxDispatcher,
    private readonly audit: AuditLogRepository,
  ) {}

  /**
   * The job body the runner calls: run(), and on a failure the attempt counted in its own
   * transaction (run's rolled back) before the error goes on to BullMQ. The fifth failure gives up.
   */
  async fire(schoolId: SchoolId, announcementId: bigint, now: Date = new Date(), dueAt: Date = now): Promise<'skipped' | 'sent'> {
    try {
      return await this.run(schoolId, announcementId, now, dueAt);
    } catch (error) {
      try {
        await this.recordFailure(schoolId, announcementId, new Date());
      } catch (counting) {
        this.logger.error({ ...failureLog(counting), announcementId: announcementId.toString() }, 'send failure not counted');
      }
      throw error;
    }
  }

  /**
   * One send: the claim first (zero rows ends the job: a replay, an edited time, a cancellation,
   * already sent). A scheduled row is checked against its creator's scope on the firing day, with
   * out-of-scope items dropped; a send now was checked by its request; a holiday's notice whose
   * holiday was cancelled since tells nobody. Then resolution, the plan and the write. No cap or
   * length refusal (decisions 8, 11); zero persons ends `sent` with recipient_count 0 (decision
   * 10). A crash rolls back to the claimed state for the sweep.
   *
   * `dueAt` is when the queue was asked to run the job (its producer's clock): the claim accepts
   * a row due by then even when this worker's clock is a little behind Redis's.
   */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: JOB_TRANSACTION_TIMEOUT_MS })
  async run(schoolId: SchoolId, announcementId: bigint, now: Date = new Date(), dueAt: Date = now): Promise<'skipped' | 'sent'> {
    const claimed = await this.announcements.claimForSend(schoolId, announcementId, dueAt > now ? dueAt : now, now);
    if (!claimed) return 'skipped';
    const { row, from } = claimed;
    const withdrawn = await this.announcements.isWithdrawnHolidayNotice(schoolId, row);
    const items = withdrawn
      ? []
      : (await this.audiences.forAnnouncements(schoolId, [row.id])).map((a) => ({
          kind: a.kind,
          targetId: a.targetId,
          roles: a.roles,
        }));
    const settings = await this.dispatch.settings(schoolId);
    const dispatch = await this.dispatch.resolve(schoolId, {
      items,
      scope: from === 'scheduled' ? { reach: await this.creatorReach(schoolId, row.createdBy), mode: 'drop' } : null,
      subject: subjectOf(row),
      on: todayIn(settings.timezone, now),
      plan: 'deliver',
      now,
    });
    const { delivered } = await this.dispatch.deliver(schoolId, row, dispatch, now);
    // Not audited: a scheduled fire has no actor (its schedule was audited with one), and a send
    // now's `announcement.sent` was written by its request. The delivery facts are logged.
    this.logger.log(
      {
        announcementId: row.id.toString(),
        from,
        recipients: dispatch.resolution.counts.total,
        droppedAudiences: dispatch.dropped,
        withdrawnHolidayNotice: withdrawn,
        dedupedByPhone: delivered.dedupedByPhone,
        smsLegs: delivered.smsLegs,
      },
      'announcement sent',
    );
    return 'sent';
  }

  /**
   * A failed attempt (decision 25): counted on a row still waiting; at MAX_SEND_FAILURES the row
   * goes back to `draft` flagged `send_failed_at` (nothing was written: each attempt rolled
   * back), audited against the row's creator, so the sender sees it on the list and the detail.
   */
  @Transactional()
  async recordFailure(schoolId: SchoolId, announcementId: bigint, now: Date): Promise<'none' | 'counted' | 'gave_up'> {
    const counted = await this.announcements.countSendFailure(schoolId, announcementId, now);
    if (!counted) return 'none';
    if (counted.failures < MAX_SEND_FAILURES) return 'counted';
    await this.announcements.giveUpSend(schoolId, announcementId, now);
    // audit_log requires an actor and the job has none: the row's creator is named, and the
    // action itself says the system gave up.
    await this.audit.record(schoolId, {
      actorUserId: counted.createdBy,
      action: 'announcement.send_failed',
      subjectType: 'announcement',
      subjectId: announcementId,
      metadata: { attempts: counted.failures, fromStatus: counted.status },
    });
    this.logger.error({ announcementId: announcementId.toString(), attempts: counted.failures }, 'announcement send given up');
    return 'gave_up';
  }

  /**
   * The outbox sweep's source (slice-9 §7.9): scheduled rows a minute past their time, and
   * `sending` rows a minute untouched (a send now or holiday notice whose job was lost or failed),
   * are enqueued again under `...-s<minute>`, so a lost job runs within the sweep's cadence.
   */
  async sweep(schoolId: SchoolId, now: Date = new Date()): Promise<number> {
    const due = await this.announcements.listOverdueSends(schoolId, new Date(now.getTime() - MINUTE_MS), SWEEP_LIMIT);
    const minute = Math.floor(now.getTime() / MINUTE_MS);
    await this.outbox.announcementSends(
      schoolId,
      due.map((row) => ({ id: row.id, scheduledAt: row.dueAt, sweepMinute: minute })),
      now,
    );
    return due.length;
  }

  /** What the creator reaches on the firing day; null when they hold neither key any more. */
  private async creatorReach(schoolId: SchoolId, userId: bigint): Promise<SenderReach | null> {
    const access = await this.permissions.load(schoolId, userId);
    if (!access || access.status !== 'active') return null;
    const scope = await this.permissions.canAny(schoolId, access, SEND_KEYS);
    if (scope === null) return null;
    return { scope, school: access.capabilities.has(Capability.ANNOUNCEMENT_SEND_SCHOOL) };
  }
}
