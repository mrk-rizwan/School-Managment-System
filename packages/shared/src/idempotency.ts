/**
 * Endpoints that take the slice-6 `Idempotency-Key` header: the lower-case route key stored in
 * `idempotency_keys.endpoint` (CHECK idempotency_keys_endpoint_check). Phase 2 adds diary
 * entries, remarks and announcements (phase-2-daily-operations.md §4.7, §6.1).
 */
export const IDEMPOTENT_ENDPOINTS = ['admissions', 'diary_entries', 'remarks', 'announcements'] as const;
export type IdempotentEndpoint = (typeof IDEMPOTENT_ENDPOINTS)[number];

/**
 * A fresh `Idempotency-Key` for a client (web and mobile): a v4 UUID **with its dashes**. The API
 * refuses a key holding 13 consecutive digits (it could be an identity number;
 * idempotency_keys_key_no_id_check). A dashless UUID is 32 hex characters and about one in
 * twenty-five holds such a run, which surfaced as an intermittent "not admitted" in the
 * admission wizard. With the dashes, no segment is longer than 12 characters, so no run of
 * digits can reach 13. Matches the key pattern (16-64 of [A-Za-z0-9_-]).
 */
export const newIdempotencyKey = (): string => globalThis.crypto.randomUUID();
