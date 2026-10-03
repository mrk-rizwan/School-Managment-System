'use client';

import { GENDERS, normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormField } from '@/components/form-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import {
  studentsApi,
  type Gender,
  type StudentLookupResultDto,
} from '@/lib/api/school-students-contract';
import { todayInSchool } from '@/lib/format';
import { formatIdentityInput, nameSchema } from '@/lib/validation';
import {
  dateOfBirthProblem,
  GENDER_LABELS,
  placeLabel,
  STUDENT_STATUS_LABELS,
} from '../../students/_lib/students-ui';
import type { Guard, StudentDraft } from './wizard-types';
import { NotesField } from '../../students/_lib/notes-field';

/**
 * Step 1 (contracts/slice-6.md §10): the B-Form is looked up first. A former student is offered
 * readmission; a current one stops the admission with a link to their record. Then the details.
 */
export function StudentStep({
  draft,
  onChange,
  onNext,
  guard,
}: {
  draft: StudentDraft;
  onChange: (draft: StudentDraft) => void;
  onNext: () => void;
  guard: Guard;
}) {
  if (!draft.checked) {
    return <BFormCheck onChecked={(bForm) => onChange({ ...draft, bForm, checked: true })} guard={guard} />;
  }
  return (
    <DetailsForm
      draft={draft}
      onBack={() => onChange({ ...draft, bForm: null, checked: false })}
      onSubmit={(values) => {
        onChange({ ...draft, ...values, gender: values.gender as Gender });
        onNext();
      }}
    />
  );
}

function BFormCheck({ onChecked, guard }: { onChecked: (bForm: string | null) => void; guard: Guard }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hit, setHit] = useState<StudentLookupResultDto['data'][number] | null>(null);
  const digits = normaliseIdentityDigits(value);

  const check = async () => {
    if (!digits || pending) return;
    setPending(true);
    setError(null);
    setHit(null);
    try {
      const result = await guard(() =>
        unwrap(studentsApi.POST('/api/v1/students/lookup', { body: { bForm: digits } })),
      );
      const found = result.data[0];
      if (found) setHit(found);
      else onChecked(digits);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <Label htmlFor={id}>Student’s B-Form or CRC number</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={id}
            value={value}
            autoComplete="off"
            autoFocus
            inputMode="numeric"
            maxLength={15}
            placeholder="#####-#######-#"
            className="w-full sm:w-64"
            onChange={(event) => {
              setHit(null);
              setValue(formatIdentityInput(event.target.value));
            }}
          />
          <Button type="submit" disabled={!digits || pending}>
            {pending ? 'Checking…' : 'Check B-Form'}
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => onChecked(null)}>
            No B-Form yet
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Checked first, so a returning student is readmitted rather than admitted twice.
        </p>
      </form>
      {Boolean(error) && (
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(error)}
        </p>
      )}
      {hit && (
        <Alert role="alert" variant={hit.readmissible ? 'default' : 'destructive'}>
          <AlertTitle>
            {hit.readmissible ? 'This child was a student here' : 'This child is already a student'}
          </AlertTitle>
          <AlertDescription>
            <p>
              {hit.student.fullName}, admission no. {hit.student.admissionNo},{' '}
              {STUDENT_STATUS_LABELS[hit.student.status].toLowerCase()}
              {hit.student.current ? ` in ${placeLabel(hit.student.current)}` : ''}.
            </p>
            <p className="mt-2">
              {hit.readmissible ? (
                <Link
                  href={`/students/${hit.student.id}/readmit`}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Readmit {hit.student.fullName}
                </Link>
              ) : (
                <Link
                  href={`/students/${hit.student.id}`}
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Open the record
                </Link>
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

const schema = z.object({
  fullName: nameSchema(2, 200),
  gender: z.string().refine((v) => (GENDERS as readonly string[]).includes(v), 'Choose a gender.'),
  dateOfBirth: z.string().superRefine((v, ctx) => {
    const problem = dateOfBirthProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  admittedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the admission date.')
    .refine((v) => v <= todayInSchool(), 'The admission date cannot be in the future.'),
  notes: z.string().max(2000, 'Use at most 2000 characters.'),
});
type Values = z.input<typeof schema>;

/** 35201-*******-1: enough to recognise, not enough to copy from the screen. */
const maskIdentity = (digits: string) => `${digits.slice(0, 5)}-*******-${digits.slice(12)}`;

function DetailsForm({
  draft,
  onBack,
  onSubmit,
}: {
  draft: StudentDraft;
  onBack: () => void;
  onSubmit: (values: Values) => void;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      fullName: draft.fullName,
      gender: draft.gender,
      dateOfBirth: draft.dateOfBirth,
      admittedOn: draft.admittedOn,
      notes: draft.notes,
    },
  });
  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">B-Form:</span>
        <span className="font-mono text-muted-foreground">
          {draft.bForm ? maskIdentity(draft.bForm) : 'Not recorded'}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {draft.bForm ? 'Change' : 'Check a B-Form'}
        </Button>
      </div>
      <FormField control={form.control} name="fullName" label="Full name" maxLength={200} autoFocus />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          control={form.control}
          name="gender"
          label="Gender"
          options={[{ value: '', label: 'Choose…' }, ...GENDERS.map((g) => ({ value: g, label: GENDER_LABELS[g] }))]}
        />
        <FormField control={form.control} name="dateOfBirth" label="Date of birth" type="date" />
        <FormField control={form.control} name="admittedOn" label="Admission date" type="date" />
      </div>
      <NotesField control={form.control} />
      <div className="flex justify-end pt-2">
        <Button type="submit">Continue</Button>
      </div>
    </form>
  );
}

