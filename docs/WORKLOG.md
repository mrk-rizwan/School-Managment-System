# ASMS work log — session handover

**Read this first in every session.** It is the single running record of what has been done,
what is in progress, and what is left. Any model (Fable, Opus, Sonnet) picking up this project
must update it before ending a session. Newest entry at the top. Dates are absolute.

Working arrangement: **Fable 5.1 does planning, review and the final build plan. Opus 5.5
writes the production code.** Do not start application code in a planning session.

---

## Current state (keep this section accurate)

- **Phase:** Phase 1, **slices 0, 1, 2, 3 and 5 done** (2026-10-03): scaffold and isolation
  guardrails; platform console and school record; school logins, sessions, users, settings;
  academic structure; guardians. **Next: wave B = slices 4 (staff, assignments) and 6 (students,
  enrolment, admission) in parallel.** Paused by the product owner after the wave-A commit, to
  resume about two hours later.
- **CI status unknown:** the auto-sync pushes to GitHub, but the repo is private and this machine
  has no GitHub login, so nobody here has seen an Actions run. The product owner must check.
- **Stack changed on 2026-10-02** to NestJS + PostgreSQL/Prisma + Next.js + React Native (see the
  2026-10-02 entries below and `CLAUDE.md`). Settled rules 1–17 and the register are unchanged.
- **Phase 1 is unblocked** on decisions. One question is open and does not block: register
  item 30.
- **`docs/plans/phase-1-foundation.md` is the approved plan for the TypeScript stack**
  (rewritten and reviewed 2026-10-02). About 30 working days, nine slices, rules R1–R104. It is
  what the Opus session executes, starting at slice 0.
- Tenant isolation: application-layer scoping, RLS dropped (2026-10-02 final entry), now with
  eight controls in `CLAUDE.md` including a query guard and a schema guard.

## Progress measure (used for the hourly % report)

Whole-project size, in estimated working days. Phase 1 comes from its approved plan; Phases 2–5
are **rough estimates** (Fable/Opus, 2026-10-03), because those phases have no plan yet. Revise
them when each phase is planned, and say so in the report.

| Phase | Scope | Est. days |
|---|---|---|
| 1 Foundation | slices 0–8 (plan §5) | 30 |
| 2 Daily operations | attendance, diary, notices, WhatsApp/SMS drivers, first React Native app | 40 |
| 3 Financial | fee heads, charges, payments, verification, receipts, expenses, payroll | 35 |
| 4 Academic | assessments, results, report cards, certificates, promotion | 30 |
| 5 Extended | biometric, advanced reporting, transport | 20 |
| **Total** | | **155** |

Phase 1 slice sizes (plan §5): 0 = 3.5 · 1 = 2.5 · 2 = 5 · 3 = 2.5 · 4 = 3 · 5 = 1.5 · 6 = 6.5 ·
7 = 4 · 8 = 1.5. A slice counts as done only after its phase gate passes and it is committed; a
slice in progress counts half. **Project % = days done ÷ 155.** Planning and reviews done before
slice 0 are not counted.

## Left to do (ordered)

1. **Confirm GitHub Actions is green** on the latest push. The repo is private and this machine
   has no GitHub login, so the product owner checks the Actions tab; a failure is fixed first.
2. **Start of wave B, small clean-ups left from wave A** (one agent, before the slices): migrate
   `users.dto.ts`, `principal.dto.ts`, `auth/dto.ts`, `platform/auth/dto.ts` and
   `school-settings.dto.ts` to `src/common/fields.ts`; `user.repository.ts` to the shared
   `escapeLike`; the local `notFound` copies to `common/errors/api-exception.ts`; web academics and
   guardians screens to the status lists now in `@asms/shared`; fold
   `SchoolSettingsRepository.lock` into `readLocked`; map Postgres 40P01 (deadlock) to 409
   `CONCURRENT_UPDATE` in `prisma-errors.ts` as a safety net.
3. **Wave B: slices 4 and 6.** Before the first handler that consumes a `Scope` (slice 4's
   teacher reads), the type-aware lint rule in the slice-0 residual-risk statement must exist.
   Services read scope with `scopeOf(session)` (the guard binds it). Slice 4's staff "issue login"
   must reuse wave A's reset-on-link rule when it links an existing login.
4. Wave C: slices 7 and 8 (full `phase-gate` at 8).
5. Product owner: register item 30 (privileged capabilities on a default password); whether a
   linked principal login should get a one-time random password instead of the CNIC default
   (wave-A security residual: the clerk who planted the login knows the default); schema-freeze
   items 7–13 and 23–26 before the end of Phase 1; whether a guardian whose children have all left
   keeps a login (part of item 11); CNIC correction after a login exists; numeric reset code or
   emailed link.
6. Product owner, optional: sample seed data (presentation slide 23) so seeders use real shapes.

---

## Process since 2026-10-03 (product owner asked for speed)

Replaces plan §0 rule 2's "every slice ends with a full gate" for the rest of Phase 1:
- **Waves, not single slices.** A: slices 2 + 3 + 5 together. B: 4 + 6. C: 7 + 8. Agents own
  disjoint files; shared files (`app.module.ts`, `eslint.config.mjs`, `packages/shared`,
  `package.json`, migrations) are edited by the main thread or by one named agent per wave.
