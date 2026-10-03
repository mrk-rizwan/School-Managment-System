'use client';

import {
  Capability,
  ErrorCode,
  GENDERS,
  READMISSIBLE_STATUSES,
  STUDENT_STATUS_TRANSITIONS,
  normaliseIdentityDigits,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { BackLink, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { school } from '@/lib/api/school-contract';
import {
  studentsApi,
  type Gender,
  type StatusChangeDto,
  type StudentDetailDto,
  type StudentStatus,
  type UpdateStudentBody,
} from '@/lib/api/school-students-contract';
import { formatDate, formatDay, todayInSchool } from '@/lib/format';
import { schoolKeys, useCapabilities } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { formatIdentityInput, nameSchema, optionalCnicSchema } from '@/lib/validation';
import {
  dateOfBirthProblem,
  GENDER_LABELS,
  IssueStudentLoginDialog,
  placeLabel,
  STUDENT_STATUS_LABELS,
  studentsKeys,
  StudentStatusBadge,
} from '../_lib/students-ui';
import { DocumentsTab } from './documents-tab';
import { EnrolmentsTab } from './enrolments-tab';
import { GuardianLinksTab } from './guardian-links-tab';
import { NotesField } from '../_lib/notes-field';

type Tab = 'details' | 'guardians' | 'enrolments' | 'documents' | 'history';

/** contracts/slice-6.md §3, §10. Write controls follow GET /me; the API checks every request. */
export function StudentDetail({ id }: { id: string }) {
  const { can } = useCapabilities();
  const [tab, setTab] = useState<Tab>('details');
  const student = useQuery({
    queryKey: studentsKeys.detail(id),
    queryFn: () => unwrap(studentsApi.GET('/api/v1/students/{id}', { params: { path: { id } } })),
  });

  return (
    <>
      <BackLink href="/students">Students</BackLink>
      {/* Absent, another school's, or outside a teacher's sections: one answer, 404 (§1). */}
      <QueryStates
        query={student}
        notFound={{
          title: 'Student not found',
          description: 'Find them in the students list.',
        }}
      >
        {(data) => {
          const tabs: { value: Tab; label: string }[] = [
            { value: 'details', label: 'Details' },
            { value: 'guardians', label: 'Guardians' },
            { value: 'enrolments', label: 'Enrolment history' },
            ...(can(Capability.DOCUMENT_VIEW) ? [{ value: 'documents' as const, label: 'Documents' }] : []),
            { value: 'history', label: 'Status history' },
          ];
          const place = placeLabel(data.current);

          return (
            <>
              <div className="flex items-start gap-4">
                {data.photoDocumentId && <StudentPhoto key={data.photoDocumentId} documentId={data.photoDocumentId} />}
                <div className="min-w-0 flex-1">
                  <PageHeader
                    title={data.fullName}
                    description={[`Admission no. ${data.admissionNo}`, place].filter(Boolean).join(' · ')}
                    actions={<StudentStatusBadge status={data.status} />}
                  />
                </div>
              </div>
              <div role="tablist" aria-label="Student record" className="mb-6 flex flex-wrap gap-1 border-b">
                {tabs.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    id={`tab-${value}`}
                    aria-selected={tab === value}
                    aria-controls={`panel-${value}`}
                    onClick={() => setTab(value)}
                    className={cn(
                      '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                      tab === value
                        ? 'border-primary font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                {tab === 'details' && (
                  <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
                    {/* Keyed by the last update so the form restarts from the saved values. */}
                    <DetailsCard key={data.updatedAt} student={data} />
                    <div className="grid gap-6">
                      <StatusCard student={data} />
                      <LoginCard student={data} />
                    </div>
                  </div>
                )}
                {tab === 'guardians' && <GuardianLinksTab student={data} />}
                {tab === 'enrolments' && <EnrolmentsTab student={data} />}
                {tab === 'documents' && <DocumentsTab student={data} />}
                {tab === 'history' && <StatusHistory studentId={data.id} />}
              </div>
            </>
          );
        }}
      </QueryStates>
    </>
  );
}

/**
 * The latest photo, streamed by the API (§6.2). Addressed by its document id rather than
 * /students/:id/photo, so a newly uploaded photo is never served from the browser cache.
 */
function StudentPhoto({ documentId }: { documentId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a private, cookie-authenticated file
    <img
      src={`/api/v1/documents/${documentId}/content`}
      alt="Student photo"
      className="size-16 shrink-0 rounded-lg border object-cover"
      onError={() => setFailed(true)}
    />
  );
}

// ---- Details (§3.5) ----

const editSchema = z.object({
  fullName: nameSchema(2, 200),
  gender: z.string().refine((v) => (GENDERS as readonly string[]).includes(v), 'Choose a gender.'),
  dateOfBirth: z.string().superRefine((v, ctx) => {
    const problem = dateOfBirthProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
  /** A new B-Form; blank keeps the recorded one. */
  bForm: optionalCnicSchema,
  notes: z.string().max(2000, 'Use at most 2000 characters.'),
});
type EditValues = z.input<typeof editSchema>;

function DetailsCard({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const queryClient = useQueryClient();
  const editable = can(Capability.STUDENT_UPDATE);
  // The B-Form is the student's login username, so it is locked once a login exists (§3.5).
  const bFormLocked = student.userId !== null;
  const [existingId, setExistingId] = useState<string | null>(null);
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      fullName: student.fullName,
      gender: student.gender,
      dateOfBirth: student.dateOfBirth,
      bForm: '',
      notes: student.notes ?? '',
    },
    disabled: !editable,
  });

  const save = useMutation({
    mutationFn: (body: UpdateStudentBody) =>
      unwrap(studentsApi.PATCH('/api/v1/students/{id}', { params: { path: { id: student.id } }, body })),
    onSuccess: (updated) => {
      queryClient.setQueryData(studentsKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: studentsKeys.list });
      toast.success('Student saved.');
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : null;
      if (code === ErrorCode.STUDENT_BFORM_EXISTS) {
        const id = ((error as ApiError).details as { studentId?: unknown } | null)?.studentId;
        setExistingId(typeof id === 'string' ? id : null);
        form.setError('bForm', { message: (error as ApiError).message }, { shouldFocus: true });
        return;
      }
      if (code === ErrorCode.STUDENT_BFORM_LOCKED) {
        form.setError('bForm', { message: (error as ApiError).message });
        void queryClient.invalidateQueries({ queryKey: studentsKeys.detail(student.id) });
        return;
      }
      applyApiError(form, error);
    },
  });

  // Only what changed is sent; blank notes clear (null).
  const onSubmit = form.handleSubmit((values) => {
    setExistingId(null);
    const notes = values.notes.trim() === '' ? null : values.notes.trim();
    const body: UpdateStudentBody = {
      ...(values.fullName.trim() !== student.fullName && { fullName: values.fullName.trim() }),
      ...(values.gender !== student.gender && { gender: values.gender as Gender }),
      ...(values.dateOfBirth !== student.dateOfBirth && { dateOfBirth: values.dateOfBirth }),
      ...(!bFormLocked && values.bForm.trim() && { bForm: normaliseIdentityDigits(values.bForm) }),
      ...(notes !== student.notes && { notes }),
    };
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>Admitted {formatDay(student.admittedOn)}.</CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField control={form.control} name="fullName" label="Full name" maxLength={200} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="gender"
              label="Gender"
              options={GENDERS.map((g) => ({ value: g, label: GENDER_LABELS[g] }))}
            />
            <FormField control={form.control} name="dateOfBirth" label="Date of birth" type="date" />
          </div>
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">B-Form number</p>
            <p className="font-mono text-sm text-muted-foreground">
              {student.bFormMasked ?? (student.hasBForm ? 'Recorded' : 'Not recorded')}
            </p>
            {bFormLocked && (
              <p className="text-xs text-muted-foreground">
                This student has a login and the B-Form is its username, so it cannot be changed
                here.
              </p>
            )}
          </div>
          {editable && !bFormLocked && (
            <FormField
              control={form.control}
              name="bForm"
              label={student.hasBForm ? 'Replace B-Form (optional)' : 'Add B-Form (optional)'}
              hint="Leave blank to keep the current value."
              inputMode="numeric"
              autoComplete="off"
              placeholder="35201-1234567-1"
              maxLength={15}
              format={formatIdentityInput}
            />
          )}
          {existingId && (
            <p className="-mt-2 text-sm">
              <Link href={`/students/${existingId}`} className="font-medium underline underline-offset-4">
                Open existing student
              </Link>{' '}
              <span className="text-muted-foreground">— the record with this B-Form.</span>
            </p>
          )}
          {editable && <NotesField control={form.control} />}
          {editable && (
            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending || !form.formState.isDirty}
                onClick={() => form.reset()}
              >
                Discard
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}


// ---- Status (§3.6, R36) ----

function StatusCard({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const [open, setOpen] = useState(false);
  const targets = STUDENT_STATUS_TRANSITIONS[student.status];
  const canChange = can(Capability.STUDENT_STATUS_CHANGE) && targets.length > 0;
  const readmissible = READMISSIBLE_STATUSES.includes(student.status);
  const canReadmit = can(Capability.STUDENT_CREATE) && readmissible;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Status</CardTitle>
        <CardDescription>
          {STUDENT_STATUS_LABELS[student.status]}
          {readmissible && '. Returning to the school is a readmission.'}
        </CardDescription>
      </CardHeader>
      {(canChange || canReadmit) && (
        <CardContent className="flex flex-wrap gap-2">
          {canChange && (
            <Button variant="outline" onClick={() => setOpen(true)}>
              Change status
            </Button>
          )}
          {canReadmit && (
            <Link href={`/students/${student.id}/readmit`} className={buttonVariants()}>
              Readmit
            </Link>
          )}
        </CardContent>
      )}
      {canChange && (
        <ChangeStatusDialog student={student} targets={targets} open={open} onOpenChange={setOpen} />
      )}
    </Card>
  );
}

/**
 * §3.6 retry-safety: a resubmit after a lost response is 409 with `from = to`. The student
 * already has the status that was asked for, so it is treated as done.
 */
function isAlreadyDone(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== ErrorCode.ILLEGAL_STATUS_TRANSITION) return false;
  const details = error.details as { from?: unknown; to?: unknown } | null;
  return details?.from !== undefined && details.from === details.to;
}

function ChangeStatusDialog({
  student,
  targets,
  open,
  onOpenChange,
}: {
  student: StudentDetailDto;
  targets: readonly StudentStatus[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const ids = { status: useId(), date: useId() };
  const [status, setStatus] = useState<StudentStatus | ''>('');
  const [effectiveOn, setEffectiveOn] = useState(todayInSchool);
  const today = todayInSchool();

  const close = () => {
    change.reset();
    setStatus('');
    setEffectiveOn(todayInSchool());
    onOpenChange(false);
  };
  const refresh = () => void queryClient.invalidateQueries({ queryKey: studentsKeys.all });
  const change = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        studentsApi.POST('/api/v1/students/{id}/change-status', {
          params: { path: { id: student.id } },
          body: { status: status as StudentStatus, reason, effectiveOn },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(studentsKeys.detail(updated.id), updated);
      refresh();
      toast.success(`${updated.fullName} is now ${STUDENT_STATUS_LABELS[updated.status].toLowerCase()}.`);
      close();
    },
    onError: (error) => {
      if (isAlreadyDone(error)) {
        toast.info('The status was already changed.');
        refresh();
        close();
      }
    },
  });

  const dateProblem =
    effectiveOn > today
      ? 'The date cannot be in the future.'
      : effectiveOn < student.admittedOn
        ? 'The date cannot be before the admission date.'
        : null;
  const leaving = status === 'withdrawn' || status === 'transferred';

  return (
    <ConfirmWithReasonDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`Change status: ${student.fullName}`}
      description="The change and its reason are kept in the status history."
      confirmLabel="Change status"
      minLength={3}
      maxLength={500}
      destructive={leaving}
      pending={change.isPending}
      confirmDisabled={status === '' || !effectiveOn || dateProblem !== null}
      onConfirm={(reason) => change.mutate(reason)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={ids.status}>New status</Label>
          <NativeSelect
            id={ids.status}
            value={status}
            disabled={change.isPending}
            onChange={(event) => setStatus(event.target.value as StudentStatus | '')}
          >
            <option value="">Choose…</option>
            {targets.map((t) => (
              <option key={t} value={t}>
                {STUDENT_STATUS_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.date}>Effective from</Label>
          <Input
            id={ids.date}
            type="date"
            value={effectiveOn}
            max={today}
            min={student.admittedOn}
            disabled={change.isPending}
            aria-invalid={dateProblem ? true : undefined}
            onChange={(event) => setEffectiveOn(event.target.value)}
          />
          {dateProblem && <p className="text-xs text-destructive">{dateProblem}</p>}
        </div>
      </div>
      {leaving && (
        <p className="text-sm text-muted-foreground">
          The student leaves their class on this date and any student login stops working. Coming
          back later is a readmission.
        </p>
      )}
      {change.error && !isAlreadyDone(change.error) && (
        <Alert variant="destructive">
          <AlertDescription>{describeApiError(change.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}

// ---- Login (§3.8, R40) ----

function LoginCard({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const [open, setOpen] = useState(false);
  // Only a principal (school.settings.manage) can read the setting; for anyone else the API
  // answers STUDENT_LOGIN_DISABLED when it is off.
  const canReadSettings = can(Capability.SCHOOL_SETTINGS_MANAGE);
  const settings = useQuery({
    queryKey: schoolKeys.settings,
    queryFn: () => unwrap(school.GET('/api/v1/school/settings')),
    enabled: canReadSettings,
  });
  const settingOff = settings.data?.studentLoginEnabled === false;

  let text: string;
  if (student.userId) text = 'This student has a login.';
  else if (settingOff) text = 'Student logins are turned off in the school settings.';
  else if (student.status !== 'active') text = 'Only an active student can be given a login.';
  else if (!student.hasBForm) text = 'Record the student’s B-Form number to issue a login: it is the username.';
  else text = 'No login yet.';

  const canIssue =
    can(Capability.USER_ACCOUNT_MANAGE) &&
    !settingOff &&
    student.status === 'active' &&
    student.userId === null &&
    student.hasBForm;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Login</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
      {canIssue && (
        <CardContent>
          <Button onClick={() => setOpen(true)}>Issue login</Button>
          <IssueStudentLoginDialog student={student} open={open} onOpenChange={setOpen} />
        </CardContent>
      )}
    </Card>
  );
}

// ---- Status history (§3.3) ----

const HISTORY_LIMIT = 25;

function StatusHistory({ studentId }: { studentId: string }) {
  const [page, setPage] = useState(1);
  const query = { page, limit: HISTORY_LIMIT } as const;
  const changes = useQuery({
    queryKey: [...studentsKeys.statusChanges(studentId), query],
    queryFn: () =>
      unwrap(
        studentsApi.GET('/api/v1/students/{id}/status-changes', {
          params: { path: { id: studentId }, query },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, StatusChangeDto>();
    return [
      column.accessor('effectiveOn', { header: 'Effective', cell: (info) => formatDay(info.getValue()) }),
      column.display({
        id: 'change',
        header: 'Change',
        cell: (info) => {
          const { fromStatus, toStatus } = info.row.original;
          return fromStatus
            ? `${STUDENT_STATUS_LABELS[fromStatus]} → ${STUDENT_STATUS_LABELS[toStatus]}`
            : `Admitted (${STUDENT_STATUS_LABELS[toStatus].toLowerCase()})`;
        },
      }),
      column.accessor('reason', {
        header: 'Reason',
        cell: (info) => <span className="whitespace-normal">{info.getValue() ?? '—'}</span>,
      }),
      column.accessor('changedByName', { header: 'By' }),
      column.accessor('createdAt', { header: 'Recorded', cell: (info) => formatDate(info.getValue()) }),
    ];
  }, []);

  return (
    <DataTable
      columns={columns}
      query={changes}
      getRowId={(row) => row.id}
      page={page}
      limit={HISTORY_LIMIT}
      onPageChange={setPage}
      emptyTitle="No status changes"
    />
  );
}
