import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PrismaTxAdapter } from './prisma';

// The §4.6 history pattern (phase-2-daily-operations.md): attendance_marks, staff_attendance and
// diary_entries are corrected in place, and a BEFORE UPDATE trigger (asms_record_change) writes
// the old and new values to their *_changes table. The trigger reads the acting user and the
// reason from two TRANSACTION-LOCAL settings, written here, never by the service directly.
//
// `is_local = true` makes each value die with the transaction (and respect savepoints): a
// session-level value would outlive it on the pooled connection and be read by the next request.
// test/guardrails/set-config-local.spec.ts fails on any set_config in src/ without `, true)`.
// Called outside @Transactional() the setting lands on one pooled connection and the update on
// another, so the trigger refuses the update (`<table>_change_actor_required`): fail-closed.
//
// No school_id: the statement touches no table. The actor is checked by the changes table's
// composite FK (school_id, changed_by) -> users, so an actor from another school is refused there.
// Listed in RAW_SQL_FILES (eslint.config.mjs).

@Injectable()
export class ChangeContextRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * Names the acting user and the reason for every history-tracked update in the current
   * transaction. `reason` null: no reason (diary_entries accepts that; attendance refuses a change).
   */
  async setChangeContext(actorUserId: bigint, reason: string | null): Promise<void> {
    await this.txHost.tx.$queryRaw`
      SELECT set_config('asms.actor_user_id', ${actorUserId.toString()}, true),
             set_config('asms.change_reason', ${reason ?? ''}, true)`;
  }
}
