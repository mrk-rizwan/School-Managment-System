'use client';

import { normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { school, type ForgotPasswordBody } from '@/lib/api/school-contract';
import { SCHOOL_PATHS } from '@/lib/school-session';
import { schoolCodeSchema, usernameSchema, useRememberedSchoolCode } from '../auth-fields';

// contracts/slice-2.md §3.3: never takes an email; always the same answer, whether or not the
// account exists or has a verified address.
const schema = z.object({ schoolCode: schoolCodeSchema, username: usernameSchema });
type ForgotValues = z.infer<typeof schema>;

export function ForgotForm() {
  const form = useForm<ForgotValues>({
    resolver: zodResolver(schema),
    defaultValues: { schoolCode: '', username: '' },
  });
  useRememberedSchoolCode(form, 'schoolCode');

  const request = useMutation({
    mutationFn: (body: ForgotPasswordBody) =>
      unwrap(school.POST('/api/v1/auth/forgot-password', { body })),
    onError: (error) => applyApiError(form, error),
  });

  const onSubmit = form.handleSubmit(({ schoolCode, username }) => {
    const digits = normaliseIdentityDigits(username);
    if (digits) request.mutate({ schoolCode, username: digits });
  });

  if (request.isSuccess) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            If this account has a verified email address, a link to reset the password has been
            sent to it. The link works for 15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-muted-foreground">
          <p>
            No email on your account, or nothing arrived? Ask your school office to reset your
            password. They will reset it to the default.
          </p>
          <Link href={SCHOOL_PATHS.login} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          We will email a reset link to the verified address on your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="schoolCode"
            label="School code"
            autoComplete="organization"
            maxLength={12}
          />
          <FormField
            control={form.control}
            name="username"
            label="CNIC or B-Form number"
            hint="13 digits. Dashes are optional."
            inputMode="numeric"
            autoComplete="username"
            maxLength={15}
          />
          <Button type="submit" size="lg" className="w-full" disabled={request.isPending}>
            {request.isPending ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          <Link href={SCHOOL_PATHS.login} className="underline underline-offset-3 hover:text-foreground">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
