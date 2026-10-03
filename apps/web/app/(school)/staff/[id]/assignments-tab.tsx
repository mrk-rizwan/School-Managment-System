'use client';

import { Capability, ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useEffect, useId, useMemo, useState } from 'react';
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, RowActions, type DataTableFeatures } from '@/components/data-table';
import { FormField, FormRootError, applyApiError, type FormFieldOption } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { ApiError, refusalMessage } from '@/lib/api/errors';
import {
  calendarApi,
  type CapabilityNotHeld,
  type TeacherAssignmentDto,
} from '@/lib/api/school-calendar-contract';
import {
  staffApi,
  type ClassTeacherConflict,
  type CreateTeacherAssignmentBody,
  type StaffDto,
  type TeacherRole,
} from '@/lib/api/school-staff-contract';
import { CAPABILITY_LABELS } from '@/lib/capability-labels';
import { useDebounced } from '@/lib/hooks';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { useClasses, useSections, useSubjectOptions, useYears } from '../../academics/_lib/options';
import { TEACHER_ROLE_LABELS, optionalDateSchema, staffKeys } from '../_lib/staff-ui';

/**
 * contracts/slice-4.md §4 and §8, with slice-10 §6's cover: "Arrange cover" on a class-teacher row
 * posts a cover assignment to the covering teacher. The whole tab needs class.manage (§1).
 */
const LIMIT = 25;

