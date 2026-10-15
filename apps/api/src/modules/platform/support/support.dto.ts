import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { SUPPORT_SESSION_ENDS, type SupportSessionEnd } from '@asms/shared';
import { IfPresent, Reason, TextField } from '../../../common/fields';
import { ID_PATTERN, IsIdString } from '../../../common/ids';
import { PageQueryDto } from '../../../common/pagination';

// Phase 5 slice 45 (contracts/slice-45.md §1): platform support access. No DTO here carries an
// identity number, a hash, an object key or a message: the views are the closed set of
// phase-5-extended.md §1.1 "Support views".

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE = { type: String, format: 'date' } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;

export const SUPPORT_SESSION_STATUSES = ['open', 'ended'] as const;
export type SupportSessionStatus = (typeof SUPPORT_SESSION_STATUSES)[number];

/** POST /platform/schools/:id/support-sessions. */
export class OpenSupportSessionDto {
  /** Why support needs to look (shown to the principals). */
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;

  /** The support ticket this access serves. */
  @ApiProperty({ minLength: 1, maxLength: 40 })
  @TextField(1, 40)
  ticketRef: string;

  /** A fresh code from the caller's authenticator (a step already used is refused). */
  @ApiProperty({ pattern: '^[0-9]{6}$' })
  @Matches(/^[0-9]{6}$/)
  totp: string;
}

/** POST /platform/support-sessions/:id/close. */
export class CloseSupportSessionDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;
}

export class ListSupportSessionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  schoolId?: string;

  @ApiPropertyOptional({ enum: SUPPORT_SESSION_STATUSES, enumName: 'SupportSessionStatus' })
  @IsOptional()
  @IsIn(SUPPORT_SESSION_STATUSES)
  status?: SupportSessionStatus;
}

/** A support session as the platform sees it. */
export class SupportSessionDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) schoolId: string;
  @ApiProperty() schoolName: string;
  @ApiProperty(ID) platformUserId: string;
  @ApiProperty() platformUserEmail: string;
  /** Whether the caller holds this session (only the holder may read through it or close it). */
  @ApiProperty() mine: boolean;
  @ApiProperty() reason: string;
  @ApiProperty() ticketRef: string;
  @ApiProperty(DATE_TIME) openedAt: Date;
  @ApiProperty(DATE_TIME) expiresAt: Date;
  /** `ended` once closed, revoked or past `expiresAt`. */
  @ApiProperty({ enum: SUPPORT_SESSION_STATUSES, enumName: 'SupportSessionStatus' }) status: SupportSessionStatus;
  @ApiProperty({ ...DATE_TIME, nullable: true }) closedAt: Date | null;
  /** How it ended; `expired` also for a session past its time the job has not closed yet. */
  @ApiProperty({ enum: SUPPORT_SESSION_ENDS, enumName: 'SupportSessionEnd', nullable: true })
  endKind: SupportSessionEnd | null;
  @ApiProperty({ type: String, nullable: true }) closeReason: string | null;
  @ApiProperty({ type: String, nullable: true }) revokeReason: string | null;
}

/** A support session as the school sees it (GET /school/support-sessions). */
export class SchoolSupportSessionDto {
  @ApiProperty(ID) id: string;
  /** Who at ASMS support opened it (their sign-in email). */
  @ApiProperty() supportName: string;
  @ApiProperty() reason: string;
  @ApiProperty() ticketRef: string;
  @ApiProperty(DATE_TIME) openedAt: Date;
  @ApiProperty(DATE_TIME) expiresAt: Date;
  @ApiProperty({ enum: SUPPORT_SESSION_STATUSES, enumName: 'SupportSessionStatus' }) status: SupportSessionStatus;
  @ApiProperty({ ...DATE_TIME, nullable: true }) closedAt: Date | null;
  @ApiProperty({ enum: SUPPORT_SESSION_ENDS, enumName: 'SupportSessionEnd', nullable: true })
  endKind: SupportSessionEnd | null;
  @ApiProperty({ type: String, nullable: true }) revokeReason: string | null;
}

/** MeDto.supportSession: the school's open session, for the staff banner. */
export class MeSupportSessionDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() reason: string;
  @ApiProperty(DATE_TIME) expiresAt: Date;
}

// ---------------------------------------------------------------------------- the views

export class SupportSchoolSettingsDto {
  @ApiProperty(ID) schoolId: string;
  @ApiProperty() name: string;
  @ApiProperty() shortCode: string;
  @ApiProperty() status: string;
  @ApiProperty() timezone: string;
  @ApiProperty() feeDueDay: number;
  @ApiProperty() feeCutoffDay: number;
  @ApiProperty() lateFeeEnabled: boolean;
  @ApiProperty({ type: Number, nullable: true }) lateFeeAmount: number | null;
  @ApiProperty() lateFeeGraceDays: number;
  @ApiProperty() payDay: number;
  @ApiProperty() expenseApprovalThreshold: number;
  @ApiProperty() periodsPerDay: number;
  @ApiProperty({ type: Number, isArray: true }) weeklyOffDays: number[];
  @ApiProperty() studentLoginEnabled: boolean;
  @ApiProperty() lateCountsAs: string;
  @ApiProperty() financialStatementBasis: string;
}

export class SupportStudentsQueryDto extends PageQueryDto {
  /** Exact admission number. */
  @ApiProperty({ minLength: 1, maxLength: 30 })
  @TextField(1, 30)
  admissionNo: string;
}

export class SupportEnrolmentDto {
  @ApiProperty() academicYearName: string;
  @ApiProperty() className: string;
  @ApiProperty() sectionName: string;
  @ApiProperty({ type: Number, nullable: true }) rollNo: number | null;
}

export class SupportStudentSummaryDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty() fullName: string;
  @ApiProperty() status: string;
  @ApiProperty({ type: SupportEnrolmentDto, nullable: true }) current: SupportEnrolmentDto | null;
}

export class SupportGuardianDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() fullName: string;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty() relationship: string;
  @ApiProperty() isPrimaryContact: boolean;
  @ApiProperty() isFeePayer: boolean;
}

export class SupportStudentDto extends SupportStudentSummaryDto {
  @ApiProperty(DATE) admittedOn: string;
  @ApiProperty({ type: SupportGuardianDto, isArray: true }) guardians: SupportGuardianDto[];
}

export class SupportChargeDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() description: string;
  @ApiProperty() feeHeadName: string;
  @ApiProperty({ type: String, nullable: true }) period: string | null;
  @ApiProperty(DATE) dueOn: string;
  /** Whole rupees. */
  @ApiProperty() amount: number;
  @ApiProperty() paid: number;
  @ApiProperty() credited: number;
  @ApiProperty() outstanding: number;
  @ApiProperty() status: string;
}

export class SupportPaymentDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(DATE) receivedOn: string;
  @ApiProperty() method: string;
  @ApiProperty() amount: number;
  /** What of it reached this student (allocations, or an advance held for them). */
  @ApiProperty() forStudent: number;
  @ApiProperty() status: string;
  @ApiProperty(DATE_TIME) verifiedAt: Date;
  @ApiProperty({ type: Number, nullable: true }) receiptNo: number | null;
}
