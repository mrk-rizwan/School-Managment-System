'use client';

import { Capability, formatRupees } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { SendIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import {
  reportsApi,
  type DefaulterDto,
  type DefaulterSort,
  type DefaultersQuery,
  type ReminderKind,
  type RemindersSentDto,
} from '@/lib/api/school-reports-contract';
import { formatDate } from '@/lib/format';
import { useDebounced, useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { useClasses } from '../../academics/_lib/options';
import { digitsOnly } from '../../fees/_lib/fees-ui';
import { CONTACT_CAPABILITY_LABELS } from '../../guardians/_lib/guardians-ui';
import { plural, reportsKeys, useDefaultYearId } from '../_lib/reports-ui';

const LIMIT = 25;
/** The API's cap on `studentIds` in one reminder send. */
const MAX_SELECTED = 50;

const SORT_LABELS: Record<DefaulterSort, string> = {
  '-outstanding': 'Owes most',
  '-oldestDueOn': 'Owed longest',
  oldestDueOn: 'Owed most recently',
  studentName: 'Student name',
  className: 'Class',
};

/** "3 families reminded; 4 SMS; 1 without SMS (allowance used up)". */
export function remindersSummary(sent: RemindersSentDto): string {
  const families = `${sent.families} ${sent.families === 1 ? 'family' : 'families'} reminded`;
  const sms = `${sent.smsUnits} SMS`;
  return sent.capped > 0 ? `${families}; ${sms}; ${sent.capped} without SMS (allowance used up)` : `${families}; ${sms}`;
}

/**
 * Defaulters (slice 22): every student who owes, the most owed first, with the fee payer and how
 * they can be reached, their last payment and reminder, and a deposit slip waiting to be checked.
 * Holders of charge.campaign.send pick students and send their families a reminder.
 */
export function DefaultersReport() {
  const { can } = useCapabilities();
  const canSend = can(Capability.CHARGE_CAMPAIGN_SEND);
  const ids = { overdue: useId(), min: useId() };
  const academicYearId = useDefaultYearId('');
  const classes = useClasses(academicYearId);
  const [classId, setClassId] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [minOutstanding, setMinOutstanding] = useState('');
  const [sort, setSort] = useState<DefaulterSort>('-outstanding');
  const min = useDebounced(minOutstanding);
  const [page, setPage] = useListPage([classId, overdueOnly, min, sort]);
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  const [sending, setSending] = useState(false);

  const query: DefaultersQuery = {
    page,
    limit: LIMIT,
    sort,
    ...(classId && { classId }),
    ...(overdueOnly && { overdueOnly: true }),
    ...(min !== '' && { minOutstanding: Number(min) }),
  };
  const defaulters = useQuery({
    queryKey: reportsKeys.report('defaulters', query),
    queryFn: () => unwrap(reportsApi.GET('/api/v1/finance-reports/defaulters', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const rows = defaulters.data?.data;

  const columns = useMemo(() => {
    const toggle = (row: DefaulterDto, on: boolean) =>
      setSelected((current) => {
        const next = new Map(current);
        if (on && next.size < MAX_SELECTED) next.set(row.studentId, row.studentName);
        else if (!on) next.delete(row.studentId);
        return next;
      });
    const column = createColumnHelper<DataTableFeatures, DefaulterDto>();
    return [
      ...(canSend
        ? [
            column.display({
              id: 'select',
              header: () => {
                const onPage = rows ?? [];
                const all = onPage.length > 0 && onPage.every((r) => selected.has(r.studentId));
                return (
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    aria-label="Select every student on this page"
                    checked={all}
                    onChange={(e) => onPage.forEach((r) => toggle(r, e.target.checked))}
                  />
                );
              },
              cell: (info) => {
                const row = info.row.original;
                const checked = selected.has(row.studentId);
                return (
                  <input
                    type="checkbox"
                    className="size-4 accent-primary disabled:opacity-50"
                    aria-label={`Select ${row.studentName}`}
                    checked={checked}
                    disabled={!checked && selected.size >= MAX_SELECTED}
                    onChange={(e) => toggle(row, e.target.checked)}
                  />
                );
              },
            }),
          ]
        : []),
      column.accessor('studentName', {
        header: 'Student',
        cell: (info) => (
          <span className="flex flex-col">
            <Link href={`/students/${info.row.original.studentId}`} className="font-medium hover:underline">
              {info.getValue()}
            </Link>
            <span className="text-xs text-muted-foreground">
              {[info.row.original.className, info.row.original.sectionName].filter(Boolean).join(' ') || 'Not enrolled'}
            </span>
          </span>
        ),
      }),
      column.accessor('outstanding', {
        header: () => <span className="block text-right">Owes</span>,
        cell: (info) => (
          <span className="block text-right tabular-nums">
            <span className="font-medium">{formatRupees(info.getValue())}</span>
            {info.row.original.overdue > 0 && (
              <span className="block text-xs text-destructive">overdue {formatRupees(info.row.original.overdue)}</span>
            )}
          </span>
        ),
      }),
      column.accessor('oldestDueOn', {
        header: 'Oldest due',
        cell: (info) => (
          <span className="flex flex-col">
            <span>{formatDate(info.getValue())}</span>
            <span className="text-xs text-muted-foreground">{plural(info.row.original.openCharges, 'open charge')}</span>
          </span>
        ),
      }),
      column.accessor('feePayer', {
        header: 'Fee payer',
        cell: (info) => {
          const payer = info.getValue();
          if (!payer) return <span className="text-muted-foreground">None recorded</span>;
          return (
            <span className="flex flex-col">
              <span>{payer.name}</span>
              <span className="text-xs text-muted-foreground">{CONTACT_CAPABILITY_LABELS[payer.contactCapability]}</span>
            </span>
          );
        },
      }),
      column.accessor('lastPaymentOn', {
        header: 'Last paid',
        cell: (info) => {
          const value = info.getValue();
          return value ? formatDate(value) : <span className="text-muted-foreground">Never</span>;
        },
      }),
      column.accessor('lastReminderAt', {
        header: 'Last reminded',
        cell: (info) => {
          const value = info.getValue();
          return value ? formatDate(value) : <span className="text-muted-foreground">Never</span>;
        },
      }),
      column.accessor('pendingClaim', {
        header: () => <span className="sr-only">Deposit slip</span>,
        cell: (info) => (info.getValue() ? <Badge variant="secondary">Slip to verify</Badge> : null),
      }),
    ];
  }, [canSend, rows, selected]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <FilterSelect label="Class" value={classId} onChange={setClassId} disabled={classes.isPending && academicYearId !== ''}>
          <option value="">All classes</option>
          {(classes.data?.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.min}>Owes at least (Rs)</Label>
          <Input
            id={ids.min}
            inputMode="numeric"
            maxLength={8}
            value={minOutstanding}
            onChange={(e) => setMinOutstanding(digitsOnly(e.target.value))}
            className="w-36"
          />
        </div>
        <FilterSelect<DefaulterSort> label="Sort" value={sort} onChange={setSort}>
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </FilterSelect>
        <label htmlFor={ids.overdue} className="flex h-9 items-center gap-2 text-sm">
          <input
            id={ids.overdue}
            type="checkbox"
            className="size-4 accent-primary"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
          />
          Overdue only
        </label>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {defaulters.data ? `${plural(defaulters.data.total, 'student')} owing` : ' '}
        </p>
        {canSend && (
          <div className="flex items-center gap-3">
            {selected.size > 0 && (
              <span className="text-sm text-muted-foreground">
                {selected.size} selected{selected.size >= MAX_SELECTED && ` (at most ${MAX_SELECTED})`}{' '}
                <button type="button" className="underline underline-offset-4" onClick={() => setSelected(new Map())}>
                  Clear
                </button>
              </span>
            )}
            <Button disabled={selected.size === 0} onClick={() => setSending(true)}>
              <SendIcon />
              Send reminder
            </Button>
          </div>
        )}
      </div>
      <DataTable
        columns={columns}
        query={defaulters}
        getRowId={(row) => row.studentId}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="Nobody owes"
        emptyDescription="No student matches these filters with fees outstanding."
      />
      {sending && (
        <SendReminderDialog
          students={selected}
          onClose={() => setSending(false)}
          onSent={() => {
            setSending(false);
            setSelected(new Map());
          }}
        />
      )}
    </>
  );
}

function SendReminderDialog({
  students,
  onClose,
  onSent,
}: {
  students: ReadonlyMap<string, string>;
  onClose: () => void;
  onSent: () => void;
}) {
  const name = useId();
  const [kind, setKind] = useState<ReminderKind>('overdue');
  const send = useMutation({
    mutationFn: () =>
      unwrap(reportsApi.POST('/api/v1/fee-reminders/send', { body: { kind, studentIds: [...students.keys()] } })),
    onSuccess: (sent) => {
      toast.success(remindersSummary(sent));
      onSent();
    },
  });
  const names = [...students.values()];

  return (
    <Dialog open onOpenChange={(open) => !open && !send.isPending && onClose()}>
      <DialogContent showCloseButton={!send.isPending}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!send.isPending) send.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Send a fee reminder</DialogTitle>
            <DialogDescription>
              To the families of {plural(names.length, 'student')}: {names.slice(0, 3).join(', ')}
              {names.length > 3 && ` and ${names.length - 3} more`}. Each family gets one message, by WhatsApp, the app or
              SMS as they can be reached.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2 rounded-lg border p-3 text-sm" disabled={send.isPending}>
            <legend className="px-1 font-medium">Reminder</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name={name} checked={kind === 'overdue'} onChange={() => setKind('overdue')} />
              Overdue: fees past their due date
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name={name} checked={kind === 'due'} onChange={() => setKind('due')} />
              Due: fees owed, due soon
            </label>
          </fieldset>
          {send.error && <p className="text-sm text-destructive" role="alert">{describeApiError(send.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={send.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={send.isPending}>
              {send.isPending ? 'Sending…' : 'Send reminder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
