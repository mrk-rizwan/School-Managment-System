'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// UI only. Slice 2 wires submission (POST /api/v1/auth/login), the remembered school code
// (lib/remembered-school.ts) and the error states. The username is never put in a URL, a log
// line or browser storage (CLAUDE.md rule 12).
const schema = z.object({
  schoolCode: z.string().trim().min(1, 'Enter your school code.'),
  username: z
    .string()
    .trim()
    .regex(/^\d{13}$/, 'Enter the 13 digits of your CNIC or B-Form number, without dashes.'),
  password: z.string().min(1, 'Enter your password.'),
});

type LoginValues = z.infer<typeof schema>;

export function LoginForm() {
  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { schoolCode: '', username: '', password: '' },
  });

  const onSubmit = form.handleSubmit(() => {
    toast.info('Sign-in is not available yet.');
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the account your school office created for you.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* method="post": if a submit happens before hydration, the identity digits go in a
            request body, never in the URL. */}
        <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="schoolCode"
            label="School code"
            autoComplete="organization"
            autoFocus
          />
          <FormField
            control={form.control}
            name="username"
            label="CNIC or B-Form number"
            hint="13 digits, no dashes."
            inputMode="numeric"
            autoComplete="username"
            maxLength={13}
          />
          <FormField
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
          />
          <Button type="submit" size="lg" className="w-full">
            Sign in
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
