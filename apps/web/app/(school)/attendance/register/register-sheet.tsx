'use client';

import { ErrorCode, type AttendanceStatus } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { RowActions } from '@/components/data-table';
import { EmptyState } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  attendanceApi,
  type RegisterViewDto,
  type RosterIncompleteDetails,
  type RosterRowDto,
  type SubmitMarkBody,
} from '@/lib/api/school-attendance-contract';
import { formatDate, formatDay, formatTime, todayInSchool } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  AlertCell,
  STATUS_LABELS,
  StatusButtons,
  TIME_PATTERN,
  attendanceErrorMessage,
  attendanceKeys,

} from '../_lib/attendance-ui';
import { AmendmentsDialog, arrivalOf, useMarkSheet, type MarkDraft, type SavedMark } from '../_lib/mark-sheet';
import { CorrectMarkDialog, MarkHistoryDialog } from './mark-dialogs';

// The register itself (contracts/slice-11.md §4.1, §4.2, §13): one row per child, P/A/L/O by
// button or keyboard, a late arrival time and a note per row. The first save sends the whole
// roster; later saves send only what changed, and any change to a saved mark asks for a reason.

const savedOf = (row: RosterRowDto): SavedMark | null => row.mark;

function bodyOf(enrolmentId: string, d: MarkDraft): SubmitMarkBody {
  const note = d.note.trim();
  const arrivedAt = arrivalOf(d);
  return { enrolmentId, status: d.status!, ...(note && { note }), ...(arrivedAt && { arrivedAt }) };
}

