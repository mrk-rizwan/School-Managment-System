# Slice 1 contracts — platform admin and the school record

**Author:** api-designer, 2026-10-02. **Binds:** `apps/api/src/modules/platform/**`, the platform
OpenAPI document, `apps/web/app/platform/**`. **Sources:** `CLAUDE.md` (conventions, named
exception 1), `phase-1-foundation.md` §3.5, §3.6, §3.9, §4, §5 slice 1, R56, R65, R67, R68, R102.
Everything not restated here follows §3.9 unchanged: envelope, `422 VALIDATION_FAILED` with
`details.fields`, string ids, camelCase, UTC ISO datetimes with `Z`, `Cache-Control: no-store`,
`NoQueryDto` on every handler without a query, `@ApiErrors()` on every route.

All paths below are under `/api/v1/platform`.

---

## 1. Access: how platform routes are declared

`RouteAccessGuard` today requires exactly one of `@Public`, `@AuthenticatedOnly`,
`@RequireCapability`. Slice 1 adds a fourth and the guard requires **exactly one of four**:

```ts
@PlatformSession(level: 'full' | 'password-change' | 'any' = 'full')
```

| Level | Session stage required | `mustChangePassword = true` allowed | Used by |
|---|---|---|---|
| `full` | `full` | no → `403 PASSWORD_CHANGE_REQUIRED` | every schools route |
| `password-change` | `full` | yes | `POST /auth/change-password` |
| `any` | `totp_enrolment` or `full` | yes | `GET /me`, `POST /auth/logout`, `POST /auth/totp/enrol`, `POST /auth/totp/confirm` |

A live `totp_enrolment` session on a `full` or `password-change` route → `403 TOTP_REQUIRED`.
`POST /auth/login` is `@Public()`. Platform controllers use no other decorator.

**Resolution order on every platform request:** Origin check (non-GET; Express middleware, so it
runs first and a refused cross-origin request is never counted by a throttle) → throttler → access
guard → validation pipe → handler. (Amended 2026-10-02 to match the implementation; the earlier
order put the throttler first, which bought nothing.) The access guard, for `@PlatformSession`: refuse if an
`Authorization` header is present (`401 AUTH_REQUIRED`; the platform API accepts no bearer) →
read cookie `__Host-asms_platform` only → SHA-256 → `platform_sessions` by `token_hash` → refuse
(`401 AUTH_REQUIRED`) if absent, revoked, past `expires_at`, idle past the limit, or user not
`active` → stage check → password gate. The guard never reads `__Host-asms_session`.

**R56, both ways, by construction and by test:**
- Platform side (slice 1): platform resolution reads only `__Host-asms_platform` and only
  `platform_sessions`. Tests: a request carrying only a school-shaped cookie, or a bearer, or a
  school session token placed in the platform cookie, gets `401` on `GET /platform/me`.
- School side (completed in slice 2): school resolution runs only for `@AuthenticatedOnly` /
  `@RequireCapability` routes, reads only `__Host-asms_session` / bearer and only `sessions`.
  Slice 2 adds the test: a valid platform cookie on a school route is `401`.
- Route snapshot (extends R68): every controller under `modules/platform` has path prefix
  `platform/` and every route carries `@PlatformSession` or `@Public`; no route outside that
  module carries `@PlatformSession`; the only `@Public` platform route is `POST /auth/login`.
- OpenAPI: the platform document `include: [PlatformModule]`; the school document excludes it.

**Origin (R65 for platform).** Every non-GET under `/platform`, **including login**, must carry
`Origin` exactly equal to the origin of `APP_URL`; missing or different → `403 ORIGIN_REJECTED`.

---

## 2. Sessions

| Item | Value |
|---|---|
| Cookie | `__Host-asms_platform=<token>; HttpOnly; Secure; SameSite=Strict; Path=/`. No `Domain`, no `Max-Age` (browser-session cookie; the server enforces expiry). Never in a JSON body |
| Token | 32 random bytes, base64url; only SHA-256 hex stored in `platform_sessions.token_hash` |
| Stage `totp_enrolment` | Minted when the password is right and TOTP is not enrolled. **Absolute 10 minutes**, no idle extension |
| Stage `full` | **Idle 2 hours, absolute 12 hours.** Shorter than school sessions (§3.5: 24 h / 30 d) because one platform login opens every school |
| `last_seen_at` | Written at most once per 5 minutes, outside the request transaction |
| Rotation | Login, TOTP confirm and change-password each mint a new token and revoke the presented session (fixation defence) |
| Logout | Revokes the presented session, clears the cookie (`Max-Age=0`) |

