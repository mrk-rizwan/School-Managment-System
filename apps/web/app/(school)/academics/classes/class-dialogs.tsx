'use client';

import { ATTENDANCE_MODES, ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError, type FormFieldOption } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import {
  academics,
  type AcademicYearDto,
  type AttendanceMode,
  type ClassDto,
  type CopySectionsResultDto,
  type UpdateClassBody,
} from '@/lib/api/school-academics-contract';
import { nameSchema } from '@/lib/validation';
import { academicsKeys, ATTENDANCE_MODE_LABELS } from '../_lib/academics-ui';
import { useClasses } from '../_lib/options';

const ATTENDANCE_OPTIONS: FormFieldOption[] = [
  // Rule 14: the school chooses per class; there is no default.
  { value: '', label: 'Choose…' },
  ...ATTENDANCE_MODES.map((mode) => ({
    value: mode,
    label: ATTENDANCE_MODE_LABELS[mode],
  })),
];

// ---- Create and edit (contracts/slice-3.md §3.3, §3.4) ----

const classSchema = z.object({
  academicYearId: z.string().min(1, 'Pick an academic year.'),
  name: nameSchema(1, 50),
  sortOrder: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, 'Enter a whole number from 0 to 999.'),
  // A string so the select can start empty ("Choose…").
  attendanceMode: z
    .string()
    .refine((v) => v in ATTENDANCE_MODE_LABELS, 'Choose how attendance is taken.'),
});
type ClassValues = z.infer<typeof classSchema>;

