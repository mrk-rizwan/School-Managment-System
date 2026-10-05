# Phase 1 — Foundation: build plan (TypeScript stack)

> **Complete (closed 2026-10-03). Superseded in part by Phase 2** (`phase-2-daily-operations.md`):
> R37 → R174 (a section change closes the old enrolment and opens a new one; `section_id` is never
> edited, a closed enrolment keeps its roll number); R80 lifted (a suspended school is not
> read-only; only `terminated` is refused); the §7 defaults gave office staff
> `attendance.student.mark` (all scope). Where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins.

**Audience:** the Opus 5.5 session that writes the code. Self-contained; read `CLAUDE.md` and
`docs/WORKLOG.md` first, then this file top to bottom before touching anything.
**Author:** Fable 5.1, 2026-10-02. **Replaces** the Laravel/Filament plan of 2026-10-01 (git
`29bbd13`), whose requirements, slice order and numbered rules were carried over.
**Reviewed** by `data-architect` (who verified the Prisma claims on 7.10.0 against PostgreSQL 16),
`security-reviewer`, `api-designer` and `business-rules`; their findings are folded in.
**Stack:** NestJS · PostgreSQL + Prisma · Next.js · Redis. Tenant isolation is application-layer
(`CLAUDE.md`, "How tenant isolation is implemented"). **Status:** approved for execution.

Phase 1 delivers what the client deck calls *Foundation*: **students, staff, classes, credentials
and permissions**, on top of the tenancy and session plumbing every later phase stands on. Nothing
financial, no attendance, no mobile app. At the end a school can be created by the platform, its
principal can log in, define sessions, classes and sections, register staff, admit students with
their guardians, issue logins, and control who may do what.

**Size, stated honestly.** The Laravel plan was about 17 working days because Filament generated
the admin screens. Here every screen and endpoint is written and the isolation guardrails are
built by hand, so this plan is about **30 working days**. The extra is UI, API surface and
guardrails, not new requirements.

---

## 0. Rules that bind every task

1. The settled rules in `CLAUDE.md` (1–17), its tenancy section and its conventions table are not
   revisited here. If a task below seems to conflict with one, `CLAUDE.md` wins and the task is
   wrong — say so in `WORKLOG.md`.
2. **Every slice ends with**: lint, typecheck and tests passing (run them, paste the summary),
   `security-reviewer` and `code-auditor` run with findings closed, `phase-gate` PASS. A slice is
   not done on a claim.
3. **Tenant isolation test for every table**, written with the table, not after.
4. **Inspect before creating.** NestJS, Prisma and the packages in §2 already do validation,
   guards, throttling, hashing, mail, scheduling. Do not hand-roll them.
5. **Minimal.** No abstraction with one caller, no pass-through wrappers. The repository layer is
   the one mandated layer; do not add a second above it.
6. **Each slice is a vertical cut**: schema → repository → service → controller → web screen →
   tests. An API without its screen is not done.
7. **Update `docs/WORKLOG.md`** at the end of every slice and whenever a decision here turns out
   wrong. The next session may be a different model.
8. Commit per slice. Never `--no-verify`.
9. **The numbered rules in §8 are test names.** Each gets at least one test whose name carries
   the rule number.
10. Each slice's **authorisation table** (endpoint → capability → subject rule) in §5 is binding.
    An endpoint not in a table does not get built until it is added to one. `api-designer` expands
    a slice's endpoints into full contracts before controllers are written; `data-architect`
    reviews its Prisma models and raw SQL before the migration is generated.

---

## 1. Shape of the system after Phase 1

```
asms/
  apps/api/                      NestJS
    prisma/schema.prisma, migrations/
    src/
      main.ts, app.module.ts
      common/          error envelope, pagination, validation config, crypto, logging
      tenancy/         SchoolId and Scope brands, request context (CLS), session resolution
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
    components/, lib/api/ (two generated clients: school, platform)
  packages/shared/               Capability enum, system-role defaults, error codes
  docker-compose.yml             postgres, redis, mailpit, minio
```

Two sessions, two cookies, two login pages: `/login` for school users, `/platform/login` for
platform admins. Parent and student accounts exist in the same `users` table and can
authenticate, but hold no capabilities and have no screens until Phase 2.

The web app talks to the API on the **same origin**: Next.js rewrites `/api/*` to the Nest
process, so the session cookie is first-party and there is no CORS configuration. Consequences
that must be handled, not assumed: the API listens on loopback or a private network only;
`trust proxy` is set to exactly one hop so client IPs are real and a spoofed `X-Forwarded-For`
from outside is ignored (test it). **School and platform pages never fetch the API from the
server side and never use Next's data cache** — every data call is made by the browser with the
user's cookie, so one tenant's data cannot be cached and served to another. Next middleware is a
redirect convenience, never an authorisation gate.

---

## 2. Stack, versions, environment

