# ASMS work log — session handover

**Read this first in every session.** It is the single running record of what has been done,
what is in progress, and what is left. Any model (Fable, Opus, Sonnet) picking up this project
must update it before ending a session. Newest entry at the top. Dates are absolute.

Working arrangement: **Fable 5.1 does planning, review and the final build plan. Opus 5.5
writes the production code.** Do not start application code in a planning session.

---

## Current state (keep this section accurate)

- **Phase:** Pre-build. No application code exists. Repository holds planning docs, agent
  definitions, hooks and git hygiene only. The Laravel skeleton scaffolded on 2026-10-01 was
  never committed and was deleted on 2026-10-02.
- **Stack changed on 2026-10-02** to NestJS + PostgreSQL/Prisma + Next.js + React Native (see the
  2026-10-02 entries below and `CLAUDE.md`). Settled rules 1–17 and the register are unchanged.
- **Phase 1 is unblocked** on decisions; nothing in the "Blocks Phase 1" tier is open.
- **`docs/plans/phase-1-foundation.md` is SUPERSEDED.** Its requirements, slice order and R1–R60
  rule list are stack-independent and carry over; everything below them must be rewritten.
- Tenant isolation: see the 2026-10-02 (final) entry — application-layer scoping, RLS dropped.

## Left to do (ordered)

1. **Re-plan Phase 1 for the new stack** (Fable). Carry over requirements, slice order and
   R1–R60; rewrite stack, schema conventions and per-slice tasks. `data-architect`,
   `business-rules` and `security-reviewer` review before approval.
2. Opus executes the new plan slice by slice, each gated and logged here.
3. Product owner: schema-freeze items 7–13 and 23–26 before the end of Phase 1; CNIC correction
   after a login exists; numeric reset code or emailed link.
4. Product owner, optional: sample seed data (presentation slide 23) so seeders use real shapes.

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
