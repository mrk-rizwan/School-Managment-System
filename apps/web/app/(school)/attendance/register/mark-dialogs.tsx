'use client';

import { ErrorCode, type AttendanceStatus } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { attendanceApi, type RegisterViewDto, type RosterRowDto } from '@/lib/api/school-attendance-contract';
import { formatDateTime } from '@/lib/format';
import { STATUS_LABELS, StatusButtons, TIME_PATTERN, attendanceErrorMessage, attendanceKeys } from '../_lib/attendance-ui';

// A mark's change history (contract §4.5) and the single-mark correction (§4.3), both opened
// from a row's menu on the register.

export function MarkHistoryDialog({ row, onClose }: { row: RosterRowDto | null; onClose: () => void }) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark history</DialogTitle>
          <DialogDescription>{row?.studentFullName}</DialogDescription>
        </DialogHeader>
        {row?.mark && <History markId={row.mark.id} />}
      </DialogContent>
    </Dialog>
  );
}

function History({ markId }: { markId: string }) {
  const query = { limit: OPTIONS_LIMIT, sort: '-changedAt' } as const;
  const changes = useQuery({
    queryKey: [...attendanceKeys.changes(markId), query],
    queryFn: () =>
      unwrap(attendanceApi.GET('/api/v1/attendance-marks/{id}/changes', { params: { path: { id: markId }, query } })),
  });
  if (changes.error) return <ErrorState error={changes.error} onRetry={() => void changes.refetch()} />;
  if (!changes.data) return <LoadingState rows={2} />;
  if (changes.data.data.length === 0) {
    return <EmptyState title="Never changed" description="This mark is as it was first recorded." />;
  }
  return (
    <ol className="grid max-h-80 gap-3 overflow-y-auto text-sm">
      {changes.data.data.map((c) => (
        <li key={c.id} className="rounded-lg border px-3 py-2">
          <p>
            <span className="font-medium">
              {STATUS_LABELS[c.fromStatus]} → {STATUS_LABELS[c.toStatus]}
            </span>
            {c.toArrivedAt && c.toArrivedAt !== c.fromArrivedAt && <span> (arrived {c.toArrivedAt})</span>}
            {c.noteChanged && <span className="text-muted-foreground"> · note changed</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {c.changedByName ?? 'Unknown'}, {formatDateTime(c.changedAt)}
          </p>
          <p className="mt-1">{c.reason}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * POST /attendance-marks/:id/amend. `fromStatus` is what the screen shows; a colleague's change in
 * between is refused (STALE_STATUS), the register is reloaded and the dialog asks again.
 */
export function CorrectMarkDialog({
  view,
  row,
  onClose,
}: {
  view: RegisterViewDto;
  row: RosterRowDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const timeId = useId();
  const mark = row?.mark ?? null;
  const [status, setStatus] = useState<AttendanceStatus | null>(null);
  const [arrivedAt, setArrivedAt] = useState('');
  const amend = useMutation({
    mutationFn: ({ reason, to }: { reason: string; to: AttendanceStatus }) =>
      unwrap(
        attendanceApi.POST('/api/v1/attendance-marks/{id}/amend', {
          params: { path: { id: mark!.id } },
          body: {
            fromStatus: mark!.status,
            status: to,
            reason,
            ...(to === 'late' && arrivedAt && { arrivedAt }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(`${row?.studentFullName}'s mark corrected.`);
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
      close();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.STALE_STATUS) {
        void queryClient.invalidateQueries({ queryKey: attendanceKeys.register(view.section.id, view.date, view.period) });
      }
    },
  });
  const close = () => {
    amend.reset();
    setStatus(null);
    setArrivedAt('');
    onClose();
  };
  const to = status ?? mark?.status ?? null;
  const timeOk = to !== 'late' || arrivedAt === '' || TIME_PATTERN.test(arrivedAt);

  return (
    <ConfirmWithReasonDialog
      open={row !== null && mark !== null}
      onOpenChange={(open) => !open && close()}
      title={`Correct ${row?.studentFullName ?? ''}'s mark`}
      description={mark ? `Now ${STATUS_LABELS[mark.status]}. The change and its reason are kept with the mark.` : undefined}
      confirmLabel="Correct mark"
      minLength={3}
      pending={amend.isPending}
      confirmDisabled={!to || !timeOk || (to === mark?.status && arrivedAt === '')}
      onConfirm={(reason) => to && amend.mutate({ reason, to })}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">New mark</span>
          <StatusButtons value={to} label={row?.studentFullName ?? ''} onChange={setStatus} />
        </div>
        {to === 'late' && (
          <div className="grid gap-1.5 sm:w-40">
            <Label htmlFor={timeId}>Arrived at (optional)</Label>
            <Input id={timeId} type="time" value={arrivedAt} onChange={(event) => setArrivedAt(event.target.value)} />
          </div>
        )}
        {amend.error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{attendanceErrorMessage(amend.error)}</AlertDescription>
          </Alert>
        )}
      </div>
    </ConfirmWithReasonDialog>
  );
}
