# Phase 2 — Daily operations: build plan

**Audience:** the Opus 5.5 session that writes the code. Self-contained; read `CLAUDE.md`, then
`docs/WORKLOG.md` ("What Phase 2 inherits" and "Left to do"), then this file top to bottom.
**Author:** Fable 5.1, 2026-10-03. **Builds on** `phase-1-foundation.md` (slices 0–8, rules
R1–R104), which is complete; nothing from it is restated unless Phase 2 changes it.
**Reviewed** by `business-rules`, `security-reviewer`, `data-architect` and `api-designer` on
2026-10-03; their findings are folded in (the first draft's alert timing, roster rule, holiday
shape, parent scope, worker tenancy, webhook exception and endpoint naming were all changed).
**Status:** approved for execution **once the owner answers the seven items in §1 marked "cannot
default"**; slice 9 and 10 groundwork may start before that.

Phase 2 delivers what the client deck calls *daily operations*: **the register, the diary, notices,
the channels that reach parents, and the first mobile app.** At the end a teacher marks attendance
on a phone in a corridor with no signal and it reaches the server when the signal returns; a parent
on a keypad phone gets an SMS the same morning their child is absent, and a correction if the
child turns up late; the principal sees which registers nobody recorded; the school writes a notice
once and every parent receives it once. Nothing financial, no marks, no events.

**Size, stated honestly.** About **40 working days**, as estimated at the Phase 1 close. Three
things make it that long: the messaging layer is new infrastructure (a worker, four drivers, a
delivery log) that every later phase stands on; the mobile app is a second client with its own
offline store; and attendance has more edge cases than any Phase 1 slice (corrections, cover,
holidays, derived daily status, alerts that must not lie). Slices 9–17 continue Phase 1's numbering;
rules continue from R105.

---

## 0. Rules that bind every task

