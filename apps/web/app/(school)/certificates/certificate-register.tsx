'use client';

import { CERTIFICATE_TYPES, newIdempotencyKey } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, type RowAction, RowActions } from '@/components/data-table';
import { FilterSelect, SearchField } from '@/components/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { unwrap } from '@/lib/api/client';
import { refusalMessage } from '@/lib/api/errors';
import {
  certificatesApi,
  type CertificateDto,
  type CertificateListQuery,
  type CertificateType,
} from '@/lib/api/school-certificates-contract';
import { studentsApi, type StudentDto } from '@/lib/api/school-students-contract';
import { formatDay } from '@/lib/format';
import { useListPage } from '@/lib/hooks';
import { useListSearch } from '@/lib/list-search';
import { useIsPrincipal } from '../fees/_lib/fees-ui';
import { placeLabel, STUDENT_STATUS_LABELS, studentsKeys } from '../students/_lib/students-ui';
import {
  CERTIFICATE_REFUSALS,
  CERTIFICATE_TYPE_LABELS,
  CertificateBadges,
  certificatesKeys,
  IssueCertificateForm,
  printCertificate,
} from './_lib/certificates-ui';

// The certificates register (phase-4-academic.md slice 34, R289-R293): every certificate issued,
// newest first, voided ones listed as such. Print opens the print view in a new tab; a reissue
// keeps the number and prints DUPLICATE; only a principal voids, and the number is never reused.

const LIMIT = 25;
type Validity = '' | 'valid' | 'voided';

