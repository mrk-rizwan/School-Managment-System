'use client';

import { ErrorCode } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoadingState } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { school, type VerifyEmailBody } from '@/lib/api/school-contract';
import { SCHOOL_PATHS, schoolKeys } from '@/lib/school-session';
import { SCHOOL_CODE_PATTERN, useFragmentToken } from '../../auth-fields';
import { LinkOutcome } from '../../link-states';

// contracts/slice-2.md §3.5. Verification happens only on the button press, never on load
// (mail scanners open links); the token travels in the POST body.
export function VerifyEmail({ schoolCode }: { schoolCode: string }) {
  const { ready, token } = useFragmentToken();
  const queryClient = useQueryClient();
  const verify = useMutation({
    mutationFn: (body: VerifyEmailBody) =>
      unwrap(school.POST('/api/v1/auth/verify-email', { body })),
    // A signed-in console shows the new state (banner, account page) on its next look.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: schoolKeys.me }),
  });

  if (!ready) return <LoadingState rows={3} />;
  const code = schoolCode.toLowerCase();
  const tokenInvalid =
    verify.error instanceof ApiError && verify.error.code === ErrorCode.TOKEN_INVALID;
  if (!token || !SCHOOL_CODE_PATTERN.test(code) || tokenInvalid) {
    return (
      <LinkOutcome
        title="This link cannot be used"
        description="Verification links work once, for 24 hours, and only for the address they were sent to. Sign in and ask for a new link from your account page."
        href={SCHOOL_PATHS.account}
        linkLabel="Go to your account"
      />
    );
  }
  if (verify.isSuccess) {
    return (
      <LinkOutcome
        title="Email verified"
        description="Password reset links will go to this address. You can now change your password."
        href={SCHOOL_PATHS.account}
        linkLabel="Go to your account"
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your email address</CardTitle>
        <CardDescription>
          Confirm that this address belongs to you. Password reset links will be sent to it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {verify.error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {describeApiError(verify.error)}
          </p>
        )}
        <Button
          size="lg"
          className="w-full"
          disabled={verify.isPending}
          onClick={() => verify.mutate({ schoolCode: code, token })}
        >
          {verify.isPending ? 'Verifying…' : 'Verify email address'}
        </Button>
      </CardContent>
    </Card>
  );
}