Phase 1 §0 rules 1–10 apply unchanged, plus the wave process recorded in `WORKLOG.md` ("Process
since 2026-10-03"), which replaces §0 rule 2's per-slice gate with a per-wave gate and one full
`phase-gate` at slice 17. Additions for Phase 2:

11. **Nothing reaches a parent except through `NotificationService`.** No module imports a
    driver. Lint enforces it: `src/messaging/drivers/**` is importable only from
    `src/messaging/**`; `bullmq` only from `src/jobs/**` and `src/messaging/outbox-dispatcher.ts`.
    A fixture test plants each forbidden import and fails.
12. **Every message type is a row in a code table (§4.2) before any sender uses it.** The table
    names its priority, its channels, whether SMS is allowed by default and its template. Adding a
    sender without adding a type is a compile error (the type is an enum key).
13. **Never present delivered as read.** No screen, DTO or report uses the word "read" for a
    message. The delivery log records accepted, delivered and failed per channel.
14. **The app is secondary.** A feature that reaches a guardian is incomplete until its WhatsApp
    and SMS behaviour is stated and tested, including the keypad-phone case (rule 17).
15. **Mobile writes are honest about state.** Saved on device → sending → saved on server →
    failed with reason. No green tick before the server acknowledges (R157).
16. **Settings over decisions.** Where the owner's answer to a register item is a policy a school
    could reasonably choose either way (late counts as, SMS allow list), it is a per-school setting
    with a platform default; the owner's answer sets the default. Where it is structural (period vs
    daily — settled), it is code. Where it is commercial, procurement or safety (§1 "cannot
    default"), it is the owner's answer and nothing ships without it.
17. **Phase 1 conventions are not re-litigated by naming.** No `PUT`; actions are
    `POST /x/:id/<verb>`; ranges are `xFrom`/`xTo`; staged uploads are `stagedUploadId`; the one
    idempotency mechanism is the slice-6 `Idempotency-Key` header; one `school_settings` resource.
    `api-designer` writes each slice's contract before controllers, as before.

---

## 1. Decisions Phase 2 needs — settle these before the slice that needs them

The register in `CLAUDE.md` is canonical. Two lists: defaults the owner merely tunes, and
questions that cannot be defaulted because they are commercial, procurement or safety.

### 1.1 Working defaults — the owner's answer replaces the default, no rework

| # | Item | Default in this plan | First used |
|---|---|---|---|
| 22 | Which message types may reach SMS | Per-school allow list, platform default: `absence_alert`, `late_advice`, `attendance_corrected`, `announcement_urgent`, `holiday_notice`. **Never:** `diary_posted`, `remark_posted`, `announcement_normal`. Fee and result types join in Phases 3 and 4 | Slice 9 |
| 23 | Late arrival for the percentage | `late_counts_as ∈ {present, half_day, absent_after_cutoff}` default `present`; `late_cutoff_time` nullable (needed only by the third value); `late` is always stored as its own status with `arrived_at` when known. **Early departure is not recorded in Phase 2** (no status for it) | Slice 11 |
| — | Authorised absence | Status `on_leave`; `leave_counts_as ∈ {excused, absent}` default `excused` (removed from the denominator). Anyone who may mark the register may mark it | Slice 11 |
| — | Amendment window | `attendance_amend_window_days` default **3**. The deck told the client "until the close of the teaching day" (0); the plan departs because a teacher who was offline on Friday must still be able to sync on Monday. The owner sets the default | Slice 11 |
| — | Absence alert time | `absence_alert_time` default **09:30** local, with a floor of 30 minutes after the register was submitted (the deck's worked example: register at 8:00, child arrives 8:40, advice at 9:30) | Slice 11 |
| 26 | Remark visibility | `remark_default_visibility` default **`guardian`**; `remark_notify_guardians` default **off** (= "on enquiry": a guardian-visible remark appears in the app, no push). Remarks are never sent by WhatsApp/SMS in Phase 2. Visibility is a level: `student` implies `guardian` | Slice 13 |
| — | Bearer session lifetimes | Guardian and student sessions: **30 d idle / 180 d absolute**. **Staff: 14 d idle / 90 d absolute** (a lost teacher phone writes registers and reads rosters); chosen per session from the capacities at login — a teacher-parent gets the staff values. Cookie sessions keep Phase 1's values | Slice 9 |
| 30 | Privileged capabilities on a default password | Not needed by Phase 2; still open | — |

### 1.2 Cannot default — needs the owner's answer before the named slice

| # | Question | Why it cannot default | Blocks |
|---|---|---|---|
| 17 | **One WhatsApp number per school** (the plan's design: a platform-owned `whatsapp_numbers` row per school; a platform-wide number is the same table with one row shared) — **who provides the SIM for each pilot school**, and the school's WhatsApp account has two-step verification enabled with the SIM held by the school, not a staff member | Procurement | Slice 9's first real delivery; slice 17 |
| 18 | **Monthly SMS allowance per school** (`sms_monthly_cap`; the code default of 500 is for development only). The deck told the client "a monthly allowance agreed in advance" | Commercial term; feeds Phase 3's subscription plan | Slice 9's production value |
| 13 | **What a suspended school still sends.** Phase 1 R80 makes a suspended school read-only, so registers cannot even be recorded. Options: (a) registers and absence alerts, SMS included, continue under suspension as a named R80 exemption; (b) nothing continues and the school is told so at suspension. A child's absence going unreported because a subscription lapsed is a safety call, not a default | Safety | Slice 9's R113 |
| — | **SMS gateway provider.** The driver is written to a generic contract (send, delivery-report webhook); the owner picks a Pakistani gateway with per-message delivery reports and a sender ID. Many offer no request signature — then its reports are accepted only from its published addresses at the edge proxy and treated as advisory (R172) | Vendor and cost | Slice 17 (one real send on staging) |
| — | **WhatsApp via WAHA.** WAHA automates WhatsApp Web; **numbers used this way can be banned.** The driver interface is the mitigation (the WhatsApp Business Cloud API is a second driver behind it). Also: WAHA Core runs one session per container, WAHA Plus several — more than one pilot school on one host needs Plus or one container per school. Owner accepts the pilot risk, or chooses the Business API from the start (per-conversation pricing, verified business) | Risk acceptance and cost | Slice 9's first real driver |
| — | **Who turns "absent" into "late" at the gate.** The deck's slide 8 has the office recording the arrival; office staff hold no `attendance.student.mark` by default (Phase 1 §7). The plan builds `POST /attendance-arrivals` under that capability; the owner says whether the office-staff default gains `attendance.student.mark` (all scope) or each school grants it per clerk | Capability-default change | Slice 11 |
| — | **How much a cover teacher gets.** The deck says "access to that class for the specified dates". The plan's `cover` assignment confers the **same section scope as a class teacher**: register, diary (any subject), remarks, `student.view` (guardian phone numbers included), section-scoped announcements. Owner confirms, or narrows to attendance only | Scope breadth | Slice 10 |
| — | **Push and store accounts.** A Firebase project (FCM) in the owner's Google account; a **Google Play developer account** ($25 one-off) for the internal-testing track; **Android only in Phase 2** (iOS needs an Apple developer account, a Mac and its own review; deferred) | Accounts | Slice 15 |

---

## 2. Shape of the system after Phase 2

```
asms/
  apps/api/
    src/
      main.ts            HTTP process: serves requests, ENQUEUES after commit, runs no job
      worker.ts          NEW: queue consumer + every scheduled job (one instance in production)
      jobs/              NEW: BullMQ processors; the only importer of bullmq Worker/Job and of
                         tenancy/queue.mint.ts; every job body runs inside runAsSchool()
      messaging/         NEW: NotificationService, message types, templates, routing, outbox
        drivers/         push (FCM), whatsapp (WAHA), sms (gateway), email — one interface
      webhooks/          NEW: WAHA and SMS delivery reports; @Webhook access; not in any OpenAPI doc
      modules/
        calendar/        NEW: holidays, teaching-day arithmetic
        attendance/      NEW: registers, marks, arrivals, alerts, day status, summaries, staff
        diary/           NEW: diary entries, remarks
        announcements/   NEW: announcements, audiences, recipients
        me/              NEW routes under /me/*: inbox, calendar, devices, children/*, student/*, staff/*
      repositories/platform/
        school-by-id.repository.ts      NEW, importable only from tenancy/queue.mint.ts
        whatsapp-number.repository.ts   NEW, platform-owned table
        delivery-health.repository.ts   NEW, non-tenant rollup written by the per-school job
      tenancy/queue.mint.ts   NEW: the fifth SchoolId constructor; runAsSchool()
  apps/web/              school screens for every slice; platform: WhatsApp pairing, delivery health
  apps/mobile/           NEW: Expo (React Native), one role-aware app, Android
  packages/shared/       message types, attendance enums, categories, error codes, app-version floor
  docker-compose.yml     + waha (profile, private network, no published port)
```

Two processes from one codebase: `main.ts` serves HTTP and **enqueues**; `worker.ts` consumes
queues and runs every scheduled job (the Phase 1 staged-upload sweep moves there; `@Cron` is
removed from the HTTP process so two API replicas never run a job twice). Development runs both
under `pnpm dev`. Exactly one worker instance in production is a deployment rule (`devops`).

The mobile app is **one Expo application** that signs in with the same `POST /auth/login`,
asks for a bearer session, reads `GET /me` and composes its tabs from the capacities, capabilities
and assignments it finds there: teacher tabs (register, diary, my classes), guardian tabs
(children, inbox), student tabs (my diary, my attendance), principal tabs (today, unrecorded
registers, announce). A teacher-parent sees both sets from one install. **If a task needs a
keyboard, it stays on the web**: admissions, assignments, settings, announcement composition
beyond a short notice.

---

## 3. Stack additions and environment

| Item | Decision |
|---|---|
| Queue | **BullMQ** on the existing Redis (`maxmemory-policy noeviction` already set). Queues `messaging`, `attendance`, `scheduled`. Job payload: `{ schoolId: string, ...ids }` — validated by zod on receipt (§4.1); never a body, a phone number or a name. Deterministic job ids (`message:<id>`). Repeatable jobs replace `@nestjs/schedule` crons. **Redis is not a system of record**: every job is re-derivable from Postgres rows, the outbox sweep re-enqueues anything lost, and a replayed job finds its row already claimed (R105). |
| Worker | `apps/api/src/worker.ts`, same Nest modules, `WORKER=1`. `concurrency` set explicitly per queue. Every job body runs inside `runAsSchool(schoolId, fn)` in `src/tenancy/` — the only place the worker may open a CLS context — so concurrent jobs for two schools never share a transaction or tenant (test: interleaved jobs for A and B; each repository call sees only its own context). Health endpoint on its own port; graceful shutdown drains in-flight jobs. |
| Push | **Firebase Cloud Messaging** via `firebase-admin`. `FCM_SERVICE_ACCOUNT_JSON` (base64); absent → `LogPushDriver` only when `NODE_ENV !== production` (R112). Push payload: `{ type, subjectType, subjectId, messageId }`, a title and the rendered body — never an identity number, phone number or token (R173). |
| WhatsApp | **WAHA** (self-hosted, Docker, pinned by digest) behind `WhatsAppDriver`. One session per school number. Media is sent to WAHA as **bytes** (base64 or multipart), never as a URL the API would have to serve (R43 stands; R148). The webhook receives delivery status and session status; inbound messages are **counted and ignored** (the inbound workflow is unspecified). **Deployment requirements (DoD):** private compose network, no published port, only the API reaches it; `WHATSAPP_API_KEY` random; dashboard and swagger off (`WAHA_DASHBOARD_ENABLED=false`, `WHATSAPP_SWAGGER_ENABLED=false`); non-root, read-only root FS; the session and files volume **encrypted**, in encrypted backups, excluded from log shipping; log level `info` (debug prints message content); inbound media download off; files lifetime 24 h; message store purged every 7 days; the pairing QR shown once to a platform admin, never stored or logged, the action audited. `WAHA_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET`. Compose profile `whatsapp`, off by default. |
| SMS | `SmsDriver` interface: `send(to, text) → providerRef`, `parseDeliveryReport(req)`. `LogSmsDriver` in development and tests; one real adapter when the owner names the provider (§1.2). `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_WEBHOOK_SECRET`. |
| Email | Phase 1's `Mailer` becomes the fourth driver, unchanged behaviour. Staff with a verified email get email as the fallback for internal notices when they have no device. |
| HTTP | `rawBody: true` on the Nest app (webhook HMAC over raw bytes); `426 UPGRADE_REQUIRED` added to the exception filter and the §3.9 status map. |
| Mobile | **Expo** (current stable SDK, pinned on day one and recorded in `WORKLOG.md`), **development builds** (not Expo Go — push needs a native module), `expo-router`, TanStack Query, `openapi-fetch` with the same generated school client, `expo-secure-store` (token), `expo-sqlite` (cache + outbox), `expo-notifications` (FCM token), `expo-image` (thumbnails on tap). No sync framework (WatermelonDB, PowerSync): the offline surface is three screens and one outbox table. Android only; `usesCleartextTraffic=false`; the API base URL is https and fixed per build. EAS Build or `expo run:android`; Play internal-testing track. |
| Web | No new packages. |
| Tests | API: as Phase 1, plus a **recorded-outbox** helper (`expectMessages(...)`) and driver contract tests that run against a real driver only with `RUN_DRIVER_TESTS=1` (never in CI). Mobile: Jest + React Native Testing Library for the outbox and routing; **Maestro** flows for login → mark register → sync on an Android emulator. Playwright as before for the web. |
| CI | Adds: worker boots; Redis-backed queue test; mobile typecheck, unit tests and one Maestro flow on an emulator (a separate, slower job). |
| Secrets | `.env.example` gains `FCM_SERVICE_ACCOUNT_JSON`, `WAHA_*`, `SMS_*`, `MOBILE_MIN_APP_VERSION`. The API still refuses to start if one of its own keys is missing; driver keys are optional and their absence selects the log driver **only outside production** (R112). |

---

## 4. Cross-cutting conventions new in Phase 2

### 4.1 The worker, the fifth `SchoolId` constructor, and named exceptions 5 and 6

**Payload resolution.** Jobs carry `schoolId` as a string. The worker turns it into a `SchoolId`
with `fromQueuePayload(payload)` in `src/tenancy/queue.mint.ts`, importable only from
`src/jobs/**`. It validates the payload shape with zod (`schoolId` matches `^[1-9][0-9]{0,18}$`,
only id fields; anything else is a **dropped** job, not a retry), reads the school through
`src/repositories/platform/school-by-id.repository.ts` — a new platform repository with one method
`findById(id: bigint) → { id: bigint; status } | null` that returns an **unbranded** row and is
importable only from `queue.mint.ts` (a `NAMED_EXCEPTION_SITES` entry) — and applies the brand
with a new `schoolIdFromQueuePayload(row)` in `school-id.mint.ts`. A terminated school is dropped;
a suspended school runs with R113's suppression. `SchoolLookupRepository` keeps exactly its one
method. Every enqueue goes through `OutboxDispatcher.enqueue(schoolId: SchoolId, jobs)`, so a
payload's `schoolId` is always serialised from a brand. **Housekeeping jobs that must reach every
school** (the staged-upload sweep, the outbox sweep, the delivery-health rollup) keep the Phase 1
in-process fan-out (`SchoolFanOutRepository.listAllForFanOut`) and never pass through
`fromQueuePayload`. This widens named exception 3 to "fan-out and job-payload resolution";
record it in `CLAUDE.md` when slice 9 lands.

**Lint and tests the boundary must prove:** `queue.mint` imported from `src/modules/**` or
`src/messaging/**` fails; `school-by-id.repository` imported from anywhere but `queue.mint.ts`
fails; `bullmq` imported from a service fails; a payload `{ schoolId: B, messageId: <A's row> }`
touches no row and logs no id; a non-numeric or unknown `schoolId` is dropped without retry.

**Enqueue after commit.** Services collect jobs during the transaction and flush them in the
after-commit hook (Phase 1 §3.3). A crash between commit and flush is recovered by the **outbox
sweep** every two minutes, which fans out per school (so its index leads with `school_id`): any
`messages` row still `queued` and older than two minutes, any `announcements` row `scheduled` whose
time has passed, any `attendance_alerts` row due and `pending`, is re-enqueued. A processor's
**first statement is a scoped conditional claim** (`UPDATE messages SET status = 'sending' WHERE
school_id = $1 AND id = $2 AND status = 'queued'`); zero rows means already handled and the job
ends successfully without a delivery, so a replayed or forged job id sends nothing (R105).

**Named exception 5 — webhook correlation.** A delivery report carries a provider reference, not
a school. `DeliveryWebhookRepository` (tagged `$queryRaw`, listed in `RAW_SQL_FILES`, with its own
isolation test) has exactly two statements: `UPDATE message_deliveries SET status = $3, … WHERE
channel = $1 AND provider_ref_hash = $2 AND status = 'accepted' RETURNING school_id, message_id`
and the same shape against `whatsapp_numbers` by `waha_session` for session-status events. The
returned `school_id` is used only to enqueue `{ schoolId, messageId }` for the roll-up, which goes
through `fromQueuePayload`. An unknown reference is `204` and a counter, never an insert. The
webhook handlers never mint a `SchoolId` and never call a scoped repository. Recorded in
`CLAUDE.md` with slice 9.

**Named exception 6 — platform-owned messaging tables.** `whatsapp_numbers` (the platform
provisions the SIM, pairs the session and disables it) and `platform_delivery_health` (a per-day
rollup written by the per-school job) are **non-tenant tables carrying a `school_id` column**, like
`platform_audit_log`. The platform reads and writes them through `repositories/platform/**`; the
school reads its own WhatsApp status through a single-predicate read (`school_id = schoolId`),
the `OwnSchoolRepository` pattern. The platform never reads `messages` or `message_deliveries`.
This keeps exception 1's "exactly two operations inside a school" intact. Recorded with slice 9.

### 4.2 The notification service

One entry point: `NotificationService.send(schoolId, { type, subject, recipients, vars })`,
called inside the sender's transaction. It writes one `messages` row **per person** (a guardian,
a staff member or a student — three nullable foreign keys, exactly one set), renders the English
body from the type's template (free text only for announcements), computes the channel plan from
the type and the person's `contact_capability` (R106), and registers the job for after commit.
The partial unique index per (subject, person) makes a retry idempotent (R107). The worker's
`messaging` processor claims the row, tries the channels in plan order, writes a
`message_deliveries` row per attempt, retries with backoff, falls to the next channel after the
type's attempt budget, and stops at the first channel that reports accepted. Delivery-status
webhooks (WAHA, SMS) move a delivery forward; FCM reports accepted only.

**Message types (code table, `packages/shared/src/messages.ts`):**

| Type | Priority | Audience | Channels in order | SMS by default | Trigger |
|---|---|---|---|---|---|
| `absence_alert` | urgent | guardians of the student | whatsapp, sms · push | yes | R126 |
| `late_advice` | normal | guardians | whatsapp · sms fallback · push | yes | R126, if `late_advice_enabled` |
| `attendance_corrected` | normal | guardians | whatsapp · sms fallback · push | yes | R126 |
| `announcement_urgent` | urgent | audience | whatsapp + sms · push | yes | R149 |
| `announcement_normal` | normal | audience | whatsapp · push | **no** | R149 |
| `holiday_notice` | normal | all guardians + staff (+ students with logins, in-app) | whatsapp · push · sms fallback | yes | R117/R151 |
| `diary_posted` | low | guardians + students of the section | push · in-app | **never** | R138 |
| `remark_posted` | low | guardians of the student | push · in-app | **never** | R140, if `remark_notify_guardians` |
| `register_unrecorded` | internal | principal + `attendance.student.mark` all-scope holders | push · email | — | R129 |
| `sms_cap_reached` | internal | principal | push · email | — | R109 |
| `whatsapp_session_down` | platform | platform admins | email (school name and id only) | — | R112 |

"Urgent" means WhatsApp and SMS **both**, always, for a WhatsApp-capable guardian; "normal" means
WhatsApp first, SMS only after WhatsApp fails its attempts **and** the type is in the allow list.
"Low" never leaves the app. Internal types go to staff, who have the app by definition, with
email as the only fallback.

**Routing by `contact_capability` (R106):**

| Capability | urgent | normal | low |
|---|---|---|---|
| `whatsapp` | WhatsApp + SMS; push too if a device | WhatsApp; push too; SMS after failure if allowed | push, in-app |
| `smartphone_data` | push + SMS | push if a device, else SMS if allowed | push, in-app |
| `keypad` | SMS | SMS if allowed, else `suppressed:not_allowed` | `suppressed:no_channel` |

A suppression is a delivery row with a reason, so the school can see that a keypad-phone parent
never receives the diary (and why), rather than wondering.

**Templates** are English, in code, parameterised by names, dates and the school's name; SMS
templates are tested to fit one GSM-7 segment (160 characters) with the longest realistic values;
announcement SMS is capped at three segments (R110). Bodies never contain an identity number,
a token, a password or an amount with paisa (rule 15). **The R16 scanner gains a phone pattern**
(`(\+?92|0)3\d{2}[\s-]?\d{7}`) in both the log scrubber and the table scan, and pino `redact`
gains `*.phone`, `*.to`, `*.from`, `*.chatId`, `*.pushToken`, `*.body`, `*.text` (R111). Provider
references (WAHA ids embed the recipient's number) are stored only as a hash; provider error text
is mapped to a short enum code, never stored raw.

**The inbox** is one query over `messages`, resolved **by person at read time** from the caller's
`guardian_id` / `staff_id` / `student_id` (so a guardian issued a login after a message was sent
still sees it), joined to `announcements` by subject. `announcement_recipients` serves audience
resolution and attachment access, not the inbox.

### 4.3 Parent and student access

Guardians and students hold no capabilities (rule 13). Phase 2 adds a second access decorator next
to Phase 1's: `@RequireCapacity('guardian' | 'student')` (there is no `'any'`; that is
`@AuthenticatedOnly()`). `RouteAccessGuard` still demands exactly one decorator per route; the R68
route snapshot lists the `@RequireCapacity` routes and asserts **they all live under `/me/*`**,
because R78 already guarantees a parent-only or student-only session is `403` everywhere else. The
naming rule: **the first segment after `/me/` names the capacity** — `/me/children/*` guardian,
`/me/student/*` student, `/me/staff/*` staff (`@RequireStaff()`), and anything directly under
`/me/` any live session.

A guardian's `Scope` is `{ kind: 'students', ids }` — the students linked to their guardian row by
**live `student_guardian` rows with `can_login = true`**, the guardian row not merged (R163); a
student's is their own id. The brand is the same `Scope` type, constructed only by
`PermissionsService`, so every student-linked repository method refuses to run without it
(control 7). The `studentId` in a `/me/children/:id/*` path must be inside the scope or the answer
is `404`. **Ending a link removes the child on the next request** (R164). A `/me/*` response never
carries another student, another guardian's name, phone, relationship or flags, a staff phone
number, an identity number, or a teacher's free-text attendance note (R165).

A user who is both staff and guardian (one login, rule 12) reaches staff routes with capabilities
and `/me/children/*` with their guardian scope; the two never mix on one route. `MeDto` gains,
additively, `capacities: ('staff'|'guardian'|'student')[]` and `assignments: [{ id, role,
classId, className, sectionId, sectionName, attendanceMode, startsOn, endsOn }]` (rows active
today, cover included) — the app composes its tabs from these (R156).

### 4.4 Dated, role-aware scope for writes

The guard's `Scope` is today's section ids and carries no role. Attendance and diary writes need
more: who may submit a register dated last Friday, whether a subject teacher may write another
subject's diary, whether a cover is inside its dates. `PermissionsService.scopeOf(session, { on:
date })` returns the sections active **on that date** with their roles, backed by
`TeacherAssignmentRepository.rolesOn(schoolId, staffId, sectionId, date) → { classTeacher | cover,
subjectIds[] }`. The route decorator still gates the route; the service gates the row (R175).
Reads by list use today's scope (Phase 1's `student.view` rule); register reads, submits and
amendments use scope on the register's date.

### 4.5 Settings (one resource: `GET|PATCH /school/settings`, `school.settings.manage`)

The Phase 1 DTO grows additively; one audit action `school_settings.updated { changes }`.

| Setting | Default | Used by |
|---|---|---|
| `periodsPerDay` (1–12) | 8 | period-mode registers (R121) |
| `weeklyOffDays` (set of weekdays, 0–6, not all seven) | Sunday | teaching-day arithmetic (R116) |
| `attendanceAmendWindowDays` (0–30) | 3 | R123 |
| `registerDeadlineTime` (local time) | 10:00 | R129 |
| `absenceAlertTime` (local time) | 09:30 | R126 |
| `lateAdviceEnabled` | false | R126 |
| `lateCountsAs` / `lateCutoffTime` | present / null | R128, item 23 |
| `leaveCountsAs` | excused | R128 |
| `smsMonthlyCap` (0–10000) | 500 (development) | R109, item 18 |
| `smsAllowedTypes` (`MessageType[]`) | §1.1 item 22 | R109 |
| `remarkDefaultVisibility` | guardian | R140, item 26 |
| `remarkNotifyGuardians` | false | R140 |

Changing `periodsPerDay` never rewrites history: a register keeps the period count it was
recorded with, and `registers_expected` on a summary row is frozen at computation.

### 4.6 History on tables that have a natural key

Attendance marks have a natural unique key (rule 14) and a diary entry is unique per section, date
and subject, so a correction cannot be "a new row" without breaking the key. The pattern, used by
both: the current row is updated **and** a `BEFORE UPDATE` row trigger inserts the old and new
values, `changed_by`, `changed_at` and `reason` into an append-only `*_changes` table that refuses
UPDATE and DELETE. The service never writes the changes table directly.

Mechanics, verified against Prisma 7's interactive transactions:
- The service sets the actor and reason as **transaction-local settings** through one repository
  helper: `SELECT set_config('asms.actor_user_id', $1, true), set_config('asms.change_reason', $2,
  true)` (tagged `$queryRaw`; `is_local = true` so the value dies with the transaction and respects
  savepoints). A grep test asserts every `set_config(` in `src/` ends with `, true)`; a
  session-level value would leak through the pool.
- The trigger reads `current_setting(name, true)`; a missing actor raises with constraint name
  `<table>_change_actor_required`, a missing reason `<table>_change_reason_required`. `changed_by`
  is a composite FK to `users`, so an actor from another school fails. A no-op update (same status
  and note) writes no history and passes — a replay is free (R125).
- Outside `@Transactional()` the setting lands on a pooled connection and the update on another:
  the trigger refuses. That is fail-closed and tested ("amend outside a transaction is refused").
- Prisma's interactive-transaction timeout is 5 s: a register is one statement (`INSERT … ON
  CONFLICT ON CONSTRAINT attendance_marks_natural_key DO UPDATE … WHERE … IS DISTINCT FROM …`,
  built with `Prisma.join`), so sixty rows fire the trigger only where something changed; the
  nightly recompute runs in batches per section-day, never one long transaction.
- `reason` is `NOT NULL` on `attendance_mark_changes` and `staff_attendance_changes` (R122, R133)
  and nullable on `diary_entry_changes` (an author's same-day edit needs none; the service demands
  one after the window, which a per-school window cannot express as a constraint).

### 4.7 Mobile offline

Three screens write offline: the register, a diary entry, a remark. Each domain row and its
`outbox` row are written in one SQLite transaction. The outbox worker (foreground, on
connectivity change, and on app open) sends items one at a time per endpoint, independent across
endpoints (R158). Registers are idempotent by their natural key — **the outbox coalesces writes to
the same (section, date, period) before sending**, so an offline correction becomes one submit
with a reason, not a terminal failure. Diary entries, remarks and announcements use the slice-6
`Idempotency-Key` header with a client-generated UUIDv7 (no `client_reference` column anywhere).
State per item: `pending → sending → done | failed(reason)`. `409` and `403` from the server are
terminal failures shown with the server's message (a suspended school's teacher must not retry
forever); `401` pauses the queue and asks for sign-in; `426` shows the update screen; network
errors retry with backoff. Read caches are keyed by endpoint and stamped with the server time of
the last refresh, shown as "as of". **Sign-out and any `401` wipe the SQLite store and the secure
store**; the remembered school code and username live only in the secure store.

### 4.8 App version floor, Origin and bearer rules

Every mobile request sends `X-App-Version` (`^[0-9]{1,4}(\.[0-9]{1,4}){2}$`). Middleware **before
session resolution** compares it numerically with `MOBILE_MIN_APP_VERSION` on any request carrying
`Authorization: Bearer` or the header; below the floor is `426 UPGRADE_REQUIRED` with
`details.minimumVersion`, a bearer request without the header is below every floor, and cookie
requests, `/health` and webhooks are exempt (R161). This is how a bad build is retired.

Phase 1's Origin check covered every non-GET without `Authorization`, which a phone cannot pass.
Generalised: **the Origin check applies to every non-GET that carries neither `Authorization` nor
`X-App-Version`** (a custom header makes a browser request non-simple, so cross-origin it needs a
CORS preflight the API never grants; non-browser clients were never CSRF-able). In the other
direction, **`channel: bearer` is refused `401` when the request carries an `Origin` header or any
school cookie, and any request presenting a bearer token together with `Origin` is refused `401`**
— a script injection in the web admin cannot mint or use a long-lived token (R170). Webhooks are
the other exemption, through their own decorator.

---

## 5. Schema, complete for Phase 2

Every tenant table carries `school_id`, `UNIQUE (school_id, id)`, the `@ignore` School relation on
both sides, the `school_id` immutability trigger, composite foreign keys, an index per foreign key
(`school_id` first), statuses as Prisma enums, and an `EXPECTED_OBJECTS` entry per hand-written
object. **Partial unique indexes and exclusion constraints on an enum predicate are correct as
constraints** (the planner just cannot use them for reads — Phase 1's lesson is "put status in the
columns of the *read* index", not "no partial constraints"). The schema guard's column regex is
extended to `/_(id|by|ids)$/` so array-of-id columns can never dodge it again; **no array of ids
exists in Phase 2**. `data-architect` reviews each migration's SQL before it is generated.

**Calendar (slice 10)**
- `holidays`: `starts_on`, `ends_on` (`@db.Date`, `ends_on` defaults to `starts_on`), `name
  varchar(100)`, `description varchar(500)`, `kind` (`public|school`), `applies_to_staff boolean
  default true` (Phase 3 payroll's working days differ from teaching days), `status`
  (`draft|published|cancelled`), `published_at/by`, `cancelled_at/by`, `cancel_reason`,
  `announcement_id` nullable FK (R151). `holidays_live_excl EXCLUDE USING gist (school_id WITH =,
  daterange(starts_on, ends_on, '[]') WITH &&) WHERE (status <> 'cancelled')` — the
  `teacher_assignments` precedent; race-safe where a trigger is not. Read index `(school_id,
  status, starts_on)`. CHECKs on the status/timestamp pairs and the no-identity reason;
  `starts_on`, `ends_on`, `kind`, `name` **frozen once published** (a wrong date is cancel + new,
  because moving it silently moves R116's denominator).
- `school_settings` gains the §4.5 columns with named CHECKs (`school_settings_periods_per_day_
  check`, `_weekly_off_days_check (weekly_off_days <@ ARRAY[0..6] AND cardinality < 7)`, …),
  `sms_allowed_types message_type[]`, enums for `late_counts_as`, `leave_counts_as`,
  `remark_default_visibility`; all defaulted so existing rows fill in.
- `teacher_assignments.role` gains `cover` in **its own migration** (`ALTER TYPE … ADD VALUE`
  cannot be used by a CHECK in the same transaction); the next migration adds
  `teacher_assignments_cover_check CHECK (role <> 'cover' OR (section_id IS NOT NULL AND subject_id
  IS NULL AND ends_on IS NOT NULL))` and a nullable `covers_assignment_id` FK to the class-teacher
  row being covered. `cover` sits outside the class-teacher exclusion constraint by construction.
- `enrolments` gains `enrolments_school_id_id_student_id_key UNIQUE (school_id, id, student_id)`
  (target for marks, alerts and remarks, so a row can never name a different child than its
  enrolment). **A section change becomes close-old/open-new**, exactly as a class change already is
  (Phase 1 R37 amended, R174): `enrolments.section_id` stops being edited in place, so the roster
  for any past date is reconstructible from `started_on`/`ended_on`.

**Messaging (slice 9)**
- `whatsapp_numbers` *(non-tenant, platform-owned; exception 6)*: `school_id`, `phone` (E.164
  CHECK), `waha_session varchar(64)` derived from the row id (never reused), `status`
  (`pending|connected|down|disabled`), `last_healthy_at`, `last_error_code` (enum), `inbound_
  ignored_count`, `paired_at/by`, `disabled_at/by/reason`. `whatsapp_numbers_school_id_live_key
  UNIQUE (school_id) WHERE status <> 'disabled'` (a lost SIM is replaced without a delete);
  `UNIQUE (waha_session)` global, allowlisted in `NON_SCHOOL_LEADING_INDEXES`.
- `platform_delivery_health` *(non-tenant; exception 6)*: `school_id`, `day`, `channel`,
  `accepted`, `delivered`, `failed`, `suppressed`, `whatsapp_status`, `sms_used`, `sms_cap`,
  `computed_at`. `UNIQUE (school_id, day, channel)`. Written by the per-school rollup job; the
  only cross-school read of messaging data (R114).
- `devices`: `user_id`, `session_id` with `devices_session_id_fkey (school_id, session_id) →
  sessions (school_id, id)` and `UNIQUE (school_id, session_id)` (one device per session; token
  rotation is an update), `platform` (`android|ios`), `push_token varchar(512)` (**not** unique —
  two parents sign in on one phone; plain index `(school_id, push_token)`), `app_version`,
  `created_at`, `last_seen_at`, `unregistered_at`, `unregistered_reason` (`sign_out|fcm_
  unregistered|replaced`). **Liveness is the session's**: the push resolver joins `sessions` and
  sends only where `revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() − idle` and
  `unregistered_at IS NULL`, so every Phase 1 revocation path satisfies R115 with no new code.
- `messages`: `type` (enum), `priority` (enum), `subject_type varchar(32)`, `subject_id`
  (polymorphic grouping like `audit_log`, allowlisted in `NON_FK_ID_COLUMNS` with the reason),
  **`guardian_id`, `staff_id`, `student_id` nullable composite FKs with `messages_recipient_check`
  (exactly one)**, `body varchar(2000)` (`messages_body_no_id_check`), `media_object_key` nullable,
  `channel_plan message_channel[]`, `status` (`queued|sending|sent|delivered|failed|suppressed`),
  `suppressed_reason` (enum `not_allowed|cap_reached|no_channel|school_suspended|backdated`),
  `created_at`, `finished_at`. Indexes `(school_id, status, created_at)` (the per-school sweep),
  `(school_id, subject_type, subject_id)`, and `(school_id, guardian_id, created_at)` /
  `(…staff_id…)` / `(…student_id…)` (the inbox). **R107 as constraints:** `messages_subject_
  guardian_key UNIQUE (school_id, subject_type, subject_id, guardian_id) WHERE guardian_id IS NOT
  NULL`, and the same for staff and student. No phone number and no `recipient_user_id`.
- `message_deliveries`: `message_id`, `channel`, `attempt smallint`, `status`
  (`accepted|delivered|failed|suppressed`), **`provider_ref_hash char(64)`** (SHA-256 of
  `channel|providerRef`; the raw reference is never stored), `to_masked varchar(32)` (`+9230*****67`,
  `_no_id_check`), `error_code` (enum of mapped codes, never provider text), `segments smallint`,
  `attempted_at`, `delivered_at`, `failed_at`. `message_deliveries_attempt_key UNIQUE (school_id,
  message_id, channel, attempt)` (a crashed worker cannot double-write an attempt);
  `message_deliveries_provider_ref_key UNIQUE (channel, provider_ref_hash) WHERE provider_ref_hash
  IS NOT NULL`, global, allowlisted (exception 5's lookup). Append-only trigger allowing only
  `status`, `delivered_at`, `failed_at`, `error_code` to change and only forward (`accepted →
  delivered | failed`; `suppressed` terminal).
- `message_usage`: `year_month char(7)` (CHECK `^[0-9]{4}-(0[1-9]|1[0-2])$`), `channel`,
  `sent_count`. `UNIQUE (school_id, year_month, channel)`. Advanced with `INSERT … ON CONFLICT DO
  UPDATE SET sent_count = sent_count + 1 WHERE sent_count < $cap RETURNING` — atomic, no lock.
- `sessions`: no shape change; per-channel and per-capacity lifetimes in code (R154).

**Attendance (slice 11)**
- `attendance_registers`: `section_id`, `class_id`, `academic_year_id` (FKs as `enrolments`:
  `(school_id, class_id, academic_year_id) → classes`, `(school_id, section_id, class_id) →
  sections`), `date`, `period smallint`, `mode` (`daily|period`, copied from the class),
  `submitted_by`, `submitted_at`, `last_amended_by`, `last_amended_at`, `source` (`app|web`, derived
  from the session channel). **No counts** (a register has ≤ 60 marks; the summary is the aggregate
  layer). `attendance_registers_natural_key UNIQUE (school_id, section_id, date, period)`;
  `UNIQUE (school_id, id, date, period)` (target of the marks FK); index `(school_id, date,
  section_id)` (R129's anti-join); indexes on `submitted_by`, `last_amended_by`. CHECKs
  `_period_check (1–12)`, `_daily_period_check (mode <> 'daily' OR period = 1)`, `_amended_check`.
- `attendance_marks` — **lean; ≈ 4.8 M rows per school-year**: `register_id NOT NULL` with the
  four-column FK `(school_id, register_id, date, period) → attendance_registers (school_id, id,
  date, period)` (a mark can never disagree with its register), `enrolment_id` (composite FK),
  `date`, `period`, `status` (`present|absent|late|on_leave`), `arrived_at time` nullable,
  `note varchar(200)` nullable (`_no_id_check`), `created_at`. **No `student_id`, no `marked_by`,
  no `academic_year_id`** (author = the register's `submitted_by` or the changes row; the year is
  on the register and the enrolment, both frozen — a deliberate exception to the "academic tables
  carry the year" convention, recorded here). **`attendance_marks_natural_key UNIQUE (school_id,
  enrolment_id, date, period)`** (rule 14; the offline idempotency key); index `(school_id,
  register_id, date, period)`. Identity columns frozen by trigger. That is the whole index set.
- `attendance_mark_changes`: `mark_id`, `old_status`, `new_status`, `old_note`, `new_note`,
  `changed_by` (composite FK, indexed), `changed_at`, `reason NOT NULL` (`_no_id_check`).
  Append-only; written only by the §4.6 trigger. Index `(school_id, mark_id)`.
- `attendance_arrivals`: `mark_id`, `arrived_at`, `recorded_by`, `recorded_at` — the gate's record
  behind `POST /attendance-arrivals` (R168); the mark's `arrived_at` mirrors the latest.
- `attendance_alerts`: `enrolment_id`, `student_id` (composite FK to the enrolment unique),
  `date`, `kind` (`absence|late|corrected`), `seq smallint default 1` (reversals, R126), `due_at`,
  `status` (`pending|sent|cancelled`), `cancel_reason` (enum: `mark_changed|holiday|link_ended|
  backdated`), `created_at`. `UNIQUE (school_id, student_id, date, kind, seq)`. Index
  `(school_id, status, due_at)`. Linked messages carry `subject_type = 'attendance_alert'`.
- `attendance_day_status` — **the R127 derivation materialised, per enrolment-day** (Phase 4's
  report cards and the parent heat map read this, never raw marks): `enrolment_id`, `student_id`,
  `section_id`, `date`, `status` (`present|absent|late|on_leave|partial`), `periods_recorded`,
  `periods_present`, `periods_late`, `periods_absent`, `periods_leave`, `computed_at`.
  `UNIQUE (school_id, enrolment_id, date)`; index `(school_id, student_id, date)`. The day's
  *value* (R128) is computed at read from these counts and the school's settings by one pure
  function, so a settings change never needs a backfill.
- `attendance_daily_summary` — per section-day, a GROUP BY of the above: `section_id`, `class_id`,
  `academic_year_id`, `date`, `mode`, `registers_expected`, `registers_recorded`, `roster_count`,
  `present`, `absent`, `late`, `on_leave`, `partial`, **`version bigint default 1`** (bumped by a
  statement-level `AFTER INSERT OR UPDATE ON attendance_marks … REFERENCING NEW TABLE` trigger
  that upserts one row per section-day — no code path can forget), **`computed_version bigint
  default 0`** (stale iff `≠ version`; the worker reads `version`, recomputes both tables, then sets
  `computed_version` — no lost update, unlike a boolean), `computed_at`. `UNIQUE (school_id,
  section_id, date)`.
- `staff_attendance` (slice 12): `staff_id`, `date`, `status` (**its own enum**
  `staff_attendance_status`, so payroll can add `half_day` without touching student indexes),
  `marked_by`, `marked_at`, `note`. `UNIQUE (school_id, staff_id, date)`. Trigger
  `staff_attendance_not_self` raises when `marked_by`'s user has `staff_id = NEW.staff_id`
  (R134). `staff_attendance_changes` as §4.6, `reason NOT NULL`.

**Diary and remarks (slice 13)**
- `diary_entries`: `section_id`, `class_id`, `academic_year_id` (FKs as registers), `date`,
  `subject_id NOT NULL`, `author_staff_id`, `topic varchar(500)`, `assignment varchar(1000)`,
  `learning_outcome varchar(500)`, `due_on`, `attachment_object_key/mime/size` nullable,
  `created_at`, `updated_at`. `UNIQUE (school_id, section_id, date, subject_id)`. Indexes
  `(school_id, section_id, date)`, `(school_id, author_staff_id, date)`, `(school_id,
  subject_id)`. Identity columns frozen. `diary_entry_changes` with explicit `old_/new_` columns
  for the five editable fields, `changed_by`, `reason` nullable. No-identity CHECKs on text.
- `remarks`: `enrolment_id`, `student_id` (composite FK to the enrolment unique), `author_staff_id`,
  `subject_id` nullable, `date`, `category` (`academic|behaviour|homework|attendance|participation|
  general`), `text varchar(1000)` (`_no_id_check`), `visibility` (`internal|guardian|student`),
  `supersedes_id` nullable with `remarks_supersedes_id_fkey (school_id, supersedes_id, student_id)
  → remarks (school_id, id, student_id)` and `UNIQUE (school_id, supersedes_id) WHERE supersedes_id
  IS NOT NULL` (a chain, never a tree), `superseded_at` (set by an AFTER INSERT trigger on the
  successor; everything else frozen), `created_at`. Indexes `(school_id, student_id, date)`,
  `(school_id, author_staff_id, date)`, `(school_id, subject_id)`.

**Announcements (slice 14)**
- `announcements`: `title varchar(120)`, `body varchar(2000)` (`_no_id_check`), `category`
  (`holiday|exam|fee|event|general`), `priority` (`normal|urgent`), `status`
  (`draft|scheduled|sending|sent|cancelled`), `scheduled_at`, `expires_on`, `attachment_*`
  nullable, `holiday_id` nullable FK (indexed, not unique — a cancellation notice is a second
  row), `created_by`, `sent_at`, `cancelled_by/at/reason`, `recipient_count`. Status CHECKs:
  `scheduled_at` set iff `scheduled`; `sent_at` set iff `sent`; cancelled fields together.
  Indexes `(school_id, status, scheduled_at)`, `(school_id, created_by, created_at)`.
- `announcement_audiences`: `announcement_id`, `kind` (`everyone|parents|students|staff|class|
  section|student|guardian|staff_member`), **five nullable FKs** `class_id`, `section_id`,
  `student_id`, `guardian_id`, `staff_id` with `announcement_audiences_target_check` by kind, and
  `roles ⊆ {parents, students}` (`audience_role[]`, default both) for `class|section|student`
  (concept slide 04: "all parents of Class 9" is role × class).
- `announcement_recipients`: `announcement_id`, **three nullable FKs** (`guardian_id`, `staff_id`,
  `student_id`, exactly one), `message_id` nullable FK; partial uniques per announcement per
  person (R145). `announcement_recipient_students` join table (`announcement_recipient_id`,
  `student_id`, composite FKs, unique pair) — which children put this parent in the audience.

**Not in Phase 2:** no `leave_requests`, no `events`, no `timetable`, no `tests`, no money tables,
no inbound-message table beyond `whatsapp_numbers.inbound_ignored_count`, no `client_reference`
columns, no arrays of ids, no `read_at`.

**Existing data touched by Phase 2 migrations:** none destructively. `school_settings` gains
defaulted columns; `teacher_assignment_role` gains a value; `enrolments` gains a unique index
(no duplicates possible: `id` is the primary key). No existing row is rewritten.

---

## 6. Slice plan

Estimates are for orientation. Capability keys are the Phase 1 enum; Phase 2 adds screens, not
keys. **Waves**: **D** = 9 + 10 · **E** = 11 + 12 + 13 + 15 in parallel · **F** = 14 + 16 ·
**G** = 17. The groundwork commit before wave D adds to `packages/shared` the enums and error codes
in §6.1 and the message-type table, so every agent builds against the same names.

Conventions not restated in the tables: `/api/v1`; `PageQueryDto` (`page` ≥ 1, `limit` 1–50
default 25, `422` out of range); `{ data, page, limit, total }`; `sort` from the allowlist, first
value default, `id` tiebreak; `NoQueryDto` on routes without a query; `@ApiErrors()`; common errors
`401`, `403 PERMISSION_DENIED | SCHOOL_SUSPENDED | ORIGIN_REJECTED`, `404` for absent, other-school
or out-of-scope path ids, `429`. Bounded resources (a month of attendance, a teaching-day count)
are objects, not paginated lists; `dateFrom`/`dateTo` on them are required and capped.

### 6.1 Groundwork: shared enums and error codes

Enums (`enum` + `enumName` on every DTO use): `MessageType` (§4.2), `MessagePriority`,
`MessageChannel` (`push|whatsapp|sms|email|in_app`), `DeliveryStatus`, `SuppressionReason`,
`AttendanceStatus` (`present|absent|late|on_leave`), `DayStatus` (+ `partial`), `LateCountsAs`,
`LeaveCountsAs`, `StaffAttendanceStatus`, `HolidayKind`, `HolidayStatus`, `RemarkCategory`,
`RemarkVisibility`, `AnnouncementCategory`, `AnnouncementPriority`, `AnnouncementStatus`,
`AudienceKind`, `AudienceRole`, `DevicePlatform`, `SessionChannel` (`cookie|bearer`),
`APP_VERSION_PATTERN`, `IdempotentEndpoint` + `'diary_entries' | 'remarks' | 'announcements'`.

New error codes: `UPGRADE_REQUIRED` 426 · `WEBHOOK_SIGNATURE_INVALID` 401 ·
`BEARER_SESSION_REQUIRED` 409 · `CONTACT_PHONE_MISSING` 409 · `SMS_CAP_EXCEEDED` 409 ·
`SMS_TOO_LONG` 409 · `WHATSAPP_ALREADY_CONNECTED` 409 · `WHATSAPP_NUMBER_MISSING` 409 ·
`HOLIDAY_DATES_TAKEN` 409 · `HOLIDAY_NOT_DRAFT` 409 · `NOT_A_TEACHING_DAY` 409 ·
`ATTENDANCE_LOCKED` 409 · `AMENDMENT_REASON_REQUIRED` 409 (`details.amendments`) ·
`ROSTER_INCOMPLETE` 422 (`details.missing`) · `STALE_STATUS` 409 · `ARRIVAL_NOT_ABSENT` 409 ·
`DIARY_ENTRY_EXISTS` 409 · `DIARY_ENTRY_LOCKED` 409 · `SUBJECT_NOT_ASSIGNED` 409 ·
`REMARK_SUPERSEDED` 409 · `ANNOUNCEMENT_SENT` 409 · `ANNOUNCEMENT_CANCELLED` 409 ·
`ANNOUNCEMENT_NO_RECIPIENTS` 409. Reused: `SELF_ACTION_FORBIDDEN`, `IDEMPOTENCY_KEY_REUSED`,
`ILLEGAL_STATUS_TRANSITION`, `CONCURRENT_UPDATE`, `REFERENCE_NOT_FOUND`, `ASSIGNMENT_EXISTS`,
`SUBJECT_ARCHIVED`, `PERMISSION_DENIED` with `details.reason ∈ {audience_requires_school,
not_author}`.

### Slice 9 — Messaging core, worker, bearer sessions, devices (≈ 7 days)

**Goal:** a message written by any service reaches a phone through the right channel, every
attempt is logged, and nothing is lost if a process dies. No user-facing feature yet beyond a
"send test message" button for the principal.

- 9.1 `worker.ts`, BullMQ queues, `runAsSchool`, `fromQueuePayload` + `school-by-id.repository`,
  lint boundaries with fixture tests, the outbox sweep. Move the staged-upload sweep to the worker
  (keeping its fan-out); delete `ScheduleModule` from the HTTP process.
- 9.2 `packages/shared/src/messages.ts` (types, priorities, allow-list default), templates with
  the segment-length test, `NotificationService`, routing (R106), `messages`,
  `message_deliveries`, `message_usage`, caps (R109), the phone pattern in the R16 scanner and
  the new `redact` paths.
- 9.3 Drivers: `PushDriver` (FCM + log), `WhatsAppDriver` (WAHA + fake; media as bytes),
  `SmsDriver` (log + one real adapter if the provider is named), `EmailDriver` (Phase 1 Mailer).
  Webhooks: `POST /webhooks/waha`, `POST /webhooks/sms` under a sixth access decorator
  **`@Webhook('waha' | 'sms')`** (R172): HMAC over the **raw bytes** with that provider's secret,
  `timingSafeEqual`, a 5-minute timestamp window where the provider sends one; zod picks only the
  fields used; a verified but unknown reference is `204` plus a counter; a bad signature is `401
  WEBHOOK_SIGNATURE_INVALID` with no details; the response never echoes the body; signed requests
  3,000/min, unsigned 10/min per IP; **excluded from both OpenAPI documents** (a third module
  bucket) and documented in `contracts/slice-9.md`. Exception 5 (§4.1) recorded in `CLAUDE.md`.
- 9.4 `whatsapp_numbers` (platform-owned), WAHA session lifecycle (create, QR pairing shown to the
  platform admin, health check every 5 minutes, `down` → fallback routing + one
  `whatsapp_session_down` email per transition, R112); `platform_delivery_health` rollup.
- 9.5 Bearer sessions: `POST /auth/login { …, channel? }` returns `bearerToken` in the body only for
  that channel (R153); per-channel and per-capacity lifetimes (R154); `MeService.mint` takes the
  channel from the presented session so **`POST /me/change-password` rotates on the same channel**
  (a bearer caller gets `{ token, expiresAt }`, never `Set-Cookie`); Origin and bearer rules (§4.8,
  R170); `POST /me/devices`; `POST /me/sessions/revoke-others` (kill a lost phone from another
  sign-in) and `POST /users/:id/sign-out-everywhere` (office, audited, no password reset) (R169);
  logout revokes the session's device (R159). `X-App-Version` floor (R161).
- 9.6 Suspended-school behaviour (R113, per the owner's §1.2 answer), the §4.5 settings fields,
  platform screens **WhatsApp pairing** and **Delivery health**, school screen **Messaging
  settings** (cap, allow list, usage, test message).

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `POST /auth/login` | `@Public()` | slice-2 fields + `channel?: 'cookie'\|'bearer'` (default cookie); bearer requires `X-App-Version`, no `Origin`, no cookie | `200 LoginResultDto = MeDto + bearerToken: string\|null`; cookie set only for cookie | `422` on `channel` when bearer lacks the header; `401` bearer with `Origin`/cookie; `426`; rest as slice-2 §3.1 (same throttles, lockout, spray) |
| `POST /auth/logout` | unchanged | — | `204`; bearer: revokes the session's device | — |
| `GET /me` | unchanged | — | `MeDto` + `capacities[]`, `assignments[]` (additive) | — |
| `POST /me/change-password` | unchanged | unchanged | rotates on the caller's channel: bearer → `{ token, expiresAt }` in the body, no cookie | R153 |
| `POST /me/devices` | `@AuthenticatedOnly()`, `@AllowWhenSuspended()` (added to the slice-2 §1.3 set) | `{ platform: 'android'\|'ios', pushToken: 1–512 }`; `appVersion` from the header | `201 DeviceDto { id, platform, appVersion, createdAt, lastSeenAt }` (new) / `200` (same live token: touch) | `409 BEARER_SESSION_REQUIRED` on a cookie session; a token already live under another session or device is `replaced` in the same transaction; the token never comes back |
| `POST /me/sessions/revoke-others` | `@AuthenticatedOnly()` | empty | `200 { revoked }` | revokes every other session of the caller and their devices (R169) |
| `POST /users/:id/sign-out-everywhere` | `user.account.manage` | `{ reason }` | `200` | R10, R12, R14 as reset; audited; password untouched (R169) |
| `GET\|PATCH /school/settings` | `school.settings.manage` | adds §4.5 fields | `200 SchoolSettingsDto` | one resource, one audit action |
| `POST /messaging/test` | `school.settings.manage` | `{ channel: 'whatsapp'\|'sms'\|'push' }` | `200 { messageId }` | to the caller's **staff** phone; counts against the cap; `409 CONTACT_PHONE_MISSING`, `SMS_CAP_EXCEEDED`; 5/min per user |
| `GET /messaging/usage` | `school.settings.manage` | `NoQueryDto` | `{ months: [{ yearMonth, byChannel: [{ channel, count }] }], cap, remaining }` | this and last month |
| `GET /messaging/whatsapp` | `school.settings.manage` | — | `{ status, lastHealthyAt, phoneMasked }` | single-predicate read of the platform-owned row |
| `GET /platform/messaging/health` | `@PlatformSession()` | paginated; `whatsappStatus?`, `q`; sort `name`, `-name`, `-failed24h`, `-smsUsed` | `{ schoolId, name, shortCode, whatsapp: { status, lastHealthyAt, lastErrorCode }, last24h: [{ channel, accepted, delivered, failed, suppressed }], sms: { used, cap } }` | from `platform_delivery_health` only (R114) |
| `GET /platform/schools/:id/whatsapp` | `@PlatformSession()` | — | `WhatsAppNumberDto { schoolId, phoneMasked, status, lastHealthyAt, lastErrorCode, inboundIgnoredCount, pairedAt }` | — |
| `POST /platform/schools/:id/whatsapp/pair` | `@PlatformSession()` | `{ phone?: PhoneField }` (first pairing) | `200 { qr: data URI, expiresAt }` | `409 WHATSAPP_ALREADY_CONNECTED`, `WHATSAPP_NUMBER_MISSING`; QR never logged; audited |
| `POST /platform/schools/:id/whatsapp/disable` | `@PlatformSession()` | `{ reason: 3–500 }` | `200 WhatsAppNumberDto` | already disabled → `200`, no audit |
| `POST /webhooks/waha`, `POST /webhooks/sms` | `@Webhook(provider)` | raw provider body + signature header | `204` on any verified body | `401 WEBHOOK_SIGNATURE_INVALID`; `429` per IP; in no OpenAPI document |

Tests: R105–R115, R153–R155, R159, R161, R169–R173; routing matrix by capability × priority
(table-driven, every cell); cap reached mid-batch; WAHA down → SMS; webhook replay and forged
signature; re-adding a completed job id produces no second delivery; forged payload pair → no row,
no log with ids; bearer token never in a cookie-client body; change-password on bearer returns a
token and no cookie; device dies with session; two parents on one phone; worker boots with Redis
down → health red, no job runs; outbox sweep recovers an enqueued-but-lost row; interleaved jobs
for two schools keep their contexts; **R16 scanner (with the phone pattern) over every rendered
template and over `messages`/`message_deliveries` after a run**.

Acceptance: a test message from the settings screen arrives on a real phone over WhatsApp (dev
WAHA) and the delivery row shows `delivered`; with WAHA stopped the same message arrives by SMS
(log driver in dev) and the row shows the fallback.

### Slice 10 — Calendar, holidays, cover, section-change history (≈ 2.5 days)

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /holidays` | `@RequireStaff()` | paginated; `dateFrom?`, `dateTo?`, `status?`, `kind?`; sort `startsOn`, `-startsOn` | `HolidayDto { id, startsOn, endsOn, name, description, kind, appliesToStaff, status, publishedAt, publishedBy, cancelledAt, cancelReason, announcementId, createdAt, updatedAt }` | — |
| `GET /holidays/:id` | `@RequireStaff()` | — | `HolidayDto` | — |
| `POST /holidays` | `holiday.manage` | `{ startsOn, endsOn?, name 1–100, description? 0–500, kind, appliesToStaff? }` | `201`, `draft` | `409 HOLIDAY_DATES_TAKEN details { holidayId }` (exclusion constraint mapped) |
| `PATCH /holidays/:id` | `holiday.manage` | create fields; `null` on required ones → `422` | `200` | `409 HOLIDAY_NOT_DRAFT`; `HOLIDAY_DATES_TAKEN` |
| `POST /holidays/:id/publish` | `holiday.manage` | empty | `200 HolidayDto` | creates and sends the `holiday_notice` announcement once (R117, R151); applies R167 to any affected registers; already published → `200`, no audit; cancelled → `409 ILLEGAL_STATUS_TRANSITION` |
| `POST /holidays/:id/cancel` | `holiday.manage` | `{ reason: 3–500 }` | `200` | from draft or published; a sent notice gets a cancellation announcement; already cancelled → `200` |
| `GET /calendar/teaching-days` | `@RequireStaff()` | `dateFrom`, `dateTo` required, ≤ 366 days | `{ dateFrom, dateTo, teachingDays, weeklyOffDays: number[], holidays: [{ startsOn, endsOn, name }] }` | informational (R116) |
| `GET /me/calendar` | `@AuthenticatedOnly()` | `dateFrom`, `dateTo` required, ≤ 366 | `{ weeklyOffDays, holidays: [{ startsOn, endsOn, name, kind }] }` — published only | — |
| `POST /staff/:id/teacher-assignments` with `role: 'cover'` | `class.manage` | `sectionId` required, `subjectId` null, `startsOn` ≥ today, **`endsOn` required**, `coversAssignmentId?` | `201 TeacherAssignmentDto` | F1 self rule as slice-4 §4.3; `ASSIGNMENT_EXISTS`; never `CLASS_TEACHER_EXISTS`; the cover teacher is pushed on assignment (R132) |
| `POST /enrolments/:id/change-section { sectionId, effectiveOn, reason }` | `enrolment.manage` | — | `200 { closed: EnrolmentDto, opened: EnrolmentDto }` | **replaces the in-place section edit** (R174); roll number follows per slice-6 rules |

