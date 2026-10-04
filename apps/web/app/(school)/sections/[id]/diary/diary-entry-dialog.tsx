'use client';

import { ErrorCode, containsIdentityNumber, newIdempotencyKey } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import { LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import {
  diaryApi,
  type CreateDiaryEntryBody,
  type DiaryEntryDto,
  type DiaryEntryExistsDetails,
  type UpdateDiaryEntryBody,
} from '@/lib/api/school-diary-contract';
import type { StagedUploadDto } from '@/lib/api/school-students-contract';
import { formatBytes, formatDay, todayInSchool } from '@/lib/format';
import { useSchoolMe } from '@/lib/school-session';
import { useSubjectOptions } from '../../../academics/_lib/options';
import { diaryErrorMessage, diaryKeys, entryEditability } from '../../../diary/_lib/diary-ui';
import { ACCEPTED_TYPES, ACCEPT_ATTRIBUTE, MAX_UPLOAD_BYTES, uploadFile } from '../../../students/_lib/documents';

// contracts/slice-13.md §4.3, §4.4, §11 "New entry" and "Edit entry". One attachment, staged
// through POST /uploads the moment it is chosen; the entry consumes it on save.

export type EntryAction =
  | { kind: 'create'; date: string }
  | { kind: 'edit'; entry: DiaryEntryDto }
  /** DIARY_ENTRY_EXISTS: open the entry that is already written. */
  | { kind: 'open'; entryId: string };

export function DiaryEntryDialog({
  sectionId,
  subjectIds,
  action,
  onAction,
}: {
  sectionId: string;
  /** The subjects a subject teacher may write; null means any. */
  subjectIds: string[] | null;
  action: EntryAction | null;
  onAction: (action: EntryAction | null) => void;
}) {
  const close = () => onAction(null);
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg">
        {action?.kind === 'create' && (
          <EntryForm sectionId={sectionId} subjectIds={subjectIds} date={action.date} onClose={close} onAction={onAction} />
        )}
        {action?.kind === 'edit' && (
          <EntryForm key={action.entry.id} sectionId={sectionId} subjectIds={subjectIds} entry={action.entry} onClose={close} onAction={onAction} />
        )}
        {action?.kind === 'open' && <OpenEntry entryId={action.entryId} onAction={onAction} />}
      </DialogContent>
    </Dialog>
  );
}

