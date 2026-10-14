'use client';

import { ErrorCode } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import { documentsApi, type ChecklistStatus } from '@/lib/api/school-documents-contract';
import type { StudentDocumentDto } from '@/lib/api/school-students-contract';
import { DOCUMENT_TYPE_LABELS, studentsKeys } from '../../students/_lib/students-ui';

// Document verification (Phase 5 slice 40, contracts/slice-40.md): the labels, the status badge
// and the verify / reject actions shared by the queue page and the student's Documents tab.

export const documentsKeys = {
  all: ['school', 'documents'] as const,
  queue: ['school', 'documents', 'queue'] as const,
  incomplete: ['school', 'documents', 'incomplete'] as const,
  checklist: (studentId: string) => ['school', 'documents', 'checklist', studentId] as const,
};

export const CHECKLIST_STATUS_LABELS: Record<ChecklistStatus, string> = {
  missing: 'Missing',
  uploaded: 'Awaiting check',
  verified: 'Verified',
  rejected: 'Rejected',
};

const VARIANTS: Record<ChecklistStatus, 'outline' | 'secondary' | 'destructive' | 'default'> = {
  missing: 'outline',
  uploaded: 'secondary',
  verified: 'default',
  rejected: 'destructive',
};

export function DocumentStatusBadge({ status }: { status: ChecklistStatus }) {
  return <Badge variant={VARIANTS[status]}>{CHECKLIST_STATUS_LABELS[status]}</Badge>;
}

export const DOCUMENT_REFUSALS: RefusalMessages = {
  [`${ErrorCode.SELF_ACTION_FORBIDDEN}:own_upload`]: 'You uploaded this document. Ask another member of staff to check it.',
  [ErrorCode.DOCUMENT_ALREADY_DECIDED]: 'This document has already been checked. The list has been refreshed.',
  [ErrorCode.NOT_FOUND]: 'This document is no longer available to you.',
};

/** The verifier is never the uploader (R322): the hint shown instead of the actions. */
export const OWN_UPLOAD_HINT = 'You uploaded this; another member of staff checks it.';

type Decidable = Pick<StudentDocumentDto, 'id' | 'type' | 'studentId'>;

/**
 * Verify (no body) and reject (with a reason, in the shared dialog). On any outcome the queue,
 * the Approvals read, the student's documents and checklist and the student list are refreshed:
 * a refusal usually means a colleague decided first.
 */
export function useDocumentDecisions() {
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState<Decidable | null>(null);
  const refresh = (studentId: string) => {
    void queryClient.invalidateQueries({ queryKey: documentsKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['school', 'approvals'] });
    void queryClient.invalidateQueries({ queryKey: studentsKeys.documents(studentId) });
    void queryClient.invalidateQueries({ queryKey: studentsKeys.list });
  };
  const verify = useMutation({
    mutationFn: (doc: Decidable) => unwrap(documentsApi.POST('/api/v1/documents/{id}/verify', { params: { path: { id: doc.id } } })),
    onSuccess: (doc) => toast.success(`${DOCUMENT_TYPE_LABELS[doc.type]} verified.`),
    onError: (error) => toast.error(refusalMessage(error, DOCUMENT_REFUSALS)),
    onSettled: (_data, _error, doc) => refresh(doc.studentId),
  });
  const reject = useMutation({
    mutationFn: ({ doc, reason }: { doc: Decidable; reason: string }) =>
      unwrap(documentsApi.POST('/api/v1/documents/{id}/reject', { params: { path: { id: doc.id } }, body: { reason } })),
    onSuccess: (doc) => toast.success(`${DOCUMENT_TYPE_LABELS[doc.type]} rejected.`),
    onError: (error) => toast.error(refusalMessage(error, DOCUMENT_REFUSALS)),
    onSettled: (_data, _error, { doc }) => {
      setRejecting(null);
      refresh(doc.studentId);
    },
  });

  const rejectDialog = (
    <ConfirmWithReasonDialog
      open={rejecting !== null}
      onOpenChange={(open) => !open && setRejecting(null)}
      title={`Reject ${rejecting ? DOCUMENT_TYPE_LABELS[rejecting.type] : 'document'}`}
      description="Say what is wrong. The reason stays with the school; the family is only asked to upload the document again."
      confirmLabel="Reject"
      minLength={3}
      maxLength={500}
      destructive
      pending={reject.isPending}
      onConfirm={(reason) => rejecting && reject.mutate({ doc: rejecting, reason })}
    />
  );

  return {
    verify: (doc: Decidable) => verify.mutate(doc),
    startReject: setRejecting,
    pendingId: verify.isPending ? verify.variables?.id : reject.isPending ? reject.variables?.doc.id : undefined,
    rejectDialog,
  };
}
