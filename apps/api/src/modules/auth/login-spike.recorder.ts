import { Injectable, Logger } from '@nestjs/common';
import { summariseDatabaseError } from '../../common/errors/prisma-errors';
// The one platform-table write in school code: named exception 2's spray detection (contract
// slice-2 §3.1 step 6). This file alone is listed in NAMED_EXCEPTION_SITES (eslint.config.mjs).
import { PlatformAuditRepository } from '../../repositories/platform/platform-audit.repository';
import type { SchoolId } from '../../tenancy/school-id';

/**
 * Writes one `login_failure_spike` row to platform_audit_log when a school's failed logins in a
 * window reach the threshold. Best effort: a failed login is a 401 whatever happens to the record
 * of it, so a write failure is logged (constraint name only), never thrown.
 */
@Injectable()
export class LoginSpikeRecorder {
  private readonly logger = new Logger('LoginSpikeRecorder');

  constructor(private readonly platformAudit: PlatformAuditRepository) {}

  async record(schoolId: SchoolId, failures: number, windowStartedAt: string): Promise<void> {
    try {
      await this.platformAudit.record({
        actorPlatformUserId: null,
        schoolId,
        action: 'login_failure_spike',
        subjectType: 'school',
        subjectId: schoolId,
        metadata: { failures, windowStartedAt },
      });
    } catch (error) {
      this.logger.error(
        { database: summariseDatabaseError(error), schoolId: schoolId.toString() },
        'login_failure_spike could not be recorded',
      );
    }
  }
}

/** The recorder with the platform repository it needs, so only this file imports it. */
export const LOGIN_SPIKE_PROVIDERS = [LoginSpikeRecorder, PlatformAuditRepository];
