'use client';

import { ErrorCode, formatRupees } from '@asms/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { SearchIcon, XCircleIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { TablePagination } from '@/components/data-table';
import { BackLink, EmptyState, ErrorState, LoadingState, QueryStates, StateCard } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  supportApi,
  type SupportAuditEntryDto,
  type SupportChargeDto,
  type SupportPaymentDto,
  type SupportSessionDto,
  type SupportStudentDto,
} from '@/lib/api/platform-support-contract';
import { formatDate, formatDateTime } from '@/lib/format';
import { platformKeys } from '@/lib/platform-session';
import { SessionStatusBadge, useCloseSession } from '../support-session-list';

// Phase 5 slice 45 (rule 40, §1.1 "Support views", R351): what a support session may read, and
// nothing else: the school's settings, a student found by admission number with the guardians'
// names and phones, that student's charges and payments, and the school's audit log. Each view is
// fetched only when asked for, and every fetch is written to both audit logs. When the session
// ends (closed, revoked by the school, expired) the next fetch is refused and the screen says so.

const LIMIT = 25;
type Tab = 'student' | 'settings' | 'audit';

const isEnded = (error: unknown): boolean => error instanceof ApiError && error.code === ErrorCode.SUPPORT_SESSION_ENDED;

export function SupportSessionViews({ id }: { id: string }) {
  const session = useQuery({
    queryKey: platformKeys.supportSession(id),
    queryFn: () => unwrap(supportApi.GET('/api/v1/platform/support-sessions/{id}', { params: { path: { id } } })),
  });
  return (
    <>
      <BackLink href="/platform/support">Support access</BackLink>
      <QueryStates
        query={session}
        notFound={{ title: 'Session not found', description: 'It may have been mistyped. Find it in the support list.' }}
      >
        {(data) => <SessionScreen session={data} />}
      </QueryStates>
    </>
  );
}

