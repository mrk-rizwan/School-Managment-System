# Slice 2 contracts — school login, sessions, users, settings

**Author:** api-designer, 2026-10-03. **Binds:** `apps/api/src/modules/{auth,me,users,school-settings}/**`,
`src/tenancy/school-session-resolver.ts`, `common/auth/route-access.ts`, the platform
issue-principal-login route, `apps/web/app/(school)/**` auth screens. **Sources:** `CLAUDE.md`
(rules 2, 12, 13; named exceptions 1, 2, 4), plan §3.4–§3.6, §3.9, §5 slice 2, §7, R1–R16,
R61–R72, R80–R81, R93, R98–R100, R103. Everything not restated follows §3.9 and `slice-1.md`
unchanged (envelope, `422 VALIDATION_FAILED`, string ids, camelCase, `NoQueryDto`, `@ApiErrors()`).
School paths are under `/api/v1`.

---

## 1. Access decorators and school session resolution

The guard requires **exactly one of five** (slice 2 owns `route-access.ts`; slices 3 and 5 code
against these signatures):

| Decorator | Meaning | Snapshot (R68) |
|---|---|---|
| `@Public()` | no session | yes |
| `@AuthenticatedOnly()` | any live school session | yes — **only** `/auth/logout`, `/me`, `/me/*` |
| `@RequireStaff()` | live session with an active staff capacity, no capability | yes |
| `@RequireCapability(...caps: [Capability, ...Capability[]])` | holds **any** of the listed keys | no |
| `@PlatformSession(level)` | slice 1 | — |

`@RequireStaff()` exists because R78 enumerates the router: a parent-only or student-only
session must get `403` on everything outside `/auth/*` and `/me/*`, so staff-wide reads cannot be
`@AuthenticatedOnly`. Marker `@AllowWhenSuspended()` (§1.3) is metadata, not an access rule.

### 1.1 Resolution (named exception 4)

`SchoolSessionResolver` lives in `src/tenancy/` (the only place `SessionEstablisher` may be
imported), exported by `TenancyModule`, called by `RouteAccessGuard` for the three school
decorators. It never reads `__Host-asms_platform` or `platform_sessions` (R56).

1. `Authorization: Bearer <t>` and cookie `__Host-asms_session` both present → `401
   AUTH_REQUIRED`. Neither → `401`. Bearer value must match `^[A-Za-z0-9_-]{43}$`.
2. SHA-256 → `SessionRepository.findActiveByTokenHash(hash)` → `{ id, schoolId, userId, channel,
   expiresAt, lastSeenAt }` where `revoked_at IS NULL AND expires_at > now()`. Absent, idle
   (`last_seen_at + 24 h <= now`), or `channel` ≠ the channel presented → `401` (R64).
3. `schoolIdFromSession(row)`; then, scoped: school via `OwnSchoolRepository` — `terminated` →
   `401`; user — `status ≠ active` → `401`; **no active capacity** → `401` (R71).
4. `SessionEstablisher.establishSession({ schoolId, userId, sessionId })`.
5. `last_seen_at` refreshed if older than 5 minutes, outside any transaction.
6. Suspended school and non-GET without `@AllowWhenSuspended` → `403 SCHOOL_SUSPENDED` (§1.3).
7. `@RequireStaff` → no staff capacity → `403 PERMISSION_DENIED`. `@RequireCapability` →
   `PermissionsService.can()` for each listed key, any success passes, else `403
   PERMISSION_DENIED`. The `Scope` is computed by the service when it needs one, not by the guard.

**Capacity** (one predicate, `PermissionsService.capacities(user)`):
- *staff*: `users.staff_id` set, `staff.status = active`, at least one live `user_roles` row;
- *guardian*: `users.guardian_id` set (plan §6 stance);
- *student*: `users.student_id` set and `school_settings.student_login_enabled` (slice 6 wires it).

Effective capabilities in slice 2 = union of `SYSTEM_ROLE_DEFAULTS` of live system-role rows,
only while staff capacity holds; computed per request, never cached (R69).

### 1.2 Cookie and bearer

| Item | Value |
|---|---|
| Cookie | `__Host-asms_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<seconds to expires_at>`. Never in a JSON body |
| Token | 32 random bytes base64url; only SHA-256 hex in `sessions.token_hash` |
| Lifetime | idle 24 h, absolute 30 days |
| Channel | slice 2 mints `cookie` only. The resolver implements the `bearer` branch now (tests insert bearer rows directly); the mobile login that mints one is Phase 2 |
| Rotation | login, change-password and reset revoke as stated per endpoint |

