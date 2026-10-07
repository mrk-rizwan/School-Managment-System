'use client';

import { LATE_COUNTS_AS, LEAVE_COUNTS_AS, MAX_RUPEES, REMARK_VISIBILITIES, type LateCountsAs } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useId } from 'react';
import { Controller, useForm, useWatch, type Control } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { CheckboxField } from '@/components/checkbox-field';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { QueryStates } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { unwrap } from '@/lib/api/client';
import {
  messagingApi,
  type SchoolSettingsDto,
  type UpdateSchoolSettingsBody,
} from '@/lib/api/school-messaging-contract';
import { formatDate } from '@/lib/format';
import { schoolKeys } from '@/lib/school-session';
import {
  LATE_COUNTS_AS_LABELS,
  LEAVE_COUNTS_AS_LABELS,
  REMARK_VISIBILITY_LABELS,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  isTime,
} from './_lib/settings-ui';
import { BillingStatusCard } from './billing-status';
import { PaymentAccountsCard } from './payment-accounts';

// contracts/slice-2.md §6 (fee due day 1–28, student sign-in) and contracts/slice-9.md §4 (the
// plan §4.5 attendance and remark fields). One resource, one Save: only what changed is sent.
// The SMS allow list and the SMS cap are on the Messaging screen. Phase 3 (slice 18, plan §3.8)
// adds the fee, late-fee, reminder, expense and payroll settings and the payment accounts.

const DUE_DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => {
  const day = i + 1;
  return { value: String(day), label: `${day}${ordinalSuffix(day)} of the month` };
});

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
}

const PERIOD_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: i === 0 ? '1 period' : `${i + 1} periods`,
}));

const integerIn = (min: number, max: number, message: string) =>
  z.string().refine((v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max, message);
const time = z.string().refine(isTime, 'Enter a time such as 09:30.');
const RUPEES_MAX = MAX_RUPEES.toLocaleString('en-US');

const schema = z
  .object({
    feeDueDay: integerIn(1, 28, 'Pick a day from 1 to 28.'),
    feeCutoffDay: integerIn(1, 28, 'Pick a day from 1 to 28.'),
    feeReminderDaysBefore: integerIn(0, 10, 'Enter a number of days from 0 to 10.'),
    overdueReminderEveryDays: integerIn(7, 30, 'Enter a number of days from 7 to 30.'),
    lateFeeEnabled: z.boolean(),
    lateFeeAmount: z.string().trim(),
    lateFeeGraceDays: integerIn(0, 30, 'Enter a number of days from 0 to 30.'),
    expenseApprovalThreshold: integerIn(0, MAX_RUPEES, `Enter whole rupees, from 0 to ${RUPEES_MAX}.`),
    payDay: integerIn(1, 28, 'Pick a day from 1 to 28.'),
    studentLoginEnabled: z.boolean(),
    periodsPerDay: integerIn(1, 12, 'Pick from 1 to 12 periods.'),
    weeklyOffDays: z.array(z.number()).max(6, 'At least one day of the week must be a school day.'),
    attendanceAmendWindowDays: integerIn(0, 30, 'Enter a number of days from 0 to 30.'),
    registerDeadlineTime: time,
    absenceAlertTime: time,
    lateAdviceEnabled: z.boolean(),
    lateCountsAs: z.enum(LATE_COUNTS_AS),
    lateCutoffTime: z.string(),
    leaveCountsAs: z.enum(LEAVE_COUNTS_AS),
    remarkDefaultVisibility: z.enum(REMARK_VISIBILITIES),
    remarkNotifyGuardians: z.boolean(),
    // Phase 4 slice 34: blank clears the signatory (the next certificate defaults it again).
    certificateSignatoryName: z
      .string()
      .trim()
      .max(100, 'Use at most 100 characters.')
      .regex(/^\P{Cc}*$/u, 'Remove line breaks and control characters.'),
    certificateShowIdentityNo: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.lateCountsAs === 'absent_after_cutoff' && !isTime(v.lateCutoffTime)) {
      ctx.addIssue({ code: 'custom', path: ['lateCutoffTime'], message: 'Enter the cut-off time, such as 08:15.' });
    }
    // Required while late fees are on (the API's CHECK); left as it is while they are off.
    const amount = v.lateFeeAmount;
    if (v.lateFeeEnabled && !(/^\d+$/.test(amount) && Number(amount) >= 1 && Number(amount) <= MAX_RUPEES)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lateFeeAmount'],
        message: `Enter the late fee in whole rupees, from 1 to ${RUPEES_MAX}.`,
      });
    }
  });
type SettingsValues = z.infer<typeof schema>;