Columns this contract relies on (for `data-architect`): `platform_users.email` (stored
lower-cased, unique), `password_hash`, `totp_secret` (encrypted, AAD `platform|platform_users|
totp_secret|<platform_user_id>`, so a secret copied to another row fails to decrypt), `totp_enrolled_at` nullable, `totp_last_step` bigint nullable,
`must_change_password`, `password_changed_at` nullable, `status` (`active|disabled`),
`last_login_at`. `platform_sessions`: `platform_user_id`, `token_hash UNIQUE`, `stage`,
`created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `user_agent`, `ip`.
`platform_audit_log.actor_platform_user_id` nullable (the seed has no actor).

---

## 3. Auth endpoints

### 3.1 `POST /auth/login` — `@Public()`

**One request carries email, password and, once enrolled, the TOTP code.** A two-step flow
would answer "password correct, now the code" (a password oracle) and needs a second pre-auth
state. Here every wrong combination looks the same.

| Field | Type | Rules |
|---|---|---|
| `email` | string, required | trim, lower-case, then `IsEmail`, 3–254 |
| `password` | string, required | 1–128 (no policy at login) |
| `totpCode` | string, optional | `^[0-9]{6}$` |

Behaviour, in order:
1. Throttles (Redis): **5/min per email+IP, 10/min per email, 30/min per IP** → `429
   RATE_LIMITED` with `Retry-After`, whether or not the account exists. Email is keyed by its
   SHA-256, never in clear. Redis unreachable → `503 SERVICE_UNAVAILABLE`, never evaluated
   without the counters.
2. Lockout: 5 consecutive failures for an email → locked 15 minutes. During a lock, correct
   credentials still get `AUTH_FAILED` and do not clear it. A success resets the counter.
3. User by email; if absent, a dummy argon2 verify so timing matches.
4. Success requires: user exists, `status = active`, password verifies, not locked, and **if
   `totp_enrolled_at` is set**, `totpCode` present, valid (SHA-1, 6 digits, 30 s, ±1 step) and
   its step `> totp_last_step`. On success `totp_last_step` is updated (replay refused).
5. Any failure → `401 AUTH_FAILED`, message "Email, password or code is incorrect.", counted
   toward the lockout.
6. If not enrolled, `totpCode` is ignored and a `totp_enrolment` session is minted. If enrolled,
   a `full` session. Any session presented with the request is revoked.

**200** `PlatformMeDto` + `Set-Cookie`. Audit `platform_user.login` (metadata `{ stage }`).
Errors: `403 ORIGIN_REJECTED` · `422 VALIDATION_FAILED` · `401 AUTH_FAILED` · `429` · `503`.

### 3.2 `GET /me` — `@PlatformSession('any')`, `NoQueryDto`

**200** `PlatformMeDto`:

| Field | Type |
|---|---|
| `id` | string |
| `email` | string |
| `sessionStage` | enum `PlatformSessionStage`: `totp_enrolment` \| `full` |
| `totpEnrolled` | boolean |
| `mustChangePassword` | boolean |
| `sessionExpiresAt` | datetime (the absolute expiry) |

Errors: `401 AUTH_REQUIRED`.

### 3.3 `POST /auth/logout` — `@PlatformSession('any')`, empty body

**204**, cookie cleared. Errors: `401 AUTH_REQUIRED` (a retried logout; the client treats it as
logged out) · `403 ORIGIN_REJECTED`. No audit row.

### 3.4 `POST /auth/totp/enrol` — `@PlatformSession('any')`, empty body

Generates a 20-byte secret, stores it encrypted in `totp_secret` with `totp_enrolled_at` left
null. Calling again replaces the pending secret.

**200** `{ otpauthUri: string, secret: string }` — `secret` is base32, for manual entry. URI:
`otpauth://totp/ASMS%20Platform:<email>?secret=<b32>&issuer=ASMS%20Platform&algorithm=SHA1&digits=6&period=30`.
No `example` in OpenAPI; never logged.

Errors: `401` · `403 ORIGIN_REJECTED` · `409 TOTP_ALREADY_ENROLLED` (user already enrolled — so
a full session cannot re-enrol). No audit row (nothing is committed until confirm).

### 3.5 `POST /auth/totp/confirm` — `@PlatformSession('any')`

| Field | Type | Rules |
|---|---|---|
| `code` | string, required | `^[0-9]{6}$` |

Verifies against the pending secret (same algorithm and replay rule as login). On success:
`totp_enrolled_at = now`, `totp_last_step` set, the `totp_enrolment` session revoked and a
`full` session minted. **200** `PlatformMeDto` + `Set-Cookie`. Audit `platform_user.totp_enrolled`.

