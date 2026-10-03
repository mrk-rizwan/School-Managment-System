'use client';

import { ErrorCode, SCHOOL_STATUS_TRANSITIONS, type SchoolStatus } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { platform, type ChangeSchoolStatusBody, type SchoolDto } from '@/lib/api/platform-contract';
import { platformKeys } from '@/lib/platform-session';
import { SCHOOL_STATUS_LABELS } from '../school-ui';

type Target = ChangeSchoolStatusBody['status'];

const ACTIONS: Record<Target, { label: string; title: string; description: string }> = {
  active: {
    label: 'Activate',
    title: 'Activate school',
    description: 'The school’s users can sign in and work normally again.',
  },
  suspended: {
    label: 'Suspend',
    title: 'Suspend school',
    description: 'The school’s console becomes read-only until it is activated again.',
  },
  terminated: {
    label: 'Terminate',
    title: 'Terminate school',
    description: 'Every school user loses access and the record is frozen. This is final.',
  },
};

/**
 * Status change (contract §4.5). Targets come from SCHOOL_STATUS_TRANSITIONS, the table the API
 * also enforces; nothing is offered for a terminated school. The reason is asked for through the
 * shared confirm-with-reason dialog; terminating asks once more, stating that it is final.
 */
export function StatusChange({ school }: { school: SchoolDto }) {
  const queryClient = useQueryClient();
  const targets = SCHOOL_STATUS_TRANSITIONS[school.status].filter(isTarget);
  const [target, setTarget] = useState<Target | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  // Terminate only: the reason waits here while the final confirmation is open.
  const [terminateReason, setTerminateReason] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: (body: ChangeSchoolStatusBody) =>
      unwrap(
        platform.POST('/api/v1/platform/schools/{id}/change-status', {
          params: { path: { id: school.id } },
          body,
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(platformKeys.school(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: platformKeys.schools });
      setReasonOpen(false);
      setTerminateReason(null);
      toast.success(`${updated.name} is now ${SCHOOL_STATUS_LABELS[updated.status].toLowerCase()}.`);
    },
    onError: (error) => {
      // A 422 on `reason` (an identity number in it, say) carries its own sentence.
      const fieldMessage = error instanceof ApiError ? error.fieldErrors[0]?.message : undefined;
      toast.error(fieldMessage ?? describeApiError(error));
      if (error instanceof ApiError && error.code === ErrorCode.ILLEGAL_STATUS_TRANSITION) {
        // Someone else changed it first: show the current status and close.
        setReasonOpen(false);
        setTerminateReason(null);
        void queryClient.invalidateQueries({ queryKey: platformKeys.school(school.id) });
      }
    },
  });

  if (targets.length === 0) return null;
  const action = target ? ACTIONS[target] : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          Change status
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {targets.map((t) => (
            <DropdownMenuItem
              key={t}
              variant={t === 'terminated' ? 'destructive' : 'default'}
              onClick={() => {
                setTarget(t);
                setReasonOpen(true);
              }}
            >
              {ACTIONS[t].label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmWithReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={action ? `${action.title}: ${school.name}` : ''}
        description={action?.description}
        confirmLabel={target === 'terminated' ? 'Continue' : (action?.label ?? 'Confirm')}
        minLength={3}
        maxLength={500}
        destructive={target !== 'active'}
        pending={change.isPending && terminateReason === null}
        onConfirm={(reason) => {
          if (!target) return;
          if (target === 'terminated') {
            setReasonOpen(false);
            setTerminateReason(reason);
            return;
          }
          change.mutate({ status: target, reason });
        }}
      />

      <Dialog
        open={terminateReason !== null}
        onOpenChange={(open) => {
          if (!open && !change.isPending) setTerminateReason(null);
        }}
      >
        <DialogContent showCloseButton={!change.isPending}>
          <DialogHeader>
            <DialogTitle>Terminate {school.name} permanently?</DialogTitle>
            <DialogDescription>
              Termination is final. The school cannot be activated again, its record is frozen,
              and every one of its users loses access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={change.isPending}
              onClick={() => setTerminateReason(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={change.isPending}
              onClick={() => {
                if (terminateReason !== null) {
                  change.mutate({ status: 'terminated', reason: terminateReason });
                }
              }}
            >
              {change.isPending ? 'Working…' : 'Terminate permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function isTarget(status: SchoolStatus): status is Target {
  return status !== 'trial';
}