export function SchoolSettings() {
  const settings = useQuery({
    queryKey: schoolKeys.settings,
    queryFn: () => unwrap(messagingApi.GET('/api/v1/school/settings')),
  });

  return (
    <>
      <PageHeader
        title="School settings"
        description="Settings that apply to the whole school."
        actions={
          <Link href="/settings/messaging" className="text-sm underline-offset-4 hover:underline">
            Messaging settings
          </Link>
        }
      />
      <div className="grid max-w-3xl gap-6">
        <QueryStates query={settings} loadingRows={6}>
          {/* Keyed by the last update so the form restarts from the saved values. */}
          {(data) => <SettingsForm key={data.updatedAt} settings={data} />}
        </QueryStates>
        {/* Its own resource and its own actions, outside the settings form's Save. */}
        <PaymentAccountsCard />
        {/* Slice 26 (A18): the school's own ASMS subscription and invoice. */}
        <BillingStatusCard />
      </div>
    </>
  );
}

function valuesOf(settings: SchoolSettingsDto): SettingsValues {
  return {
    feeDueDay: String(settings.feeDueDay),
    feeCutoffDay: String(settings.feeCutoffDay),
    feeReminderDaysBefore: String(settings.feeReminderDaysBefore),
    overdueReminderEveryDays: String(settings.overdueReminderEveryDays),
    lateFeeEnabled: settings.lateFeeEnabled,
    lateFeeAmount: settings.lateFeeAmount === null ? '' : String(settings.lateFeeAmount),
    lateFeeGraceDays: String(settings.lateFeeGraceDays),
    expenseApprovalThreshold: String(settings.expenseApprovalThreshold),
    payDay: String(settings.payDay),
    studentLoginEnabled: settings.studentLoginEnabled,
    periodsPerDay: String(settings.periodsPerDay),
    weeklyOffDays: [...settings.weeklyOffDays],
    attendanceAmendWindowDays: String(settings.attendanceAmendWindowDays),
    registerDeadlineTime: settings.registerDeadlineTime,
    absenceAlertTime: settings.absenceAlertTime,
    lateAdviceEnabled: settings.lateAdviceEnabled,
    lateCountsAs: settings.lateCountsAs,
    lateCutoffTime: settings.lateCutoffTime ?? '',
    leaveCountsAs: settings.leaveCountsAs,
    remarkDefaultVisibility: settings.remarkDefaultVisibility,
    remarkNotifyGuardians: settings.remarkNotifyGuardians,
    certificateSignatoryName: settings.certificateSignatoryName ?? '',
    certificateShowIdentityNo: settings.certificateShowIdentityNo,
  };
}

/** The PATCH body: only fields whose value differs from the saved settings. */
function changesOf(v: SettingsValues, saved: SchoolSettingsDto): UpdateSchoolSettingsBody {
  const offDays = [...v.weeklyOffDays].sort((a, b) => a - b);
  const cutoff = v.lateCountsAs === 'absent_after_cutoff' ? v.lateCutoffTime : saved.lateCutoffTime;
  // The amount is sent only while late fees are on; switching them off leaves it stored.
  const lateFeeAmount = v.lateFeeEnabled ? Number(v.lateFeeAmount) : saved.lateFeeAmount;
  const body: UpdateSchoolSettingsBody = {
    ...(Number(v.feeDueDay) !== saved.feeDueDay && { feeDueDay: Number(v.feeDueDay) }),
    ...(Number(v.feeCutoffDay) !== saved.feeCutoffDay && { feeCutoffDay: Number(v.feeCutoffDay) }),
    ...(Number(v.feeReminderDaysBefore) !== saved.feeReminderDaysBefore && {
      feeReminderDaysBefore: Number(v.feeReminderDaysBefore),
    }),
    ...(Number(v.overdueReminderEveryDays) !== saved.overdueReminderEveryDays && {
      overdueReminderEveryDays: Number(v.overdueReminderEveryDays),
    }),
    ...(v.lateFeeEnabled !== saved.lateFeeEnabled && { lateFeeEnabled: v.lateFeeEnabled }),
    ...(lateFeeAmount !== saved.lateFeeAmount && { lateFeeAmount }),
    ...(Number(v.lateFeeGraceDays) !== saved.lateFeeGraceDays && { lateFeeGraceDays: Number(v.lateFeeGraceDays) }),
    ...(Number(v.expenseApprovalThreshold) !== saved.expenseApprovalThreshold && {
      expenseApprovalThreshold: Number(v.expenseApprovalThreshold),
    }),
    ...(Number(v.payDay) !== saved.payDay && { payDay: Number(v.payDay) }),
    ...(v.studentLoginEnabled !== saved.studentLoginEnabled && { studentLoginEnabled: v.studentLoginEnabled }),
    ...(Number(v.periodsPerDay) !== saved.periodsPerDay && { periodsPerDay: Number(v.periodsPerDay) }),
    ...(offDays.join() !== saved.weeklyOffDays.join() && { weeklyOffDays: offDays }),
    ...(Number(v.attendanceAmendWindowDays) !== saved.attendanceAmendWindowDays && {
      attendanceAmendWindowDays: Number(v.attendanceAmendWindowDays),
    }),
    ...(v.registerDeadlineTime !== saved.registerDeadlineTime && { registerDeadlineTime: v.registerDeadlineTime }),
    ...(v.absenceAlertTime !== saved.absenceAlertTime && { absenceAlertTime: v.absenceAlertTime }),
    ...(v.lateAdviceEnabled !== saved.lateAdviceEnabled && { lateAdviceEnabled: v.lateAdviceEnabled }),
    ...(v.lateCountsAs !== saved.lateCountsAs && { lateCountsAs: v.lateCountsAs }),
    ...(cutoff !== saved.lateCutoffTime && { lateCutoffTime: cutoff }),
    ...(v.leaveCountsAs !== saved.leaveCountsAs && { leaveCountsAs: v.leaveCountsAs }),
    ...(v.remarkDefaultVisibility !== saved.remarkDefaultVisibility && {
      remarkDefaultVisibility: v.remarkDefaultVisibility,
    }),
    ...(v.remarkNotifyGuardians !== saved.remarkNotifyGuardians && { remarkNotifyGuardians: v.remarkNotifyGuardians }),
    ...((v.certificateSignatoryName || null) !== saved.certificateSignatoryName && {
      certificateSignatoryName: v.certificateSignatoryName || null,
    }),
    ...(v.certificateShowIdentityNo !== saved.certificateShowIdentityNo && {
      certificateShowIdentityNo: v.certificateShowIdentityNo,
    }),
  };
  return body;
}

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => ({ value, label: labels[value] }));

