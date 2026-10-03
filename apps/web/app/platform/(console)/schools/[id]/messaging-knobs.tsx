'use client';

import {
  ErrorCode,
  SMS_PROVIDER_CHOICES,
  WHATSAPP_PROVIDER_CHOICES,
  type SmsProviderChoice,
  type WhatsAppProviderChoice,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  platformMessagingApi,
  type SchoolDto,
  type UpdateSchoolBody,
} from '@/lib/api/platform-messaging-contract';
import { platformKeys } from '@/lib/platform-session';
import { SMS_PROVIDER_LABELS, WHATSAPP_PROVIDER_LABELS } from '../../messaging-ui';

// contracts/slice-9.md §6.1: the school's SMS cap and its WhatsApp and SMS providers. A provider
// change never touches the school's live WhatsApp number; it decides which onboarding route the
// school's Messaging screen offers.

const schema = z.object({
  smsMonthlyCap: z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) <= 100_000, 'Enter a whole number from 0 to 100,000.'),
  whatsappProvider: z.enum(WHATSAPP_PROVIDER_CHOICES),
  smsProvider: z.enum(SMS_PROVIDER_CHOICES),
});
type Values = z.infer<typeof schema>;

export function MessagingKnobsForm({ school }: { school: SchoolDto }) {
  const queryClient = useQueryClient();
  const terminated = school.status === 'terminated';
  // The current defaults, to say what "platform default" means today.
  const settings = useQuery({
    queryKey: platformKeys.settings,
    queryFn: () => unwrap(platformMessagingApi.GET('/api/v1/platform/settings')),
  });
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      smsMonthlyCap: String(school.smsMonthlyCap),
      whatsappProvider: school.whatsappProvider,
      smsProvider: school.smsProvider,
    },
    disabled: terminated,
  });

  const save = useMutation({
    mutationFn: (body: UpdateSchoolBody) =>
      unwrap(platformMessagingApi.PATCH('/api/v1/platform/schools/{id}', { params: { path: { id: school.id } }, body })),
    onSuccess: (updated) => {
      queryClient.setQueryData(platformKeys.school(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: platformKeys.deliveryHealth });
      toast.success('Messaging settings saved.');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.SCHOOL_TERMINATED) {
        void queryClient.invalidateQueries({ queryKey: platformKeys.school(school.id) });
      }
      applyApiError(form, error);
    },
  });

  // Only what changed is sent.
  const onSubmit = form.handleSubmit((v) => {
    const cap = Number(v.smsMonthlyCap);
    const body: UpdateSchoolBody = {
      ...(cap !== school.smsMonthlyCap && { smsMonthlyCap: cap }),
      ...(v.whatsappProvider !== school.whatsappProvider && { whatsappProvider: v.whatsappProvider }),
      ...(v.smsProvider !== school.smsProvider && { smsProvider: v.smsProvider }),
    };
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  const defaults = settings.data;
  const whatsappOptions = WHATSAPP_PROVIDER_CHOICES.map((value: WhatsAppProviderChoice) => ({
    value,
    label:
      value === 'platform_default'
        ? `Platform default${defaults ? ` (now ${WHATSAPP_PROVIDER_LABELS[defaults.defaultWhatsappProvider]})` : ''}`
        : WHATSAPP_PROVIDER_LABELS[value],
    // A provider switched off on this deployment cannot be chosen (the API refuses it, 422).
    disabled:
      value !== 'platform_default' &&
      defaults !== undefined &&
      !defaults.enabledWhatsappProviders.includes(value),
  }));
  const smsOptions = SMS_PROVIDER_CHOICES.map((value: SmsProviderChoice) => ({
    value,
    label:
      value === 'platform_default'
        ? `Platform default${defaults ? ` (now ${SMS_PROVIDER_LABELS[defaults.defaultSmsProvider]})` : ''}`
        : SMS_PROVIDER_LABELS[value],
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Messaging</CardTitle>
        <CardDescription>
          The school sees its SMS limit but cannot change it. A new limit applies to the next SMS; one below this
          month’s use holds back further SMS until next month.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="smsMonthlyCap"
            label="Monthly SMS limit"
            hint="SMS parts per calendar month, 0 to 100,000."
            inputMode="numeric"
            maxLength={6}
          />
          <FormField
            control={form.control}
            name="whatsappProvider"
            label="WhatsApp provider"
            hint="Decides how the school connects a new number. A number already connected keeps working as it is."
            options={whatsappOptions}
          />
          <FormField control={form.control} name="smsProvider" label="SMS provider" options={smsOptions} />
          {!terminated && (
            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>
                {save.isPending ? 'Saving…' : 'Save messaging'}
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
          )}
        </form>
      </CardContent>
    </Card>
  );
}