- **No separate design step.** Implementing agents write the schema and the endpoint contract
  (`docs/plans/contracts/slice-N.md`) themselves; `data-architect` reviews migrations within the
  wave review.
- **One review round per wave:** `security-reviewer` (mandatory, every wave) and one combined
  correctness-and-quality review, in parallel, then one fix round. Low-severity fixes are accepted
  on their proving tests; only critical or high findings get a re-review.
- **Full `phase-gate` once**, at slice 8. Each wave ends with the main thread's own full run
  (lint, typecheck, all tests, web build, Playwright, hook dry run) before committing.

## 2026-10-03 — Wave A: slices 2, 3 and 5 (Opus 5.5) — DONE

**Built in parallel** after a shared groundwork commit (`a49e2de`: 11 tenant tables, capability
list and role defaults, identity and phone helpers, error codes, access decorators, fail-closed
school routes, audit writer, module stubs). Five agents: slice 2 API, slice 3 API, slice 5 API,
school-auth web, academics-and-guardians web; then one agent swapped the web to the generated API
types and added a real-API end-to-end test.
- **Slice 2:** school login (school code + CNIC digits + password, generic failure, lockout and
  throttles on Redis, spray detection to the platform log), sessions (cookie or bearer, never
  both; idle 24 h, absolute 30 d), `/me`, change email/password, forgot/reset/verify with tokens
  in the URL fragment, users admin (office reset with keep/clear email, disable/enable, R10–R14,
  last principal R72/R73), school settings, and the platform's issue-principal-login.
- **Slice 3:** academic years (activate, close), classes per year (archive, copy sections, year
  immutable once it has sections — also a DB trigger), sections, subjects.
- **Slice 5:** guardians with encrypted CNIC (school-bound AAD), masked output only, POST lookup
  with per-user throttle and merge resolution, issue-login linking an existing user by CNIC hash.
- **Web:** school login, forgot/reset/verify, account, users, settings, academic structure,
  guardians; platform "issue principal login" with a confirmation step.

**Reviews and what they changed**
- `security-reviewer`: **FAIL** on one high finding, now fixed and re-checked PASS. Office staff
  could pre-position a guardian login with an incoming principal's CNIC; issue-principal-login
  then linked it and the planted session silently became principal. Now linking an existing
  login needs `confirmLinkExisting: true` (409 `LINK_EXISTING_LOGIN_UNCONFIRMED` otherwise) and
  resets the account in the same transaction (password to default, email cleared, every session
  revoked, tokens voided, audited). The re-check found one more medium issue — a request whose
  session is revoked while it waits for the user lock could still finish its write — fixed by
  re-checking the session under the lock (`SessionRepository.isLive`), with a test proven to fail
  without it. Also fixed: R14 bypass on suspended staff, CNIC with spaces reaching logs, SMTP
  `requireTLS` in production, teacher scope bound to the request (`scopeOf(session)`).
- Correctness: login-spike alarm wrote nothing (DB CHECK widened by migration
  `20261003071557_login_spike_actor`, test now asserts the row); reset-vs-office-reset deadlock
  (one lock order everywhere, plus a clock read moved after the lock — the race test found it);
  users list sorted parents wrongly (raw SQL page query, isolation-tested); section archive
  ignored a frozen class; guardian lookup with a null key was a 500; settings lock could rewind
  `updated_at`.
- Quality: one rate limiter (`common/rate-limit.ts`), one set of request-field helpers
  (`common/fields.ts`), one `escapeLike`, one `readLocked`, status lists moved to
  `@asms/shared`, one tenant-access pattern (`SchoolContext`).

**Final results:** lint and typecheck clean in all three packages; API 41 suites / 563 tests
(6 `it.todo` stubs for slices 4 and 6); web build; Playwright 60/60 including real-API runs
against the test database; pre-commit hook clean (fake test passwords carry
`pragma: allowlist secret`).

**Residual risk recorded for the product owner:** after a principal login is linked, its password
is the CNIC default, which the clerk who planted the original login knows. The clerk could sign
in first; this is audited (`user.login_after_office_reset`) and locks the real principal out, so
it is loud, not silent. Closing it fully needs a departure from rule 12 (e.g. a one-time random
password for principals) — left to the owner (Left to do, item 5).

---

## 2026-10-03 — Slice 1: platform admin and the school record (Opus 5.5) — DONE

**Built** by three parallel agents (platform auth, schools API, web) on a schema and contract
designed first (`docs/plans/contracts/slice-1.md`). Platform admin: one-step login (password +
TOTP), authenticator enrolment on first sign-in, forced password change, 2 h idle / 12 h absolute
sessions in their own table and cookie, lockout and throttles on Redis, Origin check, seed
command. Schools: list, create (writes `school_settings` and the admission counter in the same
transaction via `SchoolId.fromPlatformSchool`), edit, status changes per a shared transition
table, all audited to an append-only `platform_audit_log`. Web: platform console with login,
enrolment (QR drawn locally), password change, schools list/create/detail/status dialog.

**Decisions taken in this slice**
- Tenant→School foreign keys are declared in Prisma with `@ignore` on both sides: Prisma's diff
  otherwise drops hand-written FKs in every migration (measured). Guarded by a schema test.
- `db:migrate` now runs `prisma migrate deploy`; new migrations come from `db:migration:new`.
- Database error mapping keys on constraint names; for CHECK and trigger errors the name is read
  from `DETAIL` (our trigger functions set it), because Prisma 7.10 drops it (measured).
