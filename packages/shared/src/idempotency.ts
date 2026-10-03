/**
 * Endpoints that take the slice-6 `Idempotency-Key` header: the lower-case route key stored in
 * `idempotency_keys.endpoint` (CHECK idempotency_keys_endpoint_check). Phase 2 adds diary
 * entries, remarks and announcements (phase-2-daily-operations.md §4.7, §6.1).
 */
export const IDEMPOTENT_ENDPOINTS = ['admissions', 'diary_entries', 'remarks', 'announcements'] as const;
export type IdempotentEndpoint = (typeof IDEMPOTENT_ENDPOINTS)[number];