function SettingsForm({ settings }: { settings: SchoolSettingsDto }) {
  const queryClient = useQueryClient();
  const form = useForm<SettingsValues>({
    resolver: zodResolver(schema),
    defaultValues: valuesOf(settings),
  });
  const lateCountsAs = useWatch({ control: form.control, name: 'lateCountsAs' }) as LateCountsAs;
  const lateFeeEnabled = useWatch({ control: form.control, name: 'lateFeeEnabled' });

  const save = useMutation({
    mutationFn: (body: UpdateSchoolSettingsBody) =>
      unwrap(messagingApi.PATCH('/api/v1/school/settings', { body })),
    onSuccess: (updated) => {
      queryClient.setQueryData(schoolKeys.settings, updated);
      toast.success('Settings saved.');
    },
    // 422s land on their fields; anything else on the form.
    onError: (error) => applyApiError(form, error),
  });

  // An unchanged form sends nothing.
  const onSubmit = form.handleSubmit((values) => {
    const body = changesOf(values, settings);
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="grid gap-6">
      <FormRootError form={form} />
      <Card>
        <CardHeader>
          <CardTitle>Fees</CardTitle>
          <CardDescription>Amounts are in whole rupees; the days apply to every month.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="feeDueDay"
              label="Fee due day"
              hint="Monthly fees fall due on this day."
              options={DUE_DAY_OPTIONS}
            />
            <FormField
              control={form.control}
              name="feeCutoffDay"
              label="Joining cut-off day"
              hint="A student who joins after this day starts paying monthly fees the next month."
              options={DUE_DAY_OPTIONS}
            />
            <FormField
              control={form.control}
              name="feeReminderDaysBefore"
              label="Reminder before the due day"
              hint="Days, 0 to 10. Guardians are reminded this many days before fees fall due."
              inputMode="numeric"
              maxLength={2}
            />
            <FormField
              control={form.control}
              name="overdueReminderEveryDays"
              label="Overdue reminder every"
              hint="Days, 7 to 30, for as long as a fee stays unpaid."
              inputMode="numeric"
              maxLength={2}
            />
          </div>
          <Separator />
          <CheckboxField
            control={form.control}
            name="lateFeeEnabled"
            label="Charge a late fee"
            hint="One late fee per student per month, under the fine head. Only the principal can waive it."
          />
          {settings.lateFeeEnabled && settings.lateFeeEnabledAt && (
            <p className="text-xs text-muted-foreground">
              Late fees on since {formatDate(settings.lateFeeEnabledAt)}.
            </p>
          )}
          {lateFeeEnabled && (
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="lateFeeAmount"
                label="Late fee amount (Rs)"
                hint="Whole rupees."
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
              />
              <FormField
                control={form.control}
                name="lateFeeGraceDays"
                label="Grace days after the due day"
                hint="Days, 0 to 30, before the late fee is charged."
                inputMode="numeric"
                maxLength={2}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sign-in</CardTitle>
          <CardDescription>Staff and guardians always sign in with their CNIC.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <CheckboxField
            control={form.control}
            name="studentLoginEnabled"
            label="Students can sign in"
            hint="Students sign in with their B-Form number. A student with no number recorded has no sign-in."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>School week and attendance</CardTitle>
          <CardDescription>
            Changing the week or the periods never rewrites a register already recorded.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <WeeklyOffDaysField control={form.control} />
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="periodsPerDay"
              label="Periods per day"
              hint="For classes that record attendance per period."
              options={PERIOD_OPTIONS}
            />
            <FormField
              control={form.control}
              name="attendanceAmendWindowDays"
              label="Amendment window (registers and diary)"
              hint="Days, 0 to 30. After this a teacher can no longer change their register or diary entry; the principal can, with a reason."
              inputMode="numeric"
              maxLength={2}
            />
            <FormField
              control={form.control}
              name="registerDeadlineTime"
              label="Register deadline"
              hint="Unrecorded registers are flagged after this time."
              type="time"
            />
            <FormField
              control={form.control}
              name="absenceAlertTime"
              label="Absence alert time"
              hint="Guardians of absent children are told at this time."
              type="time"
            />
          </div>
          <Separator />
          <CheckboxField
            control={form.control}
            name="lateAdviceEnabled"
            label="Tell guardians when a child arrives late"
            hint="Sent by WhatsApp, or by SMS if your allow list includes late advice."
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="lateCountsAs"
              label="A late arrival counts as"
              options={options(LATE_COUNTS_AS, LATE_COUNTS_AS_LABELS)}
            />
            {lateCountsAs === 'absent_after_cutoff' && (
              <FormField
                control={form.control}
                name="lateCutoffTime"
                label="Cut-off time"
                hint="Arriving after this counts as absent."
                type="time"
              />
            )}
          </div>
          <FormField
            control={form.control}
            name="leaveCountsAs"
            label="Approved leave counts as"
            options={options(LEAVE_COUNTS_AS, LEAVE_COUNTS_AS_LABELS)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Teacher remarks</CardTitle>
          <CardDescription>The defaults a teacher starts from; each remark can still be changed.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <FormField
            control={form.control}
            name="remarkDefaultVisibility"
            label="Who sees a new remark"
            options={options(REMARK_VISIBILITIES, REMARK_VISIBILITY_LABELS)}
          />
          <CheckboxField
            control={form.control}
            name="remarkNotifyGuardians"
            label="Notify guardians of new remarks"
            hint="Off: guardians see remarks when they open the app."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expenses and payroll</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="expenseApprovalThreshold"
            label="Expense approval above (Rs)"
            hint="An expense larger than this waits for approval. Whole rupees; 0 means every expense."
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
          />
          <FormField
            control={form.control}
            name="payDay"
            label="Pay day"
            hint="The previous month’s payroll is prepared on this day."
            options={DUE_DAY_OPTIONS}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Certificates</CardTitle>
          <CardDescription>How leaving, character and other certificates are signed and printed.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <FormField
            control={form.control}
            name="certificateSignatoryName"
            label="Signed by"
            hint="The name printed above the signature line. Blank: the principal’s name is used when the next certificate is issued."
            maxLength={100}
          />
          <CheckboxField
            control={form.control}
            name="certificateShowIdentityNo"
            label="Print the B-Form number on leaving certificates"
            hint="Only on the printed leaving certificate; every print is recorded."
          />
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={save.isPending || !form.formState.isDirty}
          onClick={() => form.reset()}
        >
          Discard
        </Button>
      </div>
    </form>
  );
}

/** Weekly off days as one checkbox per weekday (0 = Sunday … 6 = Saturday, contract §4). */
function WeeklyOffDaysField({ control }: { control: Control<SettingsValues> }) {
  const id = useId();
  return (
    <Controller
      control={control}
      name="weeklyOffDays"
      render={({ field, fieldState }) => (
        <fieldset className="grid gap-2" aria-describedby={`${id}-hint`}>
          <legend className="mb-1.5 text-sm font-medium">Weekly days off</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {WEEKDAY_ORDER.map((day) => (
              <label key={day} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={field.value.includes(day)}
                  onChange={(event) =>
                    field.onChange(
                      event.target.checked ? [...field.value, day] : field.value.filter((d) => d !== day),
                    )
                  }
                  onBlur={field.onBlur}
                />
                {WEEKDAY_LABELS[day]}
              </label>
            ))}
          </div>
          <p
            id={`${id}-hint`}
            className={fieldState.error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
          >
            {fieldState.error?.message ??
              'No register is expected on these days, and they are left out of teaching days.'}
          </p>
        </fieldset>
      )}
    />
  );
}