Screens: holidays list + calendar month view (ranges), create/publish/cancel with reason;
settings (the new fields, on the existing settings screen); cover assignment on the section row of
the assignments tab; the section-change dialog on the enrolments tab now shows "closes the current
enrolment and opens a new one from <date>". Tests: R116–R118, R132, R167, R174; a cover row's
scope appears on the covering teacher's `/me` for the dates and vanishes after; a ten-week break is
one row and one notice; a public holiday on a Sunday is not double-counted; a cover assignee
without `attendance.student.mark` is refused at assignment (`409` with reason).

### Slice 11 — Student attendance (≈ 7 days)

**Goal:** a class teacher submits the morning register in under a minute; a subject teacher
submits a period; absent children's guardians are told that morning and corrected if the child
turns up; corrections are honest; the principal sees what was not recorded.

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /sections/:id/register` | `@RequireCapability(ATTENDANCE_STUDENT_MARK, ATTENDANCE_STUDENT_VIEW_ALL)`, scope **on the date** | `date`, `period` required | `200 RegisterViewDto { section: { id, name, classId, className, academicYearId, attendanceMode }, date, period, periodsPerDay, teachingDay, register: RegisterDto\|null, roster: [{ enrolmentId, studentId, studentFullName, rollNo, mark: AttendanceMarkDto\|null }], amendable }` — `200` with `register: null` when unrecorded | `422` on period/date |
| `POST /sections/:id/submit-register` | `ATTENDANCE_STUDENT_MARK`, scope **with role** on the date (§4.4) | `{ date, period 1–12, reason?: 3–500, marks: [{ enrolmentId, status, note?, arrivedAt? }] }` 1–200, no repeats | `201 RegisterSubmitResultDto { register, marks: [AttendanceMarkDto + outcome: created\|amended\|unchanged], summary }` when the register is created, `200` after | `409 NOT_A_TEACHING_DAY`, `ATTENDANCE_LOCKED`, `AMENDMENT_REASON_REQUIRED details { amendments: [{ enrolmentId, from, to }] }`, `CONCURRENT_UPDATE`; `422 ROSTER_INCOMPLETE details { missing }` on a first submit that omits anyone; `422 REFERENCE_NOT_FOUND` per item (all-or-nothing); audited |
| `POST /attendance-marks/:id/amend` | `ATTENDANCE_STUDENT_MARK` (mark's section in scope on its date) | `{ fromStatus, status, reason: 3–500, note?, arrivedAt? }` | `200 AttendanceMarkDto` | `409 STALE_STATUS` when `fromStatus` ≠ current (a stale phone never silently reverses a colleague); same status → `200` no audit; `ATTENDANCE_LOCKED` (section scope after window); all-scope after window audited |
| `POST /attendance-arrivals` | `ATTENDANCE_STUDENT_MARK` (all or section scope on the date) | `{ studentId, date, arrivedAt }` | `200 AttendanceMarkDto` | moves the day's first recorded `absent` mark to `late` with `arrived_at`, reason `Arrived at HH:MM`; `409 ARRIVAL_NOT_ABSENT` otherwise (R168); the gate's action |
| `GET /attendance-marks/:id/changes` | `MARK` or `VIEW_ALL`, section in scope on the mark's date | paginated; sort `-changedAt` | `MarkChangeDto { id, markId, fromStatus, toStatus, changedBy, changedByName, changedAt, reason }` | — |
| `GET /attendance-registers` | `VIEW_ALL`, or `MARK` (today's scope) | paginated; `date` required; `classId?`, `sectionId?`, `recorded?: QueryBoolean`; sort `className`, `sectionName`, `-registersRecorded` | `SectionDayDto { sectionId, sectionName, classId, className, date, mode, registersExpected, registersRecorded, recorded, submittedBy, submittedByName, submittedAt, declaredHolidayAfter: boolean }` from the summary (R131) | the principal's console is `recorded=false`; live, not the push |
| `GET /attendance-reports/daily-summary` | same | paginated; `dateFrom`, `dateTo` required ≤ 92 days; `classId?`, `sectionId?`; sort `-date`, `date`, `className` | `DailySummaryDto` per section-day | — |
| `GET /students/:id/attendance` | `STUDENT_VIEW` scoped | `dateFrom`, `dateTo` required ≤ 366 | `StudentAttendanceDto { studentId, dateFrom, dateTo, mode, percentage (1 dp)\|null, countedDays, teachingDays, present, absent, late, onLeave, partial, unrecorded, days: [{ date, status\|null, periods: [{ period, status, arrivedAt }] }] }` | aggregated by `student_id` across enrolments in the year; `percentage: null` and "no recorded days" when `countedDays = 0` |
| `GET /me/children/:id/attendance`, `GET /me/student/attendance` | `@RequireCapacity` | same | same DTO; no notes, teachers by name (R165) | `404` outside scope |
| `GET /attendance-reports/absentees`, `/late` | `VIEW_ALL` | paginated; `date` required; `classId?`, `sectionId?`; sort `className`, `rollNo`, `fullName` | `{ studentId, fullName, rollNo, classId, className, sectionId, sectionName, status, arrivedAt, alertStatus }` | — |
| `GET /attendance-reports/percentage` | `VIEW_ALL` | paginated; `dateFrom`, `dateTo` required ≤ 366; `classId?`, `sectionId?`, `below?: 0–100`; sort `percentage`, `-percentage`, `fullName`, `className` | `{ studentId, fullName, rollNo, className, sectionName, percentage, countedDays }` | CSV is Phase 5 |

Behaviour:
- **Roster (R124).** Enrolments with `started_on ≤ date ≤ coalesce(ended_on, ∞)` in that section
  (exact after R174), whose student is not `suspended` on that date, **union** any enrolment that
  already has a mark in that register. On a teaching day, not in the future (local date), within
  the class's academic year. Daily mode → `period` must be 1; period mode → 1…`periodsPerDay`.
- **Who (R120).** Class teacher or cover (any period), subject teacher (any period, period mode
  only), or an `attendance.student.mark` holder with `all` scope. Scope is evaluated **for the
  register's date** (§4.4).
- **Submit (R119, R122, R125).** The first submit must cover the whole roster; later submits may
  name a subset. One statement upserts marks (§4.6): new marks are `created`; marks whose status
  or note differs are `amended` and need `reason` (`409 AMENDMENT_REASON_REQUIRED` listing them —
  this is also how two teachers racing on one register see each other's result); unchanged marks
  are untouched. An identical replay is `200` regardless of the window, so an offline outbox
  always clears. Section-scoped amendments after the window are `409 ATTENDANCE_LOCKED`;
  all-scope holders may amend after it (R123). `source` is derived from the session channel.
- **Alerts (R126).** On submit, for every `absent` mark where no `absence` alert exists for the
  child that day, insert an alert with `due_at = max(submitted_at + 30 min, today at
  absenceAlertTime)` — only when the register's date is **today**; a backdated absence is
  `cancelled:backdated` and appears in the app only. When due, the `attendance` processor locks the
  alert row, re-reads every recorded period for that child that day, and: sends `absence_alert`
  only if **every recorded period is `absent`**; if any is `late` → `cancelled:mark_changed` and
  `late_advice` (if enabled); if any is `present`/`on_leave` → `cancelled`. A `late` recorded at
  first submit also sends `late_advice` (if enabled) when no absence alert went out. After an alert
  is `sent`, **any** change that makes the day not all-absent (including to `late`) sends
  `attendance_corrected` once, stating the current status; a reversal back to absent sends a
  further corrected notice with `seq + 1`, capped at 3 per day, and surfaces the flapping to the
  principal. The amend path takes the same alert lock and sees `pending` (→ cancel) or `sent` (→
  corrected). Recipients: the guardians flagged `is_primary_contact`; if none, every live guardian
  with `can_login` or a phone. Known limitation, recorded: present in period 1 and absent for the
  rest sends nothing (early departure is item 23's sibling).
- **Derived daily status (R127)** per enrolment-day: `on_leave` if every recorded period is
  `on_leave`; else `absent` if every recorded period is `absent`; else `partial` if any recorded
  period is `absent` or `on_leave` (mixed); else `late` if the first recorded period is `late` and
  the rest are present or late; else `present`. Both conflicting entries stay visible (deck slide
  9). Materialised in `attendance_day_status` by the `attendance` processor within a minute of any
  write and nightly for stale section-days (R131).
- **Percentage (R128) — the day is the unit in both modes.** Day value: `present` = 1, `absent` =
  0, `late` = value of `lateCountsAs` (`half_day` = 0.5; `absent_after_cutoff` = 0 when
  `arrived_at > lateCutoffTime`, else 1), `on_leave` = 0 if `leaveCountsAs = absent`, else the day
  is **excluded**; `partial` = present-equivalent periods ÷ recorded periods (late inside a partial
  day counts as present). Percentage = Σ day values ÷ Σ counted days, where **counted days are the
  teaching days on which this student has at least one recorded period** within their enrolment
  range; `teachingDays` (R116, within the range) is shown beside it. Unrecorded days are neither
  present nor absent. Zero counted days shows "no recorded days", never 100 % or NaN. Daily mode is
  the one-period case. One pure function, tested over every combination of statuses, modes and
  settings. Example: P1 absent, P2–P8 present, nobody amends → `partial`, value 7/8, shown as
  "partial (absent P1)"; the office records the arrival → `late`, value per `lateCountsAs`.
- **Unrecorded registers (R129).** The `scheduled` queue runs at `registerDeadlineTime` per
  school on teaching days: every section with a non-empty roster and **no register at all** for
  the day (period mode: the deck's "unrecorded periods" needs a timetable; recorded as a
  limitation) is listed as unrecorded and one `register_unrecorded` push goes to the principal and
  all-scope mark holders per school per day, naming the sections and any cover teacher. The
  console is live; the push is not repeated. The principal records on the web or the app, or
  assigns cover.
- **Holidays after the fact (R167).** Publishing a holiday covering a date with registers cancels
  every `pending` alert for those dates (`cancel_reason = holiday`), bumps the summary `version`
  for them, excludes them from every percentage, keeps the registers (rule 4) and shows them on
  the console as "recorded on a day later declared a holiday". Cancelling a published holiday
  reverses the exclusion; the day then shows as unrecorded, not absent. The deadline job skips
  non-teaching days. A half-day closure is not representable (§7).
- **Rollup (R131).** The statement-level trigger bumps the section-day `version` on any mark
  write; the `attendance` processor recomputes `attendance_day_status` and the summary within a
  minute, then sets `computed_version`; the nightly job recomputes every stale section-day and the
  last 7 days. The console and reports read these tables, never raw marks.

Screens (web): register (section, date, period; one row per student; keyboard-friendly; shows who
recorded it and when; amendments prompt for a reason), arrival dialog, student attendance tab
(calendar heat map + percentage with "n recorded of m teaching days"), class/section summary,
unrecorded registers (principal console tile), reports. Tests: R119–R131, R167, R168, R174, R175;
two teachers submitting the same register concurrently (one wins, the other gets the diff, no
duplicate marks); stale `fromStatus` refused; amendment after the window by a teacher refused and
by the principal audited; alert cancelled by an arrival before 09:30; alert sent exactly once;
corrected notice after a late arrival at 10:00; reversal capped; keypad parent gets SMS;
`smartphone_data` parent with no device gets SMS; backdated register sends nothing; the derived
status and percentage tables; holiday declared after registers; a moved student's old register
still amendable; isolation per table. Playwright: class teacher records, office records an arrival,
principal amends, parent view shows it.

### Slice 12 — Staff attendance (≈ 2 days)

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /staff-attendance` | `ATTENDANCE_STAFF_MANAGE` | paginated; `date` required; `status?`, `q?` (2–100); sort `fullName`, `-fullName`, `status` | `StaffDayDto { staffId, fullName, designation, mark: StaffMarkDto\|null }` | every `active` staff member |
| `POST /staff-attendance/submit` | `ATTENDANCE_STAFF_MANAGE` | `{ date, reason?, marks: [{ staffId, status, note? }] }` 1–500, no repeats | `200 { marks: [StaffMarkDto + outcome], summary }` | `409 SELF_ACTION_FORBIDDEN details { staffId }` when the caller's own row is in the payload — whole request refused (R134); `NOT_A_TEACHING_DAY` (staff holidays only: `applies_to_staff`); `AMENDMENT_REASON_REQUIRED`; `422 REFERENCE_NOT_FOUND` for staff not active on the date |
| `POST /staff-attendance/:id/amend` | `ATTENDANCE_STAFF_MANAGE` | `{ fromStatus, status, reason, note? }` | `200 StaffMarkDto` | own row → `SELF_ACTION_FORBIDDEN`; `STALE_STATUS`; same status → `200` |
| `GET /staff/:id/attendance` | `STAFF_VIEW` | `dateFrom`, `dateTo` required ≤ 366 | `StaffAttendanceDto { staffId, dateFrom, dateTo, present, absent, late, onLeave, unrecorded, days: [{ date, status, note }] }` | — |
| `GET /me/staff/attendance` | `@RequireStaff()` | same | same, the caller's own | R135 |

