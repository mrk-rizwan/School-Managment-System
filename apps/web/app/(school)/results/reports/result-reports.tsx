'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, StateCard } from '@/components/page-states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { academics } from '@/lib/api/school-academics-contract';
import {
  myResultsApi,
  type SectionSummaryReportDto,
  type SubjectReportDto,
} from '@/lib/api/school-my-results-contract';
import { resultsApi } from '@/lib/api/school-results-contract';
import { cn } from '@/lib/utils';
import { useClasses } from '../../academics/_lib/options';
import { ReportStates, useDefaultYearId, YearFilter } from '../../reports/_lib/reports-ui';
import { percentText } from '../../my-results/_lib/my-results-ui';

// contracts/slice-33.md §3, §5: Results → Reports, read with marks.view_all from the stored rows
// (R287): a published section sheet's summary, and one subject of a class in a term across its
// sections.

type Tab = 'section' | 'subject';

const reportKeys = {
  terms: (yearId: string) => ['result-reports', 'terms', yearId] as const,
  sheets: (termId: string) => ['result-reports', 'sheets', termId] as const,
  subjects: (classId: string) => ['result-reports', 'class-subjects', classId] as const,
  summary: (sheetId: string) => ['result-reports', 'summary', sheetId] as const,
  subject: (termId: string, classSubjectId: string) => ['result-reports', 'subject', termId, classSubjectId] as const,
};