**Origin (R65).** Slice 2 extends `originCheck`: every non-GET **without an `Authorization`
header** must carry `Origin` equal to `APP_URL`'s origin — this covers the public auth routes
(login CSRF) as well as cookie-carrying requests. Bearer requests are not Origin-checked.

### 1.3 Suspended school (R80)

`@AllowWhenSuspended()` on exactly: `POST /auth/logout`, `POST /me/change-email`, `POST
/me/change-password`, `POST /users/:id/disable`, `POST /users/:id/reset-password`. Public auth
routes resolve no session and are unaffected. A router-enumeration test asserts this set exactly.

---

## 2. Shared helpers (slice 2 writes them; slices 4–6 import)

- `packages/shared/src/identity.ts`: `normaliseIdentityDigits(input)` strips `-` and spaces, then
  must match `^[0-9]{13}$` or returns `null`; `IDENTITY_INPUT_PATTERN = /^[0-9]{5}-?[0-9]{7}-?[0-9]$/`;
  `containsIdentityNumber(text)` for free-text rejection.
- `packages/shared/src/phone.ts`: `normalisePhone(input)` strips spaces, `-`, `(`, `)`; `00…` →
  `+…`; `03XXXXXXXXX` (11 digits) → `+923XXXXXXXXX`; `3XXXXXXXXX` (10) → `+92…`;
  `92XXXXXXXXXX` (12) → `+92…`; result must match `^\+[1-9][0-9]{7,14}$`, else `null` (→ `422
  INVALID_VALUE` on the field).
- `apps/api/src/common/identity.ts`: `identityHash(digits)` (HMAC-SHA256, `IDENTITY_HASH_KEY`),
  `maskIdentityNumber(digits)` → `35201-*****-1`.

---

## 3. Auth (`/auth`)

### 3.1 `POST /auth/login` — `@Public()`

| Field | Rules |
|---|---|
| `schoolCode` | string, required; trim, lower-case, `^[a-z0-9]{3,12}$` |
| `username` | string, required; `IDENTITY_INPUT_PATTERN`, normalised to 13 digits |
| `password` | string, required, 1–128 |

1. Throttles (Redis, before validation, from the raw body normalised the same way; unparseable →
   keyed `''`): **5/min per `code:usernameHash:ip`, 10/min per `usernameHash` (all schools),
   30/min per IP** → `429 RATE_LIMITED` + `Retry-After`. `usernameHash = identityHash(digits)`.
2. Lockout keyed `${typedCode}:${usernameHash}` (typed, so absent schools and users lock
   identically): 5 consecutive failures → 15 min. During a lock a correct password is
   `AUTH_FAILED` and does not clear it. Redis unreachable at any step → `503
   SERVICE_UNAVAILABLE` (R81).
3. `SchoolLookupRepository.findByCode` (exception 2); user by `(schoolId, usernameHash)`; argon2
   verify, or a dummy verify if school or user is absent.
4. Success requires school present and not `terminated`, user `active`, an active capacity,
   password verifies, not locked. Anything else → `401 AUTH_FAILED` "School code, username or
   password is incorrect.", counted — identical status, body and headers (R11).
5. On success: lockout count reset; presented session revoked; new `cookie` session; `last_login_at
   = now`. If `office_reset_at IS NOT NULL AND (last_login_at IS NULL OR last_login_at <
   office_reset_at)` (read before the update) → audit `user.login_after_office_reset`.
6. **Spray detection:** per-school failure counter (resolved schools only), 10-minute window;
   at 50 failures write one `login_failure_spike` row to `platform_audit_log` (`school_id`,
   metadata `{ failures, windowStartedAt }`) — once per window. The login service file is added
   to the lint allowlist for `PlatformAuditRepository` as an exception-2 site.

**200** `MeDto` + `Set-Cookie`. Suspended schools may log in (read-only follows).
Errors: `403 ORIGIN_REJECTED` · `422` · `401 AUTH_FAILED` · `429` · `503`.

### 3.2 `POST /auth/logout` — `@AuthenticatedOnly()`, `@AllowWhenSuspended()`, empty body

Revokes the presented session; clears the cookie (`Max-Age=0`). **204**. Errors: `401`, `403
ORIGIN_REJECTED`.

### 3.3 `POST /auth/forgot-password` — `@Public()`

| Field | Rules |
|---|---|
| `schoolCode`, `username` | as login |

