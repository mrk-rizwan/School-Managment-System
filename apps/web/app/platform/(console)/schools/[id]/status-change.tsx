'use client';

import { ErrorCode, SCHOOL_STATUS_TRANSITIONS, type SchoolStatus } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useId, useState } from 'react';
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
import { Label } from '@/components/ui/label';
import { ApiError, describeApiError, toastApiError } from '@/lib/api/errors';
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
    description: 'The school keeps working; a banner is shown to its users until it is activated again.',
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
 *
 * Suspending also offers to set the school's SMS allowance to 0 (on by default): suspension
 * leaves the school working, so without it the platform keeps paying for its SMS. The allowance is
 * a second request (`PATCH /schools/:id`) sent only after the status change has succeeded; if it
 * fails the suspension stands and the toast says the allowance is unchanged.
 */
export function StatusChange({ school }: { school: SchoolDto }) {
  const queryClient = useQueryClient();
  const targets = SCHOOL_STATUS_TRANSITIONS[school.status].filter(isTarget);
  const [target, setTarget] = useState<Target | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  // Terminate only: the reason waits here while the final confirmation is open.
  const [terminateReason, setTerminateReason] = useState<string | null>(null);
  // Suspend only: also set the SMS allowance to 0.
  const [zeroSms, setZeroSms] = useState(true);
  const zeroSmsId = useId();

  const change = useMutation({
    mutationFn: async ({ body, zeroSmsCap }: { body: ChangeSchoolStatusBody; zeroSmsCap: boolean }) => {
      const updated = await unwrap(
        platform.POST('/api/v1/platform/schools/{id}/change-status', {
          params: { path: { id: school.id } },
          body,
        }),
      );
      if (!zeroSmsCap || updated.smsMonthlyCap === 0) return { updated, capError: null };
      try {
        const capped = await unwrap(
          platform.PATCH('/api/v1/platform/schools/{id}', {
            params: { path: { id: school.id } },
            body: { smsMonthlyCap: 0 },
          }),
        );
        return { updated: capped, capError: null };
      } catch (capError) {
        return { updated, capError };
      }
    },
    onSuccess: ({ updated, capError }, { zeroSmsCap }) => {
      queryClient.setQueryData(platformKeys.school(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: platformKeys.schools });
      void queryClient.invalidateQueries({ queryKey: platformKeys.deliveryHealth });
      setReasonOpen(false);
      setTerminateReason(null);
      const done = `${updated.name} is now ${SCHOOL_STATUS_LABELS[updated.status].toLowerCase()}.`;
      if (capError !== null) {
        toast.error(`${done} The SMS allowance was not changed: ${describeApiError(capError)}`);
      } else if (zeroSmsCap) {
        toast.success(`${done} Its SMS allowance is 0.`);
      } else {
        toast.success(done);
      }
    },
    onError: (error) => {
      // A 422 on `reason` (an identity number in it, say) carries its own sentence.
      toastApiError(error);
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
                setZeroSms(true);
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
          change.mutate({ body: { status: target, reason }, zeroSmsCap: target === 'suspended' && zeroSms });
        }}
      >
        {target === 'suspended' && (
          <div className="flex items-start gap-2">
            <input
              id={zeroSmsId}
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={zeroSms}
              disabled={change.isPending}
              onChange={(event) => setZeroSms(event.target.checked)}
            />
            <div className="grid gap-0.5">
              <Label htmlFor={zeroSmsId}>Also set this school’s SMS allowance to 0</Label>
              <p className="text-xs text-muted-foreground">
                Now {school.smsMonthlyCap.toLocaleString('en-PK')} a month. Change it back under Messaging when the
                school is activated.
              </p>
            </div>
          </div>
        )}
      </ConfirmWithReasonDialog>

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
                  change.mutate({ body: { status: 'terminated', reason: terminateReason }, zeroSmsCap: false });
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
