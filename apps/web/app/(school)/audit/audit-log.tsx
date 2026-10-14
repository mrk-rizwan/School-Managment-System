'use client';

import { addDaysTo } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { HistoryIcon, UserRoundSearchIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { auditApi, type AuditEntryDto, type AuditLogQuery } from '@/lib/api/school-audit-contract';
import { formatDateTime, todayInSchool } from '@/lib/format';
import { useDebounced, useListPage } from '@/lib/hooks';

// The audit log (Phase 5 slice 46, contracts/slice-46.md §4; rule 40, R354): a date range of at
// most 92 days, narrowed to one person or one record and by the start of an action. The API leaves
// out the account and role family and masks identity, phone and email shapes; this screen shows
// what it is given as text. Inert on a default password: the API refuses it and the table shows
// the "change your password first" state.

const LIMIT = 25;
const MAX_DAYS = 92;
const DAY_MS = 86_400_000;
/** As the API's ACTION_PREFIX_PATTERN: a family (`payment`) or the start of an action (`payment.vo`). */
const ACTION_PREFIX = /^[a-z][a-z0-9_]{0,40}(\.[a-z0-9_]{0,40})?$/;
const ID = /^[1-9][0-9]{0,18}$/;
const SUBJECT_TYPE = /^[a-z][a-z0-9_]{0,31}$/;

/** Records with a page of their own: the subject column links there. */
const SUBJECT_PAGES: Readonly<Record<string, (id: string) => string>> = {
  student: (id) => `/students/${id}`,
  staff: (id) => `/staff/${id}`,
  guardian: (id) => `/guardians/${id}`,
  announcement: (id) => `/announcements/${id}`,
  event: (id) => `/events/${id}`,
  class: (id) => `/academics/classes/${id}`,
  section: (id) => `/sections/${id}`,
  payroll_run: (id) => `/payroll/${id}`,
  assessment: (id) => `/marks/${id}`,
  result_sheet: (id) => `/results/sheets/${id}`,
  promotion_sheet: (id) => `/promotion/${id}`,
};

export const auditKeys = { list: ['school', 'audit-log'] as const };

/** `payment_account` → `Payment account`. */
const humanise = (code: string) => {
  const text = code.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const daysInRange = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;

type Actor = { id: string; name: string };
type Subject = { type: string; id: string };

export function AuditLog() {
  const params = useSearchParams();
  const today = todayInSchool();
  const param = (name: string, pattern: RegExp) => {
    const value = params.get(name);
    return value !== null && pattern.test(value) ? value : null;
  };
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const [from, setFrom] = useState(() => param('createdFrom', date) ?? addDaysTo(today, -6));
  const [to, setTo] = useState(() => param('createdTo', date) ?? today);
  const [actor, setActor] = useState<Actor | null>(() => {
    const id = param('actorUserId', ID);
    return id === null ? null : { id, name: 'the selected person' };
  });
  const [subject, setSubject] = useState<Subject | null>(() => {
    const type = param('subjectType', SUBJECT_TYPE);
    const id = param('subjectId', ID);
    return type === null || id === null ? null : { type, id };
  });
  const [family, setFamily] = useState(() => param('actionPrefix', ACTION_PREFIX) ?? '');
  const prefix = useDebounced(family.trim());
  const [page, setPage] = useListPage([from, to, actor?.id, subject?.type, subject?.id, prefix]);
  const ids = { from: useId(), to: useId(), family: useId() };

  const rangeProblem =
    from === '' || to === ''
      ? 'Choose both dates.'
      : daysInRange(from, to) < 1
        ? 'The end date is before the start date.'
        : daysInRange(from, to) > MAX_DAYS
          ? `Choose at most ${MAX_DAYS} days.`
          : null;
  const prefixProblem =
    prefix !== '' && !ACTION_PREFIX.test(prefix) ? 'Use lower-case letters, digits and _, with at most one dot: payment or payment.voided.' : null;

  const query: AuditLogQuery = {
    page,
    limit: LIMIT,
    createdFrom: from,
    createdTo: to,
    ...(actor && { actorUserId: actor.id }),
    ...(subject && { subjectType: subject.type, subjectId: subject.id }),
    ...(prefix && { actionPrefix: prefix }),
  };
  const valid = rangeProblem === null && prefixProblem === null;
  const entries = useQuery({
    queryKey: [...auditKeys.list, query],
    queryFn: () => unwrap(auditApi.GET('/api/v1/audit-log', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: valid,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, AuditEntryDto>();
    return [
      column.accessor('createdAt', {
        header: 'When',
        cell: (info) => <span className="whitespace-nowrap">{formatDateTime(info.getValue())}</span>,
      }),
      column.accessor('actor', {
        header: 'Who',
        cell: (info) => {
          const a = info.getValue();
          const userId = a.userId;
          if (a.kind !== 'user' || userId === null) return <Badge variant="outline">{a.name}</Badge>;
          return (
            <span className="flex items-center gap-1">
              <span>{a.name || 'Unnamed user'}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Only actions by ${a.name || 'this user'}`}
                title="Only this person's actions"
                onClick={() => setActor({ id: userId, name: a.name || 'this user' })}
              >
                <UserRoundSearchIcon />
              </Button>
            </span>
          );
        },
      }),
      column.accessor('action', {
        header: 'Action',
        cell: (info) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs break-all">{info.getValue()}</code>,
      }),
      column.display({
        id: 'record',
        header: 'Record',
        cell: (info) => {
          const e = info.row.original;
          const subjectId = e.subjectId;
          const label = `${humanise(e.subjectType)}${subjectId === null ? '' : ` ${subjectId}`}`;
          const href = subjectId === null ? undefined : SUBJECT_PAGES[e.subjectType]?.(subjectId);
          return (
            <span className="flex items-center gap-1">
              {href ? (
                <Link className="hover:underline" href={href}>
                  {label}
                </Link>
              ) : (
                <span>{label}</span>
              )}
              {subjectId !== null && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`History of ${label}`}
                  title="Only this record's history"
                  onClick={() => setSubject({ type: e.subjectType, id: subjectId })}
                >
                  <HistoryIcon />
                </Button>
              )}
            </span>
          );
        },
      }),
      column.display({
        id: 'details',
        header: 'Details',
        cell: (info) => {
          const e = info.row.original;
          if (e.details.length === 0 && e.reason === null) return <span className="text-muted-foreground">—</span>;
          return (
            <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-2 text-xs">
              {e.reason !== null && (
                <>
                  <dt className="text-muted-foreground">Reason</dt>
                  <dd className="break-words">{e.reason}</dd>
                </>
              )}
              {e.details.map((d) => (
                <span key={d.key} className="contents">
                  <dt className="text-muted-foreground">{d.key}</dt>
                  <dd className="break-all">{d.value}</dd>
                </span>
              ))}
            </dl>
          );
        },
      }),
    ];
  }, []);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={ids.from}>From</Label>
          <Input id={ids.from} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={ids.to}>To</Label>
          <Input id={ids.to} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="grid w-full gap-1.5 sm:w-56">
          <Label htmlFor={ids.family}>Action starts with</Label>
          <Input
            id={ids.family}
            value={family}
            maxLength={82}
            autoComplete="off"
            placeholder="payment"
            onChange={(e) => setFamily(e.target.value)}
          />
        </div>
      </div>
      {(actor || subject) && (
        <div className="mb-4 flex flex-wrap gap-2" aria-label="Narrowed to">
          {actor && (
            <Badge variant="secondary" className="gap-1">
              Actions by {actor.name}
              <button type="button" aria-label="Show everyone's actions" onClick={() => setActor(null)}>
                <XIcon className="size-3" />
              </button>
            </Badge>
          )}
          {subject && (
            <Badge variant="secondary" className="gap-1">
              History of {humanise(subject.type)} {subject.id}
              <button type="button" aria-label="Show every record" onClick={() => setSubject(null)}>
                <XIcon className="size-3" />
              </button>
            </Badge>
          )}
        </div>
      )}
      {valid ? (
        <DataTable
          columns={columns}
          query={entries}
          getRowId={(row) => row.id}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle="Nothing recorded"
          emptyDescription="No action matches these filters in this date range."
        />
      ) : (
        <Alert role="status">
          <AlertDescription>{rangeProblem ?? prefixProblem}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
