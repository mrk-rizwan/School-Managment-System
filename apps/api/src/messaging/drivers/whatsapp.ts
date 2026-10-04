import { createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DeliveryErrorCode } from '@asms/shared';
import { metaError } from '../provider-errors';
import { digitsOf, jsonOf, numberAt, objectAt, providerFetch, stringAt, transportError } from './http';
import type {
  CloudApiVerifier,
  CloudVerification,
  HealthOutcome,
  MediaFile,
  SendOutcome,
  WahaSessions,
  WhatsAppDriver,
  WhatsAppSender,
} from './types';

// WhatsApp (Phase 2 plan §3, contracts/slice-9.md §5.4, §5.5, §7.6, §7.8): two drivers behind
// one interface, chosen by the live row's own provider. Nothing a provider says is stored or
// logged raw; errors are mapped to DeliveryErrorCode / WhatsAppErrorCode.

/** WAHA sends are paced at 60 per minute per session (§7.6). */
export const WAHA_PER_MINUTE = 60;

const PACE = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], 70000) end
return n`;

export interface WahaConfig {
  url: string;
  apiKey: string;
  webhookUrl: string;
  webhookSecret: string;
}

/** WAHA (self-hosted): the school's own number as a WhatsApp Web session. */
export class WahaDriver implements WhatsAppDriver, WahaSessions {
  constructor(
    private readonly config: WahaConfig,
    private readonly redis: Redis,
  ) {}

  private call(path: string, init: RequestInit = {}): Promise<Response> {
    return providerFetch(`${this.config.url}${path}`, {
      ...init,
      headers: { 'X-Api-Key': this.config.apiKey, 'Content-Type': 'application/json', ...init.headers },
    });
  }

  /** A paced send is delayed to the next minute, not attempted. */
  private async paced(session: string, now: Date): Promise<Date | null> {
    const minute = Math.floor(now.getTime() / 60_000);
    const count = await this.redis.eval(PACE, 1, `asms:waha-pace:${session}:${minute}`);
    return typeof count === 'number' && count > WAHA_PER_MINUTE ? new Date((minute + 1) * 60_000) : null;
  }

  sendText(sender: WhatsAppSender, toE164: string, text: string): Promise<SendOutcome> {
    return this.send(sender, toE164, '/api/sendText', { text });
  }

  /** The bytes as base64 with the caption: an image as a picture, a PDF as a file. */
  sendMedia(sender: WhatsAppSender, toE164: string, caption: string, media: MediaFile): Promise<SendOutcome> {
    return this.send(sender, toE164, media.mime.startsWith('image/') ? '/api/sendImage' : '/api/sendFile', {
      caption,
      file: { mimetype: media.mime, filename: media.filename, data: media.bytes.toString('base64') },
    });
  }

  private async send(
    sender: WhatsAppSender,
    toE164: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<SendOutcome> {
    const session = sender.wahaSession;
    if (session === null) return { kind: 'failed', error: 'session_down' };
    try {
      const retryAt = await this.paced(session, new Date());
      if (retryAt) return { kind: 'paced', retryAt };
    } catch {
      return { kind: 'failed', error: 'provider_unavailable' };
    }
    let response: Response;
    try {
      response = await this.call(path, {
        method: 'POST',
        body: JSON.stringify({ session, chatId: `${digitsOf(toE164)}@c.us`, ...payload }),
      });
    } catch (error) {
      return { kind: 'failed', error: transportError(error) };
    }
    if (!response.ok) return { kind: 'failed', error: wahaError(response.status) };
    const body = await jsonOf(response);
    // WAHA answers with the message, whose id is a string or { _serialized }.
    const ref = stringAt(body, 'id') ?? stringAt(objectAt(body, 'id'), '_serialized');
    return { kind: 'accepted', ref };
  }

  async health(sender: WhatsAppSender): Promise<HealthOutcome> {
    if (sender.wahaSession === null) return { ok: false, code: 'session_failed' };
    let response: Response;
    try {
      response = await this.call(`/api/sessions/${encodeURIComponent(sender.wahaSession)}`);
    } catch {
      return { ok: false, code: 'unreachable' };
    }
    if (response.status === 404) return { ok: false, code: 'logged_out' };
    if (!response.ok) return { ok: false, code: 'unreachable' };
    const status = stringAt(await jsonOf(response), 'status');
    if (status === 'WORKING') return { ok: true };
    if (status === 'SCAN_QR_CODE' || status === 'STOPPED') return { ok: false, code: 'logged_out' };
    if (status === 'FAILED') return { ok: false, code: 'session_failed' };
    return { ok: false, code: 'unknown' };
  }

  async start(session: string): Promise<'working' | 'needs_qr'> {
    const existing = await this.call(`/api/sessions/${encodeURIComponent(session)}`);
    if (existing.status === 404) {
      const created = await this.call('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: session,
          start: false,
          config: {
            webhooks: [
              {
                url: this.config.webhookUrl,
                events: ['message.ack', 'session.status', 'message'],
                hmac: { key: this.config.webhookSecret },
              },
            ],
          },
        }),
      });
      if (!created.ok) throw new Error(`WAHA session create answered ${created.status}`);
    } else if (!existing.ok) {
      throw new Error(`WAHA session read answered ${existing.status}`);
    } else if (stringAt(await jsonOf(existing), 'status') === 'WORKING') {
      return 'working';
    }
    const started = await this.call(`/api/sessions/${encodeURIComponent(session)}/start`, {
      method: 'POST',
    });
    // 422: already started; the QR is still available.
    if (!started.ok && started.status !== 422) throw new Error(`WAHA start answered ${started.status}`);
    return 'needs_qr';
  }

  async qr(session: string): Promise<string> {
    const response = await this.call(`/api/${encodeURIComponent(session)}/auth/qr?format=image`, {
      headers: { Accept: 'image/png' },
    });
    if (!response.ok) throw new Error(`WAHA QR answered ${response.status}`);
    const png = Buffer.from(await response.arrayBuffer());
    return `data:image/png;base64,${png.toString('base64')}`;
  }

  async stop(session: string): Promise<void> {
    const name = encodeURIComponent(session);
    await this.call(`/api/sessions/${name}/logout`, { method: 'POST' });
    const deleted = await this.call(`/api/sessions/${name}`, { method: 'DELETE' });
    if (!deleted.ok && deleted.status !== 404) throw new Error(`WAHA delete answered ${deleted.status}`);
  }
}

function wahaError(status: number): DeliveryErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404 || status === 422) return 'session_down';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'rejected';
}

/** WhatsApp Business Cloud API (Meta Graph), with the school's own token. */
export class CloudApiDriver implements WhatsAppDriver, CloudApiVerifier {
  constructor(private readonly graphVersion: string) {}

  private url(path: string): string {
    return `https://graph.facebook.com/${this.graphVersion}/${path}`;
  }

  sendText(
    sender: WhatsAppSender,
    toE164: string,
    text: string,
    templateName: string,
  ): Promise<SendOutcome> {
    return this.sendTemplate(sender, toE164, templateName, [
      { type: 'body', parameters: [{ type: 'text', text }] },
    ]);
  }

  /**
   * The bytes are uploaded to the number's media store, then sent as the approved template's
   * header (image or document) with the caption as its body variable.
   */
  async sendMedia(
    sender: WhatsAppSender,
    toE164: string,
    caption: string,
    media: MediaFile,
    templateName: string,
  ): Promise<SendOutcome> {
    if (sender.cloudPhoneNumberId === null || sender.cloudAccessToken === null) {
      return { kind: 'failed', error: 'session_down' };
    }
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', media.mime);
    form.append('file', new Blob([new Uint8Array(media.bytes)], { type: media.mime }), media.filename);
    let uploaded: Response;
    try {
      uploaded = await providerFetch(this.url(`${sender.cloudPhoneNumberId}/media`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${sender.cloudAccessToken}` },
        body: form,
      });
    } catch (error) {
      return { kind: 'failed', error: transportError(error) };
    }
    const upload = await jsonOf(uploaded);
    const mediaId = stringAt(upload, 'id');
    if (!uploaded.ok || mediaId === null) {
      if (uploaded.status === 401) return { kind: 'failed', error: 'auth_failed' };
      return { kind: 'failed', error: metaError(numberAt(objectAt(upload, 'error'), 'code')) };
    }
    const kind = media.mime.startsWith('image/') ? 'image' : 'document';
    const asset = kind === 'image' ? { id: mediaId } : { id: mediaId, filename: media.filename };
    return this.sendTemplate(sender, toE164, templateName, [
      { type: 'header', parameters: [{ type: kind, [kind]: asset }] },
      { type: 'body', parameters: [{ type: 'text', text: caption }] },
    ]);
  }

  private async sendTemplate(
    sender: WhatsAppSender,
    toE164: string,
    templateName: string,
    components: readonly object[],
  ): Promise<SendOutcome> {
    if (sender.cloudPhoneNumberId === null || sender.cloudAccessToken === null) {
      return { kind: 'failed', error: 'session_down' };
    }
    let response: Response;
    try {
      response = await providerFetch(this.url(`${sender.cloudPhoneNumberId}/messages`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sender.cloudAccessToken}`,
          'Content-Type': 'application/json',
        },
        // The approved utility template carries the rendered text as its one body variable.
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: digitsOf(toE164),
          type: 'template',
          template: { name: templateName, language: { code: 'en' }, components },
        }),
      });
    } catch (error) {
      return { kind: 'failed', error: transportError(error) };
    }
    const body = await jsonOf(response);
    if (!response.ok) {
      if (response.status === 401) return { kind: 'failed', error: 'auth_failed' };
      return { kind: 'failed', error: metaError(numberAt(objectAt(body, 'error'), 'code')) };
    }
    const messages = objectAt(body, 'messages');
    const first: unknown = Array.isArray(messages) ? messages[0] : null;
    return { kind: 'accepted', ref: stringAt(first, 'id') };
  }

  async verify(phoneNumberId: string, accessToken: string): Promise<CloudVerification> {
    let response: Response;
    try {
      response = await providerFetch(
        this.url(`${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`),
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    const body = await jsonOf(response);
    if (response.status === 401 || numberAt(objectAt(body, 'error'), 'code') === 190) {
      return { ok: false, reason: 'token_rejected' };
    }
    if (!response.ok) {
      return response.status >= 500 ? { ok: false, reason: 'unreachable' } : { ok: false, reason: 'not_found' };
    }
    const display = stringAt(body, 'display_phone_number');
    return display === null ? { ok: false, reason: 'not_found' } : { ok: true, displayPhoneNumber: display };
  }

  async health(sender: WhatsAppSender): Promise<HealthOutcome> {
    if (sender.cloudPhoneNumberId === null || sender.cloudAccessToken === null) {
      return { ok: false, code: 'token_rejected' };
    }
    const result = await this.verify(sender.cloudPhoneNumberId, sender.cloudAccessToken);
    if (result.ok) return { ok: true };
    return { ok: false, code: result.reason === 'unreachable' ? 'unreachable' : 'token_rejected' };
  }
}

/**
 * A provider this deployment does not run (WHATSAPP_PROVIDERS_ENABLED, M1): every send fails as
 * `session_down` (a permanent failure, so a WhatsApp guardian falls to SMS), every health check
 * fails (a live row of this provider goes down once, with the usual alert), onboarding throws
 * (the route answers 503) and Cloud API verification reports the provider unreachable.
 */
export class DisabledWhatsAppDriver implements WhatsAppDriver, WahaSessions, CloudApiVerifier {
  sendText(): Promise<SendOutcome> {
    return Promise.resolve({ kind: 'failed', error: 'session_down' });
  }

  sendMedia(): Promise<SendOutcome> {
    return this.sendText();
  }

  health(): Promise<HealthOutcome> {
    return Promise.resolve({ ok: false, code: 'unreachable' });
  }

  start(): Promise<'working' | 'needs_qr'> {
    return Promise.reject(new Error('WhatsApp provider disabled on this deployment'));
  }

  qr(): Promise<string> {
    return Promise.reject(new Error('WhatsApp provider disabled on this deployment'));
  }

  stop(): Promise<void> {
    return Promise.reject(new Error('WhatsApp provider disabled on this deployment'));
  }

  verify(): Promise<CloudVerification> {
    return Promise.resolve({ ok: false, reason: 'unreachable' });
  }
}

/**
 * Development and tests without provider credentials (R112): accepts every send with a random
 * reference and reports every session healthy. Sends nothing.
 */
export class LogWhatsAppDriver implements WhatsAppDriver, WahaSessions, CloudApiVerifier {
  private readonly logger = new Logger('LogWhatsAppDriver');

  sendText(): Promise<SendOutcome> {
    this.logger.debug('whatsapp (log driver)');
    return Promise.resolve({ kind: 'accepted', ref: `log-${randomBytes(8).toString('hex')}` });
  }

  sendMedia(): Promise<SendOutcome> {
    return this.sendText();
  }

  health(): Promise<HealthOutcome> {
    return Promise.resolve({ ok: true });
  }

  start(): Promise<'working' | 'needs_qr'> {
    return Promise.resolve('needs_qr');
  }

  qr(session: string): Promise<string> {
    // A placeholder image derived from the session name: no real pairing happens.
    const fake = createHash('sha256').update(session).digest('base64');
    return Promise.resolve(`data:image/png;base64,${fake}`);
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  verify(): Promise<CloudVerification> {
    return Promise.resolve({ ok: false, reason: 'unreachable' });
  }
}
