import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ErrorCode } from '@asms/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { ENV, type Env } from '../config/env';
import { ApiException } from '../common/errors/api-exception';
import { failureLog } from '../common/errors/failure-log';
import { enforceRateLimits, MINUTE_MS, storageUnavailable } from '../common/rate-limit';
import { metaError } from '../messaging/provider-errors';
import { OutboxDispatcher } from '../messaging/outbox-dispatcher';
import { providerRefHash } from '../messaging/provider-refs';
// Named exception 5 (contracts/slice-9.md §8.5; NAMED_EXCEPTION_SITES in eslint.config.mjs).
import { DeliveryWebhookRepository } from '../repositories/platform/delivery-webhook.repository';

// Provider delivery reports (contracts/slice-9.md §8; R172). Verified over the raw bytes with
// timingSafeEqual; a zod schema per provider picks only the fields used; a verified body is
// always 204 (known, unknown or stale reference alike: a counter, never an insert); a bad
// signature is 401 with no details. Handlers never mint a SchoolId: they call the exception-5
// repository and enqueue `{ schoolId, ... }` jobs that pass through fromQueuePayload. Logs carry
// the provider, the event and the outcome only - never a body, number, chat id or reference.

export type WebhookOutcome = 'applied' | 'unknown_reference' | 'stale' | 'ignored' | 'unparseable';

/** Failed verifications per IP per minute; once spent the IP is 429 before verification. */
export const FAILED_PER_MINUTE = 10;
/** Verified webhook requests per IP per minute. */
export const VERIFIED_PER_MINUTE = 3000;
/** WAHA's signed `timestamp` must be within this of now (§8.2). */
export const WAHA_WINDOW_MS = 5 * MINUTE_MS;

const FAILURE = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

const signatureInvalid = () =>
  new ApiException(401, ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'The webhook signature is invalid.');

/** Equal-length, constant-time comparison of two hex digests. */
export function digestsEqual(expectedHex: string, presented: string): boolean {
  if (!/^[0-9a-f]+$/i.test(presented)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(presented, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The stored form of a WhatsApp provider reference, exactly as the processor wrote it. */
const refHash = (ref: string): string => providerRefHash('whatsapp', ref);

const WAHA_BODY = z.object({
  event: z.string().max(64),
  session: z.string().max(64),
  timestamp: z.number(),
  payload: z.object({ id: z.string().max(512).optional(), ack: z.number().optional() }).optional(),
});

const META_BODY = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string().max(32) }).optional(),
                statuses: z
                  .array(
                    z.object({
                      id: z.string().max(512),
                      status: z.string().max(32),
                      errors: z.array(z.object({ code: z.number() })).optional(),
                    }),
                  )
                  .optional(),
                messages: z.array(z.unknown()).optional(),
              }),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});

