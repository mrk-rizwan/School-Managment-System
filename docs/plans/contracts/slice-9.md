# Slice 9 contracts — messaging core, worker, bearer sessions, devices

**Author:** api-designer, 2026-10-03. **Binds:** `apps/api/src/worker.ts`, `src/jobs/**`,
`src/messaging/**`, `src/webhooks/**`, `src/tenancy/queue.mint.ts`,
`src/repositories/{whatsapp-number,message,message-delivery,message-usage,device}.repository.ts`,
`src/repositories/platform/{school-by-id,delivery-health,delivery-webhook}.repository.ts`,
`modules/auth/**`, `modules/me/**` (devices, sessions), `modules/users/**` (sign-out-everywhere),
`modules/school-settings/**`, `modules/messaging/**`, `modules/platform/{schools,settings,messaging}/**`,
`common/auth/route-access.ts`, `common/auth/origin-check.ts`, the app-version middleware,
`packages/shared/src/messages.ts`, `apps/web/app/(school)/settings/messaging/**`,
`apps/web/app/platform/{messaging,settings}/**`. **Sources:** `CLAUDE.md` (rules 2, 12, 13, 15, 16,
17; named exceptions 1–4; conventions), plan §1.1, §1.2, §3, §4.1, §4.2, §4.5, §4.8, §5
(messaging), §6.1, slice 9, R105–R115, R153–R155, R159, R161, R166, R169–R173,
`docs/research/sms-gateways-2026-10-03.md`. Everything not restated follows Phase 1 §3.9,
`slice-1.md` (platform), `slice-2.md` (login, sessions, `/me`, users) and `slice-7.md`. School paths
are under `/api/v1`, platform paths under `/api/v1/platform`, webhooks under `/api/v1/webhooks`.
Slice 9 **extends** slice 2 additively: no field is renamed or removed.

---

## 1. Access, request pipeline, sessions, throttles, lock order

### 1.1 Routes

| Route | Decorator |
|---|---|
| `POST /auth/login` | `@Public()` (unchanged) |
| `POST /auth/logout`, `GET /me`, `POST /me/change-password`, `POST /me/devices`, `POST /me/sessions/revoke-others` | `@AuthenticatedOnly()` |
| `POST /users/:id/sign-out-everywhere` | `@RequireCapability(USER_ACCOUNT_MANAGE)` |
| `GET\|PATCH /school/settings` | `@RequireCapability(SCHOOL_SETTINGS_MANAGE)` (unchanged) |
| `POST /messaging/test`, `GET /messaging/usage`, `GET /messaging/whatsapp`, `POST /messaging/whatsapp/pair`, `POST /messaging/whatsapp/connect-cloud-api`, `POST /messaging/whatsapp/disable` | `@RequireCapability(SCHOOL_SETTINGS_MANAGE)` |
| `PATCH /platform/schools/:id`, `GET\|PATCH /platform/settings`, `GET /platform/messaging/health` | `@PlatformSession('full')` |
| `POST /webhooks/waha` | `@Webhook('waha')` |
| `GET /webhooks/meta`, `POST /webhooks/meta` | `@Webhook('meta')` |

`RouteAccessGuard` requires **exactly one of six** decorators; `@Webhook(provider:
WebhookProvider)` is the sixth (§8.1). `WebhookProvider = 'waha' | 'meta'` in Phase 2; `'sms'`
joins with the first push-report SMS adapter (§8.4). The R68 snapshot lists every `@Webhook`
route and asserts they all live under `/webhooks/`; no `@Webhook` route appears in either OpenAPI
document (a third module bucket, `WebhooksModule`, excluded from both).

`@AllowWhenSuspended()` is **deleted** with R80 (§10); the plan's instruction to add it to
`POST /me/devices` is moot.

Common errors on school routes: `401 AUTH_REQUIRED` · `403 PERMISSION_DENIED` · `403
ORIGIN_REJECTED` · `426 UPGRADE_REQUIRED` · `429 RATE_LIMITED`. `SCHOOL_SUSPENDED` is no longer
emitted anywhere (§10). Absent, malformed or another school's path id → `404 NOT_FOUND`.

### 1.2 Request pipeline, in order

1. **App-version floor** (Express middleware, R161, §1.4) → `426`.
2. **Origin check** (Express middleware, R170, §1.3) → `403 ORIGIN_REJECTED`.
3. **Per-IP throttle** (global throttler; §1.6) → `429`.
4. **Access guard**: `@Public` / `@PlatformSession` / school resolution (`slice-2.md` §1.1 with
   §1.3 and §1.5 below) / `@Webhook` verification (§8.1) → `401` / `403`.
5. Route throttles (`perUserThrottle`, login throttles) → `429`; Redis unreachable → `503`.
6. `ValidationPipe` → `422`.
7. Handler.

### 1.3 Origin and bearer rules (R170)

- **Origin is required** (equal to `APP_URL`'s origin, else `403 ORIGIN_REJECTED`) on every school
  non-GET that carries **neither** `Authorization` **nor** `X-App-Version`. This replaces
  `slice-2.md` §1.2's "without `Authorization`". A browser cannot send `X-App-Version`
  cross-origin without a CORS preflight, and the API answers no preflight (no CORS headers, ever).
  The platform rule (`slice-1.md` §1: Origin on every platform non-GET, login included) is
  unchanged: the platform API accepts no bearer and no `X-App-Version` exemption.
- **A bearer token with `Origin` is refused.** School resolution, step 1 gains: `Authorization:
  Bearer` present **and** an `Origin` header present → `401 AUTH_REQUIRED`. (Bearer and school
  cookie together were already `401`.) A script running in the web admin can neither use nor mint
  a long-lived token.
- **`channel: bearer` at login** with an `Origin` header or a `__Host-asms_session` cookie → `401
  AUTH_FAILED` (§3.1 step 4).
- Webhooks are exempt from the Origin check through their decorator (the middleware skips
  `/api/v1/webhooks/*`).

### 1.4 App-version floor (R161)

- Header `X-App-Version`, pattern `APP_VERSION_PATTERN` = `^[0-9]{1,4}(\.[0-9]{1,4}){2}$`
  (`packages/shared`).
- The middleware runs **before session resolution** on every request that carries
  `Authorization: Bearer` **or** `X-App-Version`. It compares the three numbers left to right with
  `MOBILE_MIN_APP_VERSION`. Below the floor, a malformed header, or a bearer request **without**
  the header (below every floor) → `426 UPGRADE_REQUIRED`, `details: { minimumVersion }`, message
  "This version of the app is no longer supported. Update the app to continue." No session is
  read, nothing is counted.
- Exempt: requests with neither (cookie clients, public web forms), `/health`, `/api/v1/webhooks/*`.
- `MOBILE_MIN_APP_VERSION` is required in production (boot fails without it, pattern-checked);
  outside production it defaults to `0.0.0`.

### 1.5 Session lifetimes (R154) and resolution changes

| Channel | Capacities at resolution | Idle | Absolute (`expires_at`, set at mint) |
|---|---|---|---|
| `cookie` | any | 24 h | 30 days (unchanged) |
| `bearer` | includes `staff` | **14 days** | **90 days** |
| `bearer` | guardian and/or student only | **30 days** | **180 days** |

- The absolute lifetime is chosen **at mint** from the capacities then held (a teacher-parent gets
  the staff values) and stored in `expires_at`. Idle is computed **at each resolution** from the
  channel and the capacities now held, so gaining staff capacity tightens idle at once; losing it
  revokes every session anyway (R70). No new column.
- Resolution step 2's idle test becomes `last_seen_at + idle(channel, capacities) <= now`.
- Every Phase 1 revocation path (disable, office reset, password change, staff `left|suspended`,
  student status, issue-login reset, the principal-link reset) ends bearer sessions exactly as it
  ends cookie sessions; slice 9 adds logout's device write, revoke-others and sign-out-everywhere.
  An ended guardian link shrinks scope on the next request without revoking the session.
- **Devices die with their session** (R115): the push resolver joins `sessions` and sends only to a
  device with `unregistered_at IS NULL` whose session has `revoked_at IS NULL AND expires_at >
  now() AND last_seen_at > now() − idle` (the same `idle()` function). No revocation path writes
  `devices`; only logout (§3.2), FCM `unregistered` (§7.6) and replacement (§3.5) do.
- The daily session purge (`session-purge`, 03:00 Asia/Karachi, every school including
  terminated ones) deletes sessions revoked, or past `expires_at`, more than 90 days ago, 500 per
  transaction, and deletes the purged sessions' `devices` rows first in the same transaction (no
  cascades exist; a device row is a push address, not history, so `devices` carries no DELETE or
  TRUNCATE refusal — migration `20261004090000_devices_purgeable`). Indexed by `(school_id,
  revoked_at)` and `(school_id, expires_at)`.

### 1.6 Throttles (R166 and this slice)

| Bucket | Limit | Key |
|---|---|---|
| Per-IP, cookie and unauthenticated traffic (global throttler) | 300/min (unchanged) | IP |
| Per-IP, requests carrying `Authorization: Bearer` | **3,000/min** — DoS backstop only (carrier NAT) | IP |
| `POST /auth/login` | 5/min per `code:usernameHash:ip`, 10/min per `usernameHash`, **300/min per IP** (was 30) | as `slice-2.md` §3.1 |
| `/me/*` and `GET /me` reads (`perUserThrottle('me-reads', 120, 2000)`) | 120/min, 2,000/hour | school + user |
| `POST /me/devices` (`'devices'`) | 10/min, 60/hour | school + user |
| `POST /me/sessions/revoke-others` (`'revoke-sessions'`) | 5/min, 20/hour | school + user |
| `POST /me/change-password` | 5/min per session (unchanged) | session |
| `POST /messaging/test` (`'messaging-test'`) | 5/min, 30/hour | school + user |
| `POST /messaging/whatsapp/pair` (`'whatsapp-pair'`) | 10/min, 60/hour | school + user |
| `POST /messaging/whatsapp/connect-cloud-api` (`'whatsapp-connect'`) | 5/min, 20/hour | school + user |
| Webhooks, verified | 3,000/min | IP |
| Webhooks, failed verification | 10/min; once spent, the IP is `429` before verification | IP |

`perUserThrottle` keys by school and user, so R166's "per session" is enforced per user (stricter:
a user's phone and browser share one bucket). `429` carries `Retry-After`.

### 1.7 Lock order (whole system after slice 9)

