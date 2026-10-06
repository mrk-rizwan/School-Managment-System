import { ErrorCode } from '@asms/shared';

// The lane table (slice-15 §7.3, slice-16 §9, R158): the single place that says which writes may
// wait on the device. Lanes are independent; within a lane one request is in flight, oldest
// first. No second queue: slice 16 adds four rows here.
//
// Online-only actions (R162) never enter the outbox: they are called directly and disabled
// offline with "Needs a connection". ONLINE_ONLY_ACTIONS names them so a test can prove none of
// them is a lane.

/**
 * What a screen offers on a terminal failure, by the response's code:
 *   add_reason    — a register amendment needs a reason: a new pending row carries it
 *   reload        — refetch the roster, merge the local marks over it, a new pending row
 *   open_existing — the diary entry exists on the server: open it (and re-target the photo)
 *   edit_resend   — open the form pre-filled; saving makes a new row with a new key
 *   retry         — a new pending row with the same body
 *   discard       — shown with the server's message; the only way on is to discard
 */
export type Remedy =
  'add_reason' | 'reload' | 'open_existing' | 'edit_resend' | 'retry' | 'discard';

export type Lane = {
  method: 'POST' | 'PATCH';
  /** The endpoint template; the stored item carries the filled path. */
  path: string;
  /** True when the request carries `Idempotency-Key: <outbox id>` (slice-6 §4). */
  idempotencyHeader: boolean;
  /** Fixed headers every send of the lane carries. */
  headers?: Readonly<Record<string, string>>;
  /** True when writes to one natural key coalesce into one pending row (registers). */
  coalesces: boolean;
  /**
   * How the item is sent: the stored JSON body, or a file's upload-then-PATCH
   * (`staged_upload_patch`, staged-upload-sender.ts): the file row lives in `domainTable`.
   */
  sender: 'json' | 'staged_upload_patch';
  /** The local table written in the item's transaction (slice-16 §8); null when none. */
  domainTable: string | null;
  /** What the sync sheet calls the lane. */
  label: string;
  /** The remedy per response code; a code not listed is shown and discarded. */
  remedies: Readonly<Partial<Record<string, Remedy>>>;
};

