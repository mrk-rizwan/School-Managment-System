'use client';

import { Capability, DOCUMENT_TYPES } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { CheckIcon, DownloadIcon, UploadIcon, XIcon } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import {
  studentsApi,
  type DocumentType,
  type StudentDetailDto,
  type StudentDocumentDto,
} from '@/lib/api/school-students-contract';
import { formatBytes, formatDate } from '@/lib/format';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { QueryStates } from '@/components/page-states';
import { documentsApi } from '@/lib/api/school-documents-contract';
import { DocumentStatusBadge, OWN_UPLOAD_HINT, useDocumentDecisions } from '../../documents/_lib/documents-ui';
import { ACCEPT_ATTRIBUTE, downloadDocument, fileProblem, uploadFile } from '../_lib/documents';
import { DOCUMENT_TYPE_LABELS, studentsKeys } from '../_lib/students-ui';

const LIMIT = 25;

/** contracts/slice-6.md §6.1, §6.2. Files are downloaded through the API, never a public link. */
export function DocumentsTab({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const me = useSchoolMe();
  const canVerify = can(Capability.DOCUMENT_VERIFY);
  const decisions = useDocumentDecisions();
  const [page, setPage] = useState(1);
  const [type, setType] = useState<DocumentType | ''>('');
  const typeId = useId();
  const query = { page, limit: LIMIT, ...(type && { type }) };
  const documents = useQuery({
    queryKey: [...studentsKeys.documents(student.id), query],
    queryFn: () =>
      unwrap(
        studentsApi.GET('/api/v1/students/{id}/documents', { params: { path: { id: student.id }, query } }),
      ),
    placeholderData: keepPreviousData,
  });
  const [downloading, setDownloading] = useState<string | null>(null);

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, StudentDocumentDto>();
    return [
      column.accessor('type', {
        header: 'Document',
        cell: (info) => <span className="font-medium">{DOCUMENT_TYPE_LABELS[info.getValue()]}</span>,
      }),
      column.display({
        id: 'file',
        header: 'File',
        cell: (info) =>
          `${info.row.original.mime === 'application/pdf' ? 'PDF' : 'Image'}, ${formatBytes(info.row.original.sizeBytes)}`,
      }),
      column.accessor('uploadedByName', { header: 'Uploaded by', cell: (info) => info.getValue() ?? '—' }),
      column.accessor('createdAt', { header: 'Added', cell: (info) => formatDate(info.getValue()) }),
      // Phase 5 slice 40: the decision; the reason is staff-only (R322).
      column.accessor('status', {
        header: 'Status',
        cell: (info) => {
          const doc = info.row.original;
          return (
            <span className="grid gap-1">
              <DocumentStatusBadge status={doc.status} />
              {doc.decidedByName && (
                <span className="text-xs text-muted-foreground">
                  {doc.decidedByName}
                  {doc.decidedAt ? `, ${formatDate(doc.decidedAt)}` : ''}
                </span>
              )}
              {doc.rejectReason && <span className="text-xs text-muted-foreground">{doc.rejectReason}</span>}
            </span>
          );
        },
      }),
      column.display({
        id: 'decide',
        header: () => <span className="sr-only">Check</span>,
        cell: (info) => {
          const doc = info.row.original;
          if (!canVerify || doc.status !== 'uploaded') return null;
          if (doc.uploadedBy === me.data?.id) return <span className="text-xs text-muted-foreground">{OWN_UPLOAD_HINT}</span>;
          const label = DOCUMENT_TYPE_LABELS[doc.type];
          return (
            <span className="flex gap-1">
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
            </span>
          );
        },
      }),
      column.display({
        id: 'download',
        header: () => <span className="sr-only">Download</span>,
        cell: (info) => {
          const doc = info.row.original;
          return (
            <Button
              variant="ghost"
              size="sm"
              disabled={downloading === doc.id}
              aria-label={`Download ${DOCUMENT_TYPE_LABELS[doc.type]}`}
              onClick={() => {
                setDownloading(doc.id);
                downloadDocument(doc.id)
                  .catch((error: unknown) => toast.error(describeApiError(error)))
                  .finally(() => setDownloading(null));
              }}
            >
              <DownloadIcon />
              {downloading === doc.id ? 'Downloading…' : 'Download'}
            </Button>
          );
        },
      }),
    ];
  }, [downloading, canVerify, decisions, me.data?.id]);

  return (
    <div className="grid gap-6">
      <ChecklistCard studentId={student.id} />
      {can(Capability.DOCUMENT_UPLOAD) && <UploadCard studentId={student.id} />}
      <div className="grid gap-3">
        <div className="grid w-full gap-1.5 sm:w-64">
          <Label htmlFor={typeId}>Type</Label>
          <NativeSelect
            id={typeId}
            value={type}
            onChange={(event) => {
              setType(event.target.value as DocumentType | '');
              setPage(1);
            }}
          >
            <option value="">Any</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <DataTable
          columns={columns}
          query={documents}
          getRowId={(row) => row.id}
          page={page}
          limit={LIMIT}
          onPageChange={setPage}
          emptyTitle={type ? 'No documents of this type' : 'No documents yet'}
        />
      </div>
      {decisions.rejectDialog}
    </div>
  );
}

