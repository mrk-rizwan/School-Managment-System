# ASMS work log — session handover

**Read this first in every session.** It is the single running record of what has been done,
what is in progress, and what is left. Any model (Fable, Opus, Sonnet) picking up this project
must update it before ending a session. Newest entry at the top. Dates are absolute.

Working arrangement: **Fable 5.1 does planning, review and the final build plan. Opus 5.5
writes the production code.** Do not start application code in a planning session.

---

## Current state (keep this section accurate)

- **Phase:** Pre-build. No application code exists. Repository holds planning docs, agent
  definitions, hooks and git hygiene only.
- **Phase 1 is unblocked** (2026-10-01). The product owner confirmed one campus per school,
  CNIC-digit login with a default password, roles plus grantable capabilities, per-period
  attendance storage, per-class sessions, PKR whole rupees, English only. These are settled
  rules 11–16 in `CLAUDE.md`.
- **Phase 1 build plan is written and reviewed:** `docs/plans/phase-1-foundation.md`. It is
  what the Opus session executes, slice by slice, starting with slice 0 (Docker scaffold, CI,
  the forced-RLS spike). Nothing in the "Blocks Phase 1" tier is open.

## Left to do (ordered)

1. **Opus session: execute `docs/plans/phase-1-foundation.md` slice 0.** Record the RLS spike
   verdict and the pinned Laravel/Filament versions here.
2. Slices 1–8 in order, each gated (tests, security-reviewer, code-auditor, phase-gate), each a
   commit, each logged here.
3. Product owner: schema-freeze items 7–13 and 23–26 answered before the end of Phase 1; the
   CNIC-correction-after-login question raised by the plan (slice 4); whether a numeric reset
   code is required instead of the built-in reset link (slice 2).
4. Product owner, optional: sample seed data (presentation slide 23) so seeders use real shapes.

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
