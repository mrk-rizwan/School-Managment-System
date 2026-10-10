// The NotificationService's input types (contracts/slice-9.md §7.1). TemplateVars<T> is the
// per-type variable shape: a type whose template is not written yet maps to `never`, so a sender
// for it does not compile until its slice adds the template (plan rule 0.12). Vars never carry a
// phone number, an identity number or a token (R111); the school's name is supplied by the
// service from `schools.name`, never by the sender.
import type { DayStatus, ExpenseCategory, MessageSubjectType, MessageType, RemarkCategory } from '@asms/shared';

/** One person a message is addressed to. Exactly one key. */
export type Recipient =
  | { readonly guardianId: bigint }
  | { readonly staffId: bigint }
  | { readonly studentId: bigint };

/** Dates are calendar dates (`@db.Date` values, UTC midnight); times are instants. */
export interface TemplateVarsMap {
  /** contracts/slice-11.md §6.5 (R126): the child's day; subject `attendance_alert`. */
  absence_alert: {
    readonly studentName: string;
    readonly className: string;
    readonly sectionName: string;
    readonly date: Date;
  };
  late_advice: {
    readonly studentName: string;
    readonly className: string;
    readonly sectionName: string;
    readonly date: Date;
    /** `HH:MM`, or null when the arrival time is unknown. */
    readonly arrivedAt: string | null;
  };
  /** States the day as it is when sent. */
  attendance_corrected: {
    readonly studentName: string;
    readonly className: string;
    readonly sectionName: string;
    readonly date: Date;
    readonly status: DayStatus;
    readonly arrivedAt: string | null;
  };
  /** contracts/slice-14.md §4.4: the sender passes `{}` and the composed `body`. */
  announcement_urgent: Record<string, never>;
  announcement_normal: Record<string, never>;
  /** Notice (subject `holiday`) or cancellation (subject `holiday_cancellation`), slice 10 §4.7. */
  holiday_notice: {
    readonly name: string;
    readonly startsOn: Date;
    readonly endsOn: Date;
    /** Notice only; omitted or null when there is no next teaching day. */
    readonly reopensOn?: Date | null;
  };
  /** contracts/slice-13.md §4.6 (R138). `topic` already refuses identity and phone patterns. */
  diary_posted: {
    readonly className: string;
    readonly sectionName: string;
    readonly subjectName: string;
    readonly date: Date;
    readonly topic: string;
    readonly dueOn: Date | null;
  };
  /** contracts/slice-13.md §5.4 (R140). Never the remark text. */
  remark_posted: {
    readonly studentName: string;
    readonly category: RemarkCategory;
    readonly date: Date;
  };
  /** contracts/slice-11.md §8.4 (R129): push and email to the register watchers only. */
  register_unrecorded: {
    readonly date: Date;
    /** `HH:MM`. */
    readonly deadlineTime: string;
    readonly sections: readonly {
      readonly className: string;
      readonly sectionName: string;
      readonly coverStaffName: string | null;
    }[];
    /**
     * Phase 5 R305 (contracts/slice-37.md §3.1): a timetabled section's periods without a
     * register; teacherName null = "no assigned teacher". Absent on rows written before slice 37.
     */
    readonly periods?: readonly {
      readonly className: string;
      readonly sectionName: string;
      readonly period: number;
      readonly subjectName: string;
      readonly teacherName: string | null;
    }[];
  };
  sms_cap_reached: { readonly cap: number; readonly nextMonthStart: Date };
  messaging_test: { readonly senderName: string; readonly time: Date };
  /** Not sent through send(): no `messages` row (§7.2). */
  whatsapp_session_down: never;
  /** slice-10.md §6 step 8 (R132). */
  cover_assigned: {
    readonly className: string;
    readonly sectionName: string;
    readonly startsOn: Date;
    readonly endsOn: Date;
  };
  // Phase 3 (phase-3-financial.md §3.6): each type's variables are declared by the slice that
  // writes its template and sends it; until then nothing can send one (its renderer throws).
  /**
   * Slice 19 (contracts/slice-19.md §6): the family's new charges of one run, to each fee-payer
   * guardian with a positive total. WhatsApp keeps the amount; the push body is the title only
   * (R238, the processor's TITLE_ONLY_PUSH).
   */
  fee_charged: {
    /** `October 2026 fees`, or a campaign's name. */
    readonly label: string;
    readonly total: number;
    /** The children's first names or full names, in the family's order. */
    readonly children: readonly string[];
    readonly dueOn: Date;
  };
  /**
   * Slice 22 (R201): once per fee-paying guardian per due month, naming every owing child and the
   * family's total outstanding. WhatsApp and SMS keep the amount; the push body is the title only
   * (R238, TITLE_ONLY_PUSH).
   */
  fee_due_reminder: {
    readonly total: number;
    readonly children: readonly string[];
    readonly dueOn: Date;
  };
  /** Slice 22 (R202): the overdue amount, the children owing it and the oldest due date. */
  fee_overdue: {
    readonly overdue: number;
    readonly children: readonly string[];
    readonly since: Date;
  };
  /**
   * Slice 20 (contracts/slice-20.md §6): to the paid children's fee-payer guardians. WhatsApp and
   * SMS keep the amounts; the push body is the title only (R238, TITLE_ONLY_PUSH). Never a link.
   */
  receipt_issued: {
    /** `<n>/<year name>`. */
    readonly receiptLabel: string;
    readonly amount: number;
    readonly children: readonly string[];
    readonly yearName: string;
    /** What the named children still owe in the year after this payment. */
    readonly balance: number;
  };
  /**
   * Slice 21 (contracts/slice-21.md §5): to the submitting guardian. WhatsApp and SMS keep the
   * amount and the office's reason (validated free of identity and phone numbers); the push body
   * is the title only (R238, TITLE_ONLY_PUSH).
   */
  payment_claim_rejected: {
    readonly studentName: string;
    readonly amount: number;
    readonly paidOn: Date;
    readonly reason: string;
  };
  /** Slice 21: push and email to the payment.verify holders, once, when the slip lands; no amount. */
  payment_claim_submitted: { readonly studentName: string };
  /** Slice 20: push and email to the principals; no amount (read on the handovers page). */
  handover_shortfall: { readonly collectorName: string };
  /**
   * Slice 22 (R250): to the principals, once per run, when the SMS allowance ran out part-way
   * through the reminders; how many families went by WhatsApp or the app instead. No amount.
   */
  reminder_sms_capped: { readonly families: number };
  /** Slice 19: to the principals, push and email only; no amount (R238), read on the queue. */
  concession_requested: { readonly studentName: string; readonly requesterName: string };
  /** Slice 19: to the requester; the decision only. */
  concession_decided: {
    readonly studentName: string;
    readonly decision: 'approved' | 'rejected' | 'ended';
  };
  /** Slice 23 (§3.6): push and email to approvers; no amount (R238). */
  expense_approval_requested: {
    readonly expenseNo: number;
    readonly category: ExpenseCategory;
    readonly recorderName: string;
  };
  /** Slice 23: to the recorder; no amount, no reason (read in the app). */
  expense_decided: { readonly expenseNo: number; readonly decision: 'approved' | 'rejected' };
  /** Slice 24 (contracts/slice-24.md §5): to the approvers, push and email only. */
  leave_requested: {
    readonly staffName: string;
    readonly typeName: string;
    readonly startsOn: Date;
    readonly endsOn: Date;
    readonly workingDays: number;
  };
  /** Slice 24: to the staff member. */
  leave_decided: {
    readonly typeName: string;
    readonly startsOn: Date;
    readonly endsOn: Date;
    readonly decision: 'approved' | 'rejected';
  };
  /**
   * Slice 25 (contracts/slice-25.md §7): to each staff member of a finalised run, push and email;
   * no amount (R238), read in the app.
   */
  payslip_ready: { readonly yearMonth: string };
  /**
   * Slice 26 (contracts/slice-26.md §5): the platform's invoice to the school, to its principals,
   * push and email only; no amount (R238), read on the settings page.
   */
  platform_invoice_issued: { readonly invoiceNo: string; readonly yearMonth: string; readonly dueOn: Date };
  /** Slice 26: at overdue_at, and once more (`suspensionEligible`) at eligibility. */
  platform_invoice_overdue: {
    readonly invoiceNo: string;
    readonly yearMonth: string;
    readonly dueOn: Date;
    readonly suspensionEligible: boolean;
  };
  billing_tier_missing: Record<string, never>;
  /**
   * Phase 4 (phase-4-academic.md §3.5): name, term, percentage and grade only, never the marks
   * table, the position or the remark. SMS-allowed, so one segment; the push body is the title
   * only (TITLE_ONLY_PUSH). `percentBp` and `grade` are null when nothing was assessed.
   */
  result_published: {
    readonly studentName: string;
    /** The term's name, or `Final` for the final result. */
    readonly termName: string;
    readonly percentBp: number | null;
    readonly grade: string | null;
  };
  /** A corrected result (slice 32): the same figures, revised. */
  result_revised: {
    readonly studentName: string;
    readonly termName: string;
    readonly percentBp: number | null;
    readonly grade: string | null;
  };
  /** Slice 30, only with notify_class_tests on: in-app and a title-only push; never the mark. */
  test_marked: { readonly studentName: string; readonly testName: string };
  // Phase 5 (phase-5-extended.md §3.4): staff only, push (title only) and email, never SMS. The
  // senders are slices 39 (contracts), 44 (disputes) and 45 (support sessions).
  /** Slice 39 (R319): to every principal, at 30 and again at 7 days before the contract ends. */
  contract_expiring: {
    readonly staffName: string;
    /** The contract's last day (a `date` value). */
    readonly endsOn: Date;
    readonly daysLeft: number;
  };
  /**
   * Slice 45 (R349): to every principal when a platform admin opens read-only support access.
   * `reason` is the platform's stated reason (CHECKed free of identity numbers); never a ticket
   * system's link.
   */
  support_session_opened: {
    readonly supportName: string;
    readonly reason: string;
    readonly expiresAt: Date;
  };
  /** Slice 45: when the session ends, however it ends. */
  support_session_closed: {
    readonly supportName: string;
    readonly how: 'expired' | 'closed' | 'revoked';
  };
  /** Slice 44 (R347): to the attendance.staff.manage holders other than the staff member. */
  attendance_disputed: { readonly staffName: string; readonly date: Date };
  /** Slice 44: to the staff member who raised it. */
  attendance_dispute_decided: { readonly date: Date; readonly decision: 'approved' | 'rejected' };
}

export type TemplateVars<T extends MessageType> = TemplateVarsMap[T];

export interface SendInput<T extends MessageType> {
  readonly type: T;
  readonly subject: { readonly type: MessageSubjectType; readonly id: bigint };
  readonly recipients: readonly Recipient[];
  readonly vars: TemplateVars<T>;
  /** Announcement types only (slice 14). */
  readonly body?: string;
  /** Announcement types only (slice 14). */
  readonly media?: { readonly objectKey: string; readonly mime: string };
  /**
   * Subject `announcement` only (contracts/slice-14.md §4.4): stored on messages.title, the push
   * title and email subject.
   */
  readonly title?: string;
  /**
   * Subject `announcement` only (§4.3 step 3, §4.4): among recipients sharing one phone, one keeps
   * the phone legs and the others lose those legs (notification.service.ts dedupePhones).
   */
  readonly dedupePhones?: boolean;
}

export interface SendResult {
  readonly created: number;
  readonly existing: number;
  /** Recipients whose phone legs `dedupePhones` removed (0 without it). */
  readonly dedupedByPhone: number;
  /** The rows this call inserted, with their person (a retried sender gets none of its old rows). */
  readonly messages: readonly { readonly id: bigint; readonly person: Recipient }[];
}
