'use client';

import { ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import QRCode from 'qrcode';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { platform } from '@/lib/api/platform-contract';
import { nextPathFor, useEnterSession, usePlatformMe, useSignOut } from '@/lib/platform-session';

const schema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'),
});
type CodeValues = z.infer<typeof schema>;

/**
 * First sign-in, step one (contracts/slice-1.md §3.4, §3.5). The secret is minted on a button
 * press, never on mount: React Strict Mode mounts twice and would mint two. The QR is drawn in
 * the browser from the otpauth URI; the URI and secret live only in this component's memory.
 */
export function TotpEnrolment() {
  const router = useRouter();
  const me = usePlatformMe();
  const signOut = useSignOut();
  const enterSession = useEnterSession();

  // An already-enrolled session has nothing to do here.
  useEffect(() => {
    if (me.data?.totpEnrolled) router.replace(nextPathFor(me.data));
  }, [me.data, router]);

  const enrol = useMutation({
    mutationFn: async () => {
      const { otpauthUri, secret } = await unwrap(
        platform.POST('/api/v1/platform/auth/totp/enrol'),
      );
      const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 200 });
      return { qrDataUrl, secret };
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.TOTP_ALREADY_ENROLLED) {
        void me.refetch();
      }
    },
  });

  const form = useForm<CodeValues>({ resolver: zodResolver(schema), defaultValues: { code: '' } });

  const confirm = useMutation({
    mutationFn: (code: string) =>
      unwrap(platform.POST('/api/v1/platform/auth/totp/confirm', { body: { code } })),
    onSuccess: enterSession,
    onError: (error) => {
      form.resetField('code');
      if (error instanceof ApiError && error.code === ErrorCode.TOTP_INVALID) {
        form.setError('code', { message: error.message }, { shouldFocus: true });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.TOTP_NOT_ENROLLED) {
        enrol.reset();
        form.setError('root.server', {
          message: 'The setup was not started or has expired. Set up the authenticator again.',
        });
        return;
      }
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit(({ code }) => confirm.mutate(code));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your authenticator</CardTitle>
        <CardDescription>
          Platform accounts need a code from an authenticator app at every sign-in. Use any app
          that supports time-based codes.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!enrol.data ? (
          <>
            {enrol.error && (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {describeApiError(enrol.error)}
              </p>
            )}
            <FormRootError form={form} />
            <Button
              size="lg"
              className="w-full"
              disabled={enrol.isPending}
              onClick={() => {
                form.clearErrors();
                enrol.mutate();
              }}
            >
              {enrol.isPending ? 'Preparing…' : 'Set up authenticator'}
            </Button>
          </>
        ) : (
          <>
            <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
              <li>Scan the QR code with your authenticator app, or type the key by hand.</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <div className="flex justify-center rounded-lg border bg-white p-3">
              {/* A data URL drawn in the browser: next/image adds nothing here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={enrol.data.qrDataUrl}
                alt="QR code for your authenticator app"
                width={200}
                height={200}
              />
            </div>
            <div className="grid gap-1">
              <p className="text-xs text-muted-foreground">Setup key</p>
              <p className="font-mono text-sm tracking-wider break-all" data-testid="totp-secret">
                {groupsOfFour(enrol.data.secret)}
              </p>
            </div>
            <form noValidate onSubmit={onSubmit} className="grid gap-4">
              <FormRootError form={form} />
              <FormField
                control={form.control}
                name="code"
                label="Authenticator code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
              />
              <Button type="submit" size="lg" className="w-full" disabled={confirm.isPending}>
                {confirm.isPending ? 'Checking…' : 'Confirm'}
              </Button>
            </form>
          </>
        )}
        <Button
          variant="ghost"
          className="w-full"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Cancel and sign out
        </Button>
      </CardContent>
    </Card>
  );
}

function groupsOfFour(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}
