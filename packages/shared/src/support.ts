/**
 * Platform support access (Phase 5 rule 40, phase-5-extended.md §3.1 "Exception 7", R349-R352).
 * `platform_support_sessions.end_kind`, the Postgres enum `support_session_end` (migration
 * 20261016120000_wave_u_rankings_imports_support; shared-enums.e2e-spec.ts compares them): how a
 * session ended, and the `reason` SUPPORT_SESSION_ENDED carries. closed = the platform user closed
 * it (or logged out); revoked = a principal revoked it; expired = the expiry job closed it.
 */
export const SUPPORT_SESSION_ENDS = ['closed', 'revoked', 'expired'] as const;
export type SupportSessionEnd = (typeof SUPPORT_SESSION_ENDS)[number];
