'use client';

import { ErrorCode } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { studentsApi, type StudentDetailDto } from '@/lib/api/school-students-contract';
import { studentsKeys } from './students-ui';

/** POST /students/:id/issue-login (contracts/slice-6.md §3.8, R40), confirmed in a dialog. */
export function IssueStudentLoginDialog({
  student,
  open,
  onOpenChange,
  onIssued,
}: {
  student: Pick<StudentDetailDto, 'id' | 'fullName'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: () => void;
}) {
  const queryClient = useQueryClient();
  const issue = useMutation({
    mutationFn: () =>
      unwrap(
        studentsApi.POST('/api/v1/students/{id}/issue-login', { params: { path: { id: student.id } } }),
      ),
    onSuccess: () => {
      toast.success(`Login issued to ${student.fullName}.`);
      onIssued?.();
      onOpenChange(false);
    },
    onError: (error) => {
      // A resubmit after a lost response: the login exists, which is what was wanted.
      if (error instanceof ApiError && error.code === ErrorCode.LOGIN_ALREADY_EXISTS) {
        toast.info(`${student.fullName} already has a login.`);
        onIssued?.();
        onOpenChange(false);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: studentsKeys.all }),
  });
  const shownError =
    issue.error instanceof ApiError && issue.error.code === ErrorCode.LOGIN_ALREADY_EXISTS ? null : issue.error;

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
          <DialogTitle>Issue a login to {student.fullName}?</DialogTitle>
          <DialogDescription>
            The username is the student’s B-Form number without dashes. The password is the same
            number until they change it. Tell the family in person; nothing is sent to them.
          </DialogDescription>
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
