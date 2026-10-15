# Slice 45 contracts — platform support access (named exception 7)

**Author:** Opus 5.5 (wave U), 2026-10-15. **Binds:** `apps/api/src/modules/platform/support/**`,
`repositories/platform/support-session.repository.ts`, `repositories/platform/support-reads.repository.ts`,
`tenancy/school-id.mint.ts` (`schoolIdFromSupportSession`, `supportSessionRecord`),
`tenancy/support-flag.ts`, `tenancy/support-read-context.ts`, the query guard's support check
(`repositories/query-guard.ts`, `repositories/prisma.ts`), `ChangeContextRepository.readOnly`,
`MeDto.supportSession`, platform logout, the `support-session-expire` job, `PlatformStepUp`
(`modules/platform/auth/platform-step-up.ts`); the web pages `/platform/support`, the school
settings card and the staff banner. **Source:** `phase-5-extended.md` rule 35, §1.1 ("Support
session", "Support views"), §1.2 item 41, §1.3 A12, §3.1 "Exception 7", §3.2 Support, §3.4, §3.5,
§5.1, §5 slice 45, §7.1, §7.2, R349–R353. Everything not restated follows the Phase 1–4 conventions
(envelope, string ids, `PageQueryDto` ≤ 50, `NoQueryDto`, `404` outside the scope, no `DELETE`). No
migration: wave U (`a659e76`) built `platform_support_sessions`, the groundwork the codes, the
message types, the templates and `platform_settings.support_session_hours`.

## 1. Routes

Platform (`@PlatformSession('full')`, platform OpenAPI document):

| Route | Notes |
|---|---|
| `POST /platform/schools/:id/support-sessions { reason, ticketRef, totp }` | `201 SupportSessionDto`. Fresh second factor (§2.1). `support-open` throttle 5/min, 20/h per platform user |
| `GET /platform/support-sessions?schoolId&status=open\|ended&page&limit` | every admin's sessions (metadata only), `-openedAt` |
| `GET /platform/support-sessions/:id` | any admin's session; `404` unknown |
| `POST /platform/support-sessions/:id/close { reason? }` | owner only (else `404`); ended → `403 SUPPORT_SESSION_ENDED { reason }` |
| `GET /platform/support-sessions/:id/settings` | `SupportSchoolSettingsDto` |
| `GET …/:id/students?admissionNo=` | page of `SupportStudentSummaryDto`, exact admission number |
| `GET …/:id/students/:studentId` | `SupportStudentDto` (guardian names and phones) |
| `GET …/:id/students/:studentId/charges?page&limit` | page of `SupportChargeDto` |
| `GET …/:id/students/:studentId/payments?page&limit` | page of `SupportPaymentDto` |
| `GET …/:id/audit-log?<slice 46 filters>` | page of `AuditEntryDto`, the audit screen's exclusions and masking |

The six views carry `SupportSessionGuard` (open and owned by the caller; another admin's session or
an unknown id → `404`; closed, revoked or past `expires_at` → `403 SUPPORT_SESSION_ENDED { reason:
closed | revoked | expired }`) and the `support-reads` throttle (120/min, 2000/h per platform user).
A student of another school, or an unknown one, is `404`.

School (school OpenAPI document; `SchoolSupportModule`, imported by `AppModule`, not `PlatformModule`):

| Route | Guard | Notes |
|---|---|---|
| `GET /school/support-sessions?page&limit` | `school.settings.manage` | page of `SchoolSupportSessionDto`, `-openedAt` |
| `POST /school/support-sessions/:id/revoke { reason }` | `school.settings.manage` | `200 SchoolSupportSessionDto`; ended → `403 SUPPORT_SESSION_ENDED` |

`MeDto.supportSession: { id, reason, expiresAt } | null` — the school's open session, for every user
with staff capacity (null otherwise and when none is open).

## 2. Behaviour

### 2.1 Open

1. The TOTP is verified first, in its own transaction, against the caller's stored secret with the
   replay check (`step > totp_last_step`, the step then stored): `409 TOTP_INVALID` on a wrong,
   malformed or replayed code. The step is consumed even if the open is then refused.
2. One transaction: the school (`404` unknown; `409 SCHOOL_TERMINATED`); every open-but-expired row
   of this school or this caller is expired (§2.4) before anything is counted; then
   `409 SUPPORT_SESSION_OPEN { sessionId }` if the school has an open session,
   `409 SUPPORT_SESSION_LIMIT` at three open for the caller (the database refuses both too);
   insert with `expires_at = opened_at + support_session_hours`; mint the `SchoolId` from the new
   row; write both audit logs (`support_session.opened`, reason, `{ ticketRef, expiresAt }`) and
   `support_session_opened` to every active principal (no principal: no message, the platform row
   says `principalsNotified: 0`, the session still opens).

### 2.2 Reads (rule 35, R350, R351)

`SupportViewsService.read`: one interactive transaction opened by `SupportReadContext.run` —
nested CLS context, `SET TRANSACTION READ ONLY`, then `support: true` — in which the session is read
again (`findOpenOwned`: open, unexpired, owned), the `SchoolId` minted from it, and the view read
through `SupportReadsRepository`. After it commits, a second transaction writes `support.read` to
`platform_audit_log` and the school's `audit_log` (subject `support_session/<id>`, actor the
platform user, metadata `{ view, ids, … }`, the subject ids as comma-separated strings: metadata
holds no arrays). If that write fails, nothing is served. Lists are at most 50 rows.

