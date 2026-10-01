# ASMS — School Management System

Multi-tenant school management platform sold to Pakistani schools on a monthly subscription. One system, many schools, each isolated.

**Start every session by reading `docs/WORKLOG.md`** — the cross-model handover log: what is done, in progress and left. Update it before the session ends. Working arrangement: Fable 5.1 plans and reviews; Opus 5.5 writes the code.

**Current documents**
- `docs/WORKLOG.md` — session handover log. Read first, update last.
- `docs/asms-system-architecture.html` — technical baseline. Stack, modules, notification drivers, charge lifecycle.
- `docs/asms-system-design.html` — client-facing design.
- `docs/asms-school-presentation.html` — client presentation deck. Its slide 24 is the client question list; several of its statements are proposals, labelled in the register below.
- `docs/asms-functional-spec.md` — functional spec of record for *what the school needs*. **Read its corrections header first** — several structural decisions in it are superseded.
- `docs/decisions-pending-confirmation.md` — provisional implementation recommendations (tenancy, Filament, Flutter offline). **Not decisions.** Decisions 1–3 were confirmed on 2026-10-01 and moved to settled rules 11–16.

**Source — historical, not operating rules**
- `docs/AI-AGENT-TEAM-spec.md` — the charter these rules were distilled from. Its agent names and Supervisor Agent do not exist; its header maps them to the real agents. This file wins where they differ.

**Superseded — do not build from these**
- `docs/school-platform-blueprint.html` — first structural pass. Its data model contradicts settled rule 8.
- `docs/announcements-concept.html` — slides 01, 02, 07 and 08 are partly wrong (channel policy, three apps, read receipts, office-staff class row). Still the only spec for announcement fields, sender rights and the audience picker.
- `docs/asms-architecture-review.html` — findings now folded into the register below. Its "Fix" boxes are not decisions.
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
3. **Academic year** scopes everything academic and financial. A school may run more than one session at once, each class belonging to exactly one (rule 15).
4. **Never hard-delete.** Students, staff, payments, results and documents keep history. Corrections are new rows referencing the original.
5. **Surrogate primary keys.** CNIC, admission number and roll number are unique attributes, not keys.
6. **ENROLMENT is the hub** — student-in-a-class-in-a-year. Academic and financial records hang off enrolment.
7. **One STAFF record per employed person.** TEACHER extends staff with academic assignments; it does not restate contract, salary or attendance.
8. **One FEE_HEAD table.** Fee types are rows, not modules.
9. **Guardians link through STUDENT_GUARDIAN**, with relationship, primary-contact, fee-payer and login flags.
10. **A deposit screenshot is a claim, not a payment.** Only office verification credits the ledger.

Confirmed by the product owner on 2026-10-01 (previously open decisions 1, 2, 3, 5, 6, 19):

11. **One campus per school.** The school is the tenant and `school_id` is the tenant key. There is no campus dimension on any table. A group of schools under one owner is separate tenants; a nullable `school_group_id` on the school record is the only trace of it.
12. **Login identity is the CNIC.** Username is the person's CNIC digits with dashes removed, for guardians and staff. The **default password is the same digits**; the user may change the password at any time. The username does not change. The office creates every account at admission or hiring; **nobody self-registers.** A person who is both staff and guardian has one login carrying both capability sets. At admission the office must search existing guardians by CNIC and link, never create a duplicate; `merged_into_id` exists on the guardian table from the first migration. Security conditions that come with this choice and are not optional: the CNIC is stored encrypted and looked up through an indexed hash; it is never written to a log line or a URL; login is rate-limited and locks after repeated failures; the office can see which accounts still use the default password. Still open: the student identifier, the reset path, and whether the first login forces a change (items 27–29).
13. **Permission model: role defaults plus per-user grant and revoke, plus school-defined custom roles.** Capabilities apply to staff only; guardian and student roles are fixed and closed. The six roles are Platform admin, Principal, Office staff, Teacher, Parent, Student. **Teacher is one role; class teacher and subject teacher are assignments**, and scope (which rows) always comes from assignment data, never from a checkbox. `role.manage` is not grantable. Nobody grants what they do not hold. Every check is written `can($capability, $subject)` from the first call site. Separation of duties (you may not verify your own claim, a collector may not confirm their own handover) is a domain invariant, not a permission. The effective-permissions view ships in Phase 1 with the grant screen. The capability list itself is still to be written.
14. **Attendance is stored per period.** Each class carries a setting for whether staff record it daily or per period; a daily mark is stored as the day's single period. The offline idempotency key is `UNIQUE (school_id, enrolment_id, date, period)`.
15. **Sessions and money settings.** The principal defines academic years (sessions) and assigns each class to one, so a school may run, for example, an April session and a September session side by side. Fee due day defaults to the 10th of the month and is changeable per school. Currency is PKR. **Amounts are whole rupees**: stored as integers, no paisa, displayed without decimals.
16. **English only.** No Urdu interface, no right-to-left layout, all messages to parents in English. If Urdu is ever added it is a new decision, not a toggle.

