'use client';

import { ErrorCode } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontalIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { school, type UserDto } from '@/lib/api/school-contract';
import { schoolKeys } from '@/lib/school-session';

type Action = 'reset' | 'disable' | 'enable';

/** §5.3 refusals in words the office can act on; anything else is the API's own sentence. */
function actionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const field = error.fieldErrors[0]?.message;
    if (field) return field;
    const reason = (error.details as { reason?: unknown } | null)?.reason;
    if (error.code === ErrorCode.PERMISSION_DENIED && reason === 'target_is_principal') {
      return 'Only someone who manages roles can change a principal’s account.';
    }
    if (error.code === ErrorCode.PERMISSION_DENIED && reason === 'target_exceeds_actor') {
      return 'This account can do things yours cannot, so you cannot change it.';
    }
    if (error.code === ErrorCode.LAST_PRINCIPAL) {
      return 'This is the school’s only active principal. Appoint another principal first.';
    }
    if (error.code === ErrorCode.IDENTITY_NUMBER_MISSING) {
      return 'This person has no identity number on record, so there is no default password to reset to.';
    }
  }
  return describeApiError(error);
}

/**
 * Office reset, disable and enable for one account (contracts/slice-2.md §5.3–§5.5), each asked
 * through the shared confirm-with-reason dialog. The reset also asks whether to keep or clear the
 * email: someone who got in on the default password may have planted their own address.
 */
export function UserActions({ user }: { user: UserDto }) {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [emailChoice, setEmailChoice] = useState<'keep' | 'clear' | null>(null);
  const choiceName = useId();

  const run = useMutation({
    mutationFn: ({ kind, reason }: { kind: Action; reason: string }) => {
      const params = { path: { id: user.id } };
      if (kind === 'reset') {
        const clearEmail = user.hasEmail && emailChoice === 'clear';
        return unwrap(
          school.POST('/api/v1/users/{id}/reset-password', {
            params,
            body: { reason, clearEmail },
          }),
        );
      }
      const path = kind === 'disable' ? '/api/v1/users/{id}/disable' : '/api/v1/users/{id}/enable';
      return unwrap(school.POST(path, { params, body: { reason } }));
    },
    onSuccess: (updated, { kind }) => {
      void queryClient.invalidateQueries({ queryKey: schoolKeys.users });
      setAction(null);
      toast.success(
        kind === 'reset'
          ? `${updated.fullName}’s password is now the default: their identity number digits.`
          : `${updated.fullName}’s account is ${updated.status === 'active' ? 'enabled' : 'disabled'}.`,
      );
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  const open = (kind: Action) => {
    setEmailChoice(null);
    setAction(kind);
  };
  const needsEmailChoice = action === 'reset' && user.hasEmail && emailChoice === null;

  const dialog = {
    reset: {
      title: `Reset password: ${user.fullName}`,
      description:
        'The password goes back to the default (their identity number digits). Every device they are signed in on is signed out.',
      confirmLabel: 'Reset password',
    },
    disable: {
      title: `Disable account: ${user.fullName}`,
      description: 'They are signed out everywhere and cannot sign in until the account is enabled.',
      confirmLabel: 'Disable account',
    },
    enable: {
      title: `Enable account: ${user.fullName}`,
      description: 'They can sign in again with their current password.',
      confirmLabel: 'Enable account',
    },
  } as const;
  const current = action ? dialog[action] : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.fullName}`} />}
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => open('reset')}>Reset password</DropdownMenuItem>
          {user.status === 'active' ? (
            <DropdownMenuItem variant="destructive" onClick={() => open('disable')}>
              Disable account
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => open('enable')}>Enable account</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmWithReasonDialog
        open={action !== null}
        onOpenChange={(next) => !next && setAction(null)}
        title={current?.title ?? ''}
        description={current?.description}
        confirmLabel={current?.confirmLabel}
        minLength={3}
        maxLength={500}
        destructive={action !== 'enable'}
        pending={run.isPending}
        confirmDisabled={needsEmailChoice}
        onConfirm={(reason) => action && run.mutate({ kind: action, reason })}
      >
        {action === 'reset' && (
          <fieldset className="grid gap-2 rounded-lg border p-3 text-sm" disabled={run.isPending}>
            <legend className="px-1 font-medium">Email on this account</legend>
            {user.hasEmail ? (
              <>
                <p className="text-muted-foreground">
                  <span className="font-mono text-foreground">{user.emailMasked}</span>
                  {user.hasVerifiedEmail ? ' (verified)' : ' (not verified)'}. If you are not sure
                  this address is theirs, clear it.
                </p>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={choiceName}
                    checked={emailChoice === 'keep'}
                    onChange={() => setEmailChoice('keep')}
                  />
                  Keep this email
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={choiceName}
                    checked={emailChoice === 'clear'}
                    onChange={() => setEmailChoice('clear')}
                  />
                  Clear the email
                </label>
              </>
            ) : (
              <p className="text-muted-foreground">
                This account has no email, so only the office can reset it.
              </p>
            )}
          </fieldset>
        )}
      </ConfirmWithReasonDialog>
    </>
  );
}
