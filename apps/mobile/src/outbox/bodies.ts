import { containsIdentityNumber, type AttendanceStatus, type RemarkCategory } from '@asms/shared';
import type {
  AssessmentSubmitMarksDto,
  CounterPaymentMethod,
  CreateAssessmentDto,
  CreateClaimDto,
  CreateDiaryEntryDto,
  CreateExpenseDto,
  CreateRemarkDto,
  DepositMethod,
  RecordableExpenseCategory,
  SubmitRegisterDto,
  TestType,
} from '../api/contracts';
import { containsPhone } from '../platform/scrub';

// The only builders of outbox bodies (slice-16 §3.4, slice-15 §7.6): each copies exactly the
// contract's fields, by name, from its input — so a body carries ids, statuses and what the user
// typed, never a student's name, identity number or phone. What survives a 401 for a week is
// then no more than the typed text, keyed by ids that mean nothing off the server.

/** Typed text with an identity number or a phone in it: refused before it is saved. */
export class SensitiveTextError extends Error {
  constructor(readonly field: string) {
    super(`${field}: do not type an identity number or a phone number`);
    this.name = 'SensitiveTextError';
  }
}

/** The field error for typed text, or null when it may be saved (the server refuses the same). */
export function sensitiveTextError(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return containsIdentityNumber(text) || containsPhone(text)
    ? 'Do not type an identity number or a phone number here.'
    : null;
}

function checked(field: string, text: string | null | undefined): void {
  if (sensitiveTextError(text) !== null) throw new SensitiveTextError(field);
}

/** Empty or whitespace-only text is "not given": the key is left out. */
const given = (text: string | null | undefined): text is string =>
  typeof text === 'string' && text.trim() !== '';

export type RegisterMarkInput = {
  enrolmentId: string;
  status: AttendanceStatus;
  note?: string | null;
  arrivedAt?: string | null;
};

export function buildRegisterBody(input: {
  date: string;
  period: number;
  marks: readonly RegisterMarkInput[];
  reason?: string | null;
}): SubmitRegisterDto {
  checked('reason', input.reason);
  const marks = input.marks.map((mark) => {
    checked('note', mark.note);
    return {
      enrolmentId: mark.enrolmentId,
      status: mark.status,
      ...(given(mark.note) ? { note: mark.note.trim() } : {}),
      ...(mark.status === 'late' && given(mark.arrivedAt) ? { arrivedAt: mark.arrivedAt } : {}),
    };
  });
  return {
    date: input.date,
    period: input.period,
    marks,
    ...(given(input.reason) ? { reason: input.reason.trim() } : {}),
  };
}

export type DiaryInput = {
  date: string;
  subjectId: string;
  topic: string;
  assignment?: string | null;
  learningOutcome?: string | null;
  dueOn?: string | null;
};

/** Never a stagedUploadId: the photo travels in its own lane (slice-16 decision 1). */
export function buildDiaryBody(input: DiaryInput): CreateDiaryEntryDto {
  checked('topic', input.topic);
  checked('assignment', input.assignment);
  checked('learningOutcome', input.learningOutcome);
  return {
    date: input.date,
    subjectId: input.subjectId,
    topic: input.topic.trim(),
    ...(given(input.assignment) ? { assignment: input.assignment.trim() } : {}),
    ...(given(input.learningOutcome) ? { learningOutcome: input.learningOutcome.trim() } : {}),
    ...(given(input.dueOn) ? { dueOn: input.dueOn } : {}),
  };
}

export type RemarkInput = {
  date: string;
  category: RemarkCategory;
  text: string;
  /** null: the school's default (the field is left out, slice-16 decision 10). */
  visibility?: CreateRemarkDto['visibility'] | null;
  subjectId?: string | null;
};

export function buildRemarkBody(input: RemarkInput): CreateRemarkDto {
  checked('text', input.text);
  return {
    date: input.date,
    category: input.category,
    text: input.text.trim(),
    ...(input.visibility ? { visibility: input.visibility } : {}),
    ...(given(input.subjectId) ? { subjectId: input.subjectId } : {}),
  };
}

export type ExpenseInput = {
  category: RecordableExpenseCategory;
  /** Whole rupees. */
  amount: number;
  spentOn: string;
  description: string;
  payee?: string | null;
  method: CounterPaymentMethod;
  reference?: string | null;
};

/** Never a stagedUploadId: the receipt travels in its own lane (expense_receipt, §3.9). */
export function buildExpenseBody(input: ExpenseInput): CreateExpenseDto {
  checked('description', input.description);
  checked('payee', input.payee);
  checked('reference', input.reference);
  return {
    category: input.category,
    amount: input.amount,
    spentOn: input.spentOn,
    description: input.description.trim(),
    ...(given(input.payee) ? { payee: input.payee.trim() } : {}),
    method: input.method,
    ...(given(input.reference) ? { reference: input.reference.trim() } : {}),
  };
}

export type ClaimInput = {
  method: DepositMethod;
  /** Whole rupees. */
  claimedAmount: number;
  paidOn: string;
  reference?: string | null;
  note?: string | null;
};

/** Never a stagedUploadId: the slip travels in its own lane (payment_claim_image, §3.9). */
export function buildClaimBody(input: ClaimInput): CreateClaimDto {
  checked('reference', input.reference);
  checked('note', input.note);
  return {
    method: input.method,
    claimedAmount: input.claimedAmount,
    paidOn: input.paidOn,
    ...(given(input.reference) ? { reference: input.reference.trim() } : {}),
    ...(given(input.note) ? { note: input.note.trim() } : {}),
  };
}

/**
 * A staged_upload_patch lane's row (the diary photo, an expense's receipt): a pointer to the
 * local file row in the lane's domainTable; the sender builds the requests.
 */
export function buildAttachmentBody(localAttachmentId: string): { localAttachmentId: string } {
  return { localAttachmentId };
}

// --- Phase 4 slice 30 (§3.8): a class test and the marks grid --------------------------------

export type AssessmentInput = {
  classSubjectId: string;
  sectionId: string;
  testType: TestType;
  name: string;
  maxMarks: number;
  heldOn: string;
};

export function buildAssessmentBody(input: AssessmentInput): CreateAssessmentDto {
  checked('name', input.name);
  return {
    classSubjectId: input.classSubjectId,
    sectionId: input.sectionId,
    testType: input.testType,
    name: input.name.trim().replace(/\s+/g, ' '),
    maxMarks: input.maxMarks,
    heldOn: input.heldOn,
  };
}

/** One row of the grid as sent: a mark or an absence, its own key, the live mark it was based on. */
export type MarkEntryInput = {
  enrolmentId: string;
  obtained: number | null;
  absent: boolean;
  clientEntryKey: string;
  basedOnMarkId: string | null;
};

export function buildMarksBody(entries: readonly MarkEntryInput[]): AssessmentSubmitMarksDto {
  return {
    entries: entries.map((entry) => ({
      enrolmentId: entry.enrolmentId,
      ...(entry.absent ? { absent: true } : { obtained: entry.obtained }),
      clientEntryKey: entry.clientEntryKey,
      basedOnMarkId: entry.basedOnMarkId,
    })),
  };
}
