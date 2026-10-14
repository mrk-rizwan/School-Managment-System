'use client';

import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { ArrowRightIcon, CheckIcon, DownloadIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FilterSelect } from '@/components/list-filters';
import { Button, buttonVariants } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import { academics } from '@/lib/api/school-academics-contract';
import { documentsApi, type DocumentQueueQuery, type DocumentStatus, type QueuedDocumentDto } from '@/lib/api/school-documents-contract';
import type { DocumentType } from '@/lib/api/school-students-contract';
import { formatDateTime } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useDefaultYearId } from '../reports/_lib/reports-ui';
import { downloadDocument } from '../students/_lib/documents';
import { DOCUMENT_TYPE_LABELS, placeLabel } from '../students/_lib/students-ui';
import { CHECKLIST_STATUS_LABELS, documentsKeys, DocumentStatusBadge, OWN_UPLOAD_HINT, useDocumentDecisions } from './_lib/documents-ui';

// The verification queue (Phase 5 slice 40, contracts/slice-40.md §1, §4): documents awaiting a
// check, oldest first. Verify or reject here; the uploader never decides their own (R322).

const LIMIT = 25;

export function DocumentsQueue() {
  const [status, setStatus] = useState<DocumentStatus>('uploaded');
  const [type, setType] = useState<DocumentType | ''>('');
  const [classId, setClassId] = useState('');
  const [page, setPage] = useListPage([status, type, classId]);
  const yearId = useDefaultYearId('');
  const classes = useQuery({
    queryKey: ['school', 'classes', 'documents-filter', yearId],
    queryFn: () => unwrap(academics.GET('/api/v1/classes', { params: { query: { academicYearId: yearId, limit: 50 } } })),
    enabled: !!yearId,
  });

  const query: DocumentQueueQuery = { page, limit: LIMIT, status, ...(type && { type }), ...(classId && { classId }) };
  const documents = useQuery({
    queryKey: [...documentsKeys.queue, query],
    queryFn: () => unwrap(documentsApi.GET('/api/v1/documents', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const decisions = useDocumentDecisions();
  const [downloading, setDownloading] = useState<string | null>(null);

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, QueuedDocumentDto>();
    return [
      column.accessor('type', {
        header: 'Document',
        cell: (info) => (
          <span className="grid">
            <span className="font-medium">{DOCUMENT_TYPE_LABELS[info.getValue()]}</span>
            <span className="text-xs text-muted-foreground">
              {info.row.original.uploadedByName ?? '—'}, {formatDateTime(info.row.original.createdAt)}
            </span>
          </span>
        ),
      }),
      column.accessor('student', {
        header: 'Student',
        cell: (info) => {
          const s = info.getValue();
          const place = placeLabel(s.className && s.sectionName ? { className: s.className, sectionName: s.sectionName } : null);
          return (
            <span className="grid">
              <Link className="font-medium hover:underline" href={`/students/${s.id}`}>
                {s.fullName}
              </Link>
              <span className="text-xs text-muted-foreground">
                Adm. {s.admissionNo}
                {place ? ` · ${place}` : ''}
              </span>
            </span>
          );
        },
      }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <span className="grid gap-1">
            <DocumentStatusBadge status={info.getValue()} />
            {info.row.original.rejectReason && <span className="text-xs text-muted-foreground">{info.row.original.rejectReason}</span>}
          </span>
        ),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const doc = info.row.original;
          const label = `${DOCUMENT_TYPE_LABELS[doc.type]} of ${doc.student.fullName}`;
          return (
            <div className="flex flex-wrap items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Download ${label}`}
                disabled={downloading === doc.id}
                onClick={() => {
                  setDownloading(doc.id);
                  downloadDocument(doc.id)
                    .catch((error: unknown) => toast.error(describeApiError(error)))
                    .finally(() => setDownloading(null));
                }}
              >
                <DownloadIcon />
                <span className="hidden sm:inline">Download</span>
              </Button>
              {doc.status === 'uploaded' &&
                (doc.ownUpload ? (
                  <span className="text-xs text-muted-foreground">{OWN_UPLOAD_HINT}</span>
                ) : (
                  <>
                    <Button size="sm" aria-label={`Verify ${label}`} disabled={decisions.pendingId === doc.id} onClick={() => decisions.verify(doc)}>
                      <CheckIcon />
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Reject ${label}`}
                      disabled={decisions.pendingId === doc.id}
                      onClick={() => decisions.startReject(doc)}
                    >
                      <XIcon />
                      Reject
                    </Button>
                  </>
                ))}
            </div>
          );
        },
      }),
    ];
  }, [decisions, downloading]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <FilterSelect<DocumentStatus> label="Status" value={status} onChange={setStatus}>
            {DOCUMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CHECKLIST_STATUS_LABELS[s]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect<DocumentType | ''> label="Type" value={type} onChange={setType}>
            <option value="">All</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect<string> label="Class" value={classId} onChange={setClassId}>
            <option value="">All</option>
            {(classes.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </FilterSelect>
        </div>
        <Link href="/documents/incomplete" className={buttonVariants({ variant: 'outline' })}>
          Incomplete admissions
          <ArrowRightIcon />
        </Link>
      </div>
      <DataTable
        columns={columns}
        query={documents}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={status === 'uploaded' ? 'Nothing to check' : `No ${CHECKLIST_STATUS_LABELS[status].toLowerCase()} documents`}
        emptyDescription={status === 'uploaded' ? 'Documents uploaded on a student’s page wait here until someone checks them.' : undefined}
      />
      {decisions.rejectDialog}
    </>
  );
}
