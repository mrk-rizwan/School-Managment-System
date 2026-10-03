'use client';

import { ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { platform, type ChangePasswordBody } from '@/lib/api/platform-contract';
import { PLATFORM_PATHS, useEnterSession, usePlatformMe, useSignOut } from '@/lib/platform-session';

// contracts/slice-1.md §3.6: new password 12–128 characters and different from the current one.
// The confirmation is checked here only; it is never sent.
const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(128),
    newPassword: z
      .string()
      .min(12, 'Use at least 12 characters.')
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
type PasswordValues = z.infer<typeof schema>;

export function ChangePasswordForm() {
  const router = useRouter();
  const me = usePlatformMe();
  // The authenticator comes first (contract decision 3); a signed-out visitor is redirected by
  // SessionRedirects (app/platform/layout.tsx) when GET /me answers 401.
  useEffect(() => {
    if (me.data?.sessionStage === 'totp_enrolment') router.replace(PLATFORM_PATHS.enrol);
  }, [me.data, router]);

  const enterSession = useEnterSession();
  const signOut = useSignOut();
  const form = useForm<PasswordValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const change = useMutation({
    mutationFn: (body: ChangePasswordBody) =>
      unwrap(platform.POST('/api/v1/platform/auth/change-password', { body })),
    onSuccess: (me) => {
      toast.success('Password changed.');
      enterSession(me);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.CURRENT_PASSWORD_INCORRECT) {
        form.setError('currentPassword', { message: error.message }, { shouldFocus: true });
        return;
      }
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit(({ currentPassword, newPassword }) =>
    change.mutate({ currentPassword, newPassword }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change your password</CardTitle>
        <CardDescription>
          Choose a new password before you continue. Your other sessions will be signed out.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="currentPassword"
            label="Current password"
            type="password"
            autoComplete="current-password"
            autoFocus
          />
          <FormField
            control={form.control}
            name="newPassword"
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="12 to 128 characters."
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
          />
          <Button type="submit" size="lg" className="w-full" disabled={change.isPending}>
            {change.isPending ? 'Saving…' : 'Change password'}
          </Button>
        </form>
        <Button
          variant="ghost"
          className="w-full"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}
