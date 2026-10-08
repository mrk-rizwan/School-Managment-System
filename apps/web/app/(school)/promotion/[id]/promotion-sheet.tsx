'use client';

import { formatPercentBp, newIdempotencyKey, PROMOTION_OUTCOMES } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { BackLink, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { academics } from '@/lib/api/school-academics-contract';
import {
  promotionApi,
  type PromotionDecisionDto,
  type PromotionDecisionInput,
  type PromotionOutcome,
  type PromotionSheetDetailDto,
} from '@/lib/api/school-promotion-contract';
import { formatDateTime } from '@/lib/format';
import { useIsPrincipal } from '../../fees/_lib/fees-ui';
import { OUTCOME_LABELS, promotionErrorMessage, promotionKeys } from '../_lib/promotion-ui';

// contracts/slice-35.md §2-§4: one section's promotion sheet. Each student's result, the
// proposal and the decision; an override needs a reason; promote and detain name the class and
// section of the target year; arrears are flagged, never blocking. Apply moves everyone at once.

interface Edit {
  decision: PromotionOutcome | '';
  reason: string;
  targetClassId: string;
  targetSectionId: string;
}

const MOVES: readonly PromotionOutcome[] = ['promote', 'detain'];

const editOf = (r: PromotionDecisionDto): Edit => ({
  decision: r.decision ?? '',
  reason: r.reason ?? '',
  targetClassId: r.targetClassId ?? '',
  targetSectionId: r.targetSectionId ?? '',
});

const changed = (r: PromotionDecisionDto, e: Edit): boolean => {
  const base = editOf(r);
  return (
    e.decision !== base.decision ||
    e.reason.trim() !== base.reason ||
    e.targetClassId !== base.targetClassId ||
    e.targetSectionId !== base.targetSectionId
  );
};

export function PromotionSheet({ id }: { id: string }) {
  const sheet = useQuery({
    queryKey: promotionKeys.sheet(id),
    queryFn: () => unwrap(promotionApi.GET('/api/v1/promotion-sheets/{id}', { params: { path: { id } } })),
  });
  return (
    <>
      <BackLink href="/promotion">Promotion</BackLink>
      <QueryStates query={sheet} loadingRows={8}>
        {(data) => <SheetBody key={data.updatedAt + data.decisions.map((d) => d.decision).join()} sheet={data} />}
      </QueryStates>
    </>
  );
}

function SheetBody({ sheet }: { sheet: PromotionSheetDetailDto }) {
  const queryClient = useQueryClient();
  const isPrincipal = useIsPrincipal();
  const open = sheet.status === 'open';
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  // R295: only a final class completes; elsewhere the choice is not offered.
  const outcomes = PROMOTION_OUTCOMES.filter((o) => o !== 'complete' || sheet.classIsFinal);
  const [applyKey, setApplyKey] = useState(newIdempotencyKey);
  const targets = useQuery({
    queryKey: promotionKeys.targets(sheet.targetYearId),
    queryFn: async () => {
      const classes = await unwrap(
        academics.GET('/api/v1/classes', {
          params: { query: { academicYearId: sheet.targetYearId, status: 'active', limit: 50 } },
        }),
      );
      const out: { id: string; name: string; sections: { id: string; name: string }[] }[] = [];
      for (const klass of classes.data) {
        const sections = await unwrap(
          academics.GET('/api/v1/classes/{id}/sections', { params: { path: { id: klass.id }, query: { limit: 50 } } }),
        );
        out.push({ id: klass.id, name: klass.name, sections: sections.data.map((s) => ({ id: s.id, name: s.name })) });
      }
      return out;
    },
    enabled: open,
  });

  const edit = (r: PromotionDecisionDto): Edit => edits[r.enrolmentId] ?? editOf(r);
  const setEdit = (r: PromotionDecisionDto, patch: Partial<Edit>) =>
    setEdits((all) => ({ ...all, [r.enrolmentId]: { ...edit(r), ...patch } }));
  const pending = sheet.decisions.filter((r) => edits[r.enrolmentId] && changed(r, edit(r)));

  const refresh = () => void queryClient.invalidateQueries({ queryKey: promotionKeys.all });
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        promotionApi.PATCH('/api/v1/promotion-sheets/{id}', {
          params: { path: { id: sheet.id } },
          body: {
            decisions: pending.map((r): PromotionDecisionInput => {
              const e = edit(r);
              const moves = MOVES.includes(e.decision as PromotionOutcome);
              return {
                enrolmentId: r.enrolmentId,
                decision: e.decision as PromotionOutcome,
                ...(e.reason.trim() ? { reason: e.reason.trim() } : {}),
                ...(moves && e.targetClassId ? { targetClassId: e.targetClassId } : {}),
                ...(moves && e.targetSectionId ? { targetSectionId: e.targetSectionId } : {}),
              };
            }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success('Decisions saved.');
      setEdits({});
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      unwrap(
        promotionApi.POST('/api/v1/promotion-sheets/{id}/cancel', {
          params: { path: { id: sheet.id } },
          body: { reason: cancelReason.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success('Promotion sheet cancelled.');
      setCancelling(false);
      refresh();
    },
  });
  const apply = useMutation({
    mutationFn: () =>
      unwrap(
        promotionApi.POST('/api/v1/promotion-sheets/{id}/apply', {
          params: { path: { id: sheet.id }, header: { 'Idempotency-Key': applyKey } },
        }),
      ),
    onSuccess: () => {
      toast.success(`${sheet.className} ${sheet.sectionName} is promoted into ${sheet.targetYearName}.`);
      setApplying(false);
      refresh();
    },
  });

  return (
    <>
      <PageHeader
        title={`Promotion · ${sheet.className} ${sheet.sectionName}`}
        description={`${sheet.academicYearName} into ${sheet.targetYearName} · opened by ${sheet.openedByName} ${formatDateTime(sheet.openedAt)}`}
        actions={
          open && (
            <>
              {isPrincipal && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    cancel.reset();
                    setCancelReason('');
                    setCancelling(true);
                  }}
                >
                  Cancel sheet…
                </Button>
              )}
              <Button variant="outline" disabled={pending.length === 0 || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : `Save changes${pending.length > 0 ? ` (${pending.length})` : ''}`}
              </Button>
              <Button
                disabled={pending.length > 0 || sheet.undecided > 0}
                onClick={() => {
                  apply.reset();
                  setApplyKey(newIdempotencyKey());
                  setApplying(true);
                }}
              >
                Apply…
              </Button>
            </>
          )
        }
      />
      {sheet.status === 'applied' && (
        <Alert className="mb-4">
          <AlertTitle>Applied {sheet.appliedAt ? formatDateTime(sheet.appliedAt) : ''}</AlertTitle>
          <AlertDescription>
            The students below were moved by {sheet.appliedByName}. The sheet can no longer change.
          </AlertDescription>
        </Alert>
      )}
      {sheet.status === 'cancelled' && (
        <Alert className="mb-4">
          <AlertTitle>Cancelled</AlertTitle>
          <AlertDescription>
            Nobody was moved. The decisions below are kept for the record; the section can open a new sheet.
          </AlertDescription>
        </Alert>
      )}
      {open && !sheet.targetYearHasClasses && (
        <Alert className="mb-4">
          <AlertTitle>{sheet.targetYearName} has no classes yet</AlertTitle>
          <AlertDescription>
            Create its classes and sections, and set each class&apos;s next class, before deciding promote or detain.
          </AlertDescription>
        </Alert>
      )}
      {save.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{promotionErrorMessage(save.error)}</AlertDescription>
        </Alert>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Student</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Proposed</TableHead>
              <TableHead>Decision</TableHead>
              <TableHead>Into</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheet.decisions.map((r) => {
              const e = edit(r);
              const moves = MOVES.includes(e.decision as PromotionOutcome);
              const klass = (targets.data ?? []).find((c) => c.id === e.targetClassId);
              const needsReason = e.decision !== '' && e.decision !== (r.proposed ?? '');
              const rowOpen = open && r.enrolmentStatus === 'active';
              return (
                <TableRow key={r.id}>
                  <TableCell className="px-4">
                    <div className="font-medium">{r.studentName}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.admissionNo}
                      {r.rollNo !== null && ` · Roll ${r.rollNo}`}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.studentStatus === 'suspended' && <Badge variant="outline">Suspended</Badge>}
                      {r.arrearsFlag && <Badge variant="destructive">Fees owed</Badge>}
                      {r.resultSuperseded && <Badge variant="destructive">Result corrected: decide again</Badge>}
                      {r.revisedAfterApply && <Badge variant="outline">Result revised after apply</Badge>}
                      {r.skipped && <Badge variant="outline">Skipped (left before apply)</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.percentBp === null ? (
                      <span className="text-muted-foreground">{r.resultId ? 'Not assessed' : 'No result'}</span>
                    ) : (
                      <>
                        {formatPercentBp(r.percentBp)} % · {r.grade}{' '}
                        <span className={r.passed ? 'text-muted-foreground' : 'text-destructive'}>
                          {r.passed ? 'Passed' : 'Failed'}
                        </span>
                      </>
                    )}
                  </TableCell>
                  <TableCell>{r.proposed ? OUTCOME_LABELS[r.proposed] : '—'}</TableCell>
                  <TableCell>
                    {rowOpen ? (
                      <NativeSelect
                        aria-label={`Decision for ${r.studentName}`}
                        value={e.decision}
                        onChange={(ev) =>
                          // A new decision starts from its own default class and section (the
                          // server recomputes them); the old target belonged to the old decision.
                          setEdit(r, {
                            decision: ev.target.value as PromotionOutcome | '',
                            targetClassId: '',
                            targetSectionId: '',
                          })
                        }
                      >
                        <option value="" disabled>
                          Choose…
                        </option>
                        {outcomes.map((o) => (
                          <option key={o} value={o}>
                            {OUTCOME_LABELS[o]}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : r.decision ? (
                      OUTCOME_LABELS[r.decision]
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {rowOpen && moves ? (
                      <div className="flex gap-2">
                        <NativeSelect
                          aria-label={`Class for ${r.studentName}`}
                          value={e.targetClassId}
                          onChange={(ev) => setEdit(r, { targetClassId: ev.target.value, targetSectionId: '' })}
                        >
                          <option value="">Default class</option>
                          {(targets.data ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </NativeSelect>
                        <NativeSelect
                          aria-label={`Section for ${r.studentName}`}
                          value={e.targetSectionId}
                          onChange={(ev) => setEdit(r, { targetSectionId: ev.target.value })}
                        >
                          <option value="">Default section</option>
                          {(klass?.sections ?? []).map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    ) : r.targetClassName ? (
                      `${r.targetClassName} ${r.targetSectionName ?? ''}`
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="min-w-56">
                    {rowOpen ? (
                      <Input
                        aria-label={`Reason for ${r.studentName}`}
                        value={e.reason}
                        maxLength={500}
                        placeholder={needsReason ? 'Required: why differ from the proposal' : 'Optional'}
                        onChange={(ev) => setEdit(r, { reason: ev.target.value })}
                      />
                    ) : (
                      (r.reason ?? '—')
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Dialog open={cancelling} onOpenChange={(next) => (next || cancel.isPending ? undefined : setCancelling(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this promotion sheet?</DialogTitle>
            <DialogDescription>
              Nobody is moved. The sheet and its decisions are kept for the record, and {sheet.className}{' '}
              {sheet.sectionName} can open a new sheet.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Reason for cancelling"
            value={cancelReason}
            maxLength={500}
            placeholder="Why is the sheet cancelled?"
            onChange={(ev) => setCancelReason(ev.target.value)}
          />
          {cancel.error && (
            <Alert variant="destructive">
              <AlertDescription>{promotionErrorMessage(cancel.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(false)} disabled={cancel.isPending}>
              Keep the sheet
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending || cancelReason.trim().length < 3}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel sheet'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={applying} onOpenChange={(next) => (next || apply.isPending ? undefined : setApplying(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply the promotion sheet?</DialogTitle>
            <DialogDescription>
              Each enrolment of {sheet.academicYearName} closes on the year&apos;s last day; promoted and detained
              students start in {sheet.targetYearName} without a roll number; completed students become alumni; students
              not continuing are withdrawn. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {apply.error && (
            <Alert variant="destructive">
              <AlertDescription>{promotionErrorMessage(apply.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplying(false)} disabled={apply.isPending}>
              Cancel
            </Button>
            <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
              {apply.isPending ? 'Applying…' : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
