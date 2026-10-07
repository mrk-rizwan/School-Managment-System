import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page, type PageQueryDto } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import type { SafeHtml } from '../../common/print-view';
import { NotificationService } from '../../messaging/notification.service';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { PayrollRunRepository, type PayrollRunRecord } from '../../repositories/payroll-run.repository';
import { PayslipRepository, type PayslipRecord } from '../../repositories/payslip.repository';
import { SalaryStructureRepository } from '../../repositories/salary-structure.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { isPrincipal, principalRequired } from '../access/money-gates';
import { isEmptySlip, monthBounds, PayrollEngine } from './payroll-engine';
import { skippedOf, toPayrollRunDto, toPayslipDto } from './payroll.mappers';
import { emptyPayslip, type PayslipDays } from './payslip-compute';
import { payslipPage } from './payslip-print';
import type {
  AddPayslipDto,
  AdjustPayslipDto,
  FinaliseRunDto,
  MarkPayslipPaidDto,
  PayrollRunDto,
  PayslipDto,
  PrepareRunDto,
} from './payroll.dto';

// phase-3-financial.md slice 25 (R214, R216-R218, R235, R245-R247); contracts/slice-25.md §4-§6.
// Every write on a run takes the run's row lock first (readLocked), so prepare-race aside (the
// month key), recompute, adjust, finalise and mark-paid on one run serialise.

const ADJUST_ENDPOINT = 'payslip_adjustments';
const RUN_SUBJECT = 'payroll_run';
const PAYSLIP_SUBJECT = 'payslip';

export interface AdjustOutcome {
  replayed: boolean;
  payslip: PayslipDto;
}

const runExists = (runId: bigint): ApiException =>
  new ApiException(409, ErrorCode.PAYROLL_RUN_EXISTS, 'This month already has a payroll run.', {
    runId: runId.toString(),
  });

const runFinalised = (runId: bigint): ApiException =>
  new ApiException(409, ErrorCode.PAYROLL_RUN_FINALISED, 'This payroll run is finalised and can no longer change.', {
    runId: runId.toString(),
  });

const runNotDraft = (runId: bigint): ApiException =>
  new ApiException(409, ErrorCode.PAYROLL_RUN_NOT_DRAFT, 'This payroll run is already finalised.', {
    runId: runId.toString(),
  });

/** Mark-paid on a draft: the payslip is not money yet. */
const runNotFinalised = (): ApiException =>
  new ApiException(409, ErrorCode.ILLEGAL_STATUS_TRANSITION, 'Finalise the payroll run before marking payslips paid.', {
    status: 'draft',
  });

const payslipPaid = (payslipId: bigint): ApiException =>
  new ApiException(409, ErrorCode.PAYSLIP_PAID, 'This payslip is already marked paid.', {
    payslipId: payslipId.toString(),
  });

const payslipExists = (runId: bigint, payslipId: bigint): ApiException =>
  new ApiException(409, ErrorCode.PAYROLL_RUN_EXISTS, 'This staff member already has a payslip in this run.', {
    runId: runId.toString(),
    payslipId: payslipId.toString(),
  });

const structureMissing = (staffId: bigint): ApiException =>
  new ApiException(422, ErrorCode.SALARY_STRUCTURE_MISSING, 'This staff member never had a salary recorded.', {
    staffId: staffId.toString(),
  });

/** R216, R235: nobody adjusts their own payslip (no sole-principal exception). */
const ownPayslip = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You cannot adjust your own payslip. Ask a colleague.', {
    reason: 'own_payslip',
  });

