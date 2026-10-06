'use client';

import { Capability, formatRupees } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  chargesApi,
  type ConcessionDto,
  type ConcessionListQuery,
  type ConcessionStatus,
} from '@/lib/api/school-charges-contract';
import { formatDate } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { CONCESSION_STATUS_LABELS, feesKeys, formatMonth, useIsPrincipal } from '../_lib/fees-ui';

const LIMIT = 25;

/** `50%` or `Rs 1,000 per charge`. */
export const concessionTerms = (c: Pick<ConcessionDto, 'kind' | 'value'>) =>
  c.kind === 'percentage' ? `${c.value}%` : `${formatRupees(c.value)} per charge`;

/**
 * Concessions (slice 19, R182, R183): the principal's queue of requests, and every concession's
 * decision. The office requests from the student's Fees tab.
 */
export function ConcessionQueue() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const principal = useIsPrincipal();
  const decide = can(Capability.CONCESSION_GRANT) && principal;
  const [status, setStatus] = useState<ConcessionStatus | ''>('requested');
  const [page, setPage] = useListPage([status]);
  const [approving, setApproving] = useState<ConcessionDto | null>(null);
  const [rejecting, setRejecting] = useState<ConcessionDto | null>(null);
  const [ending, setEnding] = useState<ConcessionDto | null>(null);

  const query: ConcessionListQuery = { page, limit: LIMIT, sort: status === 'requested' ? 'requestedAt' : '-requestedAt', ...(status && { status }) };
  const concessions = useQuery({
    queryKey: [...feesKeys.concessions, 'list', query],
    queryFn: () => unwrap(chargesApi.GET('/api/v1/concessions', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const done = (message: string, close: () => void) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: feesKeys.all });
    close();
  };
  const failed = (error: unknown, close: () => void) => {
    toastApiError(error);
    if (error instanceof ApiError && error.status === 409) {
      void queryClient.invalidateQueries({ queryKey: feesKeys.concessions });
      close();
    }
  };
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(chargesApi.POST('/api/v1/concessions/{id}/reject', { params: { path: { id } }, body: { reason } })),
    onSuccess: (c) => done(`Concession for ${c.studentName} rejected.`, () => setRejecting(null)),
    onError: (error) => failed(error, () => setRejecting(null)),
  });
  const end = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(chargesApi.POST('/api/v1/concessions/{id}/end', { params: { path: { id } }, body: { reason } })),
    onSuccess: (c) => done(`Concession for ${c.studentName} ended. Charges already raised are unchanged.`, () => setEnding(null)),
    onError: (error) => failed(error, () => setEnding(null)),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ConcessionDto>();
    return [
      column.accessor('studentName', {
        header: 'Student',
        cell: (info) => (
          <Link href={`/students/${info.row.original.studentId}`} className="flex flex-col hover:underline">
            <span className="font-medium">{info.getValue()}</span>
            <span className="text-xs text-muted-foreground">{info.row.original.className}</span>
          </Link>
        ),
      }),
      column.accessor('value', {
        header: 'Concession',
        cell: (info) => (
          <span className="flex flex-col">
            <span>{concessionTerms(info.row.original)}</span>
            <span className="text-xs text-muted-foreground">
              {info.row.original.heads.map((h) => h.name).join(', ')} from {formatMonth(info.row.original.effectiveFrom)}
            </span>
          </span>
        ),
      }),
      column.accessor('reason', { header: 'Reason', cell: (info) => <span className="line-clamp-2">{info.getValue()}</span> }),
      column.accessor('requestedAt', {
        header: 'Requested',
        cell: (info) => (
          <span className="flex flex-col">
            <span>{formatDate(info.getValue())}</span>
            <span className="text-xs text-muted-foreground">{info.row.original.requestedByName ?? ''}</span>
          </span>
        ),
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <span className="flex items-center gap-2">
            <Badge variant={info.getValue() === 'requested' ? 'default' : 'ghost'}>{CONCESSION_STATUS_LABELS[info.getValue()]}</Badge>
            {info.row.original.selfApproved && <Badge variant="outline">Self-approved</Badge>}
          </span>
        ),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const c = info.row.original;
          const actions: RowAction[] = [];
          if (decide && c.status === 'requested') {
            actions.push({ label: 'Approve…', onSelect: () => setApproving(c) });
            actions.push({ label: 'Reject', onSelect: () => setRejecting(c), destructive: true });
          }
          if (decide && c.status === 'approved') actions.push({ label: 'End', onSelect: () => setEnding(c), destructive: true });
          return <RowActions label={c.studentName} actions={actions} />;
        },
      }),
    ];
  }, [decide]);

  return (
    <>
      <div className="mb-4">
        <FilterSelect<ConcessionStatus | ''> label="Status" value={status} onChange={setStatus}>
          <option value="requested">Waiting for a decision</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="ended">Ended</option>
          <option value="">All</option>
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={concessions}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={status === 'requested' ? 'Nothing waiting' : 'No concessions'}
        emptyDescription="The office requests a concession from a student’s Fees tab; a principal decides it here."
      />
      <ApproveDialog concession={approving} onClose={() => setApproving(null)} />
      <ConfirmWithReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={`Reject concession: ${rejecting?.studentName ?? ''}`}
        confirmLabel="Reject"
        minLength={3}
        destructive
        pending={reject.isPending}
        onConfirm={(reason) => rejecting && reject.mutate({ id: rejecting.id, reason })}
      />
      <ConfirmWithReasonDialog
        open={ending !== null}
        onOpenChange={(open) => !open && setEnding(null)}
        title={`End concession: ${ending?.studentName ?? ''}`}
        description="Future charges are raised in full. Charges already raised keep their concession."
        confirmLabel="End concession"
        minLength={3}
        destructive
        pending={end.isPending}
        onConfirm={(reason) => ending && end.mutate({ id: ending.id, reason })}
      />
    </>
  );
}

