'use client';

import {
  Capability,
  ErrorCode,
  PAYMENT_ACCOUNT_KINDS,
  PAYMENT_ACCOUNT_KIND_LABELS,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoPermissionState,
  isPermissionDenied,
} from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { ApiError, refusalMessage, toastApiError, type RefusalMessages } from '@/lib/api/errors';
import { feesApi, type PaymentAccountDto } from '@/lib/api/school-fees-contract';
import { formatDate } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { useIsPrincipal } from '../fees/_lib/fees-ui';
import { nameSchema } from '@/lib/validation';

// The school's payment accounts (phase-3-financial.md slice 18, rule 21). Read with any finance
// key; adding or disabling one is a payee change: school.settings.manage and the principal role
// (R233). Hiding the buttons is a convenience; the API refuses anyone else.

const accountKeys = ['school', 'payment-accounts'] as const;

const REFUSALS: RefusalMessages = {
  [`${ErrorCode.PERMISSION_DENIED}:principal_required`]: 'Only the principal can change where parents pay.',
};

export function PaymentAccountsCard() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const principal = useIsPrincipal();
  const canChange = can(Capability.SCHOOL_SETTINGS_MANAGE) && principal;
  const [adding, setAdding] = useState(false);
  const [disabling, setDisabling] = useState<PaymentAccountDto | null>(null);

  const query = { limit: OPTIONS_LIMIT } as const;
  const accounts = useQuery({
    queryKey: [...accountKeys, query],
    queryFn: () => unwrap(feesApi.GET('/api/v1/payment-accounts', { params: { query } })),
  });

  const disable = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(feesApi.POST('/api/v1/payment-accounts/{id}/disable', { params: { path: { id } }, body: { reason } })),
    onSuccess: (account) => {
      toast.success(`${account.title} disabled.`);
      void queryClient.invalidateQueries({ queryKey: accountKeys });
      setDisabling(null);
    },
    onError: (error) => {
      toast.error(refusalMessage(error, REFUSALS));
      if (error instanceof ApiError && (error.status === 403 || error.status === 409)) setDisabling(null);
    },
  });

  let body: React.ReactNode;
  if (accounts.isPending) body = <LoadingState rows={2} />;
  else if (accounts.error) {
    body = isPermissionDenied(accounts.error) ? (
      <NoPermissionState description="Payment accounts are shown to staff who handle fees." />
    ) : (
      <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
    );
  } else if (accounts.data.data.length === 0) {
    body = (
      <EmptyState
        title="No payment accounts"
        description="Until one is added, parents pay at the school counter only."
      />
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border">
        {accounts.data.data.map((account) => (
          <li key={account.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="grid min-w-0 gap-0.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {PAYMENT_ACCOUNT_KIND_LABELS[account.kind]}
                {account.bankName && <span className="font-normal text-muted-foreground">{account.bankName}</span>}
                {account.status === 'disabled' && <Badge variant="ghost">Disabled</Badge>}
              </p>
              <p className="text-sm">
                {account.title} · <span className="font-mono">{account.accountNo}</span>
              </p>
              {account.status === 'disabled' && (
                <p className="text-xs text-muted-foreground">
                  Disabled {account.disabledAt && formatDate(account.disabledAt)}
                  {account.disableReason && `: ${account.disableReason}`}
                </p>
              )}
            </div>
            {canChange && account.status === 'active' && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`Disable ${account.title}`}
                onClick={() => setDisabling(account)}
              >
                Disable
              </Button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where parents can pay</CardTitle>
        <CardDescription>
          An active account lets parents upload a deposit slip, which the office verifies before it counts as paid.
        </CardDescription>
        {canChange && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add account
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>{body}</CardContent>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>{adding && <AddAccountForm onDone={() => setAdding(false)} />}</DialogContent>
      </Dialog>
      <ConfirmWithReasonDialog
        open={disabling !== null}
        onOpenChange={(open) => !open && setDisabling(null)}
        title={`Disable ${disabling?.title ?? ''}`}
        description="Parents will no longer see this account. Slips already uploaded can still be verified."
        confirmLabel="Disable"
        minLength={3}
        maxLength={500}
        destructive
        pending={disable.isPending}
        onConfirm={(reason) => disabling && disable.mutate({ id: disabling.id, reason })}
      />
    </Card>
  );
}

/** Spaces dropped and letters upper-cased, as the API stores it. */
const compactUpper = (value: string) => value.replace(/\s+/g, '').toUpperCase();

const accountSchema = z.object({
  kind: z.enum(PAYMENT_ACCOUNT_KINDS),
  title: nameSchema(1, 100),
  accountNo: z
    .string()
    .transform(compactUpper)
    .refine((v) => /^[0-9A-Z-]{4,34}$/.test(v), 'Use 4 to 34 letters, digits or dashes.')
    .refine(
      (v) => !/^([0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9])$/.test(v),
      'This looks like an identity number. Enter the account or wallet number.',
    ),
  /** Banks only; blank is not sent. */
  bankName: z.string().trim().max(100, 'Use at most 100 characters.'),
});
type AccountInput = z.input<typeof accountSchema>;
type AccountValues = z.output<typeof accountSchema>;

const KIND_OPTIONS = PAYMENT_ACCOUNT_KINDS.map((value) => ({ value, label: PAYMENT_ACCOUNT_KIND_LABELS[value] }));

function AddAccountForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<AccountInput, unknown, AccountValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: { kind: 'bank', title: '', accountNo: '', bankName: '' },
  });
  const kind = useWatch({ control: form.control, name: 'kind' });

  const save = useMutation({
    mutationFn: ({ bankName, ...values }: AccountValues) =>
      unwrap(
        feesApi.POST('/api/v1/payment-accounts', {
          body: { ...values, ...(values.kind === 'bank' && bankName !== '' && { bankName }) },
        }),
      ),
    onSuccess: (account) => {
      void queryClient.invalidateQueries({ queryKey: accountKeys });
      toast.success(`${account.title} added.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 403) {
        form.setError('root.server', { message: refusalMessage(error, REFUSALS) });
        return;
      }
      if (!(error instanceof ApiError)) return toastApiError(error);
      applyApiError(form, error);
    },
  });

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <DialogHeader>
        <DialogTitle>Add a payment account</DialogTitle>
        <DialogDescription>Parents see these details when they pay from home.</DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="kind" label="Kind" options={KIND_OPTIONS} />
      <FormField
        control={form.control}
        name="title"
        label="Account title"
        hint="The account holder’s name, as the bank or wallet shows it."
        maxLength={100}
        autoComplete="off"
      />
      <FormField
        control={form.control}
        name="accountNo"
        label={kind === 'bank' ? 'Account number or IBAN' : 'Wallet number'}
        hint="Letters, digits and dashes. Spaces are removed."
        maxLength={40}
        autoComplete="off"
      />
      {kind === 'bank' && (
        <FormField control={form.control} name="bankName" label="Bank (optional)" maxLength={100} autoComplete="off" />
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Add account'}
        </Button>
      </DialogFooter>
    </form>
  );
}
