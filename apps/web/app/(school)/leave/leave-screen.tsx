'use client';

import { Capability, formatDay, newIdempotencyKey, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { OptionalReasonField, readReason } from '@/components/issue-login-dialog';
import { FilterSelect } from '@/components/list-filters';
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
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError, refusalMessage } from '@/lib/api/errors';
import {
  leaveApi,
  type LeaveRequestDto,
  type LeaveRequestListQuery,
  type LeaveStatus,
  type LeaveTypeDto,
} from '@/lib/api/school-leave-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import {
  LEAVE_CODE_LABELS,
  LEAVE_REFUSALS,
  LeaveStatusBadge,
  leaveKeys,
  leavePeriod,
  workingDaysLabel,
} from './_lib/leave-ui';

const LIMIT = 25;

/**
 * Staff leave for approvers (slice 24, R210-R212, R248): the queue, decisions with the cover
 * picker, end early and leave recorded on behalf; leave types for settings managers.
 */
export function LeaveScreen() {
  const { can } = useCapabilities();
  const canDecide = can(Capability.STAFF_LEAVE_APPROVE);
  const canManageTypes = can(Capability.SCHOOL_SETTINGS_MANAGE);
  return (
    <>
      <PageHeader
        title="Staff leave"
        description="Requests waiting for a decision, and the leave the school offers. Nobody decides their own leave."
      />
      {canDecide && <LeaveRequestsSection />}
      {canManageTypes && <LeaveTypesSection />}
    </>
  );
}

// ---- The approvers' queue ----

