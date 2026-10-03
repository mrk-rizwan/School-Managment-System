'use client';

import { normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { school, type LoginBody } from '@/lib/api/school-contract';
import { rememberSchoolCode } from '@/lib/remembered-school';
import { SCHOOL_PATHS, useClearCacheOnArrival, useEnterSession } from '@/lib/school-session';
import { schoolCodeSchema, usernameSchema, useRememberedSchoolCode } from '../auth-fields';

// contracts/slice-2.md §3.1 and §10. The username is never put in a URL, a log line or browser
// storage (CLAUDE.md rule 12); only the school code is remembered.
const schema = z.object({
  schoolCode: schoolCodeSchema,
  username: usernameSchema,
  password: z.string().min(1, 'Enter your password.').max(128),
});
type LoginValues = z.infer<typeof schema>;

export function LoginForm() {
  useClearCacheOnArrival();
  const enterSession = useEnterSession();
  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { schoolCode: '', username: '', password: '' },
  });
  useRememberedSchoolCode(form, 'schoolCode');

  const login = useMutation({
    mutationFn: (body: LoginBody) => unwrap(school.POST('/api/v1/auth/login', { body })),
    onSuccess: (me, body) => {
      rememberSchoolCode(body.schoolCode);
      enterSession(me);
    },
    onError: (error) => {
      form.resetField('password');
      if (error instanceof ApiError && error.status === 503) {
        form.setError('root.server', {
          message: 'Sign-in is unavailable at the moment. Try again shortly.',
        });
        return;
      }
      // 401 AUTH_FAILED carries the one generic sentence; 429 becomes the wait (describeApiError).
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit(({ schoolCode, username, password }) => {
    const digits = normaliseIdentityDigits(username);
    if (!digits) return; // the schema already refused it
    login.mutate({ schoolCode, username: digits, password });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the account your school office created for you.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* method="post": if a submit happens before hydration, the identity digits go in a
            request body, never in the URL. */}
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
          <FormField
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
          />
          <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          <Link href={SCHOOL_PATHS.forgot} className="underline underline-offset-3 hover:text-foreground">
            Forgot your password?
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
