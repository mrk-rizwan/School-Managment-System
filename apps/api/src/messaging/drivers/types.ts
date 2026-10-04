// The driver interfaces (Phase 2 plan §3, contracts/slice-9.md §7.6, §9). A driver turns one
// attempt into a mapped outcome; provider error text never leaves the driver (R111). Drivers are
// imported only inside src/messaging/** (eslint.config.mjs): nothing reaches a person except
// through NotificationService and the processor.
import type { DeliveryErrorCode, WhatsAppErrorCode } from '@asms/shared';

/** One attempt's outcome. `ref` is the provider's reference, raw: hash it before storing. */
export type SendOutcome =
  | { kind: 'accepted'; ref: string | null }
  | { kind: 'failed'; error: DeliveryErrorCode }
  /** A paced send (§7.6): not an attempt; retry at `retryAt`. */
  | { kind: 'paced'; retryAt: Date };

export interface PushMessage {
  title: string;
  body: string;
  /** Ids only (R173): type, subjectType, subjectId, messageId. */
  data: Readonly<Record<string, string>>;
}

export interface PushOutcome {
  /** Any device accepted. */
  accepted: boolean;
  /** Tokens FCM reported as no longer registered. */
  unregistered: readonly string[];
  /** When nothing was accepted and not every token was unregistered. */
  error: DeliveryErrorCode | null;
}

export interface PushDriver {
  send(tokens: readonly string[], message: PushMessage): Promise<PushOutcome>;
}

/** The school's live number as a driver needs it; the Cloud API token decrypted. */
export interface WhatsAppSender {
  wahaSession: string | null;
  cloudPhoneNumberId: string | null;
  cloudAccessToken: string | null;
}

export type HealthOutcome = { ok: true } | { ok: false; code: WhatsAppErrorCode };

/** An attachment sent as bytes, never a URL (R148). */
export interface MediaFile {
  bytes: Buffer;
  /** `image/jpeg`, `image/png` or `application/pdf`. */
  mime: string;
  filename: string;
}

export interface WhatsAppDriver {
  /** `templateName` is the Cloud API's approved template (`asms_<type>_v1`); WAHA ignores it. */
  sendText(
    sender: WhatsAppSender,
    toE164: string,
    text: string,
    templateName: string,
  ): Promise<SendOutcome>;
  /**
   * The attachment with `caption` (contracts/slice-14.md §5.4): WAHA sendImage / sendFile; the
   * Cloud API an uploaded-media template message whose body variable is the caption.
   */
  sendMedia(
    sender: WhatsAppSender,
    toE164: string,
    caption: string,
    media: MediaFile,
    templateName: string,
  ): Promise<SendOutcome>;
  health(sender: WhatsAppSender): Promise<HealthOutcome>;
}

/** WAHA-only session management (§5.4, §5.6). */
export interface WahaSessions {
  /** Creates (if needed) and starts the session; `working` when it is already paired. */
  start(session: string): Promise<'working' | 'needs_qr'>;
  /** The pairing QR as a PNG data URI. Never logged or stored. */
  qr(session: string): Promise<string>;
  /** Logs the session out and deletes it (best effort; throws on failure). */
  stop(session: string): Promise<void>;
}

/** Cloud API onboarding (§5.5): one Graph read with the school's token. */
export type CloudVerification =
  | { ok: true; displayPhoneNumber: string }
  | { ok: false; reason: 'token_rejected' | 'not_found' | 'unreachable' };

export interface CloudApiVerifier {
  verify(phoneNumberId: string, accessToken: string): Promise<CloudVerification>;
}

export type SmsStatus =
  | { kind: 'pending' }
  | { kind: 'delivered' }
  | { kind: 'failed'; error: DeliveryErrorCode };

export interface SmsDriver {
  /** `toE164` is a Pakistani mobile (+923...); `text` is GSM-7. */
  send(toE164: string, text: string): Promise<SendOutcome>;
  /** Pull providers (Sendpk): the status of a reference returned by send. */
  fetchStatus(ref: string): Promise<SmsStatus>;
  /** Whether references must be kept (encrypted) for polling. */
  readonly pull: boolean;
}

export interface EmailDriver {
  send(to: string, subject: string, text: string): Promise<SendOutcome>;
}

/** Every driver, selected once at boot from the environment (drivers.ts). Tests replace it. */
export interface MessagingDrivers {
  push: PushDriver;
  whatsapp: { waha: WhatsAppDriver; cloud_api: WhatsAppDriver };
  waha: WahaSessions;
  cloud: CloudApiVerifier;
  sms: SmsDriver;
  email: EmailDriver;
}

export const MESSAGING_DRIVERS = Symbol('MESSAGING_DRIVERS');
