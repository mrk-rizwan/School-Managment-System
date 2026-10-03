import type { IncomingMessage } from 'node:http';
import { API_PREFIX } from '../common/http';

// R172: a webhook's HMAC is computed over the raw bytes, never a re-serialised body. The JSON
// parser keeps those bytes, for webhook paths only, on a symbol a client cannot set.

const RAW_BODY = Symbol('rawBody');
const WEBHOOK_PATH = `/${API_PREFIX}/webhooks/`;

type WithRawBody = IncomingMessage & { [RAW_BODY]?: Buffer };

/** The JSON parser's `verify` hook (bootstrap.ts). */
export function captureWebhookRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  if (req.url?.startsWith(WEBHOOK_PATH)) {
    const target: WithRawBody = req;
    target[RAW_BODY] = Buffer.from(buf);
  }
}

/** The bytes the parser read, or null (no body, or not a webhook path). */
export function rawBodyOf(req: IncomingMessage): Buffer | null {
  const source: WithRawBody = req;
  return source[RAW_BODY] ?? null;
}