`school_settings` → target `users` row → `staff` → `custom_roles` → `teacher_assignments` (slice 7,
unchanged) → **`sessions` → `devices`** → **`whatsapp_numbers`** (live row). `platform_settings`
and `schools` rows are locked only by platform routes, which take no tenant lock. The messaging
processor takes no explicit lock: its claim is a conditional `UPDATE` (§7.6) and usage is an atomic
upsert (§7.7). No path takes a `devices` row before its session or a `whatsapp_numbers` row before
`school_settings`.

---

## 2. Shapes

### 2.1 Enums (`packages/shared`, `enum` + `enumName` on every DTO use)

| Enum | Values |
|---|---|
| `SessionChannel` | `cookie \| bearer` |
| `Capacity` | `staff \| guardian \| student` |
| `DevicePlatform` | `android \| ios` |
| `MessageType` | §7.2 table (12 values, `messaging_test` included) |
| `MessagePriority` | `urgent \| normal \| low \| internal \| platform` |
| `MessageChannel` | `push \| whatsapp \| sms \| email \| in_app` |
| `MessageStatus` | `queued \| sending \| sent \| delivered \| failed \| suppressed` |
| `DeliveryStatus` | `accepted \| delivered \| failed \| suppressed` |
| `SuppressionReason` | `not_allowed \| cap_reached \| no_channel \| backdated` (`school_suspended` removed, owner's item 13) |
| `DeliveryErrorCode` *(new)* | `timeout \| provider_unavailable \| rate_limited \| auth_failed \| rejected \| invalid_number \| not_on_whatsapp \| outside_window \| session_down \| unregistered_device \| dnd_blocked \| expired \| no_report \| unknown` |
| `WhatsAppProvider` | `waha \| cloud_api`; school column adds `platform_default` (`WhatsAppProviderChoice`) |
| `SmsProvider` | `sendpk`; school column adds `platform_default` (`SmsProviderChoice`) |
| `WhatsAppStatus` | `pending \| connected \| down \| disabled` |
| `WhatsAppErrorCode` *(new)* | `unreachable \| logged_out \| session_failed \| token_rejected \| number_mismatch \| unknown` |
| `MessageSubjectType` *(new, string union for `messages.subject_type`)* | slice 9: `messaging_test`, `sms_cap`; later slices add `attendance_alert`, `register_deadline`, `announcement`, `diary_entry`, `remark` with their types |
| `TeacherAssignmentRole` | `class_teacher \| subject_teacher` (+ `cover` from slice 10) |

`DeliveryErrorCode` and `WhatsAppErrorCode` are additions to the §6.1 groundwork list: provider
error text is mapped to these and never stored or returned raw (R111).

### 2.2 DTOs

`LoginResultDto` = every `MeDto` field, plus:

| Field | Type |
|---|---|
| `bearerToken` | string \| null — the 43-character token **only** when the session's channel is `bearer`; `null` for cookie. Never an `example` in OpenAPI |

`MeDto` gains (additive):

| Field | Type |
|---|---|
| `capacities` | `Capacity[]` — active capacities, in the order `staff`, `guardian`, `student` |
| `assignments` | `MeAssignmentDto[]` — the caller's teacher assignments active today (cover included from slice 10), not voided; `[]` without staff capacity. Sorted `className`, `sectionName`, `subjectName` |

`MeAssignmentDto`: `id`, `role` (`TeacherAssignmentRole`), `academicYearId`, `classId`,
`className`, `sectionId` (string \| null — a whole-class subject teacher, R54), `sectionName`
(string \| null), `subjectId` (string \| null), `subjectName` (string \| null), `attendanceMode`
(`AttendanceMode`, from the class), `startsOn` (date), `endsOn` (date \| null).

`DeviceDto`: `id`, `platform`, `appVersion` (string), `createdAt`, `lastSeenAt`. **Never the push
token** (R173).

`SessionsRevokedDto`: `revoked` (integer ≥ 0).

`SchoolSettingsDto` gains the §4 fields. `SchoolDto` (platform) gains `smsMonthlyCap` (integer),
`whatsappProvider` (`WhatsAppProviderChoice`), `smsProvider` (`SmsProviderChoice`).

`PlatformSettingsDto`: `defaultWhatsappProvider` (`WhatsAppProvider`), `defaultSmsProvider`
(`SmsProvider`), `enabledWhatsappProviders` (`WhatsAppProvider[]`, from
`WHATSAPP_PROVIDERS_ENABLED`, §6.4), `updatedAt`.

`WhatsAppSettingsDto` (`GET /messaging/whatsapp`, connect, disable):

| Field | Type |
|---|---|
| `effectiveProvider` | `WhatsAppProvider` — the school's choice, or the platform default when `platform_default`; decides which onboarding route is open |
| `number` | `WhatsAppNumberDto` \| null — the school's live row (status ≠ `disabled`), else null |

`WhatsAppNumberDto`: `id`, `provider` (`WhatsAppProvider`, the row's own, frozen), `phoneMasked`
(`+9230*****67`), `status` (`WhatsAppStatus`), `lastHealthyAt` (datetime \| null),
`lastErrorCode` (`WhatsAppErrorCode` \| null), `inboundIgnoredCount` (integer), `pairedAt`
(datetime \| null — set when it first became `connected`), `createdAt`. Never the token, the
phone-number id or the WAHA session name.

`WhatsAppPairingDto`: `qr` (string, `data:image/png;base64,…`), `expiresAt` (datetime).

`MessagingTestResultDto`: `messageId`.

`MessagingUsageDto`:

| Field | Type |
|---|---|
| `months` | `[{ yearMonth: 'YYYY-MM', byChannel: [{ channel, count }] }]` — this month then last month (Asia/Karachi); `byChannel` lists `sms`, `whatsapp`, `push`, `email`, zeros included |
| `cap` | integer — `schools.sms_monthly_cap` |
| `remaining` | integer — `max(cap − this month's sms count, 0)` |

`sms` counts **SMS segments** (the billing unit); the other channels count accepted legs (§7.7).

`PlatformDeliveryHealthDto` (one per school):

| Field | Type |
|---|---|
| `schoolId`, `name`, `shortCode` | from `schools` |
| `schoolStatus` | `SchoolStatus` |
| `whatsapp` | `{ status: WhatsAppStatus \| 'none', lastHealthyAt, lastErrorCode }` — the rollup's snapshot |
| `today`, `yesterday` | `[{ channel, accepted, delivered, failed, suppressed }]` — `push`, `whatsapp`, `sms`, `email`, zeros included |
| `sms` | `{ used, cap }` — month to date from the rollup; `cap` live from `schools` |
| `computedAt` | datetime \| null — null when no rollup row exists yet |

---

## 3. Auth, me, sessions, devices

### 3.1 `POST /auth/login` — `@Public()`

| Field | Rules |
|---|---|
| `schoolCode`, `username`, `password` | as `slice-2.md` §3.1 |
| `channel` | optional `SessionChannel`, default `cookie` |

Order:
1. Middleware: `X-App-Version` present and below the floor or malformed → `426` (§1.4). Origin,
   when neither `Authorization` nor `X-App-Version` is sent (§1.3) → `403 ORIGIN_REJECTED`.
2. Throttles (§1.6) → `429`; Redis unreachable → `503`.
3. Validation → `422`. `channel: bearer` without `X-App-Version` → `422 INVALID_VALUE` on
   `channel` ("The app must send its version").
4. `channel: bearer` and (`Origin` header present or `__Host-asms_session` cookie present) → `401
   AUTH_FAILED`, the identical body and headers as a credential failure; **not** counted toward
   the lockout or the spray counter (it is not a password guess).
5. Lockout, lookup, verify, spray: `slice-2.md` §3.1 steps 2–6 unchanged.
6. Success: lockout count reset; the **presented** session, if any (cookie or bearer, any school,
   resolved by token hash under exception 4), is revoked — the app sends its current bearer token
   on a fresh sign-in so a phone handed to a second parent kills the first parent's session and,
   by the join, its device (R159); a new session of the requested channel with `expires_at` per
   §1.5; `last_login_at = now`.

**200** `LoginResultDto`. Cookie: `Set-Cookie` as `slice-2.md` §1.2, `bearerToken: null`. Bearer:
**no `Set-Cookie`**, `bearerToken` set. `Cache-Control: no-store` (as every response). Audit
`user.login_on_default_password` (when it applies) gains `channel` in its metadata.

Errors: `403 ORIGIN_REJECTED` · `422` · `401 AUTH_FAILED` · `426` · `429` · `503`.

### 3.2 `POST /auth/logout` — `@AuthenticatedOnly()`, empty body

Revokes the presented session. **Bearer:** in the same transaction the session's live device row
gets `unregistered_at = now`, `unregistered_reason = sign_out` (R159: revoked server-side before
the app discards the token). Cookie: clears the cookie as before. **204**. Not audited.

### 3.3 `GET /me` — `NoQueryDto`, `me-reads` throttle

`MeDto` with `capacities` and `assignments` (§2.2). The tab shell of the app is composed from
`capacities`, `capabilities` and `assignments` (R156). No token, push token, username or identity
number is ever returned.

### 3.4 `POST /me/change-password` — rotation on the caller's channel (R153)

Request and refusals unchanged (`slice-2.md` §4.3): lock user row → `409
CURRENT_PASSWORD_INCORRECT` → `409 EMAIL_NOT_VERIFIED` → `422` on `newPassword`. Then, in one
transaction: hash set, `password_is_default = false`, `password_changed_at`; every **other**
session revoked (their devices die by the join); the presented session revoked and **a new session
minted on the presented session's channel** (`MeService.mint(channel)`), absolute lifetime per §1.5;
the presented session's live device row, if any, **moves** to the new session (`session_id`
updated), so push continues without a re-registration.

**200** `LoginResultDto` (previously `MeDto`; the added field is additive). Cookie caller:
`Set-Cookie`, `bearerToken: null`. Bearer caller: `bearerToken` = the new token, **no
`Set-Cookie`**; the old token is dead on commit, so an app that loses this response gets `401` on
its next call and signs in again. Audit `user.password_changed`, metadata `{ channel }`.

### 3.5 `POST /me/devices` — register or refresh this session's push address

| Field | Rules |
|---|---|
| `platform` | required `DevicePlatform` |
| `pushToken` | required string, 1–512, `^[A-Za-z0-9_:.-]+$` |

`appVersion` is read from `X-App-Version` (always present: a bearer request without it is `426`).

Order: session channel `cookie` → `409 BEARER_SESSION_REQUIRED` → `422` shape → `devices` row of
this session locked (`UNIQUE (school_id, session_id)`); then:

| State | Effect | Status |
|---|---|---|
| no row for this session | insert (`created_at`, `last_seen_at = now`) | **201** |
| row, same token, live | touch `last_seen_at`, `app_version`, `platform` | **200** |
| row, different token (FCM refresh) or `unregistered_at` set | update `push_token`, `app_version`, `platform`, `last_seen_at`; clear `unregistered_at` / `_reason` | **200** |

In the same transaction, every **other** live device row in the school with the same `push_token`
is ended: `unregistered_at = now`, `unregistered_reason = replaced` (R159; two parents on one phone
— the latest sign-in owns the token). A row of another school with the same token is untouched
(tenancy); it dies when that session is revoked, which the app does by presenting its old token at
sign-in (§3.1 step 6). An insert race on `devices_school_id_session_id_key` is re-read outside the
transaction and answered as the "row exists" case.

**201 / 200** `DeviceDto`. Not audited (a push address, refreshed often, grants nothing); logged
with the device id only — `*.pushToken` is a redact path (R173).

### 3.6 `POST /me/sessions/revoke-others` — empty body (R169)

Revokes every live session of the caller except the presented one, any channel. Their devices die by
the join; no device row is written. **200** `SessionsRevokedDto`. Audit `user.sessions_revoked`
`{ revoked }` only when `revoked > 0`. Retry: a repeat returns `{ revoked: 0 }`.

### 3.7 `POST /users/:id/sign-out-everywhere` — `{ reason: TextField(3, 500) }` (R169)

Target user locked (R99). Refusal order, as office reset (`slice-2.md` §5.3): absent → `404` →
target = caller → `409 SELF_ACTION_FORBIDDEN` (R10; the caller uses §3.6 for their own other
sessions) → target holds a live `principal` row and the caller lacks `role.manage` → `403
PERMISSION_DENIED`, `details.reason = 'target_is_principal'` (R12) → the caller lacks
`role.manage` and the target's effective set is not a subset of the caller's → `403`,
`details.reason = 'target_exceeds_actor'` (R14). Then every live session of the target is revoked.
**Password, email, tokens and `status` are untouched.** A disabled target is accepted (normally
`revoked: 0`).

**200** `SessionsRevokedDto`. Audit `user.signed_out_everywhere` `{ revoked }` with the reason, only
when `revoked > 0` (as disable on an already-disabled user: nothing happened, nothing recorded).

---

## 4. `GET|PATCH /school/settings` — additions (plan §4.5)

`SchoolSettingsDto` adds:

| Field | Type, default | PATCH rule |
|---|---|---|
| `periodsPerDay` | integer, 8 | 1–12 |
| `weeklyOffDays` | integer[], `[0]` (Sunday; 0 = Sunday … 6 = Saturday) | distinct integers 0–6, 0–6 entries (`[]` = no off day; all seven → `422`); returned ascending |
| `attendanceAmendWindowDays` | integer, 3 | 0–30 |
| `registerDeadlineTime` | string `HH:MM`, `10:00` | `^([01][0-9]\|2[0-3]):[0-5][0-9]$`, school local time |
| `absenceAlertTime` | string `HH:MM`, `09:30` | as above |
| `lateAdviceEnabled` | boolean, false | boolean |
| `lateCountsAs` | `LateCountsAs`, `present` | enum |
| `lateCutoffTime` | string \| null, null | as a time or `null`; **required** (non-null after the patch is applied) when `lateCountsAs` is, after the patch, `absent_after_cutoff` → else `422 INVALID_VALUE` on `lateCutoffTime` |
| `leaveCountsAs` | `LeaveCountsAs`, `excused` | enum |
| `smsMonthlyCap` | integer, **read-only** | not declared on the PATCH DTO → `422 UNKNOWN_FIELD` (set by the platform, §6.1) |
| `smsAllowedTypes` | `MessageType[]`, the §7.2 "SMS by default: yes" set | distinct, each one of the **SMS-eligible** types (`absence_alert`, `late_advice`, `attendance_corrected`, `announcement_urgent`, `announcement_normal`, `holiday_notice`); any other type → `422 INVALID_VALUE` on `smsAllowedTypes`; `[]` allowed; returned in §7.2 order |
| `remarkDefaultVisibility` | `RemarkVisibility`, `guardian` | enum |
| `remarkNotifyGuardians` | boolean, false | boolean |

PATCH as before: absent = unchanged; `null` is `422` on every field except `lateCutoffTime`; empty
body is a no-op. `school_settings` row locked. **200** `SchoolSettingsDto`. One audit action
`school_settings.updated { changes }`, only when something changed; arrays recorded as
comma-joined strings (audit metadata holds scalars). Changing `periodsPerDay` or `weeklyOffDays`
never rewrites a recorded register (R116).

---

## 5. Messaging (school)

### 5.1 `POST /messaging/test` — `{ channel: 'whatsapp' | 'sms' | 'push' }`

Sends a `messaging_test` message (§7.2) to **the caller's own staff record** — the caller's
`staff.phone` for WhatsApp and SMS, the caller's live devices for push. It runs through
`NotificationService` and the worker exactly like any message, so the delivery row is the proof.

Order: `422` shape → throttle (5/min, 30/hour) → `channel ∈ {whatsapp, sms}` and the staff row has
no usable phone → `409 CONTACT_PHONE_MISSING` (unreachable while `staff.phone` is required; kept so
the refusal is defined) → `whatsapp` and the school has no live `whatsapp_numbers` row → `409
WHATSAPP_NUMBER_MISSING` → `sms` and this month's SMS count + 1 > cap → `409 SMS_CAP_EXCEEDED`
`details: { cap, used }`. Then, one transaction: audit `messaging.test_sent { channel }` (subject:
the caller's user); `NotificationService.send` with subject `{ type: 'messaging_test', id: <that
audit row's id> }`, so every test is a distinct subject.

Plan (overrides §7.3): `push` → `[push]` (no live device → the message is `suppressed`,
`no_channel`, and the screen says so); `sms` → `[sms]`; `whatsapp` → `[whatsapp, sms after
WhatsApp failure]`. The test **bypasses `smsAllowedTypes`** and **counts against the cap**. A
`down` number is still tried, so stopping WAHA shows the fallback (the slice's acceptance test).

**200** `MessagingTestResultDto`. The screen polls the message through the delivery view of
slice 14; until then it re-reads `GET /messaging/usage` and shows the `messageId`. Retry: a double
tap sends two tests (throttled); no idempotency key.

### 5.2 `GET /messaging/usage` — `NoQueryDto`

**200** `MessagingUsageDto` from `message_usage` and `schools.sms_monthly_cap`
(`OwnSchoolRepository`). Not paginated: two months, four channels.

### 5.3 `GET /messaging/whatsapp` — `NoQueryDto`

**200** `WhatsAppSettingsDto`. `number` is null before the first pairing and after a disable.
`effectiveProvider` lets the screen show "Pair with QR" (WAHA) or "Connect Cloud API details".

### 5.4 `POST /messaging/whatsapp/pair` — WAHA only, `{ phone?: PhoneField }`

Order: throttle → `422` → `effectiveProvider ≠ waha` → `409 WHATSAPP_PROVIDER_MISMATCH` `details: {
provider }` → live row locked:

| Live row | Result |
|---|---|
| none, no `phone` | `409 WHATSAPP_NUMBER_MISSING` |
| none, `phone` given | insert `provider = waha`, `status = pending`, `waha_session = 'asms_' || id` (set in the insert's transaction, never reused), `paired_by = caller` |
| `provider = cloud_api` (any live status) | `409 WHATSAPP_PROVIDER_MISMATCH` `details: { provider: 'cloud_api' }` — disable it first |
| `status = connected` | `409 WHATSAPP_ALREADY_CONNECTED` |
| `pending` or `down` | re-pair the same row: `status = pending`, `paired_by = caller`; `phone`, if given, must equal the row's → else `422 INVALID_VALUE` on `phone` ("disable the current number first") |

An insert race on `whatsapp_numbers_school_id_live_key` is re-read outside the transaction and
answered from the table. Audit `whatsapp.pairing_started { whatsappNumberId, firstPairing }` —
**every** QR issued is audited (plan §3: "the action audited"). Commit. **After commit**, outside
any transaction (timeout 10 s): ensure the WAHA session exists (created with its webhook: URL
`/api/v1/webhooks/waha`, events `message.ack`, `session.status`, `message`, HMAC key
`WAHA_WEBHOOK_SECRET`), start it, fetch the QR as PNG. WAHA reports the session already `WORKING`
→ enqueue `whatsapp-health` and answer `409 WHATSAPP_ALREADY_CONNECTED`. WAHA unreachable or
erroring → `503 SERVICE_UNAVAILABLE` (the row stays `pending`; a retry works).

**200** `WhatsAppPairingDto`, `expiresAt = now + 45 s`; the screen re-requests on expiry and polls
`GET /messaging/whatsapp` (every 5 s while the QR is shown) until `connected`. The QR is never
logged, cached or stored; `*.qr` is a redact path. `pending → connected` is written by the health
job (§7.8), which the `session.status` webhook triggers within seconds.

### 5.5 `POST /messaging/whatsapp/connect-cloud-api`

| Field | Rules |
|---|---|
| `phone` | required `PhoneField` |
| `phoneNumberId` | required, `^[0-9]{5,20}$` (Meta's id; not secret) |
| `accessToken` | required, 20–1024, `^[A-Za-z0-9_.\|-]+$`; never logged (`*.accessToken` redact path), never returned |

Order: throttle → `422` → `effectiveProvider ≠ cloud_api` → `409 WHATSAPP_PROVIDER_MISMATCH` → live
row read: a `waha` row → `409 WHATSAPP_PROVIDER_MISMATCH`; a `connected` row, or a `cloud_api` row
with a different `phoneNumberId` → `409 WHATSAPP_ALREADY_CONNECTED`; a `pending|down` `cloud_api`
row with the same `phoneNumberId` → **reconnect** (the token is replaced; the usual fix for an
expired token). Then **verification, outside any transaction**: one Graph call `GET
/{META_GRAPH_VERSION}/{phoneNumberId}?fields=display_phone_number,verified_name` with the token
(timeout 10 s). Token refused → `409 WHATSAPP_VERIFICATION_FAILED` `details: { reason:
'token_rejected' }`; id not found → `'not_found'`; `display_phone_number` normalised ≠ `phone` →
`'number_mismatch'`; Graph unreachable → `503`. Then one transaction: live row locked and the
checks above re-run (a race loses with the same codes); insert (`provider = cloud_api`, `status =
connected`, `paired_at/by`, `last_healthy_at = now`) or update the token, `status = connected`.
`cloud_access_token` encrypted (AES-256-GCM, AAD `schoolId|whatsapp_numbers|cloud_access_token`).
`whatsapp_numbers_cloud_phone_number_id_key` (global) violated → `409 WHATSAPP_VERIFICATION_FAILED`
`'number_in_use'`. Audit `whatsapp.cloud_api_connected { whatsappNumberId, reconnected }`.

**200** `WhatsAppSettingsDto`.

**Cloud API set-up (the steps the contract owes, plan §1.2):**
1. *Platform, once.* A Meta Business account for the platform company; one Meta app (type
   Business) with the WhatsApp product; webhook URL `https://<api-host>/api/v1/webhooks/meta`,
   verify token `META_WEBHOOK_VERIFY_TOKEN`, field `messages` subscribed; the app secret in
   `META_APP_SECRET`; the Graph version pinned in `META_GRAPH_VERSION` and recorded in `WORKLOG.md`.
2. *Per school.* The school's own Meta Business account (business-verified), a WhatsApp Business
   Account with the school's number registered and display name approved; the platform app added
   to that WABA (`POST /{waba-id}/subscribed_apps`) so its statuses reach our webhook; a system
   user in the school's business with a **permanent** token scoped to the WABA
   (`whatsapp_business_messaging`, `whatsapp_business_management`).
3. *Templates, per school WABA.* Every WhatsApp-eligible type (§7.2) is sent as an approved
   **utility** template named `asms_<type>_v<n>`, language `en`, body variables in the order the
   type's template declares; the platform supplies the set and the school (or the platform on its
   behalf) submits them. A type whose template is not approved fails its WhatsApp leg with
   `rejected` and falls back per §7.3. The 24-hour free-form window is not used.
4. The principal enters the number, the phone-number id and the token on the Messaging settings
   screen (§5.5).

### 5.6 `POST /messaging/whatsapp/disable` — `{ reason: TextField(3, 500) }`

Live row locked. None → **200** `WhatsAppSettingsDto` (`number: null`), no audit (retry-safe).
Otherwise `status = disabled`, `disabled_at/by/reason`; audit `whatsapp.disabled {
whatsappNumberId, provider, fromStatus }`. After commit: WAHA session logged out and deleted (best
effort; a failure is logged and the health sweep retries the stop for disabled rows that still
have a session). A Cloud API token simply stops being used. Messages already planned with a
WhatsApp leg fail it with `session_down` and fall back (§7.6). The phone may be paired again as a
new row (a lost SIM is replaced without a delete). **200** `WhatsAppSettingsDto` (`number: null`).

---

## 6. Platform

### 6.1 `PATCH /platform/schools/:id` — additions (`slice-1.md` §4.4)

| Field | Rules |
|---|---|
| `smsMonthlyCap` | optional integer 0–100,000; `null` → `422` |
| `whatsappProvider` | optional `WhatsAppProviderChoice`; `null` → `422`; a provider not enabled on the deployment (§6.4) → `422 INVALID_VALUE` (`platform_default` always passes) |
| `smsProvider` | optional `SmsProviderChoice`; `null` → `422` |

Unchanged otherwise: school row locked; terminated → `409 SCHOOL_TERMINATED`; empty body or no
change → `200`, no audit. A cap change applies to the next SMS leg (a cap below this month's usage
suppresses further SMS as `cap_reached`). A provider change does not touch a live
`whatsapp_numbers` row (the platform never reads or writes it, R114): sending uses the live row's
own provider; the change only decides which onboarding route is open (§5.4, §5.5), and the school's
settings screen shows the mismatch. **200** `SchoolDto`. Platform audit `school.updated { changes
}` (existing action; the three fields join it).

### 6.2 `GET|PATCH /platform/settings`

`GET` (`NoQueryDto`) → **200** `PlatformSettingsDto` from the one `platform_settings` row (seeded by
migration: `waha`, `sendpk`).

`PATCH` `{ defaultWhatsappProvider?: WhatsAppProvider, defaultSmsProvider?: SmsProvider }`
(`platform_default` is not a value here → `422`; `null` → `422`; a WhatsApp provider not enabled
on the deployment, §6.4 → `422 INVALID_VALUE` on `defaultWhatsappProvider`). Row locked. No change → `200`, no
audit. Takes effect for every school on `platform_default` on its next onboarding check and next
SMS leg — "change it for all schools at once". **200** `PlatformSettingsDto`. Platform audit
`platform_settings.updated { changes }`, `school_id` null.

### 6.3 `GET /platform/messaging/health` — paginated (R114)

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `whatsappStatus` | optional `pending \| connected \| down \| none` |
| `schoolStatus` | optional `SchoolStatus`; absent = all except `terminated` |
| `q` | `SearchField` 2–100: `name ILIKE` or `short_code` prefix |
| `sort` | `name` (default), `-name`, `-failedToday`, `-smsUsed`; `id` tiebreak |

Reads `schools` left-joined to `platform_delivery_health` (today's and yesterday's rows, Asia/Karachi
days) through `repositories/platform/delivery-health.repository.ts`. Never reads `messages`,
`message_deliveries` or `whatsapp_numbers`; never returns a body, a recipient or a phone number.
**200** `{ data: PlatformDeliveryHealthDto[], page, limit, total }`.

### 6.4 WhatsApp providers enabled on the deployment (`WHATSAPP_PROVIDERS_ENABLED`)

Environment key, a comma list of `waha`, `cloud_api`; unset or empty means both. A provider left
out: its driver refuses every send as `session_down` (permanent, so the guardian falls to SMS) and
fails every health check (a live row of it goes `down` once, with the usual alert); its webhook
routes (§8.2 for `waha`, §8.3 for `cloud_api`) answer `404 NOT_FOUND` before any verification, as if
not mounted; the platform cannot choose it (§6.1, §6.2: `422 INVALID_VALUE`); `GET
/platform/settings` lists the enabled ones (`enabledWhatsappProviders`) so the console greys the
others out. Production requires `WAHA_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET` only while `waha`
is enabled and `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` only while `cloud_api` is;
`FCM_SERVICE_ACCOUNT_JSON`, `SMS_API_KEY`, `SMS_SENDER_ID` and `PLATFORM_ALERT_EMAIL` stay required.

---

## 7. `NotificationService` — the internal contract (not HTTP)

### 7.1 Signature and guarantees

```ts
NotificationService.send<T extends MessageType>(
  schoolId: SchoolId,
  input: {
    type: T;
    subject: { type: MessageSubjectType; id: bigint };
    recipients: readonly Recipient[];      // { guardianId } | { staffId } | { studentId }
    vars: TemplateVars<T>;                 // typed per type; no phone, identity number or token
    body?: string;                         // announcement types only (free text)
    media?: { objectKey: string; mime: string }; // announcement types only
  },
): Promise<{ created: number; existing: number }>;
```

- **Must run inside the sender's `@Transactional()`**; outside one it throws (a programming error,
  tested). It writes one `messages` row per person, deduplicated by person within the call, with
  `INSERT … ON CONFLICT` on the per-person partial unique (`messages_subject_{guardian,staff,
  student}_key`) `DO NOTHING` — so a retried sender writes nothing new (R107). `existing` counts
  the conflicts.
- Per row: the body is rendered now (§7.5); the channel plan is computed now by the pure function
  `planChannels()` (§7.3) from the type, the person's capability class, `hasDevice`, `hasLogin`,
  `hasPhone`, `whatsappConnected`, `smsAllowed`, `hasVerifiedEmail`. The phone itself is **not**
  stored on the message; the processor reads the person's current phone at attempt time.
- Initial status: plan has an external leg → `queued`, and `{ schoolId, messageId }` is registered
  for enqueue **after commit** (R105); plan is `in_app` only → `sent`, `finished_at = now`, no job;
  plan empty → `suppressed` with the reason (§7.4) and one `suppressed` delivery row on the type's
  first channel, no job.
- No module imports a driver; `bullmq` only in `src/jobs/**` and `outbox-dispatcher.ts` (plan §0.11).
- A guardian whose row is merged is refused (`Error`, a sender bug): senders resolve survivors.
- Recipient-level rules that belong to the sender (who the guardians of a child are, R126's
  "primary contacts, else every live guardian with a login or a phone") stay in the sending slice.

### 7.2 Message types (normative; `packages/shared/src/messages.ts`)

| Type | Priority | Audience | Channels, in order | SMS by default | Subject type | Template owner |
|---|---|---|---|---|---|---|
| `absence_alert` | urgent | guardians of the student | whatsapp, sms · push | yes | `attendance_alert` | slice 11 |
| `late_advice` | normal | guardians | whatsapp · sms fallback · push | yes | `attendance_alert` | slice 11 |
| `attendance_corrected` | normal | guardians | whatsapp · sms fallback · push | yes | `attendance_alert` | slice 11 |
| `announcement_urgent` | urgent | audience | whatsapp + sms · push | yes | `announcement` | slice 14 |
| `announcement_normal` | normal | audience | whatsapp · push | **no** (eligible) | `announcement` | slice 14 |
| `holiday_notice` | normal | all guardians + staff (+ students with logins, in-app) | whatsapp · push · sms fallback | yes | `announcement` | slice 10 / 14 |
| `diary_posted` | low | guardians + students of the section | push · in-app | **never** | `diary_entry` | slice 13 |
| `remark_posted` | low | guardians of the student | push · in-app | **never** | `remark` | slice 13 |
| `register_unrecorded` | internal | principal + all-scope `attendance.student.mark` holders | push · email | — | `register_deadline` | slice 11 |
| `sms_cap_reached` | internal | every active principal | push · email | — | `sms_cap` (`id` = `YYYYMM`) | **slice 9** |
| `messaging_test` | normal | the caller (staff) | the requested channel (§5.1) | bypasses the allow list; counts against the cap | `messaging_test` (`id` = audit row id) | **slice 9** |
| `whatsapp_session_down` | platform | the platform alert mailbox | email | — | none (no `messages` row) | **slice 9** |

"SMS-eligible" = the first six rows; only they may appear in `smsAllowedTypes` (§4). The platform
default allow list is the five "yes" rows. Adding a sender without a row here is a compile error
(rule 12). Slice 10's cover push (R132) needs its own row, added by slice 10.

### 7.3 Routing matrix (normative; R106 — every cell has a test)

Predicates, evaluated at write time: **D** the person's user has a live device (§1.5 join) · **L**
the person has a login with the matching capacity · **W** the school's live WhatsApp row is
`connected` and the person has a phone · **P** the person has a phone (for SMS: a Pakistani mobile,
`+923…`) · **A** the type is in `smsAllowedTypes` · **E** a verified email (staff only).
Notation: `ch` = an always leg; `sms*` = an SMS leg that runs **only after the WhatsApp leg fails**
(§7.6); `(if X)` = present only when X; `in_app` marks inbox visibility and never produces a
delivery row.

| Person class | urgent | normal | low | internal |
|---|---|---|---|---|
| guardian, `whatsapp` | `whatsapp`(if W), `sms`(if P∧A), `push`(if D), `in_app`(if L) | W: `whatsapp`, `push`(if D), `in_app`(if L), `sms*`(if P∧A) · ¬W: `push`(if D), `in_app`(if L), `sms`(if P∧A) | `push`(if D), `in_app`(if L) | — |
| guardian, `smartphone_data` | `push`(if D), `sms`(if P∧A), `in_app`(if L) | `push`(if D), `in_app`(if L); `sms`(if ¬D∧P∧A) | `push`(if D), `in_app`(if L) | — |
| guardian, `keypad` | `sms`(if P∧A) | `sms`(if P∧A) | none → `suppressed: no_channel` | — |
| staff | `push`(if D), `sms`(if P∧A), `in_app`(if L) | `push`(if D), `in_app`(if L); `sms`(if ¬D∧P∧A) | `push`(if D), `in_app`(if L) | `push`(if D), else `email`(if E); `in_app`(if L) |
| student | `push`(if D), `in_app`(if L) | `push`(if D), `in_app`(if L) | `push`(if D), `in_app`(if L) | — |
| platform | — | — | — | `email` to `PLATFORM_ALERT_EMAIL` (no row) |

- "Urgent" sends WhatsApp **and** SMS together for a WhatsApp-capable guardian (R149), still
  subject to the allow list and the cap (R109). Every SMS leg re-checks the allow list as it
  stands at its attempt (a type removed since the write is `suppressed: not_allowed`); only
  `messaging_test` bypasses it. "Normal" sends SMS only after WhatsApp fails its
  attempts (R112) — or as the primary when the school's number is not connected. "Low" never
  leaves the app (R138).
- A WhatsApp-capable guardian while the school's number is `down`, `pending` or absent is routed as
  the ¬W column: **straight to the fallback** (R112).
- Students never receive WhatsApp, SMS or email (the phone on record is a guardian's).
- Cap is **not** a plan input: it is checked atomically when an SMS leg runs (§7.7). R106's test
  includes `capRemaining = 0` cells and asserts the leg ends `suppressed: cap_reached`.
- `channel_plan` stores the legs in order. A leg's trigger is derived, never stored: `sms` after
  `whatsapp` in a `normal` plan is the after-failure leg; every other leg is always.

### 7.4 Suppression reasons

| Reason | Written when | Where |
|---|---|---|
| `not_allowed` | an SMS leg would be needed but the type is not in `smsAllowedTypes`: at write time when it removes the person's only external leg (keypad, ¬W normal), or when an `sms*` leg comes due | delivery row (channel `sms`); message-level when nothing else remains |
| `cap_reached` | an SMS leg runs and the atomic usage increment refuses (§7.7) | delivery row (channel `sms`); message-level when nothing else remains |
| `no_channel` | the plan has no leg at all (keypad + low; no device, no login, no phone) | one delivery row on the type's first channel; message-level |
| `backdated` | reserved for slice 11 (R126: a backdated absence sends nothing) | as slice 11 defines |

A suppression is always a delivery row with its reason (`message_deliveries.suppressed_reason`,
§13), so the school can see that a keypad parent never receives the diary, and why. A message is
`suppressed` only when **every** leg is; its `suppressed_reason` is the first suppressed leg's.
Suppression does not hide a message from the inbox.

### 7.5 Templates

- English only (rule 16), in code, one per type, parameterised by names, dates, times and the
  school's name. Bodies never contain an identity number, a token, a password, a phone number or an
  amount with paisa (rule 15; `messages_body_no_id_check`; R111).
- **Every SMS-eligible body starts with the school's name** (`"<School>: …"`; the mask shows as a
  shortcode on Telenor and Ufone). The name used is `schools.name` cut to **30 characters** at a
  word boundary.
- Rendered SMS text is normalised to GSM-7 (a non-GSM character is replaced by its nearest ASCII
  or dropped) so a stray character never turns a 160-character message into a 70-character UCS-2
  one. Every templated SMS-eligible body fits **one segment** with the longest fixture values (a
  30-character school name, 40-character person names) — a unit test per type (R110).
  Announcement SMS ≤ 3 segments is slice 14's (R110).
- Push payload: `{ type, subjectType, subjectId, messageId }` (strings), a title and the rendered
  body — nothing else (R173).
- Slice 9's templates:

| Type | Channel form | Text |
|---|---|---|
| `messaging_test` | WhatsApp / SMS / push body | `{school}: test message from ASMS, sent by {senderName} at {time}. No action needed.` Push title `Test message` |
| `sms_cap_reached` | push / email | Title `SMS allowance used up`. Body `{school} has used this month's {cap} SMS units. Further SMS are held until {nextMonthStart} or until the platform raises the allowance.` |
| `whatsapp_session_down` | email (platform) | Subject `WhatsApp down: {schoolName} ({schoolId})`. Body `The health check failed at {time} with {errorCode}.` School name and id only (R112) |

### 7.6 The processor: legs, attempts, state machines

**Queue job** `message`, payload `{ schoolId, messageId }`, id `message:<messageId>:<round>` where
`round` = the number of `message_deliveries` rows of the message when enqueued (so a delayed retry
and a sweep re-enqueue of the same round collapse to one job). `schoolId` resolved by
`fromQueuePayload` (R113); every body runs in `runAsSchool`.

A **round**:
1. **Claim, first statement** (R105): `UPDATE messages SET status = 'sending', claimed_at = now()
   WHERE school_id = $1 AND id = $2 AND status = 'queued' RETURNING …`. Zero rows → the job ends
   successfully, no delivery (replayed, forged or already handled).
2. For each leg in plan order that is due and not finished, one attempt, **outside any
   transaction** for the driver call; its `message_deliveries` row (unique `(message, channel,
   attempt)`) is written right after. A leg is finished when it has an `accepted`, `delivered` or
   `suppressed` row, a permanent failure, or its attempt budget is spent.
3. Any leg unfinished → status back to `queued`, and a delayed job at the earliest due time. Else
   the terminal roll-up below, `finished_at = now`.

At-least-once: a crash between a provider's acceptance and the row write can repeat that attempt
after recovery; a lost message is worse than a rare duplicate.

**Attempt budgets:**

| Channel | Attempts | Spacing | Permanent failures (no retry; the leg ends) |
|---|---|---|---|
| `whatsapp` | 3 | 0, +5 min, +15 min (R112: three attempts over fifteen minutes) | `not_on_whatsapp`, `invalid_number`, `session_down` (no connected number at attempt time), `outside_window`, `rejected`, `auth_failed` |
| `sms` | 3 | 0, +2 min, +10 min | `invalid_number`, `dnd_blocked`, `rejected`, `auth_failed` |
| `push` | 2 | 0, +1 min | `unregistered_device` (every device of the user: those rows get `unregistered_at`, reason `fcm_unregistered`) |
| `email` | 3 | 0, +5 min, +30 min | `rejected` |

A WhatsApp leg that ends failed — after its attempts, permanently, or by a later `failed` report —
makes its `sms*` leg due at once (if A; else `suppressed: not_allowed`). WhatsApp sends on WAHA are
paced at **60 per minute per session** (Redis token bucket in the driver; a paced send is delayed,
not an attempt). SMS sending rate follows the vendor's answer to question 13 (§9). FCM multicasts
to every live device of the user: accepted when any device accepts.

**Message state machine:**

| From | To | By |
|---|---|---|
| (write) | `queued` / `sent` (in-app only) / `suppressed` (empty plan) | `send()` |
| `queued` | `sending` | the claim |
| `sending` | `queued` | round ends with a leg unfinished; or the outbox sweep, `claimed_at` older than 10 min (crashed worker) |
| `sending` | `delivered` · `sent` · `failed` · `suppressed` | terminal roll-up: any leg `delivered` → `delivered`; else any `accepted` → `sent`; else any `failed` → `failed`; else `suppressed` |
| `sent` | `delivered` | `message-rollup` after a delivered report |
| `sent` | `queued` | `message-rollup`: the accepted WhatsApp leg was reported `failed` and its `sms*` leg is now due |
| `sent` | `failed` | `message-rollup`: every accepted leg later reported `failed` and no leg remains |
| `delivered`, `failed`, `suppressed` | — | terminal |

**Delivery state machine** (R108; the database trigger enforces it):

| From | To | By |
|---|---|---|
| (insert) | `accepted` · `failed` · `suppressed` | the processor |
| `accepted` | `delivered` | WAHA ack ≥ 2, Meta `delivered`/`read` (§8), SMS poll |
| `accepted` | `failed` | WAHA ack −1, Meta `failed`, SMS poll, or **SMS with no final report 24 h after `attempted_at`** → `failed`, `no_report` |
| `delivered`, `failed`, `suppressed` | — | terminal; a later report is ignored (`204`) |

WhatsApp `accepted` with no report stays `accepted` (no give-up; silence never triggers SMS). FCM
and email report `accepted` only. The word "read" appears in no DTO: Meta `read` and WAHA ack 3/4
are recorded as `delivered` (rule 0.13).

### 7.7 Usage and the cap (R109)

- `message_usage (school_id, year_month, channel, sent_count)`, month in Asia/Karachi.
- **SMS:** before each SMS attempt, `INSERT … ON CONFLICT (school_id, year_month, 'sms') DO UPDATE
  SET sent_count = message_usage.sent_count + $segments WHERE message_usage.sent_count + $segments
  <= $cap RETURNING sent_count` — atomic, no lock. No row returned → the leg is `suppressed:
  cap_reached` (no send). Reserved segments are not refunded when the provider then fails (billing
  on submit or delivery is vendor question 8; the conservative choice never exceeds the cap). The
  cap is `schools.sms_monthly_cap`, read through `OwnSchoolRepository` at the attempt.
- **First `cap_reached` of the month:** in the same transaction as the suppressed row,
  `NotificationService.send(sms_cap_reached)` to every active principal with subject `{ sms_cap,
  YYYYMM }` — R107's unique makes it once per principal per month.
- **Other channels:** `sent_count + 1` on each accepted leg, no cap.

### 7.8 WhatsApp number lifecycle and health (R112)

| From | To | By |
|---|---|---|
| — | `pending` | `pair` (§5.4) |
| — | `connected` | `connect-cloud-api` (§5.5) |
| `pending` | `connected` | health check: WAHA session `WORKING` (sets `paired_at` if null, `last_healthy_at`) |
| `connected` | `down` | health check fails (WAHA `FAILED`/`STOPPED`/`SCAN_QR_CODE`, unreachable; Graph `401`) — `last_error_code` set; **one `whatsapp_session_down` email per transition** |
| `down` | `connected` | health check passes |
| `down` | `pending` | `pair` again (WAHA) |
| `pending\|down` (cloud) | `connected` | `connect-cloud-api` reconnect |
| any live | `disabled` | `disable` (§5.6); terminal for that row |

Health: repeatable `whatsapp-health-sweep` every **5 minutes**, fan-out per non-terminated school
(exception 3), checking the live row: WAHA `GET /api/sessions/{session}`; Cloud API one Graph read
of the phone-number id. The `session.status` webhook enqueues an immediate `whatsapp-health` job
for that school (§8.2). **Status is written only by the health job and the school routes** — never
by a webhook. Worker transitions are not audited (`audit_log` needs an actor); they are visible on
the row and in the rollup.

### 7.9 Outbox sweep (R105)

Repeatable `outbox-sweep` every **2 minutes**, fan-out per non-terminated school (index leads with
`school_id`), at most 500 rows per school per run, oldest first:
- `messages` `queued` with no activity for 2 minutes (`created_at`, `claimed_at` — a round the
  processor released keeps it — and the latest attempt all older than 2 min) → re-enqueue
  `message:<id>:<round>` (a still-pending delayed job of the same id is not duplicated);
- `messages` `sending` with `claimed_at` older than **10 minutes** → `queued`, re-enqueue;
- a delivery reported `delivered` or `failed` in the last 24 hours (and at least 2 minutes ago)
  whose message is still `sent` and was last rolled up before the report (`messages.updated_at`:
  the round's finish, or `message-rollup`'s own touch when it leaves a message `sent`) →
  `message-rollup`, id `rollup:<deliveryId>:<status>:s<minute>`: a webhook's or the poll's lost
  enqueue is recovered, and a report the rollup has seen is not re-enqueued;
- registered by later slices: `announcements` `scheduled` past their time (slice 14),
  `attendance_alerts` `pending` and due (slice 11).

A terminated school's queued rows are left as they are (its jobs would be dropped by R113).

### 7.10 SMS delivery poll (pull providers; Sendpk)

Repeatable `sms-delivery-poll` every **2 minutes**, fan-out per non-terminated school, each school's
batch in `runAsSchool`. Due rows: `channel = sms`, `status = accepted`, whose age since
`attempted_at` crosses a poll point **2, 10, 30, 120 minutes, then every 120 minutes** within this
run's window (`(plannedRunAt − 2 min, plannedRunAt]`, from the repeatable's planned time). A
missed run skips one poll, harmless. Budget: **100 status queries per school per run**, oldest
first; the rest wait for their next point. The reference is read from `poll_ref` (encrypted, §13)
and the provider's answer is mapped (§9) — forward-only, like a webhook (R172). Rows `accepted`
for more than **24 hours** → `failed`, `no_report`, with no query. A final status clears
`poll_ref`. Each changed row enqueues `message-rollup`.

### 7.11 Delivery-health rollup (exception 6)

Repeatable `delivery-health-rollup` every **15 minutes**, fan-out per non-terminated school. Per
school, upserts `platform_delivery_health (school_id, day, channel)` for **today** (and yesterday
until 01:00 Asia/Karachi): counts of the day's deliveries by status, `sms_used` (month to date from
`message_usage`), `sms_cap`, and the WhatsApp snapshot (`whatsapp_status`,
`whatsapp_last_healthy_at`, `whatsapp_last_error_code`; `none` when there is no live row). The
writer is the only `NAMED_EXCEPTION_SITES` entry for `delivery-health.repository.ts` outside
`modules/platform`.

### 7.12 Jobs at a glance

| Queue | Job | Id | Payload | Trigger |
|---|---|---|---|---|
| `messaging` | `message` | `message:<messageId>:<round>` | `{ schoolId, messageId }` | after commit; delayed retry; sweep |
| `messaging` | `message-rollup` | `rollup:<deliveryId>:<status>` (sweep recovery: `…:s<minute>`) | `{ schoolId, messageId }` | webhook, SMS poll, outbox sweep (§7.9) |
| `messaging` | `whatsapp-health` | `wa-health:<whatsappNumberId>:<minute>` | `{ schoolId, whatsappNumberId }` | `session.status` webhook |
| `scheduled` | `outbox-sweep` | repeatable, 2 min | none (in-process fan-out) | — |
| `scheduled` | `whatsapp-health-sweep` | repeatable, 5 min | none | — |
| `scheduled` | `sms-delivery-poll` | repeatable, 2 min | none | — |
| `scheduled` | `delivery-health-rollup` | repeatable, 15 min | none | — |
| `scheduled` | `staged-upload-sweep` | repeatable, daily 02:30 Asia/Karachi (moved from the HTTP process) | none | — |
| `scheduled` | `session-purge` | repeatable, daily 03:00 Asia/Karachi (§1.5) | none (fan-out over every school) | — |

Payloads are zod-validated strictly (`schoolId` and the id fields match `^[1-9][0-9]{0,18}$`, no
other key); a bad payload is **dropped**, not retried, and logged without ids. A payload naming
school B and a row of school A touches no row (the scoped claim finds nothing). The worker exposes
`GET /health` on `WORKER_HEALTH_PORT`: `200` when Postgres and Redis answer, else `503`, and no job
runs while Redis is down.

---

## 8. Webhooks (excluded from OpenAPI; documented only here)

### 8.1 `@Webhook(provider)` — common rules (R172)

- `rawBody: true` on the Nest app; the HMAC is computed over the **raw bytes** with the provider's
  secret and compared with `timingSafeEqual` (lengths checked first). Content type
  `application/json`, body ≤ 100 kB (→ `413`).
- Bad or missing signature → `401 WEBHOOK_SIGNATURE_INVALID`, **no `details`**, counted against the
  failed-verification bucket (§1.6). A verified body → **`204`** in every case: known reference,
  unknown reference (`204` plus a counter, never an insert), stale event, unparseable-but-signed
  body (`204` plus a counter; logged with the event name only). The response never echoes the body.
- A zod schema per provider picks **only** the fields used; everything else is discarded unread.
- Handlers never mint a `SchoolId` and never call a scoped repository: they call
  `DeliveryWebhookRepository` (§8.5) and enqueue `{ schoolId, … }` jobs that pass through
  `fromQueuePayload`.
- A route of a WhatsApp provider not enabled on the deployment (§6.4) answers `404` before the
  throttle and the signature check.
- Logs carry the provider, event name and outcome — never a body, number, chat id or reference
  (redact paths `*.to`, `*.from`, `*.chatId`, `*.body`, `*.text`, `*.phone`).

### 8.2 `POST /webhooks/waha`

Signature: `X-Webhook-Hmac` = hex HMAC-SHA512 of the raw body with `WAHA_WEBHOOK_SECRET`
(`X-Webhook-Hmac-Algorithm: sha512`). The header names and algorithm are verified against the WAHA
image pinned in slice 9 and recorded in `WORKLOG.md`. Window: the body's `timestamp` (ms, inside
the signed bytes) must be within **5 minutes** of now; outside → `204`, counter `stale`, no effect.

