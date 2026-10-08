# ASMS — School Management System

Multi-tenant school management platform sold to Pakistani schools on a monthly subscription. One system, many schools, each isolated.

**Start every session by reading `docs/WORKLOG.md`** — the cross-model handover log: what is done, in progress and left. Update it before the session ends. Working arrangement: Fable 5.1 plans and reviews; Opus 5.5 writes the code.

**Current documents**
- `docs/WORKLOG.md` — session handover log. Read first, update last.
- `docs/plans/` — build plans per phase. `phase-4-academic.md` is the current one (rules 26-31). Phases 1-3 are complete (`phase-1-foundation.md`, `phase-2-daily-operations.md`, `phase-3-financial.md`; Phase 3 closed 2026-10-07 with the real-driver proof deferred to go-live, see `docs/WORKLOG.md`), and Phase 2 superseded its R37 and R80 (see rule 6 and register item 13). Each plan is self-contained; its binding contracts are in `docs/plans/contracts/`.
- `docs/asms-system-architecture.html` — technical baseline. Modules, notification drivers, charge lifecycle. **Its stack and runtime sections are superseded by the 2026-10-02 stack change**; the module boundaries, charge lifecycle and notification design stand.
- `docs/asms-system-design.html` — client-facing design.
- `docs/asms-school-presentation.html` — client presentation deck. Its slide 24 is the client question list; several of its statements are proposals, labelled in the register below.
- `docs/asms-functional-spec.md` — functional spec of record for *what the school needs*. **Read its corrections header first** — several structural decisions in it are superseded.
- `docs/decisions-pending-confirmation.md` — provisional implementation recommendations. **Not decisions.** Decisions 1–3 were confirmed on 2026-10-01 and moved to settled rules 11–16. **Its Laravel, Filament and Flutter sections are void after the 2026-10-02 stack change**; the Postgres and idempotency reasoning stands.

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
2. **Tenant scoping.** Every table carries `school_id`; isolation is enforced at the query layer. Tenant is derived from the session, never from client input. The single exception is the login and forgot-password forms, where no session exists yet: they take a school code, which is written to the session before authentication runs.
3. **Academic year** scopes everything academic and financial. A school may run more than one session at once, each class belonging to exactly one (rule 15).
4. **Never hard-delete.** Students, staff, payments, results and documents keep history. Corrections are new rows referencing the original.
5. **Surrogate primary keys.** CNIC, admission number and roll number are unique attributes, not keys.
6. **ENROLMENT is the hub** — student-in-a-class-in-a-year. Academic and financial records hang off enrolment. A section change is close-old/open-new like a class change (R174, amending Phase 1's R37): `enrolments.section_id` is never edited, and a closed enrolment keeps its roll number.
7. **One STAFF record per employed person.** TEACHER extends staff with academic assignments; it does not restate contract, salary or attendance.
8. **One FEE_HEAD table.** Fee types are rows, not modules.
9. **Guardians link through STUDENT_GUARDIAN**, with relationship, primary-contact, fee-payer and login flags.
10. **A deposit screenshot is a claim, not a payment.** Only office verification credits the ledger.

Confirmed by the product owner on 2026-10-01 (previously open decisions 1, 2, 3, 5, 6, 19):

11. **One campus per school.** The school is the tenant and `school_id` is the tenant key. There is no campus dimension on any table. A group of schools under one owner is separate tenants; a nullable `school_group_id` on the school record is the only trace of it.
12. **Login identity is the CNIC.** Username is the person's CNIC digits with dashes removed, for guardians and staff. The **default password is the same digits**; the user may change the password at any time. The username does not change. The office creates every account at admission or hiring; **nobody self-registers.** A person who is both staff and guardian has one login carrying both capability sets. At admission the office must search existing guardians by CNIC and link, never create a duplicate; `merged_into_id` exists on the guardian table from the first migration. Security conditions that come with this choice and are not optional: the CNIC is stored encrypted and looked up through an indexed hash, and **the username is stored only as that hash, never in clear**; it is never written to a log line or a URL; login is rate-limited and locks after repeated failures; the office can see which accounts still use the default password. **Students** log in with their own national identity number (the 13-digit B-Form / CRC number) with dashes removed, same default-password rule; a student with no number recorded has no login until the office enters one. **First login prompts a password change but does not force it.** **Password reset** is by a code sent to the account's email address; the user must enter an email before they can change their password, so every changed password has a reset path. Users with no email (keypad-phone guardians) are reset by the office to the default, which is the stated fallback. The office can see which accounts have no email and which still use the default password.
13. **Permission model: role defaults plus per-user grant and revoke, plus school-defined custom roles.** Capabilities apply to staff only; guardian and student roles are fixed and closed. The six roles are Platform admin, Principal, Office staff, Teacher, Parent, Student. **Teacher is one role; class teacher and subject teacher are assignments**, and scope (which rows) always comes from assignment data, never from a checkbox. `role.manage` is not grantable. Nobody grants what they do not hold. Every check is written `can(capability, subject)` from the first call site. Separation of duties (you may not verify your own claim, a collector may not confirm their own handover) is a domain invariant, not a permission. The effective-permissions view ships in Phase 1 with the grant screen. The capability list (51 keys) and the system-role defaults are in `docs/plans/phase-1-foundation.md` §7 and live in code (`packages/shared/src/capabilities.ts`). Since Phase 2 office staff hold `attendance.student.mark` (all scope) by default, so the gate can record a late arrival; a cover teacher holds full class-teacher scope for their dates.
14. **Attendance is stored per period.** Each class carries a setting for whether staff record it daily or per period; a daily mark is stored as the day's single period. The offline idempotency key is `UNIQUE (school_id, enrolment_id, date, period)`.
15. **Sessions and money settings.** The principal defines academic years (sessions) and assigns each class to one, so a school may run, for example, an April session and a September session side by side. Fee due day defaults to the 10th of the month and is changeable per school. Currency is PKR. **Amounts are whole rupees**: stored as integers, no paisa, displayed without decimals.
16. **English only.** No Urdu interface, no right-to-left layout, all messages to parents in English. If Urdu is ever added it is a new decision, not a toggle.
17. **Guardian contact capability is a three-value field on the guardian** — WhatsApp, smartphone with data, or keypad phone — asked by the office at admission and editable later. Every notification routing rule reads it. Unknown is not a value; the office must pick one.

Confirmed by the product owner on 2026-10-05, who accepted the main-thread recommendations for
Phase 3 (previously open decisions 7-11, 12, 13, 16, 18, 24, 25, 30). Values marked *default* are
per-school settings the school can change; the rest are rules.

18. **Fees and payments.** A partial payment is accepted; the balance stays owing and carries
    forward. A payment clears the **oldest** charge first (a PAYMENT row and PAYMENT_ALLOCATION rows,
    so one payment can cover several children). A student who joins after a cut-off day is not
    charged that month; one who leaves is charged the leaving month in full (cut-off *default* the
    15th). Late fee: off by *default*; when a school turns it on it is a fixed amount charged
    automatically after a grace day, and only the principal may waive it (one exception, built in
    Phase 3: verifying a deposit claim whose paid date is inside the grace waives the late fee when
    that payment settles the charge in full). Fee types are FEE_HEAD rows
    (rule 8) seeded with tuition (monthly), admission (once), annual charges (yearly), exam (per
    term) and fine (ad hoc); the school edits them. Every receipt carries a number sequential per
    school per academic year, and is printable and sent by WhatsApp or SMS by the usual routing.
19. **Concessions** hang off the student's enrolment, not the family: there is no automatic sibling
    discount, and a sibling reduction is an ordinary concession. A concession is a percentage or a
    fixed amount, applies to the fee heads it names (*default* tuition only; fines never, per the
    assumption below), ends with the academic year, and is approved by the principal (the office may
    request one).
20. **Leaving and suspension.** Unpaid dues block a leaving certificate unless the principal overrides,
    with a reason, audited (never for the principal's own child, even a sole principal; the override
    lapses if the amount owed later rises). Fees paid in advance for months not yet started are refundable through a
    principal-approved refund (a new row referencing the payment, rule 4); the admission fee is never
    refunded. A suspended student is still enrolled: still charged, and the family still receives
    announcements.
21. **How parents pay.** Cash at the office is the main path. A school that records a bank or
    wallet account (bank, JazzCash, Easypaisa) also gets the deposit-screenshot flow (rule 10: a claim
    until the office verifies it). Both exist from Phase 3's first release.
22. **Expenses, salaries and leave.** The office records expenses by category; an expense above a
    *default* Rs 5,000 needs the principal's approval. A salary is basic pay plus named allowances
    minus named deductions; an unpaid-absent day deducts basic pay divided by that month's working
    days; advances are repaid in instalments from later salaries; salary is paid in cash or by bank
    transfer on a *default* pay day of the 1st. Leave types *default* to casual (10 days a year), sick
    (10) and unpaid (no limit); the principal approves leave and may name a cover teacher on
    approval (built in Phase 2).
23. **Platform billing** (the platform's own money layer, rule 1): a monthly subscription per school,
    priced by student-count tier, each tier with a bundled monthly SMS allowance (which sets
    `sms_monthly_cap`); the prices are platform settings, not code. A school past due gets 15 days'
    grace before the platform may suspend it (suspension disturbs nothing, R80 lifted); after
    termination its data is kept for 12 months.
24. **Privileged capabilities on a default password** (was open item 30): `role.manage` and
    `user.account.manage` are inert while the holder still uses the default password; everything
    else works.
25. **Accounting basis** (was deferrable item 16): every money row stores both the date a charge
    falls due and the date a payment was verified, so reports can show either view; the default
    report view is decided with the reports.

Confirmed by the product owner on 2026-10-07, who accepted the main-thread recommendations for
Phase 4 (previously open decisions 14, 15, 21 and client questions 4, 10, 11, 17). Values marked
*default* are per-school (or per-year) settings the school can change; the rest are rules.

26. **Exam structure and composition.** The principal defines the **terms** of each academic year
    (*default* two: Mid-term and Annual). Every assessment is a `test` (daily, weekly, monthly or
    other, any size, created by the teacher) or the term's `exam` (one per class-subject per term,
    set up by the principal). Per subject, a term result = class-test aggregate × W₁ + exam × W₂,
    the tests averaged as percentages so a 10-mark quiz and a 50-mark test count equally; weights
    are a per-year table (*default* 20 / 80). The **final result** combines the terms by per-term
    weights (*default* equal) and is what promotion reads. Grade bands are a per-year table
    (*default* A+ ≥ 90, A 80, B 70, C 60, D 50, E 40, F below) with a *default* pass mark of 40 %
    per subject. Absence from an assessment counts 0 and prints "Ab"; the principal may excuse it,
    and the subject is then composed from what was taken. Nothing is ever added up by hand or
    stored twice: composition is one pure function.
27. **Results are approved per section per term** (closes item 21). The class teacher submits the
    section's result sheet once every subject's marks are in; the principal approves or returns it
    with a reason from the Approvals inbox. **Approval publishes** when the approver also holds
    `result.publish` (the principal does by default; a school that grants approval alone gets a
    two-step). Guardians and the student are told by the usual routing, SMS allowed by *default*.
    Class-test marks are visible in the app as soon as entered and not notified (*default*). A
    correction after publication is a **revised result row referencing the original**, approved
    again per student, which reissues the report card and notifies the guardian. Marks for a
    teacher's own child are allowed but flagged on the sheet; the approver is never the submitter
    (*main-thread default, open to correction:* a sole principal may, recorded `self_approved`, as
    rule 21 of the Phase 3 plan allows for money; built in slice 31 for sheets and corrections).
28. **Report card.** One standard layout: school, student, per-subject marks and grade, total,
    percentage, overall grade, position in the section, the approval unit (*default* on; standard competition ranking, ties
    share the position), the
    term's attendance percentage from the Phase 2 attendance record, the class teacher's term
    remark, signature lines. Rendered natively in the app, printed from the web (scriptless HTML,
    no PDF), and printed for keypad-phone families. A school may **withhold the card until dues
    are cleared** (*default* off); the result message still goes out, and the principal may
    override through the same dues endpoint certificates use. The guardian then sees percentage,
    grade and the amount owed; the student's own login sees no figure and no mention of fees
    ("please ask your parent or the school office").
29. **Certificates.** Types: leaving, character, academic (marks transcript), completion, other
    (free title). One sequential number per school per type, never reset; issued by
    `certificate.issue` holders (office staff by default); **only the leaving certificate is
    dues-gated** (rule 20) and it needs the student already withdrawn, transferred or completed (alumni); a reissue
    keeps the number, is a new row with a reason, and prints "Duplicate"; the authorising officer
    printed is the issuer, with the principal's name from school settings. Issued from the stored
    record years after the student left.
30. **Promotion and year end** (closes item 15). Per section, once the final result is approved,
    the principal opens a promotion sheet with a proposed outcome per student (final result at or
    above the pass mark → promote, otherwise → detain), overridable per student with a reason.
    Outcomes: promoted (new enrolment in the next class), detained (new enrolment in the same class
    next year), completed (the final class → alumni), not continuing (withdrawn). The section
    defaults to the same name in the next class. **Unpaid fees never block promotion**: arrears
    stay in their year, reminders continue and the sheet flags them; the leaving certificate stays
    blocked by rule 20. The principal may cancel an open promotion sheet with a reason, and the
    section may then open another. An academic year closes only when every section's promotion
    sheet is applied; a section with no enrolment in force on the year's last day needs none.
31. **Scope held back from Phase 4:** the period timetable (which teacher, period and room; it
    tightens period attendance, not results), events and PTM, and the import of past results all
    go to Phase 5. Phase 4 adds only the list of subjects each class takes, per year.

## How tenant isolation is implemented — the mechanism behind rule 2

Decided 2026-10-02. **Scoping is enforced in the application, in a repository layer. The database
does not enforce it.** This is the ordinary way multi-tenant applications are built, it is fully
supported by Prisma, and it carries no unproven machinery.

Row-level security was considered and rejected — not because it is wrong, but because driving it
from Prisma 7 has no credible production precedent and Prisma's own example is labelled
not-for-production. The reasoning is in `docs/WORKLOG.md` under 2026-10-02. The door is kept open:
see "Leaving room" below.

### The controls against a forgotten filter

1. **Nothing outside `src/repositories/**` may import the Prisma client.** Enforced by an ESLint
   `no-restricted-imports` rule and a test. Services, controllers and jobs call repositories.
2. **Every repository method takes `schoolId` as a required first argument**, typed as a branded
   `SchoolId` that can only be constructed inside the tenancy module — so it cannot be minted from
   `req.body`. Omitting it is a **compile error**, not a runtime leak.
3. **Every tenant query filters on `school_id`.** No exceptions, including `findUnique` — which
   becomes `findFirst` with both the id and the tenant, because a bare primary-key lookup is the
   classic cross-tenant read.
4. **One isolation test per table:** create a row as School A, query as School B, assert nothing
   comes back. Mechanical, fast, and it is what actually catches a mistake.

Added 2026-10-02 after the security review found that the four above check the import and the
signature but never the query itself:

5. **A query guard on the Prisma client** (an inspect-only client extension inside
   `src/repositories/`) throws if a tenant-model operation has no defined `schoolId` in its
   `where` or `data`, if any `where` value is `undefined` (Prisma drops it silently and returns
   the school's first row), or if `findUnique` is used. Its compatibility with interactive
   transactions was verified in slice 0 (`transaction-atomicity.spec.ts`); no fallback was needed.
6. **Writes use scalar foreign keys, never `connect`**, so the composite foreign key rejects
   another school's id in the database. Raw-unsafe queries, `as SchoolId` and `any` are banned by
   lint. Since slice 0 the API's lint is **type-aware**: an untyped value (`req.body`) cannot flow
   into a `SchoolId`; type assertions are refused except in the two mint files; inline
   `eslint-disable` comments have no effect; `src/tenancy` and `src/repositories` may not
   re-export; `nestjs-cls`, `TransactionHost` and `new PrismaClient` are confined to tenancy and
   repositories; the tenant is written into the request context only through
   `RequestContextService.establishSession(SchoolId)`, and into a job's context only through
   `QueueTenancy.runAsSchool` (exception 3). Since Phase 2 lint also confines `bullmq` to
   `src/jobs/**` and `src/messaging/outbox-dispatcher.ts`, the messaging drivers to
   `src/messaging/**` (everything sends through `NotificationService`), and the announcement and
   inbox repositories to their owning modules. Since Phase 4 each academic repository is confined
   to its module (academics, assessments, results, certificates, promotion); results read marks
   only through the read-only `MarkReadsRepository`; certificates and results read dues only
   through `FinanceReportsService.clearance`; promotion writes enrolments and statuses only
   through `EnrolmentsService` and `StudentsService`. The `school_id` of a row can never change:
   the query guard refuses it and a database trigger rejects it.
7. **Row scope is a required, branded argument** on every student-linked repository method. Only
   the permission service can construct it; an empty list means no rows, never no filter. Since
   Phase 4 a second brand, `MarksScope` (separate read and write modes, carrying the subject), is
   minted only in `src/tenancy/scope.mint.ts`; a read scope cannot be passed where a write scope
   is required, and a `marks.view_all` grant never widens what a teacher may write.
8. **A schema guard test reads the migrated database** and fails on a table without `school_id`,
   a foreign key between tenant tables that omits it, a missing index, or a cascade — outside two
   named allowlists in `test/guardrails/schema-checks.ts`: the non-tenant tables, and the global
   correlation indexes exception 5 needs.

`schoolId` comes from the session — never from a request body, query string or route parameter.
The single exception is the pre-auth school-code lookup at login, which rule 2 already names.
DTOs must not declare a `schoolId` field, and the global `ValidationPipe` runs with
`whitelist: true, forbidNonWhitelisted: true`, so a client that sends one is rejected rather than
trusted.

### The named exceptions — code that legitimately runs without a school

Six things must query without a `SchoolId`. They are the whole list; adding a seventh is a
decision recorded here, not a convenience. Every `SchoolId` is minted in one file,
`src/tenancy/school-id.mint.ts`, by six constructors, one per path below: `fromPlatformSchool`
(1), `schoolIdFromLookup` (2), `schoolIdsForFanOut` and `schoolIdFromQueuePayload` (3),
`schoolIdFromSession` (4), `schoolIdFromDeliveryReport` (5). The six sites outside the platform
module that may each import one platform repository are listed in ESLint `NAMED_EXCEPTION_SITES`
(`apps/api/eslint.config.mjs`).

1. **The platform module** (platform admins managing schools). Its repositories live in
   `src/repositories/platform/**`, touch only the non-tenant tables (`schools`, `school_groups`,
   `platform_users`, `platform_sessions`, `platform_audit_log`, `platform_settings`,
   `platform_delivery_health`, and since Phase 3 `platform_plans`, `platform_subscriptions`,
   `platform_invoices`, `platform_payments`, `platform_school_metrics`), and may be imported only
   from `src/modules/platform/**` and the named exception sites; the billing repositories only from
   `src/modules/platform/billing/**`, `src/jobs/platform-billing.ts` and (metrics, write)
   `src/jobs/school-metrics-rollup.ts`. Enforced by the same ESLint rule. **The platform acts inside a
   school for exactly two operations:** creating the school, which writes its first
   `school_settings` row, its counters (`admission_no`, `expense_no`), its five seeded fee heads
   and three leave types (`asms_seed_school_finance`) in the same transaction (the tenant comes
   into being),
   and issuing a principal's login, which is refused while the school already has an active
   principal unless a reason is given. Both go through `fromPlatformSchool`, importable
   only in the platform module, and both are written to the platform audit log (the principal
   login to both logs). The per-school messaging knobs (`sms_monthly_cap`, `whatsapp_provider`,
   `sms_provider`) are columns on `schools`, set through the existing `PATCH /platform/schools/:id`;
   platform-wide defaults live in the one-row `platform_settings`. They are not new operations
   inside a school.
   Platform login requires a second factor: one platform password would otherwise open every
   school. Tenant code that reads its own school row uses `OwnSchoolRepository`, whose only
   predicate is `id = schoolId`, and a school reads its own platform bill (its live plan and its
   invoices) through `OwnInvoicesRepository`, whose every tenant-keyed predicate is
   `school_id = schoolId` (the plan row, which carries no school, is read by the id from the
   school's own subscription), importable only from `src/jobs/billing-notices.ts` and
   `src/modules/school-settings/billing-status.controller.ts`; school-owned settings and counters
   live in tenant tables, not on `schools`.
2. **The pre-auth school lookup** at login and forgot-password: one method,
   `SchoolLookupRepository.findByCode(code)`, returning `id`, `shortCode`, `status` and nothing else. Its companion is the login-spray alarm
   (`src/modules/auth/login-spike.recorder.ts`), which may only write a row to
   `platform_audit_log` through `PlatformAuditRepository` (added in wave A, 2026-10-03; awaiting
   the product owner's confirmation as part of this exception).
3. **The scheduler fan-out and job payloads** (widened in Phase 2). Fan-out:
   `SchoolFanOutRepository.listAllForFanOut()` lists every school whatever its status (the
   staged-upload sweep, R41/R90); `listLiveForFanOut()` lists schools that are not terminated (the
   messaging housekeeping jobs and, since Phase 3, the fee, payroll, claim, billing-notice and
   metrics jobs). Sites: `src/jobs/job-runner.ts`,
   `src/modules/documents/staged-upload.sweep.ts`. Job payloads: a job carries ids, never a
   tenant; `QueueTenancy.fromQueuePayload` (`src/tenancy/queue.mint.ts`, importable only from
   `src/jobs/**`) validates the payload with a strict schema, reads the school through
   `SchoolByIdRepository.findById` (importable only from `queue.mint.ts`), drops an unknown or
   terminated school without retry, and mints through `schoolIdFromQueuePayload`. The job body
   runs inside `QueueTenancy.runAsSchool`, a fresh context per job, with ordinary scoped
   repositories. A suspended school runs exactly like an active one (R80 lifted).
4. **Session resolution**: one method, `SessionRepository.findActiveByTokenHash(hash)`, because the
   session token is what establishes the tenant. It returns the session with its `schoolId` and
   `userId`; everything after it is scoped. Reset and email-verification links carry the school
   code in the URL and go through exception 2, so they need no exception of their own.
5. **Delivery-report correlation** (webhooks). A WhatsApp delivery report or inbound event names
   no school, so `DeliveryWebhookRepository` (`src/repositories/platform/delivery-webhook.repository.ts`,
   tagged `$queryRaw`, importable only from `src/webhooks/webhooks.service.ts`) matches it by a
   global key: the hashed provider reference, the WAHA session or the Cloud API phone-number id.
   Each statement returns only the `school_id` of the row it changed, minted by
   `schoolIdFromDeliveryReport` and used only to enqueue a job, which resolves the school again
   through exception 3. Signatures are verified over the raw bytes before any of this runs.
6. **The platform rollups.** `platform_delivery_health` and `platform_school_metrics` are
   non-tenant tables with a `school_id` column, like `platform_audit_log`.
   `platform_delivery_health` is written only by `src/jobs/delivery-health-rollup.ts` and read only
   by `src/modules/platform/messaging/**` (`GET /platform/messaging/health`): counts, statuses and
   mapped error codes. `platform_school_metrics` (one integer per school per day: the students on
   the roll) is written only by `src/jobs/school-metrics-rollup.ts`, inside `runAsSchool` with the
   school's own `SchoolId`, and read only by `src/modules/platform/billing/**` and
   `src/jobs/platform-billing.ts`. The platform never reads `messages`, `message_deliveries` or
   `whatsapp_numbers` (R114), nor any charge, payment or other ledger row (R222): a later
   platform-side figure is another column on these rollups, not a new exception.

### Transactions

A unit of work that spans several repositories runs in **one interactive Prisma transaction**,
propagated with `@nestjs-cls/transactional` and its Prisma adapter, so repositories pick up the
ambient transaction without a `tx` parameter threaded through every call. Never the array (batch)
form of `$transaction`. No `Promise.all` inside a transaction — one connection, statements in
order. Anything that must not happen on rollback (queue dispatch, email, file moves) runs after
commit.

Since Phase 2: a request transaction times out at **15 s** (`TRANSACTION_TIMEOUT_MS`,
`src/tenancy/tenancy.module.ts`). **A request never fans out to recipients**: send-now and holiday
publish set the announcement to `sending` and the `announcement-send` job delivers it under its
own 120 s limit (`JOB_TRANSACTION_TIMEOUT_MS`; the fee-reminder job uses 60 s,
`REMINDER_JOB_TIMEOUT_MS`), returning the row to `draft` with `send_failed_at`
after five failed attempts. Jobs are enqueued only after commit, through `OutboxDispatcher`; a
processor's first statement is a scoped conditional claim (R105). BullMQ job ids use `-`, never
`:` (BullMQ refuses a custom id with `:` unless it has exactly three parts).

### Honest statement of the risk

Without database-level enforcement, **a query that forgets its filter leaks another school's
data.** The measures above make that unlikely; they do not make it impossible. That is the
accepted trade, made deliberately in exchange for building on proven ground. It is recorded here
so nobody later assumes a safety net exists that does not.

### Leaving room to add the safety net later

These cost nothing now and are what make row-level security addable afterwards **without a
migration of existing data**. They are not optional:

- `school_id NOT NULL` on **every** tenant table, from the first migration
- Composite foreign keys `(school_id, parent_id)` on child rows, so a row cannot reference a parent
  belonging to another school
- No cross-tenant foreign keys anywhere

If the system later grows past what review can police, row-level security becomes an additive
change rather than a rebuild.

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

The hook blocks: `.env` files, generated and vendored directories, logs and local databases, uploaded student documents, files over 1 MB (5 MB for the generated OpenAPI document and the generated web and mobile clients, which CI requires to be committed), and content matching private keys, AWS keys, service-account JSON, database URLs with passwords, JWTs and hardcoded credentials. It scans added lines only and handles file names with spaces or non-ASCII characters (verified 2026-10-01).

Keep file names short and ASCII. A 100-character name with an em dash once broke a deep clone on Windows and silently escaped the hook.

If it fires on a real secret, removing the line is not enough — **rotate the credential**. `--no-verify` bypasses the hook; use it only when you are certain.

## Technology stack — decided

**Changed 2026-10-02.** The stack was Laravel + Filament + Flutter until this date. It is now
TypeScript end to end. Reason: the team is two people reviewing AI-written code, and the
maintainer has shipped Node, Express, React, Next.js and React Native for four years and has
never shipped PHP. **Review capacity is the binding constraint on this project**, and a stack the
reviewer reads fluently beats a stack that generates less code. Anything written before this date
that names Laravel, Filament, Eloquent, Artisan or Flutter is superseded.

| Layer | Choice |
|---|---|
| Backend API | **NestJS** (Node + TypeScript) |
| Database | **PostgreSQL** with **Prisma** |
| Web admin | **Next.js** (React + TypeScript) |
| Mobile app | **React Native** with **Expo SDK 57** — one role-aware development build (not Expo Go), Android only in Phase 2; bearer sessions, a SQLite cache and offline outbox |
| Queues, cache | **Redis**, queues through **BullMQ**; one worker process (`node dist/worker.js`) runs every job |
| Push | **Firebase Cloud Messaging** |
| WhatsApp | Two drivers behind one interface: **WAHA** and the **Meta Cloud API**, selectable per school with a platform default; `WHATSAPP_PROVIDERS_ENABLED` per deployment |
| SMS | **Sendpk**, delivery status by polling; the school name opens every message |
| Email | Node mailer library of choice (Nodemailer is now valid — the backend is Node) |
| Files | S3-compatible object storage with signed URLs |

Why each, briefly: **NestJS** because its modules, guards and pipes map onto what ASMS needs
(permissions are guards, validation is pipes) and that structure makes AI output predictable and
therefore reviewable. **PostgreSQL** because the data model is deeply relational, because money and
audit trails need real transactions and constraints, and because its constraint enforcement is the
strongest of the realistic options. It also keeps row-level security available if the system later
outgrows application-layer scoping — see "How tenant isolation is implemented". **Prisma** because it generates
types from the schema, so a wrong field name is a compile error rather than a review burden.
**React Native** because the maintainer ships it.

Still true from the earlier research: **no tenancy package, and idempotency enforced as database
constraints** (a device can be offline for days; a cache TTL cannot survive that). Row-level
security is **not** used and there is no prototype to run — see "How tenant isolation is
implemented". Those parts of `docs/decisions-pending-confirmation.md` Part 2 that concern Laravel,
Filament and Flutter are void; the Postgres and idempotency reasoning stands.

Conventions decided 2026-10-02 with the product owner, binding on every phase:

| Convention | Decision |
|---|---|
| Repository layout | One monorepo, pnpm workspaces: `apps/api` (NestJS), `apps/web` (Next.js), `apps/mobile` (Expo / React Native), `packages/shared` (the capability enum, system-role defaults, error codes). Request and response types reach the web and mobile apps through OpenAPI-generated clients, so a contract is declared once, on the server |
| Primary keys | `bigint` auto-increment (Prisma emits `BIGSERIAL`). Serialised to clients as strings, because a JavaScript number cannot hold a 64-bit integer safely |
| Login sessions | **Server-side, revocable sessions** stored in Postgres: an opaque random token, stored hashed. The web admin carries it in an `httpOnly`, `Secure`, `SameSite=Lax` cookie; the mobile app sends it as a bearer token. **Not stateless JWT** — disabling a user, an office reset and a staff member leaving must kill access immediately |
| Roles | The five school roles (principal, office staff, teacher, parent, student) and the capability list are **defined in code**, not rows. Only school-defined custom roles are stored, so every stored row has a `school_id` |
| Web admin UI | Tailwind + shadcn/ui components, TanStack Query and TanStack Table, react-hook-form with zod |
| API | REST under `/api/v1`, JSON, one error envelope with a stable machine code, cursor-free page/limit pagination capped at 50, OpenAPI generated from the controllers. **No HTTP `DELETE` anywhere** (rule 4): rows are ended, archived or status-changed by `POST /x/:id/<verb>` with a reason. A row in another school, or outside the caller's scope, is `404`, never `403` |
| Secrets in links | Reset and verification tokens travel in the URL **fragment** and are POSTed in a body, never in a path or query string, so they reach no access log. Verification happens on a button press, never on page load |
| Passwords and identity numbers | `argon2id` over an HMAC with a server-side pepper; CNIC and B-Form encrypted with AES-256-GCM bound to school, table and column; three separate keys (pepper, encryption keyring, lookup-hash key) |
| Client IP behind the proxy | The Next.js rewrite forwards a client-sent `X-Forwarded-For` **unchanged** and adds nothing, so on its own any client can spoof its IP and defeat per-IP throttling and login lockout. **Production must run an edge reverse proxy (nginx or Caddy) in front of Next that overwrites `X-Forwarded-For` with the connecting address**; the API trusts exactly one hop. Found by the slice-0 security review, 2026-10-02 |

---

## Open decisions — the canonical register

**This is the only list.** Other documents may mirror it; where they disagree, this wins.

### Blocks Phase 1 — nothing blocks; nothing is open

> **Phase 1 was unblocked on 2026-10-01.** Numbers are never reused.
> `docs/decisions-pending-confirmation.md` keeps only the implementation recommendations (Part 2).

| # | Decision | Status |
|---|---|---|
| ~~30~~ | **Closed 2026-10-05 → rule 24.** ~~Privileged capabilities on a default password.~~ A principal's default password is their CNIC, which colleagues may know. Should `role.manage` and `user.account.manage` be inert until that user has changed their password? Everything else would still work, so this does not contradict "prompt, do not force" | Closed 2026-10-05 → rule 24; built in Phase 3 slice 18 (`403 DEFAULT_PASSWORD_BLOCKS_ACTION`, `blockedCapabilities` on `/me`; in-service overrides read `holdsNominally`) |

Closed 2026-10-05: 7, 8, 9, 10 → rules 18-19 · 11 → rule 20 · 12 (leave) → rule 22 · 13 (grace, retention) → rule 23 · 16 → rule 25 · 18 → rule 23 · 24 → rule 18 · 25 → rule 21 · 30 → rule 24.
Closed 2026-10-07: 14 → rule 26 · 15 → rule 30 · 21 → rule 27.
Closed earlier: 1 account model → rule 12 · 2 permission model → rule 13 · 3 multi-campus → rule 11 · 4 guardian contact capability → rule 17 · 5 per-school settings → rule 15 · 6 attendance granularity → rule 14 · 17 WhatsApp number → per school: the principal pairs the school's own number (owner, 2026-10-03) · 19 Urdu RTL → rule 16 · 27 student username → rule 12 · 28 password reset → rule 12 · 29 first-login change → rule 12.

### Blocks the schema freeze — feature is later, the shape is now

| # | Decision |
|---|---|
| ~~21~~ | **Closed 2026-10-07 → rule 27** (per section per term). ~~Results approval unit~~ |
| 22 | **Which message types may reach SMS at all** — SMS costs per message; the routing rule needs a per-type allow list. Raised in the architecture doc's delivery notes. *Built with a default the owner tunes:* a per-school SMS allow list with a platform default |
| 23 | **Late arrival** — counts as present, half day, or absent past a cut-off time; affects the attendance percentage. Presentation slide 24. *Built with a default the owner tunes:* `late_counts_as` = present |
| 26 | **Default remark visibility** — are teacher remarks pushed to guardians or visible on enquiry only. Presentation slide 24. *Built with a default the owner tunes:* visible to guardians, not notified |

### Deferrable without rework

| # | Decision | Condition |
|---|---|---|
| ~~14~~ | **Closed 2026-10-07 → rule 26.** Weights and grade bands are per-year tables, as the condition required |
| ~~15~~ | **Closed 2026-10-07 → rule 30** |
| 20 | Transport module | Phase 5 |
| 31 | **Rule 24's reach** (raised by the Phase 3 plan §1.2, 2026-10-06): should a user still on the default password also be blocked from money-out verbs (payee and payment-account changes, refunds, payroll finalise), and should a default-password principal lose the in-service override on staff status (today checked against nominal holdings)? | Either is a small change in the capability guard; no schema change |

### Assumed unless corrected

- Timezone is Asia/Karachi for every school
- Class-test marks reach parents immediately; term and annual results wait for principal approval (now rule 27)
- Fines are not concession-eligible
- Attendance percentage is computed against teaching days in the school calendar, excluding declared holidays (stated to the client in the presentation)
- Certificates carry a sequential number, issue date, academic year and authorising officer; reissues are recorded (stated to the client in the presentation; now rule 29)
- Platform support access to a school's data is governed by agreement and logged (stated to the client in the presentation)

---

## Not yet specified — in the plan, but only as words

These are agreed in principle and have no workflow, actor or acceptance criteria. Each needs specifying before the phase that delivers it: **staff contracts** (what expiry causes) · **events and PTM** (staff assignment, participation, reports; Phase 5 by rule 31) · **period timetable** (teacher, period, room; Phase 5 by rule 31 — certificates and the class-subject list are specified by rules 26-31) · **document verification** (is it a gate on admission, and who verifies) · **application intake** (a prospective parent has no account) · **guardian merge** (no verb yet; money paths already resolve `merged_into_id`; payer identity on past payments, the fee-payer flag and reminder dedupe are unspecified) · **inbound WhatsApp workflow** (matching a message to a guardian and an invoice) · **authorised absence** (the denominator is assumed above) · **platform support access** (the audit mechanism behind the assumption above).