export function AssignmentsTab({ staff }: { staff: StaffDto }) {
  const { can } = useCapabilities();
  const canWrite = can(Capability.CLASS_MANAGE);
  const toggleId = useId();
  const [page, setPage] = useState(1);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<TeacherAssignmentDto | null>(null);
  const [covering, setCovering] = useState<TeacherAssignmentDto | null>(null);
  const today = todayInSchool();

  const query = { page, limit: LIMIT, includeEnded, sort: '-startsOn' } as const;
  const assignments = useQuery({
    queryKey: [...staffKeys.assignments(staff.id), query],
    queryFn: () =>
      unwrap(
        calendarApi.GET('/api/v1/staff/{id}/teacher-assignments', {
          params: { path: { id: staff.id }, query },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, TeacherAssignmentDto>();
    return [
      column.display({
        id: 'class',
        header: 'Class',
        cell: (info) => {
          const a = info.row.original;
          return (
            <span className="grid">
              <span className="font-medium">
                {a.className} {a.sectionName ?? <span className="font-normal text-muted-foreground">· all sections</span>}
              </span>
              <span className="text-xs text-muted-foreground">{a.academicYearName}</span>
            </span>
          );
        },
      }),
      column.display({
        id: 'role',
        header: 'Teaches',
        cell: (info) => {
          const a = info.row.original;
          if (a.role === 'cover') {
            return (
              <span className="grid">
                <span>{TEACHER_ROLE_LABELS.cover}</span>
                {a.coversStaffFullName && (
                  <span className="text-xs text-muted-foreground">Covering for {a.coversStaffFullName}</span>
                )}
              </span>
            );
          }
          return a.role === 'class_teacher' ? TEACHER_ROLE_LABELS.class_teacher : (a.subjectName ?? TEACHER_ROLE_LABELS.subject_teacher);
        },
      }),
      column.display({
        id: 'dates',
        header: 'Dates',
        cell: (info) => {
          const a = info.row.original;
          return (
            <span className="tabular-nums">
              {formatDay(a.startsOn)} – {a.endsOn ? formatDay(a.endsOn) : 'open'}
            </span>
          );
        },
      }),
      column.display({
        id: 'state',
        header: 'Status',
        cell: (info) => <AssignmentState assignment={info.row.original} today={today} />,
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const a = info.row.original;
          const live = a.voidedAt === null && (a.endsOn === null || a.endsOn >= today);
          if (!canWrite || !live) return null;
          return (
            <RowActions
              label={`${a.className} ${a.sectionName ?? ''}`.trim()}
              actions={[
                // slice-10 §13: cover for the absent class teacher of this section.
                ...(a.role === 'class_teacher' && staff.status === 'active'
                  ? [{ label: 'Arrange cover', onSelect: () => setCovering(a) }]
                  : []),
                {
                  // §4.4: a row that has not begun (or began today) is withdrawn, never ended.
                  label: a.startsOn < today ? 'End assignment' : 'Withdraw assignment',
                  destructive: true,
                  onSelect: () => setEnding(a),
                },
              ]}
            />
          );
        },
      }),
    ];
  }, [canWrite, today, staff.status]);

  const notTeacher = !staff.systemRoles.includes('teacher');

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Teaching assignments</h2>
        <div className="flex items-center gap-4">
          <div className="flex h-8 items-center gap-2">
            <input
              id={toggleId}
              type="checkbox"
              className="size-4 accent-primary"
              checked={includeEnded}
              onChange={(event) => {
                setIncludeEnded(event.target.checked);
                setPage(1);
              }}
            />
            <Label htmlFor={toggleId}>Show ended and withdrawn</Label>
          </div>
          {canWrite && staff.status === 'active' && (
            <Button size="sm" onClick={() => setAdding(true)}>
              Add assignment
            </Button>
          )}
        </div>
      </div>
      {staff.status === 'active' && notTeacher && (
        <p className="text-sm text-muted-foreground">
          {staff.fullName} does not hold the teacher role. Assignments can be added now; they give
          access to the class only once the teacher role is given.
        </p>
      )}
      <DataTable
        columns={columns}
        query={assignments}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={includeEnded ? 'No assignments yet' : 'No current assignments'}
        emptyDescription="A class teacher keeps one section's register; a subject teacher teaches one subject to a class."
      />
      {adding && <AddAssignmentDialog staff={staff} onClose={() => setAdding(false)} />}
      <EndAssignmentDialog staff={staff} assignment={ending} today={today} onClose={() => setEnding(null)} />
      {covering && <ArrangeCoverDialog absent={staff} assignment={covering} onClose={() => setCovering(null)} />}
    </section>
  );
}

function AssignmentState({ assignment: a, today }: { assignment: TeacherAssignmentDto; today: string }) {
  if (a.voidedAt) return <span className="text-muted-foreground">Withdrawn</span>;
  if (a.endsOn && a.endsOn < today) return <span className="text-muted-foreground">Ended</span>;
  if (a.activeToday) return <Badge variant="secondary">Active today</Badge>;
  if (a.startsOn > today) return <Badge variant="outline">Starts {formatDay(a.startsOn)}</Badge>;
  return <span className="text-muted-foreground">Not active</span>;
}

// ---- Add (§4.3) ----

const addSchema = z
  .object({
    role: z.string().refine((v) => v === 'class_teacher' || v === 'subject_teacher', 'Choose a role.'),
    /** Only filters the class list: the API takes the year from the class. */
    academicYearId: z.string().min(1, 'Choose a session.'),
    classId: z.string().min(1, 'Choose a class.'),
    /** '' = every section (subject teacher only). */
    sectionId: z.string(),
    subjectId: z.string(),
    startsOn: optionalDateSchema,
    endsOn: optionalDateSchema,
  })
  .superRefine((v, ctx) => {
    if (v.role === 'class_teacher' && !v.sectionId) {
      ctx.addIssue({ code: 'custom', path: ['sectionId'], message: 'A class teacher keeps one section.' });
    }
    if (v.role === 'subject_teacher' && !v.subjectId) {
      ctx.addIssue({ code: 'custom', path: ['subjectId'], message: 'Choose a subject.' });
    }
    if (v.endsOn && v.startsOn && v.endsOn < v.startsOn) {
      ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'The last day cannot be before the first.' });
    }
  });
type AddValues = z.input<typeof addSchema>;

const ROLE_OPTIONS: FormFieldOption[] = [
  { value: '', label: 'Choose…' },
  { value: 'class_teacher', label: TEACHER_ROLE_LABELS.class_teacher },
  { value: 'subject_teacher', label: TEACHER_ROLE_LABELS.subject_teacher },
];