@Injectable()
export class PayrollRunsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly runs: PayrollRunRepository,
    private readonly payslips: PayslipRepository,
    private readonly staff: StaffRepository,
    private readonly structures: SalaryStructureRepository,
    private readonly engine: PayrollEngine,
    private readonly school: OwnSchoolRepository,
    private readonly notifications: NotificationService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  async list(query: PageQueryDto): Promise<Page<PayrollRunDto>> {
    const schoolId = this.context.schoolId;
    const { rows, total } = await this.runs.list(schoolId, { skip: (query.page - 1) * query.limit, take: query.limit });
    return toPage(await this.runDtos(schoolId, rows), query, total);
  }

  async get(id: bigint): Promise<PayrollRunDto> {
    const schoolId = this.context.schoolId;
    const [dto] = await this.runDtos(schoolId, [await this.requireRun(schoolId, id)]);
    if (!dto) throw notFound();
    return dto;
  }

  /** A run's payslips; a draft's carry the attendance days behind each count (the review). */
  async listPayslips(runId: bigint, query: PageQueryDto): Promise<Page<PayslipDto>> {
    const schoolId = this.context.schoolId;
    const run = await this.requireRun(schoolId, runId);
    const { rows, total } = await this.payslips.listForRun(schoolId, runId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const days = run.status === 'draft' ? await this.engine.days(schoolId, run, rows.map((r) => r.staffId)) : new Map<bigint, PayslipDays>();
    return toPage(rows.map((r) => toPayslipDto(r, days.get(r.staffId) ?? null)), query, total);
  }

  /** Any payslip (payroll.view), with the review days while its run is a draft. */
  async getPayslip(id: bigint): Promise<PayslipDto> {
    const schoolId = this.context.schoolId;
    const row = await this.requirePayslip(schoolId, id);
    if (row.run.status !== 'draft') return toPayslipDto(row);
    const days = await this.engine.days(schoolId, { id: row.runId, yearMonth: row.run.yearMonth }, [row.staffId]);
    return toPayslipDto(row, days.get(row.staffId) ?? null);
  }

  /** R217: the caller's own payslips of finalised runs, newest month first. */
  async listMine(staffId: bigint, query: PageQueryDto): Promise<Page<PayslipDto>> {
    const { rows, total } = await this.payslips.listFinalisedForStaff(this.context.schoolId, staffId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map((r) => toPayslipDto(r)), query, total);
  }

  /** R217: one of the caller's own finalised payslips; anyone else's, or a draft's, is 404. */
  async getMine(staffId: bigint, id: bigint): Promise<PayslipDto> {
    const row = await this.requirePayslip(this.context.schoolId, id);
    if (row.staffId !== staffId || row.run.status !== 'finalised') throw notFound();
    return toPayslipDto(row);
  }

  /** The print view (R237) of a payslip already read under its route's rule. */
  async print(slip: PayslipDto): Promise<SafeHtml> {
    const school = await this.school.find(this.context.schoolId);
    return payslipPage(school?.name ?? '', slip);
  }

  // ------------------------------------------------------------------------------ prepare

  /**
   * POST /payroll-runs: a draft for a month that has ended — or the current month from its last
   * working day (month-end salary, §1.1). PAYROLL_RUN_EXISTS when the month has one.
   */
  @Transactional()
  async prepare(dto: PrepareRunDto): Promise<PayrollRunDto> {
    const { schoolId, userId } = this.context.actor();
    await this.assertPreparable(schoolId, dto.yearMonth);
    const existing = await this.runs.findByMonth(schoolId, dto.yearMonth);
    if (existing) throw runExists(existing.id);
    const run = await this.engine.prepare(schoolId, dto.yearMonth, userId, new Date());
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payroll_run.prepared',
      subjectType: RUN_SUBJECT,
      subjectId: run.id,
      metadata: runFacts(run),
    });
    return this.get(run.id);
  }

  private async assertPreparable(schoolId: SchoolId, yearMonth: string): Promise<void> {
    const today = toDateString(await this.clock.today(schoolId));
    const current = today.slice(0, 7);
    if (yearMonth < current) return;
    if (yearMonth === current) {
      const days = await this.engine.workingDays(schoolId, monthBounds(yearMonth));
      const lastWorkingDay = days.at(-1) ?? monthBounds(yearMonth).last;
      if (today >= lastWorkingDay) return;
      throw fieldRefused(
        'yearMonth',
        ErrorCode.INVALID_VALUE,
        `This month can be prepared from its last working day, ${lastWorkingDay}`,
      );
    }
    throw fieldRefused('yearMonth', ErrorCode.INVALID_VALUE, 'yearMonth must not be a future month');
  }

  // ---------------------------------------------------------------------------- recompute

  /** A draft rewritten from the month's data now (attendance amended, leave approved). */
  @Transactional()
  async recompute(id: bigint): Promise<PayrollRunDto> {
    const { schoolId, userId } = this.context.actor();
    const run = await this.lockRun(schoolId, id);
    if (run.status !== 'draft') throw runFinalised(id);
    await this.engine.recompute(schoolId, run, userId, new Date());
    const now = await this.requireRun(schoolId, id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payroll_run.recomputed',
      subjectType: RUN_SUBJECT,
      subjectId: id,
      metadata: { ...runFacts(now), previousTotalNet: run.totalNet },
    });
    return this.get(id);
  }

  // --------------------------------------------------------------------- correction slip

  /**
   * POST /payroll-runs/:id/payslips (R216): a payslip with nothing computed for someone the draft
   * does not pay — left before the month, suspended, or without a structure when it was prepared —
   * so a correction of an earlier payslip can be adjusted onto it. On the person's latest structure
   * of any status; the run lists them as skipped with the reason. Adjust, recompute and finalise
   * treat it as any payslip the run keeps (recompute computes it if the person is now payable).
   */
  @Transactional()
  async addPayslip(id: bigint, dto: AddPayslipDto): Promise<PayslipDto> {
    const { schoolId, userId } = this.context.actor();
    const run = await this.lockRun(schoolId, id);
    if (run.status !== 'draft') throw runFinalised(id);
    const staffId = BigInt(dto.staffId);
    const member = await this.staff.findById(schoolId, staffId);
    if (!member) throw notFound();
    const existing = (await this.payslips.ofRun(schoolId, id)).find((s) => s.staffId === staffId);
    if (existing) throw payslipExists(id, existing.id);
    const structure = await this.structures.latestAnyStatus(schoolId, staffId);
    if (!structure) throw structureMissing(staffId);

    const first = monthBounds(run.yearMonth).first;
    const reason =
      member.status === 'suspended'
        ? 'suspended'
        : member.status === 'left' && member.leftOn !== null && toDateString(member.leftOn) < first
          ? 'not_employed'
          : 'no_salary_structure';
    const figures = emptyPayslip(structure.id, 0);
    if (figures === null) throw new Error('an empty payslip with no adjustment always has a figure');
    const [created] = await this.payslips.createMany(schoolId, id, [{ staffId, ...figures, lines: [] }]);
    if (!created) throw notFound();
    const skipped = skippedOf(run).filter((s) => s.staffId !== staffId.toString());
    await this.runs.setTotals(
      schoolId,
      id,
      { workingDays: run.workingDays, staffCount: run.staffCount + 1, skipped: [...skipped, { staffId: staffId.toString(), reason }], totalNet: run.totalNet },
      run.preparedBy,
      run.preparedAt,
    );
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payslip.added',
      subjectType: PAYSLIP_SUBJECT,
      subjectId: created.id,
      reason: dto.reason,
      metadata: { runId: id.toString(), yearMonth: run.yearMonth, staffId: staffId.toString(), structureId: structure.id.toString(), skipReason: reason },
    });
    return this.getPayslip(created.id);
  }

  // ------------------------------------------------------------------------------- adjust

  /**
   * POST /payslips/:id/adjust, keyed (endpoint payslip_adjustments, path id the payslip): a signed
   * line on a draft payslip, never one's own (R216, R235); a correction names the earlier
   * finalised payslip of the same person. payslipNet refuses one that takes more than the pay.
   */
  async adjust(session: SchoolSessionContext, id: bigint, dto: AdjustPayslipDto, rawKey: string | undefined): Promise<AdjustOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ADJUST_ENDPOINT, id, dto, rawKey, (claim) =>
      this.adjustInTransaction(session, actor, id, dto, claim),
    );
    const payslipId = outcome.replayed ? outcome.subjectId : outcome.value;
    return { replayed: outcome.replayed, payslip: await this.getPayslip(payslipId) };
  }

  @Transactional()
  private async adjustInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    id: bigint,
    dto: AdjustPayslipDto,
    claim: IdempotencyClaim,
  ): Promise<bigint> {
    const recordSubject = await this.idempotency.claim(actor, ADJUST_ENDPOINT, claim, PAYSLIP_SUBJECT);
    const { schoolId, userId } = actor;
    const slip = await this.requirePayslip(schoolId, id);
    const run = await this.lockRun(schoolId, slip.runId);
    if (run.status !== 'draft') throw runFinalised(run.id);
    if (session.access.staffId === slip.staffId) throw ownPayslip();

    let adjustsPayslipId: bigint | null = null;
    if (dto.adjustsPayslipId !== undefined) {
      const target = await this.payslips.findById(schoolId, BigInt(dto.adjustsPayslipId));
      if (!target || target.staffId !== slip.staffId) {
        throw fieldRefused('adjustsPayslipId', ErrorCode.REFERENCE_NOT_FOUND, 'No earlier payslip of this staff member');
      }
      if (target.run.status !== 'finalised') {
        throw fieldRefused('adjustsPayslipId', ErrorCode.INVALID_VALUE, 'Only a payslip of a finalised run is corrected');
      }
      if (target.run.yearMonth >= run.yearMonth) {
        throw fieldRefused('adjustsPayslipId', ErrorCode.INVALID_VALUE, "Only an earlier month's payslip is corrected");
      }
      adjustsPayslipId = target.id;
    }
    await this.payslips.addAdjustment(schoolId, {
      payslipId: slip.id,
      staffId: slip.staffId,
      name: dto.name,
      amount: dto.amount,
      adjustsPayslipId,
      reason: dto.reason,
      createdBy: userId,
    });
    const delta = await this.engine.recomputeOne(schoolId, run, slip.staffId);
    if (delta !== 0) await this.runs.addToTotalNet(schoolId, run.id, delta);
    await recordSubject(slip.id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payslip.adjusted',
      subjectType: PAYSLIP_SUBJECT,
      subjectId: slip.id,
      reason: dto.reason,
      metadata: {
        runId: run.id.toString(),
        yearMonth: run.yearMonth,
        staffId: slip.staffId.toString(),
        amount: dto.amount,
        name: dto.name,
        ...(adjustsPayslipId === null ? {} : { adjustsPayslipId: adjustsPayslipId.toString() }),
      },
    });
    return slip.id;
  }

  // ----------------------------------------------------------------------------- finalise

  /**
   * R216: the run is recomputed from the month's data now (advances locked first, so each
   * recovery is what is still owed), frozen, and its recoveries written (the trigger raises each
   * advance's counter); `payslip_ready` to every staff member with a payslip. A finaliser whose own
   * slip carries an adjustment needs the principal role.
   */
  @Transactional()
  async finalise(session: SchoolSessionContext, id: bigint, dto: FinaliseRunDto): Promise<PayrollRunDto> {
    const { schoolId, userId } = this.context.actor();
    const run = await this.lockRun(schoolId, id);
    if (run.status !== 'draft') throw runNotDraft(id);
    const ownStaffId = session.access.staffId;
    if (ownStaffId !== null && !isPrincipal(session) && (await this.payslips.hasAdjustment(schoolId, id, ownStaffId))) {
      throw principalRequired();
    }
    const now = new Date();
    const { plan, slipIds } = await this.engine.recompute(schoolId, run, run.preparedBy, run.preparedAt, { lockAdvances: true });
    if ((await this.runs.finalise(schoolId, id, userId, now, dto.reason ?? null)) === 0) throw runNotDraft(id);
    const recoveries = plan.slips.flatMap((slip) => {
      const payslipId = slipIds.get(slip.staffId);
      return payslipId === undefined
        ? []
        : slip.recoveries.map((r) => ({ advanceId: r.advanceId, payslipId, staffId: slip.staffId, amount: r.amount }));
    });
    await this.payslips.addRecoveries(schoolId, recoveries);
    // A payslip with nothing computed (kept or added for a correction) is not announced.
    const recipients = plan.slips.filter((slip) => !isEmptySlip(slip)).map((slip) => ({ staffId: slip.staffId }));
    if (recipients.length > 0) {
      await this.notifications.send(schoolId, {
        type: 'payslip_ready',
        subject: { type: 'payslip', id },
        recipients,
        vars: { yearMonth: run.yearMonth },
      });
    }
    const totalNet = plan.slips.reduce((sum, s) => sum + s.figures.net, 0);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payroll_run.finalised',
      subjectType: RUN_SUBJECT,
      subjectId: id,
      ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      metadata: {
        yearMonth: run.yearMonth,
        staffCount: plan.slips.length,
        totalNet,
        recoveries: recoveries.length,
        recoveredTotal: recoveries.reduce((sum, r) => sum + r.amount, 0),
      },
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------------------- mark paid

  /** R218: date, method and reference, once, on a finalised run's payslip. */
  @Transactional()
  async markPaid(id: bigint, dto: MarkPayslipPaidDto): Promise<PayslipDto> {
    const { schoolId, userId } = this.context.actor();
    const slip = await this.requirePayslip(schoolId, id);
    if (slip.run.status !== 'finalised') throw runNotFinalised();
    if (slip.status === 'paid') throw payslipPaid(id);
    const paidOn = fromDateString(dto.paidOn);
    if (paidOn > (await this.clock.today(schoolId))) {
      throw fieldRefused('paidOn', ErrorCode.INVALID_VALUE, 'paidOn must be no later than today');
    }
    const paid = { paidOn, paidMethod: dto.paidMethod, paidReference: dto.paidReference ?? null, paidBy: userId };
    if ((await this.payslips.markPaid(schoolId, id, paid)) === 0) throw payslipPaid(id);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'payslip.paid',
      subjectType: PAYSLIP_SUBJECT,
      subjectId: id,
      metadata: {
        runId: slip.runId.toString(),
        yearMonth: slip.run.yearMonth,
        staffId: slip.staffId.toString(),
        amount: slip.net,
        paidOn: dto.paidOn,
        paidMethod: dto.paidMethod,
      },
    });
    return this.getPayslip(id);
  }

  // -------------------------------------------------------------------------------- helpers

  private async requireRun(schoolId: SchoolId, id: bigint): Promise<PayrollRunRecord> {
    const run = await this.runs.findById(schoolId, id);
    if (!run) throw notFound();
    return run;
  }

  private async lockRun(schoolId: SchoolId, id: bigint): Promise<PayrollRunRecord> {
    return readLocked(
      () => this.runs.findById(schoolId, id),
      (row) => this.runs.lockIfUnchanged(schoolId, row),
    );
  }

  private async requirePayslip(schoolId: SchoolId, id: bigint): Promise<PayslipRecord> {
    const row = await this.payslips.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  private async runDtos(schoolId: SchoolId, rows: readonly PayrollRunRecord[]): Promise<PayrollRunDto[]> {
    const unmarked = await this.runs.unmarkedTotals(schoolId, rows.map((r) => r.id));
    const staffIds = [...new Set(rows.flatMap((r) => skippedOf(r).map((s) => s.staffId)))];
    const names = await this.runs.staffNames(schoolId, staffIds.map((s) => BigInt(s)));
    return rows.map((row) => toPayrollRunDto(row, names, unmarked.get(row.id) ?? 0));
  }
}

/** What a run's audit rows carry (R230): the month and the money. */
function runFacts(run: PayrollRunRecord) {
  return {
    yearMonth: run.yearMonth,
    workingDays: run.workingDays,
    staffCount: run.staffCount,
    skipped: skippedOf(run).length,
    totalNet: run.totalNet,
  };
}
