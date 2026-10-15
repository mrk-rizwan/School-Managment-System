'use client';

import { ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LifeBuoyIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import { supportApi } from '@/lib/api/platform-support-contract';
import { platformKeys } from '@/lib/platform-session';

// Phase 5 slice 45 (rule 40, R349): opening read-only support access to one school. A reason the
// principals are shown, the ticket it serves, and a fresh code from the authenticator: a code
// already used to sign in is refused. The school's principals are told at once.

const IDENTITY = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
const schema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Say why, in at least 3 characters.')
    .max(500, 'At most 500 characters.')
    .refine((v) => !IDENTITY.test(v), 'Never write an identity number here.'),
  ticketRef: z
    .string()
    .trim()
    .min(1, 'The ticket this access serves.')
    .max(40, 'At most 40 characters.')
    .refine((v) => !IDENTITY.test(v), 'Never write an identity number here.'),
  totp: z.string().trim().regex(/^[0-9]{6}$/, 'The six digits your authenticator shows now.'),
});
type Values = z.infer<typeof schema>;

export function OpenSupportSession({ school }: { school: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <LifeBuoyIcon />
        Open support access
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>{open && <OpenForm school={school} onDone={() => setOpen(false)} />}</DialogContent>
      </Dialog>
    </>
  );
}

function OpenForm({ school, onDone }: { school: { id: string; name: string }; onDone: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { reason: '', ticketRef: '', totp: '' } });
  const openSession = useMutation({
    mutationFn: (body: Values) =>
      unwrap(
        supportApi.POST('/api/v1/platform/schools/{id}/support-sessions', { params: { path: { id: school.id } }, body }),
      ),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: platformKeys.support });
      toast.success(`Read-only access to ${school.name} is open.`);
      onDone();
      router.push(`/platform/support/${session.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.TOTP_INVALID) {
        form.setError('totp', { message: 'That code is not valid, or was already used. Wait for the next one.' }, { shouldFocus: true });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.SUPPORT_SESSION_OPEN) {
        form.setError('root.server', { message: 'This school already has open support access. Close it first, or ask its holder.' });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.SUPPORT_SESSION_LIMIT) {
        form.setError('root.server', { message: 'You already hold three open sessions. Close one first.' });
        return;
      }
      applyApiError(form, error);
    },
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((values) => openSession.mutate(values))}>
      <DialogHeader>
        <DialogTitle>Open support access to {school.name}</DialogTitle>
        <DialogDescription>
          Read-only, for a few hours. The principals are told who opened it and why, and every record you read is in
          their audit log. Messages, documents, payroll and identity numbers are never shown.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="reason" label="Reason (shown to the principals)" maxLength={500} autoFocus />
      <FormField control={form.control} name="ticketRef" label="Ticket reference" maxLength={40} />
      <FormField
        control={form.control}
        name="totp"
        label="Authenticator code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={openSession.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={openSession.isPending}>
          {openSession.isPending ? 'Opening…' : 'Open access'}
        </Button>
      </DialogFooter>
    </form>
  );
}
