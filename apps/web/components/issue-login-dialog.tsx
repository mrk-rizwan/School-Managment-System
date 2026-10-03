'use client';

import { ErrorCode } from '@asms/shared';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
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
import { ApiError, describeApiError } from '@/lib/api/errors';

/**
 * Confirms and issues a login for a guardian or a student (rule 12: the office issues every
 * login; username and default password are the identity number). `issue` makes the POST.
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
  issue: () => Promise<T>;
  successMessage?: (issued: T) => string;
  /** The cached record this login changes, refreshed however the request ends. */
  invalidate: QueryKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: () => void;
}) {
  const queryClient = useQueryClient();
  const issue = useMutation({
    mutationFn: issueLogin,
    onSuccess: (issued) => {
      toast.success(successMessage(issued));
      onIssued?.();
      onOpenChange(false);
    },
    onError: (error) => {
      // A resubmit after a lost response: the login exists, which is what was wanted.
      if (error instanceof ApiError && error.code === ErrorCode.LOGIN_ALREADY_EXISTS) {
        toast.info(`${fullName} already has a login.`);
        onIssued?.();
        onOpenChange(false);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: invalidate }),
  });
  const shownError =
    issue.error instanceof ApiError && issue.error.code === ErrorCode.LOGIN_ALREADY_EXISTS
      ? null
      : issue.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (issue.isPending) return;
        if (!next) issue.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!issue.isPending}>
        <DialogHeader>
          <DialogTitle>Issue a login to {fullName}?</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {shownError && (
          <Alert variant="destructive">
            <AlertDescription>{describeApiError(shownError)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={issue.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? 'Issuing…' : 'Issue login'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
