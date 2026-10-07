import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Capability, concessionAmount, dueOn as dueOnOf, ErrorCode, MAX_RUPEES } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { fieldRefused } from '../../common/errors/api-exception';
import { IfPresent, Rupees } from '../../common/fields';
import { SchoolClock } from '../../common/school-clock';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ChargeRepository } from '../../repositories/charge.repository';
import { ChargeGenerationRepository } from '../../repositories/charge-generation.repository';
import { ConcessionRepository } from '../../repositories/concession.repository';
import { SchoolSettingsRepository } from '../../repositories/school-settings.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { FINANCE_READERS, isPrincipal } from '../access/money-gates';
import { PermissionsService } from '../access/permissions.service';
import { toDateString } from '../academics/academics.shared';
import type { ChargeDto } from './charges.dto';
import { chargeGrace, concessionExists, concessionHeadNotEligible, toChargeDto } from './charges.shared';
import { ConcessionsService } from './concessions.service';
import { requireHeld } from './fee-gates';

// R239 (phase-3-financial.md §1.1 "Once and yearly heads", slice 19): admission and readmission
// charge the class's `once` heads in their own transaction, and the office's decision on the
// admission fee: full, partial (the family pays `amount`) or free. A partial or free decision is
// a fixed concession on the admission head, approved when the caller is a principal holding
// `concession.grant`, else requested for a principal to decide.

export const ADMISSION_FEE_DECISIONS = ['full', 'partial', 'free'] as const;
export type AdmissionFeeDecision = (typeof ADMISSION_FEE_DECISIONS)[number];

export class AdmissionFeeDto {
  @ApiProperty({ enum: ADMISSION_FEE_DECISIONS, enumName: 'AdmissionFeeDecision' })
  @IsIn(ADMISSION_FEE_DECISIONS)
  decision: AdmissionFeeDecision;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_RUPEES,
    description: 'partial only: what the family pays, below the admission fee',
  })
  @IfPresent()
  @Rupees(1)
  amount?: number;
}

/** The enrolment admission or readmission has just written. */
export interface NewEnrolment {
  studentId: bigint;
  enrolmentId: bigint;
  academicYearId: bigint;
  classId: bigint;
}

@Injectable()
export class AdmissionFees {
  constructor(
    private readonly charges: ChargeRepository,
    private readonly generation: ChargeGenerationRepository,
    private readonly concessions: ConcessionRepository,
    private readonly concessionsService: ConcessionsService,
    private readonly settings: SchoolSettingsRepository,
    private readonly permissions: PermissionsService,
    private readonly clock: SchoolClock,
    private readonly audit: AuditLogRepository,
  ) {}

  /**
   * The shape rules, before any write: `amount` only with `partial`, which needs it; a reduction
   * is a concession request, so it needs `charge.create`.
   */
  assertDecision(session: SchoolSessionContext, dto: AdmissionFeeDto | undefined, path: string): void {
    if (dto === undefined) return;
    if (dto.decision === 'partial' && dto.amount === undefined) {
      throw fieldRefused(`${path}.amount`, ErrorCode.INVALID_VALUE, 'amount is required for a partial admission fee');
    }
    if (dto.decision !== 'partial' && dto.amount !== undefined) {
      throw fieldRefused(`${path}.amount`, ErrorCode.INVALID_VALUE, 'amount is taken only with a partial decision');
    }
    if (dto.decision !== 'full') requireHeld(session, Capability.CHARGE_CREATE);
  }

