# Slice 14 contracts — announcements, the audience picker, the holiday switch, the inbox

**Author:** api-designer, 2026-10-04. **Binds:** `apps/api/src/modules/announcements/**` (new:
announcements, audiences, recipients, preview, delivery summary, the sender attachment routes),
`modules/me/inbox.controller.ts` + `inbox.service.ts` (new: `GET /me/inbox*`),
`repositories/{announcement,announcement-audience,announcement-recipient,inbox}.repository.ts`
(new), `repositories/message.repository.ts` (`title`, the recipient back-fill statement),
`messaging/notification.service.ts` + `types.ts` (`title`, `dedupePhones`, the two announcement
`TemplateVarsMap` entries become `Record<string, never>`), `messaging/message-processor.ts`
(push/email title from the row, WhatsApp media, the SMS attachment line), `messaging/drivers/**`
(`sendMedia`), `messaging/delivery-sweeps.ts` + `jobs/**` (the `announcement-send` job and the
sweep source reserved in `slice-9.md` §7.9), `modules/calendar/holidays.service.ts` (publish and
cancel switch to announcements, R151), `modules/auth/dto.ts` + `me.service.ts`
(`MeDto.capabilityScopes`), `packages/shared/src/announcements.ts` (the audience helpers),
`apps/web/app/(school)/announcements/**`, `apps/web/components/audience-picker/**` (shared with
Phase 3 charge campaigns), the mobile `announce` tab and inbox screens (slice 16 consumes; this
contract is their server side). **Sources:** `CLAUDE.md` (rules 2, 4, 13, 16, 17; conventions),
`phase-2-daily-operations.md` §0.11–0.14, §1.1 item 22, §4.2 (message types, routing, the inbox
paragraph), §4.3, §4.7, §5 "Announcements", §6 slice 14, R105–R111, R143–R152, R164–R166, R171,
R173; `docs/announcements-concept.html` slides 02–04 (the only spec for the fields, the
sender-rights matrix, the audience picker and the once-per-person rule; its channel policy is
void); `slice-9.md` §1.6–1.7, §2.2, §3.3, §4, §7 (`NotificationService`, routing matrix, segments,
cap, delivery rows, §7.9's reserved sweep source), §6.3 and R114 (the platform never reads
messages); `slice-10.md` §4.5–4.7 (holiday publish and cancel, the wave-D notice path this slice
replaces), §7; `slice-6.md` §6 (`Idempotency-Key`, uploads, streaming); `slice-13.md` §1.2 (the
capacity scope and `/me` routes), §3 (the key mechanism restated), §4.5 (stored thumbnails), §7
(`POST /uploads` already admits both announcement capabilities); `slice-15.md` §6 (tab
composition: `announce` needs `.school`), §8 (push deep-links to `/inbox/[messageId]`). Everything
not restated follows Phase 1 §3.9, `slice-1.md` (envelope, `422 VALIDATION_FAILED` with
`details.fields`, string ids, camelCase, `NoQueryDto`, `PageQueryDto` capped at 50, `@ApiErrors()`,
`@IdParam()`), `slice-2.md` §1 and `slice-9.md` §1 (access decorators, pipeline, throttles). Paths
are under `/api/v1`. Dates are `YYYY-MM-DD` calendar dates in the school's timezone (R53); "today"
is `SchoolClock.today`; instants are ISO-8601 datetimes.