Throttle **3/hour per `typedCode:usernameHash`**, 30/min per IP. **202** `{}` always (R2), sent
before any lookup; the work runs after the response: school (exception 2, not `terminated`) →
user `active` with `email_verified_at` set (R3) → void the user's unused reset tokens
(`expires_at = now()`) → insert `user_tokens(purpose = password_reset, token_hash, expires_at =
now + 15 min)` → mail `${APP_URL}/reset/${shortCode}#token=${token}`. No email is ever accepted.
Errors: `403 ORIGIN_REJECTED` · `422` · `429` · `503`.

### 3.4 `POST /auth/reset-password` — `@Public()`

| Field | Rules |
|---|---|
| `schoolCode` | as login |
| `token` | `^[A-Za-z0-9_-]{43}$` |
| `newPassword` | 8–128; not the username digits (checked by `identityHash(newPassword) ≠ username_hash` when it is 13 digits) → `422 INVALID_VALUE` on `newPassword` |

Throttle 10/min per IP. School by code (absent or terminated → `TOKEN_INVALID`). One
`@Transactional()`: consume by conditional update (`used_at IS NULL AND expires_at > now()`,
`purpose = password_reset`, `school_id`) `RETURNING user_id`; lock user row; re-check `active`
(R100) — any miss → `409 TOKEN_INVALID`. Set hash, `password_is_default = false`,
`password_changed_at = now`, revoke **all** sessions, void other tokens. After commit: clear the
lockout (key `${shortCode}:${username_hash}`) and mail a notice. **204**. Audit
`user.password_reset_by_token`. A token from school A sent with school B's code finds no row.

### 3.5 `POST /auth/verify-email` — `@Public()`

`{ schoolCode, token }` as above. Throttle 10/min per IP. Consume `purpose = email_verify`; lock
user; require `active` and `users.email = user_tokens.email` (bound to the issued address) —
else `409 TOKEN_INVALID`. Set `email_verified_at = now`. **204**. Audit `user.email_verified`.

Verify tokens live **24 hours**. Links: `${APP_URL}/verify-email/${shortCode}#token=${token}`.
Both pages read the fragment, `history.replaceState` it away, act only on a button press, POST the
token in the body, and send `Referrer-Policy: no-referrer`.

---

## 4. Me (`/me`) — `@AuthenticatedOnly()`

### 4.1 `GET /me` — `NoQueryDto`

`MeDto`:

