import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { dayOfPeriod, dueOn as dueOnOf, lateFeeTarget, type LateFeeCandidate } from '@asms/shared';
import { failureLog } from '../../common/errors/failure-log';
import { todayIn } from '../../common/school-clock';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeCampaignRepository } from '../../repositories/charge-campaign.repository';
import {
  ChargeGenerationRepository,
  type ClassGeneration,
  type InsertedCharge,
  type NewLateFee,
} from '../../repositories/charge-generation.repository';
import { ChargeRunRepository, type ChargeRunRecord, type RunCounts, type SkippedClass } from '../../repositories/charge-run.repository';
import { FeeHeadRepository } from '../../repositories/fee-head.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { SchoolSettingsRepository, type SchoolSettingsRecord } from '../../repositories/school-settings.repository';
import type { AfterCommitPrismaAdapter } from '../../tenancy/after-commit';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { Advances } from '../payments/advances';
import { campaignAudienceRows } from './campaign-audiences';
import { chargeGrace, monthLabel, periodBounds, periodOf, plusDays } from './charges.shared';

// The worker side of charge generation (phase-3-financial.md §3.7, §5 slice 19, A1, R179-R185,
// R240-R242, R252). Runs inside QueueTenancy.runAsSchool (src/jobs/job-runner.ts). Generation is
// one transaction per class (§3.2's lock order: the heads shared, then the inserts); the run row,
// the fee_charged messages and the audit commit together after the last class. Jobs have no actor:
// a requested run is audited against the user who requested it; a scheduled one is not audited
// (audit_log_actor_check needs an actor) and its charge_runs row is the record.

/**
 * A job's transaction limit: one class's inserts, or the run's messages (one per family, about
 * 2,000 at 3,000 students), well inside it (§7.2: 30 s for the whole month).
 */
export const CHARGE_JOB_TIMEOUT_MS = 120_000;

interface Generated extends RunCounts {
  inserted: InsertedCharge[];
}

/** What a run tells families (fee_charged): its label and the date its charges fall due. */
interface RunNotice {
  label: string;
  dueOn: string;
}

@Injectable()
export class ChargeGeneration {
  private readonly logger = new Logger('ChargeGeneration');

  constructor(
    private readonly runs: ChargeRunRepository,
    private readonly generation: ChargeGenerationRepository,
    private readonly campaigns: ChargeCampaignRepository,
    private readonly heads: FeeHeadRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly school: OwnSchoolRepository,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLogRepository,
    private readonly advances: Advances,
  ) {}

  // ------------------------------------------------------------------------- scheduled

  /**
   * A1: the daily run for one school, for the current period of every active year containing it.
   * On the 1st it writes a run row and runs it (a requested run already queued for the month is
   * left to run); every later day is a catch-up that writes a row only when it inserted something.
   */
  async daily(schoolId: SchoolId, now: Date = new Date()): Promise<void> {
    const today = await this.today(schoolId, now);
    const period = today.slice(0, 7);
    const bounds = periodBounds(period);
    const years = await this.generation.activeYearsFor(schoolId, fromDateString(bounds.start), fromDateString(bounds.end));
    for (const year of years) {
      if (today.endsWith('-01')) {
        const run = await this.queueScheduled(schoolId, year.id, period, now);
        if (run) await this.run(schoolId, run.id, now);
        continue;
      }
      const generated = await this.generateMonth(schoolId, year.id, period, false, now);
      if (generated.inserted.length > 0) await this.recordCatchUp(schoolId, year.id, period, generated, now);
    }
  }

  /** The 1st's run row; null when a run for the month is already queued or running. */
  @Transactional()
  private async queueScheduled(schoolId: SchoolId, academicYearId: bigint, period: string, now: Date): Promise<ChargeRunRecord | null> {
    if (await this.runs.findActive(schoolId, academicYearId, period, 'monthly')) return null;
    return this.runs.createQueued(schoolId, {
      academicYearId,
      period,
      kind: 'monthly',
      campaignId: null,
      triggeredBy: null,
      regenerateVoided: false,
      queuedAt: now,
    });
  }

