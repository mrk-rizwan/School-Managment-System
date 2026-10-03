'use client';

import { Capability, ErrorCode, normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoPermissionState,
  isPermissionDenied,
} from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import {
  guardiansApi,
  type ContactCapability,
  type GuardianDetailDto,
  type GuardianStudentDto,
  type UpdateGuardianBody,
} from '@/lib/api/school-guardians-contract';
import { useCapabilities } from '../../academics/_lib/hooks';
import {
  ContactFields,
  blankToNull,
  contactFieldsSchema,
  formatIdentityInput,
  fullNameSchema,
  guardiansKeys,
  optionalCnicSchema,
} from '../_lib/guardians-ui';

/** contracts/slice-5.md §3.2, §3.3, §3.5, §3.7 and §6. */
export function GuardianDetail({ id }: { id: string }) {
  const guardian = useQuery({
    queryKey: guardiansKeys.detail(id),
    queryFn: () =>
      unwrap(guardiansApi.GET('/api/v1/guardians/{id}', { params: { path: { id } } })),
  });

  const back = (
    <Link
      href="/guardians"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      Guardians
    </Link>
  );
  const frame = (children: React.ReactNode) => (
    <>
      {back}
      <div className="rounded-lg border bg-card">{children}</div>
    </>
  );

  if (guardian.isPending) return frame(<LoadingState rows={5} />);
  if (guardian.error) {
    if (isPermissionDenied(guardian.error)) return frame(<NoPermissionState />);
    const notFound = guardian.error instanceof ApiError && guardian.error.status === 404;
    return frame(
      notFound ? (
        <EmptyState title="Guardian not found" description="Find them in the guardian list." />
      ) : (
        <ErrorState error={guardian.error} onRetry={() => void guardian.refetch()} />
      ),
    );
  }

  const data = guardian.data;
  const merged = data.status === 'merged';
  return (
    <>
      {back}
      <PageHeader
        title={data.fullName}
        description={merged ? 'Merged record' : 'Guardian'}
        actions={merged && <Badge variant="outline">Merged</Badge>}
      />
      {merged && (
        <Alert className="mb-6">
          <AlertDescription>
            This record was merged into another guardian and is kept read-only for history.{' '}
            {data.mergedIntoId && (
              <Link
                href={`/guardians/${data.mergedIntoId}`}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Open the current record
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Keyed by the last update so the form restarts from the saved values. */}
        <EditGuardianForm key={data.updatedAt} guardian={data} />
        <LoginCard guardian={data} />
      </div>
      <div className="mt-6">
        <h2 className="mb-3 text-base font-semibold">Students</h2>
        <GuardianStudents guardianId={data.id} />
      </div>
    </>
  );
}

// ---- Edit (§3.5) ----

const editSchema = contactFieldsSchema.extend({
  fullName: fullNameSchema,
  /** A new CNIC; blank keeps the recorded one. */
  cnic: optionalCnicSchema,
});
type EditValues = z.input<typeof editSchema>;

function EditGuardianForm({ guardian }: { guardian: GuardianDetailDto }) {
  const queryClient = useQueryClient();
  const merged = guardian.status === 'merged';
  // The CNIC is the login username, so it is locked once a login exists (§3.5, R24).
  const cnicLocked = guardian.userId !== null;
  const [existingId, setExistingId] = useState<string | null>(null);
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      fullName: guardian.fullName,
      cnic: '',
      phone: guardian.phone ?? '',
      email: guardian.email ?? '',
      contactCapability: guardian.contactCapability,
      address: guardian.address ?? '',
    },
    disabled: merged,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: guardiansKeys.all });
  const save = useMutation({
    mutationFn: (body: UpdateGuardianBody) =>
      unwrap(
        guardiansApi.PATCH('/api/v1/guardians/{id}', { params: { path: { id: guardian.id } }, body }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(guardiansKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: guardiansKeys.list });
      toast.success('Guardian saved.');
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : null;
      if (code === ErrorCode.GUARDIAN_CNIC_EXISTS) {
        const id = ((error as ApiError).details as { guardianId?: unknown } | null)?.guardianId;
        setExistingId(typeof id === 'string' ? id : null);
        form.setError('cnic', { message: (error as ApiError).message }, { shouldFocus: true });
        return;
      }
      if (code === ErrorCode.GUARDIAN_CNIC_LOCKED) {
        form.setError('cnic', { message: (error as ApiError).message });
        refresh();
        return;
      }
      if (code === ErrorCode.GUARDIAN_IS_PRIMARY_CONTACT) {
        form.setError('phone', { message: (error as ApiError).message }, { shouldFocus: true });
        return;
      }
      if (code === ErrorCode.GUARDIAN_MERGED || code === ErrorCode.CONCURRENT_UPDATE) refresh();
      applyApiError(form, error);
    },
  });

  // Only what changed is sent; blank optional fields clear (null).
  const onSubmit = form.handleSubmit((values) => {
    setExistingId(null);
    const phone = blankToNull(values.phone);
    const email = blankToNull(values.email.toLowerCase());
    const address = blankToNull(values.address);
    const body: UpdateGuardianBody = {
      ...(values.fullName.trim() !== guardian.fullName && { fullName: values.fullName.trim() }),
      ...(!cnicLocked && values.cnic.trim() && { cnic: normaliseIdentityDigits(values.cnic) }),
      ...(phone !== guardian.phone && { phone }),
      ...(email !== guardian.email && { email }),
      ...(address !== guardian.address && { address }),
      ...(values.contactCapability !== guardian.contactCapability && {
        contactCapability: values.contactCapability as ContactCapability,
      }),
    };
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Details</CardTitle>
        {merged && <CardDescription>A merged record cannot be edited.</CardDescription>}
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField control={form.control} name="fullName" label="Full name" maxLength={200} />
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">CNIC</p>
            <p className="font-mono text-sm text-muted-foreground">
              {guardian.cnicMasked ?? 'Not recorded'}
            </p>
            {cnicLocked && (
              <p className="text-xs text-muted-foreground">
                This guardian has a login and the CNIC is its username, so it cannot be changed
                here.
              </p>
            )}
          </div>
          {!cnicLocked && !merged && (
            <FormField
              control={form.control}
              name="cnic"
              label={guardian.hasCnic ? 'Replace CNIC (optional)' : 'Add CNIC (optional)'}
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
              <Link
                href={`/guardians/${existingId}`}
                className="font-medium underline underline-offset-4"
              >
                Open existing guardian
              </Link>{' '}
              <span className="text-muted-foreground">— the record with this CNIC.</span>
            </p>
          )}
          <ContactFields control={form.control} disabled={merged} />
          {!merged && (
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

// ---- Login (§3.7) ----

function LoginCard({ guardian }: { guardian: GuardianDetailDto }) {
  const { can } = useCapabilities();
  const [open, setOpen] = useState(false);
  const canIssue =
    can(Capability.USER_ACCOUNT_MANAGE) &&
    guardian.status === 'active' &&
    guardian.userId === null &&
    guardian.hasCnic;

  let text: string;
  if (guardian.userId) text = 'This guardian has a login.';
  else if (guardian.status === 'merged') text = 'A merged record cannot be given a login.';
  else if (!guardian.hasCnic) text = 'Record the guardian’s CNIC to issue a login: it is the username.';
  else text = 'No login yet.';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Login</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
      {canIssue && (
        <CardContent>
          <Button onClick={() => setOpen(true)}>Issue login</Button>
          <IssueLoginDialog guardian={guardian} open={open} onOpenChange={setOpen} />
        </CardContent>
      )}
    </Card>
  );
}

function IssueLoginDialog({
  guardian,
  open,
  onOpenChange,
}: {
  guardian: GuardianDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const issue = useMutation({
    mutationFn: () =>
      unwrap(
        guardiansApi.POST('/api/v1/guardians/{id}/issue-login', {
          params: { path: { id: guardian.id } },
        }),
      ),
    onSuccess: (user) => {
      toast.success(
        user.staffId
          ? `${guardian.fullName}'s existing staff login now covers this guardian too.`
          : `Login issued to ${guardian.fullName}.`,
      );
      onOpenChange(false);
    },
    onError: (error) => {
      // A resubmit after a lost response: the login exists, which is what was wanted.
      if (error instanceof ApiError && error.code === ErrorCode.LOGIN_ALREADY_EXISTS) {
        toast.info(`${guardian.fullName} already has a login.`);
        onOpenChange(false);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: guardiansKeys.all }),
  });
  const shownError =
    issue.error instanceof ApiError && issue.error.code === ErrorCode.LOGIN_ALREADY_EXISTS
      ? null
      : issue.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (issue.isPending) return;
        if (!next) issue.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!issue.isPending}>
        <DialogHeader>
          <DialogTitle>Issue a login to {guardian.fullName}?</DialogTitle>
          <DialogDescription>
            The username is the guardian’s CNIC without dashes. The password is the same CNIC
            until they change it. Tell the guardian in person; nothing is sent to them.
          </DialogDescription>
        </DialogHeader>
        {shownError && (
          <Alert variant="destructive">
            <AlertDescription>{describeApiError(shownError)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={issue.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? 'Issuing…' : 'Issue login'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Students (§3.3; rows arrive with slice 6) ----

const STUDENTS_LIMIT = 25;
const NO_STUDENTS: GuardianStudentDto[] = [];

function GuardianStudents({ guardianId }: { guardianId: string }) {
  const [page, setPage] = useState(1);
  const query = { page, limit: STUDENTS_LIMIT, sort: 'studentFullName' } as const;
  const students = useQuery({
    queryKey: [...guardiansKeys.students(guardianId), query],
    queryFn: () =>
      unwrap(
        guardiansApi.GET('/api/v1/guardians/{id}/students', {
          params: { path: { id: guardianId }, query },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, GuardianStudentDto>();
    return [
      column.accessor('studentFullName', {
        header: 'Student',
        cell: (info) => <span className="font-medium">{info.getValue()}</span>,
      }),
      column.accessor('admissionNo', { header: 'Admission no.' }),
      column.display({
        id: 'class',
        header: 'Class',
        cell: (info) =>
          [info.row.original.className, info.row.original.sectionName].filter(Boolean).join(' ') ||
          '—',
      }),
      column.accessor('relationship', { header: 'Relationship' }),
      column.display({
        id: 'flags',
        header: 'Role',
        cell: (info) => {
          const link = info.row.original;
          return (
            <span className="flex flex-wrap gap-1">
              {link.isPrimaryContact && <Badge variant="secondary">Primary contact</Badge>}
              {link.isFeePayer && <Badge variant="outline">Fee payer</Badge>}
            </span>
          );
        },
      }),
    ];
  }, []);

  const result = students.data;
  return (
    <DataTable
      columns={columns}
      data={result?.data ?? NO_STUDENTS}
      getRowId={(row) => row.linkId}
      page={result?.page ?? page}
      limit={result?.limit ?? STUDENTS_LIMIT}
      total={result?.total ?? 0}
      onPageChange={setPage}
      isLoading={students.isPending || students.isPlaceholderData}
      error={students.error}
      onRetry={() => void students.refetch()}
      emptyTitle="No students linked"
      emptyDescription="Students are linked to their guardians at admission."
    />
  );
}
