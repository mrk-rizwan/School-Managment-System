import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { digitsOf, providerFetch, transportError } from './http';
import type { SendOutcome, SmsDriver, SmsStatus } from './types';

// SMS (Phase 2 plan §3; contracts/slice-9.md §9). The one real adapter is Sendpk. What is fixed:
// HTTPS POST to api/sms.php with the key in the body (never a query string); exactly `OK ID:<n>`
// is accepted with reference <n>; anything else is a hard failure, never retried as transient;
// delivery reports by pull (api/delivery.php), driven by the poll job (§7.10).
//
// Assumptions until the vendor answers §9's questions (recorded in its table as "assumed"): the
// number is sent as 92XXXXXXXXXX, one per request (Q2 / note); the body fields are api_key,
// sender, mobile, message; delivery.php takes api_key and id in a POST body and answers a status
// word (Q3, Q4) mapped below; a response naming the API key is the key error (auth_failed).

/** `OK ID:<n>`: the only success form. */
const ACCEPTED = /^OK ID:\s*([0-9A-Za-z_-]{1,64})\s*$/;

/** Assumed status words of delivery.php (§9 Q4), matched case-insensitively. */
export function sendpkStatus(text: string): SmsStatus {
  const word = text.trim().toLowerCase();
  if (/\bdelivered\b/.test(word) && !/\bundelivered\b/.test(word)) return { kind: 'delivered' };
  if (/\bdnd\b|\bdncr\b|do not disturb/.test(word)) return { kind: 'failed', error: 'dnd_blocked' };
  if (/\bexpired\b/.test(word)) return { kind: 'failed', error: 'expired' };
  if (/\binvalid\b.*\b(number|mobile)\b/.test(word)) return { kind: 'failed', error: 'invalid_number' };
  if (/\b(failed|undelivered|rejected)\b/.test(word)) return { kind: 'failed', error: 'rejected' };
  return { kind: 'pending' };
}

/** A send response: `OK ID:<n>` accepted; the key error auth_failed; anything else rejected. */
export function sendpkSendOutcome(text: string): SendOutcome {
  const match = ACCEPTED.exec(text.trim());
  if (match?.[1]) return { kind: 'accepted', ref: match[1] };
  if (/api[\s_-]?key/i.test(text)) return { kind: 'failed', error: 'auth_failed' };
  return { kind: 'failed', error: 'rejected' };
}

export interface SendpkConfig {
  baseUrl: string;
  apiKey: string;
  senderId: string;
}

export class SendpkSmsDriver implements SmsDriver {
  readonly pull = true;

  constructor(private readonly config: SendpkConfig) {}

  private post(path: string, fields: Record<string, string>): Promise<Response> {
    return providerFetch(`${this.config.baseUrl}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: this.config.apiKey, ...fields }).toString(),
    });
  }

  async send(toE164: string, text: string): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await this.post('sms.php', {
        sender: this.config.senderId,
        mobile: digitsOf(toE164),
        message: text,
      });
    } catch (error) {
      return { kind: 'failed', error: transportError(error) };
    }
    if (response.status >= 500) return { kind: 'failed', error: 'provider_unavailable' };
    return sendpkSendOutcome(await response.text());
  }

  async fetchStatus(ref: string): Promise<SmsStatus> {
    const response = await this.post('delivery.php', { id: ref });
    if (!response.ok) return { kind: 'pending' };
    return sendpkStatus(await response.text());
  }
}

/** Development and tests without SMS_API_KEY (R112): accepts, sends nothing, reports pending. */
export class LogSmsDriver implements SmsDriver {
  readonly pull = true;
  private readonly logger = new Logger('LogSmsDriver');

  send(_to: string, text: string): Promise<SendOutcome> {
    this.logger.debug({ characters: text.length }, 'sms (log driver)');
    return Promise.resolve({ kind: 'accepted', ref: `log${randomBytes(6).toString('hex')}` });
  }

  fetchStatus(): Promise<SmsStatus> {
    return Promise.resolve({ kind: 'pending' });
  }
}
