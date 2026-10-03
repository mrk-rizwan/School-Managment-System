'use client';

import { Capability, ErrorCode, normaliseIdentityDigits, normalisePhone } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { BackLink, NoPermissionState, StateCard } from '@/components/page-states';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  guardiansApi,
  type ContactCapability,
  type CreateGuardianBody,
  type GuardianLookupResultDto,
} from '@/lib/api/school-guardians-contract';
import { useCapabilities } from '@/lib/school-session';
import { blankToNull, formatIdentityInput, nameSchema, optionalCnicSchema } from '@/lib/validation';
import { LookupHits, lookupGuardians } from '../_lib/guardian-lookup';
import { ContactFields, contactFieldsSchema, guardiansKeys } from '../_lib/guardians-ui';

const schema = contactFieldsSchema.extend({ fullName: nameSchema(2, 200), cnic: optionalCnicSchema });
type Values = z.input<typeof schema>;

const TITLE = 'New guardian';

/** contracts/slice-5.md §3.4, §6; without guardian.manage, the no-permission state (plan §9). */
export function CreateGuardianForm() {
  const { can } = useCapabilities();
  if (!can(Capability.GUARDIAN_MANAGE)) {
    return (
      <>
        <BackLink href="/guardians">Guardians</BackLink>
        <PageHeader title={TITLE} />
        <StateCard>
          <NoPermissionState />
        </StateCard>
      </>
    );
  }
  return <GuardianForm />;
}

/**
 * Without an idempotency key, the guards against a duplicate are: a CNIC can exist once (the API
 * answers with the existing record), and a phone is looked up first so the office sees who
 * already uses it. Submit is disabled while either call runs.
 */
function GuardianForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The guardian already holding the CNIC, after GUARDIAN_CNIC_EXISTS.
  const [existingId, setExistingId] = useState<string | null>(null);
  // Guardians already using the typed phone, found before creating.
  const [phoneHits, setPhoneHits] = useState<{
    phone: string;
    result: GuardianLookupResultDto;
  } | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      fullName: '',
      cnic: '',
      phone: '',
      email: '',
      contactCapability: '',
      address: '',
    },
  });

  const create = useMutation({
    mutationFn: (body: CreateGuardianBody) =>
      unwrap(guardiansApi.POST('/api/v1/guardians', { body })),
    onSuccess: (guardian) => {
      void queryClient.invalidateQueries({ queryKey: guardiansKeys.all });
      queryClient.setQueryData(guardiansKeys.detail(guardian.id), guardian);
      // Clears the identity digits before leaving the page.
      form.reset();
      toast.success(`${guardian.fullName} added.`);
      router.push(`/guardians/${guardian.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.GUARDIAN_CNIC_EXISTS) {
        const id = (error.details as { guardianId?: unknown } | null)?.guardianId;
        setExistingId(typeof id === 'string' ? id : null);
        form.setError('cnic', { message: error.message }, { shouldFocus: true });
        return;
      }
      applyApiError(form, error);
    },
  });

  const phoneLookup = useMutation({ mutationFn: (phone: string) => lookupGuardians({ phone }) });

  const createFrom = (values: Values) => {
    setExistingId(null);
    setPhoneHits(null);
    const cnic = values.cnic.trim() ? normaliseIdentityDigits(values.cnic) : null;
    create.mutate({
      fullName: values.fullName.trim(),
      cnic,
      phone: blankToNull(values.phone),
      email: blankToNull(values.email.toLowerCase()),
      contactCapability: values.contactCapability as ContactCapability,
      address: blankToNull(values.address),
    });
  };

  // A phone is looked up first; when others use it the office decides before anything is created.
  const onSubmit = form.handleSubmit(async (values) => {
    const phone = values.phone.trim() ? normalisePhone(values.phone) : null;
    if (phone) {
      try {
        const hits = await phoneLookup.mutateAsync(phone);
        if (hits.data.length > 0) {
          setPhoneHits({ phone, result: hits });
          return;
        }
      } catch (error) {
        applyApiError(form, error);
        return;
      }
    }
    createFrom(values);
  });

  // Hits stay on screen only while the phone they were found for is still the one typed.
  const currentPhone = useWatch({ control: form.control, name: 'phone' });
  const shownHits =
    phoneHits && normalisePhone(currentPhone) === phoneHits.phone ? phoneHits.result : null;
  const busy = create.isPending || phoneLookup.isPending;

  return (
    <>
      <BackLink href="/guardians">Guardians</BackLink>
      <PageHeader
        title={TITLE}
        description="A guardian with neither CNIC nor phone can be recorded, but cannot be found by lookup or given a login."
      />
      <Card className="max-w-2xl">
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <FormRootError form={form} />
            <FormField control={form.control} name="fullName" label="Full name" maxLength={200} autoFocus />
            <FormField
              control={form.control}
              name="cnic"
              label="CNIC (optional)"
              hint="13 digits. Needed for a login: it becomes the username."
              inputMode="numeric"
              autoComplete="off"
              placeholder="#####-#######-#"
              maxLength={15}
              format={formatIdentityInput}
            />
            {existingId && (
              <p className="-mt-2 text-sm">
                <Link
                  href={`/guardians/${existingId}`}
                  className="font-medium underline underline-offset-4"
                >
                  Open existing guardian
                </Link>{' '}
                <span className="text-muted-foreground">— the record with this CNIC.</span>
              </p>
            )}
            <ContactFields control={form.control} />
            {shownHits && (
              <div className="grid gap-3 rounded-lg border p-3" role="alert">
                <p className="text-sm font-medium">
                  {shownHits.data.length === 1
                    ? 'A guardian already uses this phone number.'
                    : `${shownHits.data.length} guardians already use this phone number.`}{' '}
                  Open the record if it is the same person; families often share one phone.
                </p>
                <LookupHits result={shownHits} />
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void form.handleSubmit(createFrom)()}
                  >
                    {create.isPending ? 'Saving…' : 'Add as a different person'}
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" disabled={busy || shownHits !== null}>
                {phoneLookup.isPending ? 'Checking phone…' : create.isPending ? 'Saving…' : 'Add guardian'}
              </Button>
              <Link href="/guardians" className={buttonVariants({ variant: 'outline' })}>
                Cancel
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
