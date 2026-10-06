'use client';

import { Capability, formatDay, formatRupees, newIdempotencyKey, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingState } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { refusalMessage } from '@/lib/api/errors';
import { payrollApi, type SalaryComponentKind, type SalaryStructureDto } from '@/lib/api/school-payroll-contract';
import type { StaffDto } from '@/lib/api/school-staff-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { PAYROLL_REFUSALS, payrollKeys } from '../../payroll/_lib/payroll-ui';

// A staff member's salary (phase-3-financial.md slice 25, R213): the structure in force and its
// history, and a new structure from a date (staff.contract.manage; never one's own, except the
// sole principal's, which the API decides).

const LIMIT = 10;

export function SalaryTab({ staff }: { staff: StaffDto }) {
  const { can } = useCapabilities();
  const queryClient = useQueryClient();
  const [page, setPage] = useListPage([]);
  const [editing, setEditing] = useState(false);
  const history = useQuery({
    queryKey: [...payrollKeys.structures(staff.id), page],
    queryFn: () =>
      unwrap(payrollApi.GET('/api/v1/staff/{id}/salary-structure', { params: { path: { id: staff.id }, query: { page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });
  const latest = history.data?.data.find((s) => s.status === 'active');

  return (
    <div className="grid gap-4">
      {can(Capability.STAFF_CONTRACT_MANAGE) && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing(true)}>{latest ? 'Change salary' : 'Set salary'}</Button>
        </div>
      )}
      {history.isPending ? (
        <LoadingState rows={3} />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : history.data.data.length === 0 ? (
        <EmptyState title="No salary recorded" description="Without a salary this person is skipped by the payroll run." />
      ) : (
        <>
          {history.data.data.map((s) => (
            <StructureCard key={s.id} structure={s} />
          ))}
          <div className="flex gap-2">
            {page > 1 && (
              <Button variant="ghost" onClick={() => setPage(page - 1)}>
                Newer
              </Button>
            )}
            {history.data.total > page * LIMIT && (
              <Button variant="outline" onClick={() => setPage(page + 1)}>
                Older
              </Button>
            )}
          </div>
        </>
      )}
      {editing && (
        <StructureDialog
          staff={staff}
          latest={latest ?? null}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            toast.success('Salary saved.');
            void queryClient.invalidateQueries({ queryKey: payrollKeys.structures(staff.id) });
          }}
        />
      )}
    </div>
  );
}

function StructureCard({ structure: s }: { structure: SalaryStructureDto }) {
  const range = s.endedOn ? `${formatDay(s.effectiveFrom)} – ${formatDay(s.endedOn)}` : `From ${formatDay(s.effectiveFrom)}`;
  return (
    <Card className={s.status === 'superseded' ? 'opacity-60' : undefined}>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">{range}</CardTitle>
        <div className="flex gap-2">
          {s.status === 'superseded' && <Badge variant="ghost">Replaced the same day</Badge>}
          {s.selfApproved && <Badge variant="outline">Self-approved</Badge>}
        </div>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm">
        <div className="flex justify-between">
          <span>Basic</span>
          <span className="tabular-nums">{formatRupees(s.basic)}</span>
        </div>
        {s.components.map((c) => (
          <div key={`${c.kind}-${c.name}`} className="flex justify-between text-muted-foreground">
            <span>
              {c.name} ({c.kind})
            </span>
            <span className="tabular-nums">{c.kind === 'deduction' ? `-${formatRupees(c.amount)}` : formatRupees(c.amount)}</span>
          </div>
        ))}
        <p className="mt-1 text-xs text-muted-foreground">{s.reason}</p>
      </CardContent>
    </Card>
  );
}

type Row = { kind: SalaryComponentKind; name: string; amount: string };

function StructureDialog({
  staff,
  latest,
  onClose,
  onDone,
}: {
  staff: StaffDto;
  latest: SalaryStructureDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [key] = useState(newIdempotencyKey);
  const [basic, setBasic] = useState(latest ? String(latest.basic) : '');
  const [rows, setRows] = useState<Row[]>(latest ? latest.components.map((c) => ({ ...c, amount: String(c.amount) })) : []);
  const [effectiveFrom, setEffectiveFrom] = useState(todayInSchool());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = { basic: useId(), from: useId(), reason: useId() };
  const valid = basic !== '' && reason.trim().length >= 3 && rows.every((r) => r.name.trim() !== '' && Number(r.amount) > 0);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        payrollApi.POST('/api/v1/staff/{id}/salary-structure', {
          params: { path: { id: staff.id }, header: { 'Idempotency-Key': key } },
          body: {
            basic: Number(basic),
            components: rows.map((r) => ({ kind: r.kind, name: r.name.trim(), amount: Number(r.amount) })),
            effectiveFrom,
            reason: reason.trim(),
          },
        }),
      ),
    onSuccess: onDone,
    onError: (e) => setError(refusalMessage(e, PAYROLL_REFUSALS)),
  });
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Salary for {staff.fullName}</DialogTitle>
            <DialogDescription>
              {latest
                ? `Replaces the salary from ${formatDay(latest.effectiveFrom)}: on the same day it is replaced, from a later day it ends the day before. Deductions are taken in the order listed.`
                : 'Basic pay plus named allowances, minus named deductions taken in the order listed.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.basic}>Basic (Rs a month)</Label>
              <Input id={ids.basic} inputMode="numeric" value={basic} onChange={(e) => setBasic(e.target.value.replace(/\D/g, ''))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.from}>Effective from</Label>
              <Input id={ids.from} type="date" min={latest?.effectiveFrom} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Allowances and deductions</legend>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[7.5rem_1fr_7rem_auto] gap-2">
                <NativeSelect aria-label="Kind" value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as SalaryComponentKind })}>
                  <option value="allowance">Allowance</option>
                  <option value="deduction">Deduction</option>
                </NativeSelect>
                <Input aria-label="Name" maxLength={60} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
                <Input aria-label="Amount" inputMode="numeric" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value.replace(/\D/g, '') })} />
                <Button type="button" variant="ghost" size="icon" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            {rows.length < 20 && (
              <Button type="button" variant="outline" className="justify-self-start" onClick={() => setRows([...rows, { kind: 'allowance', name: '', amount: '' }])}>
                <PlusIcon />
                Add a line
              </Button>
            )}
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.reason}>Reason</Label>
            <Input id={ids.reason} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save salary'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
