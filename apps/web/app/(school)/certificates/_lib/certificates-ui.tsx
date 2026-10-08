'use client';

import { CERTIFICATE_TYPES, ErrorCode, formatRupees, newIdempotencyKey } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { unwrap } from '@/lib/api/client';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import {
  certificatesApi,
  type CertificateDto,
  type CertificateSummaryDto,
  type CertificateType,
} from '@/lib/api/school-certificates-contract';
import { studentsApi } from '@/lib/api/school-students-contract';
import { nameSchema } from '@/lib/validation';
import { studentsKeys } from '../../students/_lib/students-ui';

// Pieces shared by the certificates register and the student page's Certificates panel
// (phase-4-academic.md slice 34, contracts/slice-34.md §8). The API decides every rule; the forms
// only save a round trip.

export const certificatesKeys = {
  all: ['school', 'certificates'] as const,
  forStudent: (studentId: string) => ['school', 'certificates', 'student', studentId] as const,
};

export const CERTIFICATE_TYPE_LABELS: Record<CertificateType, string> = {
  leaving: 'School leaving',
  character: 'Character',
  academic: 'Academic',
  completion: 'Completion',
  other: 'Other',
};

/** The type's printed title, as the API defaults it (`other` always has its own). */
export const CERTIFICATE_TYPE_HINTS: Record<CertificateType, string> = {
  leaving: 'Only for a student who has been withdrawn, transferred or has completed school, with dues paid or overridden by a principal.',
  character: 'States the student’s dates at the school and their conduct.',
  academic: 'States the class and year the student studied in, with the published result’s marks and the record of attendance.',
  completion: 'States the class the student completed in the year.',
  other: 'A certificate with your own title, for anything the other types do not cover.',
};

/**
 * Opens the printable page in a new tab (R292): the browser fetches it with the session cookie,
 * and the HTML (which may carry a B-Form number) is never held in this page's state.
 */
export function printCertificate(id: string): void {
  window.open(`/api/v1/certificates/${id}/print`, '_blank', 'noopener,noreferrer');
}

/** The refusals the certificate actions can meet, in the office's words. */
export const CERTIFICATE_REFUSALS: RefusalMessages = {
  [ErrorCode.CERTIFICATE_STUDENT_NOT_LEFT]:
    'A leaving certificate needs the student withdrawn, transferred or completed first. Change the student’s status, then issue it.',
  [ErrorCode.CERTIFICATE_NO_RESULT]:
    'No result of that academic year is published for the student yet. An academic or completion certificate prints the published result.',
  [ErrorCode.CERTIFICATE_DUES_BLOCK]: (details) =>
    `The student owes ${formatRupees(Number(details.outstanding ?? 0))}. Collect the dues, or ask a principal to override them on the student’s Fees tab.`,
  [ErrorCode.CERTIFICATE_VOIDED]: 'This certificate has been voided. Issue a new one instead.',
  [`${ErrorCode.PERMISSION_DENIED}:principal_required`]: 'Only a principal can void a certificate.',
};

/** Label, DUPLICATE and VOID badges for a certificate row. */
export function CertificateBadges({ certificate }: { certificate: CertificateSummaryDto }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="font-medium tabular-nums">{certificate.label}</span>
      {certificate.issueNo > 1 && <Badge variant="outline">Duplicate {certificate.issueNo}</Badge>}
      {certificate.voidedAt !== null && <Badge variant="destructive">Voided</Badge>}
    </span>
  );
}

// ---- Issue ----

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .regex(/^\P{Cc}*$/u, 'Remove line breaks and control characters.');

const issueSchema = z
  .object({
    type: z.enum(CERTIFICATE_TYPES),
    academicYearId: z.string(),
    title: optionalText(80),
    conduct: optionalText(100),
    remarks: optionalText(500),
  })
  .refine((v) => v.type !== 'other' || nameSchema(1, 80).safeParse(v.title).success, {
    path: ['title'],
    message: 'Give the certificate a title.',
  })
  // The API refuses an `other` title that reads as a leaving certificate (wave N review).
  .refine((v) => v.type !== 'other' || !/leav/i.test(v.title), {
    path: ['title'],
    message: 'For a leaving certificate, choose the School leaving type.',
  });
