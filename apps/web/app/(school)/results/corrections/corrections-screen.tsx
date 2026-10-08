'use client';

import { Capability } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { EmptyState, QueryStates } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import {
  resultCardPrintPath,
  resultsApi,
  type MarkCorrectionDto,
  type MarkCorrectionListQuery,
  type MarkCorrectionState,
} from '@/lib/api/school-results-contract';
import { formatDateTime, formatDay } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { correctionErrorMessage, correctionKeys, openPrint, resultKeys } from '../_lib/results-ui';

// contracts/slice-32.md §8: Results → Corrections. A mark on a published result is corrected by
// a teacher's request and a result.approve holder's decision; approval re-composes the sheet as a
// new version and tells the corrected family. The requester never decides their own (R281).

const TABS: { state: MarkCorrectionState; label: string }[] = [
  { state: 'pending', label: 'Waiting' },
  { state: 'approved', label: 'Approved' },
  { state: 'rejected', label: 'Rejected' },
];

const value = (v: MarkCorrectionDto['to'] | null, max: number): string =>
  v === null ? '—' : v.absent ? (v.excused ? 'Absent (excused)' : 'Absent') : `${v.obtained} / ${max}`;

export function CorrectionsScreen() {
  const [state, setState] = useState<MarkCorrectionState>('pending');
  const query: MarkCorrectionListQuery = { status: state, limit: 50 };
  const list = useQuery({
    queryKey: correctionKeys.list(query),
    queryFn: () => unwrap(resultsApi.GET('/api/v1/mark-corrections', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Mark corrections"
        description="Changes to marks on published results. Approving one issues a revised report card and tells the family."
      />
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Corrections">
        {TABS.map((tab) => (
          <Button
            key={tab.state}
            role="tab"
            aria-selected={state === tab.state}
            variant={state === tab.state ? 'default' : 'outline'}
            size="sm"
            onClick={() => setState(tab.state)}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      <QueryStates query={list} loadingRows={6}>
        {(page) =>
          page.data.length === 0 ? (
            <div className="rounded-lg border bg-card">
              <EmptyState
                title={state === 'pending' ? 'Nothing waiting' : 'None yet'}
                description={
                  state === 'pending'
                    ? 'Teachers ask for a correction from a locked mark in the marks grid.'
                    : 'Decided corrections appear here.'
                }
              />
            </div>
          ) : (
            <CorrectionsTable rows={page.data} />
          )
        }
      </QueryStates>
    </>
  );
}

function CorrectionsTable({ rows }: { rows: MarkCorrectionDto[] }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const mayDecide = can(Capability.RESULT_APPROVE);
  const [rejecting, setRejecting] = useState<MarkCorrectionDto | null>(null);
  const [withdrawing, setWithdrawing] = useState<MarkCorrectionDto | null>(null);
  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: correctionKeys.all });
    void queryClient.invalidateQueries({ queryKey: resultKeys.all });
  };
  const approve = useMutation({
    mutationFn: (id: string) =>
      unwrap(resultsApi.POST('/api/v1/mark-corrections/{id}/approve', { params: { path: { id } } })),
    onSuccess: (decision) => {
      settled();
      toast.success(
        decision.revisedResult.revised
          ? `Approved. ${decision.mark.studentName}'s revised result is published and the family is told.`
          : 'Approved. The result did not change.',
        {
          action: can(Capability.MARKS_VIEW_ALL)
            ? { label: 'Print card', onClick: () => openPrint(resultCardPrintPath(decision.revisedResult.id)) }
            : undefined,
        },
      );
    },
    onError: (error) => toast.error(correctionErrorMessage(error)),
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(
        resultsApi.POST('/api/v1/mark-corrections/{id}/reject', {
          params: { path: { id } },
          body: { reason },
        }),
      ),
    onSuccess: () => {
      setRejecting(null);
      settled();
      toast.success('Correction rejected. The mark stays as it was.');
    },
    onError: (error) => toast.error(correctionErrorMessage(error)),
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
      setWithdrawing(null);
      settled();
      toast.success('Correction withdrawn. The mark stays as it was.');
    },
    onError: (error) => toast.error(correctionErrorMessage(error)),
  });
  const busy = approve.isPending || reject.isPending || withdraw.isPending;
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-4">Student</TableHead>
            <TableHead>Assessment</TableHead>
            <TableHead>Mark</TableHead>
            <TableHead className="min-w-56">Reason</TableHead>
            <TableHead>Asked by</TableHead>
            <TableHead className="px-2">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.id} data-testid={`correction.${c.id}`}>
              <TableCell className="px-4">
                <span className="font-medium">{c.studentName}</span>
                <span className="block text-xs text-muted-foreground">
                  {c.className} {c.sectionName} · {c.admissionNo}
                </span>
              </TableCell>
              <TableCell>
                {c.assessmentName}
                <span className="block text-xs text-muted-foreground">
                  {c.subjectName} · {c.termName} · {formatDay(c.heldOn)}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                <span className="text-muted-foreground line-through">{value(c.from, c.maxMarks)}</span>
                <span className="block font-medium">{value(c.to, c.maxMarks)}</span>
              </TableCell>
              <TableCell className="text-sm">{c.reason}</TableCell>
              <TableCell className="text-sm">
                {c.requestedByName}
                <span className="block text-xs text-muted-foreground">{formatDateTime(c.requestedAt)}</span>
                {c.decidedByName && (
                  <Badge variant={c.status === 'rejected' && !c.withdrawn ? 'destructive' : 'secondary'} className="mt-1">
                    {c.withdrawn ? 'Withdrawn' : `${c.status === 'rejected' ? 'Rejected' : 'Approved'} by ${c.decidedByName}`}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-2 whitespace-nowrap">
                {c.status === 'pending' && c.requestedByMe && can(Capability.MARKS_ENTER) && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setWithdrawing(c)}>
                    Withdraw
                  </Button>
                )}
                {mayDecide && c.status === 'pending' && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      // The requester is refused by the API unless they are the sole principal (R281).
                      disabled={busy}
                      onClick={() => approve.mutate(c.id)}
                    >
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(c)}>
                      Reject
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmWithReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={`Reject the correction for ${rejecting?.studentName ?? ''}`}
        description="The teacher sees your reason; the mark stays as it was."
        confirmLabel="Reject correction"
        minLength={3}
        pending={reject.isPending}
        onConfirm={(reason) => rejecting && reject.mutate({ id: rejecting.id, reason })}
      />
      <ConfirmWithReasonDialog
        open={withdrawing !== null}
        onOpenChange={(open) => !open && setWithdrawing(null)}
        title={`Withdraw your correction for ${withdrawing?.studentName ?? ''}`}
        description="The correction is closed undecided and the mark stays as it was."
        confirmLabel="Withdraw correction"
        minLength={3}
        pending={withdraw.isPending}
        onConfirm={(reason) => withdrawing && withdraw.mutate({ id: withdrawing.id, reason })}
      />
    </div>
  );
}
