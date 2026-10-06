import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, yearMonthOf } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { IdempotentRequests, type IdempotencyClaim } from '../../common/idempotency';
import { readLocked } from '../../common/locking';
import { toPage, type Page, type PageQueryDto } from '../../common/pagination';
import { addDays, SchoolClock } from '../../common/school-clock';
import { SchoolContext, type Actor } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { SalaryStructureRepository } from '../../repositories/salary-structure.repository';
import { StaffRepository } from '../../repositories/staff.repository';
import { fromDateString, toDateString } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { toSalaryStructureDto } from './payroll.mappers';
import type { CreateSalaryStructureDto, MySalaryStructureDto, SalaryStructureDto } from './payroll.dto';

// phase-3-financial.md slice 25 (R213, R235, R253); contracts/slice-25.md §2. Lock order: the staff
// row (every structure write for one person serialises on it), then the school_settings row when
// the writer is the person (isSolePrincipal), then the structures.

const ENDPOINT = 'salary_structures';
const SUBJECT = 'salary_structure';

export interface SalaryStructureCreateOutcome {
  replayed: boolean;
  structure: SalaryStructureDto;
}

/** R235: nobody writes their own salary structure (the sole principal excepted, R253). */
export const ownSalary = (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, 'You cannot set your own salary. Ask a colleague.', {
    reason: 'own_salary',
  });

/** R213: a finalised payslip of a month on or after the new start used the row being replaced. */
const structureInUse = (structureId: bigint, yearMonth: string): ApiException =>
  new ApiException(
    409,
    ErrorCode.SALARY_STRUCTURE_IN_USE,
    `The current salary was paid for ${yearMonth}. A change can start only after that month.`,
    { structureId: structureId.toString(), yearMonth },
  );

@Injectable()
export class SalaryStructuresService {
  constructor(
    private readonly context: SchoolContext,
    private readonly structures: SalaryStructureRepository,
    private readonly staff: StaffRepository,
    private readonly permissions: PermissionsService,
    private readonly idempotency: IdempotentRequests,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  // ---------------------------------------------------------------------------------- reads

  /** Current and history, newest start first (staff.contract.manage | payroll.view). */
  async listForStaff(staffId: bigint, query: PageQueryDto): Promise<Page<SalaryStructureDto>> {
    const schoolId = this.context.schoolId;
    if (!(await this.staff.findById(schoolId, staffId))) throw notFound();
    const { rows, total } = await this.structures.listForStaff(schoolId, staffId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toSalaryStructureDto), query, total);
  }

  /** R217: the caller's own structure in force today, and a recorded change after it. */
  async mine(staffId: bigint): Promise<MySalaryStructureDto> {
    const schoolId = this.context.schoolId;
    const today = await this.clock.today(schoolId);
    const current = await this.structures.activeOn(schoolId, staffId, today);
    const upcoming = await this.structures.nextAfter(schoolId, staffId, today);
    return {
      current: current === null ? null : toSalaryStructureDto(current),
      upcoming: upcoming === null ? null : toSalaryStructureDto(upcoming),
    };
  }

  // ---------------------------------------------------------------------------------- write

  /**
   * POST /staff/:id/salary-structure, keyed (endpoint salary_structures, path id the staff
   * member). The new row closes the latest on `effectiveFrom − 1`, or supersedes it when it
   * starts the same day; it may not start before the latest (§2).
   */
  async create(
    session: SchoolSessionContext,
    staffId: bigint,
    dto: CreateSalaryStructureDto,
    rawKey: string | undefined,
  ): Promise<SalaryStructureCreateOutcome> {
    const actor = this.context.actor();
    const outcome = await this.idempotency.withIdempotencyKey(actor, ENDPOINT, staffId, dto, rawKey, (claim) =>
      this.createInTransaction(session, actor, staffId, dto, claim),
    );
    const id = outcome.replayed ? outcome.subjectId : outcome.value;
    const row = await this.structures.findById(actor.schoolId, id);
    if (!row) throw notFound();
    return { replayed: outcome.replayed, structure: toSalaryStructureDto(row) };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    actor: Actor,
    staffId: bigint,
    dto: CreateSalaryStructureDto,
    claim: IdempotencyClaim,
  ): Promise<bigint> {
    const recordSubject = await this.idempotency.claim(actor, ENDPOINT, claim, SUBJECT);
    const { schoolId, userId } = actor;
    await readLocked(
      () => this.staff.findById(schoolId, staffId),
      (row) => this.staff.lockIfUnchanged(schoolId, row),
    );
    assertComponentNames(dto);

    // R235, R253: one's own structure only as the sole principal, recorded self_approved.
    let selfApproved = false;
    if (session.access.staffId === staffId) {
      if (!(await this.permissions.isSolePrincipal(schoolId, userId))) throw ownSalary();
      selfApproved = true;
    }

    const effectiveFrom = fromDateString(dto.effectiveFrom);
    const latest = await this.structures.latestActive(schoolId, staffId);
    let replaced: { id: bigint; how: 'superseded' | 'closed' } | null = null;
    let endedOn: Date | null = null;
    if (latest) {
      if (effectiveFrom < latest.effectiveFrom) {
        throw fieldRefused(
          'effectiveFrom',
          ErrorCode.INVALID_VALUE,
          `effectiveFrom must be on or after ${toDateString(latest.effectiveFrom)}, when the current salary starts`,
        );
      }
      // R213: not into a month already paid on the row being replaced.
      const month = yearMonthOf(dto.effectiveFrom);
      if (await this.structures.usedByFinalisedFrom(schoolId, latest.id, month)) {
        throw structureInUse(latest.id, month);
      }
      if (effectiveFrom.getTime() === latest.effectiveFrom.getTime()) {
        if ((await this.structures.supersede(schoolId, latest.id, new Date())) === 0) throw notFound();
        endedOn = latest.endedOn;
        replaced = { id: latest.id, how: 'superseded' };
      } else {
        if ((await this.structures.close(schoolId, latest.id, addDays(effectiveFrom, -1))) === 0) throw notFound();
        replaced = { id: latest.id, how: 'closed' };
      }
    }

    const id = await this.structures.create(schoolId, {
      staffId,
      basic: dto.basic,
      effectiveFrom,
      endedOn,
      reason: dto.reason,
      createdBy: userId,
      selfApproved,
      components: dto.components.map((c) => ({ kind: c.kind, name: c.name, amount: c.amount })),
    });
    if (replaced?.how === 'superseded') await this.structures.setSupersededBy(schoolId, replaced.id, id);
    await recordSubject(id);
    const sum = (kind: 'allowance' | 'deduction') =>
      dto.components.filter((c) => c.kind === kind).reduce((total, c) => total + c.amount, 0);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'salary_structure.created',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {
        staffId: staffId.toString(),
        basic: dto.basic,
        allowancesTotal: sum('allowance'),
        deductionsTotal: sum('deduction'),
        components: dto.components.length,
        effectiveFrom: dto.effectiveFrom,
        selfApproved,
        ...(replaced === null ? {} : { [`${replaced.how}Id`]: replaced.id.toString() }),
      },
    });
    return id;
  }
}

/** salary_structure_components_name_key: one name per kind in a structure. */
function assertComponentNames(dto: CreateSalaryStructureDto): void {
  const seen = new Set<string>();
  dto.components.forEach((c, i) => {
    const key = `${c.kind}:${c.name.toLowerCase()}`;
    if (seen.has(key)) {
      throw fieldRefused(`components.${i}.name`, ErrorCode.INVALID_VALUE, `Two ${c.kind}s are named ${c.name}`);
    }
    seen.add(key);
  });
}