The views select no CNIC, B-Form, hash, object key, message, document, slip, payroll or staff
identity column; guardian phones are the only contact data (the plan's "guardian names and phones").

### 2.3 Close, revoke, logout

Close (owner) and revoke (the school, `school.settings.manage`) set `closed_at` with `end_kind`
`closed` / `revoked` (revoke also `revoked_at = closed_at`, `revoked_by`, `revoke_reason`), both
by a conditional update (a lost race reads the winner's end and answers `403
SUPPORT_SESSION_ENDED { reason }`, close and revoke alike, writing nothing). Both write both
audit logs and send `support_session_closed` (`how: closed | revoked`). Platform logout closes the
caller's open sessions first (`support_session.closed`, metadata `{ via: 'logout' }`) and only then
revokes the platform session, so a failing close leaves the user signed in to retry. None of these run
with `support: true`. The revoked session answers `403 SUPPORT_SESSION_ENDED { reason: revoked }`
on its next read.

### 2.4 Expiry

`support-session-expire` (every 5 minutes, scheduled queue): `JobRunner.eachSchool` (exception 3)
runs `SupportSessionExpiry.run(schoolId)` in `runAsSchool` for every live school: each open row of
that school past `expires_at` is closed `expired` (`closed_at` = the time of the write, the
update's filter `expires_at ≤ min(now, that time)`, so `closed_at ≥ expires_at`), both logs written
(`support_session.expired`, metadata `{ job }`) and `support_session_closed` (`how: expired`) sent.
The open flow (§2.1) expires stale rows the same way.

### 2.5 Messages

Subject `support_session`, id `sessionId × 10 + 1` (opened) or `+ 2` (closed): `messages` is unique
per person per subject regardless of type, so the two notices of one session need two subjects (the
contract-warning precedent). In-app and email, push title-only, never SMS (groundwork table).

## 3. Read-only in three layers (R350)

1. **Database:** the read transaction is `SET TRANSACTION READ ONLY` (`ChangeContextRepository.readOnly`,
   in `RAW_SQL_FILES` already); Postgres refuses any write with SQLSTATE 25006.
2. **Query guard:** with `support: true` in the CLS store (`tenancy/support-flag.ts`), any model
   operation other than `findFirst(OrThrow)`, `findUnique(OrThrow)`, `findMany`, `count`,
   `aggregate`, `groupBy`, and every model-free operation (`$queryRaw` included, fix round: a raw
   statement is opaque to the guard), throws `SupportWriteRefusedError`. Both refusals leave as
   `403 SUPPORT_WRITE_REFUSED`.
3. **Lint:** `src/modules/platform/support/**` imports no repository except the two support
   repositories and no `school-id.mint` constructor except `schoolIdFromSupportSession`
   (`support-sessions.service.ts` alone also `schoolIdFromExpiredSupportSession`, §4); the two
   repositories are importable nowhere else in `src/`.

## 4. Deviations and decisions to confirm

- **The constructors' input** (records the tenancy text): `schoolIdFromSupportSession` takes a
  `SupportSessionRecord`, a brand only `SupportSessionRepository` applies, to an open, unexpired
  row owned by the calling platform user (`findOpenOwned`, `findOpenOwnedAll`, `insertOpen`). A row
  `expireDue`'s own conditional update has just closed as expired carries a separate brand,
  `ExpiredSupportSessionRecord` (fix round), minted into a `SchoolId` only by
  `schoolIdFromExpiredSupportSession`, importable only from `support-sessions.service.ts`, and used
  only for that expiry's two audit rows and its notice (the open flow and the job). A support view
  can neither import that constructor (lint fixture `expired-support-mint-import.ts`) nor pass an
  expired row to `schoolIdFromSupportSession` (the brands differ). Never a row read by id alone.
- **School-side audit and principals.** The support module may import only its two repositories,
  so `SupportSessionRepository` writes both audit rows (`recordBoth`) and reads the active
  principals' staff ids (the same predicate as `MessageRecipientRepository.activePrincipalStaffIds`).
- **The platform log row of a revoke and an expiry** names the session's platform user as actor
  (`platform_audit_log_actor_check` admits no actorless row here, and no migration), with
  `{ by: 'school', revokedByUserId }` or `{ job }`.
- **"Principal" routes** use `school.settings.manage` (principal-only by default, grantable),
  following rule 13's `can(capability)` over a role check.
- **The audit-log view** reuses `AuditReadsRepository.page` (injected into `SupportReadsRepository`,
  a recorded lint widening) and slice 46's `auditFilterOf` and `toAuditEntryDto`.
- **Platform list and get** show every admin's sessions (oversight); views and close are owner-only.
- **No support read of messages** (item 41 stands).