function LeaveRequestsSection() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LeaveStatus | ''>('pending');
  const [page, setPage] = useListPage([status]);
  const [approving, setApproving] = useState<LeaveRequestDto | null>(null);
  const [rejecting, setRejecting] = useState<LeaveRequestDto | null>(null);
  const [ending, setEnding] = useState<LeaveRequestDto | null>(null);
  const [recording, setRecording] = useState(false);
  const [endedOn, setEndedOn] = useState('');
  const dateId = useId();

  const query: LeaveRequestListQuery = {
    page,
    limit: LIMIT,
    sort: status === 'pending' ? 'startsOn' : '-requestedAt',
    ...(status && { status }),
  };
  const requests = useQuery({
    queryKey: [...leaveKeys.requests, query],
    queryFn: () => unwrap(leaveApi.GET('/api/v1/leave-requests', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const done = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
  };
  const failed = (error: unknown) => {
    toast.error(refusalMessage(error, LEAVE_REFUSALS));
    if (error instanceof ApiError && error.status === 409) void queryClient.invalidateQueries({ queryKey: leaveKeys.requests });
  };

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(leaveApi.POST('/api/v1/leave-requests/{id}/reject', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      setRejecting(null);
      done('Leave rejected.');
    },
    onError: failed,
  });
  const endEarly = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(
        leaveApi.POST('/api/v1/leave-requests/{id}/end-early', { params: { path: { id } }, body: { endedOn, reason } }),
      ),
    onSuccess: (row) => {
      setEnding(null);
      // A past end date cannot backdate the cover: it ended yesterday instead (coverEndedOn).
      done(
        row.coverEndedOn === null
          ? 'Leave ended early.'
          : row.coverEndedOn === row.endedEarlyOn
            ? 'Leave ended early. Its cover ends the same day.'
            : `Leave ended early. Its cover ended on ${formatDay(row.coverEndedOn)}.`,
      );
    },
    onError: failed,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, LeaveRequestDto>();
    return [
      column.accessor('staffName', {
        header: 'Staff',
        cell: (info) => (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.onBehalf && <Badge variant="ghost">Recorded for them</Badge>}
            {info.row.original.selfApproved && <Badge variant="ghost">Self-approved</Badge>}
          </span>
        ),
      }),
      column.display({ id: 'type', header: 'Type', cell: (info) => info.row.original.leaveType.name }),
      column.display({
        id: 'dates',
        header: 'Dates',
        cell: (info) => (
          <span>
            {leavePeriod(info.row.original)}
            <span className="block text-xs text-muted-foreground">{workingDaysLabel(info.row.original.workingDays)}</span>
          </span>
        ),
      }),
      column.accessor('reason', { header: 'Reason', cell: (info) => <span className="line-clamp-2">{info.getValue()}</span> }),
      column.accessor('status', { header: 'Status', cell: (info) => <LeaveStatusBadge status={info.getValue()} /> }),
      column.display({
        id: 'cover',
        header: 'Needs cover',
        cell: (info) =>
          info.row.original.sectionsNeedingCover.length === 0
            ? '—'
            : info.row.original.sectionsNeedingCover.map((s) => s.name).join(', '),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const row = info.row.original;
          const actions: RowAction[] =
            row.status === 'pending'
              ? [
                  { label: 'Approve', onSelect: () => setApproving(row) },
                  { label: 'Reject', onSelect: () => setRejecting(row), destructive: true },
                ]
              : row.status === 'approved'
                ? [
                    {
                      label: 'End early',
                      onSelect: () => {
                        setEndedOn(todayInSchool() < row.endsOn ? todayInSchool() : row.startsOn);
                        setEnding(row);
                      },
                    },
                  ]
                : [];
          return <RowActions label={row.staffName} actions={actions} />;
        },
      }),
    ];
  }, []);

  return (
    <section className="mb-10 grid gap-4" aria-label="Leave requests">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterSelect<LeaveStatus | ''> label="Status" value={status} onChange={setStatus}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="ended_early">Ended early</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </FilterSelect>
        <Button onClick={() => setRecording(true)}>
          <PlusIcon />
          Record leave for someone
        </Button>
      </div>
      <DataTable
        columns={columns}
        query={requests}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={status === 'pending' ? 'Nothing waiting' : 'No requests'}
        emptyDescription="Leave requests from staff appear here."
      />
      {approving && <ApproveDialog request={approving} onClose={() => setApproving(null)} onDone={done} onError={failed} />}
      {recording && <RecordLeaveDialog onClose={() => setRecording(false)} onDone={done} />}
      <ConfirmWithReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={`Reject leave: ${rejecting?.staffName ?? ''}`}
        description="The staff member is told. The reason is recorded."
        confirmLabel="Reject"
        minLength={3}
        destructive
        pending={reject.isPending}
        onConfirm={(reason) => rejecting && reject.mutate({ id: rejecting.id, reason })}
      />
      <ConfirmWithReasonDialog
        open={ending !== null}
        onOpenChange={(open) => !open && setEnding(null)}
        title={`End leave early: ${ending?.staffName ?? ''}`}
        description="The last day of leave taken. The later days are freed and the cover ends that day."
        confirmLabel="End early"
        minLength={3}
        pending={endEarly.isPending}
        confirmDisabled={endedOn === ''}
        onConfirm={(reason) => ending && endEarly.mutate({ id: ending.id, reason })}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={dateId}>Last day of leave</Label>
          <Input
            id={dateId}
            type="date"
            value={endedOn}
            min={ending?.startsOn}
            max={ending?.endsOn}
            onChange={(event) => setEndedOn(event.target.value)}
          />
        </div>
      </ConfirmWithReasonDialog>
    </section>
  );
}

type StaffOption = { id: string; fullName: string };

/** Active teachers, for the cover picker and the on-behalf form (first 50 by name). */
function useStaffOptions(role?: 'teacher') {
  return useQuery({
    queryKey: ['school', 'staff', 'options', role ?? 'all'],
    queryFn: () =>
      unwrap(
        leaveApi.GET('/api/v1/staff', {
          params: { query: { status: 'active', limit: 50, sort: 'fullName', ...(role && { role }) } },
        }),
      ),
    select: (page): StaffOption[] => page.data.map((s) => ({ id: s.id, fullName: s.fullName })),
  });
}

