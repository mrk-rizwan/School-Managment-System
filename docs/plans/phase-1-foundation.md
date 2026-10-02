# Phase 1 — Foundation: build plan (TypeScript stack)

**Audience:** the Opus 5.5 session that writes the code. Self-contained; read `CLAUDE.md` and
`docs/WORKLOG.md` first, then this file top to bottom before touching anything.
**Author:** Fable 5.1, 2026-10-02. **Replaces** the Laravel/Filament plan of 2026-10-01 (git
`29bbd13`), whose requirements, slice order and numbered rules were reviewed and are carried over.
**Stack:** NestJS · PostgreSQL + Prisma · Next.js · Redis. Tenant isolation is application-layer
(`CLAUDE.md` "How tenant isolation is implemented"). **Status:** DRAFT — design reviews in progress; do not execute until this line says approved.

Phase 1 delivers what the client deck calls *Foundation*: **students, staff, classes, credentials
and permissions**, on top of the tenancy and session plumbing every later phase stands on. Nothing
financial, no attendance, no mobile app. At the end a school can be created by the platform, its
principal can log in, define sessions, classes and sections, register staff, admit students with
their guardians, issue logins, and control who may do what.

**Size, stated honestly.** The Laravel plan was about 17 working days because Filament generated
the admin screens. Here every screen and every endpoint is written, so this plan is about
**27 working days**. The extra is UI and API surface, not new requirements.

---

## 0. Rules that bind every task

1. The settled rules in `CLAUDE.md` (1–17), its tenancy section and its conventions table are not
   revisited here. If a task below seems to conflict with one, `CLAUDE.md` wins and the task is
   wrong — say so in `WORKLOG.md`.
2. **Every slice ends with**: lint, typecheck and tests passing (run them, paste the summary),
   `security-reviewer` and `code-auditor` run with findings closed, `phase-gate` PASS. A slice is
   not done on a claim.
3. **Tenant isolation test for every table**, written with the table, not after.
4. **Inspect before creating.** NestJS, Prisma and the packages pinned in §2 already do
   validation, guards, throttling, hashing, mail, scheduling. Do not hand-roll them.
5. **Minimal.** No abstraction with one caller, no pass-through wrappers. The repository layer is
   the one mandated layer; do not add a second one above it.
6. **Each slice is a vertical cut**: schema → repository → service → controller → web screen →
   tests. A slice whose API works but whose screen does not is not done.
7. **Update `docs/WORKLOG.md`** at the end of every slice and whenever a decision here turns out
   wrong. The next session may be a different model.
8. Commit per slice. Never `--no-verify`.
9. **The numbered rules in §7 are test names.** Each gets at least one test whose name carries
   the rule number.
10. `api-designer` reviews the endpoint list of a slice before its controllers are written;
    `data-architect` reviews its Prisma models and raw SQL before the migration is generated.

---

## 1. Shape of the system after Phase 1

```
asms/
  apps/api/                      NestJS
    prisma/schema.prisma, migrations/
    src/
      main.ts, app.module.ts
      common/          error envelope, pagination, validation config, crypto, logging
      tenancy/         SchoolId brand, request context (CLS), session → tenant resolution
      repositories/    THE ONLY PLACE THAT IMPORTS PRISMA. One file per aggregate.
        platform/      the non-tenant repositories (CLAUDE.md exception 1)
      modules/
        platform/      schools, platform users, platform auth
        auth/          login, sessions, password flows, email verification
        access/        capabilities, role defaults, custom roles, grants, permission guard
        academics/     academic years, classes, sections, subjects, teacher assignments
        people/        staff, guardians, students, enrolments, admission
        documents/     upload, staging, streaming
        audit/         audit log
  apps/web/                      Next.js App Router
    app/(auth)/        login, forgot, reset, verify-email
    app/(school)/      the school admin, one layout, capability-aware navigation
    app/platform/      the platform admin, separate layout and session
    components/, lib/api/ (generated client)
  packages/shared/               Capability enum, system-role defaults, error codes
  docker-compose.yml             postgres, redis, mailpit, minio
```

Two sessions, two cookies, two login pages: `/login` for school users, `/platform/login` for
platform admins. Parent and student accounts exist in the same `users` table and can
authenticate against the API, but have no screens until Phase 2.

The web app talks to the API on the **same origin**: Next.js rewrites `/api/*` to the Nest
process, so the session cookie is first-party and there is no CORS configuration at all.

---

## 2. Stack, versions, environment

