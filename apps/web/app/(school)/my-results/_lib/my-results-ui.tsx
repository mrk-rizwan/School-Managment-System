'use client';

import { EXAM_MARKER_LEGEND, examMarker, formatPercentLabel, formatRupees, resultTermLabel } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import {
  myResultsApi,
  type MyAssessmentMarkDto,
  type MyChildResultsDto,
  type MyResultDto,
  type MyResultSummaryDto,
  type ResultDto,
} from '@/lib/api/school-my-results-contract';
import { formatDate, formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';

// contracts/slice-33.md §5: the report card on screen and the family's results view, shared by
// My children → Results (a guardian, per child), My results (the student) and the student page.
// Only published, live results ever arrive here (R274); a withheld card arrives as null (R282).

/** Whose results: a guardian's child (by id) or the student login's own. */
export type ResultsSource = { kind: 'guardian'; studentId: string } | { kind: 'student' };

export const myResultsKeys = {
  all: ['school', 'my-results'] as const,
  list: (source: ResultsSource, yearId: string) => ['school', 'my-results', source, 'list', yearId] as const,
  card: (source: ResultsSource, resultId: string) => ['school', 'my-results', source, 'card', resultId] as const,
  tests: (source: ResultsSource, query: object) => ['school', 'my-results', source, 'tests', query] as const,
  student: (studentId: string, page: number) => ['school', 'student-results', studentId, page] as const,
};

/**
 * The report card (plan §3.4): exactly the stored row (R279) — the per-subject table, totals,
 * percentage, grade, position, attendance and remark as the school's toggles allow, and "Revised"
 * or "Superseded" when it is one.
 */
export function ReportCard({ result }: { result: ResultDto }) {
  const place = [result.className, result.sectionName].filter(Boolean).join(' – ');
  return (
    <Card data-testid={`reportCard.${result.id}`}>
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <CardDescription>{result.schoolName}</CardDescription>
            <CardTitle>
              {resultTermLabel(result)} · {result.academicYearName}
            </CardTitle>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {result.supersededAt && <Badge variant="destructive">Superseded</Badge>}
            {result.revised && result.publishedAt && (
              <Badge variant="secondary">Revised {formatDate(result.publishedAt)}</Badge>
            )}
          </div>
        </div>
        <p className="text-sm">
          <span className="font-medium">{result.studentName}</span>
          <span className="text-muted-foreground">
            {' '}
            · Admission no. {result.admissionNo} · {place}
            {result.rollNo !== null && ` · Roll no. ${result.rollNo}`}
          </span>
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-3">Subject</TableHead>
                <TableHead className="px-3 text-right">Marks</TableHead>
                <TableHead className="px-3 text-right">Percentage</TableHead>
                <TableHead className="px-3 text-right">Grade</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.subjects.map((s) => (
                <TableRow key={s.classSubjectId}>
                  <TableCell className="px-3">
                    {s.subjectName}
                    {examMarker(s) && (
                      <Badge variant="outline" className="ml-2" data-testid={`reportCard.marker.${s.classSubjectId}`}>
                        {examMarker(s)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-3 text-right tabular-nums">
                    {s.obtained === null ? '—' : `${s.obtained} / ${s.max}`}
                  </TableCell>
                  <TableCell className="px-3 text-right tabular-nums">{formatPercentLabel(s.percentBp)}</TableCell>
                  <TableCell className="px-3 text-right">{s.grade ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="px-3 font-medium">Total</TableCell>
                <TableCell className="px-3 text-right font-medium tabular-nums">
                  {result.totalObtained} / {result.totalMax}
                </TableCell>
                <TableCell className="px-3 text-right font-medium tabular-nums" data-testid="reportCard.percent">
                  {formatPercentLabel(result.percentBp)}
                </TableCell>
                <TableCell className="px-3 text-right font-medium">{result.grade ?? '—'}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        {result.subjects.some((s) => examMarker(s) !== null) && (
          <p className="text-muted-foreground text-xs" data-testid="reportCard.legend">
            {EXAM_MARKER_LEGEND}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Figure label="Result" value={result.passed === null ? '—' : result.passed ? 'Passed' : 'Not passed'} />
          {result.showPosition && (
            <Figure
              label="Position"
              value={result.position === null ? '—' : `${result.position} of ${result.positionOf ?? '—'}`}
            />
          )}
          {result.showAttendance && <Figure label="Attendance" value={formatPercentLabel(result.attendanceBp)} />}
        </dl>
        {result.showRemark && result.remark && (
          <div className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Class teacher’s remark</span>
            <p>{result.remark}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function fetchResults(source: ResultsSource, yearId: string): Promise<MyChildResultsDto> {
  const query = yearId ? { academicYearId: yearId } : {};
  return source.kind === 'guardian'
    ? unwrap(
        myResultsApi.GET('/api/v1/me/children/{id}/results', {
          params: { path: { id: source.studentId }, query },
        }),
      )
    : unwrap(myResultsApi.GET('/api/v1/me/student/results', { params: { query } }));
}

function fetchCard(source: ResultsSource, resultId: string): Promise<MyResultDto> {
  return source.kind === 'guardian'
    ? unwrap(
        myResultsApi.GET('/api/v1/me/children/{id}/results/{resultId}', {
          params: { path: { id: source.studentId, resultId } },
        }),
      )
    : unwrap(myResultsApi.GET('/api/v1/me/student/results/{resultId}', { params: { path: { resultId } } }));
}

/** The family's results: the year's terms and final, the chosen card, and the class tests. */
export function ResultsView({ source }: { source: ResultsSource }) {
  const [yearId, setYearId] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const yearSelect = useId();
  const list = useQuery({
    queryKey: myResultsKeys.list(source, yearId),
    queryFn: () => fetchResults(source, yearId),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="grid gap-6">
      <QueryStates query={list} loadingRows={3}>
        {(data) => {
          const results = [...data.terms, ...(data.final ? [data.final] : [])];
          const selected = results.find((r) => r.id === chosen) ?? results[results.length - 1] ?? null;
          return (
            <div className="grid gap-4">
              {data.years.length > 1 && (
                <div className="grid w-full gap-1.5 sm:w-48">
                  <Label htmlFor={yearSelect}>Academic year</Label>
                  <NativeSelect
                    id={yearSelect}
                    value={data.academicYearId ?? ''}
                    onChange={(e) => {
                      setYearId(e.target.value);
                      setChosen(null);
                    }}
                  >
                    {data.years.map((y) => (
                      <option key={y.id} value={y.id}>
                        {y.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )}
              {data.withheld && <WithheldNotice student={source.kind === 'student'} outstanding={data.outstanding} />}
              {results.length === 0 ? (
                <StateCard>
                  <EmptyState
                    title="No results published yet"
                    description="A term result appears here once the school publishes it."
                  />
                </StateCard>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Published results">
                    {results.map((r) => (
                      <SummaryChip
                        key={r.id}
                        summary={r}
                        active={selected?.id === r.id}
                        onSelect={() => setChosen(r.id)}
                      />
                    ))}
                  </div>
                  {selected && <CardFor source={source} summary={selected} />}
                </>
              )}
            </div>
          );
        }}
      </QueryStates>
      <ClassTests source={source} />
    </div>
  );
}

function WithheldNotice({ student, outstanding }: { student: boolean; outstanding: number | null }) {
  // Security L3: a student is never told why (no mention of fees); the family is.
  if (student) {
    return (
      <Alert data-testid="myResults.withheld">
        <AlertTitle>Report card not available</AlertTitle>
        <AlertDescription>Please ask your parent or the school office.</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert data-testid="myResults.withheld">
      <AlertTitle>Report card held back for unpaid fees</AlertTitle>
      <AlertDescription>
        {outstanding !== null
          ? `${formatRupees(outstanding)} is owed. The full report card shows here once the fees are paid; contact the school office.`
          : 'The full report card shows here once the school says the fees are cleared.'}
      </AlertDescription>
    </Alert>
  );
}

function SummaryChip({
  summary,
  active,
  onSelect,
}: {
  summary: MyResultSummaryDto;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      data-testid={`myResults.summary.${summary.id}`}
      className={cn(
        'grid min-w-36 gap-0.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
        active ? 'border-primary bg-primary/5' : 'hover:bg-muted',
      )}
    >
      <span className="font-medium">{resultTermLabel(summary)}</span>
      <span className="tabular-nums text-muted-foreground">
        {formatPercentLabel(summary.percentBp)}
        {summary.grade && ` · ${summary.grade}`}
        {summary.revised && ' · Revised'}
      </span>
    </button>
  );
}

function CardFor({ source, summary }: { source: ResultsSource; summary: MyResultSummaryDto }) {
  const card = useQuery({
    queryKey: myResultsKeys.card(source, summary.id),
    queryFn: () => fetchCard(source, summary.id),
  });
  return (
    <QueryStates
      query={card}
      loadingRows={6}
      notFound={{ title: 'Result not available', description: 'It may have been replaced by a corrected result.' }}
    >
      {(data) => (data.result ? <ReportCard result={data.result} /> : null)}
    </QueryStates>
  );
}

const TESTS_LIMIT = 20;

/** Class tests as entered (R286): tests only, newest first. */
function ClassTests({ source }: { source: ResultsSource }) {
  const [page, setPage] = useState(1);
  const query = { page, limit: TESTS_LIMIT };
  const tests = useQuery({
    queryKey: myResultsKeys.tests(source, query),
    queryFn: () =>
      source.kind === 'guardian'
        ? unwrap(
            myResultsApi.GET('/api/v1/me/children/{id}/assessments', {
              params: { path: { id: source.studentId }, query },
            }),
          )
        : unwrap(myResultsApi.GET('/api/v1/me/student/assessments', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Class tests</CardTitle>
        <CardDescription>Marks appear as the teacher enters them.</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStates query={tests} loadingRows={3}>
          {(data) =>
            data.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No class test has been marked yet.</p>
            ) : (
              <div className="grid gap-3">
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="px-3">Date</TableHead>
                        <TableHead className="px-3">Subject</TableHead>
                        <TableHead className="px-3">Test</TableHead>
                        <TableHead className="px-3 text-right">Marks</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.data.map((t) => (
                        <TableRow key={t.markId} data-testid={`myResults.test.${t.assessmentId}`}>
                          <TableCell className="px-3 whitespace-nowrap">{formatDay(t.heldOn)}</TableCell>
                          <TableCell className="px-3">{t.subjectName}</TableCell>
                          <TableCell className="px-3">
                            {t.name}
                            <span className="text-muted-foreground"> · {t.termName}</span>
                          </TableCell>
                          <TableCell className="px-3 text-right tabular-nums">{testMarks(t)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {data.total > TESTS_LIMIT && (
                  <div className="flex items-center justify-end gap-2 text-sm">
                    <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                      Newer
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page * TESTS_LIMIT >= data.total}
                      onClick={() => setPage(page + 1)}
                    >
                      Older
                    </Button>
                  </div>
                )}
              </div>
            )
          }
        </QueryStates>
      </CardContent>
    </Card>
  );
}

const testMarks = (t: MyAssessmentMarkDto): string =>
  t.absent ? (t.excused ? 'Excused' : 'Absent') : `${t.obtained ?? 0} / ${t.maxMarks}`;
