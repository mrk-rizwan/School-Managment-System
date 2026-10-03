'use client';

import {
  ErrorCode,
  normalisePhone,
  type WhatsAppErrorCode,
  type WhatsAppProvider,
  type WhatsAppStatus,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { FormField, FormRootError, PhoneField, applyApiError } from '@/components/form-field';
import { QueryStates } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import {
  messagingApi,
  type ConnectCloudApiBody,
  type WhatsAppNumberDto,
  type WhatsAppPairingDto,
  type WhatsAppSettingsDto,
  type WhatsAppVerificationFailure,
} from '@/lib/api/school-messaging-contract';
import { formatDateTime } from '@/lib/format';
import { messagingKeys } from './messaging-keys';

// contracts/slice-9.md §5.3–§5.6 and §14: the school's WhatsApp number. The onboarding route is
// decided by `effectiveProvider`: QR pairing for WAHA, the Meta details form for the Cloud API.

export const WHATSAPP_PROVIDER_LABELS: Record<WhatsAppProvider, string> = {
  waha: 'WhatsApp Web (QR pairing)',
  cloud_api: 'WhatsApp Business Cloud API',
};

const STATUS_LABELS: Record<WhatsAppStatus, string> = {
  pending: 'Waiting to connect',
  connected: 'Connected',
  down: 'Not working',
  disabled: 'Disabled',
};
const STATUS_VARIANT = {
  pending: 'outline',
  connected: 'secondary',
  down: 'destructive',
  disabled: 'outline',
} as const satisfies Record<WhatsAppStatus, string>;

export const WHATSAPP_ERROR_LABELS: Record<WhatsAppErrorCode, string> = {
  unreachable: 'The WhatsApp service could not be reached.',
  logged_out: 'The phone was logged out of WhatsApp.',
  session_failed: 'The WhatsApp session failed.',
  token_rejected: 'Meta refused the access token.',
  number_mismatch: 'The number does not match the Meta account.',
  unknown: 'An unknown problem.',
};

const VERIFICATION_MESSAGES: Record<WhatsAppVerificationFailure['reason'], string> = {
  token_rejected: 'Meta refused the access token. Check that it is a permanent token for this WhatsApp Business account.',
  not_found: 'Meta has no phone number with this phone-number ID.',
  number_mismatch: 'The phone-number ID belongs to a different phone number.',
  number_in_use: 'This phone-number ID is already connected to another school.',
};

/** One sentence for a refusal on the WhatsApp routes; anything else is `describeApiError`. */
function whatsappErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.fieldErrors.length === 0) {
    switch (error.code) {
      case ErrorCode.WHATSAPP_PROVIDER_MISMATCH:
        return 'The connection method changed. The screen has been refreshed; follow the steps shown.';
      case ErrorCode.WHATSAPP_ALREADY_CONNECTED:
        return 'WhatsApp is already connected.';
      case ErrorCode.WHATSAPP_NUMBER_MISSING:
        return 'Enter the school’s WhatsApp number first.';
      case ErrorCode.WHATSAPP_VERIFICATION_FAILED: {
        const reason = (error.details as Partial<WhatsAppVerificationFailure> | null)?.reason;
        return (reason && VERIFICATION_MESSAGES[reason]) ?? error.message;
      }
      case ErrorCode.SERVICE_UNAVAILABLE:
        return 'The WhatsApp service could not be reached. Try again in a minute.';
    }
  }
  return describeApiError(error);
}

/** The refusals after which the screen re-reads the number: someone else, or the platform, moved it. */
const REFRESH_ON = new Set<string>([ErrorCode.WHATSAPP_PROVIDER_MISMATCH, ErrorCode.WHATSAPP_ALREADY_CONNECTED]);

