import type { SchoolSettingsDto } from '../../lib/api/school-messaging-contract';

/**
 * The Phase 3 school-settings fields (slice 18) at their defaults, spread into every mocked
 * SchoolSettingsDto so a spec written before them still matches the generated type.
 */
export const FINANCE_SETTINGS = {
  feeCutoffDay: 15,
  lateFeeEnabled: false,
  lateFeeAmount: null,
  lateFeeGraceDays: 7,
  lateFeeEnabledAt: null,
  expenseApprovalThreshold: 5000,
  payDay: 1,
  feeReminderDaysBefore: 3,
  overdueReminderEveryDays: 14,
  // Phase 4 slice 34 (contracts/slice-34.md §6): the certificate settings at their defaults.
  certificateSignatoryName: null,
  certificateShowIdentityNo: true,
} as const satisfies Partial<SchoolSettingsDto>;
