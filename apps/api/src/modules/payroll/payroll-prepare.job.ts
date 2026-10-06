import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { todayIn } from '../../common/school-clock';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { PayrollRunRepository } from '../../repositories/payroll-run.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { AfterCommitPrismaAdapter } from '../../tenancy/after-commit';
import type { SchoolId } from '../../tenancy/school-id';
import { PayrollEngine } from './payroll-engine';

// The per-school body of `payroll-prepare` (phase-3-financial.md §3.7, R214): daily at 03:00 school
// time; on (or, catching up, after) the school's pay day it prepares the PREVIOUS month's draft,
// unless the month has a run.
// It never finalises. Runs inside QueueTenancy.runAsSchool (src/jobs/job-runner.ts) and audits as
// the system actor (A19).

/** The school_settings column default (§3.8), for a school without a settings row. */
const DEFAULT_PAY_DAY = 1;
/** 200 staff are well inside it (§7.2: 5 s); the request limit is 15 s. */
export const PAYROLL_JOB_TIMEOUT_MS = 60_000;

const previousMonth = (day: string): string => {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};

@Injectable()
export class PayrollPrepare {
  constructor(
    private readonly engine: PayrollEngine,
    private readonly runs: PayrollRunRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly school: OwnSchoolRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  /** The run id prepared, or null when today is not the pay day or the month has a run. */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: PAYROLL_JOB_TIMEOUT_MS })
  async run(schoolId: SchoolId, now: Date = new Date()): Promise<bigint | null> {
    const row = await this.school.find(schoolId);
    if (!row) return null;
    const today = todayIn(row.timezone, now).toISOString().slice(0, 10);
    const payDay = (await this.settings.find(schoolId))?.payDay ?? DEFAULT_PAY_DAY;
    // From the pay day on: a day the job missed is caught up later in the month.
    if (Number(today.slice(8, 10)) < payDay) return null;
    const yearMonth = previousMonth(today);
    if (await this.runs.findByMonth(schoolId, yearMonth)) return null;
    const run = await this.engine.prepare(schoolId, yearMonth, null, now);
    // Its own action: a route's actions always name a person (test/core/routes.e2e-spec.ts).
    await this.audit.recordSystem(schoolId, {
      action: 'payroll_run.auto_prepared',
      subjectType: 'payroll_run',
      subjectId: run.id,
      metadata: {
        job: 'payroll-prepare',
        yearMonth,
        workingDays: run.workingDays,
        staffCount: run.staffCount,
        totalNet: run.totalNet,
      },
    });
    return run.id;
  }
}