function SessionScreen({ session }: { session: SupportSessionDto }) {
  const [tab, setTab] = useState<Tab>('student');
  const close = useCloseSession();
  const usable = session.mine && session.status === 'open';
  return (
    <>
      <PageHeader
        title={session.schoolName}
        description={`Ticket ${session.ticketRef} · ${session.reason}`}
        actions={
          usable && (
            <Button variant="outline" disabled={close.isPending} onClick={() => close.mutate(session.id)}>
              <XCircleIcon />
              Close access
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SessionStatusBadge session={session} />
        <span className="text-sm text-muted-foreground">Read-only. Every view below is recorded in the school&apos;s audit log.</span>
      </div>
      {!usable ? (
        <StateCard>
          <EmptyState
            title={session.status === 'open' ? 'Another admin holds this session' : 'This session has ended'}
            description={
              session.status === 'open'
                ? 'Only the admin who opened it can read through it.'
                : 'Open new access from the school’s page if the ticket still needs it.'
            }
          />
        </StateCard>
      ) : (
        <>
          <div role="tablist" aria-label="Views" className="mb-4 flex flex-wrap gap-2">
            {(
              [
                ['student', 'Student and fees'],
                ['settings', 'School settings'],
                ['audit', 'Audit log'],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                role="tab"
                aria-selected={tab === key}
                variant={tab === key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTab(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          {tab === 'student' && <StudentView sessionId={session.id} />}
          {tab === 'settings' && <SettingsView sessionId={session.id} />}
          {tab === 'audit' && <AuditView sessionId={session.id} />}
        </>
      )}
    </>
  );
}

/** A refused read because the session ended: refresh the session so the screen shows it. */
function useEndedRefresh(sessionId: string, error: unknown) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (isEnded(error)) void queryClient.invalidateQueries({ queryKey: platformKeys.support });
  }, [error, queryClient, sessionId]);
}

function ViewError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isEnded(error)) {
    return <EmptyState title="This session has ended" description="The school revoked it, it expired, or it was closed." />;
  }
  return <ErrorState error={error} onRetry={onRetry} />;
}

// ---- settings --------------------------------------------------------------------------------

function SettingsView({ sessionId }: { sessionId: string }) {
  const settings = useQuery({
    queryKey: [...platformKeys.supportSession(sessionId), 'settings'],
    queryFn: () =>
      unwrap(supportApi.GET('/api/v1/platform/support-sessions/{id}/settings', { params: { path: { id: sessionId } } })),
    retry: false,
  });
  useEndedRefresh(sessionId, settings.error);
  if (settings.isPending) return <StateCard><LoadingState rows={4} /></StateCard>;
  if (settings.error) return <StateCard><ViewError error={settings.error} onRetry={() => void settings.refetch()} /></StateCard>;
  const s = settings.data;
  const rows: [string, string][] = [
    ['Status', s.status],
    ['Timezone', s.timezone],
    ['Fee due day', String(s.feeDueDay)],
    ['Fee cut-off day', String(s.feeCutoffDay)],
    ['Late fee', s.lateFeeEnabled ? `${formatRupees(s.lateFeeAmount ?? 0)} after ${s.lateFeeGraceDays} days` : 'Off'],
    ['Pay day', String(s.payDay)],
    ['Expense approval above', formatRupees(s.expenseApprovalThreshold)],
    ['Periods a day', String(s.periodsPerDay)],
    ['Student logins', s.studentLoginEnabled ? 'On' : 'Off'],
    ['Late counts as', s.lateCountsAs.replaceAll('_', ' ')],
    ['Financial statement basis', s.financialStatementBasis],
  ];
  return (
    <Card data-testid="support-settings">
      <CardHeader>
        <CardTitle>
          {s.name} ({s.shortCode})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b py-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ---- student ---------------------------------------------------------------------------------

function StudentView({ sessionId }: { sessionId: string }) {
  const [admissionNo, setAdmissionNo] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [studentId, setStudentId] = useState<string | null>(null);
  const found = useQuery({
    queryKey: [...platformKeys.supportSession(sessionId), 'students', searched],
    queryFn: () =>
      unwrap(
        supportApi.GET('/api/v1/platform/support-sessions/{id}/students', {
          params: { path: { id: sessionId }, query: { admissionNo: searched ?? '', page: 1, limit: 10 } },
        }),
      ),
    enabled: searched !== null,
    retry: false,
  });
  useEndedRefresh(sessionId, found.error);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Find a student</CardTitle>
          <CardDescription>By admission number only. Identity numbers are never shown or searched.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = admissionNo.trim();
              if (value) {
                setStudentId(null);
                setSearched(value);
              }
            }}
          >
            <div className="grid min-w-0 flex-1 gap-1.5 sm:max-w-xs">
              <Label htmlFor="support-admission-no">Admission number</Label>
              <Input
                id="support-admission-no"
                value={admissionNo}
                maxLength={30}
                onChange={(event) => setAdmissionNo(event.target.value)}
              />
            </div>
            <Button type="submit" variant="outline">
              <SearchIcon />
              Find
            </Button>
          </form>
          {searched !== null && (
            <div className="mt-4">
              {found.isPending ? (
                <LoadingState rows={1} />
              ) : found.error ? (
                <ViewError error={found.error} onRetry={() => void found.refetch()} />
              ) : found.data.data.length === 0 ? (
                <EmptyState title="No student with that admission number" description="Check the number with the school." />
              ) : (
                <ul className="divide-y text-sm">
                  {found.data.data.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <span className="font-medium">{s.fullName}</span> · {s.admissionNo} ·{' '}
                        {s.current ? `${s.current.className} ${s.current.sectionName}` : 'no current class'} · {s.status}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => setStudentId(s.id)}>
                        Open
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {studentId !== null && <StudentDetail sessionId={sessionId} studentId={studentId} />}
    </div>
  );
}

function StudentDetail({ sessionId, studentId }: { sessionId: string; studentId: string }) {
  const student = useQuery({
    queryKey: [...platformKeys.supportSession(sessionId), 'student', studentId],
    queryFn: () =>
      unwrap(
        supportApi.GET('/api/v1/platform/support-sessions/{id}/students/{studentId}', {
          params: { path: { id: sessionId, studentId } },
        }),
      ),
    retry: false,
  });
  useEndedRefresh(sessionId, student.error);
  if (student.isPending) return <StateCard><LoadingState rows={3} /></StateCard>;
  if (student.error) return <StateCard><ViewError error={student.error} onRetry={() => void student.refetch()} /></StateCard>;
  return (
    <>
      <StudentCard student={student.data} />
      <ChargesTable sessionId={sessionId} studentId={studentId} />
      <PaymentsTable sessionId={sessionId} studentId={studentId} />
    </>
  );
}

function StudentCard({ student }: { student: SupportStudentDto }) {
  return (
    <Card data-testid="support-student">
      <CardHeader>
        <CardTitle>{student.fullName}</CardTitle>
        <CardDescription>
          Admission {student.admissionNo} · admitted {formatDate(student.admittedOn)} · {student.status}
          {student.current && ` · ${student.current.academicYearName}, ${student.current.className} ${student.current.sectionName}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {student.guardians.length === 0 ? (
          <p className="text-muted-foreground">No guardian linked.</p>
        ) : (
          <ul className="grid gap-1">
            {student.guardians.map((g) => (
              <li key={g.id}>
                <span className="font-medium">{g.fullName}</span> ({g.relationship}) · {g.phone ?? 'no phone'}
                {g.isPrimaryContact && ' · primary contact'}
                {g.isFeePayer && ' · pays fees'}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function usePaged<T>(sessionId: string, key: string, fetch: (page: number) => Promise<{ data: T[]; total: number }>) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [...platformKeys.supportSession(sessionId), key, page],
    queryFn: () => fetch(page),
    placeholderData: keepPreviousData,
    retry: false,
  });
  useEndedRefresh(sessionId, query.error);
  return { query, page, setPage };
}

function ChargesTable({ sessionId, studentId }: { sessionId: string; studentId: string }) {
  const { query, page, setPage } = usePaged<SupportChargeDto>(sessionId, `charges-${studentId}`, (p) =>
    unwrap(
      supportApi.GET('/api/v1/platform/support-sessions/{id}/students/{studentId}/charges', {
        params: { path: { id: sessionId, studentId }, query: { page: p, limit: LIMIT } },
      }),
    ),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Charges</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {query.isPending ? (
          <LoadingState rows={3} />
        ) : query.error ? (
          <ViewError error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.data.length === 0 ? (
          <EmptyState title="No charges" description="Nothing has been charged to this student." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table aria-label="Charges">
                <TableHeader>
                  <TableRow>
                    <TableHead>Charge</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Owing</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.data.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        {c.feeHeadName}
                        {c.period && ` ${c.period}`}
                      </TableCell>
                      <TableCell>{formatDate(c.dueOn)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRupees(c.amount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRupees(c.paid + c.credited)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRupees(c.outstanding)}</TableCell>
                      <TableCell>{c.status}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePagination page={page} limit={LIMIT} total={query.data.total} loading={query.isFetching} onPageChange={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PaymentsTable({ sessionId, studentId }: { sessionId: string; studentId: string }) {
  const { query, page, setPage } = usePaged<SupportPaymentDto>(sessionId, `payments-${studentId}`, (p) =>
    unwrap(
      supportApi.GET('/api/v1/platform/support-sessions/{id}/students/{studentId}/payments', {
        params: { path: { id: sessionId, studentId }, query: { page: p, limit: LIMIT } },
      }),
    ),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {query.isPending ? (
          <LoadingState rows={3} />
        ) : query.error ? (
          <ViewError error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.data.length === 0 ? (
          <EmptyState title="No payments" description="No payment has reached this student." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table aria-label="Payments">
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">For this student</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.data.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{formatDate(p.receivedOn)}</TableCell>
                      <TableCell>{p.receiptNo ?? '—'}</TableCell>
                      <TableCell>{p.method.replaceAll('_', ' ')}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRupees(p.amount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRupees(p.forStudent)}</TableCell>
                      <TableCell>{p.status}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePagination page={page} limit={LIMIT} total={query.data.total} loading={query.isFetching} onPageChange={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---- audit log -------------------------------------------------------------------------------

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

function AuditView({ sessionId }: { sessionId: string }) {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 6 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const { query, page, setPage } = usePaged<SupportAuditEntryDto>(sessionId, `audit-${from}-${to}`, (p) =>
    unwrap(
      supportApi.GET('/api/v1/platform/support-sessions/{id}/audit-log', {
        params: { path: { id: sessionId }, query: { createdFrom: from, createdTo: to, page: p, limit: LIMIT } },
      }),
    ),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>The school&apos;s own log, as its audit screen shows it (at most 92 days).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 p-0">
        <div className="flex flex-wrap gap-3 px-6">
          <div className="grid gap-1.5">
            <Label htmlFor="support-audit-from">From</Label>
            <Input id="support-audit-from" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="support-audit-to">To</Label>
            <Input id="support-audit-to" type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </div>
        </div>
        {query.isPending ? (
          <LoadingState rows={3} />
        ) : query.error ? (
          <ViewError error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.data.length === 0 ? (
          <EmptyState title="Nothing recorded" description="No entries in these dates." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table aria-label="Audit log">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Record</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.data.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{formatDateTime(e.createdAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{e.action}</TableCell>
                      <TableCell>{e.actor.name}</TableCell>
                      <TableCell>
                        {e.subjectType}
                        {e.subjectId && ` ${e.subjectId}`}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{e.reason ?? ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePagination page={page} limit={LIMIT} total={query.data.total} loading={query.isFetching} onPageChange={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
