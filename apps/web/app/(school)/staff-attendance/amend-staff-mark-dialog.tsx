'use client';

import { ErrorCode, type StaffAttendanceStatus } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { staffAttendanceApi, type StaffDayDto } from '@/lib/api/school-staff-attendance-contract';
import { STATUS_LABELS, StatusButtons, attendanceErrorMessage, attendanceKeys } from '../attendance/_lib/attendance-ui';

// contracts/slice-12.md §4.3, §8 "Amend one mark": from a row's menu. A colleague's change in
// between is refused (STALE_STATUS): the day is reloaded and the dialog asks again against the
// new mark.

export function AmendStaffMarkDialog({ row, onClose }: { row: StaffDayDto | null; onClose: () => void }) {
  return row?.mark ? <AmendForm key={row.staffId} row={row} onClose={onClose} /> : null;
}

function AmendForm({ row, onClose }: { row: StaffDayDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const noteId = useId();
  const mark = row.mark!;
  const [status, setStatus] = useState<StaffAttendanceStatus>(mark.status);
  const [note, setNote] = useState(mark.note ?? '');
  const amend = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        staffAttendanceApi.POST('/api/v1/staff-attendance/{id}/amend', {
          params: { path: { id: mark.id } },
          body: {
            fromStatus: mark.status,
            status,
            reason,
            ...(note.trim() !== (mark.note ?? '') && { note: note.trim() || null }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(`${row.fullName}'s attendance amended.`);
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.STALE_STATUS) {
        void queryClient.invalidateQueries({ queryKey: attendanceKeys.staffDay });
      }
    },
  });
  const unchanged = status === mark.status && note.trim() === (mark.note ?? '');

  return (
    <ConfirmWithReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Amend ${row.fullName}`}
      description={`Now ${STATUS_LABELS[mark.status]}. The change and its reason are kept with the mark.`}
      confirmLabel="Amend"
      minLength={3}
      pending={amend.isPending}
      confirmDisabled={unchanged}
      onConfirm={(reason) => amend.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">New mark</span>
        <StatusButtons value={status} label={row.fullName} onChange={setStatus} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Input id={noteId} maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {amend.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{attendanceErrorMessage(amend.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