export function RegisterSheet({ view }: { view: RegisterViewDto }) {
  const queryClient = useQueryClient();
  const editable = view.canSubmit && view.amendable && view.teachingDay;
  // A single mark is corrected inside the window, or by a school-wide holder after it (§4.3).
  const mayCorrect = view.canSubmit && (view.amendable || view.callerRole === 'all');
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [history, setHistory] = useState<RosterRowDto | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const reload = () =>
    void queryClient.invalidateQueries({ queryKey: attendanceKeys.register(view.section.id, view.date, view.period) });

  const names = new Map(view.roster.map((row) => [row.enrolmentId, row.studentFullName]));
  const order = new Map(view.roster.map((row, index) => [row.enrolmentId, index]));
  const sheet = useMarkSheet({
    idKey: 'enrolmentId',
    rowCount: view.roster.length,
    nameOf: (id) => names.get(id) ?? 'A child',
    // The first save sends the whole roster; later saves only what changed: both are the rows
    // that differ from what is saved, sent in roster order.
    submit: (changed, reason) =>
      unwrap(
        attendanceApi.POST('/api/v1/sections/{id}/submit-register', {
          params: { path: { id: view.section.id } },
          body: {
            date: view.date,
            period: view.period,
            ...(reason && { reason }),
            marks: [...changed]
              .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
              .map((c) => bodyOf(c.id, c.draft)),
          },
        }),
      ),
    onSaved: (result) => {
      const { summary } = result;
      toast.success(
        `${result.created ? 'Register saved' : 'Changes saved'}: ${summary.present} present, ${summary.absent} absent, ${summary.late} late, ${summary.onLeave} on leave.`,
      );
      void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
    onRefused: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.ROSTER_INCOMPLETE) {
        setMissing(new Set((error.details as Partial<RosterIncompleteDetails> | null)?.missing ?? []));
        // The roster changed since it was loaded (an admission this morning): show the new one.
        reload();
      }
    },
    // Dropping the server's list means taking its marks: reload them.
    onRaceDropped: reload,
  });

  const draftFor = (row: RosterRowDto) => sheet.draftFor(row.enrolmentId, savedOf(row));
  const update = (row: RosterRowDto, patch: Partial<MarkDraft>) => {
    sheet.update(row.enrolmentId, row.studentFullName, savedOf(row), patch);
    if (patch.status) setMissing((m) => (m.has(row.enrolmentId) ? new Set([...m].filter((id) => id !== row.enrolmentId)) : m));
  };

  const firstSubmit = view.register === null;
  const changedCount = sheet.changed.length;
  const unmarked = view.roster.filter((row) => row.onRoster && draftFor(row).status === null);
  const badTime = view.roster.find((row) => {
    const t = arrivalOf(draftFor(row));
    return t !== '' && !TIME_PATTERN.test(t);
  });

  const save = () => {
    sheet.reset();
    if (firstSubmit && unmarked.length > 0) {
      setMissing(new Set(unmarked.map((row) => row.enrolmentId)));
      return;
    }
    sheet.save();
  };

  /** Every child still unmarked becomes present; nobody is left missing. */
  const markRestPresent = () => {
    for (const row of unmarked) update(row, { status: 'present' });
    setMissing(new Set());
  };

  const counts = { present: 0, absent: 0, late: 0, on_leave: 0 } as Record<AttendanceStatus, number>;
  for (const row of view.roster) {
    const s = draftFor(row).status;
    if (s) counts[s] += 1;
  }
  const correctingRow = view.roster.find((row) => row.enrolmentId === correcting) ?? null;

  if (view.roster.length === 0) {
    return (
      <div className="rounded-lg border bg-card">
        <EmptyState title="No children on this register" description="Nobody was on roll in this section on this date." />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <RegisterStatus view={view} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" data-testid="register-counts">
          {STATUS_LABELS.present} {counts.present} · {STATUS_LABELS.absent} {counts.absent} · {STATUS_LABELS.late}{' '}
          {counts.late} · {STATUS_LABELS.on_leave} {counts.on_leave}
          {unmarked.length > 0 && <span className="text-muted-foreground"> · Not marked {unmarked.length}</span>}
        </p>
        {editable && (
          <p className="hidden text-xs text-muted-foreground sm:block" id="register-keys">
            Keyboard: ↑ ↓ move between children; P, A, L or O marks and moves on.
          </p>
        )}
      </div>

      {missing.size > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {missing.size} child{missing.size === 1 ? ' is' : 'ren are'} not marked. Mark every child before saving the register
            for the first time.
          </AlertDescription>
        </Alert>
      )}
      {sheet.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{attendanceErrorMessage(sheet.error)}</AlertDescription>
        </Alert>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table aria-describedby={editable ? 'register-keys' : undefined}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-14 px-4 text-muted-foreground">Roll</TableHead>
              <TableHead className="px-4 text-muted-foreground">Name</TableHead>
              <TableHead className="px-4 text-muted-foreground">Mark</TableHead>
              <TableHead className="px-4 text-muted-foreground">Arrived</TableHead>
              <TableHead className="px-4 text-muted-foreground">Note</TableHead>
              <TableHead className="px-4 text-muted-foreground">Family told</TableHead>
              <TableHead className="w-10 px-2">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.roster.map((row, index) => {
              const d = draftFor(row);
              const dirty = sheet.isChanged(row.enrolmentId);
              return (
                <TableRow
                  key={row.enrolmentId}
                  {...sheet.rowProps(index, editable ? (status) => update(row, { status }) : null)}
                  data-enrolment={row.enrolmentId}
                  aria-label={`${row.studentFullName}, ${d.status ? STATUS_LABELS[d.status] : 'not marked'}`}
                  aria-keyshortcuts={editable ? 'P A L O ArrowUp ArrowDown' : undefined}
                  className={cn(
                    'focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    missing.has(row.enrolmentId) && 'bg-destructive/5',
                    dirty && 'bg-primary/5',
                  )}
                >
                  <TableCell className="px-4 tabular-nums text-muted-foreground">{row.rollNo ?? '—'}</TableCell>
                  <TableCell className="px-4">
                    <span className="font-medium">{row.studentFullName}</span>
                    {!row.onRoster && (
                      <Badge variant="outline" className="ml-2" title="Marked here before moving or leaving">
                        No longer in this section
                      </Badge>
                    )}
                    {row.mark?.amended && (
                      <Badge variant="ghost" className="ml-2">
                        Amended
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-4">
                    <StatusButtons
                      value={d.status}
                      label={row.studentFullName}
                      inRow
                      disabled={!editable}
                      onChange={(status) => update(row, { status })}
                    />
                  </TableCell>
                  <TableCell className="px-4">
                    {d.status === 'late' ? (
                      <Input
                        type="time"
                        aria-label={`Arrival time of ${row.studentFullName}`}
                        className="h-8 w-28"
                        value={d.arrivedAt}
                        disabled={!editable}
                        aria-invalid={d.arrivedAt && !TIME_PATTERN.test(d.arrivedAt) ? true : undefined}
                        onChange={(event) => update(row, { arrivedAt: event.target.value })}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4">
                    <Input
                      aria-label={`Note for ${row.studentFullName}`}
                      className="h-8 min-w-32"
                      maxLength={200}
                      value={d.note}
                      disabled={!editable || d.status === null}
                      onChange={(event) => update(row, { note: event.target.value })}
                    />
                  </TableCell>
                  <TableCell className="px-4">
                    <AlertCell alert={row.alert} />
                  </TableCell>
                  <TableCell className="px-2">
                    {row.mark && (
                      <RowActions
                        label={row.studentFullName}
                        actions={[
                          { label: 'Mark history', onSelect: () => setHistory(row) },
                          ...(mayCorrect ? [{ label: 'Correct this mark', onSelect: () => setCorrecting(row.enrolmentId) }] : []),
                        ]}
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {editable && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {badTime && <p className="mr-auto text-sm text-destructive">Enter the arrival time of {badTime.studentFullName} as HH:MM.</p>}
          {unmarked.length > 0 && (
            <Button variant="outline" onClick={markRestPresent}>
              Mark the rest present
            </Button>
          )}
          <Button
            onClick={save}
            disabled={sheet.pending || badTime !== undefined || (!firstSubmit && changedCount === 0)}
          >
            {sheet.pending ? 'Saving…' : firstSubmit ? 'Save register' : `Save changes${changedCount ? ` (${changedCount})` : ''}`}
          </Button>
        </div>
      )}

      <AmendmentsDialog
        dialog={sheet.dialog}
        raceDescription="Someone saved this register after you opened it. Saving yours changes these marks, so a reason is needed. Cancel to keep theirs."
        unmarked="not marked"
      />
      <MarkHistoryDialog row={history} onClose={() => setHistory(null)} />
      <CorrectMarkDialog view={view} row={correctingRow} onClose={() => setCorrecting(null)} />
    </div>
  );
}

/** Who recorded the register and when; why it is read-only when it is (contract §13). */
function RegisterStatus({ view }: { view: RegisterViewDto }) {
  const today = todayInSchool();
  const register = view.register;
  const when = (iso: string) => {
    const day = formatDate(iso);
    return day === formatDay(view.date) ? `at ${formatTime(iso)}` : `on ${day} at ${formatTime(iso)}`;
  };
  const readOnly = !view.canSubmit
    ? 'You can read this register but not change it.'
    : !view.teachingDay
      ? register
        ? 'This day was declared a holiday after the register was taken. It no longer counts; a single mark can still be corrected.'
        : 'This is not a teaching day, so there is no register to take.'
      : !view.amendable
        ? `The amendment window has closed for ${formatDay(view.date)}. Ask the principal to make changes.`
        : null;
  return (
    <div className="grid gap-3">
      <p className="text-sm" data-testid="register-recorded">
        {register ? (
          <>
            Recorded by <span className="font-medium">{register.submittedByName ?? 'unknown'}</span> {when(register.submittedAt)}
            {register.lastAmendedByName && register.lastAmendedAt && (
              <>
                {' '}
                · amended by <span className="font-medium">{register.lastAmendedByName}</span> {when(register.lastAmendedAt)}
              </>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">
            Not recorded yet{view.date === today ? ' today' : ''}. Every child must be marked the first time it is saved.
          </span>
        )}
      </p>
      {readOnly && (
        <Alert data-testid="register-read-only">
          <AlertTitle>Read only</AlertTitle>
          <AlertDescription>{readOnly}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
