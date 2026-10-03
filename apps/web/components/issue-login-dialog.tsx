'use client';

import { ErrorCode } from '@asms/shared';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, describeApiError } from '@/lib/api/errors';

/** The API's reason rule (3-500 characters, trimmed); blank sends none. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

/**
 * An optional reason for an issue-login (R57). Blank is allowed: the API then records where the
 * login was issued. `invalid` is true for 1-2 characters, which the API would refuse.
 */
export function OptionalReasonField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const length = value.trim().length;
  const invalid = length > 0 && length < REASON_MIN;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Reason (optional)</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={REASON_MAX}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-hint`}
        rows={2}
      />
      <p id={`${id}-hint`} className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
        {invalid ? `At least ${REASON_MIN} characters, or leave it blank.` : 'Recorded in the audit log.'}
      </p>
    </div>
  );
}

/** The trimmed reason, or undefined when blank; `ok` is false when it is too short to send. */
export function readReason(value: string): { reason: string | undefined; ok: boolean } {
  const trimmed = value.trim();
  return { reason: trimmed || undefined, ok: trimmed.length === 0 || trimmed.length >= REASON_MIN };
}

/**
 * Confirms and issues a login for a guardian or a student (rule 12: the office issues every
 * login; username and default password are the identity number). `issue` makes the POST with
 * the optional reason the clerk typed (undefined when blank).
 */
export function IssueLoginDialog<T>({
  fullName,
  description,
  issue: issueLogin,
  successMessage = () => `Login issued to ${fullName}.`,
  invalidate,
  open,
  onOpenChange,
  onIssued,
}: {
  fullName: string;
  /** What the username and password are, and that nothing is sent to them. */
  description: string;
  issue: (reason: string | undefined) => Promise<T>;
  successMessage?: (issued: T) => string;
  /** The cached record this login changes, refreshed however the request ends. */
  invalidate: QueryKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: () => void;
}) {
  const queryClient = useQueryClient();
  const [reasonText, setReasonText] = useState('');
  const { reason, ok } = readReason(reasonText);
  const issue = useMutation({
    mutationFn: issueLogin,
    onSuccess: (issued) => {
      toast.success(successMessage(issued));
      onIssued?.();
      close();
    },
    onError: (error) => {
      // A resubmit after a lost response: the login exists, which is what was wanted.
      if (error instanceof ApiError && error.code === ErrorCode.LOGIN_ALREADY_EXISTS) {
        toast.info(`${fullName} already has a login.`);
        onIssued?.();
        close();
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: invalidate }),
  });
  function close() {
    issue.reset();
    setReasonText('');
    onOpenChange(false);
  }
  const shownError =
    issue.error instanceof ApiError && issue.error.code === ErrorCode.LOGIN_ALREADY_EXISTS
      ? null
      : issue.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (issue.isPending) return;
        if (!next) return close();
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!issue.isPending}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ok && !issue.isPending) issue.mutate(reason);
          }}
        >
          <DialogHeader>
            <DialogTitle>Issue a login to {fullName}?</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <OptionalReasonField value={reasonText} onChange={setReasonText} disabled={issue.isPending} />
          {shownError && (
            <Alert variant="destructive">
              <AlertDescription>{describeApiError(shownError)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={issue.isPending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok || issue.isPending}>
              {issue.isPending ? 'Issuing…' : 'Issue login'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