Throttle 5/min per session. Errors: `401` · `403 ORIGIN_REJECTED` · `422` · `409
TOTP_NOT_ENROLLED` (no pending secret: enrol not called) · `409 TOTP_ALREADY_ENROLLED` · `409
TOTP_INVALID` (wrong or replayed code) · `429`.

TOTP reset (lost device) has no endpoint in v1; it is an operator script outside this contract.

### 3.6 `POST /auth/change-password` — `@PlatformSession('password-change')`

| Field | Type | Rules |
|---|---|---|
| `currentPassword` | string, required | 1–128 |
| `newPassword` | string, required | 12–128 characters; must differ from `currentPassword` (`422 INVALID_VALUE` on `newPassword`) |

On success, in one transaction with the user row locked: new hash, `must_change_password =
false`, `password_changed_at = now`, **all the user's other platform sessions revoked**, this
session rotated. **200** `PlatformMeDto` + `Set-Cookie`. Audit `platform_user.password_changed`.

Throttle 5/min per session. Errors: `401` · `403 TOTP_REQUIRED` · `403 ORIGIN_REJECTED` · `422` ·
`409 CURRENT_PASSWORD_INCORRECT` (not `401`, which would read as a dead session) · `429`.

---

## 4. Schools

`SchoolDto` (every schools route returns this shape):

| Field | Type |
|---|---|
| `id` | string |
| `name` | string |
| `shortCode` | string |
| `status` | enum `SchoolStatus`: `trial` \| `active` \| `suspended` \| `terminated` |
| `timezone` | string (IANA) |
| `createdAt`, `updatedAt` | datetime |

**`SchoolDto` carries no settings.** Exception 1 lets the platform act inside a school for
exactly two operations; creating the school is one, reading or editing `school_settings`
afterwards is not. `feeDueDay` is set once at creation; after that it belongs to the principal
(`PATCH /school/settings`, slice 2). `schoolGroupId` is not in v1 (no group endpoints exist);
adding it later is additive.

All schools routes: `@PlatformSession()` (level `full`). Common errors on every one: `401
AUTH_REQUIRED` · `403 TOTP_REQUIRED` · `403 PASSWORD_CHANGE_REQUIRED` · `403 ORIGIN_REJECTED`
(non-GET) · `429`.

### 4.1 `GET /schools` — paginated

Query DTO extends `PageQueryDto`:

