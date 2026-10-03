'use client';

import { XIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { describeApiError } from '@/lib/api/errors';
import { DOCUMENT_TYPES } from '@asms/shared';
import type { DocumentType } from '@/lib/api/school-students-contract';
import { ACCEPT_ATTRIBUTE, fileProblem, uploadFile } from '../../students/_lib/documents';
import { PlacementSelects } from '../../students/_lib/placement';
import { DOCUMENT_TYPE_LABELS, formatBytes } from '../../students/_lib/students-ui';
import type { DocumentEntry, Guard, PlacementDraft } from './wizard-types';

export function rollNoProblem(rollNo: string): string | null {
  if (rollNo.trim() === '') return null;
  const n = Number(rollNo);
  return Number.isInteger(n) && n >= 1 && n <= 9999 ? null : 'Enter a number from 1 to 9999.';
}

/** Step 3: class and section in a year that is not closed (contracts/slice-6.md §10). */
export function PlacementStep({
  value,
  onChange,
  onBack,
  onNext,
  guard,
}: {
  value: PlacementDraft;
  onChange: (value: PlacementDraft) => void;
  onBack: () => void;
  onNext: () => void;
  guard: Guard;
}) {
  const rollId = useId();
  const [tried, setTried] = useState(false);
  const rollProblem = rollNoProblem(value.rollNo);
  const missing = {
    academicYearId: value.academicYearId ? undefined : 'Choose the academic year.',
    classId: value.classId ? undefined : 'Choose the class.',
    sectionId: value.sectionId ? undefined : 'Choose the section.',
  };
  const complete = !missing.academicYearId && !missing.classId && !missing.sectionId && !rollProblem;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (complete) onNext();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <PlacementSelects
          value={value}
          onChange={(placement) => onChange({ ...value, ...placement })}
          call={guard}
          errors={tried ? missing : undefined}
        />
      </div>
      <div className="grid gap-1.5 sm:w-48">
        <Label htmlFor={rollId}>Roll number (optional)</Label>
        <Input
          id={rollId}
          value={value.rollNo}
          inputMode="numeric"
          maxLength={4}
          aria-invalid={rollProblem ? true : undefined}
          onChange={(event) => onChange({ ...value, rollNo: event.target.value.replace(/\D/g, '') })}
        />
        {rollProblem && <p className="text-xs text-destructive">{rollProblem}</p>}
      </div>
      <div className="flex justify-between pt-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="submit">Continue</Button>
      </div>
    </form>
  );
}

const MAX_DOCUMENTS = 10;

/**
 * Step 4, optional: each file is uploaded as it is chosen (POST /uploads) and only its staged
 * id is kept. Staged uploads belong to the user, not the session, and last 24 hours (R91).
 */
export function DocumentsStep({
  entries,
  onChange,
  onBack,
  onNext,
  guard,
}: {
  entries: DocumentEntry[];
  onChange: (entries: DocumentEntry[]) => void;
  onBack: () => void;
  onNext: () => void;
  guard: Guard;
}) {
  const ids = { type: useId(), file: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<DocumentType | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const problem = file && type ? fileProblem(file, type) : null;
  const full = entries.length >= MAX_DOCUMENTS;

  const upload = async () => {
    if (!file || !type || problem || pending || full) return;
    setPending(true);
    setError(null);
    try {
      const staged = await guard(() => uploadFile(file));
      onChange([
        ...entries,
        { stagedUploadId: staged.id, type, fileName: file.name, sizeBytes: staged.sizeBytes },
      ]);
      setType('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-4">
      {entries.length > 0 ? (
        <ul className="grid gap-2" aria-label="Documents to attach">
          {entries.map((doc) => (
            <li
              key={doc.stagedUploadId}
              className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{DOCUMENT_TYPE_LABELS[doc.type]}</span>
                <span className="text-muted-foreground">
                  {' '}
                  — {doc.fileName}, {formatBytes(doc.sizeBytes)}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${doc.fileName}`}
                onClick={() => onChange(entries.filter((d) => d.stagedUploadId !== doc.stagedUploadId))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No documents yet. They can also be added later from the student’s record.
        </p>
      )}
      {!full && (
        <form
          className="grid gap-4 sm:grid-cols-[14rem_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={ids.type}>Type</Label>
            <NativeSelect
              id={ids.type}
              value={type}
              disabled={pending}
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
            <Label htmlFor={ids.file}>File (JPEG, PNG or PDF, up to 5 MB)</Label>
            <Input
              id={ids.file}
              ref={fileInput}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              disabled={pending}
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={!file || !type || problem !== null || pending}>
            {pending ? 'Uploading…' : 'Upload'}
          </Button>
        </form>
      )}
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      {Boolean(error) && (
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(error)}
        </p>
      )}
      <div className="flex justify-between pt-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" disabled={pending} onClick={onNext}>
          {entries.length === 0 ? 'Skip' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}