- 500s never log raw Prisma errors (they carry the whole failing row, including hashes).
- `CLAUDE.md` exception 1: the platform acts inside a school for two operations (creating it,
  issuing a principal login); `fromPlatformSchool` accepts only a branded `CreatedSchoolRow`.
- Seed credentials are needed only by the seed command, not by the running API.
- TOTP secrets are encrypted with AAD bound to the user's id.
- Pre-commit hook: values starting with `/` are not credentials; a fake test credential opts out
  with `pragma: allowlist secret` on the same line.

**Reviews:** security PASS first time (1 medium, 3 low — all fixed with tests proven to fail
without the fix); correctness audit (1 medium race on school edit, 3 low, 5 weak tests — fixed);
code quality (~130 lines removed: session store layer, sort tables, duplicate constants).

**Final results:** lint and typecheck clean in all three packages; API 20 suites / 318 tests;
web build; Playwright 15/15 including a real-API run (first login → enrol → password change →
create school → activate) against the test database; hook dry run clean.

**Dev database note:** any platform admin enrolled before the AAD change cannot sign in; re-seed
with a new email, or clear `totp_secret` and `totp_enrolled_at` for that row.

---

## 2026-10-02 — Slice 0: scaffold and guardrails (Opus 5.5) — DONE, CI pending

**Built** by four parallel agents with disjoint file ownership (API core, tenancy guardrails, web
shell, CI), then integrated and gated by the main thread.

**Pinned versions.** Node 24.18, pnpm 12.3.4. API: @nestjs/core 12.1.2, Prisma 7.10.0 (client,
CLI, adapter-pg), nestjs-cls 7.0.1, @nestjs-cls/transactional 4.0.1, @nestjs/swagger 12.0.2,
@nestjs/throttler 6.7.1, @node-rs/argon2 2.2.1, zod 4.6.5, TypeScript 5.9.3, Jest 30.5.2,
ESLint 9.39.5, typescript-eslint 8.71.0. Web: Next 16.3.8, React 19.2.8, Tailwind 4.3.3,
TanStack Query 5.104.0, openapi-fetch 0.17.0, Playwright 1.63.0. Services: postgres:16-alpine,
redis:7-alpine, mailpit v1.31.3, minio RELEASE.2025-09-07T16-13-09Z.

**Deviations from plan §2, each justified:**
- `@node-rs/argon2` instead of `argon2`: the latter compiles a native module on Windows and needs
  a C++ toolset; the former ships prebuilt binaries. Same algorithm (argon2id).
- TypeScript 5.9, not 7.x: NestJS needs decorator-metadata emit, which ts-jest gets from 5.x.
- PHP-free Docker: Node runs on the host; Docker only for services.
- Extra packages: `zod` (env validation at boot), `ioredis` + `@nest-lab/throttler-storage-redis`
  (throttler on Redis), `dotenv` (tests and `dotenv run` in the dev script).
- Jest runs with `--experimental-vm-modules`: NestJS 12 ships as ESM.
- The web CSP is set per request with a nonce in `proxy.ts`, not as a static header: a static
  header would need `script-src 'unsafe-inline'` for the App Router's inline scripts.
- `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` are not validated at boot yet; slice 1 adds
  them with the seed that uses them.

**Query guard atomicity (plan §3.2): PASS, guard kept, no `tenantWhere()` fallback.**
`transaction-atomicity.spec.ts` holds a `FOR UPDATE` row lock inside an interactive transaction
opened through the guarded client and probes it from a separate connection with `NOWAIT`: locked
throughout, released on commit, with a control case proving the probe detects an escaped
statement. Prisma's `strictUndefinedChecks` preview is enabled: optional fields must be omitted or
`Prisma.skip`, never `undefined`.

**Final results:** lint and typecheck clean in all three packages; API 11 suites / 161 tests;
web build; Playwright 6/6; OpenAPI regeneration byte-identical; pre-commit hook passes over all
committed files; `pnpm dev` serves `/api/v1/health` through the web origin.

**Gate history.** code-quality and code-auditor findings fixed. `security-reviewer` failed the
slice three times before passing: (1) lint let `req.body` become a SchoolId, client IP spoofable
through the Next rewrite, guard did not inspect update data, platform models were a route into
tenant data; (2) six further brand-forgery routes (alias assertions, type-level `import()`,
inferred generic helpers, `eslint-disable` comments, re-export barrels, ClsService poisoning);
(3) bracket access to a TS-private field and a computed key reaching the session setter — fixed
with a runtime-private `#cls` and a separate `SessionEstablisher` importable only in
`src/tenancy`. `phase-gate` failed once (an embedded credential URL in a test, the missing route
snapshot, no migration review, this log) and those are closed. `data-architect` approved the two
migrations.

