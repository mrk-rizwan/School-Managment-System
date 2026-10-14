'use client';

import {
  DISPUTE_STATUS_LABELS,
  ErrorCode,
  STAFF_ATTENDANCE_STATUSES,
  newIdempotencyKey,
  type StaffAttendanceStatus,
} from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { QueryStates } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import {
  staffAttendanceApi,
  type MyStaffAttendanceDayDto,
} from '@/lib/api/school-staff-attendance-contract';
import { formatDateTime, formatDay } from '@/lib/format';
import { STATUS_LABELS, attendanceKeys } from '../attendance/_lib/attendance-ui';
import { StaffAttendanceMonth } from '../staff-attendance/_lib/staff-attendance-month';

// contracts/slice-12.md §4.4, R135: every staff member reads their own record, read-only.
// Phase 5 slice 44 (contracts/slice-44.md §2.5, R346): a mark they think is wrong can be disputed
// with a reason; a colleague who manages staff attendance decides. Online only.

const myDisputesKey = [...attendanceKeys.mine, 'disputes'] as const;

const REFUSALS: RefusalMessages = {
  [ErrorCode.ATTENDANCE_DISPUTE_PENDING_EXISTS]: 'This day already has a dispute waiting for a decision.',
  [ErrorCode.ATTENDANCE_DISPUTE_NOT_PENDING]: 'This dispute was already decided.',
};

export function MyAttendance() {
  const [disputing, setDisputing] = useState<MyStaffAttendanceDayDto | null>(null);
  return (
    <>
      <PageHeader
        title="My attendance"
        description="Your attendance as the office or the biometric device recorded it. If a day is wrong, dispute it."
      />
      <StaffAttendanceMonth source={{ kind: 'me' }} onDispute={setDisputing} />
      <MyDisputes />
      {disputing && <RaiseDisputeDialog key={disputing.date} day={disputing} onClose={() => setDisputing(null)} />}
    </>
  );
}

function RaiseDisputeDialog({ day, onClose }: { day: MyStaffAttendanceDayDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  // One key per opening of the dialog: a retried send replays instead of raising twice.
  const [key] = useState(newIdempotencyKey);
  const choices = STAFF_ATTENDANCE_STATUSES.filter((s) => s !== day.status);
  const [requested, setRequested] = useState<StaffAttendanceStatus>(choices[0] ?? 'present');
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const raise = useMutation({
    mutationFn: () =>
      unwrap(
        staffAttendanceApi.POST('/api/v1/me/staff/attendance-disputes', {
          params: { header: { 'Idempotency-Key': key } },
          body: { attendanceId: day.markId!, requestedStatus: requested, reason: trimmed },
        }),
      ),
    onSuccess: () => {
      toast.success('Dispute sent. You will be told the decision.');
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.mine });
      onClose();
    },
    onError: (error) => toast.error(refusalMessage(error, REFUSALS)),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && !raise.isPending && onClose()}>
      <DialogContent showCloseButton={!raise.isPending}>
        <DialogHeader>
          <DialogTitle>Dispute {formatDay(day.date)}</DialogTitle>
          <DialogDescription>
            It says {STATUS_LABELS[day.status!]}. Say what it should say and why; a colleague decides.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="dispute-status">It should say</Label>
            <NativeSelect id="dispute-status" value={requested} onChange={(e) => setRequested(e.target.value as StaffAttendanceStatus)}>
              {choices.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dispute-reason">Reason</Label>
            <Textarea id="dispute-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <p className="text-xs text-muted-foreground">At least 3 characters. Do not write an identity number.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={raise.isPending}>
            Cancel
          </Button>
          <Button onClick={() => raise.mutate()} disabled={raise.isPending || trimmed.length < 3}>
            {raise.isPending ? 'Sending…' : 'Send dispute'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MyDisputes() {
  const queryClient = useQueryClient();
  const query = { page: 1, limit: 10 } as const;
  const disputes = useQuery({
    queryKey: [...myDisputesKey, query],
    queryFn: () => unwrap(staffAttendanceApi.GET('/api/v1/me/staff/attendance-disputes', { params: { query } })),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) =>
      unwrap(staffAttendanceApi.POST('/api/v1/me/staff/attendance-disputes/{id}/withdraw', { params: { path: { id } } })),
    onSuccess: () => {
      toast.success('Dispute withdrawn.');
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.mine });
    },
    onError: (error) => toast.error(refusalMessage(error, REFUSALS)),
  });
  return (
    <Card className="mt-6" data-testid="my-disputes">
      <CardHeader>
        <CardTitle>My disputes</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryStates query={disputes} loadingRows={3}>
          {(page) =>
            page.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">You have not disputed any day.</p>
            ) : (
              <ul className="divide-y text-sm">
                {page.data.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 py-2" data-dispute={d.id}>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">
                        {formatDay(d.date)}: {STATUS_LABELS[d.markStatus]} → {STATUS_LABELS[d.requestedStatus]}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Sent {formatDateTime(d.createdAt)}
                        {d.decidedByName && ` · decided by ${d.decidedByName}`}
                        {d.decisionReason && `: “${d.decisionReason}”`}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant={d.status === 'pending' ? 'default' : 'outline'}>{DISPUTE_STATUS_LABELS[d.status]}</Badge>
                      {d.status === 'pending' && (
                        <Button variant="outline" size="sm" disabled={withdraw.isPending} onClick={() => withdraw.mutate(d.id)}>
                          Withdraw
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryStates>
      </CardContent>
    </Card>
  );
}