| Field | Type |
|---|---|
| `id` | string |
| `fullName` | string (staff → guardian → student, first present) |
| `email` | string \| null (unmasked: it is the caller's own) |
| `hasVerifiedEmail` | boolean |
| `passwordIsDefault` | boolean |
| `school` | `{ id, name, shortCode, status }` |
| `roles` | `SchoolRole[]` — enum `principal \| office_staff \| teacher \| parent \| student`, from active capacities |
| `capabilities` | `Capability[]`, sorted; empty for parent/student |
| `sessionExpiresAt` | datetime |

No username or identity number is ever returned. `customRoles` arrives in slice 7 (additive).

### 4.2 `POST /me/change-email` — `@AllowWhenSuspended()`

`{ currentPassword: 1–128, email: trim, lower-case, IsEmail, 3–254 }`. Throttle 5/min per
session. Lock user row; wrong password → `409 CURRENT_PASSWORD_INCORRECT`. Same address and
already verified → `200`, nothing changes. Otherwise: set `email`, `email_verified_at = null`
(R7), void outstanding `email_verify` **and** `password_reset` tokens (R93), insert a verify
token bound to the address, audit `user.email_changed`. After commit: mail the link; if the
previous address was verified and differs, mail it a notice. **200** `MeDto`.

### 4.3 `POST /me/change-password` — `@AllowWhenSuspended()`

`{ currentPassword: 1–128, newPassword: as §3.4 and ≠ currentPassword }`. Throttle 5/min per
session. Lock user row; `409 CURRENT_PASSWORD_INCORRECT`; `hasVerifiedEmail` false → `409
EMAIL_NOT_VERIFIED`. Set hash, `password_is_default = false`, `password_changed_at`; revoke all
other sessions; rotate this one. Notice mailed after commit. **200** `MeDto` + `Set-Cookie`.
Audit `user.password_changed`.

---

## 5. Users — `@RequireCapability(USER_ACCOUNT_MANAGE)`

`UserDto`:

| Field | Type |
|---|---|
| `id`, `staffId`, `guardianId`, `studentId` | string; the last three nullable |
| `fullName` | string |
| `systemRoles` | `SystemRole[]` (live rows) |
| `status` | enum `UserStatus`: `active \| disabled` |
| `emailMasked` | string \| null — `a***@example.com` |
| `hasEmail`, `hasVerifiedEmail`, `passwordIsDefault` | boolean |
| `lastLoginAt`, `createdAt` | datetime; `lastLoginAt` nullable |

### 5.1 `GET /users` — paginated

`page`, `limit`; `status`; `passwordIsDefault`, `hasEmail` (`true|false` strings → boolean);
`kind` (`staff|guardian|student`); `q` 2–100 on full name, a 13-digit run → `422`. `sort`:
`fullName` (default), `-fullName`, `lastLoginAt`, `-lastLoginAt`, `createdAt`, `-createdAt`; `id`
tiebreak. Guardian and student joins are added by slices 5 and 6.

### 5.2 `GET /users/:id` — `UserDto`; `404`.

### 5.3 Target rules for reset, disable, enable

In order, after locking the target user row (R99): target = caller → `409 SELF_ACTION_FORBIDDEN`
(R10); target holds a live `principal` row and caller lacks `role.manage` → `403
PERMISSION_DENIED`, `details.reason = 'target_is_principal'` (R12); caller lacks `role.manage`
and the target's effective set is not a subset of the caller's → `403`, `details.reason =
'target_exceeds_actor'` (R14).

### 5.4 `POST /users/:id/reset-password` — `@AllowWhenSuspended()`

`{ reason: 3–500, no identity pattern; clearEmail: boolean, required }`. Default password =
decrypted digits of the linked staff CNIC / guardian CNIC / student B-Form (missing → `409
IDENTITY_NUMBER_MISSING`). Sets hash, `password_is_default = true`, `office_reset_at = now`;
revokes all sessions; voids all tokens; if `clearEmail` → `email = null`, `email_verified_at =
null`. `status` untouched (R6). After commit: clear lockout; if a verified email was kept, mail a
notice. **200** `UserDto`. Audit `user.office_reset`, metadata `{ clearEmail }`.

### 5.5 `POST /users/:id/disable` — `@AllowWhenSuspended()` · `POST /users/:id/enable`

`{ reason }`. Already in the target state → `200`, no audit. Disable: lock `school_settings`
(R72/R73); would leave no active principal → `409 LAST_PRINCIPAL`; set `disabled`, revoke all
sessions, void tokens (R9, R100). Enable: set `active`. **200** `UserDto`. Audit
`user.disabled` / `user.enabled`.

---

## 6. `GET|PATCH /school/settings` — `@RequireCapability(SCHOOL_SETTINGS_MANAGE)`

`SchoolSettingsDto { feeDueDay: integer, studentLoginEnabled: boolean, updatedAt }`.
PATCH: `feeDueDay` int 1–28, `studentLoginEnabled` boolean; `null` → `422`; empty body is a
no-op. Audit `school_settings.updated` `{ changes }` only when something changed. **200**.

---

## 7. `POST /platform/schools/:id/issue-principal-login` — `@PlatformSession()`

| Field | Rules |
|---|---|
| `fullName` | 2–200, no control characters |
| `cnic` | `IDENTITY_INPUT_PATTERN`, normalised |
| `phone` | `normalisePhone`, required |
| `reason` | optional, 3–500, no identity pattern |

**Branded input.** `SchoolRepository.lockForPrincipalIssue(id)` (`SELECT … FOR UPDATE` on
`schools`) returns a new brand `PrincipalIssueSchoolRow`, minted only in
`school-id.mint.ts` and importable only from `repositories/platform/**`; `fromPlatformSchool`
accepts `CreatedSchoolRow | PrincipalIssueSchoolRow`. No id from the request reaches the brand.

One transaction: lock school (absent → `404`; `terminated` → `409 SCHOOL_TERMINATED`); count
active principals; ≥ 1 and no `reason` → `409 ACTIVE_PRINCIPAL_EXISTS` (R103). Staff by
`cnic_hash`: exists and not `active` → `409 STAFF_NOT_ACTIVE`; absent → create (`designation
'Principal'`, `joined_on` today in the school timezone). User by `username_hash`: `disabled` →
`409 USER_DISABLED`; exists → set `staff_id` if null (R22); absent → create with the default
password. Live `principal` row already → `409 ALREADY_PRINCIPAL`; else insert it
(`assigned_by` null). Audit to both logs. After commit, if `reason` was used, existing principals
with a verified email get a notice.

**201** `{ userId, staffId, fullName, linkedExistingUser: boolean }`. Errors: `401` · `403` (slice-1
set) · `404` · `422` · `409` as above. Retry: a resubmit after a timeout gets `ALREADY_PRINCIPAL`,
which the web shows as done.

---

## 8. Error codes

| Code | Status | Where |
|---|---|---|
| `TOKEN_INVALID` | 409 | reset, verify — unknown, used, expired, wrong school, user inactive, address changed |
| `EMAIL_NOT_VERIFIED` | 409 | change-password |
| `SELF_ACTION_FORBIDDEN` | 409 | reset, disable, enable on self (later R47, R74) |
| `LAST_PRINCIPAL` | 409 | disable (later role removal, staff status) |
| `IDENTITY_NUMBER_MISSING` | 409 | office reset with no decryptable number |
| `ACTIVE_PRINCIPAL_EXISTS` | 409 | issue-principal-login without reason |
| `ALREADY_PRINCIPAL` | 409 | issue-principal-login on a current principal |
| `STAFF_NOT_ACTIVE` | 409 | issue-principal-login (later R21) |
| `USER_DISABLED` | 409 | issue-principal-login onto a disabled user |

Reused: `AUTH_FAILED`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `SCHOOL_SUSPENDED`,
`CURRENT_PASSWORD_INCORRECT`, `SCHOOL_TERMINATED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`.

## 9. School audit actions (`audit_log`)

| Action | Subject | Actor | Reason | Metadata |
|---|---|---|---|---|
| `user.login_after_office_reset` | user | user | — | `{}` |
| `user.email_changed` / `user.email_verified` | user | user | — | `{}` (no address) |
| `user.password_changed` / `user.password_reset_by_token` | user | user | — | `{}` |
| `user.office_reset` | user | caller | required | `{ clearEmail }` |
| `user.disabled` / `user.enabled` | user | caller | required | `{}` |
| `school_settings.updated` | school_settings | caller | — | `{ changes }` |
| `staff.created`, `user.principal_login_issued` | staff / user | platform user | as given | `{ linkedExistingUser }` |

Token-driven rows have no user actor: `actor_user_id` is the target. Platform log adds
`school.principal_login_issued` and `login_failure_spike`.

---

## 10. Web screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| `/login` | `POST /auth/login` | School code (remembered in `localStorage`), CNIC (dashes allowed), password. One generic message; `429` shows the wait; `503` "try again shortly" |
| `/forgot` | `POST /auth/forgot-password` | Always the same confirmation; tells users with no email to ask the office |
| `/reset/[code]` | `POST /auth/reset-password` | Fragment token, button, then `/login` |
| `/verify-email/[code]` | `POST /auth/verify-email` | Fragment token, "Verify" button |
| `(school)` layout | `GET /me` | Sidebar from `capabilities`; `401` → `/login`; persistent default-password banner; suspended notice |
| `/account` | `POST /me/change-email`, `/me/change-password` | Password form disabled with an explanation until `hasVerifiedEmail` |
| Users list | `GET /users` | Filters status, kind, default password, no email; reset / disable / enable dialogs (shared confirm-with-reason); reset shows `emailMasked` and a required keep/clear choice |
| School settings | `GET|PATCH /school/settings` | Fee due day 1–28, student login toggle |
| Platform school detail | `POST /platform/schools/:id/issue-principal-login` | Reason field appears on `ACTIVE_PRINCIPAL_EXISTS` |

---

## Decisions made here

1. Five access decorators; `@RequireStaff()` added for staff-wide reads; `@RequireCapability` takes
   one or more keys with any-of semantics.
2. Suspended exemptions are an explicit `@AllowWhenSuspended()` marker, enumerated by test.
3. School cookie is persistent (`Max-Age` to the 30-day expiry); slice 2 mints cookie sessions
   only; the bearer branch exists in the resolver for Phase 2.
4. Origin is required on every non-GET without `Authorization`, public auth routes included.
5. New column `users.office_reset_at` (for `data-architect`) drives the first-login-after-reset
   audit. Token voiding sets `expires_at = now()`; `used_at` means consumed only.
6. Verify tokens last 24 h; reset tokens 15 min. Reset and verify return `204`; failures are one
   `409 TOKEN_INVALID`.
7. Change-email voids reset tokens too and notifies the old verified address.
8. Office reset reads the default password by decrypting the linked identity number.
9. Spray threshold: 50 failures per school per 10 minutes, one platform audit row per window.
10. Issue-principal-login reuses an existing staff row or user by hash; the brand
    `PrincipalIssueSchoolRow` comes only from a locked platform read.
11. `normalisePhone` and identity helpers live in `packages/shared` and are written by slice 2.