  /**
   * Inside the admission or readmission transaction, after the enrolment and the guardian links:
   * one `generated` charge per priced `once` head on charges_once_key (a readmission is a new
   * enrolment, so it is charged again), the admission head reduced by the decision.
   */
  async charge(
    session: SchoolSessionContext,
    schoolId: SchoolId,
    enrolment: NewEnrolment,
    dto: AdmissionFeeDto | undefined,
    path: string,
  ): Promise<void> {
    const decision = dto?.decision;
    const userId = session.access.userId;
    const today = toDateString(await this.clock.today(schoolId));
    const period = today.slice(0, 7);
    const priced = await this.generation.onceStructures(schoolId, enrolment.classId, period);
    if (priced.length === 0) return;
    const settings = await this.settings.find(schoolId);
    if (!settings) throw new Error('school settings missing for a resolved tenant');
    const dueOn = new Date(`${dueOnOf(period, settings.feeDueDay, today, chargeGrace(settings))}T00:00:00.000Z`);
    for (const item of priced) {
      const isAdmission = item.head.category === 'admission';
      let concession: { id: bigint; conceded: number } | null = null;
      if (isAdmission) {
        concession = await this.reduce(session, schoolId, enrolment, item, decision, dto?.amount, period, path);
      }
      const created = await this.charges.create(
        schoolId,
        {
          enrolmentId: enrolment.enrolmentId,
          studentId: enrolment.studentId,
          academicYearId: enrolment.academicYearId,
          feeHeadId: item.feeHeadId,
          headFrequency: 'once',
          kind: 'generated',
          period: null,
          concessionId: concession !== null && concession.conceded > 0 ? concession.id : null,
          grossAmount: item.amount,
          concessionAmount: concession?.conceded ?? 0,
          description: item.head.name,
          dueOn,
          createdBy: userId,
        },
        new Date(),
      );
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: 'charge.admission_fee',
        subjectType: 'charge',
        subjectId: created.id,
        metadata: {
          studentId: enrolment.studentId.toString(),
          enrolmentId: enrolment.enrolmentId.toString(),
          feeHeadId: item.feeHeadId.toString(),
          decision: isAdmission ? (decision ?? 'unchanged') : 'full',
          grossAmount: item.amount,
          amount: created.amount,
          concessionId: concession?.id.toString() ?? null,
        },
      });
    }
  }

  /** The once-head charges of an enrolment, for a caller who reads money (R234); else none. */
  async chargesOf(session: SchoolSessionContext, schoolId: SchoolId, enrolmentId: bigint): Promise<ChargeDto[]> {
    if (!FINANCE_READERS.some((key) => session.access.capabilities.has(key))) return [];
    return (await this.charges.onceChargesOf(schoolId, enrolmentId)).map(toChargeDto);
  }

  /**
   * The admission head's concession for this enrolment (R239). A live concession of the year on
   * the head (an earlier admission's, the same year) is reused when no decision is sent or the
   * decision is the same; a different decision retires it (ended if approved, rejected if still
   * requested) and writes the new one, all in the admission or readmission transaction. A new
   * reduction is a fixed concession, approved for a principal holding `concession.grant`
   * (requested instead when it is their own child and they are not the sole principal, so the
   * admission itself is never refused). Returns what it takes off this charge now.
   */
  private async reduce(
    session: SchoolSessionContext,
    schoolId: SchoolId,
    enrolment: NewEnrolment,
    item: { feeHeadId: bigint; amount: number; head: { concessionEligible: boolean } },
    decision: AdmissionFeeDecision | undefined,
    amount: number | undefined,
    period: string,
    path: string,
  ): Promise<{ id: bigint; conceded: number } | null> {
    const userId = session.access.userId;
    let value: number | null = null;
    if (decision === 'partial' || decision === 'free') {
      if (!item.head.concessionEligible) throw concessionHeadNotEligible(item.feeHeadId);
      const pays = decision === 'free' ? 0 : (amount ?? 0);
      if (pays >= item.amount) {
        throw fieldRefused(`${path}.amount`, ErrorCode.INVALID_VALUE, `amount must be below the admission fee (${item.amount})`);
      }
      value = item.amount - pays;
    }
    const fixed = (v: number) =>
      concessionAmount(item.amount, { kind: 'fixed', value: v, feeHeadIds: [item.feeHeadId] }, { id: item.feeHeadId, concessionEligible: true });

    await this.concessions.lockStudent(schoolId, enrolment.studentId);
    const live = await this.concessions.findLiveOnHeads(schoolId, enrolment.studentId, enrolment.academicYearId, [item.feeHeadId]);
    const old = live ? await this.concessions.findById(schoolId, live.concessionId) : null;
    if (old) {
      const same = decision === undefined || (value !== null && old.kind === 'fixed' && old.value === value);
      if (same) {
        const conceded = old.status === 'approved' ? concessionAmount(item.amount, { kind: old.kind, value: old.value, feeHeadIds: [item.feeHeadId] }, { id: item.feeHeadId, concessionEligible: item.head.concessionEligible }) : 0;
        return { id: old.id, conceded };
      }
      // A concession reaching other heads too is not this decision's to retire.
      if (old.heads.length > 1) throw concessionExists(old.id, item.feeHeadId);
      const reason = 'Replaced by the admission fee decision at readmission';
      const now = new Date();
      const retired =
        old.status === 'approved'
          ? await this.concessions.end(schoolId, old.id, userId, reason, now)
          : await this.concessions.decide(schoolId, old.id, { status: 'rejected', by: userId, at: now, reason, selfApproved: false });
      if (retired !== 1) throw concessionExists(old.id, item.feeHeadId);
      await this.audit.record(schoolId, {
        actorUserId: userId,
        action: old.status === 'approved' ? 'concession.ended' : 'concession.rejected',
        subjectType: 'concession',
        subjectId: old.id,
        reason,
        metadata: { studentId: enrolment.studentId.toString(), enrolmentId: enrolment.enrolmentId.toString() },
      });
    }
    if (value === null) return null;

    let approved: { selfApproved: boolean } | null = null;
    if (isPrincipal(session) && session.access.capabilities.has(Capability.CONCESSION_GRANT)) {
      if (!(await this.permissions.actorIsGuardianOf(schoolId, userId, enrolment.studentId))) {
        approved = { selfApproved: false };
      } else if (await this.permissions.isSolePrincipal(schoolId, userId)) {
        approved = { selfApproved: true };
      }
    }
    const id = await this.concessionsService.insert(
      schoolId,
      userId,
      {
        studentId: enrolment.studentId,
        academicYearId: enrolment.academicYearId,
        enrolmentId: enrolment.enrolmentId,
        kind: 'fixed',
        value,
        effectiveFrom: period,
        reason: decision === 'free' ? 'Admission fee waived at admission' : 'Admission fee reduced at admission',
        feeHeadIds: [item.feeHeadId],
      },
      approved,
    );
    return { id, conceded: approved === null ? 0 : fixed(value) };
  }
}