**Accepted residual risk (security-reviewer's wording, recorded verbatim):** "Slice 0 accepts the
following residual risk on the SchoolId and Scope brands. The name-based lint bans do not see a
brand reached through an indirect type expression (for example `Parameters<typeof f>[0]`). Such a
type can still appear in a type predicate, an overload signature, a class field or a
request-decorated parameter, and a third-party generic whose type parameter is inferred only from
its return type can produce a brand without a cast. Each of these needs deliberate, visible code;
none comes from an accidental `any`, which the type-aware no-unsafe rules refuse. Three things
contain the risk. First, the runtime query guard refuses any tenant-table operation without an
own-property bigint schoolId. Second, the per-table isolation tests run School A's session against
School B's rows. Third, the security reviewer reviews every slice and treats any type predicate,
overload or decorated parameter mentioning a tenant type as a finding. The guard does not detect a
wrong but well-formed schoolId, and nothing checks a forged Scope at runtime. This acceptance
therefore expires before the first slice that consumes Scope from a request-handling path. By then
a type-aware lint rule must reject request-decorated parameters that are not classes, and any
decorated parameter or class field whose resolved type contains the SchoolId or Scope brand
symbol."

**Closed 2026-10-03, before wave B.** The type-aware lint rule `asms/no-brand-in-request`
(`apps/api/eslint-rules/no-brand-in-request.mjs`, wired for `src/**`) rejects request-decorated
parameters on `@Controller` methods whose declared type is not a class (only exceptions: `string`
under `@Param('key')` / `@Query('key')`, and the sanctioned decorators `CurrentSchoolSession`,
`CurrentPlatformSession`, `IdParam`, `Req`, `Res`, each matched by name and declaring file). It also
rejects any decorated method parameter, and any field of a class with decorated fields, whose
resolved type contains a brand at any depth — a brand being any property keyed by a unique symbol
declared under `src/tenancy/**`, so `Parameters<typeof f>[0]`, aliases and generics no longer hide
one. Proven by `test/guardrails/lint-boundaries.spec.ts` (fixtures `request-brand.ts`,
`request-legitimate.ts`). Still open, and not request-bound: type predicates and overloads reaching
a brand through an indirect type expression, and third-party generics inferred from their return
type — they remain under the runtime query guard, per-table isolation tests and per-slice security
review.

**Deployment requirement found here:** the Next.js rewrite forwards a client-sent
`X-Forwarded-For` unchanged, so production needs an edge proxy that overwrites it (recorded in
`CLAUDE.md` and the `devops` agent). Slice 2's login lockout must not reach an internet-facing
environment until staging proves a forged header is ignored.

**Carry-overs into slice 1** (from `data-architect` and the gate):
1. **First:** run a throwaway `prisma migrate diff` once a tenant table exists, to see whether
   Prisma emits `DROP CONSTRAINT` for the hand-written `school_id → schools(id)` foreign key. If it
   does, removing those lines becomes a routine step of SQL review, like partial indexes.
2. `schools.short_code` format CHECK `^[a-z0-9]{3,12}$` and an immutability trigger (SQL is in the
   data-architect review; test short codes already match the format).
3. Replace the school-id trigger function with `CREATE OR REPLACE` so it raises with a constraint
   name (the error mapper keys on constraint names).
4. `updated_at` gets `@default(now())` alongside `@updatedAt`.
5. `school_groups` FK with explicit names, `Restrict` actions and an explicit index.
6. Timezone validated in the DTO with `Intl.supportedValuesOf('timeZone')`.
7. Validate `PLATFORM_ADMIN_*` at boot.
8. Delete the throwaway `/demo` page and its nav entry once real screens use the shared components.

---

## 2026-10-02 — Phase 1 plan rewritten for the TypeScript stack and reviewed (Fable 5.1) — DONE

**Six conventions decided with the product owner** ("go with recommendations"), now in the
`CLAUDE.md` conventions table: pnpm monorepo (`apps/api`, `apps/web`, `packages/shared`);
`bigint` keys serialised as strings; server-side revocable sessions, not JWT; school roles and
capabilities defined in code, only custom roles stored; shadcn/ui + TanStack + react-hook-form;
REST `/api/v1` with one error envelope.

**`CLAUDE.md` fixed:** the stack section still said forced RLS and a prototype, contradicting the
tenancy section — removed. Added the named cross-tenant exceptions (platform, pre-auth school
lookup, scheduler fan-out, session resolution), the transaction convention, and controls 5–8.

**Four design reviews, all findings adopted.** The ones that changed the design:
- `security-reviewer` returned **"not approvable as written"** on the first draft. Three blockers:
  nothing checked that a query actually carried its `schoolId` (now a query guard on the Prisma
  client, scalar-FK-only writes, a required branded `Scope`); the platform module could issue a
  principal login in any school through an unlisted path (now a named constructor, TOTP on
  platform login, refused while a principal exists unless a reason is given, double audit); and
  most endpoints had no stated permission (now an authorisation table per slice, binding).
  Also adopted: password pepper, AAD-bound field encryption, reset and verify tokens in the URL
  fragment, clerk must choose keep-or-clear email on office reset, `trust proxy` one hop.
- `data-architect` **ran Prisma 7.10.0 against PostgreSQL 16** rather than reasoning. Verified:
  the schema guard cannot read Prisma metadata in v7 (now reads `pg_constraint`); the
  `partialIndexes` preview flag drops hand-written partial indexes (keep it off); `P2002` no
  longer names the fields (map errors by constraint name); a caught unique violation aborts the
  transaction (handle conflicts outside it). Design changes: section tied to its class by a
  three-column FK; school settings and counters moved off the platform's `schools` table;
  `user_roles` rows are ended not deleted and hold only staff roles; one class teacher per section
  by exclusion constraint; uploads are stored once and never moved.
- `business-rules` found three defects: the sweep could delete a committed document after a
  failed move (now nothing moves); a password change could overwrite a racing office reset (now
  the user row is locked, R99); office staff could disable a principal (R12 and R14 widened).
  Also: last-principal invariant across all three removal paths (R72); `users.status` written
  only by the disable endpoint (R71); system-role assignment moved from slice 7 to slice 4.
- `api-designer`: one naming convention, the full status map, idempotency semantics, about
  fifteen endpoints the screens needed but the draft lacked, the OpenAPI pitfalls with bigint
  ids, and no HTTP `DELETE` anywhere.

**Decided by Fable within the brief:** platform admin login uses TOTP; no queue in Phase 1 (mail
is sent in-process after commit, three attempts); staff photos dropped from Phase 1; a student's
photo is their latest `photo` document; idempotency keys are not purged in Phase 1.

**Raised to the product owner:** register item 30. Recommended yes.

**Also this session:** two agent lines that still described closed decisions were corrected
(`data-architect` on login identity and money; `api-designer` on money and string ids).

---

## 2026-10-02 — Laravel leftovers removed (Opus 5.5) — DONE

Deleted the untracked Laravel 13 skeleton from the 2026-10-01 slice-0 start: `app`, `bootstrap`,
`config`, `database`, `docker`, `public`, `resources`, `routes`, `storage`, `tests`, `vendor`. None
was ever committed. Two local Docker images (`asms-app:dev`, `composer:latest`) remain on the
maintainer's machine; remove with `docker rmi` when Docker Desktop is running. Current state and
left-to-do above corrected: they still pointed at the superseded Laravel plan.

---

## 2026-10-01 — Phase 1 build plan written and reviewed (Fable 5.1) — DONE

**Decisions taken by Fable (owner said "go as you make sense"):** Docker-first dev environment,
nothing on the host but Docker Desktop; GitHub Actions CI; Flutter deferred to Phase 2; the five
generic MCPmarket skills kept at the owner's request; seed data invented in Pakistani-school shape
until the owner supplies samples.

**Plan:** `docs/plans/phase-1-foundation.md` — nine slices from scaffold to phase close, the 51
capability keys with role defaults, 60 numbered rules that are test names, schema conventions.

**Reviewed before approval** by `data-architect`, `business-rules` and `security-reviewer`
(design reviews, no code exists). Findings adopted, the important ones:
- Username was going to be the CNIC in plaintext — now stored only as an HMAC hash
  (`IDENTITY_HASH_KEY`, separate from `APP_KEY`). `CLAUDE.md` rule 12 amended.
- Login had no tenant: same digits in two schools would resolve to the first match, and under
  RLS the user lookup itself had no tenant. Now the login and forgot-password forms take a school
  code written to the session before authentication. `CLAUDE.md` rule 2 amended with this single
  exception.
- A mutable "current session" pointer on classes would lie about history; class rows are now per
  academic year and immutable, with composite FKs `(class_id, academic_year_id)`.
- Composite tenant foreign keys `(school_id, parent_id)` everywhere; the isolation test enumerates
  every table against an allowlist, not only tables that happen to have `school_id`.
- One lifecycle mechanism per table: status on people/record tables, soft delete only on config
  tables, so unique indexes stay meaningful.
- Office staff could have become principal via reset + role assignment; rules R12–R14 close it.
- Documents: private disk for Livewire temp uploads too, sniffed types, re-encoded images, signed
  5-minute URLs behind a capability check.
- Phones normalised to E.164; no unique on email; teacher assignments date-bounded; admission
  number from a locked counter; readmission path; status transition table; idempotency token on
  the admission wizard; rate limiting via `RateLimiter` not columns; capabilities as a PHP enum;
  document verification screen and grant expiry dropped from Phase 1.

**Flagged to the product owner, not decided**
- CNIC correction once a login exists conflicts with "username does not change"; Phase 1 refuses
  the edit.
- Password reset uses Laravel's built-in emailed link rather than a numeric code; a code is a
  small change if insisted on.

## 2026-10-01 — Auth details and contact capability confirmed (Fable 5.1) — DONE

**Answers given:** students log in with their national ID number (B-Form / CRC, read from
"use id card"); password reset by a code to an email the user must enter before changing their
password; first login prompts but does not force a change; guardian contact capability is the
three-value field asked at admission.

**Applied:** rule 12 extended, rule 17 added, register items 4, 27, 28, 29 closed; the
"Blocks Phase 1" tier is now empty.

**Flagged to the product owner:** email reset assumes an email; keypad-phone guardians have none,
so rule 12 states office reset-to-default as the fallback. "Use id card" for students was read as
the B-Form / CRC number, not a school-issued card; correct it if wrong.

## 2026-10-01 — Decisions 1, 2, 3, 5, 6 confirmed by the product owner (Fable 5.1) — DONE

**Answers given:** one campus per school; login username and default password are the CNIC digits
without dashes, password changeable by the user; permission model and attendance granularity as
recommended; principal defines academic sessions per class; due date 10th (changeable); English
only, no Urdu; PKR, whole rupees only.

**Applied**
- `CLAUDE.md`: settled rules 11–16 written; rule 3 amended for per-class sessions; register rows
  1, 2, 3, 5, 6, 19 closed (numbers retired, listed under "Closed"); new rows 27–29 for the auth
  details the answer left open; Urdu removed from assumptions and market constraints; capability
  list moved to "Not yet specified".
- `docs/decisions-pending-confirmation.md`: Part 1 deleted, replaced by a note on what survived
  and what changed (CNIC + password instead of phone + OTP); RTL prototype dropped.
- Client docs: every Urdu / language-choice line replaced with English only; architecture
  "Assumed: RTL" item closed.
- Agents `product-designer` and `research-scout`: Urdu guidance removed.

**Flagged to the product owner**
- CNIC digits as the default password is weak: the number appears on many documents. Rule 12
  therefore makes encrypted storage, hashed lookup, no logging, rate limiting, lockout and a
  "still on default password" view mandatory, and item 29 asks whether to force a change on
  first login (recommended: yes).
- "notl" in the answer was read as "no decimals"; whole-rupee amounts are now rule 15. Correct
  it if that reading is wrong.

## 2026-10-01 — Pre-build review of the whole repository (Fable 5.1) — DONE

**Goal:** recheck everything before a build plan is written; fix what is wrong; commit.

**Repository hygiene**
- **Pre-commit hook bug fixed and verified.** Files whose names contain spaces or non-ASCII
  characters were silently skipped by the secret scan and the size check (shell word-splitting
  plus git's path quoting). Proven: a staged hardcoded credential inside the functional spec
  passed the old hook with exit 0. Rewritten to read paths line-by-line with
  `core.quotepath=false`. Tested five cases: secrets in space/non-ASCII paths blocked; clean
  change passes; force-added `.env` blocked; database URL and >1 MB file blocked; nothing
  staged exits 0.
- **Added `.gitattributes`.** Local git has `core.autocrlf=true`; a fresh Windows clone could
  have checked the hook out with CRLF and broken `#!/bin/sh`. Hooks and `*.sh` forced to LF.
- **Renamed the functional spec** from the 100-character em-dash name to
  `docs/asms-functional-spec.md` (archive copy likewise). The old name failed a clone into a
  deep path on Windows with "Filename too long" and was what exposed the hook bug. All
  references updated.
- Confirmed `git-pusher.md` and `.claude/local/` are excluded from git; remote `origin` exists.

**Documentation consistency** (from a `docs-maintainer` sweep of every current doc and agent
file against `CLAUDE.md`; 25 findings, all applied or recorded)
- `CLAUDE.md`: now points at this log first; document list corrected (added presentation,
  pending-decisions, this log; charter moved to "source, historical"); git section updated;
  `devops` no longer a "placeholder"; stack section points at the Part 2 implementation
  recommendations (no tenancy package, forced RLS, not Filament tenancy, Drift + outbox);
  the six roles named once; decisions 1, 2, 6, 12, 14, 18 annotated with what client docs
  already show; **six new register items 21–26** (results approval unit, SMS-eligible message
  types, late arrival, late-payment charge, banking, default remark visibility) lifted from
  the architecture doc and presentation slide 24; three presentation statements moved into
  "Assumed unless corrected" (attendance denominator, certificate numbering, support access).
- `docs/asms-system-architecture.html`: Plate 03 routing rule corrected from "push if app
  installed, else WhatsApp" (app-first, the exact defect flagged elsewhere) to "WhatsApp,
  plus push if app installed"; Plate 02 account/permission rows labelled provisional;
  decisions 14/15 re-tiered to match the register; leave-cover and approval-unit rows point at
  register items 12 and 21.
- `docs/asms-system-design.html`: "Everything above is agreed" softened to "agreed in shape"
  with account/permission marked as awaiting confirmation; leave-cover question now carries
  the proposal instead of "nobody can"; six roles named; 14/15 pills re-tiered.
- `docs/asms-school-presentation.html`: slide count 27→26 and "nine modules"→ten, with the
  module list matching the slides. No client-facing promise was changed; where the deck
  commits to something still open (period-level attendance, monthly allowance) the register
  now says so rather than the deck being edited.
- `docs/asms-functional-spec.md` corrections header: dead "§29 CNIC" citation fixed; three
  rows added (separate apps → one role-aware app; biometric → deferred; "OCR imports" →
  struck); current-documents line completed.
- `docs/asms-architecture-review.html`: superseded banner added (it had none, unlike the
  other two superseded docs), stating its "Fix" boxes are not decisions.
- `docs/announcements-concept.html`: banner extended from "slide 07" to slides 01, 02, 07, 08.
- `docs/decisions-pending-confirmation.md`: capability arithmetic fixed (groups sum to 51,
  not 38) and stated plainly that the named list is not yet written.
- `docs/AI-AGENT-TEAM-spec.md`: status header mapping its 20 agent names to the real ones.
- Agents: `business-rules` and `data-architect` no longer keep private copies of the
  open-decisions / settled-rules lists (they point at `CLAUDE.md`); `requirements-analyst`
  reads the register, spec header, architecture doc, pending decisions and this log, and
  uses the canonical six roles; `api-designer` and `devops` no longer imply a separate
  principal app or a decided host; `test-engineer` example no longer presumes decision 9.

**Flagged for the user, not changed**
- `.claude/skills/` holds five generic skills installed from MCPmarket (`api-design-patterns`,
  `compliance-audit`, `database-design-patterns`, `mermaid-diagramming`,
  `requirements-discovery`), ~4,000 lines, committed. `compliance-audit` covers
  GDPR/HIPAA/PCI/SOC 2 and does not apply here. None are referenced by `CLAUDE.md`. Left in
  place; removing user-installed tooling is the user's call.
- `docs/_archive/` duplicates ~7,000 lines of superseded documents in git. Harmless, explicitly
  not a source of truth, but the largest thing in the repository.
- Product decisions surfaced by the sweep were **recorded, not made**: see register items
  21–26 and the annotations on 1, 2, 6, 12, 18. The client deck already commits to
  period-level attendance storage and a monthly message allowance; confirm or withdraw.

---

## 2026-10-02 — Stack changed: Laravel/Filament/Flutter → NestJS/Prisma/Next.js/React Native

**Decided by the product owner.** Trigger: the manager challenged PHP as dated; the discussion
surfaced something not previously on record — the maintainer has shipped Node, Express, MongoDB,
React, Next.js and React Native for four years (Shopify apps, recurring billing with dunning,
RBAC, JWT auth, webhook pipelines) and has never shipped PHP.

**Reasoning.** The team is two humans and two AI sessions. AI writes; humans review. **Review
capacity is the binding constraint.** The earlier recommendation rested on Filament generating the
CRUD screens — less code to review — and on PHP's hiring pool in Pakistan. There is no hiring, so
that argument was void, and "less code to review" loses to "code the reviewer can actually read".
The maintainer has already built ASMS's hardest modules in Node in another domain.

**New stack.** NestJS (Node + TypeScript) · PostgreSQL + Prisma · Next.js web admin · React
Native mobile · Redis · WAHA · FCM · S3. PostgreSQL unchanged and reaffirmed: the model is
relational, money needs real transactions and constraints, and **forced row-level security is the
tenant-isolation strategy** — no MySQL or MongoDB equivalent.

**Done this session**
- `CLAUDE.md` — stack section rewritten with the reasoning; document list annotated
- `.claude/agents/api-designer.md` — NestJS contracts, Next.js and React Native clients
- `.claude/agents/data-architect.md` — Prisma tooling; RLS, partial indexes and CHECK constraints
  go in raw SQL inside migrations, since Prisma cannot express them
- `.claude/agents/devops.md` — rewritten for the Node runtime (separate worker process, single
  scheduler, `prisma migrate deploy`, typecheck in CI)
- `docs/asms-functional-spec.md` — Flutter → React Native in the corrections header
- `docs/asms-system-architecture.html` — stack table, process table, decisions table and Plate 01
  diagram updated
- `docs/plans/phase-1-foundation.md` — **marked SUPERSEDED, do not execute**
- `docs/decisions-pending-confirmation.md` — Laravel/Filament/Flutter parts marked void

**Unchanged and still valid:** all 17 settled rules · the module boundaries · the charge lifecycle
· the notification driver design · forced RLS · idempotency as database constraints (a device can
be offline for days; a cache TTL cannot survive that) · the open-decisions register.

**Next session must do first:** re-plan Phase 1 against the new stack. The requirements, slice
ordering and R1–R60 rule list in the old plan are stack-independent and were reviewed and
approved — carry them over, rewrite everything below them. `data-architect`, `business-rules` and
`security-reviewer` review again before approval.

**Still open:** the forced-RLS prototype before schema freeze — now against Prisma and NestJS
rather than Filament, which removes the "unproven under Filament" caveat but replaces it with
"unproven under Prisma". Verify Prisma's connection handling sets the tenant GUC per request and
per queued job, since there is no HTTP request in a worker.

---

## 2026-10-02 (later) — Tenant isolation mechanism decided

Ran `solution-advisor` (design) and `research-scout` (verification against sources) on how RLS is
driven under NestJS + Prisma. **The pattern this session originally proposed is confirmed broken.**

**What was rejected, and why it matters.** The proposal was a Prisma client extension on
`$allOperations` wrapping every operation in its own transaction to set the tenant GUC. Evidence:

- Prisma's own `prisma-client-extensions` RLS example carries *"not intended to be used in
  production environments"* and warns that explicit `$transaction()` "may not work as intended".
  Last meaningful update December 2022.
- **Issue #23583** (Prisma 5.11, closed **not planned**): the extension executes parts of an
  interactive transaction in *separate* transactions. `FOR UPDATE SKIP LOCKED` row locks were not
  visible to the following `UPDATE`. A no-op extension did not reproduce it. **This is a loss of
  atomicity, not a performance issue**, and it lands on payment, allocation and ledger writes.
- **Issue #20016 / #25034**: an extension cannot detect that it is inside a transaction except via
  private internals; the best community workaround's own author no longer vouches for it.
- Pool arithmetic: the inner wrapper needs a second connection while the outer transaction holds
  the first, so concurrency deadlocks at pool size. It surfaces as `P2028` after ~5 s, pointing at
  the wrong thing. **A two-person team testing one request at a time will never see this.**

**Decided.** One **interactive** transaction per unit of work via `@nestjs-cls/transactional` +
`transactional-adapter-prisma`, GUC as its first statement. Never batch `$transaction` (issue
#30206: intermittently never settles on driver adapters). Full mechanism in `CLAUDE.md`.

**One factual correction to earlier reasoning.** `current_setting('app.school_id', true)` does
**not** return NULL once a transaction-local GUC has been used on that connection — it returns the
empty string, and `''::uuid` raises. Prisma issue #20407, confirmed, unfixed. Policies must read
`NULLIF(current_setting('app.school_id', true), '')::uuid`. Still fails closed, but without the
`NULLIF` isolation tests pass on a cold pool and fail on a warm one.

**Agent disagreement, resolved explicitly** (per the conflict rule). `solution-advisor` argued
against a repository-level `school_id` filter: a redundant read filter masks an RLS regression,
because behavioural isolation tests would still pass with the policies dropped. `research-scout`
argued for it: honest query plans, debuggable errors, defence in depth. **Resolution: keep the
filter, and make the *metadata* test — not the behavioural test — the thing that proves RLS
exists.** Both tests mandatory. Recorded in `CLAUDE.md` item 9 with the reasoning, so it is not
re-litigated.

**Also settled:** tenant set in **middleware**, not an interceptor (NestJS runs middleware → guards
→ interceptors, and the auth guard queries the DB under RLS) · the scheduler fans out one job per
school and never queries tenant data, removing an entry point rather than guarding it · three
Postgres roles with a boot-time assertion that the runtime role lacks `BYPASSRLS` · no
`Promise.all` inside a transaction.

**Files updated:** `CLAUDE.md` (new "How tenant isolation is implemented" section, ten numbered
items plus six prototype acceptance criteria) · `.claude/agents/data-architect.md` (the exact
policy DDL, composite tenant FKs, and the backfill trap where an owner-run `UPDATE` affects zero
rows) · `.claude/agents/devops.md` (three roles, boot assertion, hosting constraint, pin Prisma) ·
`docs/decisions-pending-confirmation.md` (tenancy no longer provisional there).

**Open and genuinely unknown.** `research-scout` found **no first-hand production report** of this
pattern under NestJS + Prisma 7 — only Prisma's disclaimed example, a May 2023 article written
against internals that no longer exist, and a one-star pre-1.0 package. *The absence of a credible
"we run this at scale" account is itself the finding.* Prisma 7 requires driver adapters and
removed the Rust query engine, so most public writing on this topic reasons about internals that
are gone. **The six-point prototype in `CLAUDE.md` is not optional** — it is roughly a day, and it
runs before the schema freezes.

Also unverified: whether `nestjs-cls` propagates reliably through BullMQ processors. The author
declines to guarantee non-HTTP transports and no public test exists. Prototype criterion 4 covers it.

**Hosting is now an open dependency** of this design: fine on plain Postgres and PgBouncer
transaction mode, **incompatible with Prisma Accelerate / Data Proxy**. Re-check when hosting closes.

---

## 2026-10-02 (final) — Row-level security dropped. Application-layer scoping instead.

**Product owner's call: take the path with no unproven machinery.** This reverses the decision
recorded two entries above, deliberately and with the reasoning intact above it.

**What changed.** Tenant scoping is enforced in a **repository layer in the application**. The
database does not enforce it. No session GUC, no `set_config`, no forced RLS, no three Postgres
roles, no boot assertion, and **no prototype day** — nothing here is novel, so there is nothing to
prove before building.

**Why.** The RLS design was sound but had no credible production precedent under Prisma 7: Prisma's
own example is labelled not-for-production, the one good article predates the engine rewrite, and
`research-scout` found no first-hand "we run this at scale" account. Building a school's fee
records on a pattern nobody has shipped is a risk the owner declined. Correct call for a two-person
team with no appetite for debugging someone else's unsolved problem.

**The four controls that replace it** (all in `CLAUDE.md`):

1. Nothing outside `src/repositories/**` may import the Prisma client — ESLint rule plus a test
2. Every repository method takes `schoolId` as a required branded argument; omitting it is a
   **compile error**
3. Every tenant query filters on `school_id`, including `findUnique` → `findFirst`, because a bare
   primary-key lookup is the classic cross-tenant read
4. One isolation test per table: write as School A, read as School B, assert nothing

**The risk, stated plainly and on the record.** Without database enforcement, a query that forgets
its filter **leaks another school's data**. The four controls make that unlikely, not impossible.
Accepted knowingly in exchange for building on proven ground. `security-reviewer` has been updated
to say it is now **the control rather than a second opinion on one** — tenant isolation review is
no longer a backstop check.

**Kept so the safety net can be added later without migrating data** — non-negotiable, in
`data-architect`: `school_id NOT NULL` on every tenant table · composite FKs `(school_id,
parent_id)` on child rows · indexes leading with `school_id` · no cross-tenant foreign keys. If the
system outgrows what review can police, RLS becomes additive rather than a rebuild.

**Files updated:** `CLAUDE.md` (tenancy section rewritten; Postgres rationale no longer cites RLS)
· `.claude/agents/data-architect.md` · `.claude/agents/devops.md` (one app role; three-role split
and boot assertion removed) · `.claude/agents/security-reviewer.md` (tenant isolation is now the
control) · `docs/decisions-pending-confirmation.md`.

**Unchanged:** the stack (NestJS · PostgreSQL · Prisma · Next.js · React Native), all 17 settled
rules, the open-decisions register, and the superseded status of `docs/plans/phase-1-foundation.md`.

**Next session:** re-plan Phase 1 against this stack. Carry over the old plan's requirements, slice
ordering and R1–R60 rule list — stack-independent and already reviewed. There is no prototype
blocking the schema freeze any more.
