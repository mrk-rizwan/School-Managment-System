# ASMS work log — session handover

**Read this first in every session.** It is the single running record of what has been done,
what is in progress, and what is left. Any model (Fable, Opus, Sonnet) picking up this project
must update it before ending a session. Newest entry at the top. Dates are absolute.

Working arrangement: **Fable 5.1 does planning, review and the final build plan. Opus 5.5
writes the production code.** Do not start application code in a planning session.

---

## Current state (keep this section accurate)

- **Phase:** **Phases 1-4 complete and closed.** Phase 4 (Academic) closed on 2026-10-08:
  every slice 29-36 built, reviewed and committed, close commit `55255eb`, CI run 37822174131
  green on both jobs (all Maestro flows incl. teacher-marks-offline, principal-approve-result,
  parent-report-card), **`phase-gate` PASS** with two recorded limitations (below, "What Phase 5
  inherits"). Phase 3 closed 2026-10-07 with the real-driver proof deferred to go-live ("Left to
  do" item 1). Project = 143.5 / 163.5 days = 88 %. **Next: Phase 5 (Extended) needs a plan**
  (rule 31: the period timetable, events and PTM, past-results import; plus biometric attendance,
  advanced reporting and transport, register item 20) — and the owner's answers to the Phase 4
  defaults listed below.
- **The repository is public** since 2026-10-07 (the owner's choice, so that GitHub Actions runs
  without billing; the full history was scanned for secrets first and was clean). Treat every
  commit as published: the pre-commit hook stays the guard.
- **pnpm does not start on this machine** since 2026-10-06 (corepack's `pnpm-native.exe` fails to
  spawn). Run tools directly: API Jest `node --experimental-vm-modules node_modules/jest/bin/jest.js`,
  mobile Jest with `NODE_PATH=<repo>/node_modules/.pnpm/node_modules`, `npx nest build` +
  `npx tsx scripts/generate-openapi.ts`, `npx openapi-typescript …` for the clients, and start
  `npx next dev --port 3100` yourself before `npx playwright test -c playwright.mocked.config.ts`.
  CI is unaffected. Stop any dev server you start: a stale one on :3100 answered 500 on every
  dynamic route and cost a fix agent 40 minutes.
- **Local ports (owner, 2026-10-04): web 3460, API 3461** — the owner runs other apps on 3000.
  `.env` / `.env.example`, web scripts, Playwright, CI, mobile defaults and README all use them.
- **CI:** green through wave A (`067e767`); the Phase 1 close push (`ef2e5e8`, run 37138806242)
  was **red** — the API test process ran out of heap on the runner after 17 of 72 suites (local
  Node allows 4.3 GB, the runner's 2 GB). Fixed by running Jest with two recycled workers
  (`--maxWorkers=2 --workerIdleMemoryLimit=1024MB`; 955/955 locally in 200 s). GitHub CLI is now
  installed at `~/bin/gh.exe` (on PATH; device-code login as `mrk-rizwan`, config in
  `~/.config/gh` — set `GH_CONFIG_DIR=$HOME/.config/gh` in Git Bash), so CI results are readable
  from this machine with `gh run list` / `gh run view <id> --log-failed`. **CI green on `4dc5819` (run 37143282348, every step including Playwright) — Phase 1 formally closed, 2026-10-03.**
- **Stack changed on 2026-10-02** to NestJS + PostgreSQL/Prisma + Next.js + React Native (see the
  2026-10-02 entries below and `CLAUDE.md`). Settled rules 1–17 and the register are unchanged.
- **No register item blocks a phase.** Item 30 closed 2026-10-05 as CLAUDE.md rule 24 and was
  built in Phase 3 slice 18.
- **`docs/plans/phase-1-foundation.md`** was the approved Phase 1 plan (30 days, nine slices,
  rules R1–R104) and is now complete; every rule except R15 has a named test.
- Tenant isolation: application-layer scoping, RLS dropped (2026-10-02 final entry), now with
  eight controls in `CLAUDE.md` including a query guard and a schema guard.

## Progress measure (used for the hourly % report)

Whole-project size, in estimated working days. Phase 1 comes from its approved plan; Phases 2–5
are **rough estimates** (Fable/Opus, 2026-10-03), because those phases have no plan yet. Revise
them when each phase is planned, and say so in the report.

| Phase | Scope | Est. days |
|---|---|---|
| 1 Foundation | slices 0–8 (plan §5) | 30 |
| 2 Daily operations | slices 9-17 (plan §6; slice 9 grew by 2 days for the second WhatsApp driver) | 42 |
| 3 Financial | slices 18-28 (plan `phase-3-financial.md`, revised twice, approved 2026-10-06) | 38.5 |
| 4 Academic | slices 29-36 (plan `phase-4-academic.md`, reviewed and approved 2026-10-07) | 33 |
| 5 Extended | biometric, advanced reporting, transport | 20 |
| **Total** | | **163.5** |

Phase 1 slice sizes (plan §5): 0 = 3.5 · 1 = 2.5 · 2 = 5 · 3 = 2.5 · 4 = 3 · 5 = 1.5 · 6 = 6.5 ·
7 = 4 · 8 = 1.5. A slice counts as done only after its phase gate passes and it is committed; a
slice in progress counts half. **Project % = days done ÷ 163.5** (Phase 4 planned at 33 on 2026-10-07; Phase 3's 110.5 done days = 68 %). Phase 2 slice sizes: 9 = 9 · 10 = 2.5 ·
11 = 7 · 12 = 2 · 13 = 4 · 14 = 5 · 15 = 5 · 16 = 6 · 17 = 1.5. Phase 3 slice sizes (plan §5):
18 = 2.5 · 19 = 7 · 20 = 6 · 21 = 4 · 22 = 3 · 23 = 2 · 24 = 2.5 · 25 = 4.5 · 26 = 3 · 27 = 2 ·
28 = 1.5 (the plan's total is 38.5). Phase 4 slice sizes (plan §5): 29 = 3 · 30 = 6 · 31 = 6.5 · 32 = 4 ·
33 = 3 · 34 = 4 · 35 = 5 · 36 = 1.5. Planning and reviews done before slice 0 are not counted.

## Left to do (ordered)

1. **Real-driver proof — a hard precondition of the first production deployment** (deferred
   again by the owner on 2026-10-07 at the Phase 3 close; it no longer blocks a phase gate, only
   go-live) (phase gate, 2026-10-05; deferred from Phase 2 because it is owner-blocked).
   One WhatsApp message through WAHA and one SMS through Sendpk on staging, delivery rows
   `delivered`, plus WAHA's first real start (uid 1000, read-only root) and the 7-day purge
   decision (GOWS vs WEBJS, `docs/deployment.md`). **Owner action, requested 2026-10-03:** the
   Sendpk account and PTA sender registration (15-30 days), and a WAHA host. Before the first
   real send, the vendor's answers to the 15 questions go into `docs/plans/contracts/slice-9.md`
   §9; if an answer changes anything beyond `src/messaging/drivers/sms.ts` and
   `src/messaging/legs.spec.ts`, it is rework reviewed by `data-architect`. The deferral is safe
   only while R112 holds (a missing driver credential fails production boot); if that rule is
   relaxed, the deferral lapses. It becomes a FAIL if the accounts exist, or a school is
   scheduled to go live, before the proof is done. **The Phase 3 gate (2026-10-07) failed on it,
   as the plan said it would; the deferral has expired.**
1b. ~~GitHub Actions stopped starting jobs~~ **Resolved 2026-10-07:** the account's Actions billing
   failed ("recent account payments have failed or your spending limit needs to be increased");
   the owner made the repository public, where hosted runners are free. CI ran again from run
   37586567674 and is green from run 37639293912 (`0af67a9`).
2. **Phase 3 (Financial) decisions settled 2026-10-05:** the owner accepted the main-thread
   recommendations; recorded as CLAUDE.md rules 18-25 (register items 7-13, 16, 18, 24, 25, 30
   closed). Defaults the main thread chose where it had made no recommendation (late fee off,
   both payment paths, seeded fee heads, receipts, expense threshold Rs 5,000, salary and leave
   defaults, platform billing tiers, 15-day grace, 12-month retention) are open to the owner's
   correction. All slices are built; the gate result and the owner items from the build are in
   the 2026-10-07 entries and "What Phase 4 inherits" below.
3a. **Owner answered Phase 2 §1.2 on 2026-10-03** (recorded in the plan): the principal pairs
   the school's own WhatsApp number; the platform admin sets each school's SMS cap; **nothing is
   disturbed under suspension until termination** (this lifts Phase 1 R80's read-only rule —
   slice 9 removes it); SMS provider options researched (`research-scout` report below) and one
   or two will be connected; **both** WAHA and the WhatsApp Business API, selectable per school
   with a platform default; cover teacher gets full class-teacher scope; the owner creates the
   Firebase project and the Play account; Android only; office staff gain `attendance.student.mark` (all scope) by default so the gate
   can record a late arrival; **SMS: Sendpk only for now** (research in
   `docs/research/sms-gateways-2026-10-03.md`; the school-SIM Android gateway idea is deferred to
   a later driver). Nothing in §1.2 is open. **Owner to start now:** PTA registration of the
   platform's SMS sender name with Sendpk (15–30 days; company letterhead, NTN/SECP, signatory
   CNIC); the Firebase project and the Play developer account before slice 15.
4. Product owner, decisions taken provisionally by the main thread — confirm or overturn:
   (a) principals are unrestricted peers (grants/revokes on a principal refused);
   (b) the login-spike recorder as part of named exception 2 (CLAUDE.md);
   (c) issue-login reason optional with a fixed fallback;
   (d) identity-probe budget 30/min, 300/h per user (about 50 admissions an hour per clerk);
   (e) object storage on Chainguard's MinIO image (chosen by the owner 2026-10-03 — recorded).
5. Product owner, open questions (item 30 closed → rule 24, built in slice 18): one-time random password for principals (closes the default-password residual);
   admission/readmission/change-class dates outside the academic year; a former student whose
   CNIC equals their B-Form (review recommends an audited "retire student login" action, never a
   link); a guardian whose children have all left (part of 11); CNIC correction after a login
   exists; numeric reset code vs emailed link; email every principal when the principal role is
   added or removed.
6. Small leftovers, not defects (also listed under "What Phase 2 inherits"): S3 mid-stream
   truncation, no bucket reconcile, pg "already executing a query" warnings; and grant-screen guidance on
   delegating `class.manage` + `staff.create` + `user.account.manage` together is not written yet.
7. Product owner, optional: sample seed data (presentation slide 23).

---

## What Phase 5 inherits from Phase 4 (written at the Phase 4 close, 2026-10-08)

**Built and standing:** terms, result settings and grade bands per year; class subject lists;
class tests and per-section exams entered on the phone offline; result sheets submitted per
section and approved from the Approvals inbox; composition by one set of pure functions
(`packages/shared/src/results/`); the final result; publication to families by WhatsApp, SMS or
the app; report cards (native, printed, withheld for dues when a school turns it on);
corrections as new versions; parent and student views; result reports; numbered certificates
(the leaving certificate dues-gated); promotion sheets, year-end apply and the year-close guard.

**What Phase 5 must use rather than rebuild:**
- **The period timetable attaches to `class_subjects`** (a period names a class-subject and a
  teacher); Phase 2's R120 (who may mark a period) and R129 (unrecorded registers) tighten from it.
  `MarksScope` is the subject-aware scope the timetable and period attendance should reuse.
- **Merit lists, GPA, cross-section or historical reports read `results` and `result_subjects`**
  (stored figures, settings snapshot on the sheet); add columns, never recompute.
- **Past-results import** writes `results`/`result_subjects` rows on sheets created for the
  imported year, with a provenance column — it must not invent marks.
- **Events and PTM**: the Approvals inbox and `GET /me/approvals` take new sections; announcements
  carry the invitations.
- **Year-end extras** (fee-structure copy, capacity planning) hang off `promotion_sheets`.

**Recorded limitations from the gate (both closed on 2026-10-09 in the follow-up commit: ten Phase 4
screens added to the tablet check, R277 named):**
- Tablet viewport proof for the Phase 4 screens was missing at the gate (`e2e/responsive.spec.ts`
  listed none newer than Phase 2 — the precedent Phase 3 accepted); added after the gate if the
  follow-up commit says so.
- R277 (attendance on the card) was proven inside the R296 test without its own name; named after
  the gate if the follow-up commit says so.

**For the owner to confirm (defaults built):**
- Position within the section, not the whole class (register-style item 36).
- Result messages go to the fee-payer guardians, else the primary contact, else every guardian
  with a phone (the receipt rule) — or to every guardian?
- A suspended pupil must be reactivated before being marked "not continuing".
- The optional `pass_rule = overall` (default per subject, as rule 26).
- Grace marks are not built (item 35); the promotion override covers borderline cases.
- The school's real grade bands and pass mark (item 32; default A+ 90 … F below 40, pass 40 %).
- The B-Form number prints on the leaving certificate (item 33, default on).
- Repeat-year fees for a detained pupil follow the class as normal (item 34).
- Sole-principal self-approval of sheets and corrections, recorded `self_approved` (rule 27).

**Not built by design (plan §6):** the period timetable, events and PTM, past-results import,
merit lists across sections, GPA, an audit-log screen. Guardian merge still has no verb.

## What Phase 4 inherits from Phase 3 (written at the Phase 3 close, 2026-10-07)

**Built and standing:** fee heads and settings; charge generation (monthly, yearly, once,
campaigns) with proration, late fees and concessions; payments with oldest-first allocation,
advances, receipts numbered per school per year, voids, refunds and their reversals,
carry-forward and its undo, cash custody and handovers; deposit-screenshot claims with office
verification; fee reminders and seven finance reports; dues clearance with the principal's
override; expenses with approval; staff leave with cover; salary structures, advances, the monthly
payroll run and payslips; platform billing (plans by student-count tier, invoices, grace); the
Approvals tab and page. Every money rule sits in database triggers as well as services; the R228
scripted year asserts the §0.20 identities against the tables.

**What Phase 4 must use rather than rebuild:**
- **Certificates read `GET /students/:id/dues-clearance`** (rule 20): it says cleared or not and
  carries the override. The override is refused for the principal's own child and lapses when the
  amount owed rises. Phase 4 builds the certificate, its number and reissue; not the dues logic.
- **Promotion at year end** (register item 15) will need "do arrears block promotion?" — ask the
  owner; the same endpoint answers it. Carry-forward moves advances; arrears stay in their year.
- **Exam fees** are the seeded `exam` head (per term, by campaign); results need no fee link.
- Results approval (item 21) can reuse the Approvals page and `GET /me/approvals` by adding a
  section, gated by its own capability.

**Deferred, with the condition that brings each back:**
- Real-driver proof and GitHub Actions billing — "Left to do" items 1 and 1b (owner).
- A guardian who is not the fee payer gets no message when the office verifies their claim at a
  lower amount or a corrected date (no message type; they see it in the app/web) — owner to decide.
- Rule 24 checked against nominal holdings: a principal still on the default password keeps the
  in-service override on staff status changes (whole-phase security low 2) — owner to decide; a
  one-line change (`holds` instead of `holdsNominally`, `staff-status.service.ts`) if not wanted.
- Rule 24 is not extended to money-out verbs (payee changes, refunds, payroll) — new register
  question, CLAUDE.md "Blocks Phase 1" table.
- Price tiers: none seeded; no platform invoice until the platform admin enters them
  (`docs/deployment.md`, "Before the first platform billing run").
- Accepted lows: a PDF deposit slip can be passed to the share sheet on the phone (temporary
  file deleted after); TalkBack can reach controls behind an open sheet (touch cannot); the
  cover picker loads full staff rows for a moment; the receipt prints "Sept", the payslip "Sep".
- Guardian merge has no verb (CLAUDE.md "Not yet specified").
- Not built by design (plan §6): refunds of allocated charges, partial platform payments,
  bank reconciliation and a general ledger, data purge after retention, staff contracts, inbound
  WhatsApp screenshots, an audit-log screen, iOS.

## What Phase 3 inherits from Phase 2 (written at the Phase 2 close, 2026-10-05)

**Built and standing:** messaging (one row per person, routing by contact capability, WAHA and
Cloud API WhatsApp drivers, Sendpk SMS, FCM push, email), the worker and its job model (claim-first,
enqueue after commit, payloads resolved through exception 3), bearer sessions and devices,
calendar and holidays, cover assignments, student and staff attendance with alerts and reports,
diary and remarks, announcements and the inbox, and the Android app (teacher, parent, student,
principal) with its offline outbox. `docs/deployment.md` holds every production requirement.

**Deferred, with the condition that brings each back:**
- **Real-driver proof on staging** (one WhatsApp through WAHA, one SMS through Sendpk, delivery rows
  `delivered`): blocked on the owner's Sendpk account and sender registration (PTA, 15-30 days)
  and a WAHA host. Until then both drivers are proven only against recorded fakes and the
  Sendpk adapter's assumptions; the 15 vendor questions in
  `docs/research/sms-gateways-2026-10-03.md` must be answered before the first real send.
- **WAHA's 7-day message-store purge**: no setting on the default WEBJS engine; needs the GOWS
  engine with message storage off and a change to how `WahaDriver` creates sessions. Decide at
  the first staging deployment.
- **Deployment topology**: WAHA has no published port, so the API must run as a container on
  `waha_private` (`docs/deployment.md`). The first real start of WAHA as uid 1000 on a read-only
  root is untested.
- **Firebase and Play**: push is off (`EXPO_PUBLIC_PUSH_ENABLED=false`) until the owner creates
  the Firebase project; the Android applicationId `pk.asms.app` is PROVISIONAL until the owner
  confirms it before the first Play upload. The splash image is a transparent placeholder.
- **The whole-school attendance percentage report** takes about 0.8 s at 3,000 students even
  with its index (the cost is `DISTINCT ON` over the window); a monthly per-student total is the
  rewrite if a faster report is needed (performance review, 2026-10-05).
- **The registers console** evaluates suspension per enrolment; revisit at 10,000 students.
- **Per-request memo of school settings** (about six round trips per register submit): not
  worth it yet.
- **The pre-slice-14 holiday notice path** (about 70 lines) can go once the owner retires
  slice-10 decision 1.
- **Media cache and webhook counters are per process**; with one worker that is one read per
  attachment.

**Growth figures for Phase 3 planning** (one school, per year, measured): attendance_marks about
1.3 M rows / 270 MB (per-period classes dominate), attendance_day_status 0.55 M / 150 MB,
messages 0.2 M / 100 MB, message_deliveries 0.13 M / 50 MB. Bulk inserts cost about 5
foreign-key probes per row by design (composite foreign keys); the 120 s job limit allows about
60,000 recipients per announcement.

**What Phase 3 must settle first** (register): items 7-11 block its schema (partial payment,
sibling discount, concession scope, proration, exit states), and 24-25 (late-payment charge,
banking) decide its first screens. Phase 3 has no plan yet: write
`docs/plans/phase-3-financial.md` in the Phase 2 plan's style before any code.

**Owner items still open from Phase 2:** register item 30 (privileged capabilities on a default
password), whether suspended students' families receive announcements (part of item 11), and
the provisional main-thread decisions listed under "Left to do" item 4.

## What Phase 2 inherits from Phase 1 (written at the Phase 1 close, 2026-10-03)

**Built and ready to use (plan §10)**
- `classes.attendance_mode` (`apps/api/prisma/schema.prisma`, enum `attendance_mode`) and rule 14:
  Phase 2 writes `attendance` with `UNIQUE (school_id, enrolment_id, date, period)`; a daily mark
  is the day's single period.
- `guardians.contact_capability` (enum `contact_capability`, rule 17): every routing rule reads it.
- Dated `teacher_assignments` are the only source of teacher scope
  (`TeacherAssignmentRepository.activeSectionIds`, read through `PermissionsService` →
  `scopeOf(session)`); the mobile app's "my classes" comes from here. Nobody can assign
  themselves except a principal (F1).
- Bearer sessions are accepted on every school route (`common/auth/school-session.ts`); React
  Native signs in with the same `POST /api/v1/auth/login` (cookie and bearer together are refused).
- BullMQ and a worker arrive with messaging. Job payloads carry a school id that the tenancy
  module validates into a `SchoolId`; the scheduler fan-out (named exception 3) is the pattern.
- Capability keys for attendance, diary and announcements already exist
  (`packages/shared/src/capabilities.ts`); later phases add screens, not keys.
- `school_counters` (model `SchoolCounter`) is ready for certificate and receipt numbering.
- Effective permissions are one pure function (`modules/access/effective-permissions.ts`) behind
  `can()`, `/me`, R14 and the permissions screen.

**Conventions Phase 2 must follow**
- Prisma sends enum conditions as a stable cast, so **a partial index whose WHERE is on an enum
  column is never used for reads**. Put status in the index columns
  (`20261003140000_enrolment_status_index` is the example).
- `strictUndefinedChecks` is on; tenant→`School` foreign keys are declared `@ignore` and written
  in hand SQL; new migrations come from `pnpm db:migration:new --name x` (create-only, then edit).
- No `Promise.all` inside a transaction; mail, queue dispatch and file moves after commit.
- After any API contract change: `pnpm --filter @asms/api build && pnpm --filter @asms/api openapi
  && pnpm --filter @asms/web api:generate && pnpm --filter @asms/mobile api:generate`; CI fails on
  drift in either client.
- Every endpoint has a contract in `docs/plans/contracts/` before or with its code; every mutating
  route is classified in the audit table in `apps/api/test/core/routes.e2e-spec.ts` (a new
  unclassified route fails the suite).
- Student-linked repository methods take the branded `Scope` (control 7); identity-revealing
  routes spend the shared `identity-probe` budget, one unit per identity number.
- Never log a raw error object: `failureLog(error)`.

**Accepted residual risks (stated, not solved)**
- Tenant isolation is application-layer only; a query that forgets its filter leaks another
  school's data. Controls 1–8 make this unlikely, not impossible (CLAUDE.md).
- Brand forgery is closed for request data by `asms/no-brand-in-request`, but type predicates,
  overloads and third-party generics can still produce a `SchoolId` without the mint files;
  review catches these, lint does not.
- A linked principal login's default password is known to whoever created the original login,
  and the platform admin knows every principal's default. Every such sign-in is now audited
  (`user.login_on_default_password`); closing it needs register item 30 and a one-time password
  for principals (owner decision).

**Deployment requirements before any internet exposure**
- An edge proxy (nginx or Caddy) that overwrites `X-Forwarded-For` (R101). Without it the per-IP
  login bucket is one global bucket and a single client can block every school's login. Staging
  must prove a forged header is ignored and distinct clients get distinct buckets.
- SSE-S3 on in production; SMTP `requireTLS`; gzip for `application/json` at the proxy (parents on
  metered data).

**Known leftovers (not defects)**
- An S3 error mid-download truncates the response; no bucket-prefix reconcile for objects without
  rows; two pg "client already executing a query" warnings in the full run (cause unconfirmed);
  `students-real.spec.ts` flaked once under `--workers 2`.
- Two teachers who both hold `class.manage` can assign each other; delegating `staff.create` +
  `user.account.manage` + `class.manage` together reaches every section. Worth a line of guidance
  on the grant screen.

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

## 2026-10-07/08 — Phase 4 built: waves M-P and the close (Fable 5.1 plans and reviews, Opus 5.5 builds) — DONE, phase gate PASS on `55255eb`

**Close (slice 36):** `55255eb` — the whole-phase review fixes ("Ab"/"Ex" on cards, exam
dates and cover entry, promotion own-child refusal, result.approve deciders, reports need
school-wide scope, the rules-locked flag), performance (submit-marks batched, two whole-table
scans removed, a notify-sweep index), complete R296/R300 scripts, `revised_after_apply` only on
changed figures, docs. CI run 37822174131 green; `phase-gate` PASS (limitations in "What
Phase 5 inherits").

**Waves and commits.** M (`87c5bff`): groundwork (message types, terms, result settings with
bands, class subjects, `asms_seed_year_results` for every year, the result-composition functions,
`MarksScope` read/write) + slice 29 set-up. Web edit-dialog bug (`d44ee92`): seven edit dialogs
had never saved since Phases 1-3 (react-hook-form `isDirty` read only in the handler); one test
per dialog now. N schema (`dcd9778`) + N (`2bc618b`): slice 30 marks entry offline on the phone
(two outbox lanes, per-row keys, `changed_elsewhere`) and slice 34 certificates (numbered per
type, leaving certificate dues-gated, B-Form only in its print, audited). O (`4a22fc4`): slice 31
result sheets — compose, submit, approve, publish, final sheet, `result-notify`. P (`012041b`):
slice 32 report cards and corrections (versions with full row sets), slice 33 parent/student views
and result reports, slice 35 promotion and year end (+ cancel), and the fix for wave O's one CI
failure (ResultsModule re-provided `TeacherAssignmentRepository`, so a Phase 2 spy missed it).

**Process notes.** Every wave: per-slice security and correctness reviews (Fable), one fix round
(Opus), commit, CI. Three session restarts stopped the wave P agents; they were resumed from disk
each time with no loss. One agent tried to delete a migration-history row after a network drop;
the permission guard refused it and it added a forward migration instead (kept: two small wave O
migrations). Running many API e2e suites at once on this laptop crashes node — run them one group
at a time.

**Decisions taken by the main thread during the build (owner may overturn):**
- Office staff do not hold `class.manage` by default (Phase 1 defaults kept; plan §3.1 corrected).
- Exam marks: an exam's write scope is minted for the day of entry inside its term (covers can
  enter exam marks during their dates only when they also hold the subject); exams can be dated.
- Card markers: an unexcused missed exam prints "Ab", an excused one "Ex", with a legend.
- Certificates: void voids the whole number; custom titles only on "other", never "leaving";
  alumni may receive a leaving certificate; prints refuse cross-site requests (also receipts and
  payslips).
- Corrections: the requester may withdraw; a result.approve holder decides (scope from marks.enter
  or result.approve); author ≠ approver and own-child refused in the database and the service, sole
  principal recorded `self_approved`; excusal after publication applies at once; a correction that
  changes no figure tells nobody; never-told families get `result_published`, not `revised`.
- Families: a teacher sees full cards only for sections they class-teach or cover; a student with
  a withheld card sees "Report card not available. Please ask your parent or the school office"
  and no figure; the phone reads results online only and shares the card as text.
- Promotion: complete only for a final class; a principal's override of their own child is refused
  unless sole principal; a principal may cancel an open sheet; year close ignores sections with no
  enrolment in force on the year's last day; `revised_after_apply` only when the student's own
  figures changed.

**For the owner to confirm (defaults built; the plan does not guess):** position within the
section, not the class (item 36); result messages go to the fee-payer guardians first, else the
primary contact, else every guardian with a phone (as receipts); `not_continuing` refused for a
suspended student (reactivate first); the optional `pass_rule = overall`; grace marks not built
(item 35); grade bands and pass mark values (item 32); B-Form on the leaving certificate (item 33,
default on).

**Performance at 3,000 students × 6 years** (2.4M marks, 575k result subjects): approve a
60-student section 0.8-1.0 s (budget 2 s), correction cascade 1.3 s, section print 0.17 s,
reports ≤ 0.15 s, guardian reads ≤ 0.06 s, submit-marks 60 rows 0.19 s after batching (was 0.82 s),
promotion apply 0.24 s (was 2.7 s). Two whole-table scans fixed; a partial index for the notify
sweep.

## 2026-10-07 (evening) — Phase 3 closed by the owner, real-driver proof deferred (main thread)

The owner asked to defer both outstanding owner items, the Sendpk account (with its PTA sender
registration) and the WAHA host, and to close Phase 3 on the code side: "can we defer this both?
is code side is done? we can check later". Phase 3 is therefore **closed with the real-driver
proof deferred**, exactly as Phase 2 deferred it. The `phase-gate` re-run on `0af67a9` had found
that proof to be the only unmet item. It remains a **hard precondition of the first production
deployment**: no school goes live on real messaging until one WhatsApp through WAHA and one SMS
through Sendpk show `delivered` on staging. The two skipped API tests are the real-provider
tests, and they run when the credentials exist. Before any further phase is called production
ready, `phase-gate` should be re-run once the proof is done.

## 2026-10-07 (afternoon) — CI green, Phase 3 gate re-run (main thread) — gate FAIL on the real-driver proof only

**CI back:** the repository went public and run 37586567674 started. Its API job failed on two
`TRUNCATE` guard tests that waited 30 s for a table lock behind the 12-month reports load
(`c781196`: `lock_timeout` 5 s, and a busy table proves the refusal from `pg_trigger` /
`pg_constraint`). The phone flows failed only on scrolling and on a screenshot path:
- `parent-deposit-slip` passed for the first time on CI;
- `parent-receipt` and `principal-approvals` were made to scroll to their targets (`30ef03d`);
- the screenshot is written to Maestro's own output folder (`0af67a9`).

**Run 37639293912 on `0af67a9`: green on both jobs.** The claim-sheet capture under FLAG_SECURE
measured 703 bytes (a black frame), which is the evidence for slice 27's security finding.
`b7c5b53` keeps it on green runs: `upload-artifact` skipped the hidden `.maestro` folder.

**Review verdicts on record for Phase 3:**
- per-slice `security-reviewer` and `code-auditor` on every wave;
- whole-phase `security-reviewer` **PASS** (three lows: two fixed, one an owner decision, rule 24
  nominal holding, register item 31);
- `performance-engineer`: one index and a chunked late-fee insert;
- `business-rules`: gaps G1-G3 and G6 fixed, R228 widened;
- `code-quality`: the tidy-up in `f852e1b`;
- `docs-maintainer` sweep: fixed in `0bbfdfb`;
- `code-auditor` on the close fix round: fixed in `4dd29c1`;
- `phase-gate` twice: FAIL on `4dd29c1` (team items fixed since), then FAIL on `0af67a9` on the
  real-driver proof alone.

**The gate's verdict on `0af67a9`:** every Definition-of-Done item is met — CI green, tests,
database and isolation, permissions, security, docs and git clean — except the plan's
precondition. "Re-gate only after the owner's real-driver proof; nothing else stands between this
phase and PASS."

## 2026-10-07 — Phase 3 wave L (slice 27), the phase gate, and the fixes after it (main thread) — gate FAIL

**Slice 27, the Approvals tab and page** (`1eace86`): `GET /me/approvals` returns the first ten
rows and the count of each queue the caller may act on (claims, handovers, expenses, leave), by
calling each queue's own list method, so the counts equal the queues (R227). The web has an
Approvals page plus the principal's dashboard tiles; the phone has an Approvals tab, second after
Home, so a principal's Inbox moves under More, and its decisions are online only (R226).
Review fixes:
- sheets render inside the protected screen (an RN Modal is its own Android window, not covered
  by FLAG_SECURE), and CI keeps the claim-sheet screenshot as evidence;
- the self-approved tile counts by decision date (`decidedFrom`/`decidedTo` on `GET /expenses`);
- "last 7 days" means seven days;
- the cover picker says when staff exceed 50.

**CI fixes** (`2f43cb5`): `onceMore` retries a service's own stale read up to three times (a
database-caused failure still gets one), because under CI load R236's interleaving lost the race
twice; the deposit-slip flow scrolls to its fields.

**Close fix round** (`f852e1b`, `4dd29c1`): the entry below.

**Phase gate on `4dd29c1`: FAIL.**
- Owner-blocked (unchanged until the owner acts): the real-driver proof; GitHub Actions not
  starting jobs.
- Team-fixable, **fixed after the gate, in the commit after this entry:**
  - (a) The deposit-slip Maestro flow had never passed. The API log of run 37571084037 shows the
    claim, the upload and the slip PATCH all succeeded; the flow waited for "Slip: with the
    school", which the phone shows only for a moment, because a claim the server lists with its
    slip leaves the on-phone section. It now waits for the server's row, then for the on-phone
    section to go. Until that flow passes, `parent-receipt` and slice 27's `principal-approvals`
    have never run on CI.
  - (b) This "Phase 4 inherits" section, the register row for rule 24's reach, and this state.
  - (c) A Playwright test for "Undo carry-forward".
  - (d) R16's whole-table scan widened to the Phase 3 free-text columns.
- Met, per the gate:
  - typecheck;
  - 440 API tests in the guard, payment, fee, report and approval suites;
  - 582 mobile tests;
  - migrations and the schema guard;
  - reviews on record;
  - docs;
  - git clean.

**Watch:** the late-fee sweep timing in `generation-perf` (3 overdue months, 3,000 students, 9,000
late fees) measured 3.4 s and later 4.9 s against its 5 s budget on this machine, whose test
database now holds about 1.6 M charges. If it flakes on CI, the next lever is the charge side of
the candidate query, which still scans the whole year (performance review, "secondary").

**To re-gate:** the owner fixes the Actions billing; one green CI run on HEAD, including the three
Maestro flows; the real-driver proof; then `phase-gate` again.

## 2026-10-07 — Phase 3 close fix round (Opus 5.5, from the slice-28 reviews) — DONE, committed `f852e1b` and `4dd29c1`

One agent, after slice 27 (`1eace86`, `2f43cb5`). Per item, what changed and its proof:

- **Performance.** Migration `20261007090000_phase3_close_indexes`: `enrolments (school_id, student_id,
  academic_year_id)` (the old `(school_id, student_id)` index stays). Collections-by-class now looks
  up the enrolment once per child and year (CTE), not once per receipt line: 0.46 s → 0.24 s at
  75,600 lines. `reports-perf` loads a realistic year (12 months × 3 heads = 108,000 charges, 9 months
  settled through real `payment_allocations` and receipt lines, one family in five two months
  behind); `generation-perf` adds a late-fee sweep over 3 overdue months (9,000 late fees, 3.5 s,
  budget 5 s). **The sweep found a real bug:** `insertLateFees` bound 12 parameters a row in one
  statement, so a large school's first sweep over several months passed Postgres's 65,535-parameter
  limit and failed; it now inserts in chunks of 2,000. Load note: the allocations' FK check on
  payments picks a range index on stale statistics (2 ms a row), so the test ANALYZEs first.
- **G1 carry-forward undo.** `POST /payments/:id/carry-forward/undo { reversalId, reason }`
  (`payment.record`, keyed, own child refused, audited `payment.carry_forward_reversed`): a new
  reversal kind `carry_forward_reversal` on the source payment names the carry-forward; the trigger
  raises the source's advance back and voids the carried payment. Allowed only while the carried
  payment is live and wholly unallocated with no refund or carry of its own (service, and the
  database: `payment_reversals_carried_spent`). Migrations `20261007090100_carry_forward_undo_kind`
  (the enum value alone) and `20261007090200_carry_forward_undo`; `payment_reversals_reverses_check`
  widened; a void nets the undo. Web: "Undo carry-forward" on the payments list. Contract slice-20
  §1.3a, plan route table, R57 and R68 tables. Test: payments.e2e "G1".
- **G2** in-grace waiver dry run allocates over every open charge except the late fees being waived
  (a fixed point), so an older open late fee takes its share first. Test: claims.e2e "G2".
- **G3** regenerating a voided past month applies a concession ended after the period began
  (`ended_at > periodStartsAt`, the school's timezone). Test: generation.e2e "G3".
- **G6** an approval asked to apply but finding nothing open says "no open charge to reduce" on the
  web (the response's empty `adjustments` already carried it; no contract change). Test: charges.e2e
  R239 (paid in full, then approved: `adjustments: []`, audited 0).
- **R228** scripted year: an admission through `POST /admissions` after the cut-off with its fee, an
  advance consumed by a newly generated month (R189), and the report-only lines checked against the
  tables (Σ reversals by kind, handover counted − expected and its cash_shortfall expense, concessions
  from charges, payroll Σ net and Σ paid). Header comment lists what is still written directly.
- **Security lows.** Tenant repositories may no longer import platform, billing or own-invoice
  repositories (lint; `AuditMetadataValue` moved to `repositories/audit-metadata.ts`; two new refuse
  fixtures). `src/messaging/push-money.spec.ts`: every money type rendered with amounts, the push
  body never holds a rupee figure (family money types are title-only; staff and platform money types
  carry no amount, so they stay out of TITLE_ONLY_PUSH).
- **Quality moves.** `PAYMENT_METHOD_LABELS` and `DEPOSIT_METHODS` in `@asms/shared` (eight copies
  gone, the slice-27 mobile approvals one included); `monthLabel`/`shortMonthLabel` in shared
  (payslip-compute's `shortDay` and the Intl-based ones untouched); `fieldInvalid`/`noIdentity`/
  `refusal` in `common/errors/constraints.shared.ts`, `ownChild` in `api-exception.ts`; `isPrincipal`
  in money-gates (three copies gone; web expense list and payment accounts use `useIsPrincipal`);
  `userNames` in `repositories/name-reads.ts` (finance reports no longer import PaymentRepository);
  one `ReasonDto` in `common/reason.dto.ts` for the `@Reason()` copies (`LeaveReasonDto` folded in:
  the schema name `ReasonDto` is unchanged, `LeaveReasonDto` is referenced by no client; the roles
  and users ReasonDtos validate differently and stay); 26 unused schema-alias types deleted from the
  Phase 3 web contracts (the six hand-written refusal-detail shapes kept as documentation);
  `plusDays` gone; `SEEDED_LEAVE_TYPES` compared with the seeded rows (seeds.e2e).

**Runs:** API tsc and eslint clean; full API suite 2,246 passed, 2 skipped, 13 failed: every failure
a timeout while Playwright and the dev server shared the machine (billing.e2e 1,452 s, lint-boundaries
1,804 s, the two perf suites); each of the four suites then passed alone. Measured alone: reports
load 83 s, defaulters 57 ms, collections worst 269 ms (by class); generation 1st 9.5 s, catch-up
0.5 s, late-fee sweep 3.4 s (budget 5 s; it needs `ANALYZE enrolments` after the bulk load, without
it the candidate lookup is a 10 s scan). reports-perf's timeout is now 600 s. Web tsc and eslint
clean; mocked Playwright 321 passed and 12 timed out under the same load, all 63 tests of those four
spec files then passed alone. Mobile tsc, eslint and jest (582) clean. The web "Undo carry-forward"
action has no Playwright test yet.

## 2026-10-06/07 — Phase 3 waves H-K: slices 18-26 (Opus 5.5 builds, Fable 5.1 reviews) — DONE

Built overnight at the owner's request ("complete Phase 3 this night"). Process as in Phase 2:
the schema is committed first, parallel build agents own disjoint files, then a security review
and a correctness review per slice (Fable), one fix round (Opus), the main thread's full check,
commit, push, CI.

**Commits:** `0981a86` plan · `75db041` wave H (slice 18: fee setup, payment accounts,
settings, rule 24) + wave I schema · `b3e9d8e` wave I (19 charges, 23 expenses, 24 leave,
26 platform billing) · `78d45cf` + `8a5ca92` wave J (20 payments, receipts, voids, refunds,
cash handover; 25 payroll; the Expo upgrade) · `ea6b815` wave K schema · `afb1eb3` CI 75 min ·
`f6d9977` test order · wave K (21 deposit claims, guardian Fees tab; 22 reminders, finance
reports, dues clearance) in the commit after this entry.

**Main-thread decisions taken during the build (owner may overturn):**
- Rule 24 is checked against what a user holds *nominally*, so a principal's in-service
  override still works (`holdsNominally`); the sole-principal lock applies to both paths that
  add a principal.
- Own-child separation of duties is keyed on the acting user (`asms.actor_user_id`), so system
  jobs never trip it; system-actor audit rows (`recordSystem`) need `metadata ? 'job'`.
- **Late-fee waiver on claim verify:** only when the verified payment settles the late fee's
  charge in full (a token deposit inside the grace no longer waives it — wave K audit).
- **Dues-clearance override** (rule 20): refused for the principal's own child, **with no
  sole-principal exception** (the dues must be paid); the override lapses when the amount owed
  rises above what was overridden (e.g. a void reopens a charge).
- Fee reminders: overdue families keep SMS before due-soon families on a short budget; the
  SMS pre-check is advisory (the dispatcher's `reserveSms` holds the cap); no "allowance ran
  out" notice when the cap was 0 before the run; manual sends throttled 5/min, 30/h.
- Claims: the guardian upload is `POST /me/uploads` (R78: a parent reaches nothing outside
  `/me`); slip images are served inline, PDFs as attachments (a sandboxed PDF renders blank);
  a co-guardian sees a claim's reference but not the other guardian's note; an office verifier
  who is the child's guardian gets 404 on the slip image but still sees the claim in the queue
  (cannot decide it).
- **Open for the owner:** a guardian who is not the fee payer gets no message when the office
  verifies their claim at a lower amount or a corrected date (no message type exists; they see
  it in the app/web). Price-tier values (no invoice until entered). Pre-commit hook allows 5 MB
  for the generated OpenAPI files and clients (they passed 1 MB in Phase 3).

**Reviews, wave K:** security PASS on both slices (no critical/high); raw SQL of all 18 report
queries filters `school_id` on every table and join. Correctness: no severe defect; one rule gap
(the waiver above) and five low findings, all fixed with tests. R228 scripted year asserts every
§0.20 identity against the database, now including a cash refund and a void after handover.
Performance at 3,000 students: defaulters page 50-91 ms, collections ≤ 140 ms, reminder job
10.3 s for 4,000 reminders (needs `ANALYZE` after bulk loads).

**Test-infra notes:** `apps/api/test/sequencer.js` runs the route suite last (its R57 check read
no audit rows on a fresh CI database). A slice 22 agent once disabled `audit_log_append_only`
in the *test* database to delete four bad rows it had written; agents are now told never to.

## 2026-10-05 — Phase 2 wave G: slice 17, the phase close (Opus 5.5 builds, Fable 5.1 reviews) — DONE, phase gate PASS on `e4494b2`

**Reviews:** whole-phase security PASS with two conditions, both closed: (1) WAHA's deployment
requirements now exist as a compose `whatsapp` profile (no published port, private plus
egress-only networks, dashboard and swagger off, non-root, read-only root, image pinned by
digest) and `docs/deployment.md` (WAHA, exactly one worker, the edge proxy, the bucket, env per
provider, backups, database settings); (2) a guardian unlinked from a child no longer sees that
child's alerts, remarks or diary entries in the inbox (R164 amended; announcements stay).
Performance at 3,000 students x three years: everything named is fine except four full scans of
`message_deliveries` per school every 2-15 min and the whole-school percentage report; five
indexes added (`20261005130629_phase2_close_indexes`, 96 ms to 0.07 ms on the SMS poll).
Mobile code quality: no duplicated screens; 13 tidy-ups, about 170 production lines removed net,
date and time formatters and enum display labels moved to `packages/shared` for web and mobile.
Docs sweep: CLAUDE.md rewritten for six named exceptions and six constructors, the register
updated with the owner's Phase 2 answers, README gained the worker step.

**Guardrails (R16, R57, R68):** identity and phone scans over every template, delivery rows, the
worker's log and the mobile log ring; every audit action read back by a test; a table of all
171 routes with their guard; tests use their own queue prefix and fail if a job reaches a
production-named queue. Found and fixed: the API log scrubber missed phones written with spaces
or dashes, and the notice-text check missed `+92 300 1234567`.

**Results:** lint and typecheck clean everywhere; API 130 suites / 1,779 tests (2 skipped,
real-provider); mobile 38 suites / 500 tests; web build; Playwright (see the commit).

**Phase gate, first run (03146b1, CI green): FAIL on two items, both closed.** (1) Plan §9's
end-to-end tests now take the late advice and the corrected notice from a register submit to
delivery rows for a keypad, a WhatsApp and a smartphone-without-WhatsApp guardian
(`test/attendance/alerts.e2e-spec.ts` from line 340), plus the WhatsApp-to-SMS fallback and an
SMS-disallowed type. (2) `code-auditor` on the wave G diff: no critical or high defect; the new
inbox predicate verified clean. Fixed: phone patterns in the API log scrubber, the notice-text
check and the mobile scrubber missed the 3+4 split (`0300 123 4567`, `+92 300 123 4567`); the
outbox scan could send after a pause raised during its read; `isIsoDate` accepted 30 February;
`formatTime` uses `hourCycle: 'h23'`. The gate accepted the real-driver proof as an owner-blocked
deferral on the conditions in "Left to do" item 1. Known, not proven: the mobile screens at
360 dp (the CI emulator uses the default device profile).

**Not done in Phase 2:** the real-driver proof on staging (owner accounts); see "Left to do"
item 1 and "What Phase 3 inherits".

## 2026-10-05 — Wave F CI: the Android app's first device run (main thread) — DONE

Seven pushes between `406ee5b` and `e4ec096` took the mobile CI job from "never built an APK" to
all seven Maestro flows passing. In order:

- **Build:** `babel-preset-expo` resolved through expo (`7054730`'s fix was uncommitted at the
  time); the splash plugin needs an image or Android resource linking fails (transparent
  placeholder `apps/mobile/assets/splash-icon.png` until a logo exists); the e2e APK builds for
  `x86_64` only (four ABIs took 20-54 min); the runner frees ~20 GB of unused toolchains before the
  emulator image; the ci job's limit is 45 min.
- **App defects found only on the device (now covered by Jest):** Expo replaces the global
  `fetch` and its responses are not `instanceof Response`; the openapi-fetch middleware returned
  the response, so every typed call threw after a 200 and sign-in said "No connection". The
  middleware now only inspects, and the Jest fake fetch answers like Expo's (114 tests fail with
  the old line). Same pass: uploads send an expo-file-system `File`, only real network failures
  read as offline, outbox sends that throw for other reasons fail once, the sign-in button always
  leaves busy, exclusive SQLite transactions get secure_delete/foreign_keys/busy_timeout and run
  one at a time. Then: the sync chip never appeared after an offline save (the outbox list was
  refreshed only by the worker, which skips listeners offline) — fixed for registers, diary,
  remarks and Discard.
- **CI script defects:** the principal's calendar and account are under More (six tabs); the
  emulator's launcher "isn't responding" dialog is hidden; `ci-run.sh` recorded the subshell's pid,
  so API restarts never happened (EADDRINUSE) and the update-required flow signed in — it now
  execs node and refuses to start while the old API answers. A failing flow prints the API log and
  saves a screenshot and `maestro hierarchy`.
- A staff-attendance test assumed the third newest workday was inside the 3-day window, which a
  Sunday breaks (failed on a Monday); it uses the newest workday.

Airplane mode worked through Maestro's `setAirplaneMode`; the adb fallback was not needed.

## 2026-10-04 — Phase 2 wave F: slices 14 and 16 (Opus 5.5 builds, Fable 5.1 reviews) — DONE

**Slice 14 (announcements and inbox):** announcements with drafts, scheduling, send-now, cancel,
attachments (5 MB, jpg/png/pdf), the audience picker (everyone, parents, students, staff, class,
section, student, family, staff member), per-person recipients with dedupe by login, by identity
hash and by phone, SMS units and the cap pre-check, delivery counts, `/me/inbox` for every role,
`MeDto.capabilityScopes`. Holiday notices now go through announcements (pre-slice-14 holiday rows
keep the old path; retiring it waits on the owner). Web screens on the generated client.
**Slice 16 (Android screens):** 16a teacher register (offline outbox lanes, coalescing, SQLite
migrations 2 and 3), diary with photo upload, remarks, parent and student family screens; 16b
principal Today (unrecorded registers, Record now inside the Today stack, assign cover), Announce
(composer, SMS usage, delivery) and the Inbox for everyone.

**Decisions taken by the main thread (contracts amended):**
- **Send-now and holiday publish no longer fan out in the request** (reverses slice-14 decision 9):
  a cold 3,000-recipient run timed out at 23.7 s against the 15 s request transaction. The request
  validates, checks scope and the SMS cap, sets `sending` and answers in about 0.1 s; the
  `announcement-send` job delivers (4.4-6.1 s at 3,000, its own 120 s transaction limit). After 5
  failed attempts the row returns to `draft` with `send_failed_at` and an audit row (migration
  `20261004160000_slice14_send_failures`).
- **Register submit honours `Prefer: return=minimal`** (marks become id, enrolmentId, outcome). The
  honest teacher scripted day (700 B headers per round trip, a full 25-item inbox page) measured
  56.0 KB against R160's 50 KB; with the minimal answer it is **44.9 KB**. Budget unchanged.
- The mobile composer follows slice-14 §12's audience list (wider than slice-16 §7.2, which defers
  to it); "Send without SMS" patches the same draft to normal and sends it (no duplicate draft); a
  saved draft locks its fields.

**Reviews:** security PASS twice (slice 14 + 16a; 16b). Fixed: a shared phone could get no
WhatsApp (dedupe now keeps the sharer who has a phone leg), attachment bytes read once per
recipient (now a bounded per-process cache), the cover sheet cached staff phones on the phone,
child names on a non-secure screen, CI logins in process arguments. Correctness found two high
defects, both fixed: two offline edits of one register merged into `reason: null`, which the
server refuses, so the register was discarded; and the send-now timeout above. Also fixed:
scheduling skipped the scope check, clock skew between worker and Redis, the 366-day range, an
endless sweep retry, Record now leaving the principal in a tab they lack.

**Also fixed this wave (main thread):** BullMQ refuses a custom job id containing ':' unless it
has exactly three parts, so absence alerts and attendance rollups were never queued, while every
test passed because none went through a real queue. Every id now uses '-'; new real-Redis tests
(`test/jobs/job-ids.e2e-spec.ts`, `test/jobs/outbox-dispatcher.e2e-spec.ts`), and the messaging
harness fails if any enqueue was swallowed. `TRANSACTION_TIMEOUT_MS` = 15 s; the CI Android setup
and `babel-preset-expo` resolution fixed (`7054730`). Mobile Jest pinned to two workers (it ran out
of memory with the default).

**Results:** lint and typecheck clean in all packages; API 130 suites / 1,743 tests (2 skipped,
real-provider); mobile 36 suites / 454 tests, `expo export` and the Gradle embed command clean,
expo-doctor 21/21; web build; Playwright full suite (see the commit); hook clean.

**Left from this wave (slice 17):** some API suites still enqueue to the real default `messaging`
queue (a running dev worker would pick them up); a holiday cancel waiting on a long notice job
could exceed its 15 s limit (safe to retry); the pre-slice-14 holiday path (about 70 lines) can go
once the owner retires slice-10 decision 1; the new Maestro flows (`principal-today`,
`principal-announce`, the inbox step) have never run: CI is their first run; the media cache and
webhook counters are per process.

## 2026-10-04 — Phase 2 wave E: slices 11, 12, 13, 15 (Opus 5.5 builds, Fable 5.1 reviews) — DONE

**Groundwork** (`f7925ca`): attendance, staff attendance, diary and remarks schema; one generic
history trigger reading `set_config('asms.actor_user_id'|'asms.change_reason', …, true)`
(`ChangeContextRepository`), statement-level summary bump triggers, contracts for slices 11–13
and 15.

**Slice 11 (student attendance):** registers per section/date/period with a complete first
submit, amendments with reasons and history, the amendment window, arrivals at the gate, the
alert lifecycle (09:30 floor, sent only if every recorded period is still absent, corrections
when the derived day changes, cap of three — `capped_at` marks a refused fourth), derived day
status and percentages as one pure function in `packages/shared/src/attendance-calc.ts` (129
table tests), per-enrolment day status and section summary with a version pair, nightly
recompute, deadline sweep, the CalendarListener, `ATTENDANCE_RECORDED_AFTER` live.
**Slice 12 (staff attendance):** day sheet, amend, not-self in service and trigger, working days
via `isStaffWorkingDay`. **Slice 13 (diary and remarks):** the guardian/student `students`
scope (bound on `@RequireCapacity` routes; `MeDto.children`, `MeDto.staffId`), diary entries
with attachments and stored thumbnails, remarks with a supersede chain and visibility levels,
`/me/children/*` and `/me/student/*` routes, `POST /uploads` widened (R171).
**Slice 15 (mobile foundation):** `apps/mobile`, Expo SDK 57 / React Native 0.86 / React 19.2,
Android, bearer sign-in, tabs composed from `/me`, SQLite cache and outbox with honest states,
push wired but off until Firebase exists (`EXPO_PUBLIC_PUSH_ENABLED=false`), update screen,
log scrubber. Exact versions are in the slice-15 build report: expo 57.0.26,
react-native 0.86.3, react 19.2.3, expo-router 57.0.24, @tanstack/react-query 5.104.0,
openapi-fetch 0.17.0, jest 29.7.0 + jest-expo 57.0.5, Maestro 2.11.0 (CI), JDK Temurin 17 (CI).
**This machine has no Android SDK, JDK or Maestro**: the app has never run on a device; the CI
`mobile` job (emulator + Maestro) is its first real run. Helpers `ApiError`/`describeApiError`
and the date formatters moved into `packages/shared` with re-export shims in the web.

**Decisions taken (owner to confirm where marked):**
- Out-of-scope registers and diary: never assigned → 404; assigned on other dates → 403
  `not_assigned_on_date` (one shared `refuseOutsideDate`).
- Unsent mobile writes after a 401 survive **at most 7 days** for the same user, then are
  discarded with a visible notice (security review confirmed; R155 amended). Outbox bodies
  carry ids, never names (rule for slice 16).
- **PROVISIONAL, owner to confirm before the first Play upload:** Android applicationId
  `pk.asms.app` (`pk.asms.app.dev` for dev builds).
- A subject teacher's whole-class row no longer reaches archived sections (slice-10 contract
  amended).
- The dev seed (`seed:dev-school`) refuses a non-local database unless `ALLOW_DEV_SEED=1`, and
  requires `DEV_SCHOOL_PRINCIPAL_PHONE`.

**Reviews:** API/web security PASS (four low, fixed: Scope on student-linked reads, stored
thumbnails + throttle, 404/403 alignment, archived sections); mobile security PASS with
conditions (two medium fixed: SQLite secure_delete + WAL removal on wipe, seed guard; four low
fixed); correctness found no critical or high defect (cap-test assertion, `correctionsCapped`
meaning, two web glitches, doc drift — fixed). Refactors: `withIdempotencyKey`, `diffMarks`,
`daysBetween`/`assertRange`, `SchoolSettingsReader`, `name-reads`, one throttle guard, raw
`FOR UPDATE` staff locks (+ `marked_by`/`marked_at` frozen), web `useMarkSheet` and one
refusal-message table.

**Results:** lint and typecheck clean in all packages; API 121 suites / 1,633 tests (2 skipped,
real-provider); mobile 18 suites / 200 tests, `expo export` and `expo-doctor` clean; web build;
Playwright 237/237 including the real-API specs; hook clean.

**Left from this wave:** `/me` does not say where a capability comes from, so the web may show a
teacher with a school-wide grant fewer diary/remark controls than the server allows (never more);
slice 16 should add the source to `/me`. The thumbnail pipeline and webhook counters are
in-process. The Android app has not run on a device.

## 2026-10-04 — Phase 2 wave D: slices 9 and 10 (Opus 5.5 builds, Fable 5.1 reviews) — DONE

**Groundwork** (`7f57476`): shared enums, 27 error codes, the message-type table, teaching-day
functions, office staff gain `attendance.student.mark`; messaging and calendar schema; worker
entry point (`pnpm --filter @asms/api worker`), queue tenancy mint with `runAsSchool`, lint
boundaries (bullmq, drivers, the mint). Contracts `docs/plans/contracts/slice-9.md` and
`slice-10.md`. Dependencies pinned: `bullmq` 6.3.11, `firebase-admin` 14.5.0;
`@nestjs/schedule` removed.

**Slice 9:** `NotificationService` (one row per person, routing by contact capability and
priority, templates with the school name first), outbox dispatched after commit, a claim-first
processor, WhatsApp through WAHA **and** the Cloud API (selectable per school, platform default,
and `WHATSAPP_PROVIDERS_ENABLED` per deployment — only enabled providers need keys), Sendpk SMS
with polled delivery status, FCM push, email; webhooks verified over raw bytes (exception 5);
platform delivery-health rollup (exception 6); SMS cap by segment; daily `session-purge`.
Bearer sessions for the app (token in the body only, refused with `Origin` or a cookie,
lifetimes by capacity), `X-App-Version` floor (426), devices, revoke-others,
sign-out-everywhere, `MeDto.capacities/assignments`. **R80 lifted:** a suspended school is no
longer read-only (owner, 2026-10-03); the platform's suspend dialog offers to set the school's
SMS allowance to 0, ticked by default.
**Slice 10:** holidays as date ranges with an exclusion constraint, one notice per person,
cancellation withdraws unsent notices; teaching days (shared function); cover assignments with
full class-teacher scope for their dates; `scopeOf(session, { capability, on })` and
`rolesOn`; section and class changes close the old enrolment on `effectiveOn − 1` and open a
new one (R174; `section_id` frozen).

**Reviews:** security PASS (two medium — provider keys forced in production, suspended
schools' SMS spend — and five low, all fixed); correctness found no behaviour defects in the
core flows; fixed a worker test that scanned the whole test DB, the missing session purge (the
shipped migration forbade deleting devices — dropped, owner-side decision taken by the main
thread), sweep churn on paced messages, after-commit callbacks running inside the closed
transaction, a cap-reached retry loop, allow-list check at attempt time. Refactors: one
`diffFields`, one `recoverConstraint`, one `ContactResolver`, one title source.

**Also fixed this wave:**
- The "flaky" `students-real` admission failure, seen three times since wave B, was real: the
  web wizard's idempotency key was a dashless UUID, and about one in twenty-five holds 13
  digits in a row, which the API refuses as identity-shaped. `newIdempotencyKey()` in
  `packages/shared` keeps the dashes (no run can exceed 12); test `test/core/idempotency-key.spec.ts`.
- A test helper read "today" in UTC while the API reads the school clock; it failed only
  between 00:00 and 05:00 Karachi.
- The seed script stopped compiling when `failureLog` moved into an import chain carrying
  pino types; `failureLog` now lives in `common/errors/failure-log.ts`.

**CI green on `578c210` (run 37157788364).** **Results:** lint and typecheck clean; API 100 suites / 1,298 tests (2 skipped — real-provider
contract tests, run only with `RUN_DRIVER_TESTS=1`); web build; Playwright 192/192 including
the real-API specs; hook clean.

**Left from this wave:** the SMS poll and delivery-health rollup scan `message_deliveries` per
school with no supporting index (performance-engineer at slice 17); Prettier reports
line-ending differences on many files (not enforced); a cover cannot yet be arranged for a
section with no class teacher; Sendpk's real answers to the 15 vendor questions replace the
adapter's recorded assumptions before the first real send.

## 2026-10-03 — Phase 2 plan written and reviewed (Fable 5.1) — DONE

`docs/plans/phase-2-daily-operations.md`: nine slices (9–17), about 40 days, rules R105–R175,
schema, endpoint tables with shapes and codes, the decisions it needs. Scope: messaging core with
a worker and four drivers (push, WhatsApp via WAHA, SMS, email), calendar and holidays, student
attendance (registers, corrections with history, arrivals, alerts, derived day status, rollups),
staff attendance, diary and remarks, announcements with the shared audience picker, and the first
mobile app (Expo, Android) with offline registers.

**Reviews and what they changed** (all four ran on the first draft; the file is the second):
- `business-rules`: the absence alert would have sent "absent" at 8:35 in the deck's own
  example and never corrected it → alerts at a clock time (09:30) with a floor, sent only if every
  recorded period is still absent, corrected on any later change, reversals capped; the
  percentage changed meaning between daily and period modes → the day is the unit in both; the
  derived-status precedence hid a mid-day absence → reordered with `partial`; a section change
  edited in place made past rosters unreconstructible → section change becomes close/open (R37
  amended, R174); a holiday reached parents twice → the announcement is the notice; holidays
  declared after registers were recorded → R167; nobody but the principal could record an arrival
  → `POST /attendance-arrivals` (R168); the submit body had no reason while the trigger demanded
  one → reason on submit, `STALE_STATUS` on amend; seven "defaults" were really owner decisions
  → §1.2.
- `security-reviewer`: the worker's school lookup would have let any module mint a tenant from a
  string → a one-method platform repository importable only from the queue mint, zod-validated
  payloads, a scoped conditional claim per job, `runAsSchool`; an ended guardian link kept access
  → removed on the next request (R164); guardian scope ignored `can_login` → fixed (R163);
  password change minted a cookie for a phone → rotation on the caller's channel; WAHA message
  ids embed the phone number and the scanner misses 12-digit numbers → hashed references, phone
  pattern in the scanner, mapped error codes; a bearer token could be minted from the browser →
  refused with `Origin` or a cookie (R170); staff bearer lifetimes shortened (14 d/90 d); device
  revoke and office sign-out-everywhere (R169); webhook hardening as rules (R172); WAHA deployment
  requirements; uploads capability (R171); dated role-aware scope (R175).
- `data-architect`: holidays as single dates made a summer break 70 rows and 70 notices → date
  ranges with an exclusion constraint; array-of-id columns dodged the schema guard → join tables
  and the guard regex extended; `recipient_kind/id` → three nullable FKs with a CHECK (changing
  this later rewrites every message); the marks table at ~4.8 M rows/school-year → lean (no
  `student_id`, `marked_by`, year; four indexes), one-statement upsert, trigger-written history
  via `set_config(…, true)`; a boolean dirty flag lost updates → version pair; the section summary
  cannot serve report cards → per-enrolment `attendance_day_status`; `whatsapp_numbers` →
  platform-owned (exception 6); a webhook's provider-ref lookup → named exception 5; `cover`'s
  enum value must be its own migration; `devices.push_token` must not be unique.
- `api-designer`: the mobile app could not log in under the Phase 1 Origin rule → the check now
  applies only to requests with neither `Authorization` nor `X-App-Version`; two idempotency
  mechanisms → the slice-6 header only; `PUT` → `POST /sections/:id/submit-register`; every
  `@RequireCapacity` route under `/me/<capacity>/*` (R78 snapshot); `MeDto` gains `capacities` and
  `assignments`; full request/response/error tables per slice; the groundwork list of 23 error
  codes and 22 enums (§6.1).

**Decisions the plan takes provisionally (owner to confirm or overturn):** `late_counts_as`
default present with an optional cutoff; amendment window 3 days (the deck said end of day);
remarks default guardian-visible, on enquiry; bearer lifetimes 30/180 d guardians, 14/90 d staff;
office staff do not read the diary by default.

## 2026-10-03 — Slice 8: Phase 1 close (Opus 5.5) — DONE

**Whole-phase `security-reviewer`: FAIL → fixed → PASS.** Tenant isolation found sound (no path
from one school's session or job to another's data). Blocking finding F1: a teacher given
`class.manage` could assign themselves to every section and widen their own row scope — now
refused unless the actor holds `role.manage` (test `test/staff/assignments.e2e-spec.ts` "F1 / R74").
Low fixes, each with a proving test: F2 every default-password login audited
(`user.login_on_default_password {afterOfficeReset}`, replacing `user.login_after_office_reset`);
F3 identity-probe budget spent per identity number (an admission costs up to 5); F4 no raw error
objects in logs (`failureLog`); F5 permissions loaded only after the password verifies, and not
for a locked, disabled or terminated-school account (`test/school-auth/login.service.spec.ts`);
F7 student-linked repository methods take the branded `Scope`. F6 is the edge-proxy deployment
requirement (no test possible here). Rate limits stop charging later limits once one refuses.

**Rule coverage (`test-engineer`):** every R1–R104 except R15 has a named test. New: R16 identity
scans over audit tables, captured logs, responses and the built web bundle; R57 audit table over
every mutating route (a new unclassified route fails); R62 isolation-coverage guard; R92 mail
failure; R99 office-reset races; R104 ciphertext binding. Two defects found and fixed: issue-login
audit rows had no reason (R57 — now an optional reason with a fixed fallback per path, strings in
`packages/shared/src/logins.ts`), and a CNIC-shaped placeholder shipped in the web bundle (now
`#####-#######-#`).

**`phase-gate` (first run): FAIL on evidence, not code.** Closed: CI could not reach object
storage (and Docker Hub no longer serves `minio/minio` — **owner chose Chainguard's MinIO, pinned
by digest**, in compose and CI; older checkouts chown the volume once, see README); tablet width
(`apps/web/e2e/responsive.spec.ts`, every route at 768 px, no page-level overflow); F5 proofs;
`code-auditor` on the close-out diff (four lows, fixed); "What Phase 2 inherits" written below.
**Fresh clone verified** (into `D:\asmsf`, dev stack stopped): README followed literally to a
signed-in principal on the default password — about 5 minutes with a cold `pnpm install`. One
README addition from it: clone into a short path on Windows (260-character limit).

**Results:** lint and typecheck clean; API 72 suites / 955 tests; web build; Playwright 157/157;
hook clean.

**Main-thread decisions in this slice, for the owner to confirm:** principals are unrestricted
peers (slice 7); issue-login reason is optional with a fixed fallback; the identity-probe budget
(30/min, 300/h per user) caps one clerk at about 50 admissions an hour — raise it before
admission season if that is too low.

## 2026-10-03 — Wave C part 1: slice 7 and slice-8 preparation (Opus 5.5) — DONE

**Slice 7** (contract `docs/plans/contracts/slice-7.md`, migrations `20261003130000_slice7_roles_grants`
and `20261003150000_slice7_history_guards`): custom roles (create, edit with reason when keys are
removed or a held role gains keys, archive, no unarchive), per-user grant and revoke rows
(append-only, ended with a reason, DB trigger refuses anything else), assigning a custom role
through the one "Give a role" dialog, `GET /users/:id/permissions` (role defaults, deltas, effective
lines with source and scope). `EffectivePermissions` is a pure function
(`modules/access/effective-permissions.ts`, 80+ unit tests) behind `can()`, `/me` and R14.
`role.manage` is unreachable three ways (DTO, DB CHECK, read filter). Staff leaving ends grants.
**Decision taken by the main thread, for the owner to confirm:** principals are unrestricted
peers — grants and revokes on a live principal are refused (409 `TARGET_IS_PRINCIPAL`), and
becoming principal ends existing rows. Reason: the security review showed a revoke on a principal
could be undone by another principal (via assignment or office reset), so offering it was a false
control. Also: custom-role-only staff now show their role (`customRoleNames`); R96 race test is
deterministic; cross-tenant tests assert the composite FK names.

**Reviews:** security PASS (four low, all fixed: principal peers, reason on widening a held role,
history triggers on roles tables, self-end CHECK). Correctness: three validation defects fixed
(`null` bypassed R95's reason and caused 500s; 13-digit role key caused a 500 via the audit
no-ID CHECK), stale permissions view, a slice-4 lock-order inversion in staff status change
(now restarts to keep user→staff order).

**Slice-8 preparation:** `docs-maintainer` sweep → README now walks a fresh clone to a signed-in
principal, `--wait` on compose, API build before Playwright; CLAUDE.md exceptions 1–3 match the
code (login-spike recorder recorded as part of exception 2, **awaiting owner confirmation**).
`performance-engineer`: nothing blocks; one index added (`20261003140000_enrolment_status_index`).
**Rule for Phase 2:** Prisma sends enum conditions as a stable cast, so a partial index whose
WHERE is on an enum column is never used for reads — put status in the index columns instead.
Not verified: response compression (belongs on the edge proxy). Web `code-quality` → about 750
lines removed (shared list filters, `QueryStates`, formatters, validation, issue-login dialog,
error messages), demo route deleted, dashed CNIC no longer reaches `q` on users/schools search,
create-staff and create-guardian forms have no-permission states.

**Results:** lint and typecheck clean; API 63 suites / 892 tests; web build; Playwright 125/125
(one flake recorded under Left to do); hook clean.

## 2026-10-03 — Wave B: slices 4 and 6 (Opus 5.5) — DONE

**Built in parallel** after the groundwork commit (`c03e730`: schema for slices 4 and 6,
contracts `docs/plans/contracts/slice-4.md` and `slice-6.md`, the `asms/no-brand-in-request` lint
rule that closes the slice-0 residual risk, wave-A clean-ups). Five build agents: slice 4 API,
slice 6 API part A (students, enrolment, links, logins), part B (admission, readmission,
documents, uploads), staff web, students-and-admission web; then one agent swapped the web to
the generated API types.
- **Slice 4:** staff records (encrypted CNIC, status changes, leaving ends role assignments),
  staff issue-login reusing wave A's reset-on-link, system-role assignment, teacher assignments
  (class teacher one per class at a time, subject teachers, ending with a reason). Teacher row
  scope comes from assignments active today in the school's timezone (`common/school-clock.ts`).
- **Slice 6:** students (encrypted B-Form, status transitions in `@asms/shared`), enrolments
  (roll numbers, change class/section), guardian links (primary contact, fee payer, login flag),
  student logins, the admission wizard (one transaction: student, guardians found by CNIC or new,
  enrolment, staged documents; idempotency key), readmission, documents in S3-compatible storage
  with staged uploads and a scheduled sweep (scheduler fan-out, named exception 3).
- **Web:** staff list/detail/create with assignments; students list/detail (enrolments, guardians,
  documents, status history), admission wizard, readmit form. A lost session mid-wizard opens a
  sign-in dialog in place instead of redirecting (`useSuppressSessionRedirects`), and a sign-in
  as a different user abandons the form.

**Reviews and what they changed**
- `security-reviewer`: **PASS**, one medium and three low, all fixed. Medium: B-Form/CNIC
  existence probes were throttled only on the lookup route; admission, student patch, and
  guardian and staff create/patch revealed the same thing unthrottled. Now every one of them
  spends one shared per-user `identity-probe` budget (30/min, 300/h; `common/rate-limit.ts`),
  with tests. Low: the platform could link a student login as principal (now 409
  `USERNAME_IN_USE`); an upload object could be orphaned (row now written before the object, and
  a failed write expires the row for the sweep); the sweep's lint exemption now allows only the
  fan-out repository; admission creating a guardian or enabling a guardian login now needs
  `guardian.manage`.
- Correctness (no high findings): roll-number race now returns `details.enrolmentId` (admission
  and readmission); admission refusal order matches contract §6.3; teacher-assignment race
  fallback used the wrong default start date; a missing stored object is logged by document id.
  `enrolments_class_id_fkey` is deliberately left unmapped (cannot fire; a 500 would mean a bug).
- Quality: one throttle factory replacing three guards; `IsCalendarDate`, `NoIdentityNumber`,
  `identityAad` and `fieldRefused` each exist once in `common/`; student and staff enums in
  `@asms/shared`; StudentLoginRepository removed; `ScheduleModule` registered in `AppModule`.
- Contracts amended to match the code: slice-4 §1 lock order; slice-6 §2 nullable fields, §3.4
  shared budget, §6.1 upload order, §6.3 refusal order, §8 audit id lists as comma-joined
  strings; slice-5 §3.6 shared budget.
- The two login-throttle tests that failed when runs overlapped now use random usernames.

**Final results:** lint and typecheck clean in all three packages; API 58 suites / 761 tests
(1 `it.todo` for slice-7 grants); web build; Playwright 97/97 including
`e2e/students-real.spec.ts` against the real API (teacher sees only their section's student);
pre-commit hook clean.

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
in first; this is audited (`user.login_on_default_password`, metadata
`afterOfficeReset`; renamed in slice 8) and locks the real principal out, so
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