export function ClassFormDialog({
  target,
  years,
  onClose,
}: {
  /** null: closed. `{ yearId }`: create in that year. A class: edit it. */
  target: ClassDto | { yearId: string } | null;
  years: AcademicYearDto[];
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {target !== null && (
          <ClassForm
            klass={'id' in target ? target : null}
            defaultYearId={'id' in target ? target.academicYearId : target.yearId}
            years={years}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ClassForm({
  klass,
  defaultYearId,
  years,
  onDone,
}: {
  klass: ClassDto | null;
  defaultYearId: string;
  years: AcademicYearDto[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  // Set once the API answers CLASS_YEAR_IMMUTABLE: the class is referenced, its year is fixed.
  const [yearLocked, setYearLocked] = useState(false);
  const form = useForm<ClassValues>({
    resolver: zodResolver(classSchema),
    defaultValues: {
      academicYearId: defaultYearId,
      name: klass?.name ?? '',
      sortOrder: String(klass?.sortOrder ?? 0),
      attendanceMode: klass?.attendanceMode ?? '',
    },
  });

  // A class may move only to a year that is not closed; its own year is always listed.
  const yearOptions: FormFieldOption[] = years
    .filter((y) => y.status !== 'closed' || y.id === defaultYearId)
    .map((y) => ({ value: y.id, label: y.name }));

  const save = useMutation({
    mutationFn: (values: ClassValues) => {
      const fields = {
        academicYearId: values.academicYearId,
        name: values.name.trim(),
        sortOrder: Number(values.sortOrder),
        attendanceMode: values.attendanceMode as AttendanceMode,
      };
      if (!klass) return unwrap(academics.POST('/api/v1/classes', { body: fields }));
      const body: UpdateClassBody = {
        ...(fields.academicYearId !== klass.academicYearId && { academicYearId: fields.academicYearId }),
        ...(fields.name !== klass.name && { name: fields.name }),
        ...(fields.sortOrder !== klass.sortOrder && { sortOrder: fields.sortOrder }),
        ...(fields.attendanceMode !== klass.attendanceMode && { attendanceMode: fields.attendanceMode }),
      };
      return unwrap(
        academics.PATCH('/api/v1/classes/{id}', { params: { path: { id: klass.id } }, body }),
      );
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: academicsKeys.classes });
      toast.success(klass ? `${saved.name} saved.` : `${saved.name} created.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.CLASS_NAME_TAKEN) {
        form.setError('name', { message: error.message }, { shouldFocus: true });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.CLASS_YEAR_IMMUTABLE) {
        setYearLocked(true);
        form.setValue('academicYearId', defaultYearId);
        form.setError('academicYearId', { message: error.message });
        return;
      }
      applyApiError(form, error);
    },
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit((values) => {
        if (klass && !form.formState.isDirty) return onDone();
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{klass ? `Edit ${klass.name}` : 'New class'}</DialogTitle>
        <DialogDescription>
          Each class belongs to one academic year. Add its sections after creating it.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField
        control={form.control}
        name="academicYearId"
        label="Academic year"
        options={yearOptions}
        disabled={yearLocked}
        hint={
          yearLocked
            ? 'This class already has sections or students, so its year cannot change.'
            : undefined
        }
      />
      <FormField control={form.control} name="name" label="Name" hint="For example Class 5." maxLength={50} autoFocus />
      <FormField
        control={form.control}
        name="sortOrder"
        label="Display order"
        hint="Lower numbers are listed first."
        type="number"
        inputMode="numeric"
      />
      <FormField
        control={form.control}
        name="attendanceMode"
        label="Attendance is taken"
        options={ATTENDANCE_OPTIONS}
      />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : klass ? 'Save changes' : 'Create class'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Copy sections (§3.6) ----

/**
 * "Copy sections from…": picks a source class in any year and copies its live sections into the
 * target. Retry-safe on the server (existing names are skipped), so the result lists both.
 */
export function CopySectionsDialog({
  target,
  years,
  onClose,
}: {
  target: ClassDto | null;
  years: AcademicYearDto[];
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {target && <CopySectionsBody target={target} years={years} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function CopySectionsBody({
  target,
  years,
  onDone,
}: {
  target: ClassDto;
  years: AcademicYearDto[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const yearSelectId = useId();
  const classSelectId = useId();
  const [yearId, setYearId] = useState(target.academicYearId);
  const [fromClassId, setFromClassId] = useState('');

  // Archived classes too: their sections can still be copied.
  const sources = useClasses(yearId, { includeArchived: true });
  const sourceOptions = (sources.data?.data ?? []).filter((c) => c.id !== target.id);

  const copy = useMutation({
    mutationFn: () =>
      unwrap(
        academics.POST('/api/v1/classes/{id}/copy-sections', {
          params: { path: { id: target.id } },
          body: { fromClassId },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: academicsKeys.sections(target.id) });
    },
  });

  if (copy.data) return <CopyResult target={target} result={copy.data} onDone={onDone} />;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (fromClassId && !copy.isPending) copy.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Copy sections into {target.name}</DialogTitle>
        <DialogDescription>
          Every section of the chosen class is copied with its capacity. Sections {target.name}{' '}
          already has are skipped.
        </DialogDescription>
      </DialogHeader>
      {copy.error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {describeApiError(copy.error)}
        </p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={yearSelectId}>Academic year</Label>
        <NativeSelect
          id={yearSelectId}
          value={yearId}
          disabled={copy.isPending}
          onChange={(event) => {
            setYearId(event.target.value);
            setFromClassId('');
          }}
        >
          {years.map((y) => (
            <option key={y.id} value={y.id}>
              {y.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={classSelectId}>Copy from class</Label>
        <NativeSelect
          id={classSelectId}
          value={fromClassId}
          disabled={copy.isPending || sources.isPending}
          onChange={(event) => setFromClassId(event.target.value)}
        >
          <option value="">
            {sources.isPending
              ? 'Loading classes…'
              : sourceOptions.length === 0
                ? 'No other classes in this year'
                : 'Choose a class…'}
          </option>
          {sourceOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
        {sources.error && (
          <p className="text-xs text-destructive">{describeApiError(sources.error)}</p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={copy.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!fromClassId || copy.isPending}>
          {copy.isPending ? 'Copying…' : 'Copy sections'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CopyResult({
  target,
  result,
  onDone,
}: {
  target: ClassDto;
  result: CopySectionsResultDto;
  onDone: () => void;
}) {
  const created = result.created.map((s) => s.name);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Sections copied into {target.name}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-2 text-sm" role="status">
        <p>
          {created.length === 0
            ? 'No new sections were created.'
            : `Created ${created.length} section${created.length === 1 ? '' : 's'}: ${created.join(', ')}.`}
        </p>
        {result.skippedNames.length > 0 && (
          <p className="text-muted-foreground">
            Skipped, already in {target.name}: {result.skippedNames.join(', ')}.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  );
}
