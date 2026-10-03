'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import {
  ErrorState,
  LoadingState,
  NoPermissionState,
  isPermissionDenied,
} from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import {
  school,
  type SchoolSettingsDto,
  type UpdateSchoolSettingsBody,
} from '@/lib/api/school-contract';
import { schoolKeys } from '@/lib/school-session';

// contracts/slice-2.md §6: fee due day 1–28 (default the 10th, CLAUDE.md rule 15) and whether
// students may sign in.

const DUE_DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => {
  const day = i + 1;
  return { value: String(day), label: `${day}${ordinalSuffix(day)} of the month` };
});

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
}

const schema = z.object({
  feeDueDay: z.string().regex(/^([1-9]|1[0-9]|2[0-8])$/, 'Pick a day from 1 to 28.'),
  studentLoginEnabled: z.boolean(),
});
type SettingsValues = z.infer<typeof schema>;

export function SchoolSettings() {
  const settings = useQuery({
    queryKey: schoolKeys.settings,
    queryFn: () => unwrap(school.GET('/api/v1/school/settings')),
  });

  let body: React.ReactNode;
  if (settings.isPending) body = <Frame><LoadingState rows={3} /></Frame>;
  else if (settings.error) {
    body = (
      <Frame>
        {isPermissionDenied(settings.error) ? (
          <NoPermissionState />
        ) : (
          <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
        )}
      </Frame>
    );
  } else {
    // Keyed by the last update so the form restarts from the saved values.
    body = <SettingsForm key={settings.data.updatedAt} settings={settings.data} />;
  }

  return (
    <>
      <PageHeader title="School settings" description="Settings that apply to the whole school." />
      <div className="max-w-2xl">{body}</div>
    </>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border bg-card">{children}</div>;
}

function SettingsForm({ settings }: { settings: SchoolSettingsDto }) {
  const queryClient = useQueryClient();
  const toggleId = useId();
  const form = useForm<SettingsValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      feeDueDay: String(settings.feeDueDay),
      studentLoginEnabled: settings.studentLoginEnabled,
    },
  });

  const save = useMutation({
    mutationFn: (body: UpdateSchoolSettingsBody) =>
      unwrap(school.PATCH('/api/v1/school/settings', { body })),
    onSuccess: (updated) => {
      queryClient.setQueryData(schoolKeys.settings, updated);
      toast.success('Settings saved.');
    },
    // 403 SCHOOL_SUSPENDED and 422s land on the form.
    onError: (error) => applyApiError(form, error),
  });

  // Only what changed is sent; an unchanged form sends nothing.
  const onSubmit = form.handleSubmit(({ feeDueDay, studentLoginEnabled }) => {
    const day = Number(feeDueDay);
    const body: UpdateSchoolSettingsBody = {
      ...(day !== settings.feeDueDay && { feeDueDay: day }),
      ...(studentLoginEnabled !== settings.studentLoginEnabled && { studentLoginEnabled }),
    };
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fees and sign-in</CardTitle>
        <CardDescription>Amounts are in whole rupees; the due day applies to every month.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-5">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="feeDueDay"
            label="Fee due day"
            hint="Monthly fees fall due on this day."
            options={DUE_DAY_OPTIONS}
          />
          <Controller
            control={form.control}
            name="studentLoginEnabled"
            render={({ field }) => (
              <div className="flex items-start gap-3">
                <input
                  id={toggleId}
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={field.value}
                  onChange={(event) => field.onChange(event.target.checked)}
                  onBlur={field.onBlur}
                  ref={field.ref}
                  aria-describedby={`${toggleId}-hint`}
                />
                <div className="grid gap-0.5">
                  <label htmlFor={toggleId} className="text-sm font-medium">
                    Students can sign in
                  </label>
                  <p id={`${toggleId}-hint`} className="text-xs text-muted-foreground">
                    Students sign in with their B-Form number. A student with no number recorded
                    has no sign-in.
                  </p>
                </div>
              </div>
            )}
          />
          <div className="flex gap-2 pt-1">
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
        </form>
      </CardContent>
    </Card>
  );
}
