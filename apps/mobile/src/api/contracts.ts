import type { components } from './school';

// The DTO and body types the screens use, from the generated document (slice-15 §2.5). A
// regenerated document that changes one of these is caught by `pnpm typecheck`.
type Schemas = components['schemas'];

export type MeDto = Schemas['MeDto'];
export type LoginResultDto = Schemas['LoginResultDto'];
export type MeAssignmentDto = Schemas['MeAssignmentDto'];
export type DeviceDto = Schemas['DeviceDto'];
/** The contract calls it MeCalendarDto; the generated document names it MyCalendarDto. */
export type MyCalendarDto = Schemas['MyCalendarDto'];
export type SchoolLoginDto = Schemas['SchoolLoginDto'];
export type RegisterDeviceDto = Schemas['RegisterDeviceDto'];
export type ChangePasswordDto = Schemas['ChangePasswordDto'];
export type SessionsRevokedDto = Schemas['SessionsRevokedDto'];

// Slice 16: attendance, diary, remarks and the parent/student/staff reads.
export type RegisterViewDto = Schemas['RegisterViewDto'];
export type RosterRowDto = Schemas['RosterRowDto'];
export type RegisterSubmitResultDto = Schemas['RegisterSubmitResultDto'];
export type RegisterSubmitMinimalResultDto = Schemas['RegisterSubmitMinimalResultDto'];
export type RegisterDto = Schemas['RegisterDto'];
export type RegisterCountsDto = Schemas['RegisterCountsDto'];
export type SubmitRegisterDto = Schemas['SubmitRegisterDto'];
export type AttendanceMarkDto = Schemas['AttendanceMarkDto'];
export type AmendMarkDto = Schemas['AmendMarkDto'];
export type MarkChangeDto = Schemas['MarkChangeDto'];
export type StudentAttendanceDto = Schemas['StudentAttendanceDto'];
export type StudentDayDto = Schemas['StudentDayDto'];
export type MyStaffAttendanceDto = Schemas['MyStaffAttendanceDto'];
export type MyStaffAttendanceDayDto = Schemas['MyStaffAttendanceDayDto'];
export type DiaryEntryDto = Schemas['DiaryEntryDto'];
export type MyDiaryEntryDto = Schemas['MyDiaryEntryDto'];
export type CreateDiaryEntryDto = Schemas['CreateDiaryEntryDto'];
export type RemarkDto = Schemas['RemarkDto'];
export type MyRemarkDto = Schemas['MyRemarkDto'];
export type CreateRemarkDto = Schemas['CreateRemarkDto'];
export type MyChildDto = Schemas['MyChildDto'];
export type SectionDto = Schemas['SectionDto'];
export type SubjectDto = Schemas['SubjectDto'];
export type StagedUploadDto = Schemas['StagedUploadDto'];

// Slice 16b: Today, Announce, the inbox (contracts/slice-14.md, slice-11 §10, slice-10 §6).
export type SectionDayDto = Schemas['SectionDayDto'];
export type DailySummaryDto = Schemas['DailySummaryDto'];
export type StaffDto = Schemas['StaffDto'];
export type TeacherAssignmentDto = Schemas['TeacherAssignmentDto'];
export type MessagingUsageDto = Schemas['MessagingUsageDto'];
export type ClassDto = Schemas['ClassDto'];
export type AnnouncementDto = Schemas['AnnouncementDto'];
export type AudienceInputDto = Schemas['AudienceInputDto'];
export type AudiencePreviewDto = Schemas['AudiencePreviewDto'];
export type DeliverySummaryDto = Schemas['DeliverySummaryDto'];
export type InboxItemDto = Schemas['InboxItemDto'];

// Phase 3 slice 23: expense capture (§3.9).
export type CreateExpenseDto = Schemas['CreateExpenseDto'];
export type ExpenseDto = Schemas['ExpenseDto'];
export type RecordableExpenseCategory = Schemas['RecordableExpenseCategory'];
export type CounterPaymentMethod = Schemas['CounterPaymentMethod'];

// Phase 3 slice 24: My leave (online only, R226).
export type LeaveTypeDto = Schemas['LeaveTypeDto'];
export type LeaveBalanceDto = Schemas['LeaveBalanceDto'];
export type LeaveRequestDto = Schemas['LeaveRequestDto'];
export type CreateMyLeaveRequestDto = Schemas['CreateMyLeaveRequestDto'];

// Phase 3 slice 25: My payslips (online read, rendered natively).
export type PayslipDto = Schemas['PayslipDto'];
export type MySalaryStructureDto = Schemas['MySalaryStructureDto'];

// Phase 3 slice 21: the guardian's Fees (dues, receipts, deposit claims; §3.9).
export type MyDuesDto = Schemas['MyDuesDto'];
export type MyChargeDto = Schemas['MyChargeDto'];
export type MyReceiptDto = Schemas['MyReceiptDto'];
export type MyClaimDto = Schemas['MyClaimDto'];
export type CreateClaimDto = Schemas['CreateClaimDto'];
export type DepositMethod = Schemas['DepositMethod'];
export type MyPaymentAccountDto = Schemas['MyPaymentAccountDto'];

// Phase 3 slice 27: the Approvals tab (online only, R226).
export type ApprovalsDto = Schemas['ApprovalsDto'];
export type ClaimDto = Schemas['ClaimDto'];
export type HandoverDto = Schemas['HandoverDto'];

// Phase 4 slice 30: class tests and the marks grid (§3.8).
export type AssessmentDto = Schemas['AssessmentDto'];
export type AssessmentMarksDto = Schemas['AssessmentMarksDto'];
export type AssessmentMarkRowDto = Schemas['AssessmentMarkRowDto'];
export type CreateAssessmentDto = Schemas['CreateAssessmentDto'];
export type AssessmentSubmitMarksDto = Schemas['AssessmentSubmitMarksDto'];
export type MarkEntryDto = Schemas['MarkEntryDto'];
export type MarkEntryResultDto = Schemas['MarkEntryResultDto'];
export type ClassSubjectDto = Schemas['ClassSubjectDto'];
export type TestType = Schemas['TestType'];
