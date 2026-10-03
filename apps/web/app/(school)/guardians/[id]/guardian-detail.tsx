'use client';

import { Capability, ErrorCode, normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { IssueLoginDialog } from '@/components/issue-login-dialog';
import { BackLink, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  guardiansApi,
  type ContactCapability,
  type GuardianDetailDto,
  type GuardianStudentDto,
  type UpdateGuardianBody,
} from '@/lib/api/school-guardians-contract';
import { useCapabilities } from '@/lib/school-session';
import { blankToNull, formatIdentityInput, nameSchema, optionalCnicSchema } from '@/lib/validation';
import { ContactFields, contactFieldsSchema, guardiansKeys } from '../_lib/guardians-ui';

/** contracts/slice-5.md §3.2, §3.3, §3.5, §3.7 and §6. */
export function GuardianDetail({ id }: { id: string }) {
  const guardian = useQuery({
    queryKey: guardiansKeys.detail(id),
    queryFn: () =>
      unwrap(guardiansApi.GET('/api/v1/guardians/{id}', { params: { path: { id } } })),
  });

  return (
    <>
      <BackLink href="/guardians">Guardians</BackLink>
      <QueryStates
        query={guardian}
        notFound={{
          title: 'Guardian not found',
          description: 'Find them in the guardian list.',
        }}
      >
        {(data) => {
          const merged = data.status === 'merged';
          return (
            <>
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
        }}
      </QueryStates>
    </>
  );
}

// ---- Edit (§3.5) ----

const editSchema = contactFieldsSchema.extend({
  fullName: nameSchema(2, 200),
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
              placeholder="#####-#######-#"
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
          <IssueLoginDialog
            fullName={guardian.fullName}
            description="The username is the guardian’s CNIC without dashes. The password is the same CNIC until they change it. Tell the guardian in person; nothing is sent to them."
            issue={(reason) =>
              unwrap(
                guardiansApi.POST('/api/v1/guardians/{id}/issue-login', {
                  params: { path: { id: guardian.id } },
                  body: { ...(reason && { reason }) },
                }),
              )
            }
            successMessage={(user) =>
              user.staffId
                ? `${guardian.fullName}'s existing staff login now covers this guardian too.`
                : `Login issued to ${guardian.fullName}.`
            }
            invalidate={guardiansKeys.all}
            open={open}
            onOpenChange={setOpen}
          />
        </CardContent>
      )}
    </Card>
  );
}

// ---- Students (§3.3, filled by slice 6: contracts/slice-6.md §9) ----

const STUDENTS_LIMIT = 25;

function GuardianStudents({ guardianId }: { guardianId: string }) {
  const { can } = useCapabilities();
  // The student record is scoped by student.view; without it the name is plain text.
  const canOpenStudent = can(Capability.STUDENT_VIEW);
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
        cell: (info) =>
          canOpenStudent ? (
            <Link
              href={`/students/${info.row.original.studentId}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {info.getValue()}
            </Link>
          ) : (
            <span className="font-medium">{info.getValue()}</span>
          ),
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
              {link.canLogin && <Badge variant="outline">May log in</Badge>}
              {link.linkEndedAt && <Badge variant="ghost">Link ended</Badge>}
            </span>
          );
        },
      }),
    ];
  }, [canOpenStudent]);

  return (
    <DataTable
      columns={columns}
      query={students}
      getRowId={(row) => row.linkId}
      page={page}
      limit={STUDENTS_LIMIT}
      onPageChange={setPage}
      emptyTitle="No students linked"
      emptyDescription="Students are linked to their guardians at admission."
    />
  );
}
