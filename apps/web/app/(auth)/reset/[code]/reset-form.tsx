'use client';

import { ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { school, type ResetPasswordBody } from '@/lib/api/school-contract';
import { SCHOOL_PATHS } from '@/lib/school-session';
import { newPasswordSchema } from '@/lib/validation';
import { SCHOOL_CODE_PATTERN, useFragmentToken } from '../../auth-fields';
import { LinkOutcome } from '../../link-states';

// contracts/slice-2.md §3.4. The token travels in the POST body only; the confirmation is
// checked here and never sent.
const schema = z
  .object({ newPassword: newPasswordSchema, confirmPassword: z.string() })
  .refine((v) => v.confirmPassword === v.newPassword, {
    path: ['confirmPassword'],
    message: 'The passwords do not match.',
  });
type ResetValues = z.infer<typeof schema>;

const unusableLink = (
  <LinkOutcome
    title="This link cannot be used"
    description="Reset links work once, for 15 minutes. Request a new one."
    href={SCHOOL_PATHS.forgot}
    linkLabel="Request a new link"
  />
);

export function ResetForm({ schoolCode }: { schoolCode: string }) {
  const { ready, token } = useFragmentToken();
  const router = useRouter();
  const form = useForm<ResetValues>({
    resolver: zodResolver(schema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const reset = useMutation({
    mutationFn: (body: ResetPasswordBody) =>
      unwrap(school.POST('/api/v1/auth/reset-password', { body })),
    onSuccess: () => {
      toast.success('Password changed. Sign in with your new password.');
      router.replace(SCHOOL_PATHS.login);
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.code === ErrorCode.TOKEN_INVALID)) {
        applyApiError(form, error);
      }
    },
  });

  if (!ready) return <LoadingState rows={3} />;
  const code = schoolCode.toLowerCase();
  if (!token || !SCHOOL_CODE_PATTERN.test(code)) return unusableLink;
  if (reset.error instanceof ApiError && reset.error.code === ErrorCode.TOKEN_INVALID) {
    return unusableLink;
  }

  const onSubmit = form.handleSubmit(({ newPassword }) =>
    reset.mutate({ schoolCode: code, token, newPassword }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          After this, every device signed in to your account is signed out.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
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
          <Button type="submit" size="lg" className="w-full" disabled={reset.isPending}>
            {reset.isPending ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
