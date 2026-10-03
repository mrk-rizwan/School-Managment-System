import type { DeliveryErrorCode } from '@asms/shared';

/** Every provider call is bounded (contracts/slice-9.md §5.4, §5.5: 10 s). */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * fetch with the provider timeout. Rejects on a network error or the timeout, and on any redirect:
 * a provider answering with a redirect would otherwise have the API key, the bearer token or the
 * message body re-sent to wherever it points.
 */
export function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
}

/** A thrown fetch: the timeout, or the provider unreachable. Never the error's text. */
export function transportError(error: unknown): DeliveryErrorCode {
  return error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'provider_unavailable';
}

/** The JSON body of a response, or null when it is not JSON. */
export async function jsonOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** A string at `obj[key]`, else null: provider bodies are read by narrowing, never trusted. */
export function stringAt(obj: unknown, key: string): string | null {
  const value = objectAt(obj, key);
  return typeof value === 'string' ? value : null;
}

/** An own property's value, or null. */
export function objectAt(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null) return null;
  const value: unknown = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return value ?? null;
}

export function numberAt(obj: unknown, key: string): number | null {
  const value = objectAt(obj, key);
  return typeof value === 'number' ? value : null;
}

/** E.164 `+923001234567` -> `923001234567` (WAHA chat ids, Meta and Sendpk numbers). */
export const digitsOf = (e164: string): string => e164.replace(/^\+/, '');