  @Transactional<AfterCommitPrismaAdapter>({ timeout: CHARGE_JOB_TIMEOUT_MS })
  private async recordCatchUp(
    schoolId: SchoolId,
    academicYearId: bigint,
    period: string,
    generated: Generated,
    now: Date,
  ): Promise<void> {
    const run = await this.runs.createDone(schoolId, {
      academicYearId,
      period,
      startedAt: now,
      finishedAt: new Date(),
      ...generated,
    });
    await this.notifyFamilies(schoolId, run.id, generated.inserted, await this.monthNotice(schoolId, period, now));
    await this.audit.recordSystem(schoolId, {
      action: 'charge_run.completed',
      subjectType: 'charge_run',
      subjectId: run.id,
      metadata: { job: 'charge-generate', catchUp: true, ...runFacts(run, generated) },
    });
    this.logger.log({ runId: run.id.toString(), inserted: generated.chargesInserted }, 'charge catch-up recorded');
  }

  // ------------------------------------------------------------------------- one run

  /**
   * The charge-run job: claim (R105), generate, finish. A monthly run inserts class by class and
   * finishes in a last transaction; a campaign run inserts and finishes in one transaction, so a
   * campaign is `generated` exactly when its charges exist. A run that throws is failed `error`
   * (a campaign goes back to draft, having no charges), audited and logged, and the job ends: a
   * BullMQ retry could only find the run claimed. Generation is idempotent, so the office simply
   * runs it again (R252).
   */
  async run(schoolId: SchoolId, runId: bigint, now: Date = new Date()): Promise<'skipped' | 'done' | 'failed'> {
    const run = await this.claim(schoolId, runId, now);
    if (!run) return 'skipped';
    try {
      if (run.kind === 'campaign') {
        if ((await this.campaignRun(schoolId, run, now)) === 'gone') {
          await this.fail(schoolId, run, 'campaign_gone', now);
          return 'failed';
        }
        return 'done';
      }
      if (await this.yearClosed(schoolId, run.academicYearId)) {
        await this.fail(schoolId, run, 'year_closed', now);
        return 'failed';
      }
      const generated = await this.generateMonth(schoolId, run.academicYearId, run.period, run.regenerateVoided, now);
      await this.complete(schoolId, run, generated, await this.monthNotice(schoolId, run.period, now), now);
      return 'done';
    } catch (error) {
      this.logger.error({ ...failureLog(error), runId: run.id.toString() }, 'charge run threw');
      await this.fail(schoolId, run, 'error', new Date());
      return 'failed';
    }
  }

  @Transactional()
  private async claim(schoolId: SchoolId, runId: bigint, now: Date): Promise<ChargeRunRecord | null> {
    if (!(await this.runs.claim(schoolId, runId, now))) return null;
    return this.runs.findById(schoolId, runId);
  }

  /** The run failed with `code`; a campaign (which then has no charges) goes back to draft. */
  @Transactional()
  private async fail(
    schoolId: SchoolId,
    run: { id: bigint; campaignId: bigint | null },
    code: string,
    now: Date,
  ): Promise<boolean> {
    if (!(await this.runs.fail(schoolId, run.id, code, now))) return false;
    if (run.campaignId !== null) await this.campaigns.move(schoolId, run.campaignId, 'generating', 'draft');
    await this.audit.recordSystem(schoolId, {
      action: 'charge_run.failed',
      subjectType: 'charge_run',
      subjectId: run.id,
      metadata: {
        job: code === 'stale' ? 'outbox-sweep' : 'charge-run',
        errorCode: code,
        campaignId: run.campaignId?.toString() ?? null,
      },
    });
    this.logger.warn({ runId: run.id.toString(), errorCode: code }, 'charge run failed');
    return true;
  }