| Param | Rules |
|---|---|
| `page`, `limit` | as `PageQueryDto` (1–999999; 1–50, default 25); out of range `422` |
| `status` | optional, one `SchoolStatus` value |
| `q` | optional, trimmed, 2–100 chars; a run of 13 digits → `422`. Matches `name ILIKE '%q%'` **or** `short_code LIKE lower(q) || '%'`, with `%` `_` `\` escaped |
| `sort` | optional, one of `name`, `-name`, `shortCode`, `-shortCode`, `status`, `-status`, `createdAt`, `-createdAt`; default `name`; `id` ascending as tiebreak; anything else `422` |

**200** `{ data: SchoolDto[], page, limit, total }` (`@ApiPaginated(SchoolDto)`).

### 4.2 `POST /schools` — create

| Field | Type | Rules |
|---|---|---|
| `name` | string, required | trimmed, 2–200, no control characters |
| `shortCode` | string, required | trimmed and lower-cased, then `^[a-z0-9]{3,12}$` |
| `timezone` | string, optional | default `Asia/Karachi`; must be in `Intl.supportedValuesOf('timeZone')` (a `Set` built once at boot) |
| `feeDueDay` | integer, optional | JSON number, `IsInt`, 1–28; default 10 |

One `@Transactional()` unit: insert `schools` (status always `trial`); mint the id through
`SchoolId.fromPlatformSchool`; insert `school_settings` (`fee_due_day`, `student_login_enabled =
false`); insert `school_counters (name = 'admission_no', value = 0)`; write the audit row.

**201** `SchoolDto`. Audit `school.created`, `school_id` = new id, metadata `{ shortCode, name,
timezone, feeDueDay }`.

Errors: `422 VALIDATION_FAILED` (including `feeDueDay` 29) · `409 SCHOOL_SHORT_CODE_TAKEN`
(mapped from constraint `schools_short_code_key`; `details: { field: 'shortCode' }`).

Retry-safety: `shortCode` is the natural idempotency key. A double-submit creates one school; the
second gets `409 SCHOOL_SHORT_CODE_TAKEN`, and the web, on that code after a timed-out first
attempt, offers to open the existing school found by `GET /schools?q=<shortCode>`.

### 4.3 `GET /schools/:id`

`@IdParam()` + `@ApiIdParam()`, `NoQueryDto`. **200** `SchoolDto`. Errors: `404 NOT_FOUND`
(absent or malformed id).

### 4.4 `PATCH /schools/:id` — plain attributes

| Field | Type | Rules |
|---|---|---|
| `name` | string, optional | as create; `null` → `422` |
| `timezone` | string, optional | as create; `null` → `422` |
| `shortCode` | any, optional | **declared only to be refused**: present with any value → `409 SCHOOL_SHORT_CODE_IMMUTABLE`. The database trigger raises the same code as a second line |

`status` is not declared (→ `422 UNKNOWN_FIELD`); status changes only through 4.5. An empty body
is a no-op: `200`, no audit row.

**200** `SchoolDto`. Audit `school.updated`, metadata `{ changes: { <field>: { from, to } } }`
for fields whose value actually changed (none changed → no row).

Errors: `404` · `422` · `409 SCHOOL_SHORT_CODE_IMMUTABLE` · `409 SCHOOL_TERMINATED` (terminated
is final; its record is frozen).

### 4.5 `POST /schools/:id/change-status`

| Field | Type | Rules |
|---|---|---|
| `status` | enum, required | `active` \| `suspended` \| `terminated` (`trial` is never a target) |
| `reason` | string, required | trimmed, 3–500; an identity-number pattern (dashed or 13 digits) → `422` |

**Transition table** (exported from `packages/shared` as `SCHOOL_STATUS_TRANSITIONS`, used by the
service and the web dialog — declared once):

| From \ To | active | suspended | terminated |
|---|---|---|---|
| `trial` | yes | yes | yes |
| `active` | — | yes | yes |
| `suspended` | yes | — | yes |
| `terminated` | no | no | no |

Nothing returns to `trial`. `trial → suspended` is kept: a trial school that stops paying is
frozen read-only before a decision to terminate.

The school row is locked `FOR UPDATE` and the transition checked under the lock. **Target equal
to current status → `200`, unchanged, no audit row** (a double-submitted dialog is harmless).
Otherwise update `status`, audit `school.status_changed` with `reason` and metadata `{ from, to }`.

Effect is read at request time by school session resolution (§3.5): `suspended` → read-only
(R80), `terminated` → every school session refused. **The platform does not revoke school
sessions** — that would be a third operation inside a school.

**200** `SchoolDto`. Errors: `404` · `422` · `409 ILLEGAL_STATUS_TRANSITION`
(`details: { from, to }`).

---

## 5. Error codes added to `packages/shared/src/error-codes.ts`

| Code | Status | Where |
|---|---|---|
| `PASSWORD_CHANGE_REQUIRED` | 403 | any `full`-level route while `mustChangePassword` |
| `TOTP_REQUIRED` | 403 | enrolment-stage session on a non-`any` route |
| `TOTP_NOT_ENROLLED` | 409 | confirm with no pending secret |
| `TOTP_ALREADY_ENROLLED` | 409 | enrol or confirm after enrolment |
| `TOTP_INVALID` | 409 | confirm with a wrong or replayed code |
| `CURRENT_PASSWORD_INCORRECT` | 409 | change-password (slice 2's `/me/change-password` reuses it) |
| `SCHOOL_SHORT_CODE_TAKEN` | 409 | create |
| `SCHOOL_SHORT_CODE_IMMUTABLE` | 409 | patch; also the trigger's named constraint |
| `SCHOOL_TERMINATED` | 409 | patch of a terminated school |
| `CONCURRENT_UPDATE` | 409 | patch that lost three retries to concurrent edits; reload and retry (added 2026-10-03) |
| `ILLEGAL_STATUS_TRANSITION` | 409 | change-status |

Login never uses the TOTP codes: wrong code at login is `401 AUTH_FAILED` like everything else.
The constraint-name → code mapper (§3.8) does not exist yet; slice 1 builds it with these two
entries: `schools_short_code_key` → `SCHOOL_SHORT_CODE_TAKEN`, the immutability trigger's
constraint name → `SCHOOL_SHORT_CODE_IMMUTABLE`.

---

## 6. Platform audit actions

| Action | `school_id` | Actor | `reason` | Metadata |
|---|---|---|---|---|
| `platform_user.seeded` | null | null | null | `{}` |
| `platform_user.login` | null | user | null | `{ stage }` |
| `platform_user.totp_enrolled` | null | user | null | `{}` |
| `platform_user.password_changed` | null | user | null | `{}` |
| `school.created` | new id | user | null | `{ shortCode, name, timezone, feeDueDay }` |
| `school.updated` | id | user | null | `{ changes }` |
| `school.status_changed` | id | user | required | `{ from, to }` |

Written inside the same transaction as the change. Email is not repeated in metadata (the actor
id identifies the user). Failed logins are not audited; they are throttled, locked and logged.

---

## 7. Seed

Script `apps/api` → `pnpm --filter api seed:platform-admin`. Reads `PLATFORM_ADMIN_EMAIL` and
`PLATFORM_ADMIN_PASSWORD` (both also validated at API boot per `WORKLOG` carry-over 7: email
format; password 12–128). Email trimmed and lower-cased.

- `INSERT … ON CONFLICT (email) DO NOTHING` with `must_change_password = true`, `status =
  active`, no TOTP, password hashed per §3.6. If inserted, audit `platform_user.seeded`.
- **Idempotent:** an existing user with that email is untouched — password, TOTP and status are
  not reset. Exit 0 either way, printing `created` or `exists` (never the email or password).
- Running it with a different email creates a second admin; that is the documented way to add one
  in Phase 1.

First sign-in therefore runs: login (password only) → enrol → confirm → change password → schools.

---

## 8. Web screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| Platform layout (`app/platform`) | `GET /me` on load | `401` → `/platform/login`; `sessionStage = totp_enrolment` → `/platform/enrol`; `mustChangePassword` → `/platform/change-password`. Any later `403 TOTP_REQUIRED` / `PASSWORD_CHANGE_REQUIRED` redirects the same way |
| `/platform/login` | `POST /auth/login` | Fields email, password, code (labelled "Authenticator code — leave blank on first sign-in"). Routes on the returned `PlatformMeDto` as above, else `/platform/schools`. Shows the one generic message on `401`; `429` shows the wait from `Retry-After` |
| `/platform/enrol` | `POST /auth/totp/enrol`, `POST /auth/totp/confirm`, `POST /auth/logout` | Enrol on a "Set up authenticator" button press, not on mount (React Strict Mode would mint two secrets). QR rendered **in the browser** from `otpauthUri` with a bundled library; no external QR service, URI never logged or stored. Secret shown in groups of four for manual entry. Code field → confirm; `TOTP_INVALID` on the field |
| `/platform/change-password` | `POST /auth/change-password` | current, new, confirm-new (confirm is client-only). `CURRENT_PASSWORD_INCORRECT` on the current field |
| Schools list | `GET /schools` | Shared table; `status` select, `q` search (≥ 2 chars, debounced), sortable columns as the allowlist, page/limit. Loading, empty, error states |
| Create school | `POST /schools` | Name, short code (hint: 3–12 lower-case letters or digits; cannot be changed later), timezone select (options from `Intl.supportedValuesOf` in the browser, default `Asia/Karachi`), fee due day 1–28 default 10. Field errors from `details.fields`; `SCHOOL_SHORT_CODE_TAKEN` on the short code field |
| School detail / edit | `GET /schools/:id`, `PATCH /schools/:id` | Name and timezone editable; short code read-only text, never sent. Terminated school: form disabled |
| Status dialog | `POST /schools/:id/change-status` | Shared confirm-with-reason dialog. Target options from `SCHOOL_STATUS_TRANSITIONS[current]`; hidden for `terminated`. Terminate needs a second confirmation stating it is final |
| Sign out | `POST /auth/logout` | Then `/platform/login`, query cache cleared |

---

## Decisions made here

1. One-step login; every failure is `401 AUTH_FAILED`; enrolment is the only pre-auth state.
2. A fourth access decorator, `@PlatformSession(level)`; the guard requires exactly one of four.
3. First sign-in enrols TOTP before changing the password, so the change sits behind the second
   factor.
4. Platform sessions: enrolment 10 min; full idle 2 h, absolute 12 h; `SameSite=Strict`; token
   rotates on login, TOTP confirm and password change.
5. Origin check on every platform non-GET, login included.
6. The platform never reads or edits `school_settings` after creation; `feeDueDay` is create-only.
   No `schoolGroupId` in v1.
7. Schools start `trial`; same-status change is a `200` no-op; terminated schools are frozen.
8. `shortCode` is lower-cased before validation and declared in PATCH only to be refused.
9. Non-session refusals (`TOTP_INVALID`, `CURRENT_PASSWORD_INCORRECT`) are `409`, never `401`.
10. TOTP replay refused via the last accepted step; lost-device recovery is an operator script.
11. Platform passwords 12–128 characters.
