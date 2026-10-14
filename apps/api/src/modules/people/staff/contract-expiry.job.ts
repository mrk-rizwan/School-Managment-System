import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { addDays, daysBetween, todayIn } from '../../../common/school-clock';
import { NotificationService } from '../../../messaging/notification.service';
import { MessageRecipientRepository } from '../../../repositories/message-recipient.repository';
import { OwnSchoolRepository } from '../../../repositories/own-school.repository';
import { StaffContractRepository, type StaffContractRecord } from '../../../repositories/staff-contract.repository';
import type { AfterCommitPrismaAdapter } from '../../../tenancy/after-commit';
import type { SchoolId } from '../../../tenancy/school-id';

// The per-school body of `contract-expiry-warn` (phase-5-extended.md §3.5, rule 35, R319, A6;
// contracts/slice-39.md §3): daily at 06:00 school time, inside QueueTenancy.runAsSchool
// (src/jobs/job-runner.ts). A live contract whose last day is within the school's
// `contract_warning_days` (*default* 30) gets `contract_expiring` to every active principal once,
// and again once within 7 days; nothing on the day itself and nothing after it. Each warning is
// stamped (warned_30_at, warned_7_at: set once, by a conditional update, so two runs never send
// twice) in the transaction that writes its messages. Expiry changes nothing else (R320).

/** The second warning's lead (rule 35: "and again at 7 days"). */
export const SECOND_WARNING_DAYS = 7;
/** A school's handful of contracts is far inside it; the request limit is 15 s. */
export const CONTRACT_JOB_TIMEOUT_MS = 60_000;

const STAGE = { first: 1n, second: 2n } as const;

/**
 * `messages.subject_id` of a contract warning: `contractId * 10 + stage`, so the two warnings of
 * one contract are two subjects and each reaches each principal once (R107 is one row per person
 * per subject), as the platform invoice notices do.
 */
export const contractNoticeSubjectId = (contractId: bigint, stage: keyof typeof STAGE): bigint =>
  contractId * 10n + STAGE[stage];

@Injectable()
export class ContractExpiryWarn {
  constructor(
    private readonly contracts: StaffContractRepository,
    private readonly school: OwnSchoolRepository,
    private readonly people: MessageRecipientRepository,
    private readonly notifications: NotificationService,
  ) {}

  /** The number of warnings sent (contracts warned, not messages). */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: CONTRACT_JOB_TIMEOUT_MS })
  async run(schoolId: SchoolId, now: Date = new Date()): Promise<number> {
    const row = await this.school.find(schoolId);
    if (!row) return 0;
    // A6: ends_on is the last working day, compared with the school's own today.
    const today = todayIn(row.timezone, now);
    const lead = await this.contracts.warningDays(schoolId);
    const second = Math.min(SECOND_WARNING_DAYS, lead);
    // No principal, nothing stamped: the warning goes out once a principal exists.
    const principals = await this.people.activePrincipalStaffIds(schoolId);
    if (principals.length === 0) return 0;
    const recipients = principals.map((staffId) => ({ staffId }));

    let sent = 0;
    // The first warning only outside the second's window, so a contract added a few days before
    // its end gets one message, not two on the same morning.
    if (lead > second) {
      for (const contract of await this.contracts.unwarned(schoolId, 'warned30At', addDays(today, second + 1), addDays(today, lead))) {
        sent += await this.warn(schoolId, contract, 'first', today, now, recipients);
      }
    }
    for (const contract of await this.contracts.unwarned(schoolId, 'warned7At', addDays(today, 1), addDays(today, second))) {
      sent += await this.warn(schoolId, contract, 'second', today, now, recipients);
    }
    return sent;
  }

  private async warn(
    schoolId: SchoolId,
    contract: StaffContractRecord,
    stage: keyof typeof STAGE,
    today: Date,
    now: Date,
    recipients: readonly { staffId: bigint }[],
  ): Promise<number> {
    if (contract.endsOn === null) return 0;
    // Claimed first: a concurrent run that stamped it already sends nothing here.
    if ((await this.contracts.stamp(schoolId, contract.id, stage === 'first' ? 'warned30At' : 'warned7At', now)) === 0) return 0;
    await this.notifications.send(schoolId, {
      type: 'contract_expiring',
      subject: { type: 'staff_contract', id: contractNoticeSubjectId(contract.id, stage) },
      recipients,
      vars: { staffName: contract.staffName, endsOn: contract.endsOn, daysLeft: daysBetween(today, contract.endsOn) },
    });
    return 1;
  }
}
