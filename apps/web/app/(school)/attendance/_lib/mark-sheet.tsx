'use client';

import { ErrorCode, type AttendanceStatus } from '@asms/shared';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { ApiError } from '@/lib/api/errors';
import { STATUS_KEYS, STATUS_LABELS } from './attendance-ui';

// The editing core shared by the student register and the staff day sheet (contracts/slice-11.md
// §4.2, slice-12.md §4.2): drafts over the saved marks, the changes they make, the reason asked
// for when a saved mark changes (ours, or the server's list after a race), and the row keyboard.

/** A saved mark as a sheet compares against it. Staff marks have no arrival time. */
export type SavedMark = { status: AttendanceStatus; note: string | null; arrivedAt?: string | null };
export type MarkDraft = { status: AttendanceStatus | null; arrivedAt: string; note: string };
/** One saved mark changing, as the reason dialog lists it. */
export type MarkChange = { id: string; name: string; from: AttendanceStatus | null; to: AttendanceStatus; noteChanged: boolean };

/** A row the user has changed: its draft, and the mark it was loaded with. */
type Touched = { name: string; saved: SavedMark | null; draft: MarkDraft };
/** A changed row, as a sheet sends it. */
export type ChangedRow = Touched & { id: string };

export const draftOf = (saved: SavedMark | null): MarkDraft => ({
  status: saved?.status ?? null,
  arrivedAt: saved?.arrivedAt ?? '',
  note: saved?.note ?? '',
});
/** The arrival time a draft would save: only a late mark carries one. */
export const arrivalOf = (d: MarkDraft) => (d.status === 'late' ? d.arrivedAt.trim() : '');

function isUnchanged(saved: SavedMark | null, d: MarkDraft): boolean {
  if (!saved) return d.status === null;
  return saved.status === d.status && (saved.note ?? '') === d.note.trim() && (saved.arrivedAt ?? '') === arrivalOf(d);
}

/** The server's AMENDMENT_REASON_REQUIRED list, keyed by `enrolmentId` or `staffId`. */
type ServerAmendment = { from: AttendanceStatus | null; to: AttendanceStatus; noteChanged: boolean } & Record<string, unknown>;

