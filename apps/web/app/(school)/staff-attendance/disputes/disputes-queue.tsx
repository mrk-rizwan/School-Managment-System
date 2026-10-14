'use client';

import { DISPUTE_STATUS_LABELS, ErrorCode, type DisputeStatus } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { TablePagination } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { BackLink, EmptyState, ErrorState, LoadingState, NoPermissionState, isPermissionDenied } from '@/components/page-states';
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
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import {
  staffAttendanceApi,
  type AttendanceDisputeDto,
  type DisputesQuery,
} from '@/lib/api/school-staff-attendance-contract';
import { formatDateTime, formatDay } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useSchoolMe } from '@/lib/school-session';
import { STATUS_LABELS, attendanceKeys } from '../../attendance/_lib/attendance-ui';

// Phase 5 slice 44 (contracts/slice-44.md §2.6, R346, R347): staff attendance disputes for
// attendance.staff.manage holders. Approving amends the mark to what was asked (from whatever it
// says now); rejecting needs a reason. Nobody decides their own dispute, a principal included.

const LIMIT = 25;
export const disputeKeys = ['school', 'attendance', 'disputes'] as const;

const REFUSALS: RefusalMessages = {
  [`${ErrorCode.SELF_ACTION_FORBIDDEN}:own_attendance`]: 'You cannot decide a dispute of your own attendance. Ask a colleague.',
  [ErrorCode.ATTENDANCE_DISPUTE_NOT_PENDING]: 'This dispute was already decided or withdrawn.',
};

export function DisputesQueue() {
  const queryClient = useQueryClient();
  const me = useSchoolMe();
  const [status, setStatus] = useState<'' | DisputeStatus>('pending');
  const [page, setPage] = useListPage([status]);
  const [approving, setApproving] = useState<AttendanceDisputeDto | null>(null);
  const [rejecting, setRejecting] = useState<AttendanceDisputeDto | null>(null);
  const query: DisputesQuery = { page, limit: LIMIT, ...(status && { status }) };
  const list = useQuery({
    queryKey: [...disputeKeys, query],
    queryFn: () => unwrap(staffAttendanceApi.GET('/api/v1/staff-attendance-disputes', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.data ?? [];
  const ownStaffId = me.data?.staffId ?? null;

  const done = (verb: string) => (dispute: AttendanceDisputeDto) => {
    toast.success(`Dispute of ${dispute.staffName} ${verb}.`);
    setApproving(null);
    setRejecting(null);
    void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['school', 'approvals'] });
  };
  const failed = (error: unknown) => {
    setApproving(null);
    setRejecting(null);
    toast.error(refusalMessage(error, REFUSALS));
    void queryClient.invalidateQueries({ queryKey: disputeKeys });
  };
  const approve = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(
        staffAttendanceApi.POST('/api/v1/staff-attendance-disputes/{id}/approve', {
          params: { path: { id } },
          body: reason ? { reason } : {},
        }),
      ),
    onSuccess: done('approved'),
    onError: failed,
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(staffAttendanceApi.POST('/api/v1/staff-attendance-disputes/{id}/reject', { params: { path: { id } }, body: { reason } })),
    onSuccess: done('rejected'),
    onError: failed,
  });

  return (
    <>
      <BackLink href="/staff-attendance">Staff attendance</BackLink>
      <PageHeader
        title="Attendance disputes"
        description="Staff who think their attendance was recorded wrongly ask here. Approving changes the mark; the change is kept in its history."
      />
      <div className="mb-4">
        <FilterSelect<'' | DisputeStatus> label="Status" value={status} onChange={setStatus}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="">Any</option>
        </FilterSelect>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        {list.error ? (
          isPermissionDenied(list.error) ? (
            <NoPermissionState />
          ) : (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          )
        ) : list.isPending ? (
          <LoadingState rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState title="No disputes" description={status === 'pending' ? 'Nobody is waiting for a decision.' : 'None match this filter.'} />
        ) : (
          <Table aria-busy={list.isPlaceholderData} data-testid="disputes-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4 text-muted-foreground">Staff member and day</TableHead>
                <TableHead className="px-4 text-muted-foreground">Asks</TableHead>
                <TableHead className="px-4 text-muted-foreground">Reason</TableHead>
                <TableHead className="px-4 text-muted-foreground">Status</TableHead>
                <TableHead className="px-4">
                  <span className="sr-only">Decision</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => {
                const own = ownStaffId !== null && d.staffId === ownStaffId;
                return (
                  <TableRow key={d.id} data-dispute={d.id}>
                    <TableCell className="px-4">
                      <div className="font-medium">
                        {d.staffName}
                        {own && (
                          <Badge variant="outline" className="ml-2">
                            your own
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDay(d.date)}
                        {d.markSource === 'device' && ' · marked by the device'}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 text-sm">
                      {STATUS_LABELS[d.markStatus]} → <span className="font-medium">{STATUS_LABELS[d.requestedStatus]}</span>
                    </TableCell>
                    <TableCell className="max-w-72 px-4 text-sm">
                      <p className="break-words">{d.reason}</p>
                      <p className="text-xs text-muted-foreground">Raised {formatDateTime(d.createdAt)}</p>
                    </TableCell>
                    <TableCell className="px-4 text-sm">
                      <Badge variant={d.status === 'pending' ? 'default' : 'outline'}>{DISPUTE_STATUS_LABELS[d.status]}</Badge>
                      {d.decidedByName && <p className="mt-1 text-xs text-muted-foreground">by {d.decidedByName}</p>}
                      {d.decisionReason && <p className="text-xs text-muted-foreground">“{d.decisionReason}”</p>}
                    </TableCell>
                    <TableCell className="px-4">
                      {d.status === 'pending' &&
                        (own ? (
                          <span className="text-xs text-muted-foreground">A colleague decides this</span>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => setApproving(d)}>
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setRejecting(d)}>
                              Reject
                            </Button>
                          </div>
                        ))}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {rows.length > 0 && !list.error && (
          <TablePagination
            page={list.data?.page ?? page}
            limit={LIMIT}
            total={list.data?.total ?? 0}
            loading={list.isPlaceholderData}
            onPageChange={setPage}
          />
        )}
      </div>

      <ApproveDialog
        key={approving?.id ?? 'none'}
        dispute={approving}
        pending={approve.isPending}
        onClose={() => setApproving(null)}
        onConfirm={(reason) => approving && approve.mutate({ id: approving.id, reason })}
      />
      <ConfirmWithReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={rejecting ? `Reject ${rejecting.staffName}'s dispute?` : 'Reject the dispute?'}
        description="The mark stays as it is. Your reason is shown to them."
        confirmLabel="Reject"
        minLength={3}
        destructive
        pending={reject.isPending}
        onConfirm={(reason) => rejecting && reject.mutate({ id: rejecting.id, reason })}
      />
    </>
  );
}

function ApproveDialog({
  dispute,
  pending,
  onClose,
  onConfirm,
}: {
  dispute: AttendanceDisputeDto | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 3;
  return (
    <Dialog open={dispute !== null} onOpenChange={(open) => !pending && !open && onClose()}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Approve the dispute?</DialogTitle>
          {dispute && (
            <DialogDescription>
              {dispute.staffName}’s mark for {formatDay(dispute.date)} becomes {STATUS_LABELS[dispute.requestedStatus]}. It now
              says {STATUS_LABELS[dispute.markStatus]}.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="approve-reason">Note (optional)</Label>
          <Textarea id="approve-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          {tooShort && <p className="text-xs text-destructive">Write at least 3 characters, or leave it empty.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(trimmed)} disabled={pending || tooShort}>
            {pending ? 'Approving…' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