No alerts; the app shows "my attendance" (read). Biometric remains deferred. Tests: R133–R136; a
principal cannot mark themselves; a second office user can; the trigger refuses a direct write.

### Slice 13 — Diary and remarks (≈ 4 days)

Readers of a section's diary are its assigned staff and `diary.write` all-scope holders (the
principal); **office staff do not read the diary by default** (a consequence of the fixed
capability list; the principal may grant `diary.write`). `POST /uploads` accepts any of
`document.upload | diary.write | announcement.send.scope | announcement.send.school` (R171);
consumption stays bound to the uploader, so another user's `stagedUploadId` is `422
REFERENCE_NOT_FOUND`. Thumbnails come from the Phase 1 re-encode pipeline, never from the original
bytes.

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /sections/:id/diary-entries` | `DIARY_WRITE` scoped (today) | paginated; `dateFrom?`, `dateTo?` (≤ 366 if both), `subjectId?`; sort `-date`, `date` | `DiaryEntryDto { id, sectionId, classId, academicYearId, date, subjectId, subjectName, authorStaffId, authorName, topic, assignment, learningOutcome, dueOn, hasAttachment, attachmentMime, createdAt, updatedAt }` | R142 |
| `GET /diary-entries/:id` | same | — | `DiaryEntryDto` | — |
| `POST /sections/:id/diary-entries` | `DIARY_WRITE` scoped with role (on `date`) | **`Idempotency-Key` required**; `{ date, subjectId, topic 1–500, assignment? 0–1000, learningOutcome? 0–500, dueOn? ≥ date, stagedUploadId? }` | `201` / replay `200` + `Idempotency-Replayed: true` | `409 DIARY_ENTRY_EXISTS details { entryId }`, `SUBJECT_NOT_ASSIGNED` (subject teacher, other subject), `SUBJECT_ARCHIVED`; `422 REFERENCE_NOT_FOUND` (upload, per R91); identity pattern `422`; sends `diary_posted` after commit (R138) |
| `PATCH /diary-entries/:id` | `DIARY_WRITE` | create fields minus `date`/`subjectId`, plus `reason?` | `200` | author within window: no reason; `409 DIARY_ENTRY_LOCKED` (author after window); all-scope after window: `AMENDMENT_REASON_REQUIRED` without a reason; another section-scoped teacher → `403 PERMISSION_DENIED details.reason = 'not_author'` (the row is visible to them) |
| `GET /diary-entries/:id/attachment` | `DIARY_WRITE` scoped | — | stream, slice-6 §6.2 headers | `404` if none |
| `GET /diary-entries/:id/thumbnail` | same | — | image | images only |
| `GET /me/children/:id/diary-entries`, `GET /me/student/diary-entries` | `@RequireCapacity` | paginated; `dateFrom?`, `dateTo?`; sort `-date` | `DiaryEntryDto` with the author's name only | — |
| `GET /me/children/:id/diary-entries/:entryId/attachment` (+ `/thumbnail`), `GET /me/student/diary-entries/:entryId/attachment` (+ `/thumbnail`) | `@RequireCapacity` | — | stream | `404` outside scope |
| `GET /students/:id/remarks` | `STUDENT_VIEW` scoped | paginated; `category?`, `visibility?`, `dateFrom?`, `dateTo?`, `includeSuperseded` (default false); sort `-date`, `date` | `RemarkDto { id, studentId, enrolmentId, date, category, text, visibility, subjectId, subjectName, authorStaffId, authorName, supersedesId, supersededAt, supersededById, createdAt }` | all visibilities for staff |
| `POST /students/:id/remarks` | `REMARK_WRITE` scoped | **`Idempotency-Key` required**; `{ date ≤ today, category, text 1–1000, visibility?, subjectId? }` | `201` / replay `200` | default visibility from settings; `remark_posted` only when `remarkNotifyGuardians` and visibility ≥ `guardian` (R140) |
| `POST /remarks/:id/correct` | `REMARK_WRITE` (author, or all scope) | `{ text, reason: 3–500 }` | `201 RemarkDto` (a new row) | `409 REMARK_SUPERSEDED details { supersededById }`; retry-safe by that code (R141) |
| `GET /me/children/:id/remarks`, `GET /me/student/remarks` | `@RequireCapacity` | paginated; `category?`, `dateFrom?`, `dateTo?`; sort `-date` | `RemarkDto` at the capacity's visibility (`student` ⊇ `guardian`); superseded rows shown as superseded | — |

