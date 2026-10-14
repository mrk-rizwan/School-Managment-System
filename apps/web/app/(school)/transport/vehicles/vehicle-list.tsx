'use client';

import { ErrorCode, newIdempotencyKey, VEHICLE_CAPACITY_MAX } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { transportApi, type VehicleDto, type VehicleFilter } from '@/lib/api/school-transport-contract';
import { useListPage } from '@/lib/hooks';
import { useActiveStaff } from '../../timetable/_lib/timetable-ui';
import { TransportTabs, transportErrorMessage, transportKeys } from '../_lib/transport-ui';

// Vehicles (contracts/slice-41.md §2.1): registration, seats and driver. A retired vehicle is
// history; one a route still uses cannot be retired. transport.manage only.

const LIMIT = 25;

export function VehicleList() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<VehicleFilter>('active');
  const [page, setPage] = useListPage([status]);
  const [editing, setEditing] = useState<VehicleDto | 'new' | null>(null);
  const [retiring, setRetiring] = useState<VehicleDto | null>(null);
  const query = { page, limit: LIMIT, status };
  const list = useQuery({
    queryKey: transportKeys.vehicles(query),
    queryFn: () => unwrap(transportApi.GET('/api/v1/vehicles', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: transportKeys.all });
  const retire = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(transportApi.POST('/api/v1/vehicles/{id}/retire', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      toast.success('Vehicle retired.');
      setRetiring(null);
      refresh();
    },
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, VehicleDto>();
    return [
      column.accessor('registration', { header: 'Registration', cell: (info) => <span className="font-medium">{info.getValue()}</span> }),
      column.accessor('capacity', { header: () => <span className="block text-right">Seats</span>, cell: (info) => <span className="block text-right tabular-nums">{info.getValue()}</span> }),
      column.accessor('driverName', { header: 'Driver', cell: (info) => info.getValue() ?? '—' }),
      column.accessor('routeNames', {
        header: 'Routes',
        cell: (info) => <span className="block max-w-48 truncate">{info.getValue().join(', ') || '—'}</span>,
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => <Badge variant={info.getValue() === 'active' ? 'secondary' : 'ghost'}>{info.getValue() === 'active' ? 'In use' : 'Retired'}</Badge>,
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) =>
          info.row.original.status === 'active' ? (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(info.row.original)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRetiring(info.row.original)}>
                Retire
              </Button>
            </div>
          ) : null,
      }),
    ];
  }, []);

  return (
    <>
      <PageHeader
        title="Transport"
        description="School vans and buses, their routes, stops and monthly amounts, and who rides them."
        actions={
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            Add vehicle
          </Button>
        }
      />
      <TransportTabs />
      <section className="grid gap-4" aria-label="Vehicles">
        <div className="flex flex-wrap items-start gap-3">
          <FilterSelect<VehicleFilter> label="Status" value={status} onChange={setStatus}>
            <option value="active">In use</option>
            <option value="retired">Retired</option>
            <option value="all">All</option>
          </FilterSelect>
        </div>
        <DataTable
          columns={columns}
          query={list}
          getRowId={(row) => row.id}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle={status === 'retired' ? 'No retired vehicles' : 'No vehicles yet'}
          emptyDescription="Add the school's vans and buses, then give each route its vehicle."
        />
      </section>
      {editing && (
        <VehicleDialog
          vehicle={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(saved) => {
            toast.success(editing === 'new' ? `Vehicle ${saved.registration} added.` : 'Vehicle saved.');
            setEditing(null);
            refresh();
          }}
        />
      )}
      {retiring && (
        <ConfirmWithReasonDialog
          open
          onOpenChange={(next) => !next && setRetiring(null)}
          title={`Retire ${retiring.registration}`}
          description="A retired vehicle stays in the records and takes no route. A route still using it must change vehicle first."
          confirmLabel="Retire"
          minLength={3}
          maxLength={500}
          destructive
          pending={retire.isPending}
          onConfirm={(reason) => retire.mutate({ id: retiring.id, reason })}
        >
          {retire.error && (
            <Alert variant="destructive">
              <AlertDescription>{transportErrorMessage(retire.error)}</AlertDescription>
            </Alert>
          )}
        </ConfirmWithReasonDialog>
      )}
    </>
  );
}

function VehicleDialog({ vehicle, onClose, onDone }: { vehicle: VehicleDto | null; onClose: () => void; onDone: (v: VehicleDto) => void }) {
  const ids = { reg: useId(), seats: useId(), driver: useId() };
  const staff = useActiveStaff();
  const [registration, setRegistration] = useState(vehicle?.registration ?? '');
  const [capacity, setCapacity] = useState(String(vehicle?.capacity ?? ''));
  const [driver, setDriver] = useState(vehicle?.driverStaffId ?? '');
  // One key per add dialog: a refused submit stores nothing, so the next one may reuse it; a lost
  // answer replays. A key already spent on another body is replaced.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const seats = Number(capacity);
  const valid = registration.trim() !== '' && Number.isInteger(seats) && seats >= 1 && seats <= VEHICLE_CAPACITY_MAX;
  const save = useMutation({
    mutationFn: () =>
      vehicle
        ? unwrap(
            transportApi.PATCH('/api/v1/vehicles/{id}', {
              params: { path: { id: vehicle.id } },
              body: { registration: registration.trim(), capacity: seats, driverStaffId: driver || null },
            }),
          )
        : unwrap(
            transportApi.POST('/api/v1/vehicles', {
              params: { header: { 'Idempotency-Key': idempotencyKey } },
              body: { registration: registration.trim(), capacity: seats, ...(driver ? { driverStaffId: driver } : {}) },
            }),
          ),
    onSuccess: onDone,
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{vehicle ? `Edit ${vehicle.registration}` : 'Add vehicle'}</DialogTitle>
            <DialogDescription>Seats are a guide: assigning more riders warns but is allowed.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.reg}>Registration</Label>
              <Input id={ids.reg} maxLength={20} value={registration} onChange={(e) => setRegistration(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.seats}>Seats</Label>
              <Input id={ids.seats} type="number" inputMode="numeric" min={1} max={VEHICLE_CAPACITY_MAX} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.driver}>Driver (a member of staff)</Label>
            <NativeSelect id={ids.driver} value={driver} disabled={staff.isPending} onChange={(e) => setDriver(e.target.value)}>
              <option value="">No driver</option>
              {(staff.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </NativeSelect>
          </div>
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>{transportErrorMessage(save.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? 'Saving…' : vehicle ? 'Save' : 'Add vehicle'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
