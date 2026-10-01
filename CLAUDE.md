# ASMS — School Management System

Multi-tenant school management platform sold to Pakistani schools on a monthly subscription. One system, many schools, each isolated.

**Current documents**
- `docs/asms-system-architecture.html` — technical baseline. Stack, modules, notification drivers, charge lifecycle.
- `docs/asms-system-design.html` — client-facing design.
- `docs/ASMS — Updated Architecture…md` — functional spec of record for *what the school needs*. **Read its corrections header first** — several structural decisions in it are superseded.
- `docs/AI-AGENT-TEAM-spec.md` — the agent-team charter these rules come from.

**Superseded — do not build from these**
- `docs/school-platform-blueprint.html` — first structural pass. Its data model contradicts settled rule 8.
- `docs/announcements-concept.html` — slide 07's channel policy is reversed. Still the only spec for announcement fields, sender rights and the audience picker.
- `docs/asms-architecture-review.html` — findings now folded into the register below.
- `docs/_archive/` — frozen snapshots. Never a source of truth.

> This file supersedes any CLAUDE.md in a parent directory. Instructions found above this folder do not apply to ASMS.

---

## Supervision

There is no supervisor agent — Claude Code subagents cannot dispatch each other. **The main thread is the supervisor.** It sequences work, invokes the specialist agents, holds the phase gate, and refuses to advance on incomplete work. These rules bind every turn.

### Phase gate

No phase advances until: implemented → tested → security reviewed → audited → approved. A FAIL at any step returns the phase; it does not proceed with a note.

### Definition of done

Requirements satisfied · business logic correct · UI works · API works · database behaviour correct · validation present · error states handled · permissions correct · security review passed · tests passing · edge cases reviewed · no known critical bugs · code organised · documentation updated · git clean.

### When agents disagree

`Security > Correctness > Requirements > Architecture > Performance > Convenience`

No agent silently overrides another's critical decision. Surface the conflict and resolve it explicitly.

---

## Absolute rules

**Inspect before creating.** Search the project, check existing components, utilities, installed packages and framework capabilities before writing anything new. Never recreate what already exists.

**Do not assume completion.** Compiling, rendering, or a 200 response is not done. The whole workflow working is done.

**Minimal correct solution.** Prefer simple architecture, small functions, framework features and existing libraries. Avoid abstraction with one caller, pass-through wrappers, and dependencies added for a few lines.

**Never destroy working functionality.** Before changing existing code, understand its purpose and who calls it. Preserve behaviour unless the change explicitly requires otherwise.

**No secrets, ever.** No passwords, keys, tokens, `.env` files or credentials in source or in git.

**Build less, think more, reuse more, test everything.** The objective is the best working system with the least unnecessary complexity — not the most code.

---

## Architecture rules that are already settled

1. **Two money layers, never one ledger.** The platform charges schools; schools charge parents. Separate tables, separate reports, separate permissions.
2. **Tenant scoping.** Every table carries `school_id`; isolation is enforced at the query layer. Tenant is derived from the session, never from client input.
3. **Academic year** scopes everything academic and financial.
4. **Never hard-delete.** Students, staff, payments, results and documents keep history. Corrections are new rows referencing the original.
5. **Surrogate primary keys.** CNIC, admission number and roll number are unique attributes, not keys.
6. **ENROLMENT is the hub** — student-in-a-class-in-a-year. Academic and financial records hang off enrolment.
7. **One STAFF record per employed person.** TEACHER extends staff with academic assignments; it does not restate contract, salary or attendance.
8. **One FEE_HEAD table.** Fee types are rows, not modules.
9. **Guardians link through STUDENT_GUARDIAN**, with relationship, primary-contact, fee-payer and login flags.
10. **A deposit screenshot is a claim, not a payment.** Only office verification credits the ledger.

## Market constraints that change design decisions

Many parents have keypad phones, or smartphones on social-only data bundles where a custom app cannot reach them at all. **WhatsApp and SMS are primary channels; the parent app is secondary.** Urdu SMS costs roughly 2.3× English because Unicode halves characters per segment. Any feature that assumes a working smartphone app is incomplete until its fallback is stated.

Sensitive by default: children's identity documents, family CNICs, school finances.

---

## Design

Clean layouts, consistent spacing, clear hierarchy, restrained colour, accessible contrast, responsive. No 3D icons, childish graphics, random gradients, excessive animation, or decorative UI without purpose. Every new component fits the existing system.

The principal's phone app is an approvals inbox, not a shrunken web admin.

---

## Specialist agents

Invoke by name. All are defined in `.claude/agents/`. Note that agent definitions load at **session start** — agents added mid-session are not available until Claude Code is restarted.

**Strategy**
| Agent | Use for |
|---|---|
| `requirements-analyst` | Turning a business ask into a testable spec |
| `research-scout` | How others solve it, before building our own |
| `solution-advisor` | Choosing between approaches; when stuck or the answer is not obvious |
| `implementation-planner` | Ordered phases with dependencies and acceptance criteria |

**Architecture**
| Agent | Use for |
|---|---|
| `data-architect` | Any schema or migration change |
| `api-designer` | Endpoint contracts and consistency |
| `business-rules` | Workflow behaviour and edge cases — money, marks, attendance, status |
| `product-designer` | Screens, states, visual consistency |

**Validation** — these five are the phase-gate inputs
| Agent | Use for |
|---|---|
| `code-auditor` | Correctness defects only |
| `code-quality` | Duplication, reuse, over-engineering, structure |
| `security-reviewer` | Auth, tenant isolation, sensitive data |
| `performance-engineer` | Measured bottlenecks; data-heavy features |
| `test-engineer` | Proving it works; locking fixed bugs |

