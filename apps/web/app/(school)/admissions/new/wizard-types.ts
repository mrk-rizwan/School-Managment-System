import type { CreateGuardianBody } from '@/lib/api/school-guardians-contract';
import type { DocumentType, Gender } from '@/lib/api/school-students-contract';
import type { LinkFlags } from '../../students/_lib/link-flags';
import type { Placement } from '../../students/_lib/placement';

// The admission wizard's state. It lives in React state only — never localStorage or the URL —
// because it holds identity digits (plan §3.10).

/** Runs a request, re-authenticating in place on a 401 (see _lib/reauth.tsx). */
export type Guard = <T>(call: () => Promise<T>) => Promise<T>;

export type StudentDraft = {
  /** True once the B-Form lookup has run (or "no B-Form yet" was chosen). */
  checked: boolean;
  /** 13 digits, or null when the child has none yet. */
  bForm: string | null;
  fullName: string;
  gender: Gender | '';
  dateOfBirth: string;
  admittedOn: string;
  notes: string;
};

/** An existing guardian is kept by id only, never by their digits (plan §5 slice 6). */
export type GuardianEntry = LinkFlags & { key: string } & (
    | { kind: 'existing'; guardianId: string; fullName: string; hasPhone: boolean; family: string | null }
    | { kind: 'new'; guardian: CreateGuardianBody }
  );

export type DocumentEntry = {
  stagedUploadId: string;
  type: DocumentType;
  fileName: string;
  sizeBytes: number;
};

export type PlacementDraft = Placement & { rollNo: string };

export const guardianName = (entry: GuardianEntry) =>
  entry.kind === 'existing' ? entry.fullName : entry.guardian.fullName;
export const guardianHasPhone = (entry: GuardianEntry) =>
  entry.kind === 'existing' ? entry.hasPhone : Boolean(entry.guardian.phone);

/** R28–R30 and the relationship, as sentences; empty when the guardians step may be left. */
export function guardianProblems(entries: GuardianEntry[]): string[] {
  const problems: string[] = [];
  if (entries.length === 0) return ['Link or add at least one guardian.'];
  if (entries.some((e) => e.relationship === '')) problems.push('Choose each guardian’s relationship.');
  const primaries = entries.filter((e) => e.isPrimaryContact);
  if (primaries.length !== 1) problems.push('Choose one primary contact.');
  else if (!guardianHasPhone(primaries[0])) problems.push('The primary contact needs a phone number.');
  if (!entries.some((e) => e.isFeePayer)) problems.push('Mark at least one guardian as paying fees.');
  return problems;
}
