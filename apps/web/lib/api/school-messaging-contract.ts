/**
 * School API types for messaging settings, WhatsApp onboarding, usage and the test message
 * (contracts/slice-9.md §2.2, §4, §5), taken from the generated OpenAPI document (`school.d.ts`,
 * produced by `pnpm api:generate`). Screens import the client and the DTO and body types from
 * here, so a regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components } from './school';

type Schemas = components['schemas'];

export { schoolApi as messagingApi } from './client';

// ---- Enums ----

export type MessageChannel = Schemas['MessageChannel'];
export type MessageType = Schemas['MessageType'];
export type WhatsAppProvider = Schemas['WhatsAppProvider'];
export type WhatsAppStatus = Schemas['WhatsAppStatus'];
export type WhatsAppErrorCode = Schemas['WhatsAppErrorCode'];

// ---- School settings (§4): the slice-2 fields plus the plan §4.5 additions ----

export type SchoolSettingsDto = Schemas['SchoolSettingsDto'];
/** Absent = unchanged; `null` only on `lateCutoffTime`. `smsMonthlyCap` is read-only (422 UNKNOWN_FIELD). */
export type UpdateSchoolSettingsBody = Schemas['UpdateSchoolSettingsDto'];

// ---- WhatsApp (§2.2, §5.3–§5.6) ----

export type WhatsAppNumberDto = Schemas['WhatsAppNumberDto'];
export type WhatsAppSettingsDto = Schemas['WhatsAppSettingsDto'];
/** Never stored, cached or logged by the screen. */
export type WhatsAppPairingDto = Schemas['WhatsAppPairingDto'];
export type PairWhatsAppBody = Schemas['WhatsAppPairDto'];
export type ConnectCloudApiBody = Schemas['ConnectCloudApiDto'];
export type DisableWhatsAppBody = Schemas['DisableWhatsAppDto'];

// ---- Usage and the test message (§5.1, §5.2) ----

export type TestChannel = Schemas['MessagingTestChannel'];
export type MessagingTestBody = Schemas['MessagingTestDto'];
export type MessagingTestResultDto = Schemas['MessagingTestResultDto'];
/**
 * The channels the usage view lists, zeros included. The document types `byChannel[].channel` as
 * every `MessageChannel`; the API sends only these four (messaging-admin.service.ts `USAGE_CHANNELS`).
 */
export type UsageChannel = Extract<Schemas['UsageChannelDto']['channel'], 'sms' | 'whatsapp' | 'push' | 'email'>;
export type MessagingUsageDto = Schemas['MessagingUsageDto'];

// ---- `details` of this slice's refusals; error details are not in the OpenAPI document ----

/** 409 WHATSAPP_VERIFICATION_FAILED from messaging-admin.service.ts `connectCloudApi`. */
export type WhatsAppVerificationFailure = {
  reason: 'token_rejected' | 'not_found' | 'number_mismatch' | 'number_in_use';
};
/** 409 SMS_CAP_EXCEEDED from messaging-admin.service.ts `sendTest`. */
export type SmsCapExceeded = { cap: number; used: number };