Screens: section diary (day view, week view), entry form with attachment, student remarks tab.
Tests: R137–R143, R171; a subject teacher cannot write another subject; a class teacher may write
any; replayed `Idempotency-Key` returns the existing row to its author and `409
IDEMPOTENCY_KEY_REUSED` to another user with the same key; identity pattern refused; a keypad
parent's suppression row exists with `not_allowed`; a non-recipient cannot fetch an attachment.

### Slice 14 — Announcements (≈ 5 days)

Audience DTO `{ kind, targetId?, roles? }`, array 1–20: `everyone|parents|students|staff` take no
`targetId` and `everyone` combines with nothing; `class|section|student` take `roles ⊆ {parents,
students}` (default both); `guardian`, `staff_member` take a target. `staff` and `staff_member`
need `announcement.send.school` (a section scope contains no staff). A `class` target is inside
scope only when **every** section of the class is; `guardian` and `student` targets must be linked
to a student in scope; an absent, other-tenant or out-of-scope target is `422 REFERENCE_NOT_FOUND`
on `audiences[i].targetId` with an identical body for all three (R144). A broad kind without
`.school` is `403 PERMISSION_DENIED details.reason = 'audience_requires_school'`.

**Resolution (R145)** happens at send time and dedupes a person in order: same user id → same
identity hash (a staff member whose CNIC is also a guardian's) → same normalised phone per channel
(two guardians sharing one phone get one WhatsApp). One in-app row per person; one message per
phone. Where a person is in the audience as staff and as guardian, the **guardian** channel plan
wins. Resolution excludes staff not `active`, guardians with no live `can_login` link, students
not `active`. `student` kind resolves to the student's live guardians (per `roles`) and the
student's own login.

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /announcements` | `@RequireCapability(ANNOUNCEMENT_SEND_SCOPE, ANNOUNCEMENT_SEND_SCHOOL)`: `.school` every row, else own rows | paginated; `status?`, `category?`, `priority?`, `createdFrom?`, `createdTo?`; sort `-createdAt`, `createdAt`, `-scheduledAt`, `-sentAt` | `AnnouncementDto { id, title, body, category, priority, status, audiences[], scheduledAt, expiresOn, hasAttachment, attachmentMime, holidayId, createdBy, createdByName, createdAt, sentAt, cancelledAt, cancelReason, recipientCount }` | received announcements are the inbox's job |
| `GET /announcements/:id` | same | — | `AnnouncementDto` | — |
| `POST /announcements` | same; broad kinds need `.school` | **`Idempotency-Key` required**; `{ title 1–120, body 1–2000, category, priority, audiences[], scheduledAt? (≥ now + 1 min, ≤ 90 d), expiresOn? (≥ today), stagedUploadId? }` | `201`, `draft` | audience rules above; `409 SMS_TOO_LONG` when urgent and the SMS rendering exceeds three segments (R110) |
| `POST /announcements/preview-audience` | same | `{ audiences[], priority, body? }` | `200 { recipients: { total, guardians, staff, students }, sms: { legs, segments, units, remaining, cap } }` | same refusals; 30/min per user (it walks the school) |
| `PATCH /announcements/:id` | creator or `.school` | create fields; `null` clears optional ones | `200` | `409 ANNOUNCEMENT_SENT`, `ANNOUNCEMENT_CANCELLED` |
| `POST /announcements/:id/send` | creator or `.school` | empty | `200 AnnouncementDto` (`scheduled` when `scheduledAt` is set, else `sending`) | resolves recipients, writes rows and messages, enqueues after commit; `409 SMS_CAP_EXCEEDED details { smsUnits, remaining, cap }`, `ANNOUNCEMENT_NO_RECIPIENTS`, `ANNOUNCEMENT_CANCELLED`, `SMS_TOO_LONG`; already scheduled/sending/sent → `200`, no audit; audited with counts by kind (R152) |
| `POST /announcements/:id/cancel` | creator or `.school` | `{ reason: 3–500 }` | `200` | from `draft\|scheduled`; already cancelled → `200`; `409 ANNOUNCEMENT_SENT` (R146) |
| `GET /announcements/:id/delivery` | creator or `.school` | — | `DeliverySummaryDto { announcementId, status, recipients: { total, guardians, staff, students }, byChannel: [{ channel, accepted, delivered, failed, suppressed }], suppressions: [{ reason, count }], smsSegmentsPerMessage, computedAt }` | no field named read (R150) |
| `GET /announcements/:id/attachment` (+ `/thumbnail`) | creator or `.school` | — | stream | — |
| `GET /me/inbox` | `@AuthenticatedOnly()` | paginated; `category?`; fixed `-sentAt` | `InboxItemDto { id, kind: 'announcement'\|'notice', messageType, title, body, category, priority, sentAt, expiresOn, hasAttachment, announcementId, viaStudents: [{ studentId, fullName }] }` | expired omitted (R147); per-user throttle (R166) |
| `GET /me/inbox/:id/attachment` (+ `/thumbnail`) | `@AuthenticatedOnly()` | — | stream; `:id` is the caller's own inbox item | `404` otherwise (R148) |

The **audience picker** (web, and a reduced one in the app) is one component shared by
announcements now and charge campaigns in Phase 3 (the architecture's warning): everyone → by
role → by class → by section → one student/family/staff member, with the live count and SMS units
from `preview-audience`. Holidays publish through this path (R151). Tests: R144–R152; a teacher
targeting a section outside scope → `422 REFERENCE_NOT_FOUND` identical to absent; a class target
with one section out of scope refused; a parent with three children once; a staff member who is
also a parent once, by the guardian plan; two guardians on one phone → one WhatsApp, two inbox
rows; scheduled send fires within a minute; cancel after send refused; urgent → WhatsApp + SMS;
normal keypad parent suppressed; delivery summary equals the delivery rows; a non-recipient cannot
fetch an attachment; a guardian issued a login after the send still sees it in the inbox.
Playwright: principal composes, previews the count and SMS units, sends; delivery page fills in
from the fake drivers; a teacher cannot see "Everyone".

### Slice 15 — Mobile foundation (≈ 5 days)

- 15.1 `apps/mobile`: Expo dev build, `expo-router`, theme tokens matching the web (restrained,
  no decoration), generated API client, `X-App-Version` on every request.
- 15.2 Sign-in (school code remembered, CNIC/B-Form digits, password) → bearer session in the
  secure store; `GET /me` → role-aware tab shell from `capacities`, capabilities and `assignments`
  (R156); forced-update screen (R161); sign-out revokes the session and device (R159) and wipes the
  stores (R155); session loss anywhere → sign-in screen with the queue paused (§4.7).
- 15.3 Push registration on first sign-in and token refresh (`POST /me/devices`); a notification
  tap deep-links to the inbox item, register or diary entry.
- 15.4 Offline store: SQLite schema (caches keyed by endpoint + params; `outbox`), the outbox
  worker (R157, R158), coalescing of register writes by natural key, connectivity listener, "as of"
  stamps, a sync status sheet listing pending and failed items with their server reasons.
- 15.5 Data cost: no media in lists; `expo-image` with the thumbnail endpoints; no background
  prefetch; a byte-count test over a scripted teacher day stays under 50 KB excluding images and
  under the per-session throttle (R160, R166).
- 15.6 Logging: no identity pattern, phone number, token or password in any log or crash report;
  the R16 regex (with the phone pattern) runs over the app's log sink.

Tests: Jest for the outbox state machine (every transition: `401` pause, `409`/`403` terminal,
`426`, network retry, coalescing) and tab composition from `/me`; Maestro: sign in → shell → sign
out. No feature screen yet beyond the shell and the inbox list (read-only, from slice 14's
`/me/inbox`).

### Slice 16 — Mobile screens (≈ 6 days)

**16a Teacher and parent (after 11, 13, 15):**
- My classes (from `/me.assignments`), **register** (section, date, period; one tap per student
  cycling present → absent → late → leave; submit; offline; "saved on server" only after the
  `POST` returns; a reason sheet when the server lists amendments), amendment with reason within
  the window (online, with `fromStatus`), **diary entry** (topic, assignment, outcome, due date,
  photo attachment queued separately), **remark** (student, category, text, visibility).
- Parent: **children** (one card each: today's derived status, this month's percentage with "n of
  m days"), **child attendance** (month view), **child diary** (by date, attachments on tap),
  **remarks** (guardian-visible), **inbox**, **calendar** (holidays). Student: own attendance,
  diary, inbox.
**16b Principal (after 14):**
- **Today**: attendance summary from the rollup (present/absent/late per class), **unrecorded
  registers** with "record now" (opens the register for that section) and "assign cover" (online),
  **new announcement** (short notice: title, body, urgent toggle, audience from the reduced picker:
  everyone / class / section, with the SMS units it will spend; longer composition stays on the
  web), SMS usage this month.
- Every list screen: loading, empty, error, offline ("as of") states; 360 px width; large tap
  targets (a corridor, one hand).

Tests: Maestro flows — teacher marks a register in airplane mode, reconnects, the server has it and
the parent's child card updates; parent opens the inbox and a diary attachment; principal sees the
unrecorded section and records it. Jest for the register tap cycle and the derived-status display.

### Slice 17 — Phase close (≈ 1.5 days)

- Real-driver proof on staging: one WhatsApp message through WAHA (deployed per §3's requirements)
  and one SMS through the chosen provider, delivery rows `delivered`.
- `security-reviewer` on the whole phase (parent access, webhooks, bearer sessions, the worker's
  tenancy, message bodies, WAHA deployment); `performance-engineer` on the register submit, the
  rollup, the roster-at-date query and the inbox query at 3,000 students × 200 teaching days;
  `code-quality` on the mobile app (one component per concern, no duplicated screens);
  `docs-maintainer` sweep; `CLAUDE.md` updated with exceptions 3 (widened), 5 and 6, the fifth
  constructor, and R37's amendment.
- R16 scans extended to message bodies, delivery rows, the worker's logs and the mobile log sink;
  R57 audit table extended to every new mutating route; the R68 snapshot extended with the
  `@RequireCapacity` and `@Webhook` routes.
- `phase-gate`; `WORKLOG.md` says what Phase 3 inherits (§10) and what was deferred.

---

## 7. Open items Phase 2 must not pre-empt

| Item | Phase 2 stance |
|---|---|
| 7–11 (money, exit states, retention) | No money tables. R164 keeps an ended link's child out of the parent's scope; retention of a departed family's access is item 11. |
| 13 | Per the owner's §1.2 answer; until then suspended = read-only plus `suppressed:school_suspended` on WhatsApp/SMS. |
| 12 staff leave | `cover` role only. No leave requests, entitlements or payroll effect. |
| 14, 15, 21 (results, promotion, approval unit) | Untouched; Phase 4 reads attendance from `attendance_day_status`, not raw marks. |
| 24, 25 (late payment, banking) | Untouched. |
| Events and PTM | Not built. An announcement with category `event` is text, not an event row. |
| Subjects and timetable | No timetable. Period attendance records the period number and who marked it; the server cannot verify that period N belongs to that teacher, and "unrecorded periods" is not deliverable (only "no register at all"). Recorded as a limitation; the timetable is a Phase 4 prerequisite and will tighten R120 and R129. |
| Inbound WhatsApp | Webhook receives and **counts** inbound messages; nothing is stored or matched. The deposit-screenshot flow is Phase 3 and needs the workflow specified first. |
| Early departure; half-day closures | Not recorded / not representable. Same decision as item 23 when the owner answers. |
| Biometric staff attendance | Deferred; the `staff_attendance` row is what a device would write later. |
| Read receipts | Not stored anywhere (rule 0.13). Unread state is local to the device. |
| Urdu | Rule 16; every template is English. |
| Audit-log screen | Still needs a 52nd capability — still a decision. |
| iOS | Deferred; the Expo project is iOS-capable, nothing in Phase 2 assumes Android-only APIs except FCM token handling, which `expo-notifications` abstracts. |

---

## 8. Numbered rules (each is a test)

**Messaging and the worker**
- R105 Every outbound message is a `messages` row written in the sender's transaction and
  enqueued after commit; a row still `queued` two minutes later is re-enqueued by the per-school
  sweep; the processor's first statement is a scoped conditional claim, so a replayed or forged
  job id sends nothing.
- R106 The channel plan is a pure function of (message type, `contact_capability`, device
  registered, school WhatsApp status, SMS allowed, cap remaining); every cell of the §4.2 matrix
  has a test.
- R107 One message per person per subject, enforced by the partial unique indexes: a guardian
  with three children receives a school-wide announcement once, and one `absence_alert` per
  absent child.
- R108 Every attempt writes a `message_deliveries` row, unique per (message, channel, attempt); a
  webhook can only move a delivery forward (`accepted → delivered|failed`); the word "read"
  appears in no DTO.
- R109 An SMS leg is sent only if the type is in the school's allow list and the month's usage is
  below the cap (atomic increment); otherwise it is `suppressed` with `not_allowed` or
  `cap_reached`; the first `cap_reached` in a month sends `sms_cap_reached` to the principal once.
- R110 Templated SMS fits one GSM-7 segment with the longest fixture values; announcement SMS is
  refused at compose and send time beyond three segments when any recipient has an SMS leg.
- R111 No message body, delivery row, push payload or log line contains an identity number,
  token, password, unmasked phone number or raw provider reference; the R16 scanner, extended
  with the phone pattern, runs over the messaging tables, the worker's logs and the push payloads
  after a full run; provider references are stored only hashed and provider errors only as mapped
  codes.
- R112 A WhatsApp leg falls to SMS after three failed attempts over fifteen minutes (if allowed);
  a failed health check marks the school's number `down`, routes new messages straight to the
  fallback and emails the platform once per transition (school name and id only). In production a
  missing driver credential fails boot; in development it selects the log driver.
- R113 The worker resolves `schoolId` only through `fromQueuePayload` (zod-validated, unbranded
  platform read, brand applied in the mint file), which drops a terminated school; every job body
  runs in `runAsSchool`; for a suspended school the §1.2 answer applies (default:
  `suppressed:school_suspended` on WhatsApp and SMS, push continues).
- R114 The platform's delivery-health view reads only `platform_delivery_health` and shows
  counts, statuses and mapped error codes per school, never a message body, a recipient or a
  phone number.
- R115 A push goes only to a device whose session is live and not idle-expired (checked by join at
  send time); logout, revocation, disable, office reset, sign-out-everywhere and staff leaving all
  stop push to that device within one request.

**Calendar and cover**
- R116 Teaching days = calendar days in range − weekly-off days − published holiday ranges; a
  holiday on a weekly-off day changes nothing; changing weekly-off days never rewrites recorded
  registers (the denominator is per student's recorded days, R128) and affects R118 and R129 going
  forward only.
- R117 Publishing a holiday sends exactly one `holiday_notice` per guardian and staff member (the
  announcement row *is* the notice, R151); cancelling a published holiday needs a reason and sends
  a cancellation; a draft sends nothing; a published holiday's dates, kind and name are frozen.
- R118 A register on a non-teaching day is `409 NOT_A_TEACHING_DAY`.
- R132 A `cover` assignment is dated, ends, confers class-teacher section scope for its dates only
  (breadth per the owner's §1.2 answer), does not displace the class teacher, cannot be
  self-assigned, requires the assignee to hold `attendance.student.mark`, pushes the cover
  teacher on assignment, and lapses without any write.
- R167 Publishing a holiday over dates with registers cancels their pending alerts
  (`cancel_reason = holiday`), excludes those days from every percentage, keeps the registers and
  flags them on the console; cancelling the holiday reverses the exclusion and the days show as
  unrecorded, never absent; the deadline job skips non-teaching days.
- R174 A section change closes the current enrolment on the day before `effectiveOn` and opens a
  new one (as a class change does); `enrolments.section_id` is never edited in place after this
  slice; the old register remains amendable and the roster for any past date is exact.

**Student attendance**
- R119 One register per (section, date, period); the first submit must cover the whole roster
  (`422 ROSTER_INCOMPLETE`), later submits may name a subset; submitting is idempotent on the
  natural key; the first submit sets `submitted_by/at`, later ones `last_amended_by/at`.
- R120 Only an assignment active **on the register's date** (class teacher or cover any period;
  subject teacher any period in period mode) or an `all`-scope `attendance.student.mark` holder
  may submit or amend; the service checks `rolesOn(section, date)`, never today's scope alone.
- R121 Daily mode accepts period 1 only; period mode accepts 1…`periodsPerDay`; anything else
  is `422`.
- R122 Every status or note change after the first write produces an `attendance_mark_changes`
  row with actor, time and a non-null reason, via the trigger; a change without a reason is
  `409 AMENDMENT_REASON_REQUIRED` listing the amendments; a direct update without the
  transaction-local actor is refused by the database.
- R123 Section-scoped amendments after the window are `409 ATTENDANCE_LOCKED`; `all`-scope
  holders may amend after it, audited.
- R124 The roster is the enrolments active on the date in that section (not `suspended`), plus
  any already marked; future dates, dates outside the academic year, non-teaching days and
  enrolments not on the roster are refused; the request is all-or-nothing.
- R125 An identical replay is `200` and writes no history, regardless of the window; a replay
  with different statuses is an amendment (with reason) within the window and `ATTENDANCE_LOCKED`
  after it; an amend with a stale `fromStatus` is `409 STALE_STATUS` — never last-write-wins,
  never a silent drop.
- R126 One `absence_alert` per child per day, due at `max(submit + 30 min, absenceAlertTime)`,
  only for today's register, sent only if every recorded period is still `absent` when due;
  `late` cancels it and sends `late_advice` (if enabled); any change after it was sent that makes
  the day not all-absent sends `attendance_corrected` once, reversals send a further one with
  `seq + 1` capped at 3; the alert row is locked by both the sender and the amend path;
  recipients are primary contacts, else every live guardian with a login or a phone; a backdated
  absence sends nothing.
- R127 The derived day status follows `on_leave (all) > absent (all) > partial (mixed) > late
  (first period late, rest present/late) > present`, materialised per enrolment-day; conflicting
  period entries are both retained and shown; every combination over 1–3 periods is table-tested.
- R128 The day is the unit in both modes; day values follow §6 slice 11; counted days are the
  teaching days on which the student has a recorded period, aggregated by `student_id` within the
  year; `lateCountsAs` (with the cutoff), `leaveCountsAs` and holidays are honoured; unrecorded
  days are excluded; zero counted days is "no recorded days", never 100 %; one pure function
  computes it from `attendance_day_status` and the settings.
- R129 After the deadline on a teaching day, every section with a non-empty roster and no
  register at all is listed as unrecorded (live) and one `register_unrecorded` push goes to the
  principal and all-scope mark holders per school per day, naming sections and cover teachers.
- R130 Teachers read only their scope; guardians only their linked children; students only
  themselves; `attendance.student.view_all` reads everything.
- R131 The statement-level trigger bumps the section-day `version` on any mark write; the
  processor recomputes `attendance_day_status` and the summary within a minute and sets
  `computed_version`; the nightly job recomputes every stale section-day; the console, reports,
  parent views and Phase 4 read these tables, never raw marks.
- R168 `POST /attendance-arrivals` moves the day's first recorded `absent` mark to `late` with
  `arrived_at` and an automatic reason, refuses anything else (`409 ARRIVAL_NOT_ABSENT`), and
  interacts with R126 exactly as an amendment does.
- R175 `scopeOf(session, { on: date })` returns sections with roles from `rolesOn`; a subject
  teacher is refused in daily mode, a subject teacher is refused another subject's diary, a
  teacher is refused a register dated before their assignment began, a cover is refused outside
  its dates — each a named test.

**Staff attendance**
- R133 One row per staff member per date; amendments are logged with a non-null reason and a
  `fromStatus` check.
- R134 Nobody marks or amends their own staff attendance, principals included; a payload holding
  the caller's own row is refused whole; the trigger refuses a direct write.
- R135 Any staff member reads their own history; `staff.view` reads others'.
- R136 Non-teaching days (weekly off, or a published holiday with `applies_to_staff`) are refused.

**Diary and remarks**
- R137 One diary entry per section, date and subject; a class teacher may write any subject, a
  subject teacher only an assigned one; edits by the author within the window need no reason, by
  `all`-scope `diary.write` after it need one; every edit is a `diary_entry_changes` row.
- R138 Posting sends `diary_posted` by push and in-app to the section's guardians and students
  with logins, never by WhatsApp or SMS; a keypad guardian gets a suppression row.
- R139 Diary and remark text refuse identity patterns.
- R140 A remark's visibility defaults from settings; visibility is a level (`student` ⊇
  `guardian`); guardians see `guardian`-or-above, students `student`, staff all; `remark_posted`
  goes out only when `remarkNotifyGuardians`.
- R141 A remark is never edited; a correction is a new row with `supersedes_id` (a chain, never a
  tree), and the original shows as superseded to every reader who could see it.
- R142 Diary readers are the section's assigned staff, `diary.write` all-scope holders, the
  section's guardians (via `/me/children`) and students (via `/me/student`); nobody else,
  including other teachers and office staff.
- R143 A diary entry, remark or announcement replayed with the same `Idempotency-Key` returns the
  existing row to its author with `200`; another user's replay of that key is `409
  IDEMPOTENCY_KEY_REUSED`; no `client_reference` exists.
- R171 `POST /uploads` is open to `document.upload`, `diary.write` and both announcement
  capabilities; consumption is bound to the uploader; thumbnails are produced by the re-encode
  pipeline only.

**Announcements**
- R144 School-wide and staff audiences need `announcement.send.school`; scoped audiences need
  `announcement.send.scope` and every target must be inside the sender's scope (a class only when
  all its sections are); an absent, other-tenant or out-of-scope target is `422
  REFERENCE_NOT_FOUND` with an identical body.
- R145 Audiences resolve to persons once each at send time, deduped by user, then identity hash,
  then phone per channel; `roles` decide whether a class/section/student target reaches parents,
  students or both; a staff member who is also a parent is one recipient on the guardian plan;
  `announcement_recipient_students` records why a parent is in the audience.
- R146 A scheduled announcement sends within one minute of its time, may be edited or cancelled
  until then, and is immutable once `sending` or `sent`; a draft may be cancelled.
- R147 Expired announcements leave every inbox and stay on the school's list.
- R148 One attachment, image or PDF ≤ 5 MB, streamed only to recipients (own inbox item) and
  senders; sent as bytes on WhatsApp, as "see the app" on SMS; never a URL.
- R149 Urgent → WhatsApp and SMS together (subject to R109) plus push; normal → WhatsApp plus
  push, SMS only after failure and only if allowed.
- R150 The delivery summary equals the delivery rows: recipients, per-channel accepted, delivered,
  failed, suppressed with reasons; no read count exists.
- R151 Publishing a holiday creates the announcement that is its notice (`holiday_id` set,
  audience `everyone`); cancelling the holiday cancels an unsent one or sends a cancellation
  notice for a sent one.
- R152 Create, schedule, send and cancel are audited with actor, counts by audience kind and the
  reason, never recipient names.

**Mobile and bearer sessions**
- R153 A bearer token is returned in the body only when the login asked for `channel: bearer`; a
  cookie client never sees a token in a body and a bearer client never gets a cookie; password
  change rotates on the caller's channel.
- R154 Bearer sessions idle out and expire per capacity (§1.1); every Phase 1 revocation path
  (disable, office reset, password change, staff left/suspended, student status, issue-login reset)
  plus device revoke and sign-out-everywhere ends them; an ended guardian link shrinks scope
  without revoking the session.
- R155 The token lives in the secure store only; sign-out and any `401` wipe the SQLite and
  secure stores; no identity pattern, phone number, token or password reaches the app's logs,
  crash reports or `AsyncStorage`; cleartext traffic is off.
- R156 Tabs and actions are composed from `/me` (`capacities`, capabilities, `assignments`); a
  screen the API would refuse is never rendered; a user with no capacity sees the "no access"
  screen and is signed out.
- R157 Offline writes move `pending → sending → done | failed(reason)`; "saved on server" appears
  only after the server's `2xx`; `409` and `403` are terminal with the server's message; `401`
  pauses the queue; `426` shows the update screen.
- R158 Queue items are independent per endpoint; a failed attachment never blocks a register;
  register writes to one natural key are coalesced before sending.
- R159 Device registration is tied to the session; sign-out revokes the session and device
  server-side before the token is discarded; a token re-registered under another session replaces
  the earlier device row.
- R160 A scripted teacher day (sign-in, three registers, one diary entry, inbox refresh) transfers
  under 50 KB excluding images and stays under the per-session throttle; no image loads before a
  tap.
- R161 A request below `MOBILE_MIN_APP_VERSION` is `426 UPGRADE_REQUIRED` (checked before session
  resolution; a bearer request with no header is below every floor) and the app shows only the
  update screen.
- R162 Online-only actions (amend after window, assign cover, send announcement, arrivals) fail
  closed offline with a clear message and never enter the outbox.
- R169 `POST /me/sessions/revoke-others` ends every other session and device of the caller;
  `POST /users/:id/sign-out-everywhere` does the same for a target under R10/R12/R14, audited,
  without touching the password.
- R170 The Origin check applies to every non-GET carrying neither `Authorization` nor
  `X-App-Version`; a bearer login or any bearer request that carries `Origin` or a school cookie
  is `401`.
- R173 A push payload carries only ids, a title and the rendered body; `*.pushToken` is a redact
  path; `GET /me` and `DeviceDto` never return a token.

**Parent and student access**
- R163 A guardian's scope is the students linked by live `student_guardian` rows **with
  `can_login`** for their guardian id (guardian row not merged); a student's scope is themselves;
  neither holds a capability; `@RequireCapacity` admits them only on `/me/*` routes (snapshot).
- R164 A guardian keeps read access to a child whose status is no longer `active` while the link
  is live, and receives no new notices for that child; an ended link removes the child from scope
  on the next request, history included, and cancels that guardian's pending alerts.
- R165 A `/me/*` response never carries another student, another guardian's name, phone,
  relationship or flags, a staff phone number, an identity number or a teacher's attendance note;
  teachers appear by name only.
- R166 `/me/*` routes are throttled per session (`perUserThrottle('me-reads', 120, 2000)`);
  bearer traffic's per-IP ceiling is a DoS backstop only (3,000/min, because carrier NAT puts
  thousands of parents behind one address); `POST /auth/login` keeps 5/min per account+IP and
  10/min per username with its per-IP limit raised to 300/min.
- R172 Webhooks are verified over raw bytes with `timingSafeEqual` and a timestamp window where
  available; DTOs pick only the fields used; an unknown reference is `204` and a counter; a bad
  signature is `401` without details; the response never echoes the body; an unsigned provider's
  reports are accepted only from its published addresses at the edge and can only move a delivery
  forward.

---

## 9. Definition of done for the phase

All of `CLAUDE.md`'s Definition of Done, read literally, plus:

- R105–R175 each have a named test, and CI runs them; the Maestro flow runs on an emulator in CI.
- One real WhatsApp delivery and one real SMS delivery proven on staging with `delivered` rows,
  with WAHA deployed per §3's requirements (private network, no port, encrypted volume, dashboard
  off, pairing audited).
- The R16 scan, with the phone pattern, covers `messages`, `message_deliveries`, push payloads,
  the worker's logs and the mobile log sink.
- A keypad-phone guardian, a WhatsApp guardian and a smartphone-without-WhatsApp guardian each
  have an end-to-end test from a register submit to their delivery rows, including the late
  arrival and the corrected notice.
- A teacher's day works with the phone in airplane mode until the walk back to the staff room.
- Every mobile screen has loading, empty, error and offline states at 360 px; every web screen the
  Phase 1 four states at 1280 px and tablet width.
- Exactly one worker instance, the WAHA container with its persistent encrypted session volume
  and health check, and the edge-proxy allow-list for an unsigned SMS provider are documented
  deployment requirements.
- `CLAUDE.md` records the fifth `SchoolId` constructor, exceptions 3 (widened), 5 and 6, and the
  amendment of R37.
- `WORKLOG.md` says what Phase 3 inherits and what was deferred, with register numbers.

---

## 10. What Phase 3 will need from Phase 2 (so do not paint over it)

- `NotificationService` and the message-type table — fee due, overdue, payment verified/rejected
  and receipt types are new rows there, not new code paths. Their SMS defaults are item 22's.
- The **audience picker** component and `preview-audience` — charge campaigns target with it, SMS
  units included.
- `message_usage` and the cap — the subscription plan table (item 18) reads and sets it.
- `staff_attendance` rows and `holidays.applies_to_staff` — payroll deductions and working days.
- The worker, `runAsSchool` and the queues — the monthly invoice job and reminder jobs are
  repeatable jobs there, resolved through `fromQueuePayload`.
- The WAHA webhook and `inbound_ignored_count` — inbound deposit screenshots arrive through it once
  the inbound workflow is specified; Phase 2 already counts them.
- Bearer sessions, devices and the mobile shell — the principal's approvals inbox (fee proofs,
  handovers) adds tabs to the app, not a second app.
- `attendance_day_status` — Phase 4's report cards read attendance from it, per enrolment-day,
  never from marks; `attendance_daily_summary` serves dashboards only.
