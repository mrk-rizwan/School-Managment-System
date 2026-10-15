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
  // Phase 5 slice 40 (contracts/slice-40.md §3): the required documents at their default.
  requiredDocumentTypes: ['b_form', 'photo'] as SchoolSettingsDto['requiredDocumentTypes'],
  // Phase 5 slice 39 (rule 35): the contract-expiry warning at its default.
  contractWarningDays: 30,
  // Phase 5 slice 44: no late-after time and no device token yet.
  staffLateAfter: null,
  deviceTokenRotatedAt: null,
  // Phase 5 slice 42 (contracts/slice-42.md §1): the financial statement's basis at its default.
  financialStatementBasis: 'received',
} as const satisfies Partial<SchoolSettingsDto>;
