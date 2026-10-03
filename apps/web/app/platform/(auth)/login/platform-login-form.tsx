'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { platform, type PlatformLoginBody } from '@/lib/api/platform-contract';
import { useClearCacheOnArrival, useEnterSession } from '@/lib/platform-session';

// One request carries email, password and, once enrolled, the authenticator code
// (contracts/slice-1.md §3.1). Every wrong combination gets the same message from the API.
const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').max(254),
  password: z.string().min(1, 'Enter your password.').max(128),
  totpCode: z.union([
    z.literal(''),
    z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits.'),
  ]),
});
type LoginValues = z.infer<typeof schema>;

export function PlatformLoginForm() {
  useClearCacheOnArrival();
  const enterSession = useEnterSession();
  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '', totpCode: '' },
  });

  const login = useMutation({
    mutationFn: (body: PlatformLoginBody) =>
      unwrap(platform.POST('/api/v1/platform/auth/login', { body })),
    onSuccess: enterSession,
    onError: (error) => {
      form.resetField('totpCode');
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit(({ email, password, totpCode }) => {
    login.mutate({ email, password, ...(totpCode ? { totpCode } : {}) });
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform sign in</CardTitle>
        <CardDescription>For ASMS platform administrators.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="email"
            label="Email"
            type="email"
            autoComplete="username"
            autoFocus
          />
          <FormField
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
          />
          <FormField
            control={form.control}
            name="totpCode"
            label="Authenticator code — leave blank on first sign-in"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