function OpenEntry({ entryId, onAction }: { entryId: string; onAction: (action: EntryAction | null) => void }) {
  const entry = useQuery({
    queryKey: diaryKeys.entry(entryId),
    queryFn: () => unwrap(diaryApi.GET('/api/v1/diary-entries/{id}', { params: { path: { id: entryId } } })),
  });
  // Hand over to the edit form once the entry is here.
  useEffect(() => {
    if (entry.data) onAction({ kind: 'edit', entry: entry.data });
  }, [entry.data, onAction]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Opening the entry</DialogTitle>
      </DialogHeader>
      {entry.error ? <p className="text-sm text-destructive">{describeApiError(entry.error)}</p> : <LoadingState rows={2} />}
    </>
  );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const noId = (v: string) => !containsIdentityNumber(v);
const schema = z.object({
  date: z.string().regex(DATE, 'Enter the date.'),
  subjectId: z.string().min(1, 'Choose a subject.'),
  topic: z
    .string()
    .trim()
    .min(1, 'Write the topic.')
    .max(500, 'Use at most 500 characters.')
    .regex(/^\P{Cc}*$/u, 'Keep the topic on one line.')
    .refine(noId, 'Remove the identity number.'),
  assignment: z.string().max(1000, 'Use at most 1000 characters.').refine(noId, 'Remove the identity number.'),
  learningOutcome: z.string().max(500, 'Use at most 500 characters.').refine(noId, 'Remove the identity number.'),
  dueOn: z.string().refine((v) => v === '' || DATE.test(v), 'Enter a date.'),
  reason: z.string(),
});
type Values = z.infer<typeof schema>;

/** The attachment as the form holds it: the saved one, a newly staged one, or none. */
type Attachment = { kind: 'saved' } | { kind: 'staged'; upload: StagedUploadDto; name: string } | { kind: 'none' };

function EntryForm({
  sectionId,
  subjectIds,
  date,
  entry,
  onClose,
  onAction,
}: {
  sectionId: string;
  subjectIds: string[] | null;
  date?: string;
  entry?: DiaryEntryDto;
  onClose: () => void;
  onAction: (action: EntryAction | null) => void;
}) {
  const queryClient = useQueryClient();
  const me = useSchoolMe();
  const today = todayInSchool();
  const fileId = useId();
  const subjects = useSubjectOptions();
  // One key per opening of the form (§3): a retried save is a replay, never a second entry.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [attachment, setAttachment] = useState<Attachment>(entry?.hasAttachment ? { kind: 'saved' } : { kind: 'none' });
  const [existing, setExisting] = useState<string | null>(null);

  // The same rule as the section card's Edit button (§4.4).
  const editability = entry ? entryEditability(entry, me.data, today) : null;
  const afterWindow = editability?.afterWindow ?? false;
  const reasonRequired = editability?.reason === 'required';

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      date: entry?.date ?? date ?? today,
      subjectId: entry?.subjectId ?? '',
      topic: entry?.topic ?? '',
      assignment: entry?.assignment ?? '',
      learningOutcome: entry?.learningOutcome ?? '',
      dueOn: entry?.dueOn ?? '',
      reason: '',
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(file),
    onSuccess: (staged, file) => setAttachment({ kind: 'staged', upload: staged, name: file.name }),
  });
  const pickFile = (file: File | undefined) => {
    upload.reset();
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      form.setError('root.server', { message: 'Choose a JPEG, PNG or PDF file.' });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      form.setError('root.server', { message: 'The file is larger than 5 MB.' });
      return;
    }
    upload.mutate(file);
  };

  const done = (saved: DiaryEntryDto, message: string) => {
    queryClient.setQueryData(diaryKeys.entry(saved.id), saved);
    void queryClient.invalidateQueries({ queryKey: diaryKeys.section(sectionId) });
    toast.success(message);
    onClose();
  };

  const save = useMutation({
    mutationFn: (body: CreateDiaryEntryBody | UpdateDiaryEntryBody) =>
      entry
        ? unwrap(diaryApi.PATCH('/api/v1/diary-entries/{id}', { params: { path: { id: entry.id } }, body }))
        : unwrap(
            diaryApi.POST('/api/v1/sections/{id}/diary-entries', {
              params: { path: { id: sectionId }, header: { 'Idempotency-Key': idempotencyKey } },
              body: body as CreateDiaryEntryBody,
            }),
          ),
    onMutate: () => setExisting(null),
    onSuccess: (saved) => done(saved, entry ? 'Entry saved.' : 'Entry written.'),
    onError: (error) => {
      if (!(error instanceof ApiError)) return form.setError('root.server', { message: describeApiError(error) });
      const reason = (error.details as { reason?: string } | null)?.reason;
      switch (error.code) {
        case ErrorCode.DIARY_ENTRY_EXISTS: {
          const id = (error.details as Partial<DiaryEntryExistsDetails> | null)?.entryId ?? null;
          setExisting(id);
          form.setError('root.server', { message: diaryErrorMessage(error) });
          return;
        }
        case ErrorCode.SUBJECT_NOT_ASSIGNED:
        case ErrorCode.SUBJECT_ARCHIVED:
          form.setError('subjectId', { message: diaryErrorMessage(error) });
          return;
        case ErrorCode.AMENDMENT_REASON_REQUIRED:
          form.setError('reason', { message: diaryErrorMessage(error) });
          return;
        case ErrorCode.IDEMPOTENCY_KEY_REUSED:
          setIdempotencyKey(newIdempotencyKey());
          break;
        case ErrorCode.PERMISSION_DENIED:
          if (reason === 'not_assigned_on_date') {
            form.setError('date', { message: diaryErrorMessage(error) });
            return;
          }
      }
      if (!applyApiFieldErrors(form, error)) form.setError('root.server', { message: diaryErrorMessage(error, entry) });
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    if (v.date > today) return form.setError('date', { message: 'A diary entry cannot be dated in the future. Set a due date instead.' });
    if (v.dueOn && v.dueOn < v.date) return form.setError('dueOn', { message: 'The due date cannot be before the entry’s date.' });
    const reason = v.reason.trim();
    if (reasonRequired && reason.length < 3) {
      return form.setError('reason', { message: 'The edit window has closed: give a reason of at least 3 characters.' });
    }
    if (reason && reason.length < 3) return form.setError('reason', { message: 'Use at least 3 characters, or leave it blank.' });
    const assignment = v.assignment.trim() || null;
    const learningOutcome = v.learningOutcome.trim() || null;
    const dueOn = v.dueOn || null;
    if (!entry) {
      save.mutate({
        date: v.date,
        subjectId: v.subjectId,
        topic: v.topic.trim(),
        ...(assignment && { assignment }),
        ...(learningOutcome && { learningOutcome }),
        ...(dueOn && { dueOn }),
        ...(attachment.kind === 'staged' && { stagedUploadId: attachment.upload.id }),
      });
      return;
    }
    // Only what changed is sent (absent = unchanged, §4.4).
    const body: UpdateDiaryEntryBody = {
      ...(v.topic.trim() !== entry.topic && { topic: v.topic.trim() }),
      ...(assignment !== entry.assignment && { assignment }),
      ...(learningOutcome !== entry.learningOutcome && { learningOutcome }),
      ...(dueOn !== entry.dueOn && { dueOn }),
      ...(attachment.kind === 'staged' && { stagedUploadId: attachment.upload.id }),
      ...(attachment.kind === 'none' && entry.hasAttachment && { stagedUploadId: null }),
    };
    if (Object.keys(body).length === 0) return onClose();
    save.mutate({ ...body, ...(reason && { reason }) });
  });

  const subjectOptions = [
    { value: '', label: subjects.isPending ? 'Loading…' : 'Choose…' },
    ...(subjects.data?.data ?? [])
      .filter((s) => !s.archivedAt && (subjectIds === null || subjectIds.includes(s.id)))
      .map((s) => ({ value: s.id, label: s.name })),
  ];
  const busy = save.isPending || upload.isPending;

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{entry ? `Edit ${entry.subjectName}, ${formatDay(entry.date)}` : 'New diary entry'}</DialogTitle>
        <DialogDescription>
          {entry
            ? afterWindow
              ? `The edit window closed on ${formatDay(entry.editWindowEndsOn)}. A change now needs a reason.`
              : `Editable until ${formatDay(entry.editWindowEndsOn)}. Families are not told about edits.`
            : 'Families are told of an entry dated today, in the app. One entry per subject per day.'}
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      {existing && (
        <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => onAction({ kind: 'open', entryId: existing })}>
          Open the existing entry
        </Button>
      )}
      {!entry && (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField control={form.control} name="date" label="Date" type="date" />
          <FormField control={form.control} name="subjectId" label="Subject" options={subjectOptions} />
        </div>
      )}
      <FormField control={form.control} name="topic" label="Topic" maxLength={500} />
      <TextArea label="Homework (optional)" error={form.formState.errors.assignment?.message} rows={3} maxLength={1000} field={form.register('assignment')} />
      <TextArea label="Learning outcome (optional)" error={form.formState.errors.learningOutcome?.message} rows={2} maxLength={500} field={form.register('learningOutcome')} />
      <FormField control={form.control} name="dueOn" label="Due on (optional)" type="date" />

      <div className="grid gap-1.5">
        <Label htmlFor={fileId}>Attachment (optional)</Label>
        {attachment.kind === 'none' ? (
          <input
            id={fileId}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            disabled={busy}
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1 file:text-sm"
            onChange={(event) => pickFile(event.target.files?.[0])}
          />
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="diary-attachment">
            <span className="truncate">
              {attachment.kind === 'staged'
                ? `${attachment.name} (${formatBytes(attachment.upload.sizeBytes)})`
                : `Saved ${entry?.attachmentMime === 'application/pdf' ? 'PDF' : 'picture'}`}
            </span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove the attachment" disabled={busy} onClick={() => setAttachment({ kind: 'none' })}>
              <XIcon />
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {upload.isPending ? 'Uploading…' : 'One JPEG, PNG or PDF, up to 5 MB.'}
        </p>
        {upload.error && <p className="text-xs text-destructive">{describeApiError(upload.error)}</p>}
      </div>

      {editability && editability.reason !== 'none' && (
        <TextArea
          label={reasonRequired ? 'Reason for the change' : 'Reason (optional)'}
          error={form.formState.errors.reason?.message}
          rows={2}
          maxLength={500}
          field={form.register('reason')}
        />
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {save.isPending ? 'Saving…' : entry ? 'Save changes' : 'Write entry'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TextArea({
  label,
  error,
  rows,
  maxLength,
  field,
}: {
  label: string;
  error?: string;
  rows: number;
  maxLength: number;
  field: UseFormRegisterReturn;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} rows={rows} maxLength={maxLength} {...field} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} />
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
