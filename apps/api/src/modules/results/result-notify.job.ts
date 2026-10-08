import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { NotificationService } from '../../messaging/notification.service';
import { OutboxDispatcher } from '../../messaging/outbox-dispatcher';
import { AcademicTermRepository } from '../../repositories/academic-term.repository';
import { ResultRepository } from '../../repositories/result.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { AfterCommitPrismaAdapter } from '../../tenancy/after-commit';
import type { SchoolId } from '../../tenancy/school-id';
import { JOB_TRANSACTION_TIMEOUT_MS } from '../announcements/announcement-send.job';

// contracts/slice-31.md §5 (phase-4-academic.md §3.5, §3.6, R273): the worker side of a
// publication. Runs inside QueueTenancy.runAsSchool (src/jobs/job-runner.ts) with a SchoolId and
// no session. Its first statement is the scoped claim (R105): the target's rows that are
// published, live and not yet told are stamped notified_at and returned; a replay, a superseded
// or an unpublished row claims nothing. One message per student, to the family by the receipt
// rule and the student's own login; `result_revised` for a revised row (slice 32's corrections).

const MINUTE_MS = 60_000;
/** A published sheet whose rows are still untold this long after is re-enqueued by the sweep. */
const SWEEP_AFTER_MS = 2 * MINUTE_MS;
/** The sweep's batch per school. */
const SWEEP_LIMIT = 100;
/** The final result's name in a message (§3.5: name, term, percentage and grade only). */
const FINAL_TERM_NAME = 'Final';

@Injectable()
export class ResultNotifyJob {
  private readonly logger = new Logger('ResultNotifyJob');

  constructor(
    private readonly results: ResultRepository,
    private readonly terms: AcademicTermRepository,
    private readonly schoolSettings: SchoolSettingsRepository,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  /** One send; returns the number of messages written. */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: JOB_TRANSACTION_TIMEOUT_MS })
  async run(
    schoolId: SchoolId,
    target: { sheetId: bigint } | { resultId: bigint },
    now: Date = new Date(),
  ): Promise<number> {
    const claimed = await this.results.claimForNotify(schoolId, target, now);
    if (claimed.length === 0) return 0;
    const studentLogin = await this.schoolSettings.studentLoginEnabled(schoolId);
    const recipients = await this.results.notifyRecipients(
      schoolId,
      claimed.map((row) => row.studentId),
      studentLogin,
    );
    const termNames = new Map<bigint, string>();
    let sent = 0;
    for (const row of claimed) {
      const people = recipients.get(row.studentId);
      if (!people || (people.guardianIds.length === 0 && !people.student)) continue;
      let termName = FINAL_TERM_NAME;
      if (row.termId !== null) {
        const known = termNames.get(row.termId);
        termName = known ?? (await this.terms.findById(schoolId, row.termId))?.name ?? '';
        termNames.set(row.termId, termName);
      }
      const vars = {
        studentName: people.fullName,
        termName,
        percentBp: row.percentBp,
        grade: row.grade,
      };
      const recipientsOf = [
        ...people.guardianIds.map((guardianId) => ({ guardianId })),
        ...(people.student ? [{ studentId: row.studentId }] : []),
      ];
      const subject = { type: 'result' as const, id: row.id };
      if (row.revised) {
        await this.notifications.send(schoolId, {
          type: 'result_revised',
          subject,
          recipients: recipientsOf,
          vars,
        });
      } else {
        await this.notifications.send(schoolId, {
          type: 'result_published',
          subject,
          recipients: recipientsOf,
          vars,
        });
      }
      sent++;
    }
    this.logger.log({ claimed: claimed.length, sent }, 'results told');
    return sent;
  }

  /** The outbox sweep's source (§3.6): a sheet published two minutes ago whose rows are untold. */
  async sweep(schoolId: SchoolId, plannedAt: Date): Promise<void> {
    const sheetIds = await this.results.unnotifiedSheetIds(
      schoolId,
      new Date(plannedAt.getTime() - SWEEP_AFTER_MS),
      SWEEP_LIMIT,
    );
    if (sheetIds.length === 0) return;
    await this.outbox.resultNotify(schoolId, sheetIds, Math.floor(plannedAt.getTime() / MINUTE_MS));
  }
}
