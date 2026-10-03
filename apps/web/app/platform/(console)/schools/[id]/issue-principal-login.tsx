'use client';

import {
  ErrorCode,
  IDENTITY_INPUT_PATTERN,
  containsIdentityNumber,
  normaliseIdentityDigits,
  normalisePhone,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
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
import { ApiError } from '@/lib/api/errors';
import {
  platform,
  type IssuePrincipalLoginBody,
  type IssuePrincipalLoginDto,
  type SchoolDto,
} from '@/lib/api/platform-contract';
import { schoolNameSchema } from '../school-ui';

// contracts/slice-2.md §7: the one place a platform admin creates a login inside a school.
// The reason field appears only when the school already has an active principal (R103).

const schema = z.object({
  // Same rule as a school name: 2–200 characters, no control characters.
  fullName: schoolNameSchema,
  cnic: z
    .string()
    .trim()
    .regex(IDENTITY_INPUT_PATTERN, 'Enter the 13-digit CNIC, with or without dashes.'),
  phone: z
    .string()
    .trim()
    .refine((v) => normalisePhone(v) !== null, 'Enter a mobile number, such as 0300 1234567.'),
  reason: z.string().trim(),
});
type IssueValues = z.infer<typeof schema>;

export function IssuePrincipalLogin({ school }: { school: SchoolDto }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <KeyRoundIcon />
        Issue principal login
      </Button>
      <Dialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <DialogContent showCloseButton={!pending}>
          {/* Unmounts on close, so every opening starts with an empty form. */}
          <IssueForm school={school} onPendingChange={setPending} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function IssueForm({
  school,
  onPendingChange,
  onDone,
}: {
  school: SchoolDto;
  onPendingChange: (pending: boolean) => void;
  onDone: () => void;
}) {
  const [needsReason, setNeedsReason] = useState(false);
  const [issued, setIssued] = useState<IssuePrincipalLoginDto | null>(null);
  // Set when the CNIC already has a sign-in (§7 LINK_EXISTING_LOGIN_UNCONFIRMED): the body to
  // resend with confirmLinkExisting once the admin accepts the reset.
  const [linkBody, setLinkBody] = useState<IssuePrincipalLoginBody | null>(null);
  const form = useForm<IssueValues>({
    resolver: zodResolver(schema),
    defaultValues: { fullName: '', cnic: '', phone: '', reason: '' },
  });

  const issue = useMutation({
    mutationFn: (body: IssuePrincipalLoginBody) =>
      unwrap(
        platform.POST('/api/v1/platform/schools/{id}/issue-principal-login', {
          params: { path: { id: school.id } },
          body,
        }),
      ),
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    onSuccess: setIssued,
    onError: (error, body) => {
      setLinkBody(null);
      if (error instanceof ApiError && error.code === ErrorCode.ALREADY_PRINCIPAL) {
        // A resubmit after a timeout lands here: the first attempt worked (contract §7).
        toast.success('This person is already a principal of this school.');
        onDone();
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.ACTIVE_PRINCIPAL_EXISTS) {
        setNeedsReason(true);
        form.setError('reason', {
          message:
            'This school already has an active principal. Say why another is needed; the existing principals will be told.',
        }, { shouldFocus: true });
        return;
      }
      if (
        error instanceof ApiError &&
        error.code === ErrorCode.LINK_EXISTING_LOGIN_UNCONFIRMED &&
        !body.confirmLinkExisting
      ) {
        setLinkBody(body);
        return;
      }
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit(({ fullName, cnic, phone, reason }) => {
    if (needsReason) {
      if (reason.length < 3) {
        form.setError('reason', { message: 'Give a reason of at least 3 characters.' });
        return;
      }
      if (containsIdentityNumber(reason)) {
        form.setError('reason', { message: 'Do not put an identity number in the reason.' });
        return;
      }
    }
    const digits = normaliseIdentityDigits(cnic);
    const e164 = normalisePhone(phone);
    if (!digits || !e164) return; // the schema already refused these
    issue.mutate({
      fullName,
      cnic: digits,
      phone: e164,
      ...(needsReason && { reason }),
    });
  });

  if (issued) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Principal login issued</DialogTitle>
          <DialogDescription>
            {issued.linkedExistingUser
              ? `${issued.fullName}’s existing sign-in at this school now carries the principal role.`
              : `${issued.fullName} can now sign in to ${school.name}.`}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          They sign in with school code <span className="font-mono text-foreground">{school.shortCode}</span>{' '}
          and their CNIC digits as the username. Their password is the same digits; they will be
          prompted to change it.
        </p>
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  if (linkBody) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>This person already has a sign-in</DialogTitle>
          <DialogDescription>
            {linkBody.fullName} already signs in to {school.name}, for example as a parent.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm">
          <p>Issuing the principal role to that sign-in will:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>sign them out everywhere;</li>
            <li>reset their password to the default, their CNIC digits;</li>
            <li>clear their email address.</li>
          </ul>
          <p>They will be asked to change that password the next time they sign in.</p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={issue.isPending}
            onClick={() => setLinkBody(null)}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={issue.isPending}
            onClick={() => issue.mutate({ ...linkBody, confirmLinkExisting: true })}
          >
            {issue.isPending ? 'Working…' : 'Reset and issue login'}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Issue principal login: {school.name}</DialogTitle>
        <DialogDescription>
          Creates the principal’s staff record and sign-in. Their username and first password
          are their CNIC digits.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="fullName" label="Full name" maxLength={200} />
      <FormField
        control={form.control}
        name="cnic"
        label="CNIC"
        hint="13 digits. Dashes are optional."
        inputMode="numeric"
        autoComplete="off"
        maxLength={15}
      />
      <FormField
        control={form.control}
        name="phone"
        label="Mobile number"
        type="tel"
        autoComplete="off"
        maxLength={20}
      />
      {needsReason && (
        <FormField control={form.control} name="reason" label="Reason" maxLength={500} />
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={issue.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={issue.isPending}>
          {issue.isPending ? 'Working…' : 'Issue login'}
        </Button>
      </DialogFooter>
    </form>
  );
}