export function WhatsAppCard() {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState(false);
  const whatsapp = useQuery({
    queryKey: messagingKeys.whatsapp,
    queryFn: () => unwrap(messagingApi.GET('/api/v1/messaging/whatsapp')),
    // §5.4: poll every 5 s while a QR is on screen, until the health job marks it connected;
    // then the pairing panel unmounts, which ends the polling.
    refetchInterval: pairing ? 5_000 : false,
  });

  const onRefusal = (error: unknown) => {
    if (error instanceof ApiError && REFRESH_ON.has(error.code)) {
      void queryClient.invalidateQueries({ queryKey: messagingKeys.whatsapp });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>WhatsApp</CardTitle>
        <CardDescription>
          Messages to guardians go by WhatsApp first. Without a working number they fall back to SMS
          where your allow list permits.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryStates query={whatsapp} loadingRows={3}>
          {(data) => (
            <div className="grid gap-5">
              {data.number && <NumberSummary number={data.number} />}
              <ProviderMismatch settings={data} />
              <Onboarding
                settings={data}
                pairing={pairing}
                onPairingChange={setPairing}
                onRefusal={onRefusal}
              />
              {data.number && <DisableNumber number={data.number} />}
            </div>
          )}
        </QueryStates>
      </CardContent>
    </Card>
  );
}

function NumberSummary({ number }: { number: WhatsAppNumberDto }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-testid="whatsapp-number">
      <Detail label="Status">
        <Badge variant={STATUS_VARIANT[number.status]}>{STATUS_LABELS[number.status]}</Badge>
      </Detail>
      <Detail label="Number">
        <span className="font-mono">{number.phoneMasked}</span>
      </Detail>
      <Detail label="Connected through">{WHATSAPP_PROVIDER_LABELS[number.provider]}</Detail>
      <Detail label="Last working">{number.lastHealthyAt ? formatDateTime(number.lastHealthyAt) : 'Not yet'}</Detail>
      {number.lastErrorCode && number.status !== 'connected' && (
        <Detail label="Last problem">{WHATSAPP_ERROR_LABELS[number.lastErrorCode]}</Detail>
      )}
      {number.inboundIgnoredCount > 0 && (
        <Detail label="Replies not read">
          {number.inboundIgnoredCount} message{number.inboundIgnoredCount === 1 ? '' : 's'} sent to this number were
          not read by the system
        </Detail>
      )}
    </dl>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** §6.1: a provider change never touches the live number; the screen says so. */
function ProviderMismatch({ settings }: { settings: WhatsAppSettingsDto }) {
  const number = settings.number;
  if (!number || number.provider === settings.effectiveProvider) return null;
  return (
    <Alert data-testid="provider-mismatch">
      <AlertTitle>The connection method has changed</AlertTitle>
      <AlertDescription>
        This number is connected through {WHATSAPP_PROVIDER_LABELS[number.provider]}; new connections now use{' '}
        {WHATSAPP_PROVIDER_LABELS[settings.effectiveProvider]}. Messages keep going through the current number. To
        switch, disable it and connect again.
      </AlertDescription>
    </Alert>
  );
}

function Onboarding({
  settings,
  pairing,
  onPairingChange,
  onRefusal,
}: {
  settings: WhatsAppSettingsDto;
  pairing: boolean;
  onPairingChange: (pairing: boolean) => void;
  onRefusal: (error: unknown) => void;
}) {
  const { number, effectiveProvider } = settings;
  if (number?.status === 'connected') return null;
  // A live row of the other provider must be disabled first (§5.4, §5.5).
  if (number && number.provider !== effectiveProvider) return null;
  if (effectiveProvider === 'waha') {
    return (
      <QrPairing number={number} pairing={pairing} onPairingChange={onPairingChange} onRefusal={onRefusal} />
    );
  }
  return <CloudApiForm number={number} onRefusal={onRefusal} />;
}

// ---- WAHA: QR pairing (§5.4) ----

const secondsUntil = (iso: string) => Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));

/** A QR lives 45 s; the screen asks for a fresh one this many times before waiting for a click. */
const AUTO_REFRESHES = 3;

