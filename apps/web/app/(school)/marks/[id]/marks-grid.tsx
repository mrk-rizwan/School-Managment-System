'use client';

import { Capability, newIdempotencyKey } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { BackLink, EmptyState, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { toastApiError } from '@/lib/api/errors';
import {
  assessmentsApi,
  type AssessmentMarkRowDto,
  type AssessmentMarksDto,
  type MarkEntryBody,
} from '@/lib/api/school-assessments-contract';
import { resultsApi } from '@/lib/api/school-results-contract';
import { formatDay } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { correctionErrorMessage } from '../../results/_lib/results-ui';
import { kindLabel, marksErrorMessage, marksKeys } from '../_lib/marks-ui';

// contracts/slice-30.md §8, the marks grid: one row per student on the grid (the section on
// held_on), a mark typed or "Absent" ticked, Enter and the arrow keys move between rows. Save
// sends only the rows that changed, each with its own entry key (kept for a retry of the same
// value) and the mark it was based on; the answer is per row: a row someone else changed in the
// meantime is not written and is reported, with their mark shown.

type Draft = { obtained: string; absent: boolean };

const savedDraft = (row: AssessmentMarkRowDto): Draft => ({
  obtained: row.obtained === null ? '' : String(row.obtained),
  absent: row.absent,
});
const sameDraft = (a: Draft, b: Draft) =>
  a.absent === b.absent && (a.absent || a.obtained.trim() === b.obtained.trim());
const signature = (d: Draft) => (d.absent ? 'absent' : d.obtained.trim());

export function MarksGridScreen({ id }: { id: string }) {
  const grid = useQuery({
    queryKey: marksKeys.grid(id),
    queryFn: () =>
      unwrap(assessmentsApi.GET('/api/v1/assessments/{id}/marks', { params: { path: { id } } })),
  });
  return (
    <>
      <BackLink href="/marks">Marks</BackLink>
      <QueryStates
        query={grid}
        loadingRows={8}
        notFound={{
          title: 'Not one of your tests',
          description: 'This test is not in your sections and subjects, or it does not exist.',
        }}
      >
        {(data) => <MarksGrid key={data.assessment.updatedAt} data={data} />}
      </QueryStates>
    </>
  );
}

function MarksGrid({ data }: { data: AssessmentMarksDto }) {
  const { assessment, rows } = data;
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const editable = assessment.canEnterMarks;
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map());
  // An entry's key stays with its value, so a retried save of the same value is a replay (R262).
  const [keys, setKeys] = useState<ReadonlyMap<string, { sig: string; key: string }>>(new Map());
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [excusing, setExcusing] = useState<AssessmentMarkRowDto | null>(null);
  const [withdrawing, setWithdrawing] = useState<AssessmentMarkRowDto | null>(null);
  // Slice 32: a correction of a locked mark on a published result, keyed once per opened dialog.
  const [correcting, setCorrecting] = useState<{
    row: AssessmentMarkRowDto;
    key: string;
    draft: Draft;
  } | null>(null);

  const draftOf = (row: AssessmentMarkRowDto) => drafts.get(row.enrolmentId) ?? savedDraft(row);
  const changed = rows.filter(
    (row) =>
      drafts.has(row.enrolmentId) && !sameDraft(drafts.get(row.enrolmentId)!, savedDraft(row)),
  );
  const invalid = changed.filter((row) => {
    const d = draftOf(row);
    if (d.absent) return false;
    if (!/^[0-9]{1,4}$/.test(d.obtained.trim())) return true;
    return Number(d.obtained) > assessment.maxMarks;
  });
  const set = (row: AssessmentMarkRowDto, patch: Partial<Draft>) =>
    setDrafts((current) => new Map(current).set(row.enrolmentId, { ...draftOf(row), ...patch }));

  const reload = () =>
    void queryClient.invalidateQueries({ queryKey: marksKeys.grid(assessment.id) });

  const save = useMutation({
    mutationFn: (entries: MarkEntryBody[]) =>
      unwrap(
        assessmentsApi.POST('/api/v1/assessments/{id}/submit-marks', {
          params: { path: { id: assessment.id } },
          body: { entries },
        }),
      ),
    onSuccess: async (result) => {
      const elsewhere = result.entries
        .filter((e) => e.outcome === 'changed_elsewhere')
        .map((e) => e.enrolmentId);
      const names = new Map(rows.map((row) => [row.enrolmentId, row.student.fullName]));
      const saved = result.entries.filter(
        (e) => e.outcome === 'created' || e.outcome === 'superseded',
      ).length;
      if (saved > 0) toast.success(`${saved} mark${saved === 1 ? '' : 's'} saved.`);
      // Every answered row now shows the server's mark: ours, or (changed_elsewhere) theirs.
      await queryClient.invalidateQueries({ queryKey: marksKeys.all });
      setConflicts(elsewhere.map((enrolmentId) => names.get(enrolmentId) ?? 'A student'));
      setDrafts(new Map());
      setKeys(new Map());
      setError(null);
    },
    onError: (failure) => setError(marksErrorMessage(failure)),
  });

  const submit = () => {
    if (invalid.length > 0 || changed.length === 0) return;
    const nextKeys = new Map(keys);
    const entries = changed.map((row): MarkEntryBody => {
      const d = draftOf(row);
      const sig = signature(d);
      const held = keys.get(row.enrolmentId);
      const key = held && held.sig === sig ? held.key : newIdempotencyKey();
      nextKeys.set(row.enrolmentId, { sig, key });
      return {
        enrolmentId: row.enrolmentId,
        ...(d.absent ? { absent: true } : { obtained: Number(d.obtained) }),
        clientEntryKey: key,
        basedOnMarkId: row.markId,
      };
    });
    setKeys(nextKeys);
    save.mutate(entries);
  };

  const excuse = useMutation({
    mutationFn: ({ markId, reason }: { markId: string; reason: string }) =>
      unwrap(
        assessmentsApi.POST('/api/v1/marks/{id}/excuse', {
          params: { path: { id: markId } },
          body: { reason },
        }),
      ),
    onSuccess: () => {
      toast.success('Absence excused.');
      setExcusing(null);
      reload();
    },
    onError: toastApiError,
  });

  const correct = useMutation({
    mutationFn: ({ markId, key, draft, reason }: { markId: string; key: string; draft: Draft; reason: string }) =>
      unwrap(
        resultsApi.POST('/api/v1/marks/{id}/correct', {
          params: { path: { id: markId }, header: { 'Idempotency-Key': key } },
          body: draft.absent ? { absent: true, reason } : { obtained: Number(draft.obtained), reason },
        }),
      ),
    onSuccess: () => {
      toast.success('Correction sent. The principal decides it; the mark changes once approved.');
      setCorrecting(null);
      reload();
    },
    onError: (failure) => toast.error(correctionErrorMessage(failure)),
  });
  const withdraw = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(
        resultsApi.POST('/api/v1/mark-corrections/{id}/withdraw', {
          params: { path: { id } },
          body: { reason },
        }),
      ),
    onSuccess: () => {
      toast.success('Correction withdrawn. The mark stays as it was.');
      setWithdrawing(null);
      reload();
    },
    onError: (failure) => toast.error(correctionErrorMessage(failure)),
  });
  const correctionDraftBad =
    correcting !== null &&
    !correcting.draft.absent &&
    (!/^[0-9]{1,4}$/.test(correcting.draft.obtained.trim()) ||
      Number(correcting.draft.obtained) > assessment.maxMarks);

  /** Enter and ↓ move to the next row's mark, ↑ to the previous one. */
  const move = (index: number, step: number) => {
    document.querySelector<HTMLInputElement>(`[data-mark-input="${index + step}"]`)?.focus();
  };

  const marked = rows.filter((row) => row.status === 'live').length;
  const mayExcuse = can(Capability.RESULT_APPROVE);
  // A locked mark is changed only by a correction once the result is published (the API checks).
  const mayCorrect = can(Capability.MARKS_ENTER) && assessment.locked && !assessment.voidedAt;

  return (
    <div className="grid gap-4">
      <PageHeader
        title={assessment.name}
        description={`${kindLabel(assessment)} · ${assessment.className} ${assessment.sectionName} · ${assessment.subjectName} · ${formatDay(assessment.heldOn)} · out of ${assessment.maxMarks}`}
      />
      <p className="text-sm" data-testid="marks-count">
        {marked} of {rows.length} marked{changed.length > 0 && ` · ${changed.length} unsaved`}
      </p>
      {!editable && (
        <Alert data-testid="marks-read-only">
          <AlertTitle>Read only</AlertTitle>
          <AlertDescription>
            {assessment.voidedAt
              ? 'This assessment has been voided.'
              : assessment.locked
                ? 'Locked: the result sheet for this term has been submitted.'
                : 'You can read these marks but not enter them: you do not teach this subject in this section.'}
          </AlertDescription>
        </Alert>
      )}
      {conflicts.length > 0 && (
        <Alert role="status" data-testid="marks-conflicts">
          <AlertTitle>Changed elsewhere</AlertTitle>
          <AlertDescription>
            Someone else saved a mark for {conflicts.join(', ')} after you opened this test. Yours
            was not saved; their mark is shown. Enter yours again to replace it.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            title="No students"
            description="Nobody was on roll in this section on the test's date."
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14 px-4 text-muted-foreground">Roll</TableHead>
                <TableHead className="px-4 text-muted-foreground">Name</TableHead>
                <TableHead className="px-4 text-muted-foreground">
                  Mark (out of {assessment.maxMarks})
                </TableHead>
                <TableHead className="px-4 text-muted-foreground">Absent</TableHead>
                <TableHead className="w-24 px-2">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => {
                const d = draftOf(row);
                const dirty = changed.includes(row);
                const bad = invalid.includes(row);
                return (
                  <TableRow
                    key={row.enrolmentId}
                    data-enrolment={row.enrolmentId}
                    className={cn(dirty && 'bg-primary/5')}
                  >
                    <TableCell className="px-4 tabular-nums text-muted-foreground">
                      {row.student.rollNo ?? '—'}
                    </TableCell>
                    <TableCell className="px-4">
                      <span className="font-medium">{row.student.fullName}</span>
                      {row.excused && (
                        <Badge variant="outline" className="ml-2">
                          Excused
                        </Badge>
                      )}
                      {row.ownChildOf && (
                        <Badge variant="ghost" className="ml-2">
                          Your child
                        </Badge>
                      )}
                      {row.pendingCorrectionId && (
                        <Badge variant="outline" className="ml-2">
                          Correction waiting
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="px-4">
                      <Input
                        data-mark-input={index}
                        aria-label={`Mark of ${row.student.fullName}`}
                        inputMode="numeric"
                        className="h-8 w-24 tabular-nums"
                        value={d.absent ? '' : d.obtained}
                        disabled={!editable || d.absent}
                        aria-invalid={bad ? true : undefined}
                        onChange={(event) => set(row, { obtained: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            move(index, 1);
                          } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            move(index, -1);
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell className="px-4">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`${row.student.fullName} absent`}
                        checked={d.absent}
                        disabled={!editable}
                        onChange={(event) => set(row, { absent: event.target.checked })}
                      />
                    </TableCell>
                    <TableCell className="px-2">
                      {mayExcuse && row.markId && row.absent && !row.excused && (
                        <Button variant="ghost" size="sm" onClick={() => setExcusing(row)}>
                          Excuse
                        </Button>
                      )}
                      {row.pendingCorrectionId && row.pendingCorrectionMine && (
                        <Button variant="ghost" size="sm" onClick={() => setWithdrawing(row)}>
                          Withdraw correction
                        </Button>
                      )}
                      {mayCorrect && row.markId && !row.pendingCorrectionId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setCorrecting({ row, key: newIdempotencyKey(), draft: savedDraft(row) })
                          }
                        >
                          Request correction
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {editable && rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {invalid.length > 0 && (
            <p className="mr-auto text-sm text-destructive">
              Enter a whole number from 0 to {assessment.maxMarks} for{' '}
              {invalid[0]!.student.fullName}.
            </p>
          )}
          <Button
            onClick={submit}
            disabled={save.isPending || changed.length === 0 || invalid.length > 0}
          >
            {save.isPending
              ? 'Saving…'
              : `Save marks${changed.length ? ` (${changed.length})` : ''}`}
          </Button>
        </div>
      )}
      <ConfirmWithReasonDialog
        open={excusing !== null}
        onOpenChange={(open) => !open && setExcusing(null)}
        title={`Excuse ${excusing?.student.fullName ?? ''}'s absence`}
        description="An excused absence does not count against the student's result."
        confirmLabel="Excuse absence"
        minLength={3}
        pending={excuse.isPending}
        onConfirm={(reason) =>
          excusing?.markId && excuse.mutate({ markId: excusing.markId, reason })
        }
      />
      <ConfirmWithReasonDialog
        open={withdrawing !== null}
        onOpenChange={(open) => !open && setWithdrawing(null)}
        title={`Withdraw your correction of ${withdrawing?.student.fullName ?? ''}'s mark`}
        description="The correction is closed undecided and the mark stays as it was. You can ask again later."
        confirmLabel="Withdraw correction"
        minLength={3}
        pending={withdraw.isPending}
        onConfirm={(reason) =>
          withdrawing?.pendingCorrectionId && withdraw.mutate({ id: withdrawing.pendingCorrectionId, reason })
        }
      />
      <ConfirmWithReasonDialog
        open={correcting !== null}
        onOpenChange={(open) => !open && setCorrecting(null)}
        title={`Correct ${correcting?.row.student.fullName ?? ''}'s mark`}
        description="The result is published. A correction is decided by the principal; once approved the report card is reissued and the family told."
        confirmLabel="Send correction"
        minLength={3}
        pending={correct.isPending}
        confirmDisabled={correctionDraftBad}
        onConfirm={(reason) =>
          correcting?.row.markId &&
          correct.mutate({ markId: correcting.row.markId, key: correcting.key, draft: correcting.draft, reason })
        }
      >
        {correcting && (
          <div className="flex items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="correction-mark">Corrected mark (out of {assessment.maxMarks})</Label>
              <Input
                id="correction-mark"
                inputMode="numeric"
                className="w-28 tabular-nums"
                disabled={correcting.draft.absent}
                value={correcting.draft.absent ? '' : correcting.draft.obtained}
                aria-invalid={correctionDraftBad ? true : undefined}
                onChange={(e) =>
                  setCorrecting({ ...correcting, draft: { ...correcting.draft, obtained: e.target.value } })
                }
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={correcting.draft.absent}
                onChange={(e) =>
                  setCorrecting({ ...correcting, draft: { ...correcting.draft, absent: e.target.checked } })
                }
              />
              Absent
            </label>
          </div>
        )}
      </ConfirmWithReasonDialog>
    </div>
  );
}
