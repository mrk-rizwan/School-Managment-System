'use client';

import { SMS_PROVIDERS, WHATSAPP_PROVIDERS } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { QueryStates } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import {
  platformMessagingApi,
  type PlatformSettingsDto,
  type UpdatePlatformSettingsBody,
} from '@/lib/api/platform-messaging-contract';
import { formatDateTime } from '@/lib/format';
import { platformKeys } from '@/lib/platform-session';
import { SMS_PROVIDER_LABELS, WHATSAPP_PROVIDER_LABELS } from '../messaging-ui';

// contracts/slice-9.md §6.2: the defaults every school on "platform default" uses. A change takes
// effect for all of them at once: the next WhatsApp onboarding and the next SMS.

const schema = z.object({
  defaultWhatsappProvider: z.enum(WHATSAPP_PROVIDERS),
  defaultSmsProvider: z.enum(SMS_PROVIDERS),
});
type Values = z.infer<typeof schema>;

export function PlatformSettings() {
  const settings = useQuery({
    queryKey: platformKeys.settings,
    queryFn: () => unwrap(platformMessagingApi.GET('/api/v1/platform/settings')),
  });
  return (
    <>
      <PageHeader title="Platform settings" description="Defaults for every school." />
      <div className="max-w-2xl">
        <QueryStates query={settings} loadingRows={3}>
          {(data) => <SettingsForm key={data.updatedAt} settings={data} />}
        </QueryStates>
      </div>
    </>
  );
}

function SettingsForm({ settings }: { settings: PlatformSettingsDto }) {
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      defaultWhatsappProvider: settings.defaultWhatsappProvider,
      defaultSmsProvider: settings.defaultSmsProvider,
    },
  });
  const save = useMutation({
    mutationFn: (body: UpdatePlatformSettingsBody) =>
      unwrap(platformMessagingApi.PATCH('/api/v1/platform/settings', { body })),
    onSuccess: (updated) => {
      queryClient.setQueryData(platformKeys.settings, updated);
      toast.success('Platform settings saved.');
    },
    onError: (error) => applyApiError(form, error),
  });
  const onSubmit = form.handleSubmit((v) => {
    const body: UpdatePlatformSettingsBody = {
      ...(v.defaultWhatsappProvider !== settings.defaultWhatsappProvider && {
        defaultWhatsappProvider: v.defaultWhatsappProvider,
      }),
      ...(v.defaultSmsProvider !== settings.defaultSmsProvider && { defaultSmsProvider: v.defaultSmsProvider }),
    };
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Messaging providers</CardTitle>
        <CardDescription>
          Applies to every school on platform default, at once. A school’s WhatsApp number that is already connected
          keeps working through its own provider. Last changed {formatDateTime(settings.updatedAt)}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField
            control={form.control}
            name="defaultWhatsappProvider"
            label="Default WhatsApp provider"
            hint="How schools on the default connect a new WhatsApp number."
            options={WHATSAPP_PROVIDERS.map((value) => ({
              value,
              label: settings.enabledWhatsappProviders.includes(value)
                ? WHATSAPP_PROVIDER_LABELS[value]
                : `${WHATSAPP_PROVIDER_LABELS[value]} (switched off on this server)`,
              disabled: !settings.enabledWhatsappProviders.includes(value),
            }))}
          />
          <FormField
            control={form.control}
            name="defaultSmsProvider"
            label="Default SMS provider"
            hint="Used for the next SMS of every school on the default."
            options={SMS_PROVIDERS.map((value) => ({ value, label: SMS_PROVIDER_LABELS[value] }))}
          />
          <div className="flex gap-2 pt-2">
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
      </CardContent>
    </Card>
  );
}
