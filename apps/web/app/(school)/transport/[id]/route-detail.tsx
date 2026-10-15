'use client';

import { addMonths, formatDay, formatRupees, monthLabel, newIdempotencyKey, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { BackLink, EmptyState, ErrorState, LoadingState, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { studentsApi } from '@/lib/api/school-students-contract';
import {
  transportApi,
  type StopInput,
  type TransportAssignmentDto,
  type TransportRouteAmountDto,
  type TransportRouteDetailDto,
} from '@/lib/api/school-transport-contract';
import { useListPage } from '@/lib/hooks';
import { useDefaultYearId } from '../../reports/_lib/reports-ui';
import { SectionSelect } from '../../timetable/_lib/timetable-ui';
import { AssignmentStatusBadge, stopLabel, transportErrorMessage, transportKeys } from '../_lib/transport-ui';
import { VehicleSelect } from '../_lib/vehicle-select';

// One route (contracts/slice-41.md §2.2-§2.5, §3): its name and vehicle, the stops replaced as a
// whole, the monthly amounts (from next month; a future one voided), and the riders — assigned
// from a section list with a stop and a start date, ended with a reason. transport.manage only.

const RIDERS_LIMIT = 25;

export function RouteDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [archiving, setArchiving] = useState(false);
  const route = useQuery({
    queryKey: transportKeys.route(id),
    queryFn: () => unwrap(transportApi.GET('/api/v1/transport-routes/{id}', { params: { path: { id } } })),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: transportKeys.all });
  const archive = useMutation({
    mutationFn: (reason: string) => unwrap(transportApi.POST('/api/v1/transport-routes/{id}/archive', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      toast.success('Route archived.');
      setArchiving(false);
      refresh();
    },
  });

  return (
    <>
      <BackLink href="/transport">Transport</BackLink>
      <QueryStates query={route} notFound={{ title: 'Route not found', description: 'Find it in the routes list.' }}>
        {(data) => {
          const active = data.status === 'active';
          return (
            <>
              <PageHeader
                title={data.name}
                description={
                  data.vehicle
                    ? `${data.vehicle.registration} · ${data.vehicle.capacity} seats · ${data.vehicle.driverName ?? 'no driver'}`
                    : 'No vehicle yet'
                }
                actions={
                  active ? (
                    <Button variant="outline" onClick={() => setArchiving(true)}>
                      Archive route
                    </Button>
                  ) : (
                    <Badge variant="ghost">Archived</Badge>
                  )
                }
              />
              {!active && data.archiveReason && (
                <Alert className="mb-6">
                  <AlertDescription>Archived: {data.archiveReason}. An archived route is read-only.</AlertDescription>
                </Alert>
              )}
              <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
                <div className="grid gap-6">
                  <RidersCard route={data} onChanged={refresh} />
                  <StopsCard key={data.stops.map((s) => `${s.id}:${s.sortOrder}:${s.name}:${s.pickupTime}`).join('|')} route={data} onSaved={refresh} />
                </div>
                <div className="grid gap-6">
                  <DetailsCard key={`${data.name}|${data.vehicle?.id ?? ''}`} route={data} onSaved={refresh} />
                  <AmountsCard route={data} onChanged={refresh} />
                </div>
              </div>
              {archiving && (
                <ConfirmWithReasonDialog
                  open
                  onOpenChange={(next) => !next && setArchiving(false)}
                  title={`Archive ${data.name}`}
                  description="An archived route keeps its history and takes no new riders or amounts. End every rider's assignment first."
                  confirmLabel="Archive"
                  minLength={3}
                  maxLength={500}
                  destructive
                  pending={archive.isPending}
                  onConfirm={(reason) => archive.mutate(reason)}
                >
                  {archive.error && (
                    <Alert variant="destructive">
                      <AlertDescription>{transportErrorMessage(archive.error)}</AlertDescription>
                    </Alert>
                  )}
                </ConfirmWithReasonDialog>
              )}
            </>
          );
        }}
      </QueryStates>
    </>
  );
}

// ------------------------------------------------------------------------------------- details

function DetailsCard({ route, onSaved }: { route: TransportRouteDetailDto; onSaved: () => void }) {
  const nameId = useId();
  const [name, setName] = useState(route.name);
  const [vehicleId, setVehicleId] = useState(route.vehicle?.id ?? '');
  const active = route.status === 'active';
  const changed = name.trim() !== route.name || vehicleId !== (route.vehicle?.id ?? '');
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        transportApi.PATCH('/api/v1/transport-routes/{id}', {
          params: { path: { id: route.id } },
          body: { name: name.trim(), vehicleId: vehicleId || null },
        }),
      ),
    onSuccess: () => {
      toast.success('Route saved.');
      onSaved();
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Route</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed && name.trim()) save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input id={nameId} maxLength={80} value={name} disabled={!active} onChange={(e) => setName(e.target.value)} />
          </div>
          {active ? <VehicleSelect value={vehicleId} onChange={setVehicleId} /> : null}
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>{transportErrorMessage(save.error)}</AlertDescription>
            </Alert>
          )}
          {active && (
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={!changed || !name.trim() || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// --------------------------------------------------------------------------------------- stops

type StopRow = { key: string; id?: string; name: string; pickupTime: string };

function StopsCard({ route, onSaved }: { route: TransportRouteDetailDto; onSaved: () => void }) {
  const active = route.status === 'active';
  const reasonId = useId();
  const [rows, setRows] = useState<StopRow[]>(() => route.stops.map((s) => ({ key: s.id, id: s.id, name: s.name, pickupTime: s.pickupTime ?? '' })));
  const [reason, setReason] = useState('');
  const kept = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
  const removed = route.stops.filter((s) => !kept.has(s.id));
  const dirty =
    removed.length > 0 ||
    rows.length !== route.stops.length ||
    rows.some((r, i) => {
      const s = route.stops[i];
      return !s || r.id !== s.id || r.name.trim() !== s.name || r.pickupTime !== (s.pickupTime ?? '');
    });
  const valid = rows.every((r) => r.name.trim() !== '') && (removed.length === 0 || reason.trim().length >= 3);
  const save = useMutation({
    mutationFn: () => {
      const stops: StopInput[] = rows.map((r, i) => ({
        ...(r.id ? { id: r.id } : {}),
        sortOrder: i + 1,
        name: r.name.trim(),
        ...(r.pickupTime ? { pickupTime: r.pickupTime } : {}),
      }));
      return unwrap(
        transportApi.PATCH('/api/v1/transport-routes/{id}', {
          params: { path: { id: route.id } },
          body: { stops, ...(removed.length > 0 ? { reason: reason.trim() } : {}) },
        }),
      );
    },
    onSuccess: () => {
      toast.success('Stops saved.');
      onSaved();
    },
  });
  const update = (i: number, patch: Partial<StopRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(i, 1);
    if (row) next.splice(i + by, 0, row);
    setRows(next);
  };

  return (
    <Card data-testid="transport.stops">
      <CardHeader>
        <CardTitle className="text-base">Stops</CardTitle>
        <CardDescription>In pickup order. Families see their child&apos;s stop and pickup time.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 && <EmptyState title="No stops yet" description="Add the stops in the order the vehicle reaches them." />}
        {rows.map((row, i) => (
          <div key={row.key} className="grid grid-cols-[2rem_minmax(0,1fr)_7rem_auto] items-center gap-2">
            <span className="text-right text-sm text-muted-foreground tabular-nums">{i + 1}.</span>
            <Input aria-label={`Stop ${i + 1} name`} maxLength={80} value={row.name} disabled={!active} onChange={(e) => update(i, { name: e.target.value })} />
            <Input
              aria-label={`Stop ${i + 1} pickup time`}
              type="time"
              value={row.pickupTime}
              disabled={!active}
              onChange={(e) => update(i, { pickupTime: e.target.value })}
            />
            {active && (
              <div className="flex gap-1">
                <Button type="button" size="icon" variant="ghost" aria-label={`Move stop ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUpIcon />
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label={`Move stop ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDownIcon />
                </Button>
                <Button type="button" size="icon" variant="ghost" aria-label={`Remove stop ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Trash2Icon />
                </Button>
              </div>
            )}
          </div>
        ))}
        {active && (
          <>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={rows.length >= 100}
                onClick={() => setRows([...rows, { key: `new-${Date.now()}-${rows.length}`, name: '', pickupTime: '' }])}
              >
                <PlusIcon />
                Add stop
              </Button>
            </div>
            {removed.length > 0 && (
              <div className="grid gap-1.5">
                <Label htmlFor={reasonId}>Why remove {removed.map((s) => s.name).join(', ')}?</Label>
                <Input id={reasonId} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}
            {save.error && (
              <Alert variant="destructive">
                <AlertDescription>{transportErrorMessage(save.error)}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end">
              <Button size="sm" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Save stops'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------------------------- amounts

function AmountsCard({ route, onChanged }: { route: TransportRouteDetailDto; onChanged: () => void }) {
  const [setting, setSetting] = useState(false);
  const [voiding, setVoiding] = useState<TransportRouteAmountDto | null>(null);
  const active = route.status === 'active';
  const voidAmount = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(transportApi.POST('/api/v1/transport-route-amounts/{id}/void', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      toast.success('Amount voided.');
      setVoiding(null);
      onChanged();
    },
  });
  return (
    <Card data-testid="transport.amounts">
      <CardHeader>
        <CardTitle className="text-base">Monthly amount</CardTitle>
        <CardDescription>
          {route.currentAmount === null ? 'Not set: riders are not charged yet.' : `${formatRupees(route.currentAmount)} a month this month.`} Charged
          with the month&apos;s fees under Transport; a change applies from next month.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {route.amounts.length > 0 && (
          <ul className="grid gap-2 text-sm">
            {route.amounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className={a.voidedAt ? 'text-muted-foreground line-through' : undefined}>
                  {formatRupees(a.amount)} from {monthLabel(a.effectivePeriod)}
                </span>
                {a.voidable && active && (
                  <Button size="sm" variant="ghost" onClick={() => setVoiding(a)}>
                    Void
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {active && (
          <div>
            <Button size="sm" variant="outline" onClick={() => setSetting(true)}>
              Set amount
            </Button>
          </div>
        )}
      </CardContent>
      {setting && (
        <AmountDialog
          route={route}
          onClose={() => setSetting(false)}
          onDone={() => {
            toast.success('Amount set.');
            setSetting(false);
            onChanged();
          }}
        />
      )}
      {voiding && (
        <ConfirmWithReasonDialog
          open
          onOpenChange={(next) => !next && setVoiding(null)}
          title={`Void ${formatRupees(voiding.amount)} from ${monthLabel(voiding.effectivePeriod)}`}
          description="A mistaken amount is voided before its month starts; then set the right one."
          confirmLabel="Void"
          minLength={3}
          maxLength={500}
          destructive
          pending={voidAmount.isPending}
          onConfirm={(reason) => voidAmount.mutate({ id: voiding.id, reason })}
        >
          {voidAmount.error && (
            <Alert variant="destructive">
              <AlertDescription>{transportErrorMessage(voidAmount.error)}</AlertDescription>
            </Alert>
          )}
        </ConfirmWithReasonDialog>
      )}
    </Card>
  );
}

function AmountDialog({ route, onClose, onDone }: { route: TransportRouteDetailDto; onClose: () => void; onDone: () => void }) {
  const ids = { amount: useId(), month: useId() };
  const thisMonth = todayInSchool().slice(0, 7);
  // A route's first price may start this month; any later change from next month (rule 37).
  const earliest = route.currentAmount === null ? thisMonth : addMonths(thisMonth, 1);
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState(earliest);
  const rupees = Number(amount);
  const valid = amount !== '' && Number.isInteger(rupees) && rupees >= 0 && period >= earliest;
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        transportApi.POST('/api/v1/transport-routes/{id}/amounts', {
          params: { path: { id: route.id } },
          body: { amount: rupees, effectivePeriod: period },
        }),
      ),
    onSuccess: onDone,
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
            <DialogTitle>Monthly amount: {route.name}</DialogTitle>
            <DialogDescription>Whole rupees a month, for every rider, from the month chosen.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.amount}>Amount (Rs)</Label>
              <Input id={ids.amount} type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.month}>From month</Label>
              <Input id={ids.month} type="month" min={earliest} value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
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
              {save.isPending ? 'Saving…' : 'Set amount'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------- riders

function RidersCard({ route, onChanged }: { route: TransportRouteDetailDto; onChanged: () => void }) {
  const active = route.status === 'active';
  const [includeEnded, setIncludeEnded] = useState(false);
  const [page, setPage] = useListPage([includeEnded]);
  const [assigning, setAssigning] = useState(false);
  const [ending, setEnding] = useState<TransportAssignmentDto | null>(null);
  const query = { page, limit: RIDERS_LIMIT, includeEnded };
  const riders = useQuery({
    queryKey: transportKeys.riders(route.id, query),
    queryFn: () => unwrap(transportApi.GET('/api/v1/transport-routes/{id}/assignments', { params: { path: { id: route.id }, query } })),
    placeholderData: keepPreviousData,
  });
  const over = route.vehicle !== null && route.riders > route.vehicle.capacity;

  return (
    <Card data-testid="transport.riders">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle className="text-base">Riders</CardTitle>
          <CardDescription className={over ? 'text-destructive' : undefined}>
            {route.riders} riding{route.vehicle ? ` · ${route.vehicle.capacity} seats` : ''}
            {over ? ' · over capacity' : ''}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeEnded} onChange={(e) => setIncludeEnded(e.target.checked)} />
            Show ended
          </label>
          {active && (
            <Button size="sm" onClick={() => setAssigning(true)}>
              Assign students
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {riders.isPending ? (
          <LoadingState rows={3} />
        ) : riders.isError ? (
          <ErrorState error={riders.error} onRetry={() => void riders.refetch()} />
        ) : riders.data.data.length === 0 ? (
          <EmptyState title="Nobody rides this route yet" description="Assign students from their section, with their stop and first day." />
        ) : (
          <div className="grid gap-3">
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Student</TableHead>
                    <TableHead>Stop</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {riders.data.data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="grid gap-0.5">
                          <Link href={`/students/${r.studentId}`} className="font-medium underline-offset-4 hover:underline">
                            {r.studentName}
                          </Link>
                          <span className="text-xs text-muted-foreground">{[r.className, r.sectionName].filter(Boolean).join(' ')}</span>
                        </div>
                      </TableCell>
                      <TableCell>{stopLabel(r.stopName, r.pickupTime)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDay(r.startsOn)}
                        {r.endsOn ? ` – ${formatDay(r.endsOn)}` : ''}
                      </TableCell>
                      <TableCell>
                        <AssignmentStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {r.status !== 'ended' && (
                          <Button size="sm" variant="outline" onClick={() => setEnding(r)}>
                            End
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex gap-2">
              {page > 1 && (
                <Button variant="ghost" onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
              )}
              {riders.data.total > page * RIDERS_LIMIT && (
                <Button variant="outline" onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
      {assigning && <AssignDialog route={route} onClose={() => setAssigning(false)} onDone={onChanged} />}
      {ending && (
        <EndDialog
          assignment={ending}
          onClose={() => setEnding(null)}
          onDone={() => {
            toast.success(`${ending.studentName} no longer rides ${route.name}.`);
            setEnding(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

function EndDialog({ assignment, onClose, onDone }: { assignment: TransportAssignmentDto; onClose: () => void; onDone: () => void }) {
  const dateId = useId();
  const today = todayInSchool();
  const [endedOn, setEndedOn] = useState(today < assignment.startsOn ? assignment.startsOn : today);
  const end = useMutation({
    mutationFn: (reason: string) =>
      unwrap(transportApi.POST('/api/v1/transport-assignments/{id}/end', { params: { path: { id: assignment.id } }, body: { endedOn, reason } })),
    onSuccess: onDone,
  });
  return (
    <ConfirmWithReasonDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={`End ${assignment.studentName}'s transport`}
      description="The month of the last day is still charged in full. To move to another route, end this one and assign the new one from the next day."
      confirmLabel="End"
      minLength={3}
      maxLength={500}
      destructive
      pending={end.isPending}
      confirmDisabled={endedOn === ''}
      onConfirm={(reason) => end.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={dateId}>Last day on the route</Label>
        <Input id={dateId} type="date" value={endedOn} onChange={(e) => setEndedOn(e.target.value)} />
      </div>
      {end.error && (
        <Alert variant="destructive">
          <AlertDescription>{transportErrorMessage(end.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}

type Outcome = { name: string; ok: boolean; message: string };

/** Assign from a section list: each chosen student gets one keyed request; refusals are listed. */
function AssignDialog({ route, onClose, onDone }: { route: TransportRouteDetailDto; onClose: () => void; onDone: () => void }) {
  const ids = { stop: useId(), starts: useId() };
  const yearId = useDefaultYearId('');
  const [sectionId, setSectionId] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [stopId, setStopId] = useState('');
  const [startsOn, setStartsOn] = useState(todayInSchool());
  const [keys] = useState(() => new Map<string, string>());
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const students = useQuery({
    queryKey: ['school', 'students', 'transport-assign', sectionId],
    queryFn: () =>
      unwrap(studentsApi.GET('/api/v1/students', { params: { query: { sectionId, status: 'active', limit: OPTIONS_LIMIT, page: 1 } } })),
    enabled: sectionId !== '',
  });
  const assign = useMutation({
    mutationFn: async () => {
      const rows = (students.data?.data ?? []).filter((s) => chosen.has(s.id));
      const results: Outcome[] = [];
      for (const s of rows) {
        const key = keys.get(s.id) ?? newIdempotencyKey();
        keys.set(s.id, key);
        try {
          const created = await unwrap(
            transportApi.POST('/api/v1/transport-routes/{id}/assignments', {
              params: { path: { id: route.id }, header: { 'Idempotency-Key': key } },
              body: { studentId: s.id, startsOn, ...(stopId ? { stopId } : {}) },
            }),
          );
          const warning = created.capacityWarning;
          results.push({
            name: s.fullName,
            ok: true,
            message: warning ? `Assigned — ${warning.riders} riders for ${warning.capacity} seats` : 'Assigned',
          });
        } catch (error) {
          results.push({ name: s.fullName, ok: false, message: transportErrorMessage(error) });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      setOutcomes(results);
      onDone();
    },
  });
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !assign.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign students: {route.name}</DialogTitle>
          <DialogDescription>
            Each student rides from the first day chosen. Students who join after the 15th are charged from next month.
          </DialogDescription>
        </DialogHeader>
        {outcomes ? (
          <div className="grid gap-3">
            <ul className="grid gap-1 text-sm" data-testid="transport.assign.outcomes">
              {outcomes.map((o) => (
                <li key={o.name} className={o.ok ? undefined : 'text-destructive'}>
                  {o.name}: {o.message}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen.size > 0 && startsOn) assign.mutate();
            }}
          >
            <SectionSelect
              yearId={yearId}
              value={sectionId}
              onChange={(id) => {
                setSectionId(id);
                setChosen(new Set());
              }}
              className="w-full"
            />
            {sectionId !== '' && (
              <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                {students.isPending ? (
                  <LoadingState rows={3} />
                ) : students.isError ? (
                  <ErrorState error={students.error} onRetry={() => void students.refetch()} />
                ) : students.data.data.length === 0 ? (
                  <p className="p-2 text-sm text-muted-foreground">No active students in this section.</p>
                ) : (
                  <ul className="grid gap-1">
                    {students.data.data.map((s) => (
                      <li key={s.id}>
                        <label className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted">
                          <input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} />
                          {s.fullName}
                          <span className="text-xs text-muted-foreground">{s.admissionNo}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={ids.stop}>Stop</Label>
                <NativeSelect id={ids.stop} value={stopId} onChange={(e) => setStopId(e.target.value)}>
                  <option value="">No stop yet</option>
                  {route.stops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {stopLabel(s.name, s.pickupTime)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={ids.starts}>First day</Label>
                <Input id={ids.starts} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={assign.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={chosen.size === 0 || !startsOn || assign.isPending}>
                {assign.isPending ? 'Assigning…' : `Assign ${chosen.size || ''}`.trim()}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