function ApproveDialog({
  request,
  onClose,
  onDone,
  onError,
}: {
  request: LeaveRequestDto;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const { can } = useCapabilities();
  // A cover is a teacher assignment: the API refuses it without class.manage.
  const canCover = can(Capability.CLASS_MANAGE);
  const needing = canCover ? request.sectionsNeedingCover : [];
  const [sectionId, setSectionId] = useState(needing[0]?.sectionId ?? '');
  const [coverStaffId, setCoverStaffId] = useState('');
  const [reasonText, setReasonText] = useState('');
  const teachers = useStaffOptions('teacher');
  const sectionField = useId();
  const staffField = useId();
  const { reason, ok } = readReason(reasonText);
  const wantsCover = sectionId !== '' && coverStaffId !== '';

  const approve = useMutation({
    mutationFn: () =>
      unwrap(
        leaveApi.POST('/api/v1/leave-requests/{id}/approve', {
          params: { path: { id: request.id } },
          body: { ...(reason && { reason }), ...(wantsCover && { cover: { sectionId, coverStaffId } }) },
        }),
      ),
    onSuccess: () => {
      onClose();
      onDone(wantsCover ? 'Leave approved and cover assigned.' : 'Leave approved.');
    },
    onError,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !approve.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ok) approve.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Approve leave: {request.staffName}</DialogTitle>
            <DialogDescription>
              {request.leaveType.name}, {leavePeriod(request)} ({workingDaysLabel(request.workingDays)}). The staff member is
              told.
            </DialogDescription>
          </DialogHeader>
          {needing.length > 0 && (
            <div className="grid gap-3 rounded-md border p-3">
              <p className="text-sm">
                {request.staffName} is class teacher of {needing.map((s) => s.name).join(', ')} during this leave. Choose who
                marks the register.
              </p>
              <div className="grid gap-1.5">
                <Label htmlFor={sectionField}>Section</Label>
                <NativeSelect id={sectionField} value={sectionId} onChange={(event) => setSectionId(event.target.value)}>
                  {needing.map((s) => (
                    <option key={s.sectionId} value={s.sectionId}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={staffField}>Covering teacher</Label>
                <NativeSelect id={staffField} value={coverStaffId} onChange={(event) => setCoverStaffId(event.target.value)}>
                  <option value="">No cover now</option>
                  {(teachers.data ?? [])
                    .filter((t) => t.id !== request.staffId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.fullName}
                      </option>
                    ))}
                </NativeSelect>
              </div>
            </div>
          )}
          {!canCover && request.sectionsNeedingCover.length > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="cover-not-allowed">
              {request.staffName} is class teacher of {request.sectionsNeedingCover.map((s) => s.name).join(', ')} during this
              leave. Assigning a cover needs permission to manage classes: ask someone who can.
            </p>
          )}
          <OptionalReasonField value={reasonText} onChange={setReasonText} disabled={approve.isPending} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={approve.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok || approve.isPending}>
              {approve.isPending ? 'Working…' : 'Approve'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Leave recorded by an approver for a staff member (R210): it stays pending until decided. */
function RecordLeaveDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const staff = useStaffOptions();
  const types = useActiveTypes();
  const [key] = useState(newIdempotencyKey);
  const today = todayInSchool();
  const [form, setForm] = useState({ staffId: '', leaveTypeId: '', startsOn: today, endsOn: today, reason: '' });
  const [error, setError] = useState<string | null>(null);
  const ids = { staff: useId(), type: useId(), from: useId(), to: useId(), reason: useId() };
  const complete = form.staffId !== '' && form.leaveTypeId !== '' && form.reason.trim().length >= 3 && form.endsOn >= form.startsOn;

  const record = useMutation({
    mutationFn: () =>
      unwrap(
        leaveApi.POST('/api/v1/leave-requests', {
          params: { header: { 'Idempotency-Key': key } },
          body: { ...form, reason: form.reason.trim() },
        }),
      ),
    onSuccess: () => {
      onClose();
      onDone('Leave recorded. It waits for a decision.');
    },
    onError: (e) => setError(refusalMessage(e, LEAVE_REFUSALS)),
  });

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  return (
    <Dialog open onOpenChange={(open) => !open && !record.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) record.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Record leave for someone</DialogTitle>
            <DialogDescription>For a staff member who phoned in. It still needs a decision.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.staff}>Staff member</Label>
            <NativeSelect id={ids.staff} value={form.staffId} onChange={(e) => set({ staffId: e.target.value })}>
              <option value="">Choose…</option>
              {(staff.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.type}>Type</Label>
            <NativeSelect id={ids.type} value={form.leaveTypeId} onChange={(e) => set({ leaveTypeId: e.target.value })}>
              <option value="">Choose…</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.from}>First day</Label>
              <Input id={ids.from} type="date" value={form.startsOn} onChange={(e) => set({ startsOn: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.to}>Last day</Label>
              <Input id={ids.to} type="date" value={form.endsOn} min={form.startsOn} onChange={(e) => set({ endsOn: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.reason}>Reason</Label>
            <Textarea id={ids.reason} rows={2} maxLength={500} value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={record.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!complete || record.isPending}>
              {record.isPending ? 'Working…' : 'Record leave'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Leave types ----

export function useActiveTypes() {
  return useQuery({
    queryKey: [...leaveKeys.types, 'active'],
    queryFn: () => unwrap(leaveApi.GET('/api/v1/leave-types', { params: { query: { status: 'active', limit: 50 } } })),
    select: (page): LeaveTypeDto[] => page.data,
  });
}

function LeaveTypesSection() {
  const queryClient = useQueryClient();
  const [page, setPage] = useListPage([]);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<LeaveTypeDto | null>(null);
  const types = useQuery({
    queryKey: [...leaveKeys.types, 'list', page],
    queryFn: () => unwrap(leaveApi.GET('/api/v1/leave-types', { params: { query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const archive = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(leaveApi.POST('/api/v1/leave-types/{id}/archive', { params: { path: { id } }, body: { reason } })),
    onSuccess: (type) => {
      toast.success(`${type.name} archived.`);
      setArchiving(null);
      void queryClient.invalidateQueries({ queryKey: leaveKeys.types });
    },
    onError: (error) => toast.error(refusalMessage(error, LEAVE_REFUSALS)),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, LeaveTypeDto>();
    return [
      column.accessor('name', {
        header: 'Leave type',
        cell: (info) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.status === 'archived' && <Badge variant="ghost">Archived</Badge>}
          </span>
        ),
      }),
      column.accessor('code', { header: 'Kind', cell: (info) => LEAVE_CODE_LABELS[info.getValue()] }),
      column.accessor('daysPerYear', {
        header: 'Days a year',
        cell: (info) => info.getValue() ?? 'No limit',
      }),
      column.accessor('paid', { header: 'Paid', cell: (info) => (info.getValue() ? 'Yes' : 'No') }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const type = info.row.original;
          const actions: RowAction[] =
            type.status === 'active' ? [{ label: 'Archive', onSelect: () => setArchiving(type), destructive: true }] : [];
          return <RowActions label={type.name} actions={actions} />;
        },
      }),
    ];
  }, []);

  return (
    <section className="grid gap-4" aria-label="Leave types">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Leave types</h2>
          <p className="text-sm text-muted-foreground">
            The entitlement is per calendar year, pro-rated for someone who joined during it. A type cannot be edited: archive it
            and add another.
          </p>
        </div>
        <Button variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon />
          New leave type
        </Button>
      </div>
      <DataTable
        columns={columns}
        query={types}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No leave types"
      />
      {creating && <LeaveTypeDialog onClose={() => setCreating(false)} />}
      <ConfirmWithReasonDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive leave type: ${archiving?.name ?? ''}`}
        description="Requests already made keep it; nobody can request it any more. Archiving cannot be undone."
        confirmLabel="Archive"
        minLength={3}
        destructive
        pending={archive.isPending}
        onConfirm={(reason) => archiving && archive.mutate({ id: archiving.id, reason })}
      />
    </section>
  );
}

function LeaveTypeDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [code, setCode] = useState<LeaveTypeDto['code']>('other');
  const [days, setDays] = useState('');
  const [paid, setPaid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), code: useId(), days: useId(), paid: useId() };
  const daysValue = days.trim() === '' ? undefined : Number(days);
  const valid = name.trim().length >= 1 && (daysValue === undefined || (Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 366));

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        leaveApi.POST('/api/v1/leave-types', {
          body: { name: name.trim(), code, paid: code === 'unpaid' ? false : paid, ...(daysValue !== undefined && { daysPerYear: daysValue }) },
        }),
      ),
    onSuccess: (type) => {
      toast.success(`${type.name} added.`);
      void queryClient.invalidateQueries({ queryKey: leaveKeys.types });
      onClose();
    },
    onError: (e) => setError(refusalMessage(e, LEAVE_REFUSALS)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New leave type</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.name}>Name</Label>
            <Input id={ids.name} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.code}>Kind</Label>
            <NativeSelect id={ids.code} value={code} onChange={(e) => setCode(e.target.value as LeaveTypeDto['code'])}>
              {Object.entries(LEAVE_CODE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.days}>Days a year (blank for no limit)</Label>
            <Input id={ids.days} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor={ids.paid}>
            <input
              id={ids.paid}
              type="checkbox"
              checked={code !== 'unpaid' && paid}
              disabled={code === 'unpaid'}
              onChange={(e) => setPaid(e.target.checked)}
            />
            Paid leave
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? 'Working…' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
