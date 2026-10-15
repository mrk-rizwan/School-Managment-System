'use client';

import { Capability, ErrorCode, formatRupees, newIdempotencyKey } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { CheckCircle2Icon, FileUpIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { QueryStates } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { ApiError, refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import {
  commitImport,
  importsApi,
  MAX_IMPORT_BYTES,
  previewOpeningBalances,
  previewPastResults,
  type ImportDetailDto,
  type ImportDto,
  type ImportKind,
  type ImportRowErrorCode,
  type ImportStatus,
} from '@/lib/api/school-imports-contract';
import { formatDate, formatDateTime, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { DEFAULT_PASSWORD_HINT, useBlockedActions, useCapabilities, useSchoolMe } from '@/lib/school-session';
import { useYearSections } from '../academics/_lib/options';
import { useDefaultYearId, useTerms, YearFilter } from '../reports/_lib/reports-ui';

// Commencement imports (Phase 5 slice 43, contracts/slice-43.md; rule 39, R339-R343): a school
// moving onto the system brings its earlier term results (one CSV per section and term) and the
// fees each student still owes (one CSV per year). Choose the kind, upload the CSV, read the
// preview — every refused row with its line — and commit it, or correct the file and upload again.
// A preview lapses after 24 hours. Cell text the file holds is shown as text, never as markup.

const LIMIT = 25;

export const importKeys = {
  lists: ['school', 'imports', 'list'] as const,
  list: (query: object) => ['school', 'imports', 'list', query] as const,
  detail: (id: string) => ['school', 'imports', 'detail', id] as const,
};

const KIND_LABELS: Record<ImportKind, string> = {
  past_results: 'Past results',
  opening_balances: 'Opening balances',
};

const STATUS_LABELS: Record<ImportStatus, string> = {
  previewed: 'Awaiting commit',
  committed: 'Committed',
  failed: 'Failed',
};

const statusVariant = (status: ImportStatus) =>
  status === 'committed' ? ('secondary' as const) : status === 'failed' ? ('destructive' as const) : ('outline' as const);

/** Each row refusal in words the office can act on (the codes of packages/shared imports/kinds.ts). */
const ROW_ERROR_LABELS: Record<ImportRowErrorCode, string> = {
  first_column: 'The first column must be admission_no',
  unknown_column: 'Not a column this file can have',
  missing_column: 'This column is missing',
  duplicate_column: 'This column appears twice',
  required: 'Empty',
  unknown_admission_no: 'No student has this admission number',
  not_on_roster: 'Not on the list for this import (another section, or not enrolled this year)',
  duplicate: 'This student is listed twice',
  missing_from_file: 'This student is missing from the file',
  invalid_mark: 'Not a mark: write a whole number, or Ab for absent',
  over_max: "Above the exam's maximum",
  invalid_amount: 'Not a whole rupee amount above 0',
  identity_number: 'Looks like an identity number, which is not accepted',
};

const REFUSALS: RefusalMessages = {
  [ErrorCode.IMPORT_SHEET_EXISTS]: 'This section already has a result sheet for the term, so its results cannot be imported.',
  [ErrorCode.IMPORT_MARKS_EXIST]: 'Marks have already been entered for this section and term. Import only into a term with no marks.',
  [ErrorCode.IMPORT_YEAR_CLOSED]: 'This academic year is closed.',
  [ErrorCode.IMPORT_DUPLICATE_FILE]: 'This file has already been imported.',
  [ErrorCode.IMPORT_EXPIRED]: 'This preview has expired. Upload the file again.',
  [ErrorCode.IMPORT_NOT_PREVIEWED]: 'This import is no longer waiting to be committed.',
  [ErrorCode.IMPORT_ROWS_INVALID]: 'The file has errors. Correct them and upload it again.',
  [ErrorCode.STALE_STATUS]: 'The class or its students changed since the preview. Upload the file again.',
  [`${ErrorCode.PERMISSION_DENIED}:principal_required`]: 'Only a principal can import opening balances.',
  [`${ErrorCode.PERMISSION_DENIED}:assessment_define_required`]: 'Importing results also needs the permission to set up exams.',
  [ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION]: DEFAULT_PASSWORD_HINT,
};

export const importErrorMessage = (error: unknown) => refusalMessage(error, REFUSALS);

export function ImportsHome() {
  const { can } = useCapabilities();
  const me = useSchoolMe();
  const blocked = useBlockedActions();
  const isPrincipal = (me.data?.roles ?? []).includes('principal');
  const kinds: ImportKind[] = [
    ...(can(Capability.RESULT_PUBLISH) && can(Capability.ASSESSMENT_DEFINE) ? (['past_results'] as const) : []),
    ...(can(Capability.CHARGE_CREATE) && isPrincipal ? (['opening_balances'] as const) : []),
  ];
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Imports"
        description="Bring in the results and fee balances a school had before it moved onto this system. Every file is checked and shown to you before anything is saved."
      />
      <div className="grid gap-6">
        {me.isPending ? null : kinds.length === 0 ? (
          <Alert>
            <AlertDescription>Only the principal imports results and opening balances.</AlertDescription>
          </Alert>
        ) : (
          <NewImport kinds={kinds} balancesBlocked={blocked('import.opening_balances')} onPreviewed={setOpenId} />
        )}
        {openId !== null && <ImportPanel id={openId} onClose={() => setOpenId(null)} />}
        <History onOpen={setOpenId} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------- the upload form

function NewImport({
  kinds,
  balancesBlocked,
  onPreviewed,
}: {
  kinds: ImportKind[];
  balancesBlocked: boolean;
  onPreviewed: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const ids = { kind: useId(), section: useId(), term: useId(), due: useId(), file: useId() };
  const [kind, setKind] = useState<ImportKind>(kinds[0] ?? 'past_results');
  const [chosenYear, setChosenYear] = useState('');
  const yearId = useDefaultYearId(chosenYear);
  const sections = useYearSections(yearId, { enabled: kind === 'past_results' });
  const terms = useTerms(kind === 'past_results' ? yearId : '');
  const [sectionId, setSectionId] = useState('');
  const [termId, setTermId] = useState('');
  const today = todayInSchool();
  const [dueOn, setDueOn] = useState(today);
  const [file, setFile] = useState<File | null>(null);
  // One key per form; a new one once it has been spent on another body (IDEMPOTENCY_KEY_REUSED).
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const fileProblem =
    file === null
      ? null
      : file.size === 0
        ? 'The file is empty.'
        : file.size > MAX_IMPORT_BYTES
          ? 'The file is larger than 2 MB.'
          : !/\.csv$/i.test(file.name)
            ? 'Choose a .csv file (in Excel: Save As → CSV UTF-8).'
            : null;
  const ready =
    file !== null &&
    fileProblem === null &&
    (kind === 'past_results' ? sectionId !== '' && termId !== '' : yearId !== '' && dueOn >= today) &&
    !(kind === 'opening_balances' && balancesBlocked);

  const preview = useMutation({
    mutationFn: () => {
      if (file === null) throw new Error('no file');
      return kind === 'past_results'
        ? previewPastResults({ sectionId, termId }, file, idempotencyKey)
        : previewOpeningBalances({ academicYearId: yearId, dueOn }, file, idempotencyKey);
    },
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: importKeys.lists });
      queryClient.setQueryData(importKeys.detail(detail.id), detail);
      setIdempotencyKey(newIdempotencyKey());
      setFile(null);
      onPreviewed(detail.id);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>New import</CardTitle>
        <CardDescription>
          {kind === 'past_results'
            ? 'One file per section and term: admission_no, then one column per subject, named as the class’s subjects are, with the exam mark or Ab. Every student of the section must be listed. No message is sent.'
            : 'One file per year: admission_no, amount (whole rupees above 0) and an optional note. Each row becomes an "Opening balance" charge, due on the date you choose. A credit is taken at the counter, not imported.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) preview.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.kind}>What to import</Label>
              <NativeSelect
                id={ids.kind}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as ImportKind);
                  preview.reset();
                }}
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <YearFilter
              value={yearId}
              onChange={(id) => {
                setChosenYear(id);
                setSectionId('');
                setTermId('');
              }}
            />
            {kind === 'past_results' ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.section}>Section</Label>
                  <NativeSelect id={ids.section} value={sectionId} disabled={sections.isPending} onChange={(e) => setSectionId(e.target.value)}>
                    <option value="">Choose a section</option>
                    {(sections.data ?? []).map((klass) =>
                      klass.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {klass.name} {s.name}
                        </option>
                      )),
                    )}
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.term}>Term</Label>
                  <NativeSelect id={ids.term} value={termId} disabled={terms.isPending} onChange={(e) => setTermId(e.target.value)}>
                    <option value="">Choose a term</option>
                    {(terms.data ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor={ids.due}>Due on</Label>
                <Input id={ids.due} type="date" min={today} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
              </div>
            )}
          </div>
          <div className="grid gap-1.5 sm:max-w-md">
            <Label htmlFor={ids.file}>CSV file</Label>
            <Input
              id={ids.file}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                preview.reset();
              }}
            />
            {fileProblem && <p className="text-sm text-destructive">{fileProblem}</p>}
          </div>
          {kind === 'opening_balances' && balancesBlocked && (
            <Alert>
              <AlertDescription>{DEFAULT_PASSWORD_HINT}</AlertDescription>
            </Alert>
          )}
          {preview.error && (
            <Alert variant="destructive">
              <AlertDescription>{importErrorMessage(preview.error)}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button type="submit" disabled={!ready || preview.isPending}>
              <FileUpIcon aria-hidden />
              {preview.isPending ? 'Checking…' : 'Upload and check'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------------- one import: preview

function ImportPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const blocked = useBlockedActions();
  const detail = useQuery({
    queryKey: importKeys.detail(id),
    queryFn: () => unwrap(importsApi.GET('/api/v1/imports/{id}', { params: { path: { id } } })),
  });
  const [idempotencyKey] = useState(newIdempotencyKey);
  const commit = useMutation({
    mutationFn: () => commitImport(id, idempotencyKey),
    onSuccess: (done) => {
      queryClient.setQueryData(importKeys.detail(id), done);
      void queryClient.invalidateQueries({ queryKey: importKeys.lists });
    },
  });
  return (
    <section aria-label="Import preview">
      <QueryStates query={detail} notFound={{ title: 'Import not found', description: 'It may belong to another kind you cannot import.' }}>
        {(row) => (
          <Card>
            <CardHeader className="gap-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="grid gap-1">
                  <CardTitle>
                    {KIND_LABELS[row.kind]} · {targetOf(row)}
                  </CardTitle>
                  <CardDescription>
                    <span className="break-all">{row.fileName}</span> · {row.rowCount} {row.rowCount === 1 ? 'row' : 'rows'} · checked by{' '}
                    {row.createdByName} {formatDateTime(row.createdAt)}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(row.status)}>{STATUS_LABELS[row.status]}</Badge>
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    Close
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Outcome row={row} />
              {row.errorCount > 0 && <RowErrors row={row} />}
              {row.rows.length > 0 && <PreviewRows row={row} />}
              {commit.error && (
                <Alert variant="destructive">
                  <AlertDescription>{importErrorMessage(commit.error)}</AlertDescription>
                </Alert>
              )}
              {row.status === 'previewed' && row.errorCount === 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    onClick={() => commit.mutate()}
                    disabled={commit.isPending || (row.kind === 'opening_balances' && blocked('import.opening_balances'))}
                    title={row.kind === 'opening_balances' && blocked('import.opening_balances') ? DEFAULT_PASSWORD_HINT : undefined}
                  >
                    {commit.isPending ? 'Committing…' : row.kind === 'past_results' ? 'Commit results' : 'Commit balances'}
                  </Button>
                  <p className="text-sm text-muted-foreground">Commit before {formatDateTime(row.expiresAt)}, or upload the file again.</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </QueryStates>
    </section>
  );
}

function targetOf(row: ImportDto): string {
  return row.kind === 'past_results'
    ? `${row.className ?? ''} ${row.sectionName ?? ''} · ${row.termName ?? ''} · ${row.academicYearName}`
    : `${row.academicYearName} · due ${row.dueOn === null ? '—' : formatDate(row.dueOn)}`;
}

function Outcome({ row }: { row: ImportDetailDto }) {
  if (row.status === 'committed') {
    return (
      <Alert>
        <CheckCircle2Icon aria-hidden />
        <AlertTitle>Committed {row.committedAt ? formatDateTime(row.committedAt) : ''}</AlertTitle>
        <AlertDescription>
          {row.kind === 'past_results' ? (
            <>
              The section’s results are published as imported; no message was sent.{' '}
              {row.resultSheetId && (
                <Link className="underline underline-offset-4" href={`/results/sheets/${row.resultSheetId}`}>
                  Open the result sheet
                </Link>
              )}
            </>
          ) : (
            'Each row is now an Opening balance charge on the student’s fee statement.'
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (row.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {row.error === 'expired' ? 'This preview expired before it was committed. Upload the file again.' : 'This import failed.'}
        </AlertDescription>
      </Alert>
    );
  }
  return row.errorCount > 0 ? (
    <Alert variant="destructive">
      <AlertTitle>
        {row.errorCount} {row.errorCount === 1 ? 'problem' : 'problems'} found
      </AlertTitle>
      <AlertDescription>Nothing has been saved. Correct the file and upload it again; a file with any problem cannot be committed.</AlertDescription>
    </Alert>
  ) : (
    <Alert>
      <AlertDescription>
        Every row is valid. Check the table, then commit.
        {row.kind === 'opening_balances' &&
          row.totalAmount !== null &&
          ` ${formatRupees(row.totalAmount)} in all${row.totalAdvance ? `, of which ${formatRupees(row.totalAdvance)} is paid at once from advances already held` : ''}.`}
      </AlertDescription>
    </Alert>
  );
}

function RowErrors({ row }: { row: ImportDetailDto }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-medium">
        Problems{row.errorCount > row.errors.length ? ` (the first ${row.errors.length} of ${row.errorCount})` : ''}
      </h3>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Line</TableHead>
              <TableHead>Column</TableHead>
              <TableHead>Problem</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {row.errors.map((e, i) => (
              <TableRow key={`${e.row}-${e.field}-${i}`}>
                <TableCell className="px-4 tabular-nums">{e.row === 0 ? '—' : e.row === 1 ? 'Header' : e.row}</TableCell>
                <TableCell className="break-all">{e.field}</TableCell>
                <TableCell>
                  {ROW_ERROR_LABELS[e.code]}
                  {e.admissionNo && <span className="text-muted-foreground"> (admission no. {e.admissionNo})</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PreviewRows({ row }: { row: ImportDetailDto }) {
  const results = row.kind === 'past_results';
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="px-4">Line</TableHead>
            <TableHead>Student</TableHead>
            {results ? (
              row.subjects.map((s) => (
                <TableHead key={s.classSubjectId} className="text-right">
                  {s.name}
                  <span className="block text-xs font-normal text-muted-foreground">of {s.maxMarks}</span>
                </TableHead>
              ))
            ) : (
              <>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="text-right">Paid from advance</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {row.rows.map((r) => (
            <TableRow key={r.row}>
              <TableCell className="px-4 tabular-nums">{r.row}</TableCell>
              <TableCell>
                <span className="font-medium">{r.studentName}</span>
                <span className="block text-xs text-muted-foreground">{r.admissionNo}</span>
              </TableCell>
              {results ? (
                (r.marks ?? []).map((m) => (
                  <TableCell key={m.classSubjectId} className="text-right tabular-nums">
                    {m.obtained === null ? 'Ab' : m.obtained}
                  </TableCell>
                ))
              ) : (
                <>
                  <TableCell className="text-right tabular-nums">{r.amount === null ? '—' : formatRupees(r.amount)}</TableCell>
                  <TableCell className="break-words">{r.note ?? ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.advance ? formatRupees(r.advance) : '—'}</TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ------------------------------------------------------------------------------------ history

function History({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useListPage([]);
  const query = { page, limit: LIMIT };
  const list = useQuery({
    queryKey: importKeys.list(query),
    queryFn: () => unwrap(importsApi.GET('/api/v1/imports', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ImportDto>();
    return [
      column.accessor('createdAt', {
        header: 'Checked',
        cell: (info) => <span className="whitespace-nowrap">{formatDateTime(info.getValue())}</span>,
      }),
      column.accessor('kind', { header: 'Kind', cell: (info) => KIND_LABELS[info.getValue()] }),
      column.display({ id: 'target', header: 'For', cell: (info) => targetOf(info.row.original) }),
      column.accessor('fileName', { header: 'File', cell: (info) => <span className="break-all">{info.getValue()}</span> }),
      column.accessor('rowCount', {
        header: () => <span className="block text-right">Rows</span>,
        cell: (info) => <span className="block text-right tabular-nums">{info.getValue()}</span>,
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => {
          const r = info.row.original;
          return (
            <Badge variant={statusVariant(r.status)}>
              {r.status === 'previewed' && r.errorCount > 0 ? `${r.errorCount} problems` : STATUS_LABELS[r.status]}
            </Badge>
          );
        },
      }),
      column.display({
        id: 'open',
        header: () => <span className="sr-only">Open</span>,
        cell: (info) => (
          <Button variant="outline" size="sm" onClick={() => onOpen(info.row.original.id)}>
            View
          </Button>
        ),
      }),
    ];
  }, [onOpen]);
  return (
    <section className="grid gap-3" aria-label="Import history">
      <h2 className="text-base font-semibold">History</h2>
      <DataTable
        columns={columns}
        query={list}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No imports yet"
        emptyDescription="Files you upload and check appear here, committed or not."
      />
    </section>
  );
}