type IssueValues = z.infer<typeof issueSchema>;

const TYPE_OPTIONS = CERTIFICATE_TYPES.map((value) => ({ value, label: CERTIFICATE_TYPE_LABELS[value] }));

/**
 * The issue form for one student, inside a dialog. The year list is the student's own enrolment
 * years (the API refuses any other); blank means the latest.
 */
export function IssueCertificateForm({
  student,
  onDone,
  onCancel,
  onBack,
}: {
  student: { id: string; fullName: string };
  onDone: (issued: CertificateDto) => void;
  onCancel: () => void;
  /** Shown as "Change student" when the student was picked in the same dialog. */
  onBack?: () => void;
}) {
  const queryClient = useQueryClient();
  // One key per opened form: a retried issue is a replay, never a second number.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const enrolments = useQuery({
    queryKey: studentsKeys.enrolments(student.id),
    queryFn: () =>
      unwrap(studentsApi.GET('/api/v1/students/{id}/enrolments', { params: { path: { id: student.id }, query: { limit: 50 } } })),
  });
  const years = [...new Map((enrolments.data?.data ?? []).map((e) => [e.academicYearId, e.academicYearName])).entries()];
  const form = useForm<IssueValues>({
    resolver: zodResolver(issueSchema),
    defaultValues: { type: 'character', academicYearId: '', title: '', conduct: '', remarks: '' },
  });
  const type = useWatch({ control: form.control, name: 'type' });

  const issue = useMutation({
    mutationFn: (values: IssueValues) =>
      unwrap(
        certificatesApi.POST('/api/v1/students/{id}/certificates', {
          params: { path: { id: student.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            type: values.type,
            ...(values.academicYearId && { academicYearId: values.academicYearId }),
            // A title belongs to an `other` certificate only; the API refuses it on any other type.
            ...(values.type === 'other' && values.title && { title: values.title }),
            ...(values.conduct && { conduct: values.conduct }),
            ...(values.remarks && { remarks: values.remarks }),
          },
        }),
      ),
    onSuccess: (issued) => {
      void queryClient.invalidateQueries({ queryKey: certificatesKeys.all });
      toast.success(`${issued.title} ${issued.label} issued to ${student.fullName}.`);
      onDone(issued);
    },
    onError: (error) => {
      if (applyApiFieldErrors(form, error)) return;
      form.setError('root.server', { message: refusalMessage(error, CERTIFICATE_REFUSALS) });
    },
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((values) => issue.mutate(values))}>
      <DialogHeader>
        <DialogTitle>Issue a certificate</DialogTitle>
        <DialogDescription>
          To {student.fullName}. The certificate records the student’s details as they are today; a later change to the
          student’s record does not alter it.
        </DialogDescription>
      </DialogHeader>
      {onBack && (
        <div>
          <Button type="button" variant="ghost" size="sm" disabled={issue.isPending} onClick={onBack}>
            Change student
          </Button>
        </div>
      )}
      <FormRootError form={form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="type" label="Certificate" options={TYPE_OPTIONS} autoFocus />
        <FormField
          control={form.control}
          name="academicYearId"
          label="Academic year"
          options={[{ value: '', label: 'Latest year' }, ...years.map(([value, label]) => ({ value, label }))]}
        />
      </div>
      <p className="text-sm text-muted-foreground">{CERTIFICATE_TYPE_HINTS[type]}</p>
      {type === 'other' && <FormField control={form.control} name="title" label="Title" maxLength={80} />}
      <FormField control={form.control} name="conduct" label="Conduct (optional)" placeholder="Good" maxLength={100} />
      <FormField control={form.control} name="remarks" label="Remarks (optional)" maxLength={500} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={issue.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={issue.isPending}>
          {issue.isPending ? 'Issuing…' : 'Issue certificate'}
        </Button>
      </DialogFooter>
    </form>
  );
}
