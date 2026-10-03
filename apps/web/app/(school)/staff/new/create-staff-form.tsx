'use client';

import { ErrorCode, normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { staffApi, type CreateStaffBody } from '@/lib/api/school-staff-contract';
import { blankToNull, formatIdentityInput } from '../../guardians/_lib/guardians-ui';
import {
  StaffMoreFields,
  staffFieldsSchema,
  staffKeys,
  type StaffFieldValues,
} from '../_lib/staff-ui';

/**
 * contracts/slice-4.md §3.3, §8. A CNIC can exist once, so a resubmit with one answers with the
 * existing record; without one the submit button is disabled while the request runs.
 */
export function CreateStaffForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The staff member already holding the CNIC, after STAFF_CNIC_EXISTS.
  const [existingId, setExistingId] = useState<string | null>(null);
  const form = useForm<StaffFieldValues>({
    resolver: zodResolver(staffFieldsSchema),
    defaultValues: { fullName: '', cnic: '', phone: '', designation: '', joinedOn: '' },
  });

  const create = useMutation({
    mutationFn: (body: CreateStaffBody) => unwrap(staffApi.POST('/api/v1/staff', { body })),
    onSuccess: (staff) => {
      void queryClient.invalidateQueries({ queryKey: staffKeys.all });
      queryClient.setQueryData(staffKeys.detail(staff.id), staff);
      // Clears the identity digits before leaving the page.
      form.reset();
      toast.success(`${staff.fullName} added.`);
      router.push(`/staff/${staff.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.STAFF_CNIC_EXISTS) {
        const id = (error.details as { staffId?: unknown } | null)?.staffId;
        setExistingId(typeof id === 'string' ? id : null);
        form.setError('cnic', { message: error.message }, { shouldFocus: true });
        return;
      }
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setExistingId(null);
    create.mutate({
      fullName: values.fullName.trim(),
      cnic: values.cnic.trim() ? normaliseIdentityDigits(values.cnic) : null,
      phone: values.phone.trim(),
      designation: blankToNull(values.designation),
      joinedOn: values.joinedOn || undefined,
    });
  });

  return (
    <>
      <Link
        href="/staff"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        Staff
      </Link>
      <PageHeader
        title="New staff member"
        description="The record is created without a login. Issue a login and give a role from the staff member’s page."
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
              placeholder="35201-1234567-1"
              maxLength={15}
              format={formatIdentityInput}
            />
            {existingId && (
              <p className="-mt-2 text-sm">
                <Link href={`/staff/${existingId}`} className="font-medium underline underline-offset-4">
                  Open existing staff member
                </Link>{' '}
                <span className="text-muted-foreground">— the record with this CNIC.</span>
              </p>
            )}
            <StaffMoreFields control={form.control} />
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Saving…' : 'Add staff member'}
              </Button>
              <Link href="/staff" className={buttonVariants({ variant: 'outline' })}>
                Cancel
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
