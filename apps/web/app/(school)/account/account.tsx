'use client';

import { ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type FieldValues, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  school,
  type ChangeEmailBody,
  type ChangeSchoolPasswordBody,
  type MeDto,
} from '@/lib/api/school-contract';
import { schoolKeys, useSchoolMe, useSetMe } from '@/lib/school-session';

// contracts/slice-2.md §4.2, §4.3, §10. The shell renders this only after GET /me loaded.
export function Account() {
  const me = useSchoolMe();
  if (!me.data) return null;
  return (
    <>
      <PageHeader title="Your account" description={`${me.data.fullName} · ${me.data.school.name}`} />
      <div className="grid max-w-2xl gap-6">
        <EmailCard me={me.data} />
        <PasswordCard me={me.data} />
      </div>
    </>
  );
}

type WithCurrentPassword = FieldValues & { currentPassword: string };

/** A wrong current password belongs on its field; anything else goes through applyApiError. */
function showError<T extends WithCurrentPassword>(form: UseFormReturn<T>, error: unknown) {
  if (error instanceof ApiError && error.code === ErrorCode.CURRENT_PASSWORD_INCORRECT) {
    const setError = form.setError as UseFormReturn<WithCurrentPassword>['setError'];
    setError('currentPassword', { message: error.message }, { shouldFocus: true });
    return;
  }
  applyApiError(form, error);
}

const currentPasswordSchema = z.string().min(1, 'Enter your current password.').max(128);

const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Use at most 254 characters.')
    .pipe(z.email('Enter a valid email address.')),
  currentPassword: currentPasswordSchema,
});
type EmailValues = z.infer<typeof emailSchema>;

function EmailCard({ me }: { me: MeDto }) {
  const setMe = useSetMe();
  const form = useForm<EmailValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: me.email ?? '', currentPassword: '' },
  });

  const change = useMutation({
    mutationFn: (body: ChangeEmailBody) => unwrap(school.POST('/api/v1/me/change-email', { body })),
    onSuccess: (updated) => {
      setMe(updated);
      form.reset({ email: updated.email ?? '', currentPassword: '' });
      toast.success(
        updated.hasVerifiedEmail
          ? 'This address is already verified.'
          : 'We sent a link to that address. Open it to verify the address.',
      );
    },
    onError: (error) => showError(form, error),
  });

  const onSubmit = form.handleSubmit((values) => change.mutate(values));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email address</CardTitle>
        <CardDescription>Password reset links go to this address once it is verified.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Current:</span>
          {me.email ? (
            <>
              <span className="font-medium">{me.email}</span>
              {me.hasVerifiedEmail ? (
                <Badge variant="secondary">Verified</Badge>
              ) : (
                <Badge variant="outline">Not verified</Badge>
              )}
            </>
          ) : (
            <span>None</span>
          )}
        </div>
        {me.email && !me.hasVerifiedEmail && (
          <p className="text-sm text-muted-foreground">
            Open the link we emailed to verify it. To get a new link, save the address again.
          </p>
        )}
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="email"
            label="Email address"
            type="email"
            autoComplete="email"
            maxLength={254}
          />
          <FormField
            control={form.control}
            name="currentPassword"
            label="Current password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
          />
          <div>
            <Button type="submit" disabled={change.isPending}>
              {change.isPending ? 'Saving…' : 'Save and send verification link'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const passwordSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    newPassword: z
      .string()
      .min(8, 'Use at least 8 characters.')
      .max(128, 'Use at most 128 characters.'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'The new password must be different from the current one.',
  })
  .refine((v) => v.confirmPassword === v.newPassword, {
    path: ['confirmPassword'],
    message: 'The passwords do not match.',
  });
type PasswordValues = z.infer<typeof passwordSchema>;

/** §4.3: needs a verified email, so every changed password has a reset path (rule 12). */
function PasswordCard({ me }: { me: MeDto }) {
  const setMe = useSetMe();
  const queryClient = useQueryClient();
  const locked = !me.hasVerifiedEmail;
  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    disabled: locked,
  });

  const change = useMutation({
    mutationFn: (body: ChangeSchoolPasswordBody) =>
      unwrap(school.POST('/api/v1/me/change-password', { body })),
    onSuccess: (updated) => {
      setMe(updated);
      form.reset();
      toast.success('Password changed. Your other devices have been signed out.');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.EMAIL_NOT_VERIFIED) {
        // The address changed elsewhere: reload the account, which locks this form.
        void queryClient.invalidateQueries({ queryKey: schoolKeys.me });
      }
      showError(form, error);
    },
  });

  const onSubmit = form.handleSubmit(({ currentPassword, newPassword }) =>
    change.mutate({ currentPassword, newPassword }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          {locked
            ? 'Add and verify an email address first, so you can reset your password if you forget it.'
            : 'Changing it signs out your other devices.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="currentPassword"
            label="Current password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
          />
          <FormField
            control={form.control}
            name="newPassword"
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="8 to 128 characters. Not your identity number."
            maxLength={128}
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            maxLength={128}
          />
          <div>
            <Button type="submit" disabled={locked || change.isPending}>
              {change.isPending ? 'Saving…' : 'Change password'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