## Market constraints that change design decisions

Many parents have keypad phones, or smartphones on social-only data bundles where a custom app cannot reach them at all. **WhatsApp and SMS are primary channels; the parent app is secondary.** Any feature that assumes a working smartphone app is incomplete until its fallback is stated. The platform is English-only (rule 16), so the Urdu SMS cost penalty does not apply.

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
| `devops` | Deploy, CI, backups, monitoring. Written for the decided stack; hosting itself is still an assumption |

A local-only `git-pusher` agent (commit and push helper) exists on the maintainer's machine and is excluded from git via `.git/info/exclude`; a fresh clone will not have it. Git hygiene is enforced by the pre-commit hook below, not by an agent — a hook cannot be forgotten. Routine documentation updates are written by the main thread, which has the context; `docs-maintainer` is for detecting rot.

Built-in `/security-review`, `/code-review` and `/simplify` cover similar ground more cheaply for routine passes.

---

## Git

Branch `master`, remote `origin` on GitHub (`mrk-rizwan/School-Managment-System`). `core.hooksPath` is set to `.githooks` — **the pre-commit guard is live.** A fresh clone must run `git config core.hooksPath .githooks` once. `.gitattributes` forces LF on hooks and shell scripts so Windows checkouts cannot break them.

The hook blocks: `.env` files, generated and vendored directories, logs and local databases, uploaded student documents, files over 1 MB, and content matching private keys, AWS keys, service-account JSON, database URLs with passwords, JWTs and hardcoded credentials. It scans added lines only and handles file names with spaces or non-ASCII characters (verified 2026-10-01).

Keep file names short and ASCII. A 100-character name with an em dash once broke a deep clone on Windows and silently escaped the hook.

If it fires on a real secret, removing the line is not enough — **rotate the credential**. `--no-verify` bypasses the hook; use it only when you are certain.

## Technology stack — decided

Laravel + PostgreSQL + Filament (backend and web admin) · Flutter (one role-aware mobile app) · Firebase Cloud Messaging (push) · Redis (queues, cache) · WAHA behind a driver interface (WhatsApp) · Laravel Mail (email — **not** Nodemailer, which is Node-only) · S3-compatible object storage with signed URLs.

How the stack is used — no tenancy package, forced Postgres row-level security, **not** Filament's built-in tenancy (it puts the tenant in the URL), Filament page-size cap and five custom Pages, Drift plus an outbox for Flutter offline, idempotency as database constraints — is recommended in `docs/decisions-pending-confirmation.md` Part 2. Provisional: the forced-RLS prototype listed there runs before the schema freezes. Do not reach for `stancl/tenancy` or Filament tenancy without reading it.

---

## Open decisions — the canonical register

**This is the only list.** Other documents may mirror it; where they disagree, this wins.

### Blocks Phase 1

> **Phase 1 was unblocked on 2026-10-01.** Decisions 1, 2, 3, 5 and 6 were confirmed and are now
> settled rules 11–16. Numbers are never reused; closed items are listed at the end of this section.
> `docs/decisions-pending-confirmation.md` keeps only the implementation recommendations (Part 2).

| # | Decision | Status | Why it blocks |
|---|---|---|---|
| 4 | **Guardian contact capability** — how the system knows a parent has a keypad phone, social bundle, or full data | Open. Default: three-value field on the guardian, asked at admission | Every notification routing rule reads this field |
| 27 | **Student login identifier** — students have no CNIC. B-Form number, or admission number? | Open. Recommended: admission number (always exists, never changes, not a sensitive document) | The student username column |
| 28 | **Password reset path** — no email exists. Office resets to the default, or SMS OTP to the guardian's phone? | Open. Recommended: office reset in Phase 1, SMS OTP later | Phase 1 auth flow |
| 29 | **Forced password change on first login** — the default password is the CNIC, which appears on many documents. Force a change, or only prompt? | Open. Recommended: force | Phase 1 auth flow |