function QrPairing({
  number,
  pairing,
  onPairingChange,
  onRefusal,
}: {
  number: WhatsAppNumberDto | null;
  pairing: boolean;
  onPairingChange: (pairing: boolean) => void;
  onRefusal: (error: unknown) => void;
}) {
  const phoneId = useId();
  const [phone, setPhone] = useState('');
  // The QR is kept only in this component's state: never cached, stored or logged (§5.4).
  const [qr, setQr] = useState<WhatsAppPairingDto | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const firstPairing = number === null;
  const normalised = phone.trim() ? normalisePhone(phone) : null;
  const shownQr = pairing ? qr : null;

  const pair = useMutation({
    mutationFn: () =>
      unwrap(
        messagingApi.POST('/api/v1/messaging/whatsapp/pair', {
          body: firstPairing ? { phone: phone.trim() } : {},
        }),
      ),
    // Nothing of the answer stays in the mutation cache.
    gcTime: 0,
    onSuccess: (result) => {
      setQr(result);
      setSecondsLeft(secondsUntil(result.expiresAt));
      onPairingChange(true);
    },
    onError: (error) => {
      setQr(null);
      onPairingChange(false);
      onRefusal(error);
    },
  });
  const { mutate: requestQr } = pair;

  // The countdown, and a fresh code when it runs out (a few times, then on request).
  useEffect(() => {
    if (!shownQr) return;
    const timer = setInterval(() => {
      const left = secondsUntil(shownQr.expiresAt);
      setSecondsLeft(left);
      if (left > 0) return;
      setQr(null);
      if (refreshes < AUTO_REFRESHES) {
        setRefreshes((n) => n + 1);
        requestQr();
      } else onPairingChange(false);
    }, 1000);
    return () => clearInterval(timer);
  }, [shownQr, refreshes, requestQr, onPairingChange]);

  // Leaving the screen, or connecting (which unmounts this panel), stops the polling.
  useEffect(() => () => onPairingChange(false), [onPairingChange]);

  const start = () => {
    setRefreshes(0);
    requestQr();
  };
  const phoneInvalid = firstPairing && normalised === null;

  return (
    <div className="grid gap-4 rounded-lg border p-4" data-testid="qr-pairing">
      <div className="grid gap-1">
        <p className="text-sm font-medium">
          {firstPairing ? 'Connect the school’s WhatsApp number' : 'Connect this number again'}
        </p>
        <p className="text-sm text-muted-foreground">
          On the school’s phone open WhatsApp, go to Linked devices, choose Link a device and scan the code shown here.
        </p>
      </div>
      {firstPairing && (
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor={phoneId}>School’s WhatsApp number</Label>
          <Input
            id={phoneId}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            maxLength={20}
            value={phone}
            disabled={pair.isPending || shownQr !== null}
            onChange={(event) => setPhone(event.target.value)}
            aria-describedby={`${phoneId}-hint`}
          />
          <p id={`${phoneId}-hint`} className="text-xs text-muted-foreground">
            {normalised ? `Will be saved as ${normalised}.` : 'Pakistani numbers such as 0300 1234567.'}
          </p>
        </div>
      )}
      {shownQr ? (
        <div className="grid justify-items-start gap-2">
          {/* A data URI from the API; next/image adds nothing for an inline image. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shownQr.qr}
            alt="WhatsApp pairing code"
            width={224}
            height={224}
            className="size-56 rounded-md border bg-white p-2"
          />
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Code valid for {secondsLeft} second{secondsLeft === 1 ? '' : 's'}. Checking for the connection…
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => onPairingChange(false)}>
            Stop
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" disabled={pair.isPending || phoneInvalid} onClick={start}>
            {pair.isPending ? 'Getting a code…' : refreshes > 0 ? 'Show a new code' : 'Show pairing code'}
          </Button>
          {!pair.isPending && refreshes >= AUTO_REFRESHES && (
            <p className="text-sm text-muted-foreground">The code expired. Show a new one when the phone is ready.</p>
          )}
        </div>
      )}
      {pair.error && (
        <Alert variant="destructive">
          <AlertDescription>{whatsappErrorMessage(pair.error)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---- Cloud API: Meta details (§5.5) ----

const cloudSchema = z.object({
  phone: z
    .string()
    .trim()
    .refine((v) => normalisePhone(v) !== null, 'Enter a mobile number such as 0300 1234567.'),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^[0-9]{5,20}$/, 'The phone-number ID is 5 to 20 digits, from Meta’s WhatsApp Manager.'),
  accessToken: z
    .string()
    .trim()
    .min(20, 'The access token is at least 20 characters.')
    .max(1024, 'The access token is at most 1024 characters.')
    .regex(/^[A-Za-z0-9_.|-]+$/, 'Paste the token exactly as Meta shows it, with no spaces.'),
});
type CloudValues = z.infer<typeof cloudSchema>;

function CloudApiForm({ number, onRefusal }: { number: WhatsAppNumberDto | null; onRefusal: (error: unknown) => void }) {
  const queryClient = useQueryClient();
  const form = useForm<CloudValues>({
    resolver: zodResolver(cloudSchema),
    defaultValues: { phone: '', phoneNumberId: '', accessToken: '' },
  });
  const connect = useMutation({
    mutationFn: (body: ConnectCloudApiBody) =>
      unwrap(messagingApi.POST('/api/v1/messaging/whatsapp/connect-cloud-api', { body })),
    onSuccess: (settings) => {
      queryClient.setQueryData(messagingKeys.whatsapp, settings);
      toast.success('WhatsApp connected.');
    },
    onError: (error) => {
      onRefusal(error);
      if (error instanceof ApiError && error.fieldErrors.length > 0) applyApiError(form, error);
      else form.setError('root.server', { message: whatsappErrorMessage(error) });
    },
    // The token is write-only: it leaves the form whatever the answer, and is never shown again.
    onSettled: () => form.resetField('accessToken'),
  });

  const onSubmit = form.handleSubmit((values) => connect.mutate(values));
  const reconnect = number !== null;

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4 rounded-lg border p-4" data-testid="cloud-api-form">
      <div className="grid gap-1">
        <p className="text-sm font-medium">
          {reconnect ? 'Reconnect with a new access token' : 'Connect a WhatsApp Business number'}
        </p>
        <p className="text-sm text-muted-foreground">
          Enter the details from the school’s Meta Business account. The number is checked with Meta before it is
          saved. The access token is stored encrypted and is never shown again.
        </p>
      </div>
      <FormRootError form={form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <PhoneField control={form.control} name="phone" label="WhatsApp number" />
        <FormField
          control={form.control}
          name="phoneNumberId"
          label="Phone-number ID"
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
        />
      </div>
      <FormField
        control={form.control}
        name="accessToken"
        label="Permanent access token"
        type="password"
        autoComplete="off"
        maxLength={1024}
        hint="Write-only: it is sent once and never displayed."
      />
      <div>
        <Button type="submit" disabled={connect.isPending}>
          {connect.isPending ? 'Checking with Meta…' : reconnect ? 'Reconnect' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}

// ---- Disable (§5.6) ----

function DisableNumber({ number }: { number: WhatsAppNumberDto }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const disable = useMutation({
    mutationFn: (reason: string) =>
      unwrap(messagingApi.POST('/api/v1/messaging/whatsapp/disable', { body: { reason } })),
    onSuccess: (settings) => {
      queryClient.setQueryData(messagingKeys.whatsapp, settings);
      toast.success('WhatsApp number disabled.');
      setOpen(false);
    },
  });
  return (
    <div>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Disable this number
      </Button>
      <ConfirmWithReasonDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) disable.reset();
          setOpen(next);
        }}
        title="Disable the WhatsApp number"
        description={`${number.phoneMasked} stops sending at once. Messages waiting for WhatsApp go by SMS where your allow list permits. The number can be connected again later.`}
        confirmLabel="Disable"
        minLength={3}
        destructive
        pending={disable.isPending}
        onConfirm={(reason) => disable.mutate(reason)}
      >
        {disable.error && (
          <Alert variant="destructive">
            <AlertDescription>{whatsappErrorMessage(disable.error)}</AlertDescription>
          </Alert>
        )}
      </ConfirmWithReasonDialog>
    </div>
  );
}
