'use client';

import { useId, useState } from 'react';
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

/**
 * The one confirm-with-reason dialog (plan §3.10): every action that records a reason (status
 * changes, voids, revocations) asks through this. Confirm stays disabled until the reason is
 * long enough, and while the action is pending. The dialog cannot be dismissed mid-request.
 */
type ConfirmWithReasonDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Minimum reason length after trimming. */
  minLength?: number;
  maxLength?: number;
  destructive?: boolean;
  pending?: boolean;
  /** Extra fields shown above the reason (a choice the action needs, say). Optional. */
  children?: React.ReactNode;
  /** Keeps Confirm disabled while those extra fields are incomplete. */
  confirmDisabled?: boolean;
  onConfirm: (reason: string) => void;
};

export function ConfirmWithReasonDialog({
  open,
  onOpenChange,
  pending = false,
  ...props
}: ConfirmWithReasonDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={!pending}>
        {/* Body unmounts when the dialog closes, so the reason starts empty every time. */}
        <ReasonForm pending={pending} onCancel={() => onOpenChange(false)} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  title,
  description,
  confirmLabel = 'Confirm',
  minLength = 10,
  maxLength = 500,
  destructive = false,
  pending,
  children,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: Omit<ConfirmWithReasonDialogProps, 'open' | 'onOpenChange'> & {
  pending: boolean;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const id = useId();
  const trimmed = reason.trim();
  const tooShort = trimmed.length < minLength;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!tooShort && !pending && !confirmDisabled) onConfirm(trimmed);
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {children}
      <div className="grid gap-1.5">
        <Label htmlFor={id}>Reason</Label>
        <Textarea
          id={id}
          value={reason}
          maxLength={maxLength}
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={`${id}-hint`}
          rows={3}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {tooShort
            ? `At least ${minLength} characters (${trimmed.length} so far).`
            : `${trimmed.length} of ${maxLength} characters.`}
        </p>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant={destructive ? 'destructive' : 'default'}
          disabled={tooShort || pending || confirmDisabled}
        >
          {pending ? 'Working…' : confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