Closed: 1 account model → rule 12 · 2 permission model → rule 13 · 3 multi-campus → rule 11 · 5 per-school settings → rule 15 · 6 attendance granularity → rule 14 · 19 Urdu RTL → rule 16.

### Blocks the schema freeze — feature is later, the shape is now

| # | Decision |
|---|---|
| 7 | **Partial payment** — the architecture says "decide", spec §10 already assumes yes. Settle it. Note: PAYMENT / PAYMENT_ALLOCATION split is needed for sibling payments regardless |
| 8 | **Sibling discounts** — decides whether concession hangs off student or family |
| 9 | **Concession scope** — do free and partial students pay exam fees, trip fees, fines? Percentage or fixed? Does it expire at year end? |
| 10 | **Proration** — student admitted on the 18th or leaving on the 6th: full month, pro-rata, or next month |
| 11 | **Exit states** — withdrawal, transfer, suspension: dues, refunds, whether arrears block a leaving certificate |
| 12 | **Staff leave** — types, entitlement, approval, effect on salary, and **who marks the register when the class teacher is on leave**. The architecture doc and presentation propose: on approving leave the principal names a covering teacher with access to that class for those dates only, and unrecorded registers surface on the principal's console the same day. Proposal, not confirmed |
| 13 | **Grace and retention windows** — days past due before read-only; months of retention after termination |
| 21 | **Results approval unit** — does the principal approve a term result per class or per student? Raised in the architecture doc's approvals inbox |
| 22 | **Which message types may reach SMS at all** — SMS costs per message; the routing rule needs a per-type allow list. Raised in the architecture doc's delivery notes |
| 23 | **Late arrival** — counts as present, half day, or absent past a cut-off time; affects the attendance percentage. Presentation slide 24 |
| 24 | **Late-payment charge** — automatic after due date or at discretion; amount; who may waive. Presentation slide 24 |
| 25 | **Banking** — does the school have an account guardians can remit to? Decides whether the deposit-screenshot flow exists on day one. Presentation slide 24 |
| 26 | **Default remark visibility** — are teacher remarks pushed to guardians or visible on enquiry only. Presentation slide 24 |

### Deferrable without rework

| # | Decision | Condition |
|---|---|---|
| 14 | Result weighting and grading scale | Only if `ASSESSMENT_WEIGHT` is its own table, not columns. Client docs say "before results are built"; that is this condition, not Phase 1 |
| 15 | Promotion rules at year rollover | Enrolment already close-old/open-new; needed before first year-end |
| 16 | Cash basis or accrual | **Only if** both charge-due date and payment-verified date are stored on every row from the start |
| 17 | WhatsApp number per school or per platform | Config column either way |
| 18 | Message-cost model — bundled allowance or credits | Feeds the subscription plan table. The presentation tells the client "a monthly allowance is agreed in advance"; if accepted, this closes as bundled allowance |
| 20 | Transport module | Phase 5 |

### Assumed unless corrected

- Timezone is Asia/Karachi for every school
- Class-test marks reach parents immediately; term and annual results wait for principal approval
- Fines are not concession-eligible
- Attendance percentage is computed against teaching days in the school calendar, excluding declared holidays (stated to the client in the presentation)
- Certificates carry a sequential number, issue date, academic year and authorising officer; reissues are recorded (stated to the client in the presentation)
- Platform support access to a school's data is governed by agreement and logged (stated to the client in the presentation)

---

## Not yet specified — in the plan, but only as words

These are agreed in principle and have no workflow, actor or acceptance criteria. Each needs specifying before the phase that delivers it: **staff contracts** (what expiry causes) · **events and PTM** (staff assignment, participation, reports) · **certificates** (whether dues block one; numbering is assumed above) · **subjects and timetable** (the diary, tests and report cards all depend on it) · **document verification** (is it a gate on admission, and who verifies) · **application intake** (a prospective parent has no account) · **inbound WhatsApp workflow** (matching a message to a guardian and an invoice) · **authorised absence** (the denominator is assumed above) · **the capability list** (names, groups and role defaults behind rule 13; around 50 proposed, none named) · **salary structure** (bonuses, deductions, advances) · **platform support access** (the audit mechanism behind the assumption above).
