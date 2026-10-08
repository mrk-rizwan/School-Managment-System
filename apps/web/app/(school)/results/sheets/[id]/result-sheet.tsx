'use client';

import { Capability, TERM_REMARK_MAX } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { BackLink, EmptyState, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import {
  resultCardPrintPath,
  resultSheetPrintPath,
  resultsApi,
  type ResultSheetDetailDto,
} from '@/lib/api/school-results-contract';
import { formatDateTime } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import {
  openPrint,
  percentLabel,
  resultErrorMessage,
  resultKeys,
  ROLE_LABELS,
  SHEET_STATUS_LABELS,
  sheetStatusVariant,
  sheetTermLabel,
} from '../../_lib/results-ui';

// contracts/slice-31.md §9: one result sheet. The preview is the shared composition over the live
// marks (never stored) until approval, then the stored results. The class teacher writes the term
// remarks and submits; a result.approve holder approves or returns with a reason; a result.publish
// holder publishes an approved sheet. The API refuses whatever the caller may not do.

export function ResultSheetScreen({ id }: { id: string }) {
  const sheet = useQuery({
    queryKey: resultKeys.detail(id),
    queryFn: () =>
      unwrap(resultsApi.GET('/api/v1/result-sheets/{id}', { params: { path: { id } } })),
  });
  return (
    <>
      <BackLink href="/results/sheets">Result sheets</BackLink>
      <QueryStates
        query={sheet}
        loadingRows={8}
        notFound={{
          title: 'Not one of your sheets',
          description: 'This sheet is not in your sections, or it does not exist.',
        }}
      >
        {(data) => <ResultSheet key={data.updatedAt} data={data} />}
      </QueryStates>
    </>
  );
}

function ResultSheet({ data }: { data: ResultSheetDetailDto }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  // Slice 32 (R283): the stored rows print as report cards for a marks.view_all holder.
  const mayPrint = can(Capability.MARKS_VIEW_ALL) && data.source === 'stored';
  const [remarks, setRemarks] = useState<ReadonlyMap<string, string>>(new Map());
  const [returning, setReturning] = useState(false);
  const refresh = (next: ResultSheetDetailDto) => {
    queryClient.setQueryData(resultKeys.detail(data.id), next);
    // The answer is the sheet now; the lists (and the inbox) read again.
    void queryClient.invalidateQueries({ queryKey: [...resultKeys.all, 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['school', 'approvals'] });
  };
  const onError = (error: unknown) => toast.error(resultErrorMessage(error));
  const path = { params: { path: { id: data.id } } };

  const changed = [...remarks].filter(([enrolmentId, text]) => {
    const row = data.preview.find((r) => r.enrolmentId === enrolmentId);
    return (row?.remark ?? '') !== text.trim();
  });
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        resultsApi.PATCH('/api/v1/result-sheets/{id}', {
          ...path,
          body: {
            remarks: changed.map(([enrolmentId, text]) => ({
              enrolmentId,
              remark: text.trim() === '' ? null : text.trim(),
            })),
          },
        }),
      ),
    onSuccess: (next) => {
      setRemarks(new Map());
      refresh(next);
      toast.success('Remarks saved.');
    },
    onError,
  });
  const done = (message: string) => (next: ResultSheetDetailDto) => {
    refresh(next);
    toast.success(message);
  };
  const submit = useMutation({
    mutationFn: () => unwrap(resultsApi.POST('/api/v1/result-sheets/{id}/submit', path)),
    onSuccess: done('Sheet submitted for approval.'),
    onError,
  });
  const approve = useMutation({
    mutationFn: () => unwrap(resultsApi.POST('/api/v1/result-sheets/{id}/approve', path)),
    onSuccess: done('Sheet approved.'),
    onError,
  });
  const publish = useMutation({
    mutationFn: () => unwrap(resultsApi.POST('/api/v1/result-sheets/{id}/publish', path)),
    onSuccess: done('Results published. Families are being told.'),
    onError,
  });
  const returnSheet = useMutation({
    mutationFn: (reason: string) =>
      unwrap(resultsApi.POST('/api/v1/result-sheets/{id}/return', { ...path, body: { reason } })),
    onSuccess: (next) => {
      setReturning(false);
      refresh(next);
      toast.success('Sheet returned to the class teacher.');
    },
    onError,
  });
  const busy =
    save.isPending ||
    submit.isPending ||
    approve.isPending ||
    publish.isPending ||
    returnSheet.isPending;
  // Remarks follow canRemark (the final sheet's too); Submit follows canSubmit (term sheets).
  const editing = data.canRemark;

  return (
    <>
      <PageHeader
        title={`${data.className} ${data.sectionName} · ${sheetTermLabel(data)}`}
        description={
          data.source === 'preview'
            ? 'A preview from the marks entered so far. Nothing is stored until the sheet is approved.'
            : 'The results stored at approval: what the report card prints.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {editing && (
              <Button
                variant="outline"
                disabled={busy || changed.length === 0}
                onClick={() => save.mutate()}
              >
                Save remarks{changed.length > 0 ? ` (${changed.length})` : ''}
              </Button>
            )}
            {data.canSubmit && (
              <Button disabled={busy || changed.length > 0} onClick={() => submit.mutate()}>
                Submit for approval
              </Button>
            )}
            {data.canDecide && (data.status === 'submitted' || data.status === 'approved') && (
              <Button variant="outline" disabled={busy} onClick={() => setReturning(true)}>
                Return
              </Button>
            )}
            {data.canDecide && data.status !== 'approved' && (
              <Button disabled={busy} onClick={() => approve.mutate()}>
                Approve
              </Button>
            )}
            {mayPrint && (
              <Button variant="outline" onClick={() => openPrint(resultSheetPrintPath(data.id))}>
                Print report cards
              </Button>
            )}
            {data.canPublish && (
              <Button disabled={busy} onClick={() => publish.mutate()}>
                Publish
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={sheetStatusVariant(data.status)} data-testid="sheet.status">
          {SHEET_STATUS_LABELS[data.status]}
        </Badge>
        {data.version > 1 && <Badge variant="outline">Version {data.version}</Badge>}
        {data.submittedAt && (
          <span className="text-muted-foreground">
            Submitted {formatDateTime(data.submittedAt)} by {data.submittedByName}
            {data.cover && ' (covering)'}
          </span>
        )}
        {data.publishedAt && (
          <span className="text-muted-foreground">
            · Published {formatDateTime(data.publishedAt)}
          </span>
        )}
        {data.settings.testWeight !== null && (
          <span className="text-muted-foreground">
            · Tests {data.settings.testWeight} %, exam {data.settings.examWeight} %, pass at{' '}
            {data.settings.passPercent} %
          </span>
        )}
      </div>
      <Flags data={data} />
      {data.preview.length === 0 ? (
        <EmptyState
          title="No students on this sheet"
          description="The section has no student enrolled on the term's last day."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">Student</TableHead>
                {data.subjects.map((s) => (
                  <TableHead key={s.classSubjectId} className="text-right whitespace-nowrap">
                    {s.subjectName}
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Percent</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Position</TableHead>
                <TableHead className="text-right">Attendance</TableHead>
                <TableHead className="min-w-64">Remark</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.preview.map((row) => (
                <TableRow key={row.enrolmentId} data-testid={`sheet.row.${row.enrolmentId}`}>
                  <TableCell className="px-4">
                    <span className="font-medium">{row.fullName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.rollNo !== null ? `Roll ${row.rollNo} · ` : ''}
                      {row.admissionNo}
                    </span>
                    {mayPrint && row.resultId && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={() => openPrint(resultCardPrintPath(row.resultId!))}
                      >
                        Print card
                      </Button>
                    )}
                    {row.missing > 0 && (
                      <Badge variant="destructive" className="mt-1">
                        {row.missing} missing
                      </Badge>
                    )}
                    {row.ownChildFlags.length > 0 && (
                      <Badge variant="outline" className="mt-1 ml-1">
                        Own child
                      </Badge>
                    )}
                  </TableCell>
                  {data.subjects.map((s) => {
                    const subject = row.subjects.find((x) => x.classSubjectId === s.classSubjectId);
                    return (
                      <TableCell
                        key={s.classSubjectId}
                        className="text-right tabular-nums whitespace-nowrap"
                      >
                        {subject && subject.obtained !== null ? (
                          <>
                            {subject.obtained}/{subject.max}
                            <span className="block text-xs text-muted-foreground">
                              {subject.grade}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tabular-nums">
                    {row.totalMax > 0 ? `${row.totalObtained}/${row.totalMax}` : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percentLabel(row.percentBp)}
                  </TableCell>
                  <TableCell>
                    {row.grade ?? '—'}
                    {row.passed === false && (
                      <Badge variant="destructive" className="ml-1">
                        Fail
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.position !== null ? `${row.position} / ${row.positionOf}` : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percentLabel(row.attendanceBp)}
                  </TableCell>
                  <TableCell>
                    {editing ? (
                      <Textarea
                        aria-label={`Remark for ${row.fullName}`}
                        maxLength={TERM_REMARK_MAX}
                        rows={2}
                        value={remarks.get(row.enrolmentId) ?? row.remark ?? ''}
                        onChange={(e) =>
                          setRemarks(new Map(remarks).set(row.enrolmentId, e.target.value))
                        }
                      />
                    ) : (
                      <span className="text-sm">{row.remark ?? '—'}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ConfirmWithReasonDialog
        open={returning}
        onOpenChange={setReturning}
        title="Return the sheet"
        description="The class teacher sees your reason; the section's tests unlock for changes."
        confirmLabel="Return sheet"
        minLength={3}
        pending={returnSheet.isPending}
        onConfirm={(reason) => returnSheet.mutate(reason)}
      />
    </>
  );
}

function Flags({ data }: { data: ResultSheetDetailDto }) {
  const { flags } = data;
  return (
    <div className="mb-4 grid gap-3">
      {data.status === 'returned' && data.returnReason && (
        <Alert variant="destructive">
          <AlertTitle>Returned by {data.decidedByName}</AlertTitle>
          <AlertDescription>{data.returnReason}</AlertDescription>
        </Alert>
      )}
      {flags.ownChild.length > 0 && (
        <Alert data-testid="sheet.ownChild">
          <AlertTitle>A parent on this sheet</AlertTitle>
          <AlertDescription>
            {flags.ownChild.map((f) => `${f.userName} ${ROLE_LABELS[f.role]}`).join('; ')} — and is
            a guardian of a student on it.
          </AlertDescription>
        </Alert>
      )}
      {flags.selfApproved && (
        <Alert>
          <AlertDescription>
            Approved by its own submitter, the school&apos;s only principal.
          </AlertDescription>
        </Alert>
      )}
      {data.source === 'preview' && flags.examsNotSetUp.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            The term exam is not set up for {flags.examsNotSetUp.length} subject(s) of this section.
          </AlertDescription>
        </Alert>
      )}
      {data.source === 'preview' && flags.missingCount > 0 && (
        <Alert variant="destructive" data-testid="sheet.missing">
          <AlertDescription>
            {flags.missingCount} mark{flags.missingCount === 1 ? ' is' : 's are'} missing. Enter a
            mark or an absence for every student before submitting.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