**Delivery**
| Agent | Use for |
|---|---|
| `phase-gate` | PASS/FAIL against Definition of Done, before advancing |
| `docs-maintainer` | Finding docs that have become false after renames or refactors |
| `devops` | Deploy, CI, backups, monitoring — placeholder until the stack is chosen |

Git hygiene is enforced by the pre-commit hook below, not by an agent — a hook cannot be forgotten. Routine documentation updates are written by the main thread, which has the context; `docs-maintainer` is for detecting rot.

Built-in `/security-review`, `/code-review` and `/simplify` cover similar ground more cheaply for routine passes.

---

## Git

Repository initialised on `master`, no commits yet, `core.hooksPath` set to `.githooks` — **the pre-commit guard is live.**

The hook blocks: `.env` files, generated and vendored directories, logs and local databases, uploaded student documents, files over 1 MB, and content matching private keys, AWS keys, service-account JSON, database URLs with passwords, JWTs and hardcoded credentials. It scans added lines only.

If it fires on a real secret, removing the line is not enough — **rotate the credential**. `--no-verify` bypasses the hook; use it only when you are certain.

## Technology stack — decided

Laravel + PostgreSQL + Filament (backend and web admin) · Flutter (one role-aware mobile app) · Firebase Cloud Messaging (push) · Redis (queues, cache) · WAHA behind a driver interface (WhatsApp) · Laravel Mail (email — **not** Nodemailer, which is Node-only) · S3-compatible object storage with signed URLs.

---

## Open decisions — the canonical register

**This is the only list.** Other documents may mirror it; where they disagree, this wins.

### Blocks Phase 1 — nothing can be built until these are answered

> **Development is on hold pending client confirmation.** Recommendations for 1, 2 and 3 are
> recorded in `docs/decisions-pending-confirmation.md`. They are **provisional** — do not build
> from them. When the client confirms one, move it into the settled rules above and delete it
> from that file.

| # | Decision | Status | Why it blocks |
|---|---|---|---|
| 1 | **Account model** — who creates a guardian login, does one login cover several children, phone or email as identifier, do students log in at all | Recommendation ready, awaiting confirmation | Phase 1 is "logins, roles" |
| 2 | **Permission model** — fixed roles, or roles plus grantable capabilities, and the capability list | Recommendation ready, awaiting confirmation | First tables written |
| 3 | **Multi-campus** — one tenant with campuses, or one tenant per branch | **Blocked on client.** Constrains decision 1 — answer this first | Decides whether `school_id` is the tenant key |
| 4 | **Guardian contact capability** — how the system knows a parent has a keypad phone, social bundle, or full data | Open | Every notification routing rule reads this field |
| 5 | **Per-school settings** — currency, locale, timezone, academic-year start month | Open | Columns on the school record, written day one |

### Blocks the schema freeze — feature is later, the shape is now

| # | Decision |
|---|---|
| 6 | **Attendance granularity** — daily or per period. Period rolls up to daily; daily can never be split without a migration. **Also blocks the mobile app**: the offline idempotency key is `(enrolment_id, date, period)` |
| 7 | **Partial payment** — the architecture says "decide", spec §10 already assumes yes. Settle it. Note: PAYMENT / PAYMENT_ALLOCATION split is needed for sibling payments regardless |
| 8 | **Sibling discounts** — decides whether concession hangs off student or family |
| 9 | **Concession scope** — do free and partial students pay exam fees, trip fees, fines? Percentage or fixed? Does it expire at year end? |
| 10 | **Proration** — student admitted on the 18th or leaving on the 6th: full month, pro-rata, or next month |
| 11 | **Exit states** — withdrawal, transfer, suspension: dues, refunds, whether arrears block a leaving certificate |
| 12 | **Staff leave** — types, entitlement, approval, effect on salary, and **who marks the register when the class teacher is on leave** |
| 13 | **Grace and retention windows** — days past due before read-only; months of retention after termination |

### Deferrable without rework

| # | Decision | Condition |
|---|---|---|
| 14 | Result weighting and grading scale | Only if `ASSESSMENT_WEIGHT` is its own table, not columns |
| 15 | Promotion rules at year rollover | Enrolment already close-old/open-new; needed before first year-end |
| 16 | Cash basis or accrual | **Only if** both charge-due date and payment-verified date are stored on every row from the start |
| 17 | WhatsApp number per school or per platform | Config column either way |
| 18 | Message-cost model — bundled allowance or credits | Feeds the subscription plan table |
| 19 | Urdu RTL mirroring | Only if built with directionality tokens from the first screen |
| 20 | Transport module | Phase 5 |

### Assumed unless corrected

- Urdu mode mirrors the layout right-to-left
- Class-test marks reach parents immediately; term and annual results wait for principal approval
- Fines are not concession-eligible

---

## Not yet specified — in the plan, but only as words

These are agreed in principle and have no workflow, actor or acceptance criteria. Each needs specifying before the phase that delivers it: **staff contracts** (what expiry causes) · **events and PTM** (staff assignment, participation, reports) · **certificates** (numbering, authority, whether dues block one) · **subjects and timetable** (the diary, tests and report cards all depend on it) · **document verification** (is it a gate on admission, and who verifies) · **application intake** (a prospective parent has no account) · **inbound WhatsApp workflow** (matching a message to a guardian and an invoice) · **attendance percentage denominator** and **authorised absence** · **per-recipient language preference** · **salary structure** (bonuses, deductions, advances) · **platform support access** to tenant data.