Fields picked:

```
{ event: 'message.ack' | 'session.status' | 'message' (others → 204, ignored),
  session: string,            // our waha_session
  timestamp: number,          // ms
  payload: { id?: string, ack?: number } }   // message.ack only; nothing else is read
```

| Event | Effect |
|---|---|
| `message.ack`, `ack` 2 (DEVICE), 3 (READ), 4 (PLAYED) | statement A → `delivered` |
| `message.ack`, `ack` −1 (ERROR) | statement A → `failed`, `rejected` |
| `message.ack`, `ack` 0 or 1 | ignored (already `accepted`) |
| `session.status` | statement B with `n = 0`; a returned school → enqueue `whatsapp-health` |
| `message` (inbound) | statement B with `n = 1` (counted and ignored; nothing stored) |

Correlation: `provider_ref_hash = SHA-256('whatsapp|' + payload.id)`, the id WAHA returned at send
(it embeds the recipient's number, which is why only the hash is stored).

### 8.3 `GET` and `POST /webhooks/meta` (WhatsApp Business Cloud API)

**`GET` (subscription handshake).** Query `hub.mode` = `subscribe`, `hub.verify_token`,
`hub.challenge` (`^[A-Za-z0-9_-]{1,128}$`); no other parameter. `hub.verify_token` equal
(`timingSafeEqual`) to `META_WEBHOOK_VERIFY_TOKEN` → **200** `text/plain` with the challenge; else
`401 WEBHOOK_SIGNATURE_INVALID`. This GET mutates nothing.

**`POST`.** Signature `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the raw body with
`META_APP_SECRET`. Meta sends no request timestamp, so there is no window; replay is harmless
because transitions are forward-only. Fields picked:

```
{ object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: string },
             statuses?: [{ id: string, status: 'sent'|'delivered'|'read'|'failed',
                           errors?: [{ code: number }] }],
             messages?: unknown[] } }] }] }      // inbound: only counted
