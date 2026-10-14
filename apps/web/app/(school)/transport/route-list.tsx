'use client';

import { ErrorCode, formatRupees, monthLabel, newIdempotencyKey } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { transportApi, type TransportRouteDto, type TransportRouteFilter } from '@/lib/api/school-transport-contract';
import { useListPage } from '@/lib/hooks';
import { routeHref, TransportTabs, transportErrorMessage, transportKeys } from './_lib/transport-ui';
import { VehicleSelect } from './_lib/vehicle-select';

// Transport routes (contracts/slice-41.md §1, §3): each with its vehicle, riders, the amount in
// force this month and the next one set. transport.manage only.

const LIMIT = 25;

export function RouteList() {
  const [status, setStatus] = useState<TransportRouteFilter>('active');
  const [page, setPage] = useListPage([status]);
  const [creating, setCreating] = useState(false);
  const query = { page, limit: LIMIT, status };
  const list = useQuery({
    queryKey: transportKeys.routes(query),
    queryFn: () => unwrap(transportApi.GET('/api/v1/transport-routes', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, TransportRouteDto>();
    return [
      column.accessor('name', {
        header: 'Route',
        cell: (info) => (
          <Link href={routeHref(info.row.original.id)} className="font-medium underline-offset-4 hover:underline">
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('vehicle', {
        header: 'Vehicle',
        cell: (info) => {
          const v = info.getValue();
          return v ? (
            <div className="grid gap-0.5">
              <span>{v.registration}</span>
              <span className="text-xs text-muted-foreground">{v.driverName ?? 'No driver'}</span>
            </div>
          ) : (
            '—'
          );
        },
      }),
      column.accessor('riders', {
        header: () => <span className="block text-right">Riders</span>,
        cell: (info) => {
          const r = info.row.original;
          const over = r.vehicle !== null && r.riders > r.vehicle.capacity;
          return (
            <span className={over ? 'block text-right text-destructive tabular-nums' : 'block text-right tabular-nums'}>
              {r.riders}
              {r.vehicle ? ` / ${r.vehicle.capacity}` : ''}
            </span>
          );
        },
      }),
      column.accessor('stopCount', { header: () => <span className="block text-right">Stops</span>, cell: (info) => <span className="block text-right tabular-nums">{info.getValue()}</span> }),
      column.accessor('currentAmount', {
        header: () => <span className="block text-right">Monthly</span>,
        cell: (info) => {
          const r = info.row.original;
          return (
            <div className="grid gap-0.5 text-right">
              <span className="tabular-nums">{r.currentAmount === null ? 'Not set' : formatRupees(r.currentAmount)}</span>
              {r.nextAmount && (
                <span className="text-xs text-muted-foreground">
                  {formatRupees(r.nextAmount.amount)} from {monthLabel(r.nextAmount.effectivePeriod)}
                </span>
              )}
            </div>
          );
        },
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => <Badge variant={info.getValue() === 'active' ? 'secondary' : 'ghost'}>{info.getValue() === 'active' ? 'Running' : 'Archived'}</Badge>,
      }),
    ];
  }, []);

  return (
    <>
      <PageHeader
        title="Transport"
        description="School vans and buses, their routes, stops and monthly amounts, and who rides them."
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            New route
          </Button>
        }
      />
      <TransportTabs />
      <section className="grid gap-4" aria-label="Routes">
        <div className="flex flex-wrap items-start gap-3">
          <FilterSelect<TransportRouteFilter> label="Status" value={status} onChange={setStatus}>
            <option value="active">Running</option>
            <option value="archived">Archived</option>
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
          emptyTitle={status === 'archived' ? 'No archived routes' : 'No routes yet'}
          emptyDescription="Create a route, add its stops and its monthly amount, then assign the students who ride it."
        />
      </section>
      {creating && <NewRouteDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NewRouteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const nameId = useId();
  const [name, setName] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  // One key per dialog, as the vehicle dialog: replaced only when spent on another body.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        transportApi.POST('/api/v1/transport-routes', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { name: name.trim(), ...(vehicleId ? { vehicleId } : {}) },
        }),
      ),
    onSuccess: (route) => {
      void queryClient.invalidateQueries({ queryKey: transportKeys.all });
      router.push(routeHref(route.id));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
    },
  });
  return (
    <Dialog open onOpenChange={(next) => !next && !create.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New route</DialogTitle>
            <DialogDescription>Add the stops and the monthly amount on the next page.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input id={nameId} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Model Town morning" />
          </div>
          <VehicleSelect value={vehicleId} onChange={setVehicleId} />
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription>{transportErrorMessage(create.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create route'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
