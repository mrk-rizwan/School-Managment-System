import { Logger } from '@nestjs/common';
import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { PushDriver, PushMessage, PushOutcome } from './types';

// Push (Phase 2 plan §3): Firebase Cloud Messaging, multicast to every live device of the user;
// accepted when any device accepts (§7.6). The payload carries ids, a title and the body only
// (R173); the token is never logged.

const UNREGISTERED = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export class FcmPushDriver implements PushDriver {
  readonly #app: App;

  constructor(serviceAccountBase64: string) {
    const json: unknown = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
    if (typeof json !== 'object' || json === null) throw new Error('FCM service account is not JSON');
    this.#app = initializeApp({ credential: cert(json) }, 'asms-push');
  }

  async send(tokens: readonly string[], message: PushMessage): Promise<PushOutcome> {
    if (tokens.length === 0) return { accepted: false, unregistered: [], error: 'unregistered_device' };
    try {
      const result = await getMessaging(this.#app).sendEachForMulticast({
        tokens: [...tokens],
        notification: { title: message.title, body: message.body },
        data: { ...message.data },
        android: { priority: 'high' },
      });
      const unregistered = result.responses.flatMap((response, i) => {
        const token = tokens[i];
        return token !== undefined && response.error && UNREGISTERED.has(response.error.code)
          ? [token]
          : [];
      });
      const accepted = result.successCount > 0;
      return {
        accepted,
        unregistered,
        error: accepted
          ? null
          : unregistered.length === tokens.length
            ? 'unregistered_device'
            : 'provider_unavailable',
      };
    } catch {
      return { accepted: false, unregistered: [], error: 'provider_unavailable' };
    }
  }
}

/** Development and tests without FCM credentials (R112): logs the count, sends nothing. */
export class LogPushDriver implements PushDriver {
  private readonly logger = new Logger('LogPushDriver');

  send(tokens: readonly string[], message: PushMessage): Promise<PushOutcome> {
    this.logger.debug({ devices: tokens.length, type: message.data.type }, 'push (log driver)');
    return Promise.resolve(
      tokens.length === 0
        ? { accepted: false, unregistered: [], error: 'unregistered_device' }
        : { accepted: true, unregistered: [], error: null },
    );
  }
}
