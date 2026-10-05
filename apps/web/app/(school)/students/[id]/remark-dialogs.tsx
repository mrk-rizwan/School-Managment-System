'use client';

import {
  Capability,
  ErrorCode,
  REMARK_CATEGORIES,
  REMARK_CATEGORY_LABELS,
  REMARK_VISIBILITIES,
  containsIdentityNumber,
  newIdempotencyKey,
  type RemarkCategory,
  type RemarkVisibility,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { school } from '@/lib/api/school-contract';
import { diaryApi, type CreateRemarkBody, type RemarkDto, type RemarkSupersededDetails } from '@/lib/api/school-diary-contract';
import type { StudentDetailDto } from '@/lib/api/school-students-contract';
import { todayInSchool } from '@/lib/format';
import { schoolKeys, useCapabilities } from '@/lib/school-session';
import { useSubjectOptions } from '../../academics/_lib/options';
import { REMARK_VISIBILITY_LABELS, remarkErrorMessage, remarkKeys } from '../_lib/remarks-ui';

// A new remark (contract §5.2) and a correction (§5.3), both opened from the student's remarks tab.

const remarkSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date.'),
  category: z.string().refine((v) => (REMARK_CATEGORIES as readonly string[]).includes(v), 'Choose a category.'),
  text: z
    .string()
    .trim()
    .min(1, 'Write the remark.')
    .max(1000, 'Use at most 1000 characters.')
    .refine((v) => !containsIdentityNumber(v), 'Remove the identity number.'),
  visibility: z.string(),
  subjectId: z.string(),
});
type RemarkValues = z.infer<typeof remarkSchema>;

export function NewRemarkDialog({ student, onClose }: { student: StudentDetailDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const textId = useId();
  const today = todayInSchool();
  // One key per opening of the form (§3): a retried save is a replay, never a second remark.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const settings = useQuery({
    queryKey: schoolKeys.settings,
    queryFn: () => unwrap(school.GET('/api/v1/school/settings')),
    enabled: can(Capability.SCHOOL_SETTINGS_MANAGE),
  });
  const subjects = useSubjectOptions();
  const defaultVisibility = settings.data?.remarkDefaultVisibility;

  const form = useForm<RemarkValues>({
    resolver: zodResolver(remarkSchema),
    defaultValues: { date: today, category: '', text: '', visibility: '', subjectId: '' },
  });

  const create = useMutation({
    mutationFn: (body: CreateRemarkBody) =>
      unwrap(
        diaryApi.POST('/api/v1/students/{id}/remarks', {
          params: { path: { id: student.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: remarkKeys.student(student.id) });
      toast.success('Remark saved.');
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
      const reason = error instanceof ApiError ? (error.details as { reason?: string } | null)?.reason : undefined;
      if (reason === 'not_assigned_on_date') {
        form.setError('date', { message: remarkErrorMessage(error) });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.SUBJECT_ARCHIVED) {
        form.setError('subjectId', { message: remarkErrorMessage(error) });
        return;
      }
      if (!applyApiFieldErrors(form, error)) form.setError('root.server', { message: remarkErrorMessage(error) });
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    if (v.date > today) {
      form.setError('date', { message: 'A remark cannot be dated in the future.' });
      return;
    }
    create.mutate({
      date: v.date,
      category: v.category as RemarkCategory,
      text: v.text.trim(),
      ...(v.visibility && { visibility: v.visibility as RemarkVisibility }),
      ...(v.subjectId && { subjectId: v.subjectId }),
    });
  });

  const textError = form.formState.errors.text?.message;
  const visibilityOptions = [
    {
      value: '',
      label: defaultVisibility ? `School default (${REMARK_VISIBILITY_LABELS[defaultVisibility]})` : 'School default',
    },
    ...REMARK_VISIBILITIES.map((v) => ({ value: v, label: REMARK_VISIBILITY_LABELS[v] })),
  ];
  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent showCloseButton={!create.isPending}>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New remark</DialogTitle>
            <DialogDescription>About {student.fullName}. A remark cannot be edited later, only corrected.</DialogDescription>
          </DialogHeader>
          <FormRootError form={form} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="date" label="Date" type="date" />
            <FormField
              control={form.control}
              name="category"
              label="Category"
              options={[{ value: '', label: 'Choose…' }, ...REMARK_CATEGORIES.map((c) => ({ value: c, label: REMARK_CATEGORY_LABELS[c] }))]}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={textId}>Remark</Label>
            <Textarea
              id={textId}
              rows={4}
              maxLength={1000}
              {...form.register('text')}
              aria-invalid={textError ? true : undefined}
            />
            {textError && <p className="text-xs text-destructive">{textError}</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="visibility"
              label="Seen by"
              options={visibilityOptions}
              hint="Staff always see every remark."
            />
            <FormField
              control={form.control}
              name="subjectId"
              label="Subject (optional)"
              options={[
                { value: '', label: 'None' },
                ...(subjects.data?.data ?? []).filter((s) => !s.archivedAt).map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save remark'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CorrectRemarkDialog({ remark, studentId, onClose }: { remark: RemarkDto | null; studentId: string; onClose: () => void }) {
  return remark ? <CorrectRemarkForm key={remark.id} remark={remark} studentId={studentId} onClose={onClose} /> : null;
}

function CorrectRemarkForm({ remark, studentId, onClose }: { remark: RemarkDto; studentId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const textId = useId();
  const visibilityId = useId();
  const [text, setText] = useState(remark.text);
  const [visibility, setVisibility] = useState<RemarkVisibility>(remark.visibility);
  const correct = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        diaryApi.POST('/api/v1/remarks/{id}/correct', {
          params: { path: { id: remark.id } },
          body: { text: text.trim(), reason, ...(visibility !== remark.visibility && { visibility }) },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: remarkKeys.student(studentId) });
      toast.success('Remark corrected.');
      onClose();
    },
    onError: (error) => {
      // A correction already exists (a retry after success, or a colleague's): show the latest.
      if (error instanceof ApiError && error.code === ErrorCode.REMARK_SUPERSEDED) {
        const latest = (error.details as Partial<RemarkSupersededDetails> | null)?.supersededById;
        void queryClient.invalidateQueries({ queryKey: remarkKeys.student(studentId) });
        toast.info(latest ? 'This remark was already corrected. The list now shows the correction.' : 'Already corrected.');
        onClose();
      }
    },
  });
  const trimmed = text.trim();
  const textProblem =
    trimmed.length === 0
      ? 'Write the corrected remark.'
      : containsIdentityNumber(trimmed)
        ? 'Remove the identity number.'
        : trimmed === remark.text && visibility === remark.visibility
          ? 'Change the text or who sees it.'
          : null;

  return (
    <ConfirmWithReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Correct this remark"
      description="The original stays on record, marked as corrected, with your reason."
      confirmLabel="Save correction"
      minLength={3}
      pending={correct.isPending}
      confirmDisabled={textProblem !== null}
      onConfirm={(reason) => correct.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={textId}>Corrected remark</Label>
        <Textarea id={textId} rows={4} maxLength={1000} value={text} onChange={(event) => setText(event.target.value)} />
        {textProblem && <p className="text-xs text-muted-foreground">{textProblem}</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={visibilityId}>Seen by</Label>
        <NativeSelect
          id={visibilityId}
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as RemarkVisibility)}
        >
          {REMARK_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {REMARK_VISIBILITY_LABELS[v]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {correct.error && !(correct.error instanceof ApiError && correct.error.code === ErrorCode.REMARK_SUPERSEDED) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{remarkErrorMessage(correct.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
