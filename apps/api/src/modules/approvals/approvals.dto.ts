import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExpenseDto } from '../expenses/expenses.dto';
import { LeaveRequestDto } from '../leave/leave.dto';
import { ClaimDto } from '../payments/claims.dto';
import { HandoverDto } from '../payments/payments.dto';
import { ResultSheetDto } from '../results/results.dto';

// phase-3-financial.md slice 27 (R227); contracts/slice-27.md. Each section is the first page of
// the existing queue with its total, so `count` is what that queue's own endpoint reports.

const COUNT = { type: Number, minimum: 0, description: "The queue's total: what its own list endpoint reports" } as const;

export class ApprovalClaimsDto {
  @ApiProperty(COUNT) count: number;
  @ApiProperty({ type: () => ClaimDto, isArray: true, maxItems: 10 }) items: ClaimDto[];
}

export class ApprovalHandoversDto {
  @ApiProperty(COUNT) count: number;
  @ApiProperty({ type: () => HandoverDto, isArray: true, maxItems: 10 }) items: HandoverDto[];
}

export class ApprovalExpensesDto {
  @ApiProperty(COUNT) count: number;
  @ApiProperty({ type: () => ExpenseDto, isArray: true, maxItems: 10 }) items: ExpenseDto[];
}

export class ApprovalLeaveDto {
  @ApiProperty(COUNT) count: number;
  @ApiProperty({ type: () => LeaveRequestDto, isArray: true, maxItems: 10 }) items: LeaveRequestDto[];
}

export class ApprovalResultsDto {
  @ApiProperty(COUNT) count: number;
  @ApiProperty({ type: () => ResultSheetDto, isArray: true, maxItems: 10 }) items: ResultSheetDto[];
}

/** Only the sections whose key the caller holds; none at all is `{}`. */
export class ApprovalsDto {
  /** `payment.verify`: pending deposit claims with their slip (GET /payment-claims), oldest first. */
  @ApiPropertyOptional({ type: () => ApprovalClaimsDto }) claims?: ApprovalClaimsDto;
  /** `collection.handover.confirm`: open handovers (GET /cash-handovers?status=open). */
  @ApiPropertyOptional({ type: () => ApprovalHandoversDto }) handovers?: ApprovalHandoversDto;
  /** `expense.approve`: expenses waiting for approval (GET /expenses?status=pending_approval). */
  @ApiPropertyOptional({ type: () => ApprovalExpensesDto }) expenses?: ApprovalExpensesDto;
  /** `staff.leave.approve`: pending leave requests (GET /leave-requests?status=pending). */
  @ApiPropertyOptional({ type: () => ApprovalLeaveDto }) leave?: ApprovalLeaveDto;
  /**
   * `result.approve` (Phase 4 slice 31, R278): result sheets waiting for a decision
   * (GET /result-sheets?status=submitted), with their own-child and cover flags.
   */
  @ApiPropertyOptional({ type: () => ApprovalResultsDto }) results?: ApprovalResultsDto;
}
