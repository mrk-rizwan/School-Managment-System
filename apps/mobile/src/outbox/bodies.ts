import { containsIdentityNumber, type AttendanceStatus, type RemarkCategory } from '@asms/shared';
import type { CreateDiaryEntryDto, CreateRemarkDto, SubmitRegisterDto } from '../api/contracts';
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

/** The photo lane's row: a pointer to the local file row; the sender builds the requests. */
export function buildAttachmentBody(localAttachmentId: string): { localAttachmentId: string } {
  return { localAttachmentId };
}