/**
 * The required-documents checklist (Phase 5 slice 40, R323): per required type, the newest
 * document's status. Never a gate: a missing or rejected document is a query on the student.
 */
function ChecklistCard({ studentId }: { studentId: string }) {
  const checklist = useQuery({
    queryKey: [...studentsKeys.documents(studentId), 'checklist'],
    queryFn: () =>
      unwrap(documentsApi.GET('/api/v1/students/{id}/document-checklist', { params: { path: { id: studentId } } })),
  });
  return (
    <Card data-testid="documents.checklist">
      <CardHeader>
        <CardTitle>Required documents</CardTitle>
        <CardDescription>
          {checklist.data?.complete === false
            ? 'Some required documents are missing, awaiting a check or rejected. This never stops the admission.'
            : 'The documents the school asks for at admission.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStates query={checklist}>
          {(data) =>
            data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">The school requires no documents.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.items.map((item) => (
                  <li key={item.type} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                    <span className="font-medium">{DOCUMENT_TYPE_LABELS[item.type]}</span>
                    <DocumentStatusBadge status={item.status} />
                  </li>
                ))}
              </ul>
            )
          }
        </QueryStates>
      </CardContent>
    </Card>
  );
}

/**
 * Upload, then attach: POST /uploads stores the file, POST /students/:id/documents commits it.
 * If the attach fails the staged id is kept, and "Try again" re-posts the same id (the API
 * answers a repeat with the existing document, §6.2).
 */
function UploadCard({ studentId }: { studentId: string }) {
  const queryClient = useQueryClient();
  const ids = { type: useId(), file: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<DocumentType | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [staged, setStaged] = useState<{ id: string; type: DocumentType } | null>(null);

  const reset = () => {
    setType('');
    setFile(null);
    setStaged(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const attach = (stagedUploadId: string, documentType: DocumentType) =>
    unwrap(
      studentsApi.POST('/api/v1/students/{id}/documents', {
        params: { path: { id: studentId } },
        body: { stagedUploadId, type: documentType },
      }),
    );

  const save = useMutation({
    mutationFn: async () => {
      let current = staged;
      if (!current) {
        const upload = await uploadFile(file!);
        current = { id: upload.id, type: type as DocumentType };
        setStaged(current);
      }
      return attach(current.id, current.type);
    },
    onSuccess: (doc) => {
      toast.success(`${DOCUMENT_TYPE_LABELS[doc.type]} added.`);
      reset();
      void queryClient.invalidateQueries({ queryKey: studentsKeys.documents(studentId) });
      if (doc.type === 'photo') void queryClient.invalidateQueries({ queryKey: studentsKeys.detail(studentId) });
    },
  });

  const problem = file && type ? fileProblem(file, type) : null;
  const ready = staged !== null || (file !== null && type !== '' && problem === null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a document</CardTitle>
        <CardDescription>JPEG, PNG or PDF, up to 5 MB. Photos are re-saved without their location data.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-[14rem_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !save.isPending) save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={ids.type}>Type</Label>
            <NativeSelect
              id={ids.type}
              value={type}
              disabled={save.isPending || staged !== null}
              onChange={(event) => setType(event.target.value as DocumentType | '')}
            >
              <option value="">Choose…</option>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.file}>File</Label>
            <Input
              id={ids.file}
              ref={fileInput}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              disabled={save.isPending || staged !== null}
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <Button type="submit" disabled={!ready || save.isPending}>
            <UploadIcon />
            {save.isPending ? 'Uploading…' : staged ? 'Try again' : 'Upload'}
          </Button>
        </form>
        {problem && <p className="mt-2 text-xs text-destructive">{problem}</p>}
        {save.error && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>
              {describeApiError(save.error)}
              {staged && (
                <>
                  {' '}
                  The file is uploaded; try again to attach it, or{' '}
                  <button type="button" className="underline underline-offset-4" onClick={() => { save.reset(); reset(); }}>
                    start over
                  </button>
                  .
                </>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