export function CertificateRegister() {
  const queryClient = useQueryClient();
  const isPrincipal = useIsPrincipal();
  const [type, setType] = useState<CertificateType | ''>('');
  const [validity, setValidity] = useState<Validity>('');
  const [issuing, setIssuing] = useState(false);
  const [reissuing, setReissuing] = useState<CertificateDto | null>(null);
  const [voiding, setVoiding] = useState<CertificateDto | null>(null);
  const [page, setPage] = useListPage([type, validity]);

  const query: CertificateListQuery = {
    page,
    limit: LIMIT,
    ...(type && { type }),
    ...(validity && { voided: validity === 'voided' }),
  };
  const certificates = useQuery({
    queryKey: [...certificatesKeys.all, 'register', query],
    queryFn: () => unwrap(certificatesApi.GET('/api/v1/certificates', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const done = (message: string) => {
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: certificatesKeys.all });
  };
  const failed = (close: () => void) => (error: unknown) => {
    toast.error(refusalMessage(error, CERTIFICATE_REFUSALS));
    void queryClient.invalidateQueries({ queryKey: certificatesKeys.all });
    close();
  };

  // One key per opened reissue dialog: a retried confirm is a replay, never a second duplicate.
  const [reissueKey, setReissueKey] = useState(newIdempotencyKey);
  const reissue = useMutation({
    mutationFn: ({ c, reason }: { c: CertificateDto; reason: string }) =>
      unwrap(
        certificatesApi.POST('/api/v1/certificates/{id}/reissue', {
          params: { path: { id: c.id }, header: { 'Idempotency-Key': reissueKey } },
          body: { reason },
        }),
      ),
    onSuccess: (c) => {
      done(`${c.label} reissued as duplicate ${c.issueNo}.`);
      setReissuing(null);
    },
    onError: failed(() => setReissuing(null)),
  });
  const voidCertificate = useMutation({
    mutationFn: ({ c, reason }: { c: CertificateDto; reason: string }) =>
      unwrap(certificatesApi.POST('/api/v1/certificates/{id}/void', { params: { path: { id: c.id } }, body: { reason } })),
    onSuccess: (c) => {
      done(`${c.label} voided.`);
      setVoiding(null);
    },
    onError: failed(() => setVoiding(null)),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, CertificateDto>();
    const actionsFor = (c: CertificateDto): RowAction[] => {
      const actions: RowAction[] = [{ label: 'Print', onSelect: () => printCertificate(c.id) }];
      if (c.voidedAt === null) {
        actions.push({
          label: 'Reissue',
          onSelect: () => {
            setReissueKey(newIdempotencyKey());
            setReissuing(c);
          },
        });
        if (isPrincipal) actions.push({ label: 'Void', onSelect: () => setVoiding(c), destructive: true });
      }
      return actions;
    };
    return [
      column.accessor('label', { header: 'No.', cell: (info) => <CertificateBadges certificate={info.row.original} /> }),
      column.accessor('title', {
        header: 'Certificate',
        cell: (info) => (
          <span className="grid">
            <span>{info.getValue()}</span>
            <span className="text-xs text-muted-foreground">{CERTIFICATE_TYPE_LABELS[info.row.original.type]}</span>
          </span>
        ),
      }),
      column.accessor('studentName', {
        header: 'Student',
        cell: (info) => (
          <span className="grid">
            <a className="font-medium hover:underline" href={`/students/${info.row.original.studentId}`}>
              {info.getValue()}
            </a>
            <span className="text-xs text-muted-foreground">Adm. {info.row.original.admissionNo}</span>
          </span>
        ),
      }),
      column.accessor('issuedOn', {
        header: 'Issued',
        cell: (info) => (
          <span className="grid">
            <span>{formatDay(info.getValue())}</span>
            <span className="text-xs text-muted-foreground">by {info.row.original.issuedByName}</span>
          </span>
        ),
      }),
      column.accessor('duesStatus', {
        header: 'Dues',
        cell: (info) =>
          info.getValue() === 'not_required' ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Badge variant={info.getValue() === 'override' ? 'outline' : 'secondary'}>
              {info.getValue() === 'override' ? 'Overridden' : 'Cleared'}
            </Badge>
          ),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => <RowActions label={`certificate ${info.row.original.label}`} actions={actionsFor(info.row.original)} />,
      }),
    ];
  }, [isPrincipal]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <FilterSelect<CertificateType | ''> label="Type" value={type} onChange={setType}>
            <option value="">All</option>
            {CERTIFICATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {CERTIFICATE_TYPE_LABELS[t]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect<Validity> label="Status" value={validity} onChange={setValidity}>
            <option value="">All</option>
            <option value="valid">Valid</option>
            <option value="voided">Voided</option>
          </FilterSelect>
        </div>
        <Button onClick={() => setIssuing(true)}>
          <PlusIcon />
          Issue certificate
        </Button>
      </div>
      <DataTable
        columns={columns}
        query={certificates}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No certificates"
        emptyDescription="Certificates issued to students appear here, newest first."
      />
      <Dialog open={issuing} onOpenChange={setIssuing}>
        <DialogContent>{issuing && <IssueWithStudentSearch onDone={() => setIssuing(false)} />}</DialogContent>
      </Dialog>
      <ConfirmWithReasonDialog
        open={reissuing !== null}
        onOpenChange={(open) => !open && setReissuing(null)}
        title={`Reissue ${reissuing?.label ?? ''}`}
        description="Prints a duplicate with the same number and the same details as the original. Say why a duplicate is needed."
        confirmLabel="Reissue"
        minLength={3}
        maxLength={500}
        pending={reissue.isPending}
        onConfirm={(reason) => reissuing && reissue.mutate({ c: reissuing, reason })}
      />
      <ConfirmWithReasonDialog
        open={voiding !== null}
        onOpenChange={(open) => !open && setVoiding(null)}
        title={`Void ${voiding?.label ?? ''}`}
        description="Voiding voids the certificate number: this issue and every duplicate of it stay in the register marked void, the number is never used again and it cannot be reissued. It cannot be undone."
        confirmLabel="Void"
        minLength={3}
        maxLength={500}
        destructive
        pending={voidCertificate.isPending}
        onConfirm={(reason) => voiding && voidCertificate.mutate({ c: voiding, reason })}
      />
    </>
  );
}

/** Finds the student first (any status: a leaving certificate is for a student who has left). */
function IssueWithStudentSearch({ onDone }: { onDone: () => void }) {
  const [raw, setRaw] = useState('');
  const [picked, setPicked] = useState<StudentDto | null>(null);
  const search = useListSearch(raw);
  const query = { q: search.q, limit: 8 } as const;
  const students = useQuery({
    queryKey: [...studentsKeys.all, 'certificate-search', query],
    queryFn: () => unwrap(studentsApi.GET('/api/v1/students', { params: { query } })),
    enabled: !!search.q && picked === null,
    placeholderData: keepPreviousData,
  });

  if (picked) {
    return <IssueCertificateForm student={picked} onDone={onDone} onCancel={onDone} onBack={() => setPicked(null)} />;
  }
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Issue a certificate</DialogTitle>
        <DialogDescription>Find the student by name or admission number.</DialogDescription>
      </DialogHeader>
      <SearchField
        value={raw}
        onChange={setRaw}
        placeholder="Name or admission number"
        className="w-full"
        hint={search.identity ? 'Search by name or admission number, not an identity number.' : search.hint}
        hintTone={search.identity ? 'destructive' : 'muted'}
      />
      {search.q && (
        <ul className="grid max-h-60 gap-1 overflow-y-auto" aria-label="Matching students" aria-busy={students.isFetching}>
          {students.data?.data.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setPicked(s)}
                className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span className="font-medium">{s.fullName}</span>
                <span className="text-muted-foreground">
                  {' · '}
                  {[placeLabel(s.current) || `Adm. ${s.admissionNo}`, STUDENT_STATUS_LABELS[s.status]].join(' · ')}
                </span>
              </button>
            </li>
          ))}
          {students.data && students.data.data.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No student matches.</li>
          )}
          {students.error ? <li className="px-3 py-2 text-sm text-destructive">The search failed. Try again.</li> : null}
        </ul>
      )}
    </div>
  );
}