| Item | Decision |
|---|---|
| Node | 24 LTS on the host (`.nvmrc`, `engines`). pnpm workspaces, lockfile committed. |
| Versions | NestJS 12.x, **Prisma 7.10.x** (npm's `latest` tag currently points at an 8.0 release candidate — do not install it), Next.js 16.x, React 19.x, TypeScript at the newest version all three accept. **Pin exact versions on day one and record them in `WORKLOG.md`.** Prisma preview feature `partialIndexes` stays **off**: with it on, the next migration drops every hand-written partial index. Re-check on any Prisma upgrade. |
| Database | PostgreSQL 16 in Docker, extension `btree_gist`. One runtime role. No SQLite anywhere, including tests. |
| Dev services | `docker compose up`: `postgres`, `redis` (`maxmemory-policy noeviction`), `mailpit`, `minio`. No literal passwords in the compose file (`${VAR:?}` from `.env`); every port published on `127.0.0.1` only. Node runs on the host. |
| API packages | `@nestjs/*` core, `@nestjs/throttler` with Redis storage, `@nestjs/schedule`, `@nestjs/swagger` (with its CLI plugin and `classValidatorShim`), `nestjs-cls` + `@nestjs-cls/transactional` + its Prisma adapter, `class-validator` / `class-transformer`, `argon2`, `otplib`, `nodemailer`, `nestjs-pino`, `@aws-sdk/client-s3`, `multer`, `file-type`, `sharp`, `ulid`. |
| Web packages | Tailwind, shadcn/ui, `@tanstack/react-query` (no persister), `@tanstack/react-table`, `react-hook-form`, `zod` (form-level only), `openapi-typescript` + `openapi-fetch`. |
| Not in Phase 1 | No BullMQ and no worker process (mail is sent in-process after commit, three attempts with backoff). No JWT library. No state library beyond TanStack Query. Swagger UI off in production. Anything else: justify in `WORKLOG.md` first. |
| Tests | API: Jest + supertest, **end-to-end against the real Postgres**, plus unit tests for pure logic. Web: Playwright for the flows named in each slice. |
| CI | GitHub Actions on every push: `pnpm install --frozen-lockfile`, `prisma generate` (explicit — `migrate` does not do it), lint, typecheck, `prisma migrate deploy` against a service Postgres, API tests, OpenAPI client staleness check, web build, Playwright. Red CI blocks the slice. |
| Secrets | `.env` only; `.env.example` committed with every key and no values: `DATABASE_URL`, `REDIS_URL`, `IDENTITY_HASH_KEY`, `FIELD_ENCRYPTION_KEYS` (a keyring, `k1:<base64>`), `PASSWORD_PEPPER`, `S3_*`, `SMTP_*`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `APP_URL`. The API refuses to start if any is missing. |

---

## 3. Cross-cutting conventions (built in slice 0, used by every slice)

### 3.1 Tenancy

`SchoolId` is a branded `bigint`. Its **only** constructors live in `src/tenancy/` and are exactly:
from a resolved session; from `SchoolLookupRepository.findByCode`; `SchoolId.fromPlatformSchool`
(importable only inside `modules/platform`, for the one operation in §5 slice 2); and the
scheduler fan-out, which returns `SchoolId[]`. Lint bans `as SchoolId` and `any` in `apps/api`.

A request context (`nestjs-cls`) holds `{ schoolId, userId, sessionId }` after session
resolution. Services read it; **repositories never do** — `schoolId` is always the explicit first
argument, so a repository call cannot compile without one.

### 3.2 Repositories and the query guard

One class per aggregate in `src/repositories/`. Rules, all mechanical:

- First parameter `schoolId: SchoolId`; second, for anything student-linked, `scope: Scope` (§3.4).
- The Prisma client built there is wrapped in a **query guard** (`$extends` → `query.$allModels`)
  that inspects arguments only and throws if a tenant-model operation lacks a defined `schoolId`
  in its top-level `where` (or in `data` for creates), if any value in `where` is `undefined`
  (Prisma silently drops it and would return the school's first row), or if `findUnique*` is
  called on a tenant model. `update` / `delete` / `upsert` use the `schoolId_id` compound key.
  Enable Prisma's `strictUndefinedChecks` if the pinned version offers it.
- **Slice-0 verification of the guard:** an interactive-transaction test (row locked with `FOR
  UPDATE` in one statement is seen as locked by the next) run with the guard on, to prove an
  inspect-only extension does not split the transaction. If it does, the fallback is the same
  three checks in a `tenantWhere(schoolId, where)` helper that every repository must call, with a
  lint rule forbidding a model call whose `where` is not built by it. Record which in `WORKLOG.md`.
- Writes use **scalar foreign-key columns only** (`schoolId` + `xId`), never `connect`,
  `connectOrCreate`, `set` or `disconnect` — the composite foreign key then rejects a foreign id
  in the database. Prisma `P2003` on such a write maps to `422 REFERENCE_NOT_FOUND`. Lint bans the
  four relation-write keywords in `apps/api/src`.
- Every relation declares `onDelete: Restrict, onUpdate: Restrict`.
- `$queryRawUnsafe` / `$executeRawUnsafe` are banned by lint. Tagged `$queryRaw` is allowed only
  in files listed in the lint config, each with its own isolation test.
- Tenant code that reads the school's own row (status, name, settings) goes through
  `OwnSchoolRepository`, whose only predicate is `id = schoolId`.
- ESLint `no-restricted-imports`: Prisma only in `src/repositories/**`; `repositories/platform/**`
  only in `modules/platform/**` and the named exception sites. A fixture test proves the rule
  fires.

### 3.3 Transactions and concurrency

`@Transactional()` on the service method that is the unit of work. Interactive only. No
`Promise.all` inside one. Mail and object-storage calls run in an after-commit hook. Operations
that change a user's credentials, status or roles **lock the user row first** (`SELECT … FOR
UPDATE` through a repository method) and re-check under the lock (R99). Operations that could
remove the last principal lock the school's `school_settings` row (R73).

A unique-constraint failure aborts a Postgres transaction, so "insert, catch the conflict, read
the winner" cannot happen inside one. Where a rule depends on it (idempotency, R89; issue-login,
R77) the conflict is caught **outside** `@Transactional()` and the read is a fresh statement.

### 3.4 Authorisation and scope

`@RequireCapability(Capability.X)` on every controller method except auth. A global guard
refuses any route with neither that decorator nor an explicit `@Public()` /
`@AuthenticatedOnly()`. A route-enumeration test snapshots the list of `@Public` and
`@AuthenticatedOnly` routes; adding one is a reviewed change (R68).

`PermissionsService.can(user, capability)` returns either a refusal or a **`Scope`**, a branded
union `{ kind: 'all' } | { kind: 'sections', ids: bigint[] }` that nothing else can construct.
Repository methods over student-linked data (students, enrolments, guardian links, documents)
**require** it and apply it in the query. An empty `ids` list means no rows, never no filter.
Scope follows the capability's source: held via the teacher role default → that teacher's
assignments active today; held via principal or office-staff default, a custom role or a grant →
`all`; where both apply, the widest wins (R79).

Effective capabilities are computed from the database **on every request**, never cached in the
session, a token or the client (R69).

### 3.5 Sessions

`sessions`: `user_id`, `token_hash char(64) UNIQUE` (global — session resolution has no school
yet), `channel` (`cookie|bearer`), `created_at`, `last_seen_at`, `expires_at`, `revoked_at`,
`user_agent varchar(255)`, `ip inet`; index `(school_id, user_id)`.

- Token: 32 random bytes, base64url; only its SHA-256 is stored.
- Web: cookie `__Host-asms_session`, `httpOnly; Secure; SameSite=Lax; Path=/`; the token is
  **never returned in a JSON body** to a cookie client. Mobile (Phase 2): `Authorization: Bearer`.
  A token is accepted only on the channel it was minted for; a request carrying both is refused.
- Login always mints a fresh token and revokes any session presented with the request.
- Idle timeout 24 hours, absolute 30 days. `last_seen_at` written at most once per 5 minutes,
  outside the request's transaction.
- Every request: load by hash, refuse if revoked, expired, user not `active`, user has no active
  capacity (R71), or school `terminated`.
- **Suspended school = read-only**: every non-GET is `403 SCHOOL_SUSPENDED` except `/auth/*`,
  `/me/*`, user disable and office reset (R80).
- Cookie-authenticated non-GET requests must carry `Origin` equal to `APP_URL` (R65). No GET
  mutates (tested by enumerating routes).
- `Cache-Control: no-store` on every API response. The web app sends a CSP with
  `frame-ancestors 'none'`.
- The daily job deletes sessions that ended more than 90 days ago.

Platform sessions are a separate table and a separate cookie `__Host-asms_platform`; platform
controllers read only that cookie, school controllers only theirs, and the platform API accepts
no bearer token.

### 3.6 Identity numbers, passwords, encryption

- `cnic` / `b_form` columns hold `v1:<keyId>:<iv>:<tag>:<ciphertext>` — AES-256-GCM, a fresh
  12-byte random IV per encryption, 16-byte tag enforced on decrypt, **AAD =
  `schoolId|table|column`** so a ciphertext surfaced in the wrong tenant fails to decrypt. Keys
  come from the `FIELD_ENCRYPTION_KEYS` keyring; a `crypto:reencrypt` script rotates.
- `*_hash char(64)` = HMAC-SHA256 of the 13 digits with `IDENTITY_HASH_KEY`. Rotation recomputes
  hashes, including `users.username_hash`, from the linked person's decrypted number.
- Passwords: `argon2id(HMAC-SHA256(PASSWORD_PEPPER, password))`. The default password is a
  structured 13-digit number, so without the pepper a database dump would be brute-forceable back
  to the CNIC. Concurrent argon2 verifications are capped.
- Display is masked (`35201-*****-1`). CNIC and B-Form never appear in a URL, query string, log
  line, audit row, list response, OpenAPI example or browser storage. Lookups are `POST` with the
  digits in the body. List `q` filters refuse a 13-digit run with `422` pointing at the lookup.
- Free-text fields (`reason`, `notes`) are rejected if they contain an identity-number pattern,
  dashed (`\d{5}-\d{7}-\d`) or plain.

### 3.7 Logging and audit

`nestjs-pino` with `redact` on `req.headers.cookie`, `req.headers.authorization`, `*.password`,
`*.cnic`, `*.bForm`, `*.token`, plus a serializer replacing both identity-number patterns with
`[id]`. Request bodies are not logged. `ValidationPipe` runs with `validationError: { target:
false, value: false }` — by default it echoes the submitted DTO, CNIC and password included, into
the error.

`audit_log`: `actor_user_id` nullable, `actor_platform_user_id` nullable (`CHECK` exactly one),
`action varchar(64)`, `subject_type varchar(32)`, `subject_id`, `reason varchar(500)`, `metadata
jsonb`, `created_at`. Written by `AuditService.record()` **explicitly, inside the same
transaction** as the change. Append-only by a `BEFORE UPDATE OR DELETE` trigger that raises.
`CHECK (metadata::text !~ '[0-9]{13}')` and the same on `reason`; timestamps inside `metadata`
are ISO strings, never epoch milliseconds (which are 13 digits). Indexes `(school_id,
subject_type, subject_id, created_at)` and `(school_id, actor_user_id, created_at)`. Platform
actions go to `platform_audit_log`, which carries a nullable `school_id`.

### 3.8 Schema conventions

- Models `PascalCase`, tables and columns `snake_case` via `@@map` / `@map`. `timestamptz(3)`,
  `@db.Date` for academic dates. Text columns are bounded (`varchar(n)`).
- Ids `BigInt @id @default(autoincrement())` (Prisma emits `BIGSERIAL`). Every tenant model has
  `schoolId` required and `@@unique([schoolId, id])`; every relation between tenant models uses
  the composite `[schoolId, xId]`.
- Postgres does not index foreign keys and neither does Prisma: every foreign key gets an explicit
  `@@index`, `school_id` first.
- **Status and role columns are Prisma enums.** Adding a value is a normal migration. Removing or
  renaming one is hand-written: partial indexes and CHECKs that compare the column to a literal
  must be dropped and recreated around it.
- Partial unique indexes, `CHECK`s, the exclusion constraint and the audit trigger are raw SQL in
  a `--create-only` migration. **Every index and constraint is named explicitly**; names are
  stable identifiers, because Prisma 7's `P2002` no longer says which fields collided — the error
  mapper reads the constraint name (`meta.driverAdapterError.cause.constraint`) and maps it to an
  error code. A `CHECK` violation arrives as `P2039`.
- **One lifecycle mechanism per table.** People and record tables have a status or an end
  timestamp and no `deleted_at`. Config tables (`sections`, `subjects`) have `deleted_at`, and
  every unique index on them carries `WHERE deleted_at IS NULL`. **No HTTP `DELETE` exists
  anywhere in the API** (rule 4).
- Phones: `varchar(16)`, E.164, `CHECK (phone ~ '^\+[1-9][0-9]{7,14}$')`; one `normalisePhone()`
  defaults to `+92`.

### 3.9 API conventions

Base path `/api/v1` (school) and `/api/v1/platform`. Two OpenAPI documents and two generated
clients, so school and mobile bundles carry no platform types. v1 is additive only; a rename or
removal is v2.

- **Naming.** Plural kebab-case nouns. `PATCH /x/:id` is for plain attribute edits only. Anything
  with a reason, a state transition or a side effect is `POST /x/:id/<imperative-verb>`. List and
  create nest one level under the parent (`/students/:id/guardian-links`); a row is addressed flat
  by its own id (`/guardian-links/:id`). Identity lookups are `POST /x/lookup`, unpaginated, at
  most 20 hits.
- **Status.** Create → `201` with the resource; action → `200` with the updated resource; logout
  → `204`.
- **Errors.** One envelope: `{ "error": { "code", "message", "details", "requestId" } }`, codes
  from `packages/shared`. The exception filter is a bare `@Catch()` so no framework default body
  escapes it. Map: `400 MALFORMED_REQUEST` · `401 AUTH_REQUIRED` (no or dead session; `AUTH_FAILED`
  is login only) · `403 PERMISSION_DENIED | SCHOOL_SUSPENDED | ORIGIN_REJECTED` · `404 NOT_FOUND`
  (absent, in another tenant, or outside the caller's scope — identical body; a malformed path id
  too) · `409` every business refusal, each with its own code · `413` · `415` · `422
  VALIDATION_FAILED` (shape only; `details.fields: [{ path, code, message }]`; an id in a body
  that does not resolve in the tenant is `422` with `REFERENCE_NOT_FOUND` on that field) · `429
  RATE_LIMITED` with `Retry-After` · `503` when Redis is unreachable at login.
- **Validation.** Global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform`,
  and `enableImplicitConversion` **off**. Every handler declares a query DTO, even an empty one,
  so an unknown query parameter is refused. No DTO declares `schoolId`. JSON only; `POST /uploads`
  is the one multipart exception.
- **Lists.** `page` ≥ 1 (default 1), `limit` 1–50 (default 25); out of range is `422`, not
  clamped. Response `{ data, page, limit, total }`. Sort `?sort=fullName` or `?sort=-admittedOn`,
  one field from a per-endpoint allowlist, `id` as tiebreak. Filters are flat camelCase equality
  params; ranges `xFrom` / `xTo`; `q` needs at least 2 characters. Dropdowns use the list
  endpoints with `q` and `limit=50`; there are no separate "options" endpoints.
- **Formats.** Dates `YYYY-MM-DD`; datetimes UTC ISO-8601 with milliseconds and `Z`; keys
  camelCase; nullable fields always present as `null`; in `PATCH`, absent = unchanged, `null` =
  clear. Ids are strings matching `^[1-9][0-9]{0,18}$` in every response, param and body.
- **OpenAPI hygiene.** Controllers return response DTO classes, never Prisma types. Ids are
  `@ApiProperty({ type: String })`. `@ApiProperty({ nullable: true })` on every nullable field.
  `enum` + `enumName` on every enum. One `@ApiPaginated(Model)` and one `@ApiErrors()` decorator;
  a test fails any route without `@ApiErrors()`. `PartialType` comes from `@nestjs/swagger`. No
  `example` on identity, password or token fields. The document is generated by one script from
  the `tsc` build with sorted keys; CI fails if the committed clients are stale.

### 3.10 Web conventions

One `(school)` layout with a sidebar built from `GET /me`'s effective capabilities. Every list
screen has loading, empty, error and no-permission states; every form shows field errors from
`details.fields`. One table component, one form field set, one confirm-with-reason dialog —
reused everywhere. Wizard state lives in memory only, never `localStorage` (it holds identity
digits). The remembered school code is the only thing in `localStorage`.

---

## 4. Schema, complete for Phase 1

Every table below carries `school_id` and `UNIQUE (school_id, id)` unless marked *non-tenant*.
`data-architect` reviews the Prisma models and raw SQL of a slice before its migration is
generated.

**Non-tenant (slice 1):** `platform_users` (email, password_hash, totp_secret encrypted,
must_change_password, status) · `platform_sessions` · `platform_audit_log` (with nullable
`school_id`) · `school_groups` (name) · `schools`: `name`, `short_code` (`UNIQUE`, 3–12
lower-case ASCII letters/digits, **immutable after creation**), `status`
(`trial|active|suspended|terminated`), `school_group_id` nullable, `timezone` default
`Asia/Karachi`.

**Slice 1 (tenant):** `school_settings` (`UNIQUE (school_id)`): `fee_due_day` default 10 `CHECK
(BETWEEN 1 AND 28)`, `student_login_enabled` default false. `school_counters`: `name`, `value`;
`UNIQUE (school_id, name)` — holds the admission-number counter now and certificate numbers later.

**Slice 2:**
- `staff` (minimal): `full_name`, `cnic`, `cnic_hash` nullable, `phone`, `designation`,
  `joined_on`, `status` (`active|suspended|left`). Partial unique `(school_id, cnic_hash) WHERE
  cnic_hash IS NOT NULL`.
- `users`: `username_hash char(64)` (**no plaintext username**), `password_hash`, `email
  varchar(254)` nullable (not unique), `email_verified_at`, `password_is_default`,
  `password_changed_at`, `status` (`active|disabled`), `staff_id` / `guardian_id` / `student_id`
  nullable composite FKs, `last_login_at`. `UNIQUE (school_id, username_hash)`; `UNIQUE
  (school_id, staff_id)`, `(school_id, guardian_id)`, `(school_id, student_id)` (NULLs are
  distinct, so these also index the FKs and make "one login per person" a database fact). `CHECK
  (num_nonnulls(staff_id, guardian_id, student_id) >= 1)` — added in slice 6.
  **`status = disabled` is written only by the disable endpoint** (R71).
- `sessions` (§3.5). `user_tokens`: `user_id`, `purpose` (`password_reset|email_verify`),
  `token_hash`, `email varchar(254)` nullable (the address a verify token was issued for),
  `expires_at`, `used_at`. `UNIQUE (school_id, token_hash)`; index `(school_id, user_id,
  purpose)`. Consumed by one conditional update (`used_at IS NULL AND expires_at > now()`), never
  read-then-write.
- `user_roles`: `user_id`, `system_role` nullable (`principal|office_staff|teacher` — **parent
  and student are not rows**; they are derived from `users.guardian_id` / `student_id`),
  `custom_role_id` nullable, `assigned_by`, `assigned_at`, `ended_at`, `ended_by`. `CHECK
  (num_nonnulls(system_role, custom_role_id) = 1)`. Partial uniques `(school_id, user_id,
  system_role) WHERE system_role IS NOT NULL AND ended_at IS NULL` and the same for
  `custom_role_id`. Rows are ended, never deleted.
- `audit_log` (§3.7).

**Slice 3:** `academic_years`: `name`, `starts_on`, `ends_on`, `status`
(`planned|active|closed`), `CHECK (ends_on > starts_on)`. `classes` — **one row per class per
academic year; the year never changes once referenced**: `academic_year_id`, `name`, `sort_order`,
`attendance_mode` (`daily|period`), `status` (`active|archived`); `UNIQUE (school_id,
academic_year_id, name)`; `UNIQUE (school_id, id, academic_year_id)`. `sections`: `class_id`,
`name`, `capacity` nullable, `deleted_at`; partial unique `(school_id, class_id, name) WHERE
deleted_at IS NULL`; **`UNIQUE (school_id, id, class_id)`** so an enrolment can be tied to a
section *of its class*. `subjects`: `name`, `code` nullable, `deleted_at`; partial unique on name.

**Slice 4:** `teacher_assignments`: `staff_id`, `academic_year_id`, `class_id`, `section_id`
nullable, `subject_id` nullable, `role` (`class_teacher|subject_teacher`), `starts_on`, `ends_on`
nullable. FKs `(school_id, class_id, academic_year_id)` and `(school_id, section_id, class_id)`.
`CHECK (role <> 'class_teacher' OR section_id IS NOT NULL)`, `CHECK (role <> 'subject_teacher' OR
subject_id IS NOT NULL)`, `CHECK (ends_on IS NULL OR ends_on >= starts_on)`. **One class teacher
per section at any date**, by exclusion constraint:
`EXCLUDE USING gist (school_id WITH =, section_id WITH =, daterange(starts_on, ends_on, '[]')
WITH &&) WHERE (role = 'class_teacher')`. **Active means active today**: `starts_on <= today AND
(ends_on IS NULL OR ends_on >= today)`, in the school's timezone. Index `(school_id, staff_id)`.

**Slice 5:** `guardians`: `full_name`, `cnic`, `cnic_hash` nullable, `phone` nullable, `email`
nullable, `contact_capability` (`whatsapp|smartphone_data|keypad`, not null), `address
varchar(500)` nullable, `merged_into_id` nullable, `status` (`active|merged`). `CHECK ((status =
'merged') = (merged_into_id IS NOT NULL))`. Partial unique on `cnic_hash`; indexes `(school_id,
phone)`, `(school_id, merged_into_id)`. No uniqueness on phone.

**Slice 6:**
- `students`: `admission_no` (`UNIQUE (school_id, admission_no)`), `full_name`, `gender`,
  `date_of_birth`, `b_form`, `b_form_hash` nullable, `status`
  (`active|suspended|withdrawn|transferred|alumni`), `admitted_on`, `notes varchar(2000)`.
  Partial unique `(school_id, b_form_hash) WHERE b_form_hash IS NOT NULL`.
- `student_status_changes`: `student_id`, `from_status`, `to_status`, `reason`, `changed_by`,
  `effective_on`.
- `student_guardians`: `student_id`, `guardian_id`, `relationship`
  (`father|mother|guardian|other`), `is_primary_contact`, `is_fee_payer`, `can_login`, `ended_at`
  nullable. Partial uniques `(school_id, student_id, guardian_id) WHERE ended_at IS NULL` and
  **`(school_id, student_id) WHERE is_primary_contact AND ended_at IS NULL`**. Index `(school_id,
  guardian_id)`.
- `enrolments`: `student_id`, `academic_year_id`, `class_id`, `section_id`, `roll_no` nullable,
  `status` (`active|completed|left`), `started_on`, `ended_on`. FKs `(school_id, class_id,
  academic_year_id)` and `(school_id, section_id, class_id)`. Partial uniques `(school_id,
  student_id) WHERE status = 'active'` and `(school_id, section_id, roll_no) WHERE roll_no IS NOT
  NULL AND status = 'active'`. Indexes `(school_id, section_id, status)`, `(school_id,
  student_id)`, `(school_id, academic_year_id, status)`.
- `student_documents`: `student_id`, `type` (`b_form|photo|previous_school_leaving|guardian_cnic|
  other`), `object_key`, `mime`, `size_bytes`, `uploaded_by`. `UNIQUE (school_id, object_key)`.
  **A student's photo is their latest `photo` document** — there is no separate photo column, and
  staff photos are not in Phase 1. No verification columns until that workflow is specified.
- `staged_uploads`: `uploaded_by`, `object_key`, `mime`, `size_bytes`, `expires_at` (24 hours),
  `consumed_at`. `UNIQUE (school_id, object_key)`; `CHECK (size_bytes BETWEEN 1 AND 5242880)`;
  index `(school_id, expires_at)`.
- `idempotency_keys`: `user_id`, `endpoint varchar(64)`, `key varchar(64)`, `request_hash
  char(64)` (HMAC — the body holds identity digits), `response_status`, `subject_type`,
  `subject_id`, `created_at`. `UNIQUE (school_id, user_id, endpoint, key)`. **No stored response
  body**: a replay rebuilds the response by re-reading the subject. Never purged in Phase 1.

**Slice 7:** `custom_roles`: `key`, `name`, `status` (`active|archived`); partial unique on key
among active. `custom_role_capabilities`: `custom_role_id`, `capability_key varchar(64)`.
`user_capability_grants`: `user_id`, `capability_key`, `effect` (`grant|revoke`), `granted_by`,
`reason`, `revoked_at`, `revoked_by`; append-only; index `(school_id, user_id) WHERE revoked_at IS
NULL`. On both capability tables: `CHECK (capability_key <> 'role.manage')`. Unknown keys found
in the database are ignored on read (lookup through a `Map`, never object indexing).

---

## 5. Slice plan

Estimates are for orientation. Capability names are in §7.

### Slice 0 — Scaffold and guardrails (≈ 3.5 days)

**Goal:** an empty system in which the isolation guardrails are live and proven.

- 0.1 pnpm workspace, the three packages, Docker compose, `.env.example`, shared ESLint/Prettier,
  `README.md`. Confirm the pre-commit hook fires on a planted `.env`.
- 0.2 API skeleton: env validation at boot, the `@Catch()` envelope filter, `ValidationPipe` as
  §3.9, pino with redaction, `GET /health` (`@Public`), throttler on Redis, OpenAPI generation
  script, `trust proxy` = 1 with its test.
- 0.3 Prisma baseline (`schools` only), naming conventions, first migration reviewed as SQL.
- 0.4 Tenancy: `SchoolId`, `Scope`, CLS context, `@Transactional()` wiring, the query guard and
  its transaction-atomicity verification (§3.2), the ESLint boundaries with fixture tests.
- 0.5 **Schema guard test — reads the migrated database, not Prisma metadata** (Prisma 7's
  generated client does not expose it): every table outside the allowlist (`schools`,
  `school_groups`, `platform_users`, `platform_sessions`, `platform_audit_log`,
  `_prisma_migrations`) has `school_id bigint NOT NULL` and a unique index on exactly
  `(school_id, id)`; every foreign key between tenant tables includes `school_id` on both sides
  (`pg_constraint`); every foreign key has an index whose leading columns are the key's columns;
  every index leads with `school_id` except an allowlist (`sessions.token_hash`); no foreign key
  cascades or sets null; every `*_id` / `*_by` column on a tenant table is a foreign key; and a
  **named list** of expected partial indexes, CHECKs, the exclusion constraint and the trigger
  exists (`pg_get_indexdef`, `pg_get_constraintdef`). The list grows with each slice.
- 0.6 Isolation test helper and factories creating two schools. Tests never truncate — each
  creates its own schools, so tenancy isolates tests and they run in parallel.
- 0.7 Web skeleton: Tailwind, shadcn/ui, layout shell, generated clients, Query provider, the
  shared table / form / dialog components on a throwaway page, CSP header, one Playwright smoke.
- 0.8 CI green.

Acceptance: clone → `docker compose up` → `pnpm i` → `pnpm dev` shows a health page; a planted
Prisma import outside repositories, a query without `schoolId`, a `where` holding `undefined`, a
tenant-less table and a `connect` each fail CI.

### Slice 1 — Platform and the school record (≈ 2.5 days)

Platform login: email + password + **TOTP** (`otplib`); enrolment of the authenticator on first
login; the seeded admin has `must_change_password = true` and cannot do anything else until it is
changed. Platform non-GET requests get the same `Origin` check.

| Endpoint (under `/platform`) | Who | Subject rule |
|---|---|---|
| `POST /auth/login`, `/auth/logout`, `/auth/change-password`, `/auth/totp/enrol|confirm` | public / platform session | — |
| `GET /me` | platform session | — |
| `GET|POST /schools`, `GET|PATCH /schools/:id` | platform session | `shortCode` not patchable |
| `POST /schools/:id/change-status { status, reason }` | platform session | audited |

Creating a school also creates its `school_settings` row and its admission counter, in one
transaction. Screens: platform login with TOTP, schools list, create/edit, status dialog.

Tests: R56; status change audited; `fee_due_day` 29 refused; duplicate or edited `short_code`
refused; login throttled; TOTP required.

### Slice 2 — Staff (minimal), users, sessions, login (≈ 5 days)

**Goal:** a school user logs in with school code, CNIC digits and the default password; is
prompted to change it; can set a verified email and reset by it; the office can reset within the
limits of §8. The capability guard goes live here so every later slice is written against it.

`packages/shared` gets the `Capability` enum (51 keys), `SYSTEM_ROLE_DEFAULTS` and the error
codes. `PermissionsService` computes from system roles only for now.

| Endpoint | Capability | Subject rule |
|---|---|---|
| `POST /auth/login { schoolCode, username, password }` | public | generic `401 AUTH_FAILED` |
| `POST /auth/logout` | authenticated | revokes this session |
| `POST /auth/forgot-password { schoolCode, username }` | public | always `202`, same body |
| `POST /auth/reset-password { schoolCode, token, newPassword }` | public | token single-use, 15 min |
| `POST /auth/verify-email { schoolCode, token }` | public | bound to the issued address |
| `GET /me` | authenticated | user, school, roles, effective capabilities, `passwordIsDefault` |
| `POST /me/change-email { currentPassword, email }` | authenticated | nulls verification; mails a link |
| `POST /me/change-password { currentPassword, newPassword }` | authenticated | verified email required |
| `GET /users`, `GET /users/:id` | `user.account.manage` | filters `passwordIsDefault`, `hasEmail` |
| `POST /users/:id/reset-password { reason, clearEmail }` | `user.account.manage` | R10, R12, R14 |
| `POST /users/:id/disable|enable { reason }` | `user.account.manage` | R10, R12, R14, R72 |
| `GET|PATCH /school/settings` | `school.settings.manage` | — |
| `POST /platform/schools/:id/issue-principal-login { fullName, cnic, phone, reason? }` | platform session | see below |

Behaviour (rule 12):
- **Login.** School by `SchoolLookupRepository.findByCode`; user by `(schoolId, usernameHash)`;
  argon2 verify, with a dummy verify when the school or user is absent so timing matches. One
  `401 AUTH_FAILED` for wrong code, wrong user, wrong password, locked, disabled, no active
  capacity, terminated school.
- **Throttles.** 5/min per school-code+username+IP; **10/min per username across all schools**;
  30/min per IP; throttles answer `429` regardless of whether the account exists. Lockout: 5
  consecutive failures → 15 minutes, a Redis counter keyed on the **typed** school code and the
  username hash, so non-existent schools and users lock identically. A correct password during a
  lock is still `AUTH_FAILED` and does not clear it. **If Redis is unreachable, login is refused
  `503`**, never evaluated without the counter. A per-school failure counter above a threshold
  writes one `login_failure_spike` row to `platform_audit_log` per window — spraying many CNICs
  never trips a per-username lock.
- **Default password** = the 13 digits. `GET /me` exposes `passwordIsDefault`; the web shows a
  persistent banner. **Prompt, not force.**
- **Email and password changes** require the current password. `change-email` mails
  `APP_URL/verify-email/{shortCode}#token=…`; the page reads the **fragment**, shows a "Verify"
  button and POSTs the token in the body (mail scanners prefetch links, so verification never
  happens on GET), then `replaceState`s the fragment away; `Referrer-Policy: no-referrer`. A new
  verification request voids the previous token (R93). `change-password` needs a verified email,
  ≥ 8 characters, not the username digits; it revokes the user's other sessions and notifies the
  address.
- **Forgot password** never takes an email. It answers before any mail is sent, is throttled to
  3 per hour per school and username, and mails `APP_URL/reset/{shortCode}#token=…` only if the
  user is `active` with a verified email. Reset clears `password_is_default`, the lockout and all
  sessions.
- **Office reset**: default password, `password_is_default = true`, lockout cleared, all the
  target's sessions revoked, outstanding tokens voided, `status` untouched. The dialog shows the
  account's masked email and **requires the clerk to choose keep or clear** — an attacker who got
  in on the default password may have planted their own address. The target is notified if a
  verified email is kept. The **first login after an office reset is audited**.
- **Disable** revokes sessions and voids outstanding tokens at once.
- **Issue principal login** (platform): the one place a platform admin acts inside a school, via
  `SchoolId.fromPlatformSchool`. Creates `staff`, `users`, `user_roles → principal` in one
  transaction. **Refused while the school already has an active principal unless a reason is
  given**, in which case existing principals are notified. Written to both audit logs.

Screens: login (school code remembered), forgot, reset, verify-email, default-password banner,
change-email/password page, users list with reset and disable dialogs, school settings.

Tests: R1–R16, R61–R71, R80–R81, R93, R98–R100; same digits in two schools lands in the school
whose code was typed; a reset token from school A cannot reset the same digits in school B; no
identity pattern in the captured logs of the whole suite. Playwright: login → banner → set email
(link from mailpit) → verify → change password → banner gone.

### Slice 3 — Academic structure (≈ 2.5 days)

| Endpoint | Capability | Subject rule |
|---|---|---|
| `GET /academic-years`, `/classes`, `/classes/:id/sections`, `/subjects` and each `GET /…/:id` | any active staff role | reads are open to staff; writes need the key |
| `POST /academic-years`, `PATCH /academic-years/:id`, `POST /academic-years/:id/close` | `academic_year.manage` | R44 |
| `POST /classes`, `PATCH /classes/:id`, `POST /classes/:id/archive`, `POST /classes/:id/copy-sections` | `class.manage` | year immutable once referenced |
| `POST /classes/:id/sections`, `PATCH /sections/:id`, `POST /sections/:id/archive` | `section.manage` | not while an active enrolment references it |
| `POST /subjects`, `PATCH /subjects/:id`, `POST /subjects/:id/archive` | `subject.manage` | — |

Screens: one "Academic structure" area, four list/edit screens. Tests: isolation per table; year
dates; R44 as a `todo` test that slice 6 must make pass; class-year change refused once
referenced.

### Slice 4 — Staff (full), teacher assignments, system roles (≈ 3 days)

System-role assignment lives here, not in slice 7, so a staff login always has a stated role and
a re-hire can be given one back. The "a role counts only while its capacity is active" check also
goes live here (R59).

| Endpoint | Capability | Subject rule |
|---|---|---|
| `GET /staff` (filter `role=teacher`), `GET /staff/:id` | `staff.view` | masked CNIC |
| `POST /staff`, `PATCH /staff/:id` | `staff.create` / `staff.update` | R20, R24 |
| `POST /staff/:id/change-status { status, reason }` | `staff.status.change` | R14, R17–R19, R70, R72, R74 |
| `POST /staff/:id/issue-login { systemRole }` | `user.account.manage` | R13, R21, R22, R77 |
| `GET|POST /staff/:id/teacher-assignments`, `POST /teacher-assignments/:id/end` | `class.manage` | R23 |
| `POST /users/:id/roles { systemRole, reason }`, `POST /user-roles/:id/remove { reason }` | `role.manage` | R13, R72, R74 |

`ScopeService` resolves a teacher's section ids from assignments active today. Screens: staff
list, staff detail with assignments and roles tabs, status and issue-login dialogs.

Tests: R17–R24, R53, R54, R59, R70, R72–R74, R77; CNIC column is ciphertext; the exclusion
constraint refuses overlapping class teachers and allows sequential ones; isolation.

### Slice 5 — Guardians (≈ 1.5 days)

| Endpoint | Capability | Subject rule |
|---|---|---|
| `GET /guardians`, `GET /guardians/:id`, `GET /guardians/:id/students` | `guardian.manage` | masked CNIC |
| `POST /guardians`, `PATCH /guardians/:id` | `guardian.manage` | — |
| `POST /guardians/lookup { cnic?, phone? }` | `student.create` or `guardian.manage` | throttled per user (it is a CNIC existence oracle) |
| `POST /guardians/:id/issue-login` | `user.account.manage` | needs a CNIC and a live link with `can_login`; links to an existing user if the hash matches |

Screens: guardian list (flags "no CNIC", "no phone"), detail. Tests: R27, R31, R32; shared phone
allowed; phone normalisation; isolation.

### Slice 6 — Students, enrolment, admission (≈ 6.5 days)

| Endpoint | Capability | Subject rule |
|---|---|---|
| `GET /students`, `GET /students/:id` | `student.view` | **scoped**; out of scope is `404` |
| `GET /students/:id/guardian-links` | `student.view` (scoped) | teachers see name, relationship, phone only; masked CNIC and address need `guardian.manage` |
| `GET /students/:id/enrolments`, `/status-changes`, `/documents`, `/photo` | `student.view` / `document.view` (scoped) | — |
| `POST /students/lookup { bForm }` | `student.create` | throttled per user |
| `POST /admissions` + `Idempotency-Key` | `student.create` | this one key covers guardian create/link and the first enrolment |
| `POST /students/:id/readmit` | `student.create` | R26 |
| `PATCH /students/:id` | `student.update` | — |
| `POST /students/:id/change-status { status, reason, effectiveOn }` | `student.status.change` | R36 |
| `POST /students/:id/guardian-links`, `PATCH /guardian-links/:id`, `POST /guardian-links/:id/end` | `guardian.manage` | R28–R30 |
| `PATCH /enrolments/:id { rollNo }`, `POST /enrolments/:id/change-section`, `POST /enrolments/:id/change-class` | `enrolment.manage` | R37–R39 |
| `POST /students/:id/issue-login` | `user.account.manage` | R40; school setting must allow it |
| `POST /uploads` (multipart) | `document.upload` | staged id usable only by its uploader |
| `POST /students/:id/documents { stagedUploadId, type }` | `document.upload` | — |
| `GET /documents/:id/content` | `document.view` | the document's student must be in scope |

**Uploads.** Multer memory storage, 5 MB, `files: 1`, per-user throttle, bounded concurrency.
Sniff with `file-type`: `image/jpeg`, `image/png`, `application/pdf` only; `type = photo` must be
an image. Images are re-encoded with `sharp` (`limitInputPixels` ≈ 40 MP, `failOn: 'error'`,
first frame) — strips EXIF, including the GPS of a child's home. **Stored once**, at
`{schoolId}/{ulid}.{ext}` with `ext` from the sniffed type, in a private bucket with server-side
encryption, and recorded in `staged_uploads`. Committing a document inserts `student_documents`
with **the same key** and sets `consumed_at` — nothing is moved, so no failure can strand a
committed document. The daily job deletes only rows with `consumed_at IS NULL AND expires_at <
now()`, for every school including suspended and terminated ones. There is no GET for staged
content. **Download is streamed by the API** after the capability and scope check, with the key
asserted to start with `${schoolId}/`, `Content-Disposition: attachment`, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox`. No presigned URL is ever issued.

**Admission.** `POST /admissions` takes the whole wizard payload.
- `Idempotency-Key`: 16–64 characters of `[A-Za-z0-9_-]`, generated once when the wizard opens.
  The capability check runs before the key lookup. The key row is inserted as the first statement
  of the admission; a conflict is handled outside the transaction: same hash → replay the stored
  status with the re-read resource and `Idempotency-Replayed: true`; different hash, or a
  different user → `409 IDEMPOTENCY_KEY_REUSED`. **Only a committed admission stores the key**; a
  `422` or the duplicate warning consumes neither the key nor an admission number.
- **Possible duplicate** (name + date of birth + primary guardian match an existing student) is
  `409 ADMISSION_POSSIBLE_DUPLICATE` with `details.matches` and nothing written. The client
  resubmits with the same key plus `acknowledgedDuplicateStudentIds`; that field is excluded from
  the request hash. If the current match set holds an unacknowledged id, the warning returns
  again. A warning is never a 2xx.
- Admission number: `UPDATE school_counters SET value = value + 1 … RETURNING` inside the
  transaction — consecutive under concurrency, no gap on rollback.
- The server creates student, guardian links, enrolment, document rows, status row and audit row
  in one transaction, `status = active`.

The wizard screen: (1) **student lookup first** by B-Form — a hit on
`withdrawn|transferred|alumni` offers readmit, a hit on `active|suspended` stops with a link —
then details; (2) **guardian match, cannot be skipped** — CNIC then phone, "Ahmed Khan — father
of Ali, Class 5 — link?", several phone hits all shown, merged records resolve to the survivor,
one primary contact with a phone, at least one fee payer; the page keeps `guardianId`, never the
digits; (3) class and section; (4) documents, optional; (5) review and submit, then the
issue-login offers. If the session expires mid-wizard the submit is `401`, nothing is written,
the web re-authenticates in place and resubmits with the same key; staged uploads belong to the
user, not the session, so they survive.

Other screens: students list, student detail (details, guardians, enrolment history, documents,
status history).

Tests: R25–R44, R82–R92, R97; a forced failure at the last insert leaves nothing; SVG and HTML
uploads refused; EXIF stripped; a pixel-bomb PNG refused; a document id from school A is `404` for
school B; a teacher gets `404` on a student outside their sections on every student-linked
endpoint; isolation per table. Playwright: full admission with guardian match; readmission.

### Slice 7 — Custom roles, grants, the permissions screen (≈ 4 days)

`EffectivePermissions` =
`(∪ defaults of roles whose capacity is active) − active revoke rows ∪ active grant rows` (R50).
Parent and student effective sets are empty in Phase 1.

| Endpoint | Capability | Subject rule |
|---|---|---|
| `GET /custom-roles`, `GET /custom-roles/:id` | `user.account.manage` | read only; not covered by R55 |
| `POST /custom-roles`, `PATCH /custom-roles/:id`, `POST /custom-roles/:id/archive` | `role.manage` | R52, R94–R96 |
| `GET /users/:id/permissions` | `role.manage` | defaults, deltas, effective set with source and scope per line |
| `POST /users/:id/grants`, `POST /grants/:id/end` | `role.manage` | R45–R49, R51, R75 |
| `POST /users/:id/roles { customRoleId, reason }` | `role.manage` | R13 |

Screens: custom roles (checklist excludes `role.manage`; only capabilities the editor holds are
tickable), **staff member permissions** — three columns: role defaults, deltas with who/why/when,
effective list with sources and scope.

Tests: R45–R59, R75, R79, R94–R96, plus the grant clauses of R17–R19; exhaustive unit tests of
`EffectivePermissions` (it is pure). Playwright: principal grants `payment.verify` to an office
user, the user's `/me` shows it on the next request, principal ends it, it is gone.

### Slice 8 — Phase close (≈ 1.5 days)

- Audit coverage against R57; scan `audit_log`, `idempotency_keys` and captured logs for identity
  patterns after a full run (R16).
- `docs-maintainer` sweep; `README.md` verified on a clean clone.
- `security-reviewer` on the whole phase — it is **the** tenant-isolation control, not a second
  opinion. `performance-engineer` on the students list and the lookups only. `code-quality` on
  the web app for duplicated components.
- `phase-gate` on the Definition of Done. `WORKLOG.md` updated with what Phase 2 inherits.

---

## 6. Open items that Phase 1 must not pre-empt

| Item | Phase 1 stance |
|---|---|
| 7–10 partial payment, sibling discount, concession scope, proration | No money tables. |
| 11 exit states | Status rows exist (R36); no financial consequence. **Also undecided here:** whether a guardian whose children have all left keeps the parent capacity. Phase 1 treats a guardian with a `guardian_id` as having it. |
| 12 staff leave | No leave tables. A covering teacher would be a dated `teacher_assignments` row; do not build it. While a class teacher is away nobody but office and principal has that section in scope. |
| 13 grace and retention | `suspended` = read-only with the R80 exemptions. No day or month arithmetic. |
| 21–26 | Untouched. |
| 30 privileged capabilities on a default password | Register item 30, awaiting the owner. Not built. It is a one-line check in the capability guard if approved. |
| Document verification | Not built; no columns. |
| CNIC correction after a login exists | Refused (R24); flagged to the owner. |
| Numeric reset code versus emailed link | Link in Phase 1. |
| Audit log screen, session list screen | Not in Phase 1; an audit screen needs a 52nd capability, which is a decision. |

---

## 7. Capability registry (51 keys) and system-role defaults

Names are fixed now; later phases add screens, not keys. `noun.verb[.qualifier]`, lower-case, in
`packages/shared` as an enum with a group; `SYSTEM_ROLE_DEFAULTS` holds this table.

| Group | Keys | Principal | Office staff | Teacher |
|---|---|---|---|---|
| Setup (7) | `school.settings.manage` `academic_year.manage` `class.manage` `section.manage` `subject.manage` `fee_head.manage` `holiday.manage` | all | — | — |
| Access (2) | `user.account.manage` `role.manage`* | both | `user.account.manage` | — |
| Students (5) | `student.view` `student.create` `student.update` `student.status.change` `enrolment.manage` | all | all | `student.view` (own classes) |
| Guardians (1) | `guardian.manage` | yes | yes | — |
| Documents (3) | `document.view` `document.upload` `document.verify` | all | `document.view` `document.upload` | — |
| Staff (6) | `staff.view` `staff.create` `staff.update` `staff.contract.manage` `staff.status.change` `staff.leave.approve` | all | `staff.view` | — |
| Payroll (2) | `payroll.view` `payroll.run` | both | — | — |
| Attendance (3) | `attendance.student.mark` `attendance.student.view_all` `attendance.staff.manage` | all | `attendance.student.view_all`; `attendance.student.mark` (all, **added by Phase 2 §1.2**, owner 2026-10-03: the gate records arrivals) | `attendance.student.mark` (own classes) |
| Academics (9) | `assessment.define` `marks.enter` `marks.view_all` `result.approve` `result.publish` `diary.write` `remark.write` `timetable.manage` `certificate.issue` | all | `certificate.issue` | `marks.enter` `diary.write` `remark.write` (own classes) |
| Finance (11) | `charge.create` `charge.campaign.send` `concession.grant` `payment.record` `payment.verify` `payment.void` `collection.handover.confirm` `expense.record` `expense.approve` `finance.report.view` `fee.statement.view` | all | `charge.create` `payment.record` `fee.statement.view` `expense.record` — **not** `payment.verify`, `concession.grant`, `finance.report.view` | — |
| Comms (2) | `announcement.send.scope` `announcement.send.school` | both | `announcement.send.scope` | `announcement.send.scope` (own classes) |

\* `role.manage` is the principal's by default and **can never appear in a grant row, a revoke row
or a custom role**. Platform admins are not school users and hold no capabilities.

---

## 8. Numbered rules (each is a test)

**Login, password, reset**
- R1 Login requires a school code; a username present in two schools is never resolved to "the
  first match".
- R2 Forgot-password takes school code + digits, never an email, and always returns the same
  response.
- R3 A reset link is sent only to a verified email on an `active` user.
- R4 Office reset sets the default password and `password_is_default`, clears the lockout, and
  keeps or clears the email as the clerk explicitly chose; clearing voids outstanding tokens.
- R5 Office reset revokes all of the target's sessions and voids outstanding tokens.
- R6 Office reset never changes `status`; a disabled user stays disabled.
- R7 Changing an email nulls `email_verified_at`; password change is blocked until re-verified.
- R8 The same email on two users in a school is allowed.
- R9 Disabling a user revokes their sessions immediately; their next request is `401`.
- R10 A user may not disable, enable or office-reset their own account.
- R11 After 5 failures the username is locked for 15 minutes; every failure response is identical
  in status, body and headers; non-existent users and schools lock identically.
- R12 Reset, disable, enable and issue-login against a principal-role holder require the actor to
  hold `role.manage`.
- R13 Assigning a role whose defaults exceed the actor's effective set requires `role.manage`.
- R14 After any reset, disable, enable, issue-login, role change or staff status change, the
  target's effective set must be a subset of the actor's, unless the actor holds `role.manage`.
- R15 Superseded by R72.
- R16 No identity-number pattern (13 digits, or `#####-#######-#`) appears in any log line, URL,
  audit row, idempotency row, list response or web bundle after a full test run.

**Staff**
- R17 `staff.status = left` ends the user's staff roles, ends active grants ("staff left"), ends
  active assignments, and revokes all the user's sessions. It does not write `users.status`.
- R18 `suspended` behaves as R17 for sessions and effective capabilities, but roles, assignments
  and grants are kept inert and count again on reactivation.
- R19 Re-hire (`left → active`) restores nothing: new roles and grants must be assigned.
- R20 A second staff row for a CNIC already in the school (any status) is refused with a pointer
  to the existing row.
- R21 "Issue login" is refused for `suspended`/`left` staff, when CNIC is missing, and when a
  login already exists for the row.
- R22 Issue login links an existing user with the same `username_hash` (teacher-parent) instead
  of creating a second user.
- R23 One class teacher per section at any date (exclusion constraint); reassignment ends the old
  row and inserts the new one in one transaction.
- R24 CNIC edit is refused once a login exists.

**Admission and students**
- R25 Same B-Form in one school is refused with a link to the existing student; the same digits
  in two schools is allowed.
- R26 A B-Form hit on `withdrawn|transferred|alumni` offers readmission; a new student is never
  created for them.
- R27 A guardian with neither CNIC nor phone may be recorded but cannot be issued a login and
  cannot be found by lookup.
- R28 Exactly one primary contact per student among live links, enforced by the database.
- R29 At least one fee payer per student among live links.
- R30 A guardian with no phone cannot be primary contact.
- R31 A lookup hit whose `merged_into_id` is set resolves to the survivor.
- R32 A phone lookup returning several guardians returns all; the office picks.
- R33 `POST /admissions` requires an `Idempotency-Key`; a repeat with the same key and payload
  returns the first result and writes nothing.
- R34 Admission numbers are consecutive under concurrency and have no gaps after a rollback.
- R35 Admission creates student, guardian links, enrolment and document rows as one transaction;
  any failure leaves no row.
- R36 Status transitions: `active → suspended|withdrawn|transferred`; `suspended → active`;
  `withdrawn|transferred → active` only via readmission; `active → alumni` only at year end
  (Phase 4). Anything else, including repeating the current status, is refused.
  `withdrawn|transferred` close the active enrolment; `suspended` does not.
- R37 Roll numbers are unique per section among `active` enrolments; a section change clears
  `roll_no`.
- R38 A move to a class in another academic year is refused in Phase 1.
- R39 Moving class in-year closes the old enrolment and opens a new one; never an edit.
- R40 "Issue student login" never links to an existing user; a B-Form colliding with a CNIC
  username is refused.
- R41 Staged content has no read endpoint; an unconsumed staged upload is deleted after expiry.
- R42 Uploads are accepted only by sniffed type (`jpeg`, `png`, `pdf`), ≤ 5 MB, images re-encoded
  and pixel-bounded, stored under a ULID name.
- R43 Document content is served only to a session holding `document.view` with the document's
  student in scope; another school's user gets `404`.
- R44 Closing an academic year is refused while any enrolment in it is `active`.

**Permissions**
- R45 `role.manage` cannot appear in a grant row, a revoke row or a custom role (also a database
  `CHECK`).
- R46 Nobody grants or revokes a capability they do not hold.
- R47 Nobody grants or revokes on themselves.
- R48 Grants and revokes targeting a `role.manage` holder require `role.manage`.
- R49 Grants to users whose staff record is not `active`, or who have no staff capacity, are
  refused.
- R50 Effective = role defaults − active revokes ∪ active grants. A revoke row removes a default
  only; a grant ends solely by `revoked_at`; an active grant and an active revoke on the same key
  → grant wins; ending a grant twice is a no-op.
- R51 A grantor later losing a capability does not cascade to grants they made.
- R52 Custom roles may not contain `role.manage`; a custom role held by any user, including a
  suspended one, cannot be archived; archived roles contribute nothing.
- R53 Teacher scope is the set of assignments active today; history follows the section, not the
  person.
- R54 A `subject_teacher` row with no section scopes every section of the class.
- R55 Office staff get `403` on every permissions-write endpoint and on `GET
  /users/:id/permissions`, and do not see the screen.
- R56 Platform sessions are refused on school endpoints and school sessions on platform endpoints.
- R57 Every grant, revoke, role change, office reset, disable, enable, issue-login and status
  change writes an audit row with actor, target and reason.
- R58 The effective-permissions screen shows exactly what `EffectivePermissions` computes.
- R59 A user whose `staff.status` is not `active` has no staff capability regardless of stored
  rows.

**Guardrails**
- R60 Schema guard (slice 0.5) passes: tenant columns, composite keys, FK indexes, no cascades,
  the named constraint list.
- R61 Importing Prisma outside `src/repositories/**`, a platform repository outside its allowed
  sites, `connect`-style writes, raw-unsafe queries, `as SchoolId` and `any` each fail lint.
- R62 Every tenant table has an isolation test: written as school A, invisible and unwritable as
  school B, through the API.
- R63 A request body or query carrying `schoolId`, or any unknown field, is rejected `422`.
- R64 Session tokens are stored only as hashes; a revoked or expired session is `401` on its next
  request; a token is refused on the wrong channel.
- R65 A cookie-authenticated non-GET with a foreign or missing `Origin` is refused; no GET mutates.
- R66 Every `id` / `*Id` in every response and in the OpenAPI document is a string.
- R67 Every list endpoint is paginated; `limit` above 50 is `422`.
- R68 Every error uses the envelope with a shared code; every route has a capability decorator or
  is in the snapshot of `@Public` / `@AuthenticatedOnly` routes.
- R69 Capabilities are computed from the database on every request; a role removal, grant end or
  custom-role edit takes effect on the same session's next request.
- R70 Staff capacity ending (`left` or `suspended`) revokes every session of that user, cookie and
  bearer, even when a guardian capacity remains.
- R71 `users.status = disabled` is written only by the disable endpoint. A user with no active
  capacity is derived: login is `AUTH_FAILED` and session resolution refuses.
- R72 A school always has at least one user who is `active`, whose staff record is `active`, and
  who holds `principal`. Disable, principal-role removal and staff status `left|suspended` are
  each refused `LAST_PRINCIPAL` if they would break it.
- R73 Two principals removing each other concurrently, by any mix of paths: exactly one succeeds.
- R74 Nobody changes their own roles or their own staff status.
- R75 `role.manage` cannot appear in `user_capability_grants` with either effect.
- R76 The query guard throws on a tenant-model operation without a defined `schoolId`, on an
  `undefined` in `where`, and on `findUnique`.
- R77 Two racing issue-logins for one person create one user; the loser gets the R21 refusal, not
  `500`.
- R78 A parent-only or student-only session gets `403` on every route except `/auth/*` and
  `/me/*`, asserted by enumerating the router.
- R79 Scope follows the capability's source (§3.4); an empty section list returns no rows.
- R80 In a suspended school every non-GET is `403` except `/auth/*`, `/me/*`, user disable and
  office reset.
- R81 If Redis is unreachable, login is `503`. A correct password during a lock is `AUTH_FAILED`
  and does not clear the lock.
- R82 The stored idempotency row holds no identity digits and no response body.
- R83 Same key, same user, different payload → `409 IDEMPOTENCY_KEY_REUSED`, nothing written.
- R84 Same key from a different user in the same school is independent (the key is unique per
  user); a different school is independent.
- R85 The capability check runs before the key lookup; a replay by a user who lost
  `student.create` is `403`.
- R86 Idempotency keys are not purged in Phase 1.
- R87 Only a committed admission stores the key; a `422` or a duplicate warning stores nothing
  and consumes no admission number.
- R88 The duplicate warning is `409` with the matches; acknowledging uses the same key; an
  unacknowledged match returns the warning again.
- R89 Two racing same-key submits: the loser returns the winner's result, not `409` or `500`.
- R90 A committed document's object is never deleted by the sweep; the sweep deletes only
  unconsumed, expired staged uploads.
- R91 A staged id that is expired, already consumed or uploaded by another user is `422` on that
  field; nothing is written.
- R92 A mail failure never alters the response or the committed state; it is retried three times
  and then logged without identity data.
- R93 Re-requesting email verification issues a fresh token and voids the old one.
- R94 Adding a capability to a custom role requires the editing actor to hold it at edit time;
  existing keys are not re-checked; a creator later losing a capability does not cascade.
- R95 Removing a capability from a held custom role needs only `role.manage` and a reason; it
  applies to all holders on their next request; one audit row names the role, keys and holder
  count.
- R96 Archive racing assign never yields an archived role with a holder.
- R97 An expired session mid-wizard: the submit is `401` and writes nothing; staged uploads
  survive re-login by the same user; wizard state is never in `localStorage`.
- R98 `change-password` and `change-email` require the current password.
- R99 Office reset, disable, change-password and token reset each lock the user row and re-check
  under the lock. Whatever the interleaving with an office reset, the end state is the default
  password, `password_is_default = true` and zero live sessions.
- R100 Disable voids outstanding tokens, and token consumption re-checks `active`.
- R101 The API ignores a client-supplied `X-Forwarded-For` beyond the one trusted hop.
- R102 Platform login requires TOTP; the seeded admin must change its password first.
- R103 Issue-principal-login is refused while the school has an active principal unless a reason
  is given; it writes to both audit logs.
- R104 A ciphertext copied to another school's row, or another column, fails to decrypt.

---

## 9. Definition of done for the phase

All of `CLAUDE.md`'s Definition of Done, read literally, plus:

- A fresh clone with Docker and Node follows `README.md` to a logged-in principal in under
  15 minutes.
- R1–R104 (R15 excepted) each have a named test, and CI runs them.
- The schema guard, the lint boundaries and the query guard are each red on a planted violation.
- No identity number, password or token in any log, URL, audit row or list response.
- Every screen has loading, empty, error and no-permission states, and works at 1280 px and at
  tablet width.
- `WORKLOG.md` says what Phase 2 inherits and what was deferred, with register numbers.

---

## 10. What Phase 2 will need from Phase 1 (so do not paint over it)

- `classes.attendance_mode` and rule 14 — Phase 2 writes `attendance` with `UNIQUE (school_id,
  enrolment_id, date, period)`.
- `guardians.contact_capability` (rule 17) — every routing rule reads it.
- Dated `teacher_assignments` as the only scope source — the mobile app's "my classes".
- Bearer-channel sessions already accepted by the API — React Native logs in with the same
  `POST /auth/login`.
- BullMQ and a worker arrive in Phase 2 with messaging; job payloads carry a `schoolId` that the
  tenancy module validates into a `SchoolId`.
- The capability keys for attendance, diary and announcements already exist in the enum.
- `school_counters` is ready for certificate and receipt numbering.