export function useMarkSheet<TResult>({
  idKey,
  rowCount,
  nameOf,
  submit,
  onSaved,
  onRefused,
  onRaceDropped,
}: {
  /** The id field of the server's amendment list. */
  idKey: 'enrolmentId' | 'staffId';
  /** Rows on screen, for the arrow keys. */
  rowCount: number;
  /** A row's name, for a server amendment on a row the user did not touch. */
  nameOf: (id: string) => string;
  /** Sends the changed rows (in the order first touched); `reason` when a saved mark changes. */
  submit: (changed: ChangedRow[], reason: string | undefined) => Promise<TResult>;
  onSaved: (result: TResult) => void;
  /** Any refusal but AMENDMENT_REASON_REQUIRED. */
  onRefused?: (error: unknown) => void;
  /** The user cancelled the server's list: theirs stands, so reload it. */
  onRaceDropped: () => void;
}) {
  const [touched, setTouched] = useState<Record<string, Touched>>({});
  // The reason dialog: the changes it lists, and whether they came back from the server (a race).
  const [confirm, setConfirm] = useState<{ changes: MarkChange[]; fromServer: boolean } | null>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const draftFor = (id: string, saved: SavedMark | null) => touched[id]?.draft ?? draftOf(saved);
  /** Changes one row; a row back to its saved mark is no longer a change. */
  const update = (id: string, name: string, saved: SavedMark | null, patch: Partial<MarkDraft>) =>
    setTouched((all) => {
      const draft = { ...(all[id]?.draft ?? draftOf(saved)), ...patch };
      if (isUnchanged(saved, draft)) {
        const rest = { ...all };
        delete rest[id];
        return rest;
      }
      return { ...all, [id]: { name, saved, draft } };
    });

  /** Every changed row, in the order first touched. */
  const changed: ChangedRow[] = Object.entries(touched).map(([id, t]) => ({ id, ...t }));
  const amendments: MarkChange[] = changed
    .filter((c) => c.saved)
    .map((c) => ({
      id: c.id,
      name: c.name,
      from: c.saved!.status,
      to: c.draft.status!,
      noteChanged: (c.saved!.note ?? '') !== c.draft.note.trim(),
    }));

  const mutation = useMutation({
    mutationFn: (reason: string | undefined) => submit(changed, reason),
    onSuccess: (result) => {
      setConfirm(null);
      onSaved(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.AMENDMENT_REASON_REQUIRED) {
        // Someone saved after this was loaded: their marks differ from ours.
        const listed = (error.details as { amendments?: ServerAmendment[] } | null)?.amendments ?? [];
        setConfirm({
          fromServer: true,
          changes: listed.map((a) => {
            const id = String(a[idKey]);
            return { id, name: touched[id]?.name ?? nameOf(id), from: a.from, to: a.to, noteChanged: a.noteChanged };
          }),
        });
        return;
      }
      setConfirm(null);
      onRefused?.(error);
    },
  });

  /** Saves, asking for a reason first when a saved mark changes. */
  const save = () => {
    mutation.reset();
    if (amendments.length > 0) setConfirm({ changes: amendments, fromServer: false });
    else mutation.mutate(undefined);
  };

  const focusRow = (index: number) => rowRefs.current[Math.max(0, Math.min(index, rowCount - 1))]?.focus();
  /** A focusable row: ↑ ↓ move; P, A, L, O (and V) mark it through `mark` and move on. */
  const rowProps = (index: number, mark: ((status: AttendanceStatus) => void) | null) => ({
    ref: (el: HTMLTableRowElement | null) => {
      rowRefs.current[index] = el;
    },
    tabIndex: 0,
    onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusRow(index + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      const status = STATUS_KEYS[event.key.toLowerCase()];
      if (status && mark) {
        event.preventDefault();
        mark(status);
        focusRow(index + 1);
      }
    },
  });

  // The refusal to show under the sheet: the reason dialog answers AMENDMENT_REASON_REQUIRED.
  const error =
    mutation.error && !(mutation.error instanceof ApiError && mutation.error.code === ErrorCode.AMENDMENT_REASON_REQUIRED)
      ? mutation.error
      : null;

  return {
    draftFor,
    update,
    changed,
    isChanged: (id: string) => id in touched,
    clear: () => setTouched({}),
    /** Forgets the last refusal. */
    reset: mutation.reset,
    save,
    pending: mutation.isPending,
    error,
    rowProps,
    dialog: {
      confirm,
      pending: mutation.isPending,
      onConfirm: (reason: string) => mutation.mutate(reason),
      onCancel: () => {
        if (confirm?.fromServer) onRaceDropped();
        setConfirm(null);
      },
    },
  };
}

/** The reason dialog of a sheet's save: the marks changing, and why. */
export function AmendmentsDialog({
  dialog,
  raceDescription,
  unmarked,
}: {
  dialog: ReturnType<typeof useMarkSheet>['dialog'];
  /** What the race means on this sheet ("Someone saved this register after you opened it…"). */
  raceDescription: string;
  /** How a row with no mark reads: "not marked", "not recorded". */
  unmarked: string;
}) {
  const { confirm } = dialog;
  return (
    <ConfirmWithReasonDialog
      open={confirm !== null}
      onOpenChange={(open) => !open && dialog.onCancel()}
      title={confirm?.fromServer ? 'Changed since you loaded' : 'Why are these marks changing?'}
      description={
        confirm?.fromServer ? raceDescription : 'A saved mark is corrected, never overwritten: the reason is kept with the change.'
      }
      confirmLabel="Save changes"
      minLength={3}
      pending={dialog.pending}
      onConfirm={dialog.onConfirm}
    >
      <ul className="grid gap-1 text-sm" data-testid="amendment-list">
        {confirm?.changes.map((c) => (
          <li key={c.id}>
            <span className="font-medium">{c.name}</span>: {c.from ? STATUS_LABELS[c.from] : unmarked} → {STATUS_LABELS[c.to]}
            {c.noteChanged && <span className="text-muted-foreground"> (note changed)</span>}
          </li>
        ))}
      </ul>
    </ConfirmWithReasonDialog>
  );
}
