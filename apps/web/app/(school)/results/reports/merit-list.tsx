'use client';

import { formatPercentLabel } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DataTable, type DataTableFeatures, type PageQuery } from '@/components/data-table';
import { DownloadCsvButton } from '@/components/download-csv-button';
import { FilterSelect } from '@/components/list-filters';
import { EmptyState, StateCard } from '@/components/page-states';
import { unwrap } from '@/lib/api/client';
import { myResultsApi, type MeritListDto, type MeritListQuery, type MeritListRowDto } from '@/lib/api/school-my-results-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useClasses } from '../../academics/_lib/options';
import { ReportStates, useTerms } from '../../reports/_lib/reports-ui';

// The class merit list (Phase 5 slice 42, R333; contracts/slice-42.md §2.2): every pupil of a
// class in a term across its sections, best first, from the live class ranking. The ranking is
// made once every section has published the term; until then it is pending, naming the sections
// still to publish.

const LIMIT = 25;

const TRIGGER_LABELS: Record<NonNullable<MeritListDto['trigger']>, string> = {
  publish: 'a section published',
  correction: 'a correction',
  import: 'past results were imported',
};

/** "3 of 41"; "—" for a pupil with nothing assessed. */
const positionLabel = (position: number | null, of: number | null) =>
  position === null ? '—' : of === null ? String(position) : `${position} of ${of}`;

export function MeritListTab({ yearId }: { yearId: string }) {
  const [classId, setClassId] = useState('');
  const [termId, setTermId] = useState('');
  const terms = useTerms(yearId);
  const classes = useClasses(yearId);
  const [page, setPage] = useListPage([classId, termId]);
  const ready = classId !== '' && termId !== '';
  const query: MeritListQuery = { classId, termId, page, limit: LIMIT };
  const list = useQuery({
    queryKey: ['result-reports', 'merit-list', query] as const,
    queryFn: () => unwrap(myResultsApi.GET('/api/v1/result-reports/merit-list', { params: { query } })),
    enabled: ready,
    placeholderData: keepPreviousData,
  });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Class" value={classId} onChange={setClassId} disabled={classes.isPending} className="sm:w-48">
          <option value="">Choose a class</option>
          {(classes.data?.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Term" value={termId} onChange={setTermId} disabled={terms.isPending} className="sm:w-48">
          <option value="">Choose a term</option>
          {(terms.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </FilterSelect>
        <div className="sm:ml-auto">
          <DownloadCsvButton
            path="/api/v1/result-reports/merit-list"
            filters={query}
            disabled={!ready || list.isFetching || list.data?.status !== 'ranked' || list.data.total === 0}
          />
        </div>
      </div>
      {!ready ? (
        <StateCard>
          <EmptyState title="Choose a class and a term" description="The merit list ranks the whole class across its sections." />
        </StateCard>
      ) : (
        <ReportStates query={list}>
          {(data) => <MeritList data={data} query={list} page={page} onPageChange={setPage} />}
        </ReportStates>
      )}
    </div>
  );
}

function MeritList({
  data,
  query,
  page,
  onPageChange,
}: {
  data: MeritListDto;
  query: PageQuery<MeritListRowDto>;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, MeritListRowDto>();
    return [
      column.accessor('classPosition', {
        header: 'Position',
        cell: (info) => (
          <span className="tabular-nums whitespace-nowrap">{positionLabel(info.getValue(), info.row.original.positionOf)}</span>
        ),
      }),
      column.accessor('studentName', {
        header: 'Student',
        cell: (info) => (
          <Link href={`/students/${info.row.original.studentId}`} className="font-medium hover:underline">
            {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('admissionNo', { header: 'Admission no.' }),
      column.accessor('sectionName', { header: 'Section' }),
      column.accessor('percentBp', {
        header: 'Percent',
        cell: (info) => <span className="tabular-nums">{formatPercentLabel(info.getValue())}</span>,
      }),
      column.accessor('grade', { header: 'Grade', cell: (info) => info.getValue() ?? '—' }),
    ];
  }, []);

  if (data.status === 'not_held') {
    return (
      <StateCard>
        <EmptyState title="This class does not hold this term" description={`${data.className} skips ${data.termName}.`} />
      </StateCard>
    );
  }
  if (data.status === 'pending') {
    const names = data.pendingSections.map((s) => s.sectionName);
    return (
      <StateCard>
        <EmptyState
          title="Ranking pending"
          description={
            names.length > 0
              ? `Waiting for ${names.length === 1 ? 'section' : 'sections'} ${names.join(', ')} to publish.`
              : 'Waiting for every section to publish the term.'
          }
        />
      </StateCard>
    );
  }
  return (
    <div className="grid gap-3" data-testid="merit-list">
      <p className="text-sm text-muted-foreground">
        {data.className} · {data.termName}
        {data.computedAt && ` · Ranked ${formatDateTime(data.computedAt)}`}
        {data.trigger && `, after ${TRIGGER_LABELS[data.trigger]}`}
      </p>
      <DataTable
        columns={columns}
        query={query}
        getRowId={(row) => row.resultId}
        page={page}
        limit={LIMIT}
        onPageChange={onPageChange}
        emptyTitle="Nobody ranked"
        emptyDescription="The class had no pupils with a published result for this term."
      />
    </div>
  );
}
