'use client';

import {
  DEFAULT_FEE_DUE_DAY,
  DEFAULT_TIMEZONE,
  ErrorCode,
  MAX_FEE_DUE_DAY,
  MIN_FEE_DUE_DAY,
  SHORT_CODE_PATTERN,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { platform, type CreateSchoolBody, type SchoolDto } from '@/lib/api/platform-contract';
import { platformKeys } from '@/lib/platform-session';
import { schoolNameSchema, useTimezoneOptions } from '../school-ui';

// contracts/slice-1.md §4.2. The API repeats every rule; these only save a round trip.
const FEE_DUE_DAY_MESSAGE = `Enter a day from ${MIN_FEE_DUE_DAY} to ${MAX_FEE_DUE_DAY}.`;
const schema = z.object({
  name: schoolNameSchema,
  shortCode: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SHORT_CODE_PATTERN, '3 to 12 lower-case letters or digits.'),
  timezone: z.string().min(1, 'Pick a time zone.'),
  feeDueDay: z
    .string()
    .trim()
    .regex(/^\d{1,2}$/, FEE_DUE_DAY_MESSAGE)
    .refine(
      (v) => Number(v) >= MIN_FEE_DUE_DAY && Number(v) <= MAX_FEE_DUE_DAY,
      FEE_DUE_DAY_MESSAGE,
    ),
});
type CreateValues = z.infer<typeof schema>;

export function CreateSchoolForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const timezoneOptions = useTimezoneOptions();
  // Set when the short code is taken by a school we can show: after a timed-out first attempt
  // that school is most likely the one this form already created (contract §4.2).
  const [existing, setExisting] = useState<SchoolDto | null>(null);

  const form = useForm<CreateValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      shortCode: '',
      timezone: DEFAULT_TIMEZONE,
      feeDueDay: String(DEFAULT_FEE_DUE_DAY),
    },
  });

  const create = useMutation({
    mutationFn: (body: CreateSchoolBody) =>
      unwrap(platform.POST('/api/v1/platform/schools', { body })),
    onSuccess: (school) => {
      queryClient.setQueryData(platformKeys.school(school.id), school);
      void queryClient.invalidateQueries({ queryKey: platformKeys.schools });
      toast.success(`${school.name} created.`);
      router.push(`/platform/schools/${school.id}`);
    },
    onError: async (error, body) => {
      if (error instanceof ApiError && error.code === ErrorCode.SCHOOL_SHORT_CODE_TAKEN) {
        form.setError('shortCode', { message: error.message }, { shouldFocus: true });
        setExisting(await findByShortCode(body.shortCode));
        return;
      }
      applyApiError(form, error);
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setExisting(null);
    create.mutate({
      name: values.name,
      shortCode: values.shortCode,
      timezone: values.timezone,
      feeDueDay: Number(values.feeDueDay),
    });
  });

  return (
    <>
      <PageHeader title="New school" description="The school starts on trial." />
      <Card className="max-w-xl">
        <CardContent>
          <form noValidate onSubmit={onSubmit} className="grid gap-4">
            <FormRootError form={form} />
            <FormField control={form.control} name="name" label="School name" maxLength={200} autoFocus />
            <FormField
              control={form.control}
              name="shortCode"
              label="Short code"
              hint="3–12 lower-case letters or digits. It cannot be changed later."
              autoComplete="off"
              maxLength={12}
            />
            {existing && (
              <p className="-mt-2 text-sm">
                <Link
                  href={`/platform/schools/${existing.id}`}
                  className="font-medium underline underline-offset-4"
                >
                  Open {existing.name}
                </Link>{' '}
                <span className="text-muted-foreground">— the school using this code.</span>
              </p>
            )}
            <FormField
              control={form.control}
              name="timezone"
              label="Time zone"
              options={timezoneOptions}
            />
            <FormField
              control={form.control}
              name="feeDueDay"
              label="Fee due day"
              hint={`Day of the month, ${MIN_FEE_DUE_DAY}–${MAX_FEE_DUE_DAY}. The principal can change it later.`}
              type="number"
              inputMode="numeric"
            />
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create school'}
              </Button>
              <Link href="/platform/schools" className={buttonVariants({ variant: 'outline' })}>
                Cancel
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

/** The school holding this short code, or null if it cannot be found. */
async function findByShortCode(shortCode: string): Promise<SchoolDto | null> {
  try {
    const { data } = await unwrap(
      platform.GET('/api/v1/platform/schools', { params: { query: { q: shortCode, limit: 5 } } }),
    );
    return data.find((school) => school.shortCode === shortCode) ?? null;
  } catch {
    return null;
  }
}