export function ResultReports() {
  const [tab, setTab] = useState<Tab>('section');
  const [chosenYear, setChosenYear] = useState('');
  const yearId = useDefaultYearId(chosenYear);
  return (
    <>
      <PageHeader title="Result reports" description="Pass rates, averages and grades from the published results." />
      <div role="tablist" aria-label="Result reports" className="mb-6 flex flex-wrap gap-1 border-b">
        {(
          [
            ['section', 'Section summary'],
            ['subject', 'Subject'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab === value
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <YearFilter value={yearId} onChange={setChosenYear} />
      </div>
      {tab === 'section' ? <SectionTab key={yearId} yearId={yearId} /> : <SubjectTab key={yearId} yearId={yearId} />}
    </>
  );
}

function useTerms(yearId: string) {
  return useQuery({
    queryKey: reportKeys.terms(yearId),
    queryFn: async () =>
      (
        await unwrap(
          academics.GET('/api/v1/academic-years/{id}/terms', { params: { path: { id: yearId }, query: { limit: 10 } } }),
        )
      ).data,
    enabled: yearId !== '',
  });
}

function Select({
  label,
  value,
  onChange,
  disabled,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  options: readonly { value: string; label: string }[];
  placeholder: string;
}) {
  const id = useId();
  return (
    <div className="grid w-full gap-1.5 sm:w-48">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function SectionTab({ yearId }: { yearId: string }) {
  const [termId, setTermId] = useState('');
  const [sheetId, setSheetId] = useState('');
  const terms = useTerms(yearId);
  const sheets = useQuery({
    queryKey: reportKeys.sheets(termId),
    queryFn: () =>
      unwrap(
        resultsApi.GET('/api/v1/result-sheets', {
          params: {
            query: {
              limit: OPTIONS_LIMIT,
              status: 'published',
              ...(termId === 'final' ? { final: 'true' as const } : { termId }),
            },
          },
        }),
      ),
    enabled: termId !== '',
  });
  const summary = useQuery({
    queryKey: reportKeys.summary(sheetId),
    queryFn: () =>
      unwrap(myResultsApi.GET('/api/v1/result-reports/section-summary', { params: { query: { sheetId } } })),
    enabled: sheetId !== '',
    placeholderData: keepPreviousData,
  });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Term"
          value={termId}
          placeholder="Choose a term"
          disabled={terms.isPending}
          onChange={(v) => {
            setTermId(v);
            setSheetId('');
          }}
          options={[...(terms.data ?? []).map((t) => ({ value: t.id, label: t.name })), { value: 'final', label: 'Final result' }]}
        />
        <Select
          label="Section"
          value={sheetId}
          placeholder={termId && sheets.data?.data.length === 0 ? 'None published' : 'Choose a section'}
          disabled={!termId || sheets.isPending}
          onChange={setSheetId}
          // A corrected section has a published version per correction: each is listed, the
          // newest first, so the summary of what the families were shown at each step stays readable.
          options={[...(sheets.data?.data ?? [])]
            .sort(
              (a, b) =>
                a.className.localeCompare(b.className) ||
                a.sectionName.localeCompare(b.sectionName) ||
                b.version - a.version,
            )
            .map((s) => ({ value: s.id, label: `${s.className} – ${s.sectionName} · version ${s.version}` }))}
        />
      </div>
      {sheetId === '' ? (
        <StateCard>
          <EmptyState title="Choose a published section sheet" description="Pick a term, then a section." />
        </StateCard>
      ) : (
        <ReportStates query={summary}>{(data) => <SectionSummary report={data} />}</ReportStates>
      )}
    </div>
  );
}

function SectionSummary({ report }: { report: SectionSummaryReportDto }) {
  return (
    <div className="grid gap-4" data-testid="resultReports.summary">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Students" value={String(report.students)} />
        <Tile label="Passed" value={String(report.passed)} testId="resultReports.passed" />
        <Tile label="Not passed" value={String(report.failed)} />
        <Tile label="Average" value={percentText(report.averageBp)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            {report.className} – {report.sectionName} · {report.termName ?? 'Final result'}
          </CardTitle>
          <CardDescription>
            Grades: {report.grades.length === 0 ? '—' : report.grades.map((g) => `${g.grade} ${g.count}`).join(' · ')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-3">Subject</TableHead>
                  <TableHead className="px-3 text-right">Assessed</TableHead>
                  <TableHead className="px-3 text-right">Passed</TableHead>
                  <TableHead className="px-3 text-right">Not passed</TableHead>
                  <TableHead className="px-3 text-right">Average</TableHead>
                  <TableHead className="px-3">Grades</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.subjects.map((s) => (
                  <TableRow key={s.classSubjectId}>
                    <TableCell className="px-3">{s.subjectName}</TableCell>
                    <TableCell className="px-3 text-right tabular-nums">{s.assessed}</TableCell>
                    <TableCell className="px-3 text-right tabular-nums">{s.passed}</TableCell>
                    <TableCell className="px-3 text-right tabular-nums">{s.failed}</TableCell>
                    <TableCell className="px-3 text-right tabular-nums">{percentText(s.averageBp)}</TableCell>
                    <TableCell className="px-3 text-muted-foreground">
                      {s.grades.map((g) => `${g.grade} ${g.count}`).join(' · ') || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function SubjectTab({ yearId }: { yearId: string }) {
  const [termId, setTermId] = useState('');
  const [classId, setClassId] = useState('');
  const [classSubjectId, setClassSubjectId] = useState('');
  const terms = useTerms(yearId);
  const classes = useClasses(yearId);
  const subjects = useQuery({
    queryKey: reportKeys.subjects(classId),
    queryFn: () =>
      unwrap(
        academics.GET('/api/v1/classes/{id}/subjects', {
          params: { path: { id: classId }, query: { limit: OPTIONS_LIMIT } },
        }),
      ),
    enabled: classId !== '',
  });
  const ready = termId !== '' && classSubjectId !== '';
  const report = useQuery({
    queryKey: reportKeys.subject(termId, classSubjectId),
    queryFn: () =>
      unwrap(myResultsApi.GET('/api/v1/result-reports/subject', { params: { query: { termId, classSubjectId } } })),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Term"
          value={termId}
          placeholder="Choose a term"
          disabled={terms.isPending}
          onChange={setTermId}
          options={(terms.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
        />
        <Select
          label="Class"
          value={classId}
          placeholder="Choose a class"
          disabled={classes.isPending}
          onChange={(v) => {
            setClassId(v);
            setClassSubjectId('');
          }}
          options={(classes.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          label="Subject"
          value={classSubjectId}
          placeholder="Choose a subject"
          disabled={!classId || subjects.isPending}
          onChange={setClassSubjectId}
          options={(subjects.data?.data ?? []).map((s) => ({ value: s.id, label: s.subjectName }))}
        />
      </div>
      {!ready ? (
        <StateCard>
          <EmptyState title="Choose a term, class and subject" description="The report compares the class’s sections." />
        </StateCard>
      ) : (
        <ReportStates query={report}>{(data) => <SubjectReport report={data} />}</ReportStates>
      )}
    </div>
  );
}

function SubjectReport({ report }: { report: SubjectReportDto }) {
  if (report.sections.length === 0) {
    return (
      <StateCard>
        <EmptyState title="No results yet" description="No section of this class has an approved result for the term." />
      </StateCard>
    );
  }
  const names = (list: SubjectReportDto['sections'][number]['top']) =>
    list.map((s) => `${s.fullName} (${percentText(s.percentBp)})`).join(', ') || '—';
  return (
    <Card data-testid="resultReports.subject">
      <CardHeader>
        <CardTitle>
          {report.subjectName} · {report.className} · {report.termName}
        </CardTitle>
        <CardDescription>
          {report.assessed} assessed · average {percentText(report.averageBp)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-3">Section</TableHead>
                <TableHead className="px-3 text-right">Assessed</TableHead>
                <TableHead className="px-3 text-right">Average</TableHead>
                <TableHead className="px-3">Highest</TableHead>
                <TableHead className="px-3">Lowest</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.sections.map((s) => (
                <TableRow key={s.sectionId}>
                  <TableCell className="px-3">
                    {s.sectionName}
                    {!s.published && <span className="text-muted-foreground"> · not yet published</span>}
                  </TableCell>
                  <TableCell className="px-3 text-right tabular-nums">{s.assessed}</TableCell>
                  <TableCell className="px-3 text-right tabular-nums">{percentText(s.averageBp)}</TableCell>
                  <TableCell className="px-3">{names(s.top)}</TableCell>
                  <TableCell className="px-3">{names(s.bottom)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