function ApproveDialog({ concession, onClose }: { concession: ConcessionDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [apply, setApply] = useState(true);
  const approve = useMutation({
    mutationFn: (c: ConcessionDto) =>
      unwrap(chargesApi.POST('/api/v1/concessions/{id}/approve', { params: { path: { id: c.id } }, body: { applyToOpenCharges: apply } })),
    onSuccess: (decision) => {
      const credited = decision.adjustments.reduce((sum, a) => sum + a.amount, 0);
      toast.success(
        decision.adjustments.length > 0
          ? `Approved. ${formatRupees(credited)} credited on ${decision.adjustments.length} open charge(s).`
          : 'Approved. It applies to charges raised from now on.',
      );
      void queryClient.invalidateQueries({ queryKey: feesKeys.all });
      onClose();
    },
    onError: (error) => {
      toastApiError(error);
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: feesKeys.concessions });
        onClose();
      }
    },
  });
  return (
    <Dialog open={concession !== null} onOpenChange={(open) => !open && !approve.isPending && onClose()}>
      <DialogContent>
        {concession && (
          <>
            <DialogHeader>
              <DialogTitle>Approve concession: {concession.studentName}</DialogTitle>
              <DialogDescription>
                {concessionTerms(concession)} on {concession.heads.map((h) => h.name).join(', ')} from{' '}
                {formatMonth(concession.effectiveFrom)}. {concession.reason}
              </DialogDescription>
            </DialogHeader>
            <Label className="flex items-start gap-2 font-normal">
              <input type="checkbox" className="mt-1" checked={apply} onChange={(e) => setApply(e.target.checked)} />
              <span>
                Apply to open charges already raised from {formatMonth(concession.effectiveFrom)}
                <span className="block text-xs text-muted-foreground">Each gets a credit line; nothing already paid changes.</span>
              </span>
            </Label>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={approve.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" disabled={approve.isPending} onClick={() => approve.mutate(concession)}>
                {approve.isPending ? 'Approving…' : 'Approve'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
