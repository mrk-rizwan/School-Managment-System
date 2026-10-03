'use client';

import { ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { EmptyState, ErrorState, LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { platform, type SchoolDto, type UpdateSchoolBody } from '@/lib/api/platform-contract';
import { platformKeys } from '@/lib/platform-session';
import { formatDateTime, schoolNameSchema, SchoolStatusBadge, useTimezoneOptions } from '../school-ui';
import { IssuePrincipalLogin } from './issue-principal-login';
import { StatusChange } from './status-change';

export function SchoolDetail({ id }: { id: string }) {
  const school = useQuery({
    queryKey: platformKeys.school(id),
    queryFn: () =>
      unwrap(platform.GET('/api/v1/platform/schools/{id}', { params: { path: { id } } })),
  });

  const back = (
    <Link
      href="/platform/schools"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      Schools
    </Link>
  );

  if (school.isPending) {
    return (
      <>
        {back}
        <div className="rounded-lg border bg-card">
          <LoadingState rows={4} />
        </div>
      </>
    );
  }

  if (school.error) {
    const notFound = school.error instanceof ApiError && school.error.status === 404;
    return (
      <>
        {back}
        <div className="rounded-lg border bg-card">
          {notFound ? (
            <EmptyState
              title="School not found"
              description="It may have been mistyped in the address. Find it in the school list."
            />
          ) : (
            <ErrorState error={school.error} onRetry={() => void school.refetch()} />
          )}
        </div>
      </>
    );
  }

  const data = school.data;
  const terminated = data.status === 'terminated';

  return (
    <>
      {back}
      <PageHeader
        title={data.name}
        description={`Short code ${data.shortCode}`}
        actions={
          !terminated && (
            <>
              <IssuePrincipalLogin school={data} />
              <StatusChange school={data} />
            </>
          )
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Keyed by the last update so the form restarts from the saved values. */}
        <EditSchoolForm key={data.updatedAt} school={data} />
        <Card>
          <CardHeader>
            <CardTitle>Record</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm">
              <Detail label="Status">
                <SchoolStatusBadge status={data.status} />
              </Detail>
              <Detail label="Short code">
                <span className="font-mono">{data.shortCode}</span>
              </Detail>
              <Detail label="Created">{formatDateTime(data.createdAt)}</Detail>
              <Detail label="Last updated">{formatDateTime(data.updatedAt)}</Detail>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const editSchema = z.object({
  name: schoolNameSchema,
  timezone: z.string().min(1, 'Pick a time zone.'),
});
type EditValues = z.infer<typeof editSchema>;

/**
 * Name and time zone only (contract §4.4). The short code is never sent; status changes go
 * through the status dialog; the fee due day belongs to the principal after creation.
 */
function EditSchoolForm({ school }: { school: SchoolDto }) {
  const queryClient = useQueryClient();
  const terminated = school.status === 'terminated';
  const timezoneOptions = useTimezoneOptions(school.timezone);
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: school.name, timezone: school.timezone },
    disabled: terminated,
  });

  const save = useMutation({
    mutationFn: (body: UpdateSchoolBody) =>
      unwrap(
        platform.PATCH('/api/v1/platform/schools/{id}', {
          params: { path: { id: school.id } },
          body,
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(platformKeys.school(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: platformKeys.schools });
      toast.success('School saved.');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.SCHOOL_TERMINATED) {
        void queryClient.invalidateQueries({ queryKey: platformKeys.school(school.id) });
      }
      applyApiError(form, error);
    },
  });

  // Only what changed is sent; an unchanged form sends nothing.
  const onSubmit = form.handleSubmit(({ name, timezone }) => {
    const body: UpdateSchoolBody = {
      ...(name !== school.name && { name }),
      ...(timezone !== school.timezone && { timezone }),
    };
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>School details</CardTitle>
        <CardDescription>
          {terminated
            ? 'This school is terminated. Its record is frozen and cannot be edited.'
            : 'The short code cannot be changed.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField control={form.control} name="name" label="School name" maxLength={200} />
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">Short code</p>
            <p className="font-mono text-sm text-muted-foreground">{school.shortCode}</p>
          </div>
          <FormField
            control={form.control}
            name="timezone"
            label="Time zone"
            options={timezoneOptions}
          />
          {!terminated && (
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

