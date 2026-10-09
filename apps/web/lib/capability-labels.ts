import { CAPABILITY_GROUPS, Capability, type CapabilityGroup } from '@asms/shared';

// Plain-English names for the 53 capability keys (Phase 1 plan §7; Phase 5 added two), for the custom-role checklist and the
// permissions view. The dotted key is shown beside each label, so both read the same as the API.

const C = Capability;

export const CAPABILITY_LABELS: Record<Capability, string> = {
  [C.SCHOOL_SETTINGS_MANAGE]: 'Change school settings',
  [C.ACADEMIC_YEAR_MANAGE]: 'Manage academic years',
  [C.CLASS_MANAGE]: 'Manage classes',
  [C.SECTION_MANAGE]: 'Manage sections',
  [C.SUBJECT_MANAGE]: 'Manage subjects',
  [C.FEE_HEAD_MANAGE]: 'Manage fee heads',
  [C.HOLIDAY_MANAGE]: 'Manage holidays',
  [C.TRANSPORT_MANAGE]: 'Manage transport',
  [C.USER_ACCOUNT_MANAGE]: 'Manage user accounts',
  [C.ROLE_MANAGE]: 'Manage roles and permissions',
  [C.AUDIT_VIEW]: 'View the audit log',
  [C.STUDENT_VIEW]: 'View students',
  [C.STUDENT_CREATE]: 'Admit students',
  [C.STUDENT_UPDATE]: 'Edit student records',
  [C.STUDENT_STATUS_CHANGE]: 'Change student status',
  [C.ENROLMENT_MANAGE]: 'Manage enrolments',
  [C.GUARDIAN_MANAGE]: 'Manage guardians',
  [C.DOCUMENT_VIEW]: 'View documents',
  [C.DOCUMENT_UPLOAD]: 'Upload documents',
  [C.DOCUMENT_VERIFY]: 'Verify documents',
  [C.STAFF_VIEW]: 'View staff',
  [C.STAFF_CREATE]: 'Add staff',
  [C.STAFF_UPDATE]: 'Edit staff records',
  [C.STAFF_CONTRACT_MANAGE]: 'Manage staff contracts',
  [C.STAFF_STATUS_CHANGE]: 'Change staff status',
  [C.STAFF_LEAVE_APPROVE]: 'Approve staff leave',
  [C.PAYROLL_VIEW]: 'View payroll',
  [C.PAYROLL_RUN]: 'Run payroll',
  [C.ATTENDANCE_STUDENT_MARK]: 'Mark student attendance',
  [C.ATTENDANCE_STUDENT_VIEW_ALL]: 'View all student attendance',
  [C.ATTENDANCE_STAFF_MANAGE]: 'Manage staff attendance',
  [C.ASSESSMENT_DEFINE]: 'Define assessments',
  [C.MARKS_ENTER]: 'Enter marks',
  [C.MARKS_VIEW_ALL]: 'View all marks',
  [C.RESULT_APPROVE]: 'Approve results',
  [C.RESULT_PUBLISH]: 'Publish results',
  [C.DIARY_WRITE]: 'Write the diary',
  [C.REMARK_WRITE]: 'Write remarks',
  [C.TIMETABLE_MANAGE]: 'Manage the timetable',
  [C.CERTIFICATE_ISSUE]: 'Issue certificates',
  [C.CHARGE_CREATE]: 'Create charges',
  [C.CHARGE_CAMPAIGN_SEND]: 'Send charge campaigns',
  [C.CONCESSION_GRANT]: 'Grant concessions',
  [C.PAYMENT_RECORD]: 'Record payments',
  [C.PAYMENT_VERIFY]: 'Verify payments',
  [C.PAYMENT_VOID]: 'Void payments',
  [C.COLLECTION_HANDOVER_CONFIRM]: 'Confirm collection handovers',
  [C.EXPENSE_RECORD]: 'Record expenses',
  [C.EXPENSE_APPROVE]: 'Approve expenses',
  [C.FINANCE_REPORT_VIEW]: 'View finance reports',
  [C.FEE_STATEMENT_VIEW]: 'View fee statements',
  [C.ANNOUNCEMENT_SEND_SCOPE]: 'Send announcements to own classes',
  [C.ANNOUNCEMENT_SEND_SCHOOL]: 'Send school-wide announcements',
};

export const CAPABILITY_GROUP_LABELS: Record<CapabilityGroup, string> = {
  setup: 'Setup',
  access: 'Access',
  students: 'Students',
  guardians: 'Guardians',
  documents: 'Documents',
  staff: 'Staff',
  payroll: 'Payroll',
  attendance: 'Attendance',
  academics: 'Academics',
  finance: 'Finance',
  comms: 'Communication',
};

/**
 * The groups of §7 in display order, without `role.manage`: it is never in a custom role, a grant
 * or a revoke (R45, R75), so no picker offers it.
 */
export const GRANTABLE_GROUPS = (Object.keys(CAPABILITY_GROUPS) as CapabilityGroup[]).map((group) => ({
  group,
  label: CAPABILITY_GROUP_LABELS[group],
  capabilities: (CAPABILITY_GROUPS[group] as readonly Capability[]).filter((c) => c !== C.ROLE_MANAGE),
}));