export const LANES = {
  device_register: {
    method: 'POST',
    path: '/api/v1/me/devices',
    // Idempotent on the server: the same token answers 200 (slice-9 §3.5).
    idempotencyHeader: false,
    coalesces: false,
    sender: 'json',
    domainTable: null,
    label: 'Notification registration',
    // Silently superseded by the next token.
    remedies: {},
  },
  submit_register: {
    method: 'POST',
    path: '/api/v1/sections/:id/submit-register',
    idempotencyHeader: false,
    // R160: each mark answered as { id, enrolmentId, outcome }; the view is rebuilt from what
    // was sent (runtime.ts). Without Preference-Applied the full answer is read instead.
    headers: { Prefer: 'return=minimal' },
    coalesces: true,
    sender: 'json',
    domainTable: 'local_registers',
    label: 'Register',
    remedies: {
      [ErrorCode.AMENDMENT_REASON_REQUIRED]: 'add_reason',
      [ErrorCode.ROSTER_INCOMPLETE]: 'reload',
    },
  },
  diary_entry: {
    method: 'POST',
    path: '/api/v1/sections/:id/diary-entries',
    idempotencyHeader: true,
    coalesces: false,
    sender: 'json',
    domainTable: 'local_diary_entries',
    label: 'Diary entry',
    remedies: {
      [ErrorCode.DIARY_ENTRY_EXISTS]: 'open_existing',
      [ErrorCode.SUBJECT_NOT_ASSIGNED]: 'edit_resend',
      [ErrorCode.SUBJECT_ARCHIVED]: 'edit_resend',
      [ErrorCode.SECTION_ARCHIVED]: 'edit_resend',
      [ErrorCode.CLASS_ARCHIVED]: 'edit_resend',
      [ErrorCode.ACADEMIC_YEAR_CLOSED]: 'edit_resend',
      [ErrorCode.PERMISSION_DENIED]: 'edit_resend',
      [ErrorCode.NOT_FOUND]: 'edit_resend',
      [ErrorCode.VALIDATION_FAILED]: 'edit_resend',
      [ErrorCode.INVALID_VALUE]: 'edit_resend',
      [ErrorCode.REFERENCE_NOT_FOUND]: 'edit_resend',
    },
  },
  remark: {
    method: 'POST',
    path: '/api/v1/students/:id/remarks',
    idempotencyHeader: true,
    coalesces: false,
    sender: 'json',
    domainTable: 'local_remarks',
    label: 'Remark',
    remedies: {
      [ErrorCode.SUBJECT_ARCHIVED]: 'edit_resend',
      [ErrorCode.VALIDATION_FAILED]: 'edit_resend',
      [ErrorCode.INVALID_VALUE]: 'edit_resend',
      [ErrorCode.REFERENCE_NOT_FOUND]: 'edit_resend',
    },
  },
  diary_attachment: {
    method: 'PATCH',
    path: '/api/v1/diary-entries/:id',
    // Retry-safe by state (slice-13 §3): the same staged upload attached twice is one attachment.
    idempotencyHeader: false,
    coalesces: false,
    sender: 'staged_upload_patch',
    domainTable: 'local_attachments',
    label: 'Diary photo',
    remedies: { [ErrorCode.REFERENCE_NOT_FOUND]: 'retry' },
  },
  // Phase 3 slice 23 (§3.9, R207): an expense captured offline, then its receipt.
  expense: {
    method: 'POST',
    path: '/api/v1/expenses',
    idempotencyHeader: true,
    coalesces: false,
    sender: 'json',
    domainTable: 'local_expenses',
    label: 'Expense',
    remedies: {
      [ErrorCode.VALIDATION_FAILED]: 'edit_resend',
      [ErrorCode.INVALID_VALUE]: 'edit_resend',
    },
  },
  expense_receipt: {
    method: 'PATCH',
    path: '/api/v1/expenses/:id/receipt',
    // Retry-safe by state: the same staged upload sent again answers 200; another one is
    // EXPENSE_RECEIPT_EXISTS, shown and discarded.
    idempotencyHeader: false,
    coalesces: false,
    sender: 'staged_upload_patch',
    domainTable: 'local_files',
    label: 'Expense receipt',
    remedies: { [ErrorCode.REFERENCE_NOT_FOUND]: 'retry' },
  },
} as const satisfies Record<string, Lane>;

export type LaneId = keyof typeof LANES;

export function laneOf(id: string): Lane | null {
  return (LANES as Record<string, Lane>)[id] ?? null;
}

/** The remedy a failed item of `lane` is offered for `code`. */
export function remedyFor(lane: string, code: string | null): Remedy {
  return (code === null ? undefined : laneOf(lane)?.remedies[code]) ?? 'discard';
}

/** At most three lanes send at once. */
export const MAX_CONCURRENT_LANES = 3;

/** R162: these are called directly and fail closed offline. None may ever be a lane. */
export const ONLINE_ONLY_ACTIONS = [
  'change_password',
  'revoke_other_sessions',
  'sign_out',
  'arrivals',
  'amend_after_window',
  'amend_mark',
  'assign_cover',
  'create_announcement',
  'preview_audience',
  'send_announcement',
  // Phase 3 (§3.9, R226): money writes are online-only, except a deposit claim and an expense.
  'record_payment',
  'verify_claim',
  'reject_claim',
  'withdraw_claim',
  'confirm_handover',
  'approve_expense',
  'reject_expense',
  'void_expense',
  'request_leave',
  'cancel_leave',
  'approve_leave',
  'reject_leave',
] as const;

export type OnlineOnlyAction = (typeof ONLINE_ONLY_ACTIONS)[number];