```

| Item | Effect |
|---|---|
| status `delivered` or `read` | statement A → `delivered` |
| status `failed` | statement A → `failed`, error mapped: `131026` → `not_on_whatsapp`; `131047` → `outside_window`; `130429`, `131056` → `rate_limited`; `190` → `auth_failed`; other → `unknown` |
| status `sent` | ignored |
| `messages[]` (inbound) | statement B by `phone_number_id`, `n` = the array's length |

Correlation: `SHA-256('whatsapp|' + wamid)`.

### 8.4 SMS: no webhook in Phase 2

Sendpk is pull-only (owner's choice, research finding 3). **`POST /webhooks/sms/:provider` is not
mounted**: a route that can accept nothing is attack surface. Sendpk delivery is owned by the poll
job (§7.10). When a push-report SMS provider is added, it gets `@Webhook('sms')`, its own secret,
and — if it cannot sign — an edge allow-list of its published addresses (R172), forward-only.

### 8.5 Named exception 5 — `DeliveryWebhookRepository`

`src/repositories/platform/delivery-webhook.repository.ts`, tagged `$queryRaw`, listed in
`RAW_SQL_FILES`, importable only from `src/webhooks/**`, with its own isolation test. Exactly two
statement shapes:

- **A** `UPDATE message_deliveries SET status = $3, delivered_at | failed_at = now(), error_code =
  $4 WHERE channel = $1 AND provider_ref_hash = $2 AND status = 'accepted' RETURNING school_id,
  message_id, id` → enqueue `message-rollup`.
- **B** `UPDATE whatsapp_numbers SET inbound_ignored_count = inbound_ignored_count + $n WHERE
  <key> = $1 AND status <> 'disabled' RETURNING school_id, id`, where `<key>` is `waha_session`
  (WAHA) or `cloud_phone_number_id` (Meta) — two prepared variants of one shape.

Nothing else; zero rows returned → `204` and a counter. Each statement's `school_id` is branded
by `schoolIdFromDeliveryReport` (`src/tenancy/school-id.mint.ts`), called only here — the row was
just written by the server, matched by a globally unique key — so the webhook enqueues a typed
`SchoolId`; the job still resolves it again through `fromQueuePayload`.

---

## 9. Sendpk adapter — vendor answers required before the adapter is written

Fixed now (plan §3, research): HTTPS `POST` to `api/sms.php` with the API key **in the POST body**,
never a query string; a response of exactly `OK ID:<n>` is `accepted` with reference `<n>`;
**anything else is a hard failure** (mapped to `rejected`, or `auth_failed` if the text is the
documented key error), never retried as transient unless the vendor's answer to question 2 names a
transient form; delivery reports by **pull** (`api/delivery.php`), driven by §7.10; one
platform-owned **transactional** mask (`SMS_SENDER_ID`); `SMS_API_KEY` in `.env` only; absent
outside production → `LogSmsDriver` (R112). The reference is stored encrypted in `poll_ref` until
final, and hashed in `provider_ref_hash`.

The owner fills in the answers; the adapter is not written until each row has one.

| # | Question (research report) | Answer | Adapter consequence |
|---|---|---|---|
| 1 | HTTPS only? Can the API key go in the POST body or an `Authorization` header, not the query string? | *pending* — **assumed (adapter as built):** HTTPS; the key in the POST body (form-encoded `api_key`) | Refuse the vendor if the key must travel in a URL |
| 2 | Exact success response per message; is the returned ID stable and queryable later? Its format and length? | *pending* — **assumed:** exactly `OK ID:<n>`, `<n>` 1–64 of `[0-9A-Za-z_-]`, stable and queryable; no transient form, so any other text is a hard failure (a 5xx or a network error is `provider_unavailable` and retried) | Parse rule; `poll_ref` length; transient error forms |
| 3 | Delivery reports: callback URL? If yes: payload, statuses, retry policy, signature. If no: the status-query endpoint, response schema, retention, rate limit | *pending* — **assumed:** no callback; `POST api/delivery.php` with `api_key` and `id` in the body, answering a status word; 100 queries per school per run; give-up 24 h | §7.10 query shape, budget per run, give-up time |
| 4 | Which statuses exist (submitted / delivered / failed / expired / DND-blocked); handset receipts on all four networks? | *pending* — **assumed mapping** (case-insensitive word): `delivered` → `delivered`; `undelivered` / `failed` / `rejected` → `failed: rejected`; `expired` → `failed: expired`; `dnd` / `dncr` / "do not disturb" → `failed: dnd_blocked`; "invalid number" → `failed: invalid_number`; anything else → still pending (`sendpkStatus` in `src/messaging/drivers/sms.ts`) | Status → `DeliveryStatus` / `DeliveryErrorCode` mapping table, written here |
| 5 | On Telenor and Ufone, does the registered mask appear, or a shortcode? | *pending* | Confirms "school name in every body" (already required) |
| 6 | Are content templates pre-approved (operator "fixed SMS"), is `template_id` mandatory, turnaround, variables allowed? | *pending* | Whether §7.5 templates need registration; announcement SMS feasibility |
| 7 | Mask registration: documents, fee, renewal, turnaround, the three-month inactivity rule; transactional registration? | *pending* | Keep-alive need; go-live date |
| 8 | Billed on submit or on delivery? Failures refunded? | *pending* — **assumed:** billed on submit; no refund (reserved segments are not returned) | §7.7 refund rule (now: no refund) |
| 9 | Does unused credit expire, and when? | *pending* | Operational note only |
| 10 | Sandbox or `test_mode`? | *pending* — **assumed:** none; real calls only in `drivers.contract.spec.ts` under `RUN_DRIVER_TESTS=1` | Driver contract tests under `RUN_DRIVER_TESTS=1` |
| 11 | Direct operator routes or via another aggregator (grey route)? In writing | *pending* | Go / no-go |
| 12 | How are segments counted and charged for a 200-character English message? | *pending* — **assumed:** GSM-7, 160 in one segment, 153 per part (`smsSegments`) | §7.7 segment counting (now: GSM-7 160 / 153) |
| 13 | Sending rate limit; a burst of 2,000 absence alerts at 09:30 — queued or rejected? | *pending* — **assumed:** no vendor limit; the adapter sends at the worker `messaging` concurrency (10) | SMS pacing in the driver (§7.6) |
| 14 | Multiple masks on one account (platform now, per-school later)? Per-mask fee? | *pending* | Future per-school mask |
| 15 | Is DNCR applied to transactional traffic, and is the reject reason returned? | *pending* — **assumed:** a DND reject comes back from the delivery query as a `dnd` / `dncr` word (mapped in row 4) | `dnd_blocked` mapping |

Also to record with the answers: the number format the API expects (`92XXXXXXXXXX` assumed; the
driver converts from E.164) and the `mobile` field's batch behaviour (one number per request
assumed).

**Status (slice 9 part A, 2026-10-04).** The adapter is written on the assumptions marked above
(owner's instruction: build now and record the assumptions; nothing in the code is a TODO). Each
assumption is isolated in `src/messaging/drivers/sms.ts` (`sendpkSendOutcome`, `sendpkStatus`, the
POST field names `api_key`, `sender`, `mobile`, `message`, `id`) and pinned by
`src/messaging/legs.spec.ts`. A vendor answer that differs changes that file and its test only.

---

## 10. Lifting Phase 1 R80 — suspended schools are no longer read-only

**Decision (owner's answer to item 13, 2026-10-03: "not to disturb anything").** A `suspended`
school works exactly like an `active` one until the platform terminates it. Suspension is a
platform-visible flag and a banner in the school console, nothing else.

Consequences, all in slice 9:
- `RouteAccessGuard` loses the suspended-school branch (`route-access.ts`, the R80 block). **The
  `@AllowWhenSuspended()` marker, its metadata key and its router-enumeration test are deleted**;
  `slice-2.md` §1.3's set (logout, change-email, change-password, user disable, office reset)
  becomes moot, and so does the plan's addition of `POST /me/devices` to it.
- `SCHOOL_SUSPENDED` stays in `ErrorCode` (a code is never removed or reused) and is marked
  retired; it is removed from `@ApiErrors()`'s common responses (OpenAPI regenerated; clients
  regenerated) and from the web client's handling. A grep test: no file under `apps/api/src`
  references `ErrorCode.SCHOOL_SUSPENDED`.
- **The R80 tests invert:** (a) in a suspended school, a representative non-GET per module (a
  class create, an admission, a grant, a settings patch, a test message) succeeds; (b) the
  enumeration test becomes "no route answers `SCHOOL_SUSPENDED`"; (c) login and `GET /me` work and
  `me.school.status = 'suspended'`; (d) the worker runs a suspended school's jobs exactly as an
  active school's (R113); (e) `terminated` is unchanged — every session `401`, every job dropped.
- The web `(school)` layout shows a persistent banner when `me.school.status = 'suspended'`
  ("This school's subscription is suspended. Contact the platform."); the mobile app shows none in
  Phase 2. The platform's change-status dialog copy changes from "read-only" to "the school keeps
  working; a banner is shown".
- Documents that become false and must be amended (`docs-maintainer`): Phase 1 plan §3.5's
  "Suspended school = read-only" bullet and R80 (mark "lifted by Phase 2 slice 9"); `slice-1.md`
  §4.5's effect paragraph and the `trial → suspended` "frozen read-only" note; `slice-2.md` §1.1
  step 6, §1.3, and §3.1's "(read-only follows)"; the "common errors" lines of `slice-4.md` to
  `slice-7.md`, the plan's §6 conventions and the controller header comments that list
  `SCHOOL_SUSPENDED`; plan §4.7's "a suspended school's teacher must not retry forever"; and
  `CLAUDE.md` when the owner's §1.2 answers become settled rules.

---

## 11. Error codes

New (groundwork §6.1, used here):

| Code | Status | Where |
|---|---|---|
| `UPGRADE_REQUIRED` | 426 | app-version floor — `details.minimumVersion` (R161) |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | webhooks, no details (R172) |
| `BEARER_SESSION_REQUIRED` | 409 | `POST /me/devices` on a cookie session |
| `CONTACT_PHONE_MISSING` | 409 | `POST /messaging/test` (and later senders) |
| `SMS_CAP_EXCEEDED` | 409 | `POST /messaging/test` with `sms` — `details: { cap, used }` |
| `WHATSAPP_ALREADY_CONNECTED` | 409 | pair, connect-cloud-api |
| `WHATSAPP_NUMBER_MISSING` | 409 | first pairing without `phone`; test on `whatsapp` with no live number |

New in this contract (add to the groundwork list):

| Code | Status | Where |
|---|---|---|
| `WHATSAPP_PROVIDER_MISMATCH` | 409 | pair / connect on the wrong effective provider, or over a live row of the other provider — `details.provider` |
| `WHATSAPP_VERIFICATION_FAILED` | 409 | connect-cloud-api — `details.reason ∈ {token_rejected, not_found, number_mismatch, number_in_use}` |

Reused: `AUTH_FAILED`, `AUTH_REQUIRED`, `ORIGIN_REJECTED`, `PERMISSION_DENIED` (with
`details.reason ∈ {target_is_principal, target_exceeds_actor}`), `NOT_FOUND`, `VALIDATION_FAILED` /
`INVALID_VALUE` / `UNKNOWN_FIELD`, `SELF_ACTION_FORBIDDEN`, `CURRENT_PASSWORD_INCORRECT`,
`EMAIL_NOT_VERIFIED`, `SCHOOL_TERMINATED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`,
`PAYLOAD_TOO_LARGE`. Retired: `SCHOOL_SUSPENDED` (§10). Not used until slice 14: `SMS_TOO_LONG`.

## 12. Audit actions

School `audit_log`:

| Action | Subject | Actor | Reason | Metadata |
|---|---|---|---|---|
| `user.login_on_default_password` | user | user | — | `{ afterOfficeReset, channel }` (adds `channel`) |
| `user.password_changed` | user | user | — | `{ channel }` (adds `channel`) |
| `user.sessions_revoked` | user | user | — | `{ revoked }`; only when `revoked > 0` |
| `user.signed_out_everywhere` | user | caller | required | `{ revoked }`; only when `revoked > 0` |
| `school_settings.updated` | school_settings | caller | — | `{ changes }`; arrays comma-joined |
| `messaging.test_sent` | user (the caller) | caller | — | `{ channel }` |
| `whatsapp.pairing_started` | whatsapp_number | caller | — | `{ whatsappNumberId, firstPairing }` — one row per QR issued |
| `whatsapp.cloud_api_connected` | whatsapp_number | caller | — | `{ whatsappNumberId, reconnected }` |
| `whatsapp.disabled` | whatsapp_number | caller | required | `{ whatsappNumberId, provider, fromStatus }` |

Platform `platform_audit_log`: `school.updated { changes }` (gains the three messaging fields);
`platform_settings.updated { changes }` (`school_id` null).

Not audited, by classification in the R57 route table: `POST /auth/logout`, `POST /me/devices`,
the webhooks (no actor; counters only) and worker transitions (visible on the rows and the
rollup). No audit row carries a phone number, token, QR, push token or message body.

## 13. Schema notes for `data-architect` (beyond plan §5)

1. `messages.claimed_at timestamptz(3)` nullable — the stale-`sending` recovery (§7.9).
2. `message_deliveries.suppressed_reason suppression_reason` nullable, `CHECK ((status =
   'suppressed') = (suppressed_reason IS NOT NULL))`; `to_masked` nullable (push, in-app).
3. `message_deliveries.poll_ref` text nullable, AES-256-GCM (AAD
   `schoolId|message_deliveries|poll_ref`), set only for pull-report channels and cleared on a
   final status; the append-only trigger allows `poll_ref` to change only to NULL. The plan's
   "hash only" rule cannot serve a pull provider, which must present the reference to query it;
   encrypted storage keeps the scanner and the R111 intent intact.
4. `whatsapp_numbers.cloud_phone_number_id varchar(32)` stored **in clear** (a Meta identifier,
   not a credential; it must be unique and searchable for exception 5); only `cloud_access_token`
   is encrypted. The plan listed both as encrypted, which contradicts its global unique.
5. `platform_delivery_health` gains `whatsapp_last_healthy_at`, `whatsapp_last_error_code`.
6. `devices.session_id` is updatable (rotation on password change moves it, §3.4); `push_token`,
   `app_version`, `platform`, `last_seen_at`, `unregistered_*` updatable; `user_id` frozen.
7. `platform_settings` has `updated_at`; one row, seeded (`waha`, `sendpk`); a `CHECK (id = 1)`.
8. `message_usage.sent_count` counts SMS **segments** for `sms`, accepted legs otherwise.
9. `whatsapp_numbers.paired_by` is set at the pairing request; `paired_at` when first `connected`.

## 14. Screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| `(school)` layout | `GET /me` | Suspended banner from `school.status` (§10) |
| Account | `POST /me/sessions/revoke-others` | "Sign out all other devices", confirm; shows the count |
| Users list / user detail | `POST /users/:id/sign-out-everywhere` | Confirm-with-reason dialog; hidden on the caller's own row; `403` reasons shown as for reset |
| School settings | `GET\|PATCH /school/settings` | New sections: attendance (periods, off days, window, deadline, alert time, late and leave rules with the cutoff field shown only for `absent_after_cutoff`), remarks |
| Messaging settings | `GET /messaging/whatsapp`, `/pair`, `/connect-cloud-api`, `/disable`, `GET /messaging/usage`, `PATCH /school/settings` (`smsAllowedTypes`), `POST /messaging/test` | WhatsApp card by `effectiveProvider` (QR with countdown and status polling; or the Cloud API form); provider-mismatch notice; SMS allow list as checkboxes of the six eligible types with the three "never" types shown disabled; usage this and last month with the cap read-only ("set by the platform"); test buttons per channel |
| Platform → school detail | `PATCH /platform/schools/:id` | Messaging knobs: SMS cap, WhatsApp provider, SMS provider |
| Platform → settings | `GET\|PATCH /platform/settings` | Defaults for all schools, with "applies to every school on platform default" |
| Platform → delivery health | `GET /platform/messaging/health` | Table: school, WhatsApp status and last healthy, today and yesterday per channel, SMS used / cap, computed at; filters and sorts as §6.3 |
| Mobile (slice 15) | `POST /auth/login` (`channel: bearer`, presenting the old token), `GET /me`, `POST /me/devices`, `POST /auth/logout`, `POST /me/change-password` | Token in the secure store only; `426` → update screen; replace the token from a change-password response before anything else |

---

## Decisions made here

1. **R80 is lifted** (owner, item 13): `@AllowWhenSuspended` and its test are deleted, R80's tests
   invert, `SCHOOL_SUSPENDED` is retired but kept in the enum (§10).
2. **`POST /me/change-password` returns `LoginResultDto`** (MeDto + `bearerToken`) rather than the
   plan's bare `{ token, expiresAt }`: one response shape for login and rotation, additive to the
   slice-2 `MeDto`, and `sessionExpiresAt` already carries the expiry. The device moves to the new
   session.
3. **Idle is computed per resolution from channel and current capacities**; only the absolute
   lifetime is fixed at mint. No column.
4. **A bearer login with `Origin` or a school cookie is `401 AUTH_FAILED`** with the credential
   failure's identical body, not counted toward lockout. Ordinary bearer requests with `Origin` are
   `401 AUTH_REQUIRED`.
5. **R166's "per session" `/me/*` throttle is keyed per user** (`perUserThrottle` as it exists):
   stricter, one mechanism.
6. **`whatsapp_session_down` goes to one ops mailbox, `PLATFORM_ALERT_EMAIL`**, not to every
   platform user: reading `platform_users` from the worker would need a new named exception. No
   `messages` row (there is no tenant person).
7. **The pairing QR is shown to the principal** (owner's item 17), not "to a platform admin" as
   plan §3's WAHA row still says; every QR issued is audited.
8. **Webhooks never write WhatsApp status**: a `session.status` event only triggers an immediate
   health check, which asks the provider. A forged-but-signed or stale event cannot flip routing.
   Exception 5 keeps two statement shapes; the second has a WAHA and a Meta key variant.
9. **`POST /webhooks/sms/:provider` is not mounted** in Phase 2 (Sendpk is pull-only);
   `WebhookProvider` is `'waha' | 'meta'`.
10. **The live row's provider wins for sending**; the school's effective provider only governs
    onboarding. A platform switch never breaks a working number; re-onboarding is the school's
    step. Two new codes: `WHATSAPP_PROVIDER_MISMATCH`, `WHATSAPP_VERIFICATION_FAILED`.
11. **Cloud API always sends approved utility templates** (`asms_<type>_v<n>`); the 24-hour window
    is not tracked.
12. **The SMS cap counts segments**, reserved before each attempt and not refunded on provider
    failure, until vendor question 8 is answered.
13. **`messaging_test` is a message type** (rule 12) whose subject is its audit row; it bypasses the
    allow list and counts against the cap; push with no device is a visible `no_channel`
    suppression rather than a `409`.
14. **Routing for staff and students** (the plan's matrix covers guardians only): staff are routed
    like `smartphone_data` with email as the internal-type fallback; students get push and in-app
    only, never WhatsApp, SMS or email.
15. **`in_app` is a plan marker, never a delivery row**; an in-app-only message is `sent` at write.
    Suppression never hides a message from the inbox.
16. **Retries are delayed jobs with round-numbered ids**, not BullMQ `attempts`; a stuck `sending`
    row returns to `queued` after 10 minutes (needs `messages.claimed_at`). Delivery is
    at-least-once.
17. **WhatsApp silence never triggers SMS**; only a failure does. SMS without a final report fails
    `no_report` at 24 hours.
18. **The SMS poll is stateless**: due rows are found by age against fixed poll points per run
    window; the provider reference is stored encrypted in `poll_ref` because a pull provider needs
    it back (§13.3).
19. **`cloud_phone_number_id` is stored in clear** (§13.4); the plan's "encrypted" contradicted its
    global unique index.
20. **Delivery health uses day buckets** (`today`, `yesterday`, sort `-failedToday`) instead of the
    plan's `last24h`, because the rollup table is per day; the WhatsApp snapshot fields join the
    rollup (§13.5).
21. **`GET /messaging/whatsapp` returns `WhatsAppSettingsDto`** (`effectiveProvider` + the live row
    or null); connect and disable return the same; pair returns only the QR and the screen
    re-reads. Disable with no live row is `200`, no audit.
22. **Sign-out-everywhere and revoke-others return `{ revoked }`** and audit only when something was
    revoked (as disable on a disabled user).
23. **The school name in SMS is `schools.name` cut to 30 characters** at a word boundary, so the
    one-segment test is satisfiable; a per-school "SMS name" setting is a later decision if 30 is
    too short.
24. **`MeAssignmentDto` carries `subjectId`/`subjectName` and `academicYearId`** beyond the plan's
    list: the diary composer (slice 16) needs the subject of a subject-teacher row.
25. **The session purge deletes a purged session's device rows first**: devices reference sessions
    with no cascade. Device rows are push addresses, not history (main thread, 2026-10-04, wave-D
    finding A2): `devices_no_delete` and `devices_no_truncate` are dropped; the purge is the only
    delete.
26. **`WHATSAPP_PROVIDERS_ENABLED`** (security finding M1, §6.4): a deployment that runs one
    WhatsApp provider needs none of the other's credentials, and the other's webhook is not
    reachable; a disabled provider is refused, never silently swapped.
27. **A lost `message-rollup` is recovered by the outbox sweep** (finding L6, §7.9), with
    `messages.updated_at` as the "last rolled up" mark: no new column, and a report the rollup
    has evaluated is never re-enqueued.
