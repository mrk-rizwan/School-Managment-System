/**
 * The capability registry (phase-1-foundation.md §7): 51 keys, fixed for Phase 1. Later phases add
 * screens, not keys. Values are the dotted keys stored in custom_role_capabilities and
 * user_capability_grants; a value never changes once shipped.
 */
import { containsIdentityNumber } from './identity';
export const Capability = {
  // Setup (7)
  SCHOOL_SETTINGS_MANAGE: 'school.settings.manage',
  ACADEMIC_YEAR_MANAGE: 'academic_year.manage',
  CLASS_MANAGE: 'class.manage',
  SECTION_MANAGE: 'section.manage',
  SUBJECT_MANAGE: 'subject.manage',
  FEE_HEAD_MANAGE: 'fee_head.manage',
  HOLIDAY_MANAGE: 'holiday.manage',
  // Access (2)
  USER_ACCOUNT_MANAGE: 'user.account.manage',
  ROLE_MANAGE: 'role.manage',
  // Students (5)
  STUDENT_VIEW: 'student.view',
  STUDENT_CREATE: 'student.create',
  STUDENT_UPDATE: 'student.update',
  STUDENT_STATUS_CHANGE: 'student.status.change',
  ENROLMENT_MANAGE: 'enrolment.manage',
  // Guardians (1)
  GUARDIAN_MANAGE: 'guardian.manage',
  // Documents (3)
  DOCUMENT_VIEW: 'document.view',
  DOCUMENT_UPLOAD: 'document.upload',
  DOCUMENT_VERIFY: 'document.verify',
  // Staff (6)
  STAFF_VIEW: 'staff.view',
  STAFF_CREATE: 'staff.create',
  STAFF_UPDATE: 'staff.update',
  STAFF_CONTRACT_MANAGE: 'staff.contract.manage',
  STAFF_STATUS_CHANGE: 'staff.status.change',
  STAFF_LEAVE_APPROVE: 'staff.leave.approve',
  // Payroll (2)
  PAYROLL_VIEW: 'payroll.view',
  PAYROLL_RUN: 'payroll.run',
  // Attendance (3)
  ATTENDANCE_STUDENT_MARK: 'attendance.student.mark',
  ATTENDANCE_STUDENT_VIEW_ALL: 'attendance.student.view_all',
  ATTENDANCE_STAFF_MANAGE: 'attendance.staff.manage',
  // Academics (9)
  ASSESSMENT_DEFINE: 'assessment.define',
  MARKS_ENTER: 'marks.enter',
  MARKS_VIEW_ALL: 'marks.view_all',
  RESULT_APPROVE: 'result.approve',
  RESULT_PUBLISH: 'result.publish',
  DIARY_WRITE: 'diary.write',
  REMARK_WRITE: 'remark.write',
  TIMETABLE_MANAGE: 'timetable.manage',
  CERTIFICATE_ISSUE: 'certificate.issue',
  // Finance (11)
  CHARGE_CREATE: 'charge.create',
  CHARGE_CAMPAIGN_SEND: 'charge.campaign.send',
  CONCESSION_GRANT: 'concession.grant',
  PAYMENT_RECORD: 'payment.record',
  PAYMENT_VERIFY: 'payment.verify',
  PAYMENT_VOID: 'payment.void',
  COLLECTION_HANDOVER_CONFIRM: 'collection.handover.confirm',
  EXPENSE_RECORD: 'expense.record',
  EXPENSE_APPROVE: 'expense.approve',
  FINANCE_REPORT_VIEW: 'finance.report.view',
  FEE_STATEMENT_VIEW: 'fee.statement.view',
  // Comms (2)
  ANNOUNCEMENT_SEND_SCOPE: 'announcement.send.scope',
  ANNOUNCEMENT_SEND_SCHOOL: 'announcement.send.school',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

const C = Capability;

/** The groups of §7, in display order (the custom-role checklist and the permissions screen). */
export const CAPABILITY_GROUPS = {
  setup: [
    C.SCHOOL_SETTINGS_MANAGE,
    C.ACADEMIC_YEAR_MANAGE,
    C.CLASS_MANAGE,
    C.SECTION_MANAGE,
    C.SUBJECT_MANAGE,
    C.FEE_HEAD_MANAGE,
    C.HOLIDAY_MANAGE,
  ],
  access: [C.USER_ACCOUNT_MANAGE, C.ROLE_MANAGE],
  students: [
    C.STUDENT_VIEW,
    C.STUDENT_CREATE,
    C.STUDENT_UPDATE,
    C.STUDENT_STATUS_CHANGE,
    C.ENROLMENT_MANAGE,
  ],
  guardians: [C.GUARDIAN_MANAGE],
  documents: [C.DOCUMENT_VIEW, C.DOCUMENT_UPLOAD, C.DOCUMENT_VERIFY],
  staff: [
    C.STAFF_VIEW,
    C.STAFF_CREATE,
    C.STAFF_UPDATE,
    C.STAFF_CONTRACT_MANAGE,
    C.STAFF_STATUS_CHANGE,
    C.STAFF_LEAVE_APPROVE,
  ],
  payroll: [C.PAYROLL_VIEW, C.PAYROLL_RUN],
  attendance: [C.ATTENDANCE_STUDENT_MARK, C.ATTENDANCE_STUDENT_VIEW_ALL, C.ATTENDANCE_STAFF_MANAGE],
  academics: [
    C.ASSESSMENT_DEFINE,
    C.MARKS_ENTER,
    C.MARKS_VIEW_ALL,
    C.RESULT_APPROVE,
    C.RESULT_PUBLISH,
    C.DIARY_WRITE,
    C.REMARK_WRITE,
    C.TIMETABLE_MANAGE,
    C.CERTIFICATE_ISSUE,
  ],
  finance: [
    C.CHARGE_CREATE,
    C.CHARGE_CAMPAIGN_SEND,
    C.CONCESSION_GRANT,
    C.PAYMENT_RECORD,
    C.PAYMENT_VERIFY,
    C.PAYMENT_VOID,
    C.COLLECTION_HANDOVER_CONFIRM,
    C.EXPENSE_RECORD,
    C.EXPENSE_APPROVE,
    C.FINANCE_REPORT_VIEW,
    C.FEE_STATEMENT_VIEW,
  ],
  comms: [C.ANNOUNCEMENT_SEND_SCOPE, C.ANNOUNCEMENT_SEND_SCHOOL],
} as const satisfies Record<string, readonly Capability[]>;

export type CapabilityGroup = keyof typeof CAPABILITY_GROUPS;

/**
 * The staff system roles stored in user_roles.system_role. Parent and student are not rows: they
 * derive from users.guardian_id / users.student_id and hold no capabilities in Phase 1.
 */
export const SYSTEM_ROLES = ['principal', 'office_staff', 'teacher'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/**
 * Role defaults: the §7 table, plus attendance.student.mark for office staff (Phase 2 §1.2). Teacher defaults are scoped by the teacher's assignments
 * active today (plan §3.4, R53, R54); that scope is computed by the permission service from
 * assignment data and is deliberately not encoded here. Principal and office-staff defaults are
 * school-wide.
 */
export const SYSTEM_ROLE_DEFAULTS: Readonly<Record<SystemRole, readonly Capability[]>> = {
  // Every key, role.manage included.
  principal: Object.values(Capability),
  office_staff: [
    C.USER_ACCOUNT_MANAGE,
    C.STUDENT_VIEW,
    C.STUDENT_CREATE,
    C.STUDENT_UPDATE,
    C.STUDENT_STATUS_CHANGE,
    C.ENROLMENT_MANAGE,
    C.GUARDIAN_MANAGE,
    C.DOCUMENT_VIEW,
    C.DOCUMENT_UPLOAD,
    C.STAFF_VIEW,
    // Phase 2 §1.2 (owner, 2026-10-03): the office records a child's arrival at the gate. Held
    // through this role it has `all` scope; a principal may revoke it per clerk.
    C.ATTENDANCE_STUDENT_MARK,
    C.ATTENDANCE_STUDENT_VIEW_ALL,
    C.CERTIFICATE_ISSUE,
    C.CHARGE_CREATE,
    C.PAYMENT_RECORD,
    C.FEE_STATEMENT_VIEW,
    C.EXPENSE_RECORD,
    C.ANNOUNCEMENT_SEND_SCOPE,
  ],
  // Own classes only: scope comes from teacher_assignments, never from this list.
  teacher: [
    C.STUDENT_VIEW,
    C.ATTENDANCE_STUDENT_MARK,
    C.MARKS_ENTER,
    C.DIARY_WRITE,
    C.REMARK_WRITE,
    C.ANNOUNCEMENT_SEND_SCOPE,
  ],
};

/** Never in a grant row, a revoke row or a custom role (R45, R75; also a database CHECK). */
export const NEVER_GRANTABLE: readonly Capability[] = [C.ROLE_MANAGE];

/** Per-user rows (contracts/slice-7.md §2): a grant adds a key, a revoke removes a role default. */
export const GRANT_EFFECTS = ['grant', 'revoke'] as const;
export type GrantEffect = (typeof GRANT_EFFECTS)[number];

export const CUSTOM_ROLE_STATUSES = ['active', 'archived'] as const;
export type CustomRoleStatus = (typeof CUSTOM_ROLE_STATUSES)[number];

/**
 * A custom role's key (contracts/slice-7.md §3.3): 2-32 lower-case letters, digits or
 * underscores, starting with a letter; also `CHECK custom_roles_key_check`. The API refuses, and
 * the web should refuse, a key that is a fixed role's name or that carries 13 consecutive digits
 * (an identity number never reaches the audit log): see customRoleKeyProblem.
 */
export const CUSTOM_ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

/** The fixed roles' names, which no custom role key may reuse. */
export const RESERVED_CUSTOM_ROLE_KEYS: readonly string[] = [...SYSTEM_ROLES, 'parent', 'student'];

/** Why `key` is not an acceptable custom-role key, or null when it is. One rule for API and web. */
export function customRoleKeyProblem(key: string): 'format' | 'reserved' | 'identity_number' | null {
  if (!CUSTOM_ROLE_KEY_PATTERN.test(key)) return 'format';
  if (RESERVED_CUSTOM_ROLE_KEYS.includes(key)) return 'reserved';
  if (containsIdentityNumber(key)) return 'identity_number';
  return null;
}

/** Where an effective capability comes from (the permissions view, contracts/slice-7.md §2). */
export const CAPABILITY_SOURCE_KINDS = ['system_role', 'custom_role', 'grant'] as const;
export type CapabilitySourceKind = (typeof CAPABILITY_SOURCE_KINDS)[number];

/** `assigned_sections`: held only through the teacher default, scoped by assignments (R79). */
export const CAPABILITY_SCOPES = ['all', 'assigned_sections'] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

/** The group names of CAPABILITY_GROUPS, in display order. */
export const CAPABILITY_GROUP_NAMES = Object.keys(CAPABILITY_GROUPS) as CapabilityGroup[];

const GROUP_OF: ReadonlyMap<Capability, CapabilityGroup> = new Map(
  CAPABILITY_GROUP_NAMES.flatMap((group) =>
    CAPABILITY_GROUPS[group].map((key): [Capability, CapabilityGroup] => [key, group]),
  ),
);

/** The group a capability is listed under (every registry key has exactly one). */
export function capabilityGroupOf(capability: Capability): CapabilityGroup {
  const group = GROUP_OF.get(capability);
  if (group === undefined) throw new Error(`capability ${capability} has no group`);
  return group;
}