| Item | Decision |
|---|---|
| Node | 24 LTS on the host (`.nvmrc`, `engines`). pnpm workspaces, lockfile committed. |
| Versions | NestJS 12.x, Prisma **7.x latest stable** (do **not** install a release candidate, even if npm's `latest` tag points at one), Next.js 16.x, React 19.x, TypeScript at the newest version all three accept. **Pin exact versions on day one and record them in `WORKLOG.md`.** |
| Database | PostgreSQL 16 in Docker. One runtime role. No SQLite anywhere, including tests — partial indexes and `CHECK` constraints are part of the design. |
| Dev services | `docker compose up`: `postgres`, `redis`, `mailpit` (mail catcher), `minio` (S3-compatible). Node runs on the host. |
| API packages | `@nestjs/*` core, `@nestjs/throttler` with Redis storage, `@nestjs/schedule`, `@nestjs/swagger`, `nestjs-cls` + `@nestjs-cls/transactional` + its Prisma adapter, `class-validator` / `class-transformer`, `argon2`, `nodemailer`, `nestjs-pino`, `@aws-sdk/client-s3`, `multer`, `file-type`, `sharp`, `ulid`. |
| Web packages | Tailwind, shadcn/ui, `@tanstack/react-query`, `@tanstack/react-table`, `react-hook-form`, `zod` (form-level validation only), `openapi-typescript` + `openapi-fetch` (typed client generated from the API's OpenAPI document). |
| Not in Phase 1 | No BullMQ and no worker process (nothing here needs a queue; mail is sent after commit, in-process). No JWT library. No ORM other than Prisma. No state library beyond TanStack Query. Anything else: justify in `WORKLOG.md` first. |
| Tests | API: Jest + supertest, **end-to-end against the real Postgres**, plus unit tests for pure logic (`EffectivePermissions`, phone normalisation, crypto). Web: Playwright for the flows named in each slice. |
| CI | GitHub Actions on every push: `pnpm install --frozen-lockfile`, lint, typecheck, `prisma migrate deploy` against a service Postgres, API tests, web build, Playwright. Red CI blocks the slice. |
| Secrets | `.env` only; `.env.example` committed with every key and no values: `DATABASE_URL`, `REDIS_URL`, `IDENTITY_HASH_KEY`, `FIELD_ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET` (unused if tokens are opaque — omit if so), `S3_*`, `SMTP_*`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `APP_URL`. |

---

## 3. Cross-cutting conventions (built in slice 0, used by every slice)

**Tenancy.** `SchoolId` is a branded `bigint` type whose only constructors live in
`src/tenancy/`: from a resolved session, from `SchoolLookupRepository.findByCode`, and (later) from
a validated job payload. A request-scoped context (`nestjs-cls`) holds `{ schoolId, userId,
sessionId }` after the session middleware runs. Services read it through a `RequestContext`
service; repositories never read it — **`schoolId` is always an explicit first argument**, so a
repository call cannot compile without one.

**Repositories.** One class per aggregate in `src/repositories/`. Every method's first parameter is
`schoolId: SchoolId`; every query's `where` includes it; `findUnique` is never used on a tenant
model. ESLint `no-restricted-imports` forbids `@prisma/client` and the generated client path
everywhere except `src/repositories/**`, and forbids `src/repositories/platform/**` everywhere
except `src/modules/platform/**` and the three named exception call sites. A test asserts the
lint rule is active by linting a fixture file that violates it.

**Transactions.** `@Transactional()` from `@nestjs-cls/transactional` on the service method that
is the unit of work. Interactive transactions only. No `Promise.all` inside one. Mail, file moves
and anything else that must not happen on rollback run in an after-commit hook.

**Ids.** `BigInt @id @default(autoincrement())`. Serialised as **strings** in every response and
parsed from strings in every param and body (`ParseIdPipe`, a `@IsIdString()` validator). A test
asserts no response body contains a JSON number in an `id` or `*Id` field.

**API shape.** Base path `/api/v1`. JSON only; state-changing requests with any other content type
are refused. Errors: `{ "error": { "code": "STUDENT_BFORM_DUPLICATE", "message": "...",
"details": {...} } }` — codes are constants in `packages/shared`, stable forever; messages may
change. Validation failures are `422` with per-field details. Lists: `?page=1&limit=25`, `limit`
capped at 50, response `{ data: [...], page, limit, total }`. Global `ValidationPipe` with
`whitelist: true, forbidNonWhitelisted: true, transform: true`. No DTO declares `schoolId`.
OpenAPI is generated on build; the web client is regenerated from it and CI fails if the
committed client is stale.

**Authorisation.** `@RequireCapability(Capability.X)` on every controller method except the
auth endpoints; a global guard refuses any route that has neither that decorator nor an explicit
`@Public()` / `@AuthenticatedOnly()`, so a forgotten check is a `500` in tests, not an open
endpoint. Row-level scope (a teacher's own classes) is applied **in the repository query** through
a `scope` argument, never by filtering results afterwards.

**Sessions.** `sessions(school_id, user_id, token_hash, created_at, last_seen_at, expires_at,
revoked_at, user_agent, ip)`. The token is 32 random bytes, base64url; only its SHA-256 is stored.
Web: `httpOnly`, `Secure`, `SameSite=Lax` cookie `asms_session`. Mobile (Phase 2): the same token
as `Authorization: Bearer`. Idle timeout 24 hours, absolute 30 days. Every request loads the
session by hash (exception 4), refuses it if revoked, expired, the user is not `active`, or the
school is `terminated`; a `suspended` school is read-only (every non-GET is `403
SCHOOL_SUSPENDED`). Cookie-authenticated non-GET requests must carry an `Origin` equal to
`APP_URL`. Revocation is `revoked_at = now()` — rows are kept.

**Identity numbers.** `cnic` / `bForm` columns hold `v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM,
`FIELD_ENCRYPTION_KEY`), written and read only through `common/crypto`. `*_hash char(64)` =
HMAC-SHA256 of the 13 digits with `IDENTITY_HASH_KEY`. Two separate keys; rotating one does not
break the other. Lookups by hash; display masked (`35201-*****-1`). CNIC and B-Form never appear
in a URL, a query string, a log line, an audit row or a list response — lookups are `POST` with
the digits in the body.

**Logging.** `nestjs-pino` with `redact` on `req.headers.cookie`, `req.headers.authorization`,
`*.password`, `*.cnic`, `*.bForm`, `*.token`, and a serializer that replaces any 13-digit run with
`[id]`. Request bodies are not logged.

**Audit.** `audit_log(school_id, actor_user_id, action, subject_type, subject_id, reason,
metadata jsonb, created_at)`, written by `AuditService.record()` **explicitly, inside the same
transaction** as the change — no interceptor magic. Platform actions go to `platform_audit_log`.
`metadata` never contains identity numbers, passwords or tokens.

**Phones.** Stored E.164 in `varchar(16)` with `CHECK (phone ~ '^\+[1-9][0-9]{7,14}$')`; one
`normalisePhone()` turns `0300-1234567`, `03001234567`, `+92 300 1234567` into `+923001234567`,
defaulting to `+92`.

**Web.** One `(school)` layout with a sidebar built from the user's effective capabilities
(`GET /api/v1/me`). Every list screen has loading, empty, error and no-permission states; every
form shows field errors from the `422` details. One table component, one form field set, one
confirm-with-reason dialog — reused everywhere, never re-made per screen.

---

## 4. Slice plan

Estimates are for orientation. Each slice lists schema, endpoints, screens and tests; `api-designer`
turns the endpoint line into full contracts before controllers are written.

### Slice 0 — Scaffold and guardrails (≈ 3 days)

**Goal:** an empty system where the isolation guardrails are already live and provably working.

- 0.1 pnpm workspace, `apps/api` (Nest), `apps/web` (Next), `packages/shared`. Docker compose.
  `.env.example`. ESLint + Prettier shared config. `README.md` with the clone-to-running steps.
  Confirm the pre-commit hook fires on a planted `.env`.
- 0.2 API skeleton: config validation at boot (missing env → refuse to start), error envelope
  filter, `ValidationPipe`, pino with redaction, `/api/v1/health`, OpenAPI generation, throttler
  wired to Redis.
- 0.3 Prisma baseline: `schools` only (full table in slice 1). Naming: models `PascalCase`,
  tables and columns `snake_case` via `@@map` / `@map`, `timestamptz(3)` timestamps, `@db.Date`
  dates. Migration generated, reviewed as SQL, committed.
- 0.4 Tenancy: `SchoolId` brand, CLS request context, `@Transactional()` wiring, the ESLint
  boundaries and the fixture test proving they fire.
- 0.5 **Schema guard test** (reads Prisma's DMMF): every model outside the allowlist `School`,
  `SchoolGroup`, `PlatformUser`, `PlatformSession`, `PlatformAuditLog` has a required `schoolId`,
  a `@@unique([schoolId, id])`, and every relation to another tenant model uses the composite
  `[schoolId, xId]` fields. A new model that breaks this fails CI.
- 0.6 **Isolation test helper**: `expectIsolated(repoMethodForA, repoMethodForB)` plus factories
  that create two schools. Tests never truncate — each test creates its own schools, so tenancy
  itself isolates tests and they can run in parallel.
- 0.7 Web skeleton: Tailwind, shadcn/ui, the layout shell, the generated API client, TanStack
  Query provider, the shared table / form / dialog components with a throwaway demo page.
  Playwright runs one smoke test.
- 0.8 CI workflow green.

Acceptance: fresh clone → `docker compose up` → `pnpm i` → `pnpm dev` shows a health page; CI
green; a deliberately wrong Prisma import and a deliberately tenant-less model both fail CI.

### Slice 1 — Platform and the school record (≈ 2 days)

Schema (non-tenant, allowlisted): `platform_users` (email, password argon2id, status),
`platform_sessions`, `platform_audit_log`, `school_groups` (id, name), `schools`: `name`,
`short_code` (`UNIQUE`, 3–12 lower-case ASCII letters/digits — users type it at login), `status`
(`trial|active|suspended|terminated`), `school_group_id` nullable, `timezone` default
`Asia/Karachi`, `fee_due_day` default 10 `CHECK (BETWEEN 1 AND 28)`, `currency` `'PKR'`,
`student_login_enabled` default false, `student_login_min_class_sort` nullable,
`last_admission_no` int default 0.

Endpoints: `POST /platform/auth/login|logout`, `GET /platform/me`, `GET|POST /platform/schools`,
`GET|PATCH /platform/schools/:id`, `POST /platform/schools/:id/status` (with reason).
Screens: platform login, schools list, create/edit school, status change dialog.
Seed: one platform admin from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`; refuse to seed
if either is missing.

Tests: R56; status change audited; `fee_due_day` 29 refused; duplicate `short_code` refused;
platform login throttled.

### Slice 2 — Staff (minimal), users, sessions, login (≈ 4.5 days)

**Goal:** a school user logs in with school code, CNIC digits and the default password; is
prompted to change it; can set a verified email and reset by it; the office can reset within the
limits of §7. The capability guard goes live here so every later slice is written against it.

Schema:
- `staff` (minimal now; the principal is staff, rule 7): `full_name`, `cnic` encrypted nullable,
  `cnic_hash` nullable, `phone`, `designation`, `joined_on`, `status` (`active|suspended|left`).
  Partial unique `(school_id, cnic_hash) WHERE cnic_hash IS NOT NULL`.
- `users`: `username_hash char(64)` (**no plaintext username column**), `password_hash`, `email`
  nullable (**not unique**), `email_verified_at`, `password_is_default`, `password_changed_at`,
  `status` (`active|disabled`), `staff_id` / `guardian_id` / `student_id` nullable composite FKs
  (the latter two added in slices 5–6), `last_login_at`. `UNIQUE (school_id, username_hash)`.
  `CHECK (num_nonnulls(staff_id, guardian_id, student_id) >= 1)` added in slice 6.
- `sessions` (§3). `user_tokens`: `user_id`, `purpose` (`password_reset|email_verify`),
  `token_hash`, `expires_at`, `used_at`.
- `user_roles`: `user_id`, `system_role` nullable (`principal|office_staff|teacher|parent|
  student`), `custom_role_id` nullable (FK added in slice 7), `CHECK` exactly one is set.
- `audit_log` (§3).

Code: `packages/shared` gets the `Capability` enum (all 51 keys, §6), `SYSTEM_ROLE_DEFAULTS`, and
the error codes. `PermissionsService.effective(user)` computes from system roles only for now;
slice 4 adds teacher scope; slice 7 adds custom roles and grants. `@RequireCapability` guard and
the "no undecorated route" guard go live.

Behaviour (rule 12; R1–R16, R61–R68):
- Login `POST /auth/login { schoolCode, username, password }`. School resolved by
  `SchoolLookupRepository.findByCode`; user by `(schoolId, usernameHash)`; `argon2.verify`, with a
  dummy verify when the user is absent so timing matches. One generic `401 AUTH_FAILED` for wrong
  code, wrong user, wrong password, locked, disabled, terminated school.
- Throttling: 5/min per school+username+IP; **10/min per username across all schools**; 30/min
  per IP. Lockout: 5 consecutive failures → 15 minutes, a Redis counter keyed
  `lock:{schoolId}:{usernameHash}`; office reset deletes the key. (If Redis is wiped, lockouts
  reset — acceptable; nothing of record lives in Redis.)
- Default password = the 13 digits. This slice builds **"Issue principal login"** on the platform
  panel: creates the `staff` row, the user, and `user_roles → principal`, in one transaction.
- `GET /me` returns user, school, roles, effective capabilities and `passwordIsDefault`; the web
  shows a persistent banner while it is true. **Prompt, not force.**
- Change password `POST /me/password` requires a **verified** email on the account. `POST
  /me/email` sets it and mails a verification link `APP_URL/verify-email/{shortCode}?token=…`;
  any change nulls `email_verified_at`. Only the account holder sets their email. New password ≥ 8
  characters and not the username digits. Success revokes the user's other sessions.
- Forgot password `POST /auth/forgot { schoolCode, username }` — never an email. Always
  `202` with the same body. A link `APP_URL/reset/{shortCode}?token=…` is mailed only if the user
  is `active` with a verified email. Token 15 minutes, single use, stored hashed. Reset clears
  `password_is_default`, the lockout key and all sessions.
- Office reset `POST /users/:id/reset-password { reason }` (capability `user.account.manage`,
  subject to R12–R14): default password, `password_is_default = true`, lockout cleared, **all of
  the target's sessions revoked, outstanding `user_tokens` voided**, email kept, target notified by
  email if verified, audited, `status` untouched.
- `POST /users/:id/disable|enable { reason }`; disabling revokes sessions at once. Not on yourself.
- Users list `GET /users` (capability `user.account.manage`): name, linked person, roles, masked
  CNIC, "default password" and "no email" flags, status.

Screens: login (school code remembered in `localStorage`), forgot, reset, verify-email, the
default-password banner, change-password/email page, users list with reset/disable dialogs.

Tests: R1–R16, R61–R68; same digits in two schools lands in the school whose code was typed; reset
token from school A cannot reset the same digits in school B; no 13-digit string in the captured
log output of the whole suite. Playwright: login → banner → set email (link read from mailpit) →
change password → banner gone.

### Slice 3 — Academic structure (≈ 2.5 days)

Schema:
- `academic_years`: `name`, `starts_on`, `ends_on`, `status` (`planned|active|closed`).
  `CHECK (ends_on > starts_on)`. Several may be active (rule 15). No delete.
- `classes` — **one row per class per academic year; its year never changes once referenced**:
  `academic_year_id`, `name`, `sort_order`, `attendance_mode` (`daily|period`, default `daily`),
  `status` (`active|archived`). `UNIQUE (school_id, academic_year_id, name)`,
  `UNIQUE (school_id, id, academic_year_id)` for the composite FK from enrolments and assignments.
  April and September "Class 5" are two rows. There is no "current session" pointer.
- `sections`: `class_id`, `name`, `capacity` nullable, `deleted_at`. Partial unique
  `(school_id, class_id, name) WHERE deleted_at IS NULL`.
- `subjects`: `name`, `code` nullable, `deleted_at`. Partial unique `(school_id, name) WHERE
  deleted_at IS NULL`. No timetable in Phase 1.

Endpoints: CRUD for the four resources; `POST /academic-years/:id/close`; `POST
/classes/:id/copy-sections`. Screens: one "Academic structure" area with four list/edit screens.

Tests: R44 (closing a year with active enrolments — wired in slice 6, stubbed with a failing
`todo` test here so it cannot be forgotten); isolation per table; year dates; class year change
refused once referenced; section soft-delete refused while an active enrolment references it.

### Slice 4 — Staff (full) and teacher assignments (≈ 2.5 days)

Schema: `staff` gains `photo_key` nullable, `left_on` nullable. `teacher_assignments`: `staff_id`,
`academic_year_id`, `class_id`, `section_id` nullable, `subject_id` nullable, `role`
(`class_teacher|subject_teacher`), `starts_on`, `ends_on` nullable. `CHECK (role <>
'class_teacher' OR section_id IS NOT NULL)`. Partial unique `(school_id, academic_year_id,
section_id) WHERE role = 'class_teacher' AND ends_on IS NULL`. Active = `ends_on IS NULL`. Rows are
ended, never deleted. **This table is the only scope source for teacher checks** (rule 13).

Endpoints: staff CRUD (no delete), `POST /staff/:id/status`, `POST /staff/:id/issue-login`,
`GET|POST /staff/:id/assignments`, `POST /assignments/:id/end`. `ScopeService.forUser(user)`
returns the section ids a teacher may see; `PermissionsService.can(user, cap, subject)` uses it.
Screens: staff list, staff detail with assignments tab, status and issue-login dialogs.

Tests: R17–R24, R53, R54; CNIC column is ciphertext in the database; one current class teacher
per section, two sequential allowed; isolation.

### Slice 5 — Guardians (≈ 1.5 days)

Schema: `guardians`: `full_name`, `cnic` encrypted + `cnic_hash` nullable, `phone` nullable,
`email` nullable (contact, not the login email), `contact_capability` (`whatsapp|smartphone_data|
keypad`, **not null**, rule 17), `address` nullable, `merged_into_id` nullable self FK, `status`
(`active|merged`). Partial unique `(school_id, cnic_hash) WHERE cnic_hash IS NOT NULL`; index
`(school_id, phone)`. **No uniqueness on phone.** `users.guardian_id` FK added.

Endpoints: `GET /guardians`, `GET|PATCH /guardians/:id`, `POST /guardians`,
`POST /guardians/search { cnic? , phone? }` (POST so digits stay out of the URL),
`POST /guardians/:id/issue-login`. Screens: guardian list (flags "no CNIC", "no phone"), detail.

Tests: R27, R31, R32; shared phone allowed; phone normalisation; isolation.

### Slice 6 — Students, enrolment, admission (≈ 6 days)

Schema:
- `students`: `admission_no` (`UNIQUE (school_id, admission_no)`, `S-000123`, taken by `UPDATE
  schools SET last_admission_no = last_admission_no + 1 … RETURNING` inside the admission
  transaction), `full_name`, `gender`, `date_of_birth`, `b_form` encrypted + `b_form_hash`
  nullable, `status` (`active|suspended|withdrawn|transferred|alumni`), `admitted_on`, `photo_key`
  nullable, `merged_into_id` nullable, `notes`. Partial unique `(school_id, b_form_hash) WHERE
  b_form_hash IS NOT NULL`. `users.student_id` FK and the `num_nonnulls` CHECK added.
- `student_status_changes`: `student_id`, `from_status`, `to_status`, `reason`, `changed_by`,
  `effective_on`.
- `student_guardians`: `student_id`, `guardian_id`, `relationship` (`father|mother|guardian|
  other`), `is_primary_contact`, `is_fee_payer`, `can_login`. `UNIQUE (school_id, student_id,
  guardian_id)`. **Partial unique `(school_id, student_id) WHERE is_primary_contact`.**
- `enrolments` (rule 6): `student_id`, `academic_year_id`, `class_id`, `section_id`, `roll_no`
  nullable, `status` (`active|completed|left`), `started_on`, `ended_on`. Composite FK
  `(school_id, class_id, academic_year_id)`. Partial uniques `(school_id, student_id) WHERE status
  = 'active'` and `(school_id, section_id, roll_no) WHERE roll_no IS NOT NULL AND status =
  'active'`.
- `student_documents`: `student_id`, `type` (`b_form|photo|previous_school_leaving|guardian_cnic|
  other`), `object_key`, `mime`, `size_bytes`, `status` (`uploaded|verified|rejected`),
  `verified_by` nullable, `rejection_reason` nullable. **Upload and view only**; no verify screen.
- `staged_uploads`: `uploaded_by`, `object_key`, `mime`, `size_bytes`, `expires_at`.
- `idempotency_keys`: `key`, `user_id`, `response jsonb`, `created_at`. `UNIQUE (school_id, key)`
  — a database constraint, not a cache entry.

Uploads: `POST /uploads` (multipart, 5 MB cap in multer memory storage) → sniff with `file-type`
(allow `image/jpeg`, `image/png`, `application/pdf` only) → images re-encoded with `sharp`
(strips EXIF) → stored at `staged/{schoolId}/{ulid}.{ext}` → returns a staged id. On admission
commit, an after-commit step moves objects to `{schoolId}/students/{studentId}/{ulid}.{ext}`. A
daily `@nestjs/schedule` job (exception 3: list schools, then per school) deletes expired staged
rows and objects. **Download: `GET /documents/:id/content`, streamed by the API after
`can(document.view, document)`**, with `Content-Disposition: attachment`, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox`. The bucket is never reachable from a browser and no
presigned URL is ever issued.

Admission: one endpoint `POST /admissions` taking the whole wizard payload plus an
`Idempotency-Key` header; supporting lookups `POST /students/search-bform`, `POST
/guardians/search`. The wizard screen:
1. **Student lookup first** by B-Form: a hit on `withdrawn|transferred|alumni` offers **readmit**
   (`POST /students/:id/readmit`); a hit on `active|suspended` stops with a link. Then details.
2. **Guardian match — cannot be skipped**: CNIC then phone; shows "Ahmed Khan — father of Ali,
   Class 5 — link?"; several phone hits are all shown; merged records resolve to the survivor.
   Link or create. One primary contact (must have a phone), at least one fee payer. The page
   keeps `guardianId` only, never the digits.
3. Class and section (the class row implies the year).
4. Documents, optional (staged uploads).
5. Review → submit. Server creates everything in one transaction, `status = active`, status row,
   audit row. Then offers "Issue guardian login" and, where the school and class allow, "Issue
   student login" (username = B-Form digits; never links to an existing user).
Name + DOB + primary guardian matching an existing student is a **warning** in the response the
UI must confirm, not a block.

Other endpoints: `GET /students` (teacher-scoped in the query), `GET|PATCH /students/:id`,
`POST /students/:id/status`, `POST /students/:id/guardians`, `PATCH /student-guardians/:id`,
`POST /enrolments/:id/change-section`, `POST /enrolments/:id/roll-number`,
`POST /students/:id/change-class`. Screens: students list, student detail (details, guardians,
enrolment history, documents, status history), the admission wizard.

Tests: R25–R44; atomicity (a forced failure at the last insert leaves nothing, including no moved
files); two concurrent admissions get consecutive numbers; SVG and HTML uploads refused; EXIF
stripped; a document id from school A is `404` for school B; isolation per table. Playwright:
full admission with guardian match; readmission.

### Slice 7 — Custom roles, grants, the permissions screen (≈ 4 days)

Schema: `custom_roles` (`key`, `name`, `status` `active|archived`; partial unique on active key),
`custom_role_capabilities` (`custom_role_id`, `capability_key`), `user_capability_grants`
(`user_id`, `capability_key`, `effect` `grant|revoke`, `granted_by`, `reason`, `revoked_at`,
`revoked_by`). Append-only. No expiry in Phase 1. `user_roles.custom_role_id` FK added.

Logic: `EffectivePermissions` =
`(∪ defaults of roles whose capacity is active) − active revoke rows ∪ active grant rows` (R50),
computed once per request. Staff roles count only while `staff.status = active`; parent only
while `guardian_id` is set; student only while `student_id` is set. Parents and students: fixed
closed sets, no grant rows.

Endpoints: custom role CRUD (no delete while held), `GET /users/:id/permissions` (defaults,
deltas, effective set with the source of each line), `POST /users/:id/grants`, `POST
/grants/:id/end`, `POST /users/:id/roles`, `DELETE /users/:id/roles/:roleRef`. All gated by
`role.manage` except custom-role read.
Screens: custom roles (checklist excludes `role.manage`; only capabilities the creator holds are
tickable), **staff member permissions** — three columns: role defaults, deltas with who/why/when,
effective list with sources.

Tests: R45–R59; unit-test `EffectivePermissions` exhaustively (it is pure); the screen's
effective list equals the service's output. Playwright: principal grants `payment.verify` to an
office user, the user's `/me` shows it, principal ends it, it is gone.

### Slice 8 — Phase close (≈ 1.5 days)

- Audit coverage check against R57; grep `audit_log.metadata` and the captured logs for 13-digit
  runs after a full suite run (R16).
- `docs-maintainer` sweep; `README.md` verified by following it on a clean clone.
- `security-reviewer` on the whole phase — it is **the** tenant-isolation control now, not a
  second opinion (`CLAUDE.md`). `performance-engineer` on the students list and the admission
  searches only. `code-quality` on the web app for duplicated components.
- `phase-gate` on the Definition of Done. `WORKLOG.md` updated with what Phase 2 inherits.

---

## 5. Open items that Phase 1 must not pre-empt

| Register item | Phase 1 stance |
|---|---|
| 7–10 partial payment, sibling discount, concession scope, proration | No money tables. |
| 11 exit states | Status rows exist (R36); no financial consequence. |
| 12 staff leave | No leave tables. A covering teacher would be a dated `teacher_assignments` row; do not build it. |
| 13 grace and retention | `suspended` = read-only. No day or month arithmetic anywhere. |
| 21–26 | Untouched. |
| Document verification | Columns exist; no verify screen; gates nothing. |
| CNIC correction after a login exists | Refused (R24); flagged to the owner. |
| Numeric reset code versus emailed link | Link in Phase 1; a code is a small change if the owner insists. |

---

## 6. Capability registry (51 keys) and system-role defaults

Names are fixed now; later phases add screens, not keys. `noun.verb[.qualifier]`, lower-case.
They live in `packages/shared` as an enum with a group, and `SYSTEM_ROLE_DEFAULTS` holds this table.

| Group | Keys | Principal | Office staff | Teacher |
|---|---|---|---|---|
| Setup (7) | `school.settings.manage` `academic_year.manage` `class.manage` `section.manage` `subject.manage` `fee_head.manage` `holiday.manage` | all | — | — |
| Access (2) | `user.account.manage` `role.manage`* | both | `user.account.manage` | — |
| Students (5) | `student.view` `student.create` `student.update` `student.status.change` `enrolment.manage` | all | all | `student.view` (own classes) |
| Guardians (1) | `guardian.manage` | yes | yes | — |
| Documents (3) | `document.view` `document.upload` `document.verify` | all | `document.view` `document.upload` | — |
| Staff (6) | `staff.view` `staff.create` `staff.update` `staff.contract.manage` `staff.status.change` `staff.leave.approve` | all | `staff.view` | — |
| Payroll (2) | `payroll.view` `payroll.run` | both | — | — |
| Attendance (3) | `attendance.student.mark` `attendance.student.view_all` `attendance.staff.manage` | all | `attendance.student.view_all` | `attendance.student.mark` (own classes) |
| Academics (9) | `assessment.define` `marks.enter` `marks.view_all` `result.approve` `result.publish` `diary.write` `remark.write` `timetable.manage` `certificate.issue` | all | `certificate.issue` | `marks.enter` `diary.write` `remark.write` (own classes) |
| Finance (11) | `charge.create` `charge.campaign.send` `concession.grant` `payment.record` `payment.verify` `payment.void` `collection.handover.confirm` `expense.record` `expense.approve` `finance.report.view` `fee.statement.view` | all | `charge.create` `payment.record` `fee.statement.view` `expense.record` — **not** `payment.verify`, `concession.grant`, `finance.report.view` | — |
| Comms (2) | `announcement.send.scope` `announcement.send.school` | both | `announcement.send.scope` | `announcement.send.scope` (own classes) |

\* `role.manage` is the principal's by default and **can never appear in a grant row or a custom
role**. Parent and student sets are fixed in code. Platform admins are not school users and hold
no capabilities; the platform module is gated by its own session.

---

## 7. Numbered rules (each is a test)

**Login, password, reset (slice 2)**
- R1 Login requires a school code; a username present in two schools is never resolved to "the
  first match".
- R2 Forgot-password takes school code + digits, never an email, and always returns the same
  response.
- R3 A reset link is sent only to a verified email on an `active` user.
- R4 Office reset keeps `email` and `email_verified_at`, notifies that email, sets
  `password_is_default`, clears the lockout.
- R5 Office reset revokes all of the target's sessions and voids outstanding reset tokens.
- R6 Office reset never changes `status`; a disabled user stays disabled.
- R7 Changing a verified email nulls `email_verified_at`; password change is blocked until
  re-verified.
- R8 The same email on two users in a school is allowed.
- R9 Disabling a user revokes their sessions immediately; their next request is `401`.
- R10 A user may not disable or office-reset their own account.
- R11 After 5 failures the username is locked for 15 minutes; every failure response is identical
  in status, body and headers.
- R12 Office reset of a principal-role holder requires the actor to hold `role.manage`.
- R13 Assigning a role whose defaults exceed the actor's effective set requires `role.manage`.
- R14 The target's effective set after any reset or role change must be a subset of the actor's,
  unless the actor holds `role.manage`.
- R15 A school always has at least one `active` principal; disabling the last is refused.
- R16 No 13-digit string appears in any log line, URL, audit row, list response or web bundle
  after a full test run.

**Staff (slice 4)**
- R17 `staff.status = left` removes staff roles, ends active grants ("staff left"), ends active
  assignments, revokes sessions; the user is `disabled` only if no guardian or student capacity
  remains.
- R18 `suspended` behaves as R17 for login and effective capabilities, but assignments and grants
  are kept inert and return on reactivation.
- R19 Re-hire re-enables login only if the user is otherwise disabled; grants are not restored.
- R20 A second staff row for a CNIC already in the school (any status) is refused with a pointer
  to the existing row.
- R21 "Issue login" is refused for `suspended`/`left` staff, when CNIC is missing, and when a
  login already exists for the row.
- R22 Issue login links an existing user with the same `username_hash` (teacher-parent) instead
  of creating a second user.
- R23 One current class teacher per section; reassignment ends the old row and inserts a new one
  in one transaction.
- R24 CNIC edit is refused once a login exists.

**Admission and students (slice 6)**
- R25 Same B-Form in one school is refused with a link to the existing student; the same digits
  in two schools is allowed.
- R26 A B-Form hit on `withdrawn|transferred|alumni` offers readmission; a new student is never
  created for them.
- R27 A guardian with neither CNIC nor phone may be recorded but cannot be issued a login and
  cannot be found by the match step.
- R28 Exactly one primary contact per student, enforced by the database.
- R29 At least one fee payer per student.
- R30 A guardian with no phone cannot be primary contact.
- R31 A match hit whose `merged_into_id` is set resolves to the survivor.
- R32 A phone search returning several guardians returns all; the office picks.
- R33 `POST /admissions` requires an `Idempotency-Key`; a repeat with the same key returns the
  first response and writes nothing; two racing submits produce one student.
- R34 Admission numbers are consecutive under concurrency and have no gaps after a rollback.
- R35 Admission creates student, guardian links and enrolment as `active` in one transaction; any
  failure leaves no row and no stored file.
- R36 Status transitions: `active → suspended|withdrawn|transferred`; `suspended → active`;
  `withdrawn|transferred → active` only via readmission; `active → alumni` only at year end
  (Phase 4). Anything else, including repeating the current status, is refused.
  `withdrawn|transferred` close the active enrolment; `suspended` does not.
- R37 Roll numbers are unique per section among `active` enrolments only; a section change clears
  `roll_no`.
- R38 A move to a class in another academic year is refused in Phase 1.
- R39 Moving class in-year closes the old enrolment and opens a new one; never an edit.
- R40 "Issue student login" never links to an existing user; a B-Form colliding with a CNIC
  username is refused.
- R41 Staged files are unreachable and are removed if the admission does not commit.
- R42 Uploads are accepted only by sniffed type (`jpeg`, `png`, `pdf`), ≤ 5 MB, images re-encoded,
  stored under a ULID name.
- R43 Document content is served only to a session holding `document.view` on that document; a
  user of another school gets `404`.
- R44 Closing an academic year is refused while any enrolment in it is `active`.

**Permissions (slices 2, 4, 7)**
- R45 `role.manage` cannot appear in a grant row or a custom role.
- R46 Nobody grants or revokes a capability they do not hold.
- R47 Nobody grants or revokes on themselves, including the principal.
- R48 Grants and revokes targeting a `role.manage` holder require `role.manage`.
- R49 Grants to users whose staff record is not `active`, or who hold only parent/student roles,
  are refused.
- R50 Effective = role defaults − active revokes ∪ active grants. A revoke row removes a default
  only; a grant ends solely by `revoked_at`; an active grant and an active revoke on the same key
  → grant wins; ending a grant twice is a no-op.
- R51 A grantor later losing a capability does not cascade to grants they made.
- R52 Custom roles may not contain `role.manage`; every capability in one must be held by its
  creator; a custom role held by any user cannot be archived.
- R53 Teacher scope is evaluated against assignments active today; history follows the section,
  not the person.
- R54 A `subject_teacher` row with no section scopes every section of the class.
- R55 Office staff get `403` on every permissions endpoint and do not see the screen.
- R56 Platform sessions are refused on school endpoints and school sessions on platform endpoints.
- R57 Every grant, revoke, role assignment, office reset, disable and status change writes an
  audit row with actor, target and reason.
- R58 The effective-permissions screen shows exactly what `EffectivePermissions` computes.
- R59 A user whose `staff.status` is not `active` has no staff capability regardless of stored
  rows.

**Guardrails (slice 0 and 2)**
- R60 Every Prisma model outside the allowlist has a required `schoolId`, a `(schoolId, id)`
  unique, and composite tenant relations (schema guard test).
- R61 Importing Prisma outside `src/repositories/**` fails lint; so does importing a platform
  repository outside the platform module and the named exception sites.
- R62 Every tenant table has an isolation test: written as school A, invisible and unwritable as
  school B, through the API.
- R63 A request body or query carrying `schoolId` is rejected `422`.
- R64 Session tokens are stored only as hashes; a revoked or expired session is `401` on its next
  request.
- R65 A cookie-authenticated non-GET request with a foreign or missing `Origin` is refused.
- R66 Every `id` / `*Id` in every response is a string.
- R67 Every list endpoint is paginated; `limit` above 50 is refused.
- R68 Every error response uses the envelope with a code from `packages/shared`; a route with no
  capability decorator fails the test suite.

---

## 8. Definition of done for the phase

All of `CLAUDE.md`'s Definition of Done, read literally, plus:

- A fresh clone with Docker and Node follows `README.md` to a logged-in principal in under
  15 minutes.
- R1–R68 each have a named test, and CI runs them.
- The schema guard and the lint boundary are red on a planted violation.
- No CNIC, B-Form, password or token in any log, URL, audit row or list response.
- Every screen has loading, empty, error and no-permission states, and works at 1280 px and at
  tablet width.
- `WORKLOG.md` says what Phase 2 inherits and what was deferred, with register numbers.

---

## 9. What Phase 2 will need from Phase 1 (so do not paint over it)

- `classes.attendance_mode` and rule 14 — Phase 2 writes `attendance` with `UNIQUE (school_id,
  enrolment_id, date, period)`.
- `guardians.contact_capability` (rule 17) — every routing rule reads it.
- Dated `teacher_assignments` as the only scope source — the mobile app's "my classes".
- Bearer-token sessions already accepted by the API — React Native logs in with the same
  `POST /auth/login`.
- BullMQ and a worker process arrive in Phase 2 with messaging; job payloads carry a `schoolId`
  that the tenancy module validates into a `SchoolId`.
- The capability keys for attendance, diary and announcements already exist in the enum.