const META_CHALLENGE = z.strictObject({
  'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string().max(512),
  'hub.challenge': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Webhooks');
  /** Outcome counters (the "counter" of §8.1), per provider and outcome. */
  readonly counters = new Map<string, number>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly reports: DeliveryWebhookRepository,
    private readonly outbox: OutboxDispatcher,
  ) {}

  // ------------------------------------------------------------------------------ throttles

  private async redisCall(command: string, args: string[]): Promise<unknown> {
    if (!(this.storage instanceof ThrottlerStorageRedisService)) throw storageUnavailable();
    try {
      return await this.storage.redis.call(command, ...args);
    } catch (error) {
      this.logger.error(failureLog(error), 'webhook throttle storage unreachable');
      throw storageUnavailable();
    }
  }

  private failedKey = (ip: string) => `asms:webhook-failed:{${ip}}`;

  /** 429 before verification once the IP's failed-verification budget is spent. */
  async refuseIfFailedBudgetSpent(ip: string, res: Response): Promise<void> {
    const count = Number(await this.redisCall('GET', [this.failedKey(ip)]));
    if (count >= FAILED_PER_MINUTE) {
      res.setHeader('Retry-After', '60');
      throw new ApiException(429, ErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.');
    }
  }

  private async recordFailure(ip: string): Promise<void> {
    await this.redisCall('EVAL', [FAILURE, '1', this.failedKey(ip), String(MINUTE_MS)]);
  }

  private async countVerified(ip: string, res: Response): Promise<void> {
    await enforceRateLimits(
      this.storage,
      res,
      [{ name: 'webhook-verified', key: ip, limit: VERIFIED_PER_MINUTE, ttlMs: MINUTE_MS }],
      this.logger,
    );
  }

  /** HMAC of the raw bytes, compared in constant time; a failure is counted and refused (401). */
  async verify(
    ip: string,
    res: Response,
    raw: Buffer | null,
    algorithm: 'sha512' | 'sha256',
    secret: string | undefined,
    presented: string | undefined,
  ): Promise<void> {
    const ok =
      raw !== null &&
      secret !== undefined &&
      presented !== undefined &&
      digestsEqual(createHmac(algorithm, secret).update(raw).digest('hex'), presented);
    if (!ok) {
      await this.recordFailure(ip);
      throw signatureInvalid();
    }
    await this.countVerified(ip, res);
  }

  private count(provider: string, event: string, outcome: WebhookOutcome): WebhookOutcome {
    const key = `${provider}:${outcome}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    this.logger.log({ provider, event, outcome }, 'webhook');
    return outcome;
  }

  // ------------------------------------------------------------------------------ WAHA (§8.2)

  async waha(body: unknown, now: Date = new Date()): Promise<WebhookOutcome> {
    const parsed = WAHA_BODY.safeParse(body);
    if (!parsed.success) return this.count('waha', 'unknown', 'unparseable');
    const { event, session, timestamp, payload } = parsed.data;
    if (Math.abs(now.getTime() - timestamp) > WAHA_WINDOW_MS) return this.count('waha', event, 'stale');
    switch (event) {
      case 'message.ack': {
        const ack = payload?.ack;
        const id = payload?.id;
        if (id === undefined || ack === undefined) return this.count('waha', event, 'ignored');
        let reported;
        if (ack >= 2) reported = await this.reports.reportWhatsApp(refHash(id), 'delivered', null);
        else if (ack === -1) reported = await this.reports.reportWhatsApp(refHash(id), 'failed', 'rejected');
        else return this.count('waha', event, 'ignored');
        if (!reported) return this.count('waha', event, 'unknown_reference');
        await this.outbox.rollup(reported.schoolId, [
          { deliveryId: reported.deliveryId, messageId: reported.messageId, status: ack >= 2 ? 'delivered' : 'failed' },
        ]);
        return this.count('waha', event, 'applied');
      }
      case 'session.status': {
        // Never writes status: it triggers a health check, which asks the provider (decision 8).
        const row = await this.reports.countInboundByWahaSession(session, 0);
        if (!row) return this.count('waha', event, 'unknown_reference');
        await this.outbox.health(row.schoolId, row.whatsappNumberId, now);
        return this.count('waha', event, 'applied');
      }
      case 'message': {
        const row = await this.reports.countInboundByWahaSession(session, 1);
        return this.count('waha', event, row ? 'applied' : 'unknown_reference');
      }
      default:
        return this.count('waha', event, 'ignored');
    }
  }

  // ------------------------------------------------------------------------------ Meta (§8.3)

  /** The subscription handshake: the challenge when the verify token matches, else 401. */
  async metaChallenge(ip: string, query: unknown): Promise<string> {
    const parsed = META_CHALLENGE.safeParse(query);
    const expected = this.env.META_WEBHOOK_VERIFY_TOKEN;
    const a = Buffer.from(parsed.success ? parsed.data['hub.verify_token'] : '');
    const b = Buffer.from(expected ?? '');
    if (!parsed.success || expected === undefined || a.length !== b.length || !timingSafeEqual(a, b)) {
      await this.recordFailure(ip);
      throw signatureInvalid();
    }
    return parsed.data['hub.challenge'];
  }

  async meta(body: unknown): Promise<WebhookOutcome[]> {
    const parsed = META_BODY.safeParse(body);
    if (!parsed.success) return [this.count('meta', 'unknown', 'unparseable')];
    const outcomes: WebhookOutcome[] = [];
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') {
          outcomes.push(this.count('meta', change.field, 'ignored'));
          continue;
        }
        for (const status of change.value.statuses ?? []) {
          outcomes.push(await this.metaStatus(status));
        }
        const inbound = change.value.messages?.length ?? 0;
        const phoneNumberId = change.value.metadata?.phone_number_id;
        if (inbound > 0 && phoneNumberId !== undefined) {
          const row = await this.reports.countInboundByCloudPhoneNumberId(phoneNumberId, inbound);
          outcomes.push(this.count('meta', 'messages', row ? 'applied' : 'unknown_reference'));
        }
      }
    }
    return outcomes;
  }

  private async metaStatus(status: {
    id: string;
    status: string;
    errors?: { code: number }[] | undefined;
  }): Promise<WebhookOutcome> {
    const event = `status.${status.status}`;
    let reported;
    if (status.status === 'delivered' || status.status === 'read') {
      // "read" is recorded as delivered: the word appears in no DTO (rule 0.13).
      reported = await this.reports.reportWhatsApp(refHash(status.id), 'delivered', null);
    } else if (status.status === 'failed') {
      reported = await this.reports.reportWhatsApp(
        refHash(status.id),
        'failed',
        metaError(status.errors?.[0]?.code ?? null),
      );
    } else {
      return this.count('meta', event, 'ignored');
    }
    if (!reported) return this.count('meta', event, 'unknown_reference');
    await this.outbox.rollup(reported.schoolId, [
      {
        deliveryId: reported.deliveryId,
        messageId: reported.messageId,
        status: status.status === 'failed' ? 'failed' : 'delivered',
      },
    ]);
    return this.count('meta', event, 'applied');
  }
}

/** The service with its exception-5 repository, so only this file imports it. */
export const WEBHOOK_PROVIDERS = [WebhooksService, DeliveryWebhookRepository];