**What the built code already has** (verified 2026-10-04): the `MessageType` values
`announcement_urgent`, `announcement_normal`, `holiday_notice` and their `MESSAGE_TYPE_TABLE` rows
(subject type `announcement` allowed on all three); `MESSAGE_SUBJECT_TYPES` includes
`announcement`; `messages.media_object_key` (never written yet); `SendInput.body` and `.media`
accepted by `NotificationService.send` (body stored as given; media stored, never sent — the
processor has no media path); `TemplateVarsMap.announcement_*` are `never` (compile-time "not
written"); the capabilities `announcement.send.scope` (teacher and office default) and
`announcement.send.school` (principal); `IDEMPOTENT_ENDPOINTS` includes `announcements`; error
codes `ANNOUNCEMENT_SENT`, `ANNOUNCEMENT_CANCELLED`, `ANNOUNCEMENT_NO_RECIPIENTS`, `SMS_TOO_LONG`,
`SMS_CAP_EXCEEDED`; the shared enums in `packages/shared/src/announcements.ts`
(`ANNOUNCEMENT_CATEGORIES`, `_PRIORITIES`, `_STATUSES`, `AUDIENCE_KINDS`, `AUDIENCE_ROLES`);
`holidays.announcement_id` (nullable, no FK, allowlisted); `POST /uploads` widened (R171);
`CAPABILITY_SCOPES` and `EffectiveLine.scope` in the access module. **Not built:** the four
announcement tables, their enums, every route here, the inbox, `MeDto.capabilityScopes`. §11 lists
the migration.

**Fix round, 2026-10-04 (wave F review).** Send now and the holiday notice no longer write their
messages inside the request: a cold run at 3,000 recipients answered `500` (P2028, the 15 s
interactive-transaction limit) at 23.7 s. The request validates, checks scope and the SMS limits,
commits the row `sending` and returns it; the `announcement-send` job resolves and writes after
commit. This **reverses decision 9** (recorded there) and changes §2.1, §4.4, §4.5, §5.1, §5.5,
§5.6, §6.1, §6.2, §10 and §11 (item 11) below. Also: scheduling re-checks scope (§5.5 step 3), the
job claims on its due time (§5.6), a send that keeps failing stops (decision 25), and phone
dedupe keeps the phone with the sharer whose plan carries a phone leg (§4.4).

---

## 1. Access and scope

### 1.1 Routes

| Route | Decorator | Row rule (the service) |
|---|---|---|
| `GET /announcements`, `GET /announcements/:id` | `@RequireCapability(ANNOUNCEMENT_SEND_SCHOOL, ANNOUNCEMENT_SEND_SCOPE)` (any of) | `.school` held → every row of the school; else rows with `created_by = caller` (filtered in the query); anything else → `404` |
| `POST /announcements` | same | audience rule §4.2 on every item; `Idempotency-Key` required (§3) |
| `POST /announcements/preview-audience` | same; `AnnouncementPreviewThrottleGuard` | audience rule §4.2; writes nothing |
| `PATCH /announcements/:id`, `POST /announcements/:id/send`, `POST /announcements/:id/cancel`, `GET /announcements/:id/delivery`, `GET /announcements/:id/attachment`, `…/thumbnail` | same | row visible (above) → else `404`; **then** creator or `.school` holder — a `.scope` holder only ever sees their own rows, so this second test can refuse nobody who passed the first; it is stated so a later widening of the read rule cannot widen the write rule by accident |
| `GET /me/inbox`, `GET /me/inbox/:id`, `GET /me/inbox/:id/attachment`, `…/thumbnail` | `@AuthenticatedOnly()`, `MeReadsThrottleGuard` | the message is addressed to one of the caller's persons (§7.1), else `404` |

**One-sentence rules.** A staff member may compose, edit, send and cancel announcements whose
every audience target lies inside what their `announcement.send.*` capability reaches —
`announcement.send.school` reaches the whole school and the staff, `announcement.send.scope`
reaches the classes, sections, students and guardians of their own scope — and reads their own
announcements, or every announcement with `.school`; a signed-in person reads the messages
addressed to them. The platform reads none of it (R114, wave-D security review): no platform route
touches `announcements`, `announcement_*` or `messages`; `GET /platform/messaging/health` keeps
reading the rollup only, and the lint boundary that confines `repositories/platform/**` to
`modules/platform/**` gains its mirror for this slice's repositories — importable from
`modules/announcements/**`, `modules/me/**`, `modules/calendar/**` and `jobs/**` only.

Who holds what by default (`SYSTEM_ROLE_DEFAULTS`; concept slide 02): principal both keys;
office staff `.scope` **with `all` scope** (a school-wide source), so the office targets any class,
section, student or guardian but not `everyone`, `parents`, `students`, `staff` or a staff member
until granted `.school` ("If granted"); teacher `.scope` with `assigned_sections` scope ("own
classes only"). A principal grants `.school` to an office administrator without making them a
principal (slide 02's last line) through the slice-7 grant screen.

Common errors on every route: `401 AUTH_REQUIRED` · `403 PERMISSION_DENIED` · `403
ORIGIN_REJECTED` (cookie non-GET) · `426 UPGRADE_REQUIRED` (bearer) · `429 RATE_LIMITED`. Every
`:id` resolves in the session's school and inside the caller's visibility only; absent, malformed,
another school's or invisible → `404 NOT_FOUND`, identical body.

### 1.2 The sender's scope

The guard binds today's scope (`scopeOf(session)`, `canAny` over the two keys): `all` when either
held key has a school-wide source, else the teacher's sections active today. **Announcements use
today's scope only** — there is no dated scope here: an announcement is sent now or later, never
about a past date, and a cover teacher may announce to the covered section for exactly the days
the cover row is live. Whether broad kinds are allowed is a separate test on the **held key**, not
on the scope: `everyone | parents | students | staff | staff_member` need `announcement.send.school`
in `access.capabilities` → else `403 PERMISSION_DENIED`, `details.reason = 'audience_requires_school'`
(new reason value, plan slice 14). An office clerk with `all` scope and only `.scope` is therefore
refused `everyone` with `403` — the kind is visible to them as a concept, so `404` would be wrong.

### 1.3 Throttles

| Bucket | Limit | Key |
|---|---|---|
| `POST /announcements/preview-audience` (`AnnouncementPreviewThrottleGuard`, `perUserThrottle('announcement-preview', 30, 300)`) | 30/min, 300/hour | school + user — it walks the school |
| `GET /announcements/:id/attachment`, `…/thumbnail` (the shared per-user files guard, bucket `announcement-files`, as slice 13's `diary-files`) | 120/min, 2,000/hour | school + user |
| `GET /me/inbox*` | `me-reads` (120/min, 2,000/hour) | school + user |
| everything else | the global per-IP throttler | IP |

### 1.4 Lock order (whole system after slice 14)

`slice-13.md` §1.5's chain, extended: `… → holidays` (slice 10's publish lock) → **`announcements`
row → `announcement_recipients` → `announcement_recipient_students` → `messages`**
(`NotificationService`) → `message_deliveries`. `idempotency_keys` is the first statement of the
create transaction and locks nothing else. A send locks exactly one announcement row (`FOR UPDATE`)
and takes no lock on students, guardians, staff, classes or sections: membership is read, and the
per-person partial uniques (R107 on messages, §11 item 3 on recipients) settle a race. The
`announcement-send` job's claim is a conditional `UPDATE` (§5.6). No path takes a holiday row after
an announcement row.

### 1.5 Text normalisation (R111, R139's precedent)

| Field | Rule |
|---|---|
| `title` | `NoticeTextField(1, 120)`: trimmed, whitespace runs collapsed, no control characters, **no identity number, no phone number** — it reaches every phone |
| `body` | `NoticeTextField(1, 1800)`: as `title` but line breaks kept (`\n` only; `\r` dropped); **1,800, not the plan's 2,000** (decision 6: the stored message body is `"{school}: {title}\n{body}"` and `messages.body` is 2,000) |
| `reason` (cancel) | `TextField(3, 500)`, normalised |

`announcements_title_no_id_check`, `announcements_body_no_id_check` CHECKs back the service.

---

## 2. Shapes

### 2.1 Enums (`packages/shared/src/announcements.ts`, existing; `enum` + `enumName` on every DTO use)

| Enum | Values |
|---|---|
| `AnnouncementCategory` | `holiday \| exam \| fee \| event \| general` |
| `AnnouncementPriority` | `normal \| urgent` |
| `AnnouncementStatus` | `draft \| scheduled \| sending \| sent \| cancelled` — `sending` is observable since the fix round (decision 9, reversed): a send now or a holiday notice is committed `sending` by its request and becomes `sent` when the `announcement-send` job has written its messages, normally within seconds |
| `AudienceKind` | `everyone \| parents \| students \| staff \| class \| section \| student \| guardian \| staff_member` |
| `AudienceRole` | `parents \| students` |
| `InboxItemKind` *(new)* | `announcement \| notice` |
| `CapabilityScope` (existing, `capabilities.ts`) | `all \| assigned_sections` |

Database enums added by §11: `announcement_category`, `announcement_priority`,
`announcement_status`, `audience_kind`, `audience_role`; `suppression_reason` gains
`duplicate_phone` (§4.4). `SUPPRESSION_REASONS` in `messages.ts` gains the same value.

New shared helpers, one definition for API, web and app (pure, unit-tested):

```ts
/** Kinds that need announcement.send.school (plan slice 14; concept slide 02 "whole school"). */
export const SCHOOL_WIDE_AUDIENCE_KINDS = ['everyone', 'parents', 'students', 'staff', 'staff_member'] as const;
/** Kinds that take a targetId. */
export const TARGETED_AUDIENCE_KINDS = ['class', 'section', 'student', 'guardian', 'staff_member'] as const;
/** Kinds that take roles (default both). */
export const ROLE_AUDIENCE_KINDS = ['class', 'section', 'student'] as const;
/** The message type an announcement travels as (holiday notices keep their own allow-list entry). */
export const messageTypeOf = (a: { priority: AnnouncementPriority; holidayId: string | null }): MessageType =>
  a.holidayId !== null ? 'holiday_notice' : a.priority === 'urgent' ? 'announcement_urgent' : 'announcement_normal';
/** Why `audiences` is not acceptable, or null: the API's 422 rules of §4.1, for the picker to refuse early. */
export function audiencesProblem(audiences: readonly AudienceInput[]): { index: number | null; reason: 'empty' | 'too_many' | 'everyone_not_alone' | 'target_forbidden' | 'target_required' | 'roles_forbidden' | 'roles_empty' | 'duplicate' } | null;
/** Collapses duplicates, drops everything when `everyone` is present, sorts by kind then target. */
export function normaliseAudiences(audiences: readonly AudienceInput[]): AudienceInput[];
export const ANNOUNCEMENT_BODY_MAX = 1800; export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_SMS_MAX_SEGMENTS = 3;
```

### 2.2 DTOs

`AudienceInputDto` (request; `AudienceInput` in shared):

| Field | Rules |
|---|---|
| `kind` | required `AudienceKind` |
| `targetId` | id string; **required** for `TARGETED_AUDIENCE_KINDS`, **forbidden** otherwise (`422 INVALID_VALUE` on `audiences[i].targetId`) |
| `roles` | optional `AudienceRole[]`, distinct, 1–2 items, **allowed only** for `ROLE_AUDIENCE_KINDS`; absent = both; `[]` → `422` |

`AudienceDto` (response): `kind`, `targetId` (string \| null), `targetName` (string \| null — the
class name, `"{className} {sectionName}"`, the student's `fullName`, the guardian's `fullName`, the
staff member's `fullName`; null for broad kinds), `roles` (`AudienceRole[]`; `[]` for kinds that
take none).

`AnnouncementDto`:

| Field | Type |
|---|---|
| `id` | string |
| `title` | string 1–120 |
| `body` | string 1–1800 |
| `category` | `AnnouncementCategory` |
| `priority` | `AnnouncementPriority` |
| `messageType` | `MessageType` — `messageTypeOf(this)`; the client shows "will go by SMS" from `GET /school/settings.smsAllowedTypes` |
| `status` | `AnnouncementStatus` |
| `audiences` | `AudienceDto[]` — §4.1's normalised order |
| `scheduledAt` | datetime \| null — set iff `scheduled` |
| `expiresOn` | date \| null |
| `hasAttachment`, `attachmentMime`, `attachmentSizeBytes` | boolean, `image/jpeg \| image/png \| application/pdf` \| null, integer \| null |
| `holidayId` | string \| null — the holiday this row is the notice (or cancellation) of (R151) |
| `createdBy`, `createdByName` | string, string — user id and that user's staff `fullName` |
| `createdAt`, `updatedAt` | datetime |
| `sentAt` | datetime \| null — set iff `sent` |
| `cancelledAt`, `cancelledBy`, `cancelReason` | datetime \| null, string \| null, string \| null — together iff `cancelled` |
| `recipientCount` | integer — persons resolved at send (`0` until sent) |
| `smsSegments` | integer \| null — `smsSegments(toGsm7(composed SMS text))` (§5.4) when `messageType ∈ smsAllowedTypes` now, else null (nothing will travel by SMS) |

`AudiencePreviewDto` (`POST /announcements/preview-audience`):

| Field | Type |
|---|---|
| `recipients` | `{ total, guardians, staff, students }` — persons after §4.3's dedupe, exactly what `recipientCount` would be if sent now |
| `byAudience` | `[{ kind, targetId, targetName, persons }]` — persons each item contributes **before** dedupe (so the picker can show "Class 5: 83 people"); same order as the request after normalisation |
| `sms` | `{ allowed: boolean, legs: integer, segments: integer, units: integer, remaining: integer, cap: integer }` — §4.5; `legs`, `units` are `0` when `!allowed` |
| `warnings` | `('sms_cap_short' \| 'sms_too_long' \| 'no_recipients' \| 'whatsapp_not_connected')[]` — what `send` would refuse or degrade, so the composer shows it before the button |
| `computedAt` | datetime |

`DeliverySummaryDto` (`GET /announcements/:id/delivery`; no field is named "read", R150, rule 0.13):

| Field | Type |
|---|---|
| `announcementId`, `status` | string, `AnnouncementStatus` |
| `recipients` | `{ total, guardians, staff, students }` from `announcement_recipients` |
| `messages` | `{ queued, sending, sent, delivered, failed, suppressed }` — `messages.status` counts for the subject |
| `byChannel` | `[{ channel: ExternalChannel, accepted, delivered, failed, suppressed }]` — one entry per channel in `push, whatsapp, sms, email` order, zeros included; counts of the **latest attempt per (message, channel)** |
| `suppressions` | `[{ reason: SuppressionReason, count }]` — from the suppressed delivery rows, descending count |
| `smsSegmentsPerMessage` | integer \| null — as `AnnouncementDto.smsSegments`, frozen from the sent body |
| `smsUnitsReserved` | integer — Σ `segments` over `sms` delivery rows that are `accepted` or `delivered` or `failed` (reserved, §7.7 of slice 9) |
| `computedAt` | datetime — now; the summary is computed live, never stored |

`InboxItemDto` (`GET /me/inbox`, `GET /me/inbox/:id`; R165 on every field):

| Field | Type |
|---|---|
| `id` | string — **the `messages` row id**; the push payload's `messageId` and the app route `/inbox/[messageId]` (slice 15 §8) |
| `kind` | `InboxItemKind` — `announcement` when `subjectType = 'announcement'`, else `notice` |
| `messageType` | `MessageType` |
| `subjectType`, `subjectId` | `MessageSubjectType`, string — what the push carries; the app resolves the child's screen through `viaStudents` |
| `title` | string — announcement: the announcement's `title`; notice: `titleOf(type, subjectType, schoolName)` |
| `body` | string — announcement: the announcement's `body` (never the composed SMS text); notice: `messages.body` |
| `category` | `AnnouncementCategory` \| null — null for notices |
| `priority` | `MessagePriority` — the message's (`urgent`, `normal`, `low`, `internal`) |
| `sentAt` | datetime — `messages.created_at`: when the school sent it, not when a channel delivered it |
| `expiresOn` | date \| null — the announcement's; null for notices |
| `hasAttachment`, `attachmentMime` | boolean, mime \| null — `messages.media_object_key` set |
| `announcementId` | string \| null |
| `viaStudents` | `[{ studentId, fullName }]` — §7.2; only students in the caller's current guardian scope; `[]` for staff and student callers |

`MeDto` gains (additive, §8): `capabilityScopes: MeCapabilityScopeDto[]`, where
`MeCapabilityScopeDto { capability: Capability; scope: CapabilityScope }`.

---

## 3. The `Idempotency-Key` mechanism as applied here (plan §4.7, R143; `slice-13.md` §3)

`POST /announcements` is this slice's one key-protected write: `endpoint = 'announcements'`
(`IDEMPOTENT_ENDPOINTS`, existing), `subject_type = 'announcement'`, `response_status 201`. The
mechanism is slice 13 §3's verbatim with its request hash `HMAC-SHA256(IDENTITY_HASH_KEY,
'announcements|' + canonicalJson(body))` — no path id (the route has none), `audiences` canonical
after `normaliseAudiences`. A replay re-reads the row under the caller's current visibility and
answers `200` with `Idempotency-Replayed: true`; a different hash or an unset subject → `409
IDEMPOTENCY_KEY_REUSED`; a key-insert race is answered outside the transaction from a fresh read.
The web generates the key when the composer opens (`newIdempotencyKey()`), the app when the
compose screen opens; neither persists it beyond the form.

`PATCH`, `send`, `cancel` and `preview-audience` take no key: `send` and `cancel` are online-only
(R162) and retry-safe by state (§5.5, §5.7); `PATCH` locks the row and a no-op is `200`;
`preview-audience` writes nothing.

---

## 4. Audiences

### 4.1 Shape rules (`422`, before any read; `audiencesProblem` names each)

| Rule | Refusal |
|---|---|
| `audiences` array 1–20 | `422` on `audiences` |
| `everyone` present with any other item | `422 INVALID_VALUE` on `audiences` ("everyone combines with nothing") |
| `targetId` present on a broad kind / absent on a targeted kind | `422 INVALID_VALUE` on `audiences[i].targetId` |
| `roles` present on a kind outside `ROLE_AUDIENCE_KINDS`; or `[]`; or a repeated value | `422 INVALID_VALUE` on `audiences[i].roles` |
| the same `(kind, targetId)` twice (roles ignored for the comparison) | `422 INVALID_VALUE` on `audiences[i]` — the client merges roles, the server does not guess |

Stored and returned in `normaliseAudiences` order: by `kind` in `AUDIENCE_KINDS` order, then
`targetId` ascending. `parents` and `students` together are allowed (everyone but staff); `parents`
with `class` is allowed and simply redundant (resolution dedupes).

### 4.2 Scope rules (R144) — after shape, before anything is written

Let `S` = the bound scope (§1.2), `K` = the held keys.

| Item | Rule | Refusal |
|---|---|---|
| `everyone`, `parents`, `students`, `staff`, `staff_member` | `announcement.send.school ∈ K` | `403 PERMISSION_DENIED` `details.reason = 'audience_requires_school'` — checked **first**, for every such item, before any target is resolved (a `403` here never leaks whether a target exists) |
| `class` | the class exists in the school; `S = all`, or **every live (non-archived) section of the class** is in `S.sections` and the class has at least one live section | absent, other school's, or any live section outside `S` → `422 REFERENCE_NOT_FOUND` on `audiences[i].targetId` — **one body for all three** (R144); class archived → `409 CLASS_ARCHIVED`; a class with no live section → `422 REFERENCE_NOT_FOUND` (nothing to reach) |
| `section` | exists; `S = all` or `sectionId ∈ S.sections` | `422 REFERENCE_NOT_FOUND`; archived → `409 SECTION_ARCHIVED` |
| `student` | in scope by `slice-6.md` §1's `student.view` rule (an active enrolment in a section of `S`; `all` = any) | `422 REFERENCE_NOT_FOUND`; status `withdrawn \| transferred \| alumni` → `409 STUDENT_NOT_ACTIVE` (`suspended` is accepted: the family is still told) |
| `guardian` | exists, not merged, and has a **live** `student_guardians` row to a student in scope (as above) | `422 REFERENCE_NOT_FOUND`; merged → `409 GUARDIAN_MERGED` `details.mergedIntoId` (the survivor is the target) |
| `staff_member` | exists (`.school` already required) | `422 REFERENCE_NOT_FOUND`; status `left` → `409 STAFF_NOT_ACTIVE`; `suspended` accepted |

Scope is checked **at create, patch and send** (today's scope each time): a teacher whose
assignment ended between composing and sending gets `422 REFERENCE_NOT_FOUND` at send, not a
message to a section they no longer teach. The scheduled job (§5.6) re-checks against the
**creator's** scope on the firing day; an item that fell out of scope is **dropped from resolution
and counted** in the audit (`droppedAudiences`), never sent — there is no caller to refuse.

### 4.3 Resolution (R145) — at send, shared by `send` and `preview-audience`

One function, `AudienceResolver.resolve(schoolId, audiences, on = today)`, set-based SQL per kind,
returning persons with the students that put them there. "Enrolled on `d`": `enrolments e WHERE
e.started_on ≤ d AND (e.ended_on IS NULL OR e.ended_on ≥ d)` (slice 11 §3.1's predicate; `ended_on`
is the last day in force). "Active student": `students.status = 'active'` (plan slice 14 and
slice 10 §4.7, one definition; decision 4 flags `suspended`). "Live link": `student_guardians.ended_at
IS NULL`, guardian `status <> 'merged'`. **`can_login` is irrelevant** (decision 3). "Reachable
student": active, with a login (`users.student_id`, user `active`) and `school_settings.student_login_enabled`.
"Active staff": `staff.status = 'active'`.

| Kind | Guardians | Students | Staff |
|---|---|---|---|
| `everyone` | every guardian with a live link to an active student | every reachable student | every active staff |
| `parents` | as `everyone` | — | — |
| `students` | — | every reachable student | — |
| `staff` | — | — | every active staff |
| `class`, `section` (roles) | `parents ∈ roles`: live-link guardians of active students enrolled on `d` in the section(s) | `students ∈ roles`: those students when reachable | — |
| `student` (roles) | `parents`: the student's live-link guardians | `students`: the student when reachable | — |
| `guardian` | that guardian (survivor if merged since create) | — | — |
| `staff_member` | — | — | that staff member when active |

Then **dedupe, in order** (R145):

1. **By user.** A guardian and a staff member whose rows are the same login (`users.guardian_id`
   and `users.staff_id` both set, rule 12) are one person: **the guardian row stays**, the staff row
   goes (the guardian channel plan wins). A student cannot share a login with anyone.
2. **By identity hash.** A staff row and a guardian row with equal non-null `cnic_hash` (the same
   CNIC, two records, not yet one login) are one person: the guardian stays.
3. **By phone, per channel.** Among the remaining guardians and staff with a phone, rows sharing
   one E.164 phone keep **one** external phone recipient: order guardians before staff, then by id;
   the others are sent with `dedupePhones` (§4.4) so they get an inbox row (and push) but no
   WhatsApp or SMS — "two guardians on one phone → one WhatsApp, two inbox rows".

One `announcement_recipients` row per person left after steps 1–2 (`guardian_id` / `staff_id` /
`student_id`, exactly one), plus `announcement_recipient_students (recipient, student)` rows for a
guardian recipient naming **every** student that put them there (one per child in the matched
set; for `parents`/`everyone` that is every active linked child). Staff and student recipients
have none. `recipientCount = |recipients|`. **`announcement_recipients` serves audience resolution,
`viaStudents` and attachment access — never the inbox** (plan §4.2).

Zero persons after dedupe → `409 ANNOUNCEMENT_NO_RECIPIENTS` at `send` (nothing written, the row
stays as it was); `warnings: ['no_recipients']` at preview; `sent` with `recipientCount: 0` from
the scheduled job (decision 10).

### 4.4 `NotificationService.send` — two additive inputs this slice needs

```ts
input: {
  …,
  title?: string;                 // announcement types only: the push title and email subject (stored on messages.title)
  dedupePhones?: boolean;         // announcement types only: §4.3 step 3
}
```

- `title` is stored (`messages.title varchar(120)`, §11 item 6). The processor's `push()` and
  `email()` use `message.title ?? titleOf(type, subjectType, schoolName)`; nothing else changes
  for the eleven other types.
- `dedupePhones: true`: after contacts are resolved and planned, among recipients whose `phone`
  is equal (already E.164) **one keeps the phone**: the first (input order) whose plan carries a
  `whatsapp` leg, else the first with an `sms` leg. The others lose **only the phone legs the
  keeper carries**. Nobody carrying a phone leg → nothing is stripped (fix round: a keypad parent
  first on a type SMS may not carry, or a push-only parent, used to take the phone and leave it
  with no outside message at all). One left with no leg at all is `suppressed` with the reason
  **`duplicate_phone`** and one `suppressed: duplicate_phone` delivery row on the stripped channel
  (`whatsapp` when it lost one) — so a `duplicate_phone` row always names a phone that was in fact
  messaged. A recipient with a login keeps `push` and `in_app`. The option is refused (`Error`) on
  a non-announcement type.
- `send(schoolId, input, planned?)`: the announcement job passes the plan it already computed
  (`NotificationService.plan`, the same input) so contacts and devices are resolved once per send;
  `SendResult.messages` returns the inserted rows with their person, which the recipient rows
  carry (no read-back by subject).
- `send()` is unchanged otherwise: one row per person, R107 `ON CONFLICT DO NOTHING`, set-based
  (slice 10 §4.7's 3,000-recipient test applies to a `everyone` announcement too), body stored as
  given, media key stored. `TemplateVarsMap.announcement_urgent / _normal` become
  `Record<string, never>` (the sender passes `{}` and `body`); `RENDERERS` for them return the given
  body — `notWritten` goes.

### 4.5 SMS units and segments (R109, R110) — one function for preview and send

```
type        = messageTypeOf(announcement)
allowed     = type ∈ school_settings.sms_allowed_types   (now)
smsText     = toGsm7(composedBody) [+ '\n' + ATTACHMENT_SMS_LINE when an attachment is set]   (§5.4)
segments    = smsSegments(smsText)
legs        = allowed ? |{ persons whose planChannels(...) has an sms leg that is NOT after-failure }| : 0
units       = legs × segments
remaining   = max(cap − message_usage[this month].sms, 0);  cap = schools.sms_monthly_cap
```

`planChannels` is called with the real predicates per person (device, login, phone, WhatsApp
connected, `allowed`), exactly as `send` will; an after-failure leg (`isAfterFailureSms`) is not a
unit because it may never run and the cap is enforced at the attempt anyway (§7.7 of slice 9).
`segments > 3` and `allowed` → the announcement is **too long for SMS**: `409 SMS_TOO_LONG`
`details: { segments, maxSegments: 3 }` at create, patch and send; `warnings: ['sms_too_long']` at
preview. `units > remaining` → `409 SMS_CAP_EXCEEDED` `details: { smsUnits, remaining, cap }` at
**send now only** (create and patch do not know the audience's phones yet; preview warns
`sms_cap_short`). Send now first compares an upper bound — every resolved guardian and staff
member on SMS (students never have an SMS leg) × `segments` — with `remaining`; when it fits, no
per-person plan is computed (the common case); when it does not, `legs` is counted exactly as
above, so the refusal is never a false one. A `normal` announcement with `announcement_normal` not in the allow list (the
platform default) has `allowed = false`: no length limit beyond 1,800, no units, and the
`smsSegments` field is null.

### 4.6 `POST /announcements/preview-audience`

| Field | Rules |
|---|---|
| `audiences` | required, §4.1 |
| `priority` | required `AnnouncementPriority` |
| `holiday` | optional boolean, default false — `true` makes `messageTypeOf` return `holiday_notice` (the holiday publish confirm dialog previews with it) |
| `title`, `body` | optional, §1.5 — when both are given the `sms.segments` is exact; absent → `segments` is computed on an empty body (the prefix alone) and `warnings` omits `sms_too_long` |
| `hasAttachment` | optional boolean, default false — adds the SMS attachment line to the segment count |

Shape → §4.2 scope rules (the same `403`/`422`/`409` as create) → §4.3 resolution on today →
§4.5. **200** `AudiencePreviewDto`. Writes nothing, audits nothing; `warnings` carries
`whatsapp_not_connected` when the school's live WhatsApp row is not `connected` (R112: guardians
will be routed straight to the fallback). Throttled §1.3.

---

## 5. Announcements

### 5.1 State machine

| From | To | By |
|---|---|---|
| (create) | `draft` | `POST /announcements` |
| `draft` | `scheduled` | `send` with `scheduledAt` set and in the future |
| `draft` | `sending` | `send` without `scheduledAt`, or with one already past (the request commits it) |
| `sending` | `sent` | the `announcement-send` job (§5.6), after the request's commit |
| `sending`, `scheduled` | `draft` with `send_failed_at` | the job gives up after five failed attempts (decision 25) |
| `scheduled` | `draft` | `PATCH … { scheduledAt: null }` |
| `scheduled` | `scheduled` | `PATCH` changing `scheduledAt` (a new delayed job; the old finds nothing) |
| `scheduled` | `sending` → `sent` (one job transaction) | the `announcement-send` job at `scheduled_at` (§5.6) |
| `draft`, `scheduled` | `cancelled` | `cancel` with a reason |
| `sending`, `sent`, `cancelled` | — | terminal for content; `sent` rows still change `recipient_count` never, and nothing else |

Content (`title`, `body`, `category`, `priority`, `expires_on`, attachment, audiences) is editable in
`draft` and `scheduled` only (R146); the database freezes it once `status ∈ {sending, sent,
cancelled}` (`announcements_final_frozen`, §11); the only way out of `sending` other than `sent`
is the job's give-up, `draft` with `send_failed_at` set (§11 item 11).

### 5.2 `GET /announcements` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `status` | optional `AnnouncementStatus` |
| `category` | optional `AnnouncementCategory` |
| `priority` | optional `AnnouncementPriority` |
| `createdFrom`, `createdTo` | optional dates on `created_at` as a school-local date; either alone open-ended; both ≤ 366 days; `createdTo < createdFrom` → `422` on `createdTo` |
| `holidayId` | optional id; unknown → empty page |
| `sort` | `-createdAt` (default), `createdAt`, `-scheduledAt` (nulls last), `-sentAt` (nulls last); `id` tiebreak |

Visibility per §1.1 in the query. Expired announcements stay listed (R147: "stay on the school's
list"). **200** `{ data: AnnouncementDto[], page, limit, total }`. Received announcements are not
here — that is the inbox (§7).

### 5.3 `GET /announcements/:id` — `AnnouncementDto`; invisible → `404`.

### 5.4 `POST /announcements` — `Idempotency-Key` required (§3)

| Field | Rules |
|---|---|
| `title` | required, §1.5 |
| `body` | required, §1.5 |
| `category` | required `AnnouncementCategory` |
| `priority` | required `AnnouncementPriority` |
| `audiences` | required, §4.1, §4.2 |
| `scheduledAt` | optional datetime; **≥ now + 1 min and ≤ now + 90 days** → else `422 INVALID_VALUE` on `scheduledAt`. Stored on the draft; it takes effect at `send` |
| `expiresOn` | optional date ≥ today → else `422 INVALID_VALUE` on `expiresOn`; null = never expires |
| `stagedUploadId` | optional id; one attachment, image or PDF (R148) |

Order, one `@Transactional()` after the §3 pre-steps:

1. Key row inserted (first statement).
2. §4.2 scope rules (`403` first, then `422`/`409` per item, in item order).
3. §4.5 length check when `allowed` → `409 SMS_TOO_LONG`.
4. Attachment: `stagedUploadId` consumed by the slice-6 conditional update (`uploaded_by = caller
   AND consumed_at IS NULL AND expires_at > now()`); no row → `422 REFERENCE_NOT_FOUND` on
   `stagedUploadId` (R91). The row stores the staged object's key, mime and size; nothing moved.
5. Insert `announcements` (`status = draft`, `created_by = caller`, `recipient_count = 0`) and its
   `announcement_audiences` rows; key `subject_id` set.
6. Audit `announcement.created` (§10).
7. After commit: the thumbnail for an image attachment (slice 13 §4.5's rule, stored at
   `<objectKey>-thumb.jpg`; a failure is logged and never fails the write).

**201** `AnnouncementDto` (`draft`); replay **200**. Nothing is sent by a create.

**Composed message body** (used by send; also what `smsSegments` is computed on):

```
composed  = `${schoolLabel(school.name)}: ${title}\n${body}`          // ≤ 30 + 2 + 120 + 1 + 1800 = 1953 ≤ 2000
smsText   = toGsm7(composed) + (attachment ? '\nAttachment: open the app to view it.' : '')
title     = announcement.title                                         // messages.title → push title, email subject
```

Every SMS-eligible body starts with the school's name (slice 9 §7.5); the SMS attachment line is
appended **by the processor's `sms()`** whenever `message.media_object_key` is set (R148: "see the
app" on SMS, never a URL), so the stored body is the WhatsApp and push text and the one
`ATTACHMENT_SMS_LINE` constant lives in `templates.ts`. The WhatsApp leg sends **the bytes**: when
`media_object_key` is set the processor reads the object (key asserted to start with
`${schoolId}/`, as every stream) and calls the driver's new `sendMedia(sender, phone, body, { bytes,
mime, filename })` (WAHA `sendImage`/`sendFile`; Cloud API an uploaded-media message with the
approved caption template); a driver failure maps to the existing codes. Push and email carry
text only; the app opens the attachment from the inbox item.

### 5.5 `POST /announcements/:id/send` — empty body (`NoBodyDto`), online-only (R162)

One `@Transactional()` (the request's 15 s limit; it now writes no message):

1. Row locked (`FOR UPDATE`); invisible → `404`.
2. By status: `scheduled` → **200**, unchanged, no audit (a retry); `sending` and `sent` → **200**
   unchanged, no audit (R146's "already sent" is a successful retry, plan table; `sending` is a
   send now whose job has not finished); `cancelled` → `409 ANNOUNCEMENT_CANCELLED`.
3. `draft` with `scheduled_at > now`: §4.2 scope on today (the **caller's** scope: `403`/`422`/`409`
   as create; fix round — scope is checked at create, patch and send, and scheduling is a send);
   status `scheduled` (an earlier give-up's `send_failures` and `send_failed_at` are cleared);
   audit `announcement.scheduled`; after commit enqueue `announcement-send` with `delay =
   scheduled_at − now` (§5.6). **200** `AnnouncementDto` (`scheduled`).
4. `draft` otherwise (`scheduled_at` null or already past — "send now"): §4.2 scope on today (the
   caller's; a refusal leaves the row `draft`, nothing written); §4.3 resolution; none → `409
   ANNOUNCEMENT_NO_RECIPIENTS`; §4.5 → `409 SMS_TOO_LONG`, `409 SMS_CAP_EXCEEDED` (the upper bound
   first). Then status **`sending`** (the failure count and flag cleared), audit
   `announcement.sent` (§10) with the counts this resolution gave, and after commit enqueue
   `announcement-send` with no delay (id `ann-send-<id>-<nowEpochSeconds>`). **200**
   `AnnouncementDto` (`sending`, `recipientCount 0`).
5. The job (§5.6) resolves again on its own transaction and **writes**: the messages through
   `NotificationService.send(schoolId, { type: messageTypeOf(a), subject: { type: 'announcement',
   id }, recipients, vars: {}, body: composed, title, media, dedupePhones: true }, plan)`; the
   `announcement_recipients` and `announcement_recipient_students` rows carrying each person's
   message id (`INSERT … ON CONFLICT DO NOTHING` on the per-person partial uniques); status
   `sent`, `sent_at`, `recipient_count`, `scheduled_at` left as stored (history). Jobs for the
   messages enqueue after commit (R105).

The response of a "send now" is **`sending`** (decision 9, reversed in the fix round): a
school-wide fan-out does not fit a request's transaction, and the refusals a sender must see —
scope, nobody, too long, over the cap — are all decided before the row moves. The web shows the
toast "Sending now", and the detail page polls the record every 3 s until it is `sent`, then shows
the delivery summary. The resolution the request counted and the job's may differ by whoever joined
or left in those seconds; `recipientCount` is the job's.

### 5.6 The `announcement-send` job — queue `messaging`: every send (R146)

Payload `{ schoolId, announcementId }` (zod, ids `^[1-9][0-9]{0,18}$`), id
`ann-send-<announcementId>-<dueEpochSeconds>` (`queues.ts`: never `:`), enqueued after commit by
§5.5 steps 3 and 4, by every `PATCH` that changes `scheduled_at` (a new id; the stale job finds its
claim false), and by the holiday publish and cancel (§6). The outbox sweep (`slice-9.md` §7.9's
reserved source) re-enqueues, under `…-s<minute>`, `announcements` with `status = 'scheduled' AND
scheduled_at <= now() − 1 min` **and** those `sending` and untouched for a minute (`updated_at <=
now() − 1 min`: a send now or a notice whose job was lost or failed), so a lost job runs within
the sweep's 2-minute cadence. The worker passes the job's **due time** (its producer timestamp plus
its delay, `WorkerHost.plannedAt`). Body, `runAsSchool`, one `@Transactional({ timeout: 120 s })`
(`JOB_TRANSACTION_TIMEOUT_MS`: 3,000 recipients took 4.4–4.8 s warm and 23.7 s on a cold run;
120 s is five times that cold run, and it bounds only a stuck job's locks):

1. **Claim, first statement**, holding the row lock: `scheduled` with `scheduled_at <= max(now,
   due time)` → `sending` (the due time, not only the worker's clock, so a worker a few hundred
   ms behind Redis's clock does not skip the job until the sweep); otherwise a row already
   `sending` (its `updated_at` touched). Neither → the job ends (a replay, an edited time, a
   cancellation, already sent). A second job for the same row waits on the lock, then finds it
   `sent`.
2. A row claimed from `scheduled`: §4.2 scope rules evaluated for the **creator**
   (`PermissionsService.load(schoolId, created_by)` then `canAny`): a creator who no longer holds
   either key, or whose staff record is not active, → every item is out of scope. Items that fail
   are **dropped** (counted as `droppedAudiences`), never refused — there is nobody to answer; a
   `403`-class item (a broad kind by a creator who lost `.school`) is dropped the same way. A row
   claimed from `sending` was checked by its request (or is a holiday notice, decision 14). A
   holiday's notice whose holiday has been cancelled since (§6.2) resolves to nobody.
3. §4.3 resolution on the firing day; §4.5 **without** the cap refusal (the cap is enforced per
   leg, R109; the principal gets `sms_cap_reached` once if it bites) and **without** the length
   refusal (the body was checked at create and patch; if the school added the type to the allow
   list after scheduling, an over-long body is sent as it stands — that change is the school's own
   act and the segment count was on the row; decision 11). The plan is computed once and written as
   it stands.
4. Write exactly as §5.5 step 5; zero persons → `sent` with `recipient_count = 0` and
   `sent_at = now` (decision 10).
5. Not audited: a scheduled fire has no actor (its schedule was audited with one) and a send now's
   `announcement.sent` was written by its request. The log line `announcement sent` carries
   `recipients`, `droppedAudiences`, `dedupedByPhone`, `smsLegs` (never a name).

A crash or error inside the transaction rolls back to the claimed state (`scheduled` or `sending`)
for the sweep. Each failure is then counted on the row in its own transaction
(`announcements.send_failures`); the **fifth** gives up (decision 25): the row goes to `draft` with
`send_failed_at` set (nothing was written: each attempt rolled back), audited
`announcement.send_failed`, and the sweep no longer finds it. The sender sees the flag on the
detail page (`AnnouncementDto.sendFailedAt`) and may send again, which clears it.

### 5.7 `PATCH /announcements/:id`

Body: every create field optional (`title`, `body`, `category`, `priority`, `audiences`,
`scheduledAt`, `expiresOn`, `stagedUploadId`). Absent = unchanged. `title`, `body`, `category`,
`priority`, `audiences: null` → `422`; `scheduledAt`, `expiresOn`, `stagedUploadId: null` clear
(`stagedUploadId: null` removes the attachment; a value replaces it, consumed as §5.4 step 4 — the
old object and thumbnail stay, rule 4). `audiences`, when present, **replaces** the whole set.

Order: row locked; invisible → `404`; status `sending | sent` → `409 ANNOUNCEMENT_SENT`
`details.status`; `cancelled` → `409 ANNOUNCEMENT_CANCELLED`; field rules on the merged result
(`scheduledAt` bounds as create; on a `scheduled` row the new time must still be ≥ now + 1 min);
§4.2 scope rules on the merged `audiences` (always re-checked, today's scope); §4.5 length when
`allowed`; **no change → `200`, no audit, no job**. Otherwise: update; `announcement_audiences`
replaced (decision 12); on a `scheduled` row, `scheduledAt: null` → status `draft`, a changed
`scheduledAt` → a new delayed job after commit; audit `announcement.updated { changes }`. **200**
`AnnouncementDto`. No `CONCURRENT_UPDATE`: the row is locked.

### 5.8 `POST /announcements/:id/cancel` — `{ reason: TextField(3, 500) }`

Row locked; invisible → `404`; `cancelled` → **200** unchanged, no audit; `sending | sent` → `409
ANNOUNCEMENT_SENT` (R146: a sent announcement cannot be recalled — the messages are out; a
correction is a new announcement, concept slide 03's spirit); `draft | scheduled` → `cancelled`,
`cancelled_at/by`, `cancel_reason`; a pending delayed job finds its claim false. Audit
`announcement.cancelled` with the reason. **200** `AnnouncementDto`.

### 5.9 `GET /announcements/:id/delivery`

Invisible → `404`. Computed live from `messages` (`subject_type = 'announcement' AND subject_id =
:id`), `message_deliveries` (latest attempt per message and channel) and `announcement_recipients`.
`draft | scheduled | cancelled` → zeros with the recipients block from the rows that exist (none
before send). **200** `DeliverySummaryDto`. Equals the delivery rows by construction (R150: the
test sums the rows and compares). Not paginated: a bounded object.

### 5.10 `GET /announcements/:id/attachment`, `…/thumbnail` — the sender's copy

Invisible or no attachment → `404`; PDF for `thumbnail` → `404`. Streamed exactly as `slice-13.md`
§4.5: stored mime, `Content-Length`, `Content-Disposition: attachment;
filename="announcement-<id>.<ext>"` (`…-thumb.jpg`), `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox`, `Cache-Control: no-store`; the thumbnail is the stored one,
made on first read under the uploads `ConcurrencyLimit` when missing (`503` after a 10 s wait).
Never a presigned URL (R148). Logged by id, not audited.

---

## 6. Holidays publish through announcements (R151, R117) — the switch from `slice-10.md` §4.7

### 6.1 Publish (`POST /holidays/:id/publish`, slice 10 §4.5 step 4 replaced)

Inside the publish transaction, after the listeners, **when `endsOn ≥ today`**:
`AnnouncementsService.sendHolidayNotice(schoolId, holiday, actor)` — an internal method, not a
route, that does not check `announcement.send.*` (the publisher's `holiday.manage` is the
authority; decision 14) and:

1. Inserts an announcement: `title = cutWords("School closed " + range(startsOn, endsOn), 120)`
   (e.g. `School closed Mon 6 Oct to Fri 10 Oct`), `body = "{name}." + (reopensOn ? " Reopens {Mon
   13 Oct}." : "")` (the holiday's `name` already refuses identity and phone patterns, slice 10
   decision 6), `category = holiday`, `priority = normal`, `expires_on = endsOn`, `holiday_id`,
   `created_by = publisher`, one audience `{ kind: everyone }`, `status = sending`.
2. Resolves the audience (counts only, for the audit) and enqueues `announcement-send` after
   commit; the job (§5.6) writes §5.5 step 5 with `type = holiday_notice` (`messageTypeOf`:
   `holiday_id` set), subject `{ announcement, id }`, `dedupePhones: true`; zero persons is **not**
   a refusal here (`sent`, `recipient_count 0`; a brand-new school has nobody to tell). The publish
   request writes no message (fix round: 3,000 notices inside the request reached the 15 s limit).
3. Sets `holidays.announcement_id = announcement.id` (the foreign key arrives in §11 item 7).
4. The holiday audit row (`holiday.published`) gains `announcementId` and the three recipient
   counts as resolved at publish; no separate `announcement.sent` audit (one act, one row).

The composed body is `"{school}: School closed Mon 6 Oct to Fri 10 Oct\nEid ul Fitr. Reopens Mon 13
Oct."` — one GSM-7 segment with the longest fixtures (a test keeps it so; `name` is cut by
`cutWords` to fit, as the old template did). The `holiday_notice` type keeps its own allow-list
entry (item 22's default: on), so a school that allows holiday SMS but not announcement SMS still
gets this one by SMS — the reason `messageTypeOf` returns `holiday_notice` rather than
`announcement_normal`.

### 6.2 Cancel (`POST /holidays/:id/cancel`, slice 10 §4.6 step 3 adjusted)

From `published`, when `holidays.announcement_id` is set (published after this slice):

- **Wait for the notice's job, then withdraw the unsent:** the notice announcement row is locked
  first (lock order holiday → announcement), so a job still writing the notice commits before the
  withdrawal; then `MessageRepository.withdrawQueuedForSubject(schoolId, 'announcement',
  announcementId)` — the same statement, new subject (`suppressed: subject_cancelled`). A notice
  whose job has not started yet finds the holiday cancelled and tells nobody (§5.6 step 2). The
  notice announcement row stays (or ends) `sent` (R146; its delivery summary shows the
  withdrawals). A cancel that waits on a long-running notice job can exceed its own 15 s limit and
  answer `500`; it is retried safely (cancel is idempotent) and is a case of a holiday cancelled
  within seconds of its publish.
- **Cancellation notice, when `endsOn ≥ today`:** a **second announcement** (`holiday_id` set,
  `title = cutWords("Holiday cancelled: " + range(startsOn, endsOn), 120)`, `body = "The holiday
  ({name}) is cancelled. School is open as normal."`, `category = holiday`, `priority = normal`,
  `expires_on = endsOn`, audience `everyone`, `created_by = canceller`), committed `sending` and
  delivered by its job as §6.1 step 2, with `type = holiday_notice`. Audience `everyone` resolved **now**, not "exactly those told" as slice 10
  §4.6 does (decision 15): the cancellation is harmless to someone who was never told, and a
  "those told" audience kind is machinery for one case.
- `holidays.announcement_id` keeps pointing at the notice; `GET /announcements?holidayId=` lists
  both rows.

**Holidays published before this slice** (`announcement_id IS NULL`, messages with `subject_type =
'holiday'`): **nothing is backfilled** (slice 10 decision 1). Their cancel keeps slice 10 §4.6 step 3
unchanged — withdraw by subject `holiday`, cancellation by `holiday_notice` with subject
`holiday_cancellation` to the persons not withdrawn, through the existing template. The inbox
renders both generations the same way (kind `notice`, §7). The `holiday_notice` renderer and
`titleOf`'s two holiday titles therefore stay in `templates.ts`.

`CalendarListener` ordering is unchanged: listeners run after the status write and before the
notice; the announcement write is the last thing in the publish transaction before the audit.
Lock order: holiday row → announcement row → … (§1.4).

---

## 7. The inbox — `GET /me/inbox`, `GET /me/inbox/:id`, attachments

### 7.1 The predicate — one query over `messages`, resolved by person at read time (plan §4.2)

For the caller's `access` (`guardianId`, `staffId`, `studentId` from `users`; any may be null):

```
m.school_id = :school
AND ((m.guardian_id = :guardianId AND guardianSubjectInScope(m))                          -- null ids match nothing
     OR m.staff_id = :staffId OR m.student_id = :studentId)
AND m.type <> 'messaging_test'                                                             -- a test is not a notice (decision 17)
AND NOT (m.status = 'suppressed' AND m.suppressed_reason = 'subject_cancelled')            -- withdrawn before anyone was told
AND NOT EXISTS (announcement a ON m.subject_type = 'announcement' AND a.id = m.subject_id
                 AND a.expires_on IS NOT NULL AND a.expires_on < :today)                   -- R147
LEFT JOIN announcements a (same join) for title, body, category, expires_on, attachment mime
```

`guardianSubjectInScope(m)` (Phase 2 close, R164 amended; security review, low): a guardian row
whose subject belongs to a student reads only while that student is in the caller's **current**
guardian scope (`PermissionsService.guardianChildren`, the scope `/me/children` uses). Student-linked
subject types: `attendance_alert` (absence and late alerts and corrections; the alert's
`student_id`), `remark` (the remark's `student_id`) and `diary_entry` (any scope student with an
enrolment in the entry's section in force on its date, §7.2's predicate). Every other subject type
(`announcement`, `holiday`, `holiday_cancellation`, and the staff-only types) is not about one
student and passes. An empty scope passes none of the three. Staff and student rows are unchanged.
The same predicate serves `GET /me/inbox/:id` and both attachment routes, so a filtered row is
`404` there. Each subject check is an `EXISTS` on the subject's `(school_id, id)` key, inside the
`(school_id, guardian_id, created_at)` index scan.

Consequences, each a test: a guardian issued a login **after** a message was written sees it (the
row names the guardian, not a user); a `no_channel` or `duplicate_phone` suppression is **in** the
inbox (the inbox is the channel they now have; slice 9 decision 15); a staff member who is also a
guardian sees one row per message (dedupe wrote one); a guardian row merged since is not seen by
the survivor's login (the survivor's own rows are; recorded, accepted); an expired announcement
drops off every inbox the day after `expires_on` and stays on the school's list (R147); a
pre-slice-14 holiday notice (`subject_type = 'holiday'`) shows as a `notice` with the stored body;
`channel_plan` is **not** a predicate — a message is in the inbox whether or not `in_app` was
planned (decision 16). Indexes `(school_id, guardian_id, created_at)` and siblings serve it
(migrated in slice 9).

### 7.2 `viaStudents` (R165, slice 15 §8)

Only for a caller with guardian capacity, only students in the caller's **current** guardian scope
(`PermissionsService.guardianChildren`, one read per request): for `kind = announcement` the
`announcement_recipient_students` of the recipient row whose `guardian_id` is the caller's,
intersected with the scope; for `subjectType = attendance_alert` the alert's `student_id`; for
`remark` the remark's `student_id`; for `diary_entry` the scope's students with an enrolment in the
entry's section in force on the entry's date (slice 13 §6.1's predicate); otherwise `[]`. Resolved
for the page in **one query per subject type present** (at most four), never per row. Names come
from `students.full_name`. A child whose link ended is not named, even on an old row (R164: ended
link, gone next request), and since the Phase 2 close a row about only that child is not listed at
all (§7.1). Staff and student callers always get `[]`.

### 7.3 `GET /me/inbox` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `kind` | optional `InboxItemKind` |
| `category` | optional `AnnouncementCategory` — matches announcements only (notices have none) |
| `sort` | fixed `-sentAt` (`created_at` desc), `id` desc tiebreak; another value → `422` |

**200** `{ data: InboxItemDto[], page, limit, total }`. The app's first screen after `GET /me`;
one page is ≤ 50 rows and carries no image bytes (R160).

### 7.4 `GET /me/inbox/:id` — `InboxItemDto`

The one row by §7.1 (expiry included: an expired item is `404`) → else `404`. For a push deep-link
that lands after the list cache went stale (decision 18).

### 7.5 `GET /me/inbox/:id/attachment`, `…/thumbnail`

The message must satisfy §7.1 for the caller **and** have `media_object_key` set → else `404`
(R148: streamed only to recipients — a non-recipient, another guardian of the same child, a
guardian whose link ended, gets `404` from the predicate and never the bytes). Streamed as §5.10
with `filename="announcement-<announcementId>.<ext>"`; PDF for `thumbnail` → `404`; the thumbnail
is the stored one beside the object (same key convention, so sender and recipient routes serve the
same bytes). `me-reads` throttle. Logged by message id only.

---

## 8. `MeDto.capabilityScopes` — where a capability comes from (wave-E review)

The wave-E review found that `GET /me` lists capabilities without their scope, so the web shows a
teacher holding a school-wide grant of `diary.write` fewer controls than the server allows. Fix,
additive:

```ts
/** One entry per effective capability, in the same order as `capabilities`. */
export class MeCapabilityScopeDto {
  @ApiProperty({ enum: Object.values(Capability), enumName: 'Capability' }) capability: Capability;
  /** `all`: a school-wide source (principal or office default, custom role, grant). `assigned_sections`: held only through the teacher default, so rows come from assignments (R79). */
  @ApiProperty({ enum: CAPABILITY_SCOPES, enumName: 'CapabilityScope' }) scope: CapabilityScope;
}
// MeDto
@ApiProperty({ type: () => MeCapabilityScopeDto, isArray: true }) capabilityScopes: MeCapabilityScopeDto[];
```

- Source: `access.lines` (`effectivePermissions()`, already computed by `PermissionsService.load`
  for every request) — `{ capability: line.capability, scope: line.scope }`, sorted by
  `capabilityOrder` like `capabilities`. **No new query.** `capabilities.length ===
  capabilityScopes.length` always; `[]` without staff capacity (R59). `LoginResultDto` inherits it.
- Semantics are exactly `canAny`'s: `scope: 'all'` means every row of the school for that key;
  `assigned_sections` means the sections of today's assignments (`MeDto.assignments`). No source
  ids are exposed here (the grant screen's `EffectiveCapabilityDto` has them); the client needs
  only the breadth.
- Clients: the web renders school-wide controls (edit another teacher's diary entry, correct
  another author's remark, the audience picker's "any class/section" mode) when the key's scope is
  `all`; a `403` still shows the no-permission state. The mobile `announce` tab condition
  (`slice-15.md` §6: `cap(announcement.send.school)`) is unchanged; slice 16 may use
  `capabilityScopes` to widen the picker for an office clerk on the web first.
- OpenAPI and the generated web client are regenerated; the R68 snapshot and the `MeDto` field
  test gain the field.

---

## 9. Error codes

All exist in `packages/shared/src/error-codes.ts`; this contract fixes their `details`:

| Code | Status | Where |
|---|---|---|
| `ANNOUNCEMENT_SENT` | 409 | patch, cancel on `sending \| sent` — `details.status` |
| `ANNOUNCEMENT_CANCELLED` | 409 | patch, send on `cancelled` |
| `ANNOUNCEMENT_NO_RECIPIENTS` | 409 | send now, after resolution yields nobody — `details: { audiences: integer }` (items evaluated) |
| `SMS_TOO_LONG` | 409 | create, patch, send when the type is SMS-allowed — `details: { segments, maxSegments: 3 }` |
| `SMS_CAP_EXCEEDED` | 409 | send now, in the request (before the row moves) — `details: { smsUnits, remaining, cap }` (the shape the code comment already names) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | create (§3) |
| `PERMISSION_DENIED` | 403 | **`details.reason = 'audience_requires_school'`** (new reason value, joins the union) |
| `REFERENCE_NOT_FOUND` | 422 | `audiences[i].targetId` (absent, other tenant, out of scope — one body), `stagedUploadId` |
| `CLASS_ARCHIVED`, `SECTION_ARCHIVED`, `STUDENT_NOT_ACTIVE`, `GUARDIAN_MERGED`, `STAFF_NOT_ACTIVE` | 409 | a visible target in a state that cannot be reached (§4.2) |

Reused unchanged: `NOT_FOUND`, `VALIDATION_FAILED` / `INVALID_VALUE` / `UNKNOWN_FIELD`,
`SERVICE_UNAVAILABLE` (thumbnail concurrency), `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`
(uploads), `RATE_LIMITED`. **No new code.** `ILLEGAL_STATUS_TRANSITION` is not used: each
announcement refusal has its own code already.

## 10. Audit actions (R152 — actor, counts by audience kind, reason; never a recipient name)

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `announcement.created` | announcement | — | `{ category, priority, audienceKinds: "everyone" \| "class:2,section:1" (comma-joined kind:count), scheduled: boolean, hasAttachment, holidayId }` |
| `announcement.updated` | announcement | — | `{ changes }` — field names only (`audiences` counts as one field); never the text |
| `announcement.scheduled` | announcement | — | `{ scheduledAt, audienceKinds }` |
| `announcement.sent` | announcement | — | `{ recipients, guardians, staff, students, audienceKinds, smsSegments, dedupedByUser, dedupedByIdentity }` written by the send-now **request** when the row becomes `sending`, with that resolution's counts (`smsSegments` null when the type may not travel by SMS). `smsLegs` and `dedupedByPhone` are delivery facts computed by the job after commit; they are on its `announcement sent` log line, not here (fix round). The job itself is not audited — no actor; the row carries `sent_at` and `recipient_count` |
| `announcement.send_failed` | announcement | — | `{ attempts, fromStatus }` — the job gave up (decision 25). `audit_log` requires an actor and the job has none, so the row's **creator** is named; the action says the system did it |
| `announcement.cancelled` | announcement | required | `{ fromStatus, audienceKinds }` |
| `holiday.published` (existing) | holiday | — | gains `announcementId`; the notice counts are the publish-time resolution (the job delivers) |
| `holiday.cancelled` (existing) | holiday | required | gains `cancellationAnnouncementId` (null when none sent) |

A replayed create, a no-op patch and a retried send or cancel write no audit row. Reads are not
audited. `test/core/routes.e2e-spec.ts` classification:

```
'POST /api/v1/announcements': ['announcement.created'],
'PATCH /api/v1/announcements/:id': ['announcement.updated'],
'POST /api/v1/announcements/:id/send': ['announcement.scheduled', 'announcement.sent'],
'POST /api/v1/announcements/:id/cancel': ['announcement.cancelled'],
'POST /api/v1/announcements/preview-audience': [],
```

The R68 snapshot gains the four `/me/inbox*` routes as `@AuthenticatedOnly()` under `/me/` (plan
§4.3's naming rule: directly under `/me/` = any live session).

---

## 11. For `data-architect` — the slice-14 migration (nothing of this exists yet)

One migration `slice14_announcements` over the shipped schema, every object in `EXPECTED_OBJECTS`,
reviewed before generation (plan §5):

1. **Enums** `announcement_category (holiday|exam|fee|event|general)`, `announcement_priority
   (normal|urgent)`, `announcement_status (draft|scheduled|sending|sent|cancelled)`, `audience_kind`
   (the nine values of `AUDIENCE_KINDS`), `audience_role (parents|students)`; mirrored in
   `packages/shared` (`shared-enums.e2e-spec.ts`).
2. **`announcements`** (tenant: `school_id NOT NULL`, `UNIQUE (school_id, id)`, the `@ignore`
   School relation, the `school_id` immutability trigger): `title varchar(120)`, `body
   varchar(1800)` (both `_no_id_check`), `category`, `priority`, `status default draft`,
   `scheduled_at timestamptz(3)`, `expires_on date`, `attachment_object_key varchar(64)` /
   `attachment_mime varchar(32)` / `attachment_size_bytes int` (all null or all set,
   `announcements_attachment_check`; object-key prefix CHECK as `student_documents`; `UNIQUE
   (school_id, attachment_object_key) WHERE attachment_object_key IS NOT NULL`), `holiday_id`
   nullable composite FK `(school_id, holiday_id) → holidays (school_id, id)`, indexed, **not
   unique** (a cancellation notice is a second row), `created_by` composite FK to `users`,
   `sent_at`, `cancelled_at`, `cancelled_by` (composite FK), `cancel_reason varchar(500)`
   (`_no_id_check`), `recipient_count int NOT NULL DEFAULT 0`, `created_at`, `updated_at`. CHECKs:
   `announcements_scheduled_check ((status = 'scheduled') = (scheduled_at IS NOT NULL) OR status IN
   ('sending','sent','cancelled'))` — `scheduled_at` is kept as history once sent, so the plan's
   "set iff scheduled" is relaxed to "required when scheduled, forbidden when draft" (decision 11):
   `(status = 'draft' AND scheduled_at IS NULL) OR (status = 'scheduled' AND scheduled_at IS NOT
   NULL) OR status IN ('sending','sent','cancelled')`; `announcements_sent_check ((status = 'sent')
   = (sent_at IS NOT NULL))`; `announcements_cancelled_check` (the three cancelled fields together,
   exactly when `cancelled`); `announcements_recipient_count_check (recipient_count >= 0 AND
   (status IN ('sending','sent') OR recipient_count = 0))`. Indexes `(school_id, status,
   scheduled_at)` (the sweep source), `(school_id, created_by, created_at)` (a `.scope` holder's
   list), `(school_id, holiday_id)`, `(school_id, cancelled_by)`. Triggers: `announcements_final_frozen`
   (once `status ∈ {sending, sent, cancelled}` only `status`, `sent_at`, `recipient_count`,
   `updated_at` may change, and `status` only forward per §5.1); `announcements_no_delete`,
   `_no_truncate`.
3. **`announcement_audiences`**: `announcement_id` composite FK, `kind audience_kind`, five nullable
   composite FKs `class_id → classes`, `section_id → sections`, `student_id → students`,
   `guardian_id → guardians`, `staff_id → staff` (each indexed `(school_id, <fk>)`),
   `roles audience_role[] NOT NULL DEFAULT '{parents,students}'`. CHECK
   `announcement_audiences_target_check`: exactly the FK its `kind` names is set (`class → class_id`,
   `section → section_id`, `student → student_id`, `guardian → guardian_id`, `staff_member →
   staff_id`, broad kinds → none); `announcement_audiences_roles_check (cardinality(roles) BETWEEN 1
   AND 2 AND roles = ARRAY(SELECT DISTINCT unnest(roles)))`; `UNIQUE (school_id, announcement_id,
   kind, coalesce(class_id,0), coalesce(section_id,0), coalesce(student_id,0), coalesce(guardian_id,0),
   coalesce(staff_id,0))` as a unique index on expressions (one row per target). **No no-delete
   trigger** (decision 12): a draft's audience is a form field, replaced on `PATCH`; the audit row
   records that it changed. Index `(school_id, announcement_id)`.
4. **`announcement_recipients`**: `announcement_id` composite FK, three nullable composite FKs
   `guardian_id`, `staff_id`, `student_id` with `announcement_recipients_person_check` (exactly one),
   `message_id` nullable composite FK `(school_id, message_id) → messages (school_id, id)`, `created_at`.
   Partial uniques (R145): `announcement_recipients_guardian_key UNIQUE (school_id,
   announcement_id, guardian_id) WHERE guardian_id IS NOT NULL`, and the same for `staff_id`,
   `student_id`; `UNIQUE (school_id, id)` (target of the join table); indexes per FK with
   `school_id` first; `(school_id, message_id)`. Append-only: `_no_delete`, `_no_truncate`, and an
   update trigger allowing only `message_id` to change, from NULL.
5. **`announcement_recipient_students`**: `announcement_recipient_id` composite FK `(school_id,
   announcement_recipient_id) → announcement_recipients (school_id, id)`, `student_id` composite
   FK, `UNIQUE (school_id, announcement_recipient_id, student_id)`, index `(school_id, student_id)`;
   `_no_delete`, `_no_truncate`, columns immutable.
6. **`messages.title varchar(120)` nullable**, `messages_title_no_id_check`; set only for the three
   announcement-carried types (§4.4). The processor reads it; nothing else changes on `messages`.
7. **`holidays.announcement_id`** gains the composite FK `(school_id, announcement_id) →
   announcements (school_id, id)` and index `(school_id, announcement_id)`; removed from
   `NON_FK_ID_COLUMNS`. The two tables reference each other; the FK is added after both exist, no
   cascade either way (schema guard).
8. **`suppression_reason` gains `duplicate_phone`** — in **its own migration file** before this one
   (`ALTER TYPE … ADD VALUE`, the slice-10 `cover` precedent), `SUPPRESSION_REASONS` updated.
9. `idempotency_keys_endpoint_check` already admits `announcements` (groundwork); `messages_subject_type_check`
   already admits `announcement`. Nothing to add.
10. Isolation tests for the four tables (control 4); the schema guard's `_id` regex covers every
    column here; no array of ids (roles is an enum array, allowed by plan §5).
11. **Fix round, its own migration `20261004160000_slice14_send_failures`:** `announcements` gains
    `send_failures smallint NOT NULL DEFAULT 0` (`announcements_send_failures_check >= 0`) and
    `send_failed_at timestamptz(3)` (`announcements_send_failed_check`: set only on a `draft`); the
    function `asms_announcement_final_frozen` is replaced so that from `sending` the two failure
    columns may change too and the status may become `draft` only with `send_failed_at` set. No
    new status value: the web and mobile status unions stay as they are. All three objects are in
    `SLICE_14_OBJECTS`.

---

## 12. Screens → endpoints, and the shared audience-picker contract

Write controls render only when `GET /me` lists the capability with the right `capabilityScopes`
entry; a `403` still shows the no-permission state.

| Screen | Calls | Behaviour |
|---|---|---|
| Announcements list (web) | `GET /announcements` | Filters status, category, priority, dates; status badge; `recipientCount` and `smsSegments` columns; a `.scope`-only sender sees only their own |
| Compose / edit (web) | `POST /announcements` with `Idempotency-Key`, `PATCH /announcements/:id`, `POST /uploads`, `POST /announcements/preview-audience` (debounced 500 ms on every audience, priority, title or body change) | Fields of concept slide 03 in its order; the audience picker (below); live "N people · M SMS units of R remaining · K segments"; `sms_too_long` inline on the body ("Over 3 SMS segments; shorten or send as normal"); `audience_requires_school` hides the broad kinds for the caller (and shows the message if forced); `REFERENCE_NOT_FOUND` on an item highlights it; "Schedule" toggles the datetime |
| Announcement detail (web) | `GET /announcements/:id`, `/delivery`, `/attachment`, `POST …/send`, `…/cancel` | Send confirm repeats the preview numbers and "Urgent: WhatsApp and SMS together"; `SMS_CAP_EXCEEDED` → "Needs N SMS units; R remain. Send as normal, or shorten"; delivery page polls every 30 s while `messages.queued + sending > 0`; suppressions table with reasons in plain words (`no_channel` "no phone or app", `not_allowed` "SMS off for this type", `cap_reached` "SMS allowance used", `duplicate_phone` "same phone as another recipient", `subject_cancelled` "withdrawn before sending") — never the word "read" |
| Holiday publish / cancel confirm (web, slice 10's screens) | `POST /announcements/preview-audience { audiences: [{ kind: 'everyone' }], priority: 'normal', holiday: true, title, body }` | Shows the count and SMS units before publishing; the holiday detail links to its notice (`announcementId`) and, after a cancel, to the cancellation (`GET /announcements?holidayId=`) |
| Settings → SMS allow list (slice 9's screen) | — | The `announcement_normal` checkbox hint: "Normal announcements fall back to SMS when WhatsApp fails" |
| App — Inbox (slice 16a) | `GET /me/inbox`, `GET /me/inbox/:id`, `…/attachment`, `…/thumbnail` | List from the cache with "as of"; urgent items carry the red edge (concept slide 05); attachments load on tap (R160); a push opens `/inbox/[messageId]` through `GET /me/inbox/:id`; `viaStudents` labels "about Ali" for a parent of several children |
| App — Announce (slice 16b, principal: `cap(announcement.send.school)`) | `POST /announcements`, `preview-audience`, `POST …/send` | Reduced picker: `everyone`, `parents`, `students`, `staff`, one class, one section; short notice only; compose and send are **online** (preview needs the network; send is R162 online-only) — the create is not queued in the outbox (decision 13) |

### 12.1 The audience picker — one component, one data contract (plan slice 14; Phase 3 reuses it)

`apps/web/components/audience-picker/` (and the slice-16 RN twin) is a controlled component over
`AudienceInput[]` with these inputs and no other knowledge of announcements:

| Input | From | Rule |
|---|---|---|
| `canSchoolWide: boolean` | `me.capabilities ∋ announcement.send.school` | shows `everyone`, `parents`, `students`, `staff`, and the staff-member search |
| `sectionScope: 'all' \| string[]` | `me.capabilityScopes` for `announcement.send.scope` (or `.school`): `all` → every class and section (`GET /classes?academicYearId=`, `GET /classes/:id/sections`); `assigned_sections` → only `me.assignments[].sectionId` (and a whole-class subject row's class) | a class is offered only when every live section of it is offered (R144's rule, mirrored client-side so the server's `422` is a race, not a surprise) |
| `searchStudents(q)` | `GET /students?q=&status=active` (already scoped server-side) | "one student" and "one family" start from a student; a guardian is picked from `GET /students/:id` (`guardianLinks`, live ones) — `GET /guardians` needs `guardian.manage`, which a teacher lacks |
| `searchStaff(q)` | `GET /staff?q=&status=active` | only when `canSchoolWide` |
| `preview(audiences, priority, …)` | `POST /announcements/preview-audience` | the component shows `byAudience[].persons` beside each chip and `recipients.total` at the foot; Phase 3 passes the charge campaign's type instead |
| `value`, `onChange` | `AudienceInput[]` | emits `normaliseAudiences(value)`; refuses locally with `audiencesProblem` (same wording as the API's `422`) |

Flow is concept slide 04's: Everyone → by role → by class → by section → one student / family /
staff member; each step narrows; chips are removable; roles are a two-state toggle on class,
section and student chips ("Parents", "Students", default both). The component never names a phone
number, an identity number or a guardian's relationship (R165 applies to the picker's data too:
`GET /students/:id` returns only what the caller may see).

---

## 13. Tests this contract adds

R144 (a teacher targets a section outside scope → `422 REFERENCE_NOT_FOUND` byte-identical to an
absent id and to another school's id; a class with one section out of scope refused; a class with
every section in scope accepted; a cover teacher inside dates accepted, the day after `422`;
`everyone`/`parents`/`students`/`staff`/`staff_member` without `.school` → `403
audience_requires_school` before any lookup; office clerk with `.scope` targets any section but
not `everyone`; principal everything; a guardian not linked to a student in scope `422`; archived
section `409`; withdrawn student `409 STUDENT_NOT_ACTIVE`, suspended accepted; merged guardian
`409 GUARDIAN_MERGED`; staff `left` `409 STAFF_NOT_ACTIVE`) · R145 (a parent with three children
once, `recipient_students` has three rows; a staff member who is also a parent once, on the
guardian plan — by user and separately by identity hash; two guardians on one phone → one
WhatsApp leg and two inbox rows, the second `duplicate_phone`; `roles: ['parents']` reaches no
student login, `['students']` no guardian; a student without a login is not a recipient; a
guardian with a live `can_login = false` link **is** a recipient; a guardian with no phone and no
login is a recipient with `no_channel`; resolution on the send date, not the create date — a child
admitted after the draft is reached; preview `recipients.total` equals `recipientCount` after
send) · R146 (scheduled send fires within a minute via the delayed job; a lost job is recovered by
the sweep; edit and cancel before firing; firing after cancel sends nothing; `PATCH` after sent
`409 ANNOUNCEMENT_SENT`; `scheduledAt: null` returns a scheduled row to `draft`; a changed time
makes the old job a no-op; the creator losing scope before firing drops the item and the audit
says so; a scheduled fire with zero persons ends `sent` with `recipientCount 0`) · R147 (an
expired announcement leaves every inbox the next day and stays listed; `GET /me/inbox/:id` → `404`
once expired) · R148 (image and PDF accepted, 5 MB, re-encoded; the WhatsApp leg sends bytes with
the body as caption on both drivers (fakes assert `sendMedia`); the SMS text ends with the
attachment line and the segment count includes it; a non-recipient, another guardian of the same
child and a guardian whose link ended get `404` on the inbox attachment; the sender gets it; a PDF
thumbnail `404`; no URL in any body) · R149 (urgent → WhatsApp and SMS legs together for a
`whatsapp` guardian, push too; normal → WhatsApp and push, `sms*` only when `announcement_normal`
is allowed; normal keypad parent with the type not allowed → `suppressed: not_allowed` and in the
inbox; `smsSegments` null when not allowed) · R150 (delivery summary equals a direct sum over
`message_deliveries` and `messages` for a seeded run; `byChannel` counts the latest attempt per
message-channel; no DTO field or string contains "read") · R151 (publish creates one announcement
with `holiday_id`, audience `everyone`, type `holiday_notice`, `holidays.announcement_id` set, one
message per guardian/staff/student-with-login — slice 10's R117 assertions pass against the new
path; a wholly past holiday publishes with no announcement; cancel withdraws queued notices by
subject `announcement`, writes a second announcement with `holiday_id` and sends it to everyone;
a holiday published before the slice (`announcement_id` null, seeded) cancels through the old path
unchanged; `GET /announcements?holidayId=` lists both rows) · R152 (every mutating route's audit
row carries counts by kind and never a name; `announcement.sent` records the three dedupe counts;
the job writes no audit; a replay and a no-op write none) · R110 (`SMS_TOO_LONG` at create, patch
and send for an allowed type over three segments; the holiday notice fits one segment with
30/100-character fixtures; a normal announcement with SMS off accepts 1,800 characters) · R109
(`SMS_CAP_EXCEEDED` details; units count always-legs only; a scheduled fire past the cap suppresses
`cap_reached` per leg and sends `sms_cap_reached` once) · R143 (replay `200` with the header; a
different body `409`; another user's equal key independent; a refused create leaves the key
unconsumed; a racing pair yields one row) · R165 (inbox DTO snapshot: no other student, no
guardian name or phone, no staff phone, no identity field; `viaStudents` only scope children, an
ended link drops the name) · R166 (`/me/inbox*` under `me-reads`; preview under its own bucket) ·
inbox predicate (a guardian issued a login after the send sees it; `messaging_test` absent;
`subject_cancelled` absent; `no_channel` present; staff-guardian sees one row; `channel_plan`
without `in_app` still listed) · `MeDto.capabilityScopes` (same length and order as
`capabilities`; a teacher with a grant shows `all` for that key and `assigned_sections` for the
rest; principal all `all`; a guardian-only session `[]`) · the platform boundary (a fixture
importing an announcement or inbox repository from `modules/platform/**` fails lint; no platform
route reads `messages`) · isolation tests for the four tables · `routes.e2e-spec.ts`
classification for the five mutating routes · the R68 snapshot with the four `/me/inbox*` routes.

Fix round: send now answers `sending` and the job writes (a repeated job and a retried send
change nothing); the 3,000-recipient request is under a third of the request limit and its job is
measured under half the job limit (both printed); a shared phone kept by the WhatsApp sharer when
the first sharer is keypad on a non-SMS type, or push-only; the cap's upper bound skips the plan
and an over-bound send counts exactly; scheduling re-checks scope; the claim on the due time with
a worker 500 ms behind; the sweep recovers a `sending` row; five failures give up (and nothing else
leaves `sending` for `draft`); a holiday cancelled before its notice job ran tells nobody of the
closure; the attachment read once for a fan-out (and `MediaCache` unit tests); every
`OutboxDispatcher` method's job read back from a real Redis queue under its own prefix, and every
messaging-harness suite fails on a swallowed enqueue failure.

Playwright: principal composes, previews the count and SMS units, sends (the response is `sending`;
the detail page polls to `sent`); the delivery page fills in from the fake drivers; a teacher cannot see "Everyone" and gets the inline `422` on a foreign
section; the holiday publish confirm shows the preview; a parent's inbox (through the API, as
slice 11) shows the announcement once with the right `viaStudents`.

---

## Decisions made here

1. **Announcements use today's scope only** (no dated scope): they are sent now or later, never
   about a past date; a cover teacher reaches the covered section while the cover row is live.
   Scope is re-checked at create, patch and send; the scheduled job re-checks against the creator's
   scope on the firing day and **drops** out-of-scope items (counted in the audit) rather than
   refusing — there is nobody to answer.
2. **Broad kinds are refused `403 PERMISSION_DENIED` `details.reason = 'audience_requires_school'`
   before any target is read**, so a `403` never reveals whether a target exists; an office clerk
   with `.scope` at `all` scope targets any class or section but not `everyone` ("If granted",
   concept slide 02).
3. **`can_login` is irrelevant to resolution** — a guardian with a live link to an active student is
   a recipient whatever the login flag says, as slice 10's holiday notice, slice 11's alerts and
   slice 13's diary already decided. The plan's slice-14 sentence ("guardians with no live
   `can_login` link" excluded) is read as a slip: the holiday notice becomes an `everyone`
   announcement here, so the two rules must be one, and WhatsApp/SMS are the primary channels
   (plan §0.14). The flag governs the app, not the message.
4. **"Active student" means `students.status = 'active'`** for every audience, the plan's and slice
   10's wording — so a **suspended** child's family receives no announcement. That is questionable
   (suspension is disciplinary, not an exit, and the family still owes fees) and is raised for the
   owner under register item 11 (exit states); one definition is kept across slices until then.
   `student` as a **named target** accepts a suspended student (§4.2) so the office can tell that
   family on purpose.
5. **Dedupe order by user → identity hash → phone**, with the guardian row winning each tie; phone
   dedupe is a `NotificationService` option (`dedupePhones`) that strips the phone legs of the
   later recipient and records a new suppression reason **`duplicate_phone`** when nothing is left
   — one WhatsApp, two inbox rows, and a visible reason. A person deduped by identity hash from a
   staff login not linked to the guardian row will not see the row in their staff inbox; the
   office links the login (rule 12) and the next announcement reaches them once, visibly.
6. **The announcement body is 1,800 characters, not 2,000**: the stored message body is
   `"{school}: {title}\n{body}"` (every SMS-eligible body starts with the school's name) and
   `messages.body` is 2,000. A second composed shape per channel was rejected: one stored body, one
   SMS normalisation, one segment count. `messages.title` (new, nullable) carries the push title
   and email subject for announcement-carried types; everything else keeps `titleOf`.
7. **The SMS attachment line is appended by the processor's SMS leg** whenever `media_object_key`
   is set ("see the app", R148), so the stored body stays the WhatsApp caption and push text; the
   WhatsApp leg sends the bytes through a new `sendMedia` on both drivers. Segment counts (preview,
   `smsSegments`, `SMS_TOO_LONG`) include the line.
8. **SMS units count always-legs only** (not `sms*` after-failure legs), computed with the real
   `planChannels` predicates per person; `SMS_CAP_EXCEEDED` is a send-time pre-check for the
   principal's benefit — the per-leg atomic reservation (slice 9 §7.7) remains the enforcement, so
   a scheduled fire past the cap suppresses `cap_reached` per leg instead of failing.
9. **Reversed in the fix round (2026-10-04, main-thread decision): "send now" answers `sending`.**
   The original decision kept resolution and message writes inside the request so that `sending`
   was never observed. A cold run at 3,000 recipients answered `500` (P2028) at 23.7 s, past the
   15 s interactive-transaction limit, and the holiday publish carried the same fan-out. Now the
   request validates, checks scope and the SMS limits (so every refusal still reaches the caller
   synchronously), commits the row `sending` and returns it; the claim-safe `announcement-send`
   job, already used by the scheduled path, resolves and writes after commit in its own
   transaction with a longer limit (§5.6). The enum value needed no migration, as this decision
   foresaw. `scheduled_at` is kept on a sent row as history, so the plan's "set iff scheduled"
   CHECK is relaxed (§11 item 2).
10. **A scheduled fire with zero recipients ends `sent` with `recipientCount 0`**, and a holiday
    notice in an empty school likewise; `ANNOUNCEMENT_NO_RECIPIENTS` is a refusal only when a
    caller is there to hear it.
11. **`SMS_TOO_LONG` applies only when the announcement's message type is in the school's allow
    list now** (so an SMS leg can exist); a normal announcement with SMS off has no limit beyond
    1,800. The scheduled job does not re-check length: the allow list changing after scheduling is
    the school's own act and the segment count was on the row.
12. **`announcement_audiences` rows of a draft or scheduled announcement are replaced on `PATCH`**
    (delete and insert inside the transaction) and the table has no no-delete trigger — a draft's
    audience is a form field, not history (the slice-9 device-row precedent); the audit row records
    the change. The other three tables are append-only; `announcements` content is frozen by
    trigger once final.
13. **Mobile compose is online**: `POST /announcements` takes the `Idempotency-Key` for retry
    safety on both clients, but the app does not queue it in the outbox — preview needs the
    network and `send` is online-only (R162); an announcement is not written from a staff room
    without signal.
14. **Holiday publish creates the announcement through an internal method that does not check
    `announcement.send.*`**: `holiday.manage` is the authority, the system composes the notice, and
    the publisher is `created_by` (so a `.scope`-only publisher sees it as their own row). The
    notice travels as `holiday_notice` (its own allow-list entry, on by default), never as
    `announcement_normal`; title `School closed <range>`, body `<name>. Reopens <day>.`, one
    segment, `expires_on = endsOn`, audience `everyone`.
15. **A holiday cancellation after this slice is a second `everyone` announcement resolved now**,
    not slice 10's "exactly those told": the message is harmless to someone never told, and a
    "those told" audience kind is machinery for one case. Queued notices of the first announcement
    are withdrawn (`subject_cancelled`) by the existing statement with subject `announcement`; the
    notice row stays `sent` (R146). Holidays published before the slice are **not backfilled**
    (slice 10 decision 1) and cancel through the old path; the `holiday_notice` template stays for
    them.
16. **The inbox predicate is "a message addressed to one of my persons"**, not "a message with an
    `in_app` leg": a guardian issued a login later sees everything (plan §4.2), suppressed messages
    are in the inbox (the inbox is now their channel), and only `subject_cancelled` withdrawals and
    expired announcements are excluded. Pre-slice-14 holiday notices appear as `notice` rows.
17. **`messaging_test` rows are not inbox items**: a test is the sender's own diagnostic, shown by
    the messaging settings screen, not a notice.
18. **`GET /me/inbox/:id` is added** (the plan lists only the list and attachment routes): a push
    deep-link (`/inbox/[messageId]`, slice 15 §8) must open the item when the list cache is stale.
    The inbox item id **is** the `messages` row id, as slice 15's push payload assumed.
19. **`viaStudents` is resolved per subject type in one query each**, restricted to the caller's
    current guardian scope (R164, R165); for announcements from `announcement_recipient_students`,
    for alerts and remarks from the subject row, for diary entries from the enrolment-on-date
    predicate; staff and student callers get `[]`.
20. **`MeDto.capabilityScopes` is `{ capability, scope }[]` parallel to `capabilities`**, read from
    the already-computed `access.lines` (no new query), exposing breadth only (`all` |
    `assigned_sections`) and no source ids — enough for the web to show school-wide controls to a
    granted teacher (the wave-E finding) and for the picker to choose its mode. The mobile
    `announce` tab condition is unchanged.
21. **Archived or inactive targets that the caller can see are `409`s** (`CLASS_ARCHIVED`,
    `SECTION_ARCHIVED`, `STUDENT_NOT_ACTIVE`, `GUARDIAN_MERGED`, `STAFF_NOT_ACTIVE`), as slice 13
    does; invisibility of any kind is the one `422 REFERENCE_NOT_FOUND` body (R144). `everyone`
    with any other item, roles on the wrong kind and duplicate targets are `422 INVALID_VALUE`.
22. **The platform never reads messages or announcements** (R114, wave-D security review): no
    platform route is added, the health view keeps reading the rollup, and the lint boundary that
    confines platform repositories gains its mirror for this slice's repositories.
23. **The delivery summary is computed live** from the rows (R150: equal by construction), never
    stored; `byChannel` counts the latest attempt per message and channel; `messages` status counts
    and `smsUnitsReserved` are added to the plan's shape so the screen can say "N still sending" and
    "M SMS units used".
24. **`preview-audience` takes an optional `holiday: true`** so the holiday publish dialog previews
    with the `holiday_notice` allow-list entry, and `title`/`body`/`hasAttachment` so the segment
    count is exact; it is throttled per user (30/min, 300/hour) because it walks the school.
25. **A send that keeps failing stops after five attempts** (fix round): the sweep would otherwise
    re-enqueue a failing `announcement-send` job every 2 minutes forever, unseen. Each failure is
    counted on the row in its own transaction; the fifth (about ten minutes of retries) moves the
    row back to `draft` with `send_failed_at`, audited `announcement.send_failed` against the
    creator. Nothing was sent (each attempt rolled back), so `draft` is the honest state and lets
    the sender fix and send again; a new status value was rejected because the web and mobile
    status unions would have to change for a rare case.
