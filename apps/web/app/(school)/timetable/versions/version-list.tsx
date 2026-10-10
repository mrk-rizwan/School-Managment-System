'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, RowActions } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import {
  timetableApi,
  type TimetableVersionDto,
  type TimetableVersionListQuery,
  type TimetableVersionStatus,
} from '@/lib/api/school-timetable-contract';
import { formatDate, formatDay, todayInSchool } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useDefaultYearId, YearFilter } from '../../reports/_lib/reports-ui';
import {
  SectionSelect,
  timetableErrorMessage,
  timetableKeys,
  VERSION_STATUS_LABELS,
  versionStatusVariant,
  weekHref,
} from '../_lib/timetable-ui';

const LIMIT = 25;
const STATUSES: TimetableVersionStatus[] = ['live', 'future', 'past', 'voided'];

export function VersionList() {
  const queryClient = useQueryClient();
  const [chosenYear, setChosenYear] = useState('');
  const yearId = useDefaultYearId(chosenYear);
  const [sectionId, setSectionId] = useState('');
  const [status, setStatus] = useState<TimetableVersionStatus | ''>('');
  const [voiding, setVoiding] = useState<TimetableVersionDto | null>(null);
  const [page, setPage] = useListPage([yearId, sectionId, status]);

  const query: TimetableVersionListQuery = {
    page,
    limit: LIMIT,
    ...(yearId && { academicYearId: yearId }),
    ...(sectionId && { sectionId }),
    ...(status && { status }),
  };
  const versions = useQuery({
    queryKey: timetableKeys.versions(query),
    queryFn: () => unwrap(timetableApi.GET('/api/v1/timetable-versions', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: yearId !== '',
  });

  const voidVersion = useMutation({
    mutationFn: ({ v, reason }: { v: TimetableVersionDto; reason: string }) =>
      unwrap(
        timetableApi.POST('/api/v1/timetable-versions/{id}/void', { params: { path: { id: v.id } }, body: { reason } }),
      ),
    onSuccess: (v) => toast.success(`The ${v.className} ${v.sectionName} timetable from ${formatDay(v.effectiveFrom)} is voided.`),
    onError: (error) => toast.error(timetableErrorMessage(error)),
    onSettled: () => {
      setVoiding(null);
      void queryClient.invalidateQueries({ queryKey: timetableKeys.all });
    },
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, TimetableVersionDto>();
    return [
      column.accessor('sectionName', {
        header: 'Section',
        cell: (info) => (
          <Link href={weekHref(info.row.original.sectionId)} className="font-medium hover:underline">
            {info.row.original.className} {info.getValue()}
          </Link>
        ),
      }),
      column.accessor('effectiveFrom', {
        header: 'Applies',
        cell: (info) => (
          <span className="whitespace-nowrap">
            {formatDay(info.getValue())} – {info.row.original.effectiveTo ? formatDay(info.row.original.effectiveTo) : 'onwards'}
          </span>
        ),
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <span className="grid gap-0.5">
            <Badge variant={versionStatusVariant(info.getValue())}>{VERSION_STATUS_LABELS[info.getValue()]}</Badge>
            {info.row.original.voidReason && (
              <span className="text-xs text-muted-foreground">{info.row.original.voidReason}</span>
            )}
          </span>
        ),
      }),
      column.accessor('slotCount', { header: 'Lessons a week' }),
      column.accessor('createdAt', {
        header: 'Saved',
        cell: (info) => (
          <span className="grid">
            <span className="whitespace-nowrap">{formatDate(info.getValue())}</span>
            <span className="text-xs text-muted-foreground">by {info.row.original.createdByName}</span>
          </span>
        ),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) =>
          // A version starting today or later can be voided (a same-day correction, R301).
          info.row.original.status === 'future' ||
          (info.row.original.status === 'live' && info.row.original.effectiveFrom >= todayInSchool()) ? (
            <RowActions
              label={`timetable of ${info.row.original.className} ${info.row.original.sectionName} from ${info.row.original.effectiveFrom}`}
              actions={[{ label: 'Void', onSelect: () => setVoiding(info.row.original), destructive: true }]}
            />
          ) : null,
      }),
    ];
  }, []);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <YearFilter
          value={yearId}
          onChange={(id) => {
            setChosenYear(id);
            setSectionId('');
          }}
        />
        <SectionSelect yearId={yearId} value={sectionId} onChange={setSectionId} allLabel="All sections" />
        <FilterSelect<TimetableVersionStatus | ''> label="Status" value={status} onChange={setStatus}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {VERSION_STATUS_LABELS[s]}
            </option>
          ))}
        </FilterSelect>
      </div>
      <DataTable
        columns={columns}
        query={versions}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No timetable versions"
        emptyDescription="A version is saved each time a section's timetable is edited."
      />
      <ConfirmWithReasonDialog
        open={voiding !== null}
        onOpenChange={(open) => (open ? undefined : setVoiding(null))}
        title="Void this timetable?"
        description={
          voiding
            ? `${voiding.className} ${voiding.sectionName}, from ${formatDay(voiding.effectiveFrom)}. The timetable before it carries on in its place.`
            : undefined
        }
        confirmLabel="Void timetable"
        minLength={3}
        destructive
        pending={voidVersion.isPending}
        onConfirm={(reason) => voiding && voidVersion.mutate({ v: voiding, reason })}
      />
    </>
  );
}