  /** R184: a campaign's charges and its finish in one transaction. */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: CHARGE_JOB_TIMEOUT_MS })
  private async campaignRun(schoolId: SchoolId, run: ChargeRunRecord, now: Date): Promise<'done' | 'gone'> {
    const outcome = await this.generateCampaign(schoolId, run, now);
    if (outcome === null) return 'gone';
    if (!(await this.complete(schoolId, run, outcome.generated, outcome.notice, now))) {
      // Failed by the stale sweep meanwhile: the charges roll back with this transaction.
      throw new Error('campaign run no longer running');
    }
    return 'done';
  }

  /**
   * The run's row, the families' messages, a campaign's stamps and the audit, in one transaction
   * (joined by a campaign run's). False when the stale sweep failed the run meanwhile.
   */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: CHARGE_JOB_TIMEOUT_MS })
  private async complete(
    schoolId: SchoolId,
    run: ChargeRunRecord,
    generated: Generated,
    notice: RunNotice,
    now: Date,
  ): Promise<boolean> {
    if (!(await this.runs.finish(schoolId, run.id, generated, new Date()))) {
      // A monthly run's charges stand (idempotent); nobody is told twice.
      this.logger.warn({ runId: run.id.toString() }, 'charge run finished after the sweep failed it');
      return false;
    }
    if (run.campaignId !== null) {
      await this.campaigns.move(schoolId, run.campaignId, 'generating', 'generated', {
        generatedAt: new Date(),
        generatedCount: generated.chargesInserted,
      });
    }
    await this.notifyFamilies(schoolId, run.id, generated.inserted, notice);
    const facts = runFacts(run, generated);
    if (run.triggeredBy !== null) {
      await this.audit.record(schoolId, {
        actorUserId: run.triggeredBy,
        action: 'charge_run.completed',
        subjectType: 'charge_run',
        subjectId: run.id,
        metadata: { ...facts, job: 'charge-run' },
      });
    } else if (generated.chargesInserted > 0) {
      // The 1st's scheduled run (A19): the system actor.
      await this.audit.recordSystem(schoolId, {
        action: 'charge_run.completed',
        subjectType: 'charge_run',
        subjectId: run.id,
        metadata: { ...facts, job: 'charge-generate' },
      });
    }
    this.logger.log(
      { runId: run.id.toString(), inserted: generated.chargesInserted, at: now.toISOString() },
      'charge run done',
    );
    return true;
  }

  // ------------------------------------------------------------------------- generation

  /**
   * §5 slice 19 "Generation": every class of the year with an enrolment in the period, one
   * transaction each; monthly heads under the cut-off, yearly heads without it.
   */
  async generateMonth(
    schoolId: SchoolId,
    academicYearId: bigint,
    period: string,
    regenerateVoided: boolean,
    now: Date,
  ): Promise<Generated> {
    const settings = await this.requireSettings(schoolId);
    const today = await this.today(schoolId, now);
    const bounds = periodBounds(period);
    const year = await this.generation.yearOf(schoolId, academicYearId);
    const base: Omit<ClassGeneration, 'classId' | 'label'> = {
      academicYearId,
      period,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      cutoffDate: dayOfPeriod(period, settings.feeCutoffDay),
      dueOn: dueOnOf(period, settings.feeDueDay, today, chargeGrace(settings)),
      regenerateVoided,
    };
    const classes = await this.generation.classesToGenerate(schoolId, base);
    const inserted: InsertedCharge[] = [];
    const skippedClasses: SkippedClass[] = [];
    let candidates = 0;
    for (const cls of classes) {
      if (cls.missingStructure) skippedClasses.push({ classId: cls.classId.toString(), reason: 'no_structure' });
      const result = await this.generateClass(schoolId, { ...base, classId: cls.classId }, monthLabel(period), year?.name ?? period);
      candidates += result.candidates;
      inserted.push(...result.inserted);
    }
    return {
      inserted,
      studentsCharged: new Set(inserted.map((c) => c.studentId)).size,
      chargesInserted: inserted.length,
      chargesSkipped: candidates - inserted.length,
      skippedClasses,
    };
  }

  @Transactional<AfterCommitPrismaAdapter>({ timeout: CHARGE_JOB_TIMEOUT_MS })
  private async generateClass(
    schoolId: SchoolId,
    g: Omit<ClassGeneration, 'label'>,
    monthName: string,
    yearName: string,
  ): Promise<{ candidates: number; inserted: InsertedCharge[] }> {
    await this.generation.lockHeadsShared(schoolId);
    const monthly = await this.generation.generateMonthly(schoolId, { ...g, label: monthName });
    const yearly = await this.generation.generateYearly(schoolId, { ...g, label: yearName });
    const inserted = [...monthly.inserted, ...yearly.inserted];
    await this.applyAdvances(schoolId, g.academicYearId, inserted, 'charge-generate');
    return { candidates: monthly.candidates + yearly.candidates, inserted };
  }

  /** A campaign's charges (R184), one transaction; null when the campaign is not generating. */
  private async generateCampaign(
    schoolId: SchoolId,
    run: ChargeRunRecord,
    now: Date,
  ): Promise<{ generated: Generated; notice: RunNotice } | null> {
    if (run.campaignId === null) return null;
    const campaign = await this.campaigns.findById(schoolId, run.campaignId);
    if (!campaign || campaign.status !== 'generating') return null;
    const settings = await this.requireSettings(schoolId);
    const today = await this.today(schoolId, now);
    const nominal = toDateString(campaign.dueOn);
    // R240: a campaign charge created after its due date is due `grace` days after creation.
    const dueOn = today > nominal ? plusDays(today, chargeGrace(settings)) : nominal;
    const targets = await this.campaigns.targetEnrolments(schoolId, campaign.academicYearId, campaignAudienceRows(campaign));
    const result = await this.insertCampaign(schoolId, {
      campaignId: campaign.id,
      academicYearId: campaign.academicYearId,
      feeHeadId: campaign.feeHeadId,
      amount: campaign.amount,
      description: campaign.description ?? campaign.name,
      dueOn,
      period: periodOf(fromDateString(today)),
      applyConcessions: campaign.applyConcessions && campaign.feeHead.concessionEligible,
      enrolmentIds: targets.map((t) => t.id),
    });
    return {
      generated: {
        inserted: result.inserted,
        studentsCharged: new Set(result.inserted.map((c) => c.studentId)).size,
        chargesInserted: result.inserted.length,
        chargesSkipped: result.candidates - result.inserted.length,
        skippedClasses: [],
      },
      notice: { label: campaign.name, dueOn },
    };
  }

  @Transactional<AfterCommitPrismaAdapter>({ timeout: CHARGE_JOB_TIMEOUT_MS })
  private async insertCampaign(
    schoolId: SchoolId,
    c: Parameters<ChargeGenerationRepository['generateCampaign']>[1],
  ): ReturnType<ChargeGenerationRepository['generateCampaign']> {
    const result = await this.generation.generateCampaign(schoolId, c);
    await this.applyAdvances(schoolId, c.academicYearId, result.inserted, 'campaign-generate');
    return result;
  }

  // ------------------------------------------------------------------------- late fees

  /**
   * The late-fee sweep (R185): when enabled, one late fee per student and period against the
   * period's oldest overdue monthly charge (lateFeeTarget), under the fine head, due today, never
   * after the enrolment ended. Returns how many were written.
   */
  @Transactional<AfterCommitPrismaAdapter>({ timeout: CHARGE_JOB_TIMEOUT_MS })
  async lateFees(schoolId: SchoolId, now: Date = new Date()): Promise<number> {
    const settings = await this.requireSettings(schoolId);
    if (!settings.lateFeeEnabled || settings.lateFeeAmount === null || settings.lateFeeEnabledAt === null) return 0;
    const fine = await this.heads.findLiveByCategory(schoolId, 'fine');
    if (!fine) {
      this.logger.warn('late fees enabled but the school has no live fine head');
      return 0;
    }
    const timezone = await this.timezone(schoolId);
    const today = toDateString(todayIn(timezone, now));
    const enabledOn = toDateString(todayIn(timezone, settings.lateFeeEnabledAt));
    const candidates = await this.generation.lateFeeCandidates(schoolId, {
      enabledOn,
      overdueBefore: plusDays(today, -settings.lateFeeGraceDays),
      today,
    });
    const byStudent = new Map<bigint, typeof candidates>();
    for (const c of candidates) byStudent.set(c.studentId, [...(byStudent.get(c.studentId) ?? []), c]);
    const taken = await this.generation.lateFeePeriods(schoolId, [...byStudent.keys()]);
    const fees: NewLateFee[] = [];
    const rules = { lateFeeEnabled: true, lateFeeGraceDays: settings.lateFeeGraceDays, lateFeeEnabledOn: enabledOn };
    for (const [studentId, rows] of byStudent) {
      const periods = [...(taken.get(studentId) ?? [])];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const open: LateFeeCandidate[] = rows;
      // One per period: the oldest overdue charge of each period without a live late fee.
      for (let target = lateFeeTarget(open, periods, rules, today); target !== null; target = lateFeeTarget(open, periods, rules, today)) {
        const row = byId.get(target.id);
        if (!row || target.period === null) break;
        fees.push({
          targetId: row.id,
          studentId,
          enrolmentId: row.enrolmentId,
          academicYearId: row.academicYearId,
          period: target.period,
        });
        periods.push(target.period);
      }
    }
    const labels = new Map(fees.map((f) => [f.period, monthLabel(f.period)]));
    const inserted = await this.generation.insertLateFees(
      schoolId,
      fees,
      { id: fine.id, frequency: fine.frequency },
      settings.lateFeeAmount,
      today,
      labels,
    );
    // R189: an advance pays a fine or a late fee too, per year of the fees written.
    const key = (studentId: bigint, period: string) => `${studentId}:${period}`;
    const yearOf = new Map(fees.map((f) => [key(f.studentId, f.period), f.academicYearId]));
    const byYear = new Map<bigint, InsertedCharge[]>();
    for (const fee of inserted) {
      const year = yearOf.get(key(fee.studentId, fee.period));
      if (year !== undefined) byYear.set(year, [...(byYear.get(year) ?? []), fee]);
    }
    for (const [year, yearFees] of byYear) await this.applyAdvances(schoolId, year, yearFees, 'late-fee-sweep');
    if (inserted.length > 0) {
      const perPeriod: Record<string, number> = {};
      for (const fee of inserted) perPeriod[fee.period] = (perPeriod[fee.period] ?? 0) + 1;
      // A19: one row per sweep that charged anything, with its counts.
      await this.audit.recordSystem(schoolId, {
        action: 'charge.late_fees_charged',
        subjectType: 'school',
        subjectId: null,
        metadata: {
          job: 'late-fee-sweep',
          inserted: inserted.length,
          amount: inserted.reduce((sum, f) => sum + f.amount, 0),
          perPeriod,
          day: today,
        },
      });
      this.logger.log({ inserted: inserted.length }, 'late fees charged');
    }
    return inserted.length;
  }

  // ------------------------------------------------------------------------- advances

  /**
   * R189, A5 (slice 20): the new charges' children's advances in the year pay them, oldest due
   * first, in the inserting transaction (payments locked first, then charges, R236). A19: one
   * system-actor audit row per application that moved money.
   */
  private async applyAdvances(
    schoolId: SchoolId,
    academicYearId: bigint,
    inserted: readonly InsertedCharge[],
    job: string,
  ): Promise<void> {
    const students = [...new Set(inserted.filter((c) => c.amount > 0).map((c) => c.studentId))];
    const applied = await this.advances.applyTo(schoolId, academicYearId, students);
    if (applied.amount === 0) return;
    await this.audit.recordSystem(schoolId, {
      action: 'charge.advance_applied',
      subjectType: 'school',
      subjectId: null,
      metadata: {
        job,
        academicYearId: academicYearId.toString(),
        allocations: applied.allocations.length,
        students: new Set(applied.allocations.map((a) => a.studentId)).size,
        amount: applied.amount,
      },
    });
  }

  // ------------------------------------------------------------------------- stale sweep

  /**
   * R252, from the outbox sweep: a run queued over 10 minutes or running over 15 is failed
   * `stale`, and its campaign goes back to draft, so a crashed run never blocks a year.
   */
  async staleSweep(schoolId: SchoolId, now: Date = new Date()): Promise<number> {
    const stale = await this.runs.stale(schoolId, now);
    for (const run of stale) await this.fail(schoolId, run, 'stale', now);
    if (stale.length > 0) this.logger.warn({ runs: stale.length }, 'stale charge runs failed');
    return stale.length;
  }

  // ------------------------------------------------------------------------- families

  /**
   * fee_charged (R241): one message per fee-payer guardian whose children this run charged, with
   * the family's total of the rows inserted, only when it is positive; subject the run (R107 keeps
   * one per person per run).
   */
  private async notifyFamilies(schoolId: SchoolId, runId: bigint, inserted: readonly InsertedCharge[], notice: RunNotice): Promise<void> {
    const perStudent = new Map<bigint, number>();
    for (const c of inserted) {
      if (c.amount > 0) perStudent.set(c.studentId, (perStudent.get(c.studentId) ?? 0) + c.amount);
    }
    if (perStudent.size === 0) return;
    const links = await this.generation.feePayers(schoolId, [...perStudent.keys()]);
    const families = new Map<bigint, { total: number; children: string[] }>();
    for (const link of links) {
      const family = families.get(link.guardianId) ?? { total: 0, children: [] };
      family.total += perStudent.get(link.studentId) ?? 0;
      family.children.push(link.student.fullName);
      families.set(link.guardianId, family);
    }
    const dueOn = fromDateString(notice.dueOn);
    await this.notifications.sendEach(schoolId, {
      type: 'fee_charged',
      subject: { type: 'charge_run', id: runId },
      items: [...families].map(([guardianId, family]) => ({
        recipient: { guardianId },
        vars: { label: notice.label, total: family.total, children: family.children, dueOn },
      })),
    });
  }

  private async monthNotice(schoolId: SchoolId, period: string, now: Date): Promise<RunNotice> {
    const settings = await this.requireSettings(schoolId);
    const today = await this.today(schoolId, now);
    return { label: `${monthLabel(period)} fees`, dueOn: dueOnOf(period, settings.feeDueDay, today, chargeGrace(settings)) };
  }

  // ------------------------------------------------------------------------- reads

  private async yearClosed(schoolId: SchoolId, academicYearId: bigint): Promise<boolean> {
    const year = await this.generation.yearOf(schoolId, academicYearId);
    return year === null || year.status === 'closed';
  }

  private async requireSettings(schoolId: SchoolId): Promise<SchoolSettingsRecord> {
    const settings = await this.settings.find(schoolId);
    if (!settings) throw new Error('school settings missing for a resolved tenant');
    return settings;
  }

  private async timezone(schoolId: SchoolId): Promise<string> {
    const row = await this.school.find(schoolId);
    if (!row) throw new Error('school row missing for a resolved tenant');
    return row.timezone;
  }

  /** The school's calendar day of `now`, `YYYY-MM-DD`. */
  private async today(schoolId: SchoolId, now: Date): Promise<string> {
    return toDateString(todayIn(await this.timezone(schoolId), now));
  }
}

/** What a run's audit row records (R230): the counts and the amount it charged. */
function runFacts(
  run: { kind: string; period: string; academicYearId: bigint; campaignId: bigint | null },
  generated: Generated,
) {
  return {
    kind: run.kind,
    period: run.period,
    academicYearId: run.academicYearId.toString(),
    campaignId: run.campaignId?.toString() ?? null,
    studentsCharged: generated.studentsCharged,
    chargesInserted: generated.chargesInserted,
    chargesSkipped: generated.chargesSkipped,
    amount: generated.inserted.reduce((sum, c) => sum + c.amount, 0),
    skippedClasses: generated.skippedClasses.length,
  };
}