function AddAssignmentDialog({ staff, onClose }: { staff: StaffDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const today = todayInSchool();
  // The body that hit CLASS_TEACHER_EXISTS, and who holds the section: the second step asks
  // before replacing them (§4.3, decision 3).
  const [conflict, setConflict] = useState<{
    body: CreateTeacherAssignmentBody;
    conflicts: ClassTeacherConflict[];
  } | null>(null);

  const years = useYears();
  const openYears = (years.data?.data ?? []).filter((y) => y.status !== 'closed');
  const defaultYear = openYears.find((y) => y.status === 'active') ?? openYears[0];

  const form = useForm<AddValues>({
    resolver: zodResolver(addSchema),
    defaultValues: {
      role: '',
      academicYearId: defaultYear?.id ?? '',
      classId: '',
      sectionId: '',
      subjectId: '',
      startsOn: '',
      endsOn: '',
    },
  });
  const [role, yearId, classId] = useWatch({
    control: form.control,
    name: ['role', 'academicYearId', 'classId'],
  });

  // The years arrive after the form mounts: pick the default once they do.
  useEffect(() => {
    if (!form.getValues('academicYearId') && defaultYear) form.setValue('academicYearId', defaultYear.id);
  }, [defaultYear, form]);
  // A class belongs to one year and a section to one class: clear what no longer fits.
  useEffect(() => {
    form.setValue('classId', '');
  }, [yearId, form]);
  useEffect(() => {
    form.setValue('sectionId', '');
  }, [classId, form]);

  const classes = useClasses(yearId);
  const sections = useSections(classId);
  const subjects = useSubjectOptions(role === 'subject_teacher');

  const create = useMutation({
    mutationFn: (body: CreateTeacherAssignmentBody) =>
      unwrap(
        staffApi.POST('/api/v1/staff/{id}/teacher-assignments', {
          params: { path: { id: staff.id } },
          body,
        }),
      ),
    onSuccess: (row) => {
      toast.success(
        `${staff.fullName} assigned to ${row.className}${row.sectionName ? ` ${row.sectionName}` : ''}.`,
      );
      void queryClient.invalidateQueries({ queryKey: staffKeys.assignments(staff.id) });
      onClose();
    },
    onError: (error, body) => {
      if (error instanceof ApiError && error.code === ErrorCode.CLASS_TEACHER_EXISTS && !body.replaceCurrent) {
        const conflicts = (error.details as { conflicts?: ClassTeacherConflict[] } | null)?.conflicts ?? [];
        setConflict({ body, conflicts });
        return;
      }
      // A resubmit after a lost response: the assignment exists, which is what was wanted.
      if (error instanceof ApiError && error.code === ErrorCode.ASSIGNMENT_EXISTS) {
        toast.info('This assignment already exists.');
        void queryClient.invalidateQueries({ queryKey: staffKeys.assignments(staff.id) });
        onClose();
        return;
      }
      setConflict(null);
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    const teacherRole = values.role as TeacherRole;
    create.mutate({
      role: teacherRole,
      classId: values.classId,
      sectionId: values.sectionId || null,
      ...(teacherRole === 'subject_teacher' && { subjectId: values.subjectId }),
      ...(values.startsOn && { startsOn: values.startsOn }),
      ...(values.endsOn && { endsOn: values.endsOn }),
    });
  });

  const options = (rows: { id: string; name: string }[] | undefined, empty: string): FormFieldOption[] => [
    { value: '', label: empty },
    ...(rows ?? []).map((r) => ({ value: r.id, label: r.name })),
  ];
  const liveSections = sections.data?.data.filter((s) => s.archivedAt === null);
  const liveSubjects = subjects.data?.data.filter((s) => s.archivedAt === null);

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent showCloseButton={!create.isPending}>
        {conflict ? (
          <>
            <DialogHeader>
              <DialogTitle>This section already has a class teacher</DialogTitle>
              <DialogDescription>A section has one class teacher at a time.</DialogDescription>
            </DialogHeader>
            <ul className="grid gap-1 text-sm">
              {conflict.conflicts.map((c) => (
                <li key={c.assignmentId}>
                  <span className="font-medium">{c.staffFullName}</span>, from {formatDay(c.startsOn)}
                  {c.endsOn ? ` to ${formatDay(c.endsOn)}` : ''}
                </li>
              ))}
            </ul>
            <p className="text-sm">
              Replacing ends their assignment the day before {staff.fullName} starts, or withdraws it if
              it has not begun.
            </p>
            {create.error && !(create.error instanceof ApiError && create.error.code === ErrorCode.CLASS_TEACHER_EXISTS) && (
              <Alert variant="destructive">
                <AlertDescription>{refusalMessage(create.error, 'record')}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => {
                  create.reset();
                  setConflict(null);
                }}
              >
                Back
              </Button>
              <Button
                type="button"
                disabled={create.isPending}
                onClick={() => create.mutate({ ...conflict.body, replaceCurrent: true })}
              >
                {create.isPending ? 'Working…' : 'Replace class teacher'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Add a teaching assignment</DialogTitle>
              <DialogDescription>
                For {staff.fullName}. It counts from its first day; it cannot start in the past.
              </DialogDescription>
            </DialogHeader>
            <FormRootError form={form} />
            <FormField control={form.control} name="role" label="Role" options={ROLE_OPTIONS} />
            <FormField
              control={form.control}
              name="academicYearId"
              label="Session"
              options={options(openYears, years.isPending ? 'Loading…' : 'Choose…')}
            />
            <FormField
              control={form.control}
              name="classId"
              label="Class"
              disabled={!yearId}
              options={options(classes.data?.data, classes.isFetching ? 'Loading…' : 'Choose…')}
            />
            <FormField
              control={form.control}
              name="sectionId"
              label="Section"
              disabled={!classId}
              hint={role === 'subject_teacher' ? 'Leave as every section to teach the whole class.' : undefined}
              options={options(
                liveSections,
                role === 'subject_teacher' ? 'Every section' : sections.isFetching ? 'Loading…' : 'Choose…',
              )}
            />
            {role === 'subject_teacher' && (
              <FormField
                control={form.control}
                name="subjectId"
                label="Subject"
                options={options(liveSubjects, subjects.isFetching ? 'Loading…' : 'Choose…')}
              />
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <DateField form={form} name="startsOn" label="First day (optional)" min={today} hint="Blank: today, or the session's first day." />
              <DateField form={form} name="endsOn" label="Last day (optional)" min={today} hint="Blank: until ended." />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Saving…' : 'Add assignment'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A date input with a `min` (FormField does not pass one through). */
function DateField({
  form,
  name,
  label,
  min,
  hint,
}: {
  form: UseFormReturn<AddValues>;
  name: 'startsOn' | 'endsOn';
  label: string;
  min: string;
  hint: string;
}) {
  const id = useId();
  const error = form.formState.errors[name]?.message;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="date"
        min={min}
        {...form.register(name)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-note`}
      />
      <p id={`${id}-note`} className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {error ?? hint}
      </p>
    </div>
  );
}

// ---- End (§4.4) ----

function EndAssignmentDialog({
  staff,
  assignment,
  today,
  onClose,
}: {
  staff: StaffDto;
  assignment: TeacherAssignmentDto | null;
  today: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const dateId = useId();
  const [lastDay, setLastDay] = useState('');
  const started = assignment !== null && assignment.startsOn < today;
  const close = () => {
    setLastDay('');
    end.reset();
    onClose();
  };
  const end = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(
        staffApi.POST('/api/v1/teacher-assignments/{id}/end', {
          params: { path: { id } },
          body: { ...(lastDay && { endsOn: lastDay }), ...(reason && { reason }) },
        }),
      ),
    onSuccess: (row) => {
      toast.success(row.voidedAt ? 'Assignment withdrawn.' : 'Assignment ended.');
      void queryClient.invalidateQueries({ queryKey: staffKeys.assignments(staff.id) });
      close();
    },
  });

  const name = assignment ? `${assignment.className}${assignment.sectionName ? ` ${assignment.sectionName}` : ''}` : '';
  return (
    <ConfirmWithReasonDialog
      open={assignment !== null}
      onOpenChange={(open) => !open && close()}
      title={started ? `End assignment: ${name}` : `Withdraw assignment: ${name}`}
      description={
        started
          ? 'With no last day it stops counting from today. History is kept. A reason is optional.'
          : 'It has not begun, so it is withdrawn and never counts. History is kept. A reason is optional.'
      }
      confirmLabel={started || lastDay ? 'End assignment' : 'Withdraw'}
      minLength={0}
      maxLength={500}
      destructive
      pending={end.isPending}
      onConfirm={(reason) => assignment && end.mutate({ id: assignment.id, reason })}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={dateId}>Last day (optional)</Label>
        <Input
          id={dateId}
          type="date"
          min={assignment && assignment.startsOn > today ? assignment.startsOn : today}
          max={assignment?.endsOn ?? undefined}
          value={lastDay}
          disabled={end.isPending}
          onChange={(event) => setLastDay(event.target.value)}
          aria-describedby={`${dateId}-hint`}
        />
        <p id={`${dateId}-hint`} className="text-xs text-muted-foreground">
          A planned last day, today or later. Leave blank to stop now.
        </p>
      </div>
      {end.error && (
        <Alert variant="destructive">
          <AlertDescription>{refusalMessage(end.error, 'record')}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}

// ---- Cover (contracts/slice-10.md §6, §13) ----

function coverErrorMessage(error: unknown, coverName: string): string {
  if (error instanceof ApiError && error.fieldErrors.length === 0) {
    switch (error.code) {
      case ErrorCode.CAPABILITY_NOT_HELD: {
        const capability = (error.details as Partial<CapabilityNotHeld> | null)?.capability;
        const label = capability ? (CAPABILITY_LABELS as Record<string, string>)[capability] : undefined;
        return `${coverName} cannot mark registers${label ? ` (${label})` : ''}. Give them that permission first, or choose someone else.`;
      }
      case ErrorCode.SELF_ACTION_FORBIDDEN:
        return 'You cannot assign cover to yourself. Ask your principal to arrange it.';
      case ErrorCode.ASSIGNMENT_EXISTS:
        return `${coverName} already covers this section on some of these dates.`;
      case ErrorCode.STAFF_NOT_ACTIVE:
        return `${coverName} is not an active member of staff.`;
    }
  }
  return refusalMessage(error, 'record');
}

/**
 * "Arrange cover" on the absent class teacher's row: pick the covering staff member and the
 * dates (the last day is required: a cover always lapses), then post a `cover` assignment to the
 * covering teacher's record, naming this row as the one covered unless unticked.
 */
function ArrangeCoverDialog({
  absent,
  assignment,
  onClose,
}: {
  absent: StaffDto;
  assignment: TeacherAssignmentDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const searchId = useId();
  const staffId = useId();
  const fromId = useId();
  const toId = useId();
  const standsInId = useId();
  const today = todayInSchool();
  const firstAllowed = assignment.startsOn > today ? assignment.startsOn : today;
  const [search, setSearch] = useState('');
  const [cover, setCover] = useState<{ id: string; name: string } | null>(null);
  const [startsOn, setStartsOn] = useState(firstAllowed);
  const [endsOn, setEndsOn] = useState('');
  const [standsIn, setStandsIn] = useState(true);

  const term = useDebounced(search.trim());
  // A covering teacher needs a login (to mark the register), so only staff with one are offered.
  const staffQuery = {
    status: 'active',
    hasLogin: true,
    sort: 'fullName',
    limit: OPTIONS_LIMIT,
    ...(term.length >= 2 && { q: term }),
  } as const;
  const candidates = useQuery({
    queryKey: [...staffKeys.list, 'cover-options', staffQuery],
    queryFn: () => unwrap(staffApi.GET('/api/v1/staff', { params: { query: staffQuery } })),
  });
  const options = (candidates.data?.data ?? []).filter((s) => s.id !== absent.id);

  const section = `${assignment.className} ${assignment.sectionName ?? ''}`.trim();
  const problem = !startsOn
    ? 'Choose the first day.'
    : startsOn < today
      ? 'Cover cannot start in the past.'
      : !endsOn
        ? 'Choose the last day: cover always ends.'
        : endsOn < startsOn
          ? 'The last day cannot be before the first.'
          : standsIn && assignment.endsOn !== null && startsOn > assignment.endsOn
            ? `${absent.fullName}’s assignment ends before this cover starts.`
            : null;
  // The "choose the last day" prompt waits until a date has been touched.
  const showProblem = problem !== null && (startsOn !== firstAllowed || endsOn !== '');

  const create = useMutation({
    mutationFn: (coverId: string) =>
      unwrap(
        calendarApi.POST('/api/v1/staff/{id}/teacher-assignments', {
          params: { path: { id: coverId } },
          body: {
            role: 'cover',
            classId: assignment.classId,
            sectionId: assignment.sectionId,
            startsOn,
            endsOn,
            coversAssignmentId: standsIn ? assignment.id : null,
          },
        }),
      ),
    onSuccess: (row) => {
      toast.success(
        `${row.staffFullName} is covering ${section} from ${formatDay(row.startsOn)} to ${row.endsOn ? formatDay(row.endsOn) : 'open'}.`,
      );
      void queryClient.invalidateQueries({ queryKey: staffKeys.assignments(absent.id) });
      void queryClient.invalidateQueries({ queryKey: staffKeys.assignments(row.staffId) });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent showCloseButton={!create.isPending}>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (cover && !problem && !create.isPending) create.mutate(cover.id);
          }}
        >
          <DialogHeader>
            <DialogTitle>Arrange cover: {section}</DialogTitle>
            <DialogDescription>
              The covering teacher keeps this section’s register for the dates below and is told by the app.
              Access ends by itself after the last day.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={searchId}>Find staff</Label>
            <Input
              id={searchId}
              type="search"
              value={search}
              maxLength={100}
              autoComplete="off"
              placeholder="Name"
              disabled={create.isPending}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={staffId}>Covering teacher</Label>
            <NativeSelect
              id={staffId}
              value={cover?.id ?? ''}
              disabled={create.isPending}
              aria-describedby={`${staffId}-hint`}
              onChange={(event) => {
                const found = options.find((s) => s.id === event.target.value);
                setCover(found ? { id: found.id, name: found.fullName } : null);
                create.reset();
              }}
            >
              <option value="">
                {candidates.isPending ? 'Loading…' : options.length ? 'Choose…' : 'No staff found'}
              </option>
              {cover && !options.some((s) => s.id === cover.id) && <option value={cover.id}>{cover.name}</option>}
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                  {s.designation ? ` · ${s.designation}` : ''}
                </option>
              ))}
            </NativeSelect>
            <p id={`${staffId}-hint`} className="text-xs text-muted-foreground">
              Active staff with a login. They must be able to mark registers.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={fromId}>First day</Label>
              <Input
                id={fromId}
                type="date"
                value={startsOn}
                min={firstAllowed}
                disabled={create.isPending}
                onChange={(event) => setStartsOn(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={toId}>Last day</Label>
              <Input
                id={toId}
                type="date"
                value={endsOn}
                min={startsOn || firstAllowed}
                required
                disabled={create.isPending}
                onChange={(event) => setEndsOn(event.target.value)}
              />
            </div>
          </div>
          <div className="flex items-start gap-3">
            <input
              id={standsInId}
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={standsIn}
              disabled={create.isPending}
              onChange={(event) => setStandsIn(event.target.checked)}
            />
            <Label htmlFor={standsInId} className="font-normal">
              Covering for {absent.fullName}, the class teacher
            </Label>
          </div>
          {showProblem && (
            <p className="text-xs text-destructive" role="alert">
              {problem}
            </p>
          )}
          {create.error && (
            <Alert variant="destructive">
              <AlertDescription>{coverErrorMessage(create.error, cover?.name ?? 'This teacher')}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!cover || problem !== null || create.isPending}>
              {create.isPending ? 'Saving…' : 'Arrange cover'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
