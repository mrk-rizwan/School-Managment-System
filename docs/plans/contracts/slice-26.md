# Slice 26 contracts — platform billing

**Author:** Opus 5.5 (wave I), 2026-10-06. **Binds:** `apps/api/src/modules/platform/billing/**`
(new), `repositories/platform/{plan,subscription,school-metrics,invoice,platform-payment}.repository.ts`
(new), `repositories/own-invoices.repository.ts` (new), `jobs/{platform-billing,school-metrics-rollup,billing-notices}.ts`
(new), `messaging/platform-alerts.ts` (new), `modules/school-settings/billing-status.controller.ts`
(new); the slice-26 lines of `repositories/platform/{school,platform-settings,platform-audit}.repository.ts`,
`repositories/student.repository.ts` (`countOnRoll`), `modules/platform/schools/*` (cap override,
`terminatedAt`, `retentionEndsOn`), `modules/platform/settings/*` (invoice due day, grace days),
`messaging/{templates,types,queues,messaging.module}.ts`, `jobs/{job-runner,jobs.module,worker-host}.ts`,
`common/errors/constraints-billing.ts`, `eslint.config.mjs` (the `test/platform-billing` block; the
billing boundaries themselves landed with wave H); the web platform console's plans, invoices and
school billing screens and the school settings page's billing card. **Source:**
`phase-3-financial.md` §1.1 (rule 23 rows), §1.2 item 23, A11, A12, A18, §2, §3.6, §3.7, §4
"Platform billing", §5.1 (lint), slice 26, §7.1 ("The platform never reads a school's ledger"),
R219–R224; the main thread's second-revision item 7 (billing by derived tier). Everything not
restated follows the Phase 1 and 2 conventions (envelope, string ids, `PageQueryDto`, `NoQueryDto`,
`@ApiErrors()`, `404` for an absent id, no `DELETE`). Every platform route is
`@PlatformSession('full')` and audited to `platform_audit_log`.

## 1. Routes

### 1.1 Plans (R219)

| Route | Notes |
|---|---|
| `GET /platform/plans` | paginated; `status?`; ordered active first, then band |
| `GET /platform/plans/:id` | `PlanDto { id, name, minStudents, maxStudents \| null, monthlyPrice, smsAllowance, status, archivedAt, createdAt, updatedAt }` |
| `POST /platform/plans` | `{ name (2–60), minStudents (0–1,000,000), maxStudents? (null/absent = unbounded), monthlyPrice (0–MAX_RUPEES), smsAllowance (0–100,000) }` → `201`; `422` on `maxStudents` below `minStudents`; `409 PLAN_BAND_OVERLAPS { planId, minStudents, maxStudents }` naming the active plan it meets (the exclusion constraint is the race backstop, mapped to the same code without details) |
| `PATCH /platform/plans/:id` | `name`, `monthlyPrice`, `smsAllowance` only; a band field is `422` (unknown property: bands are frozen); archived → `409 PLAN_ARCHIVED`; no change → `200`, no audit row. A price or allowance change reaches schools at the next monthly run (A12) |
| `POST /platform/plans/:id/archive` | `{ reason }`; final; a repeat is `200` with no row; `409 PLAN_IN_USE { planId }` while a live subscription points at it. Archive and every subscription write lock the plan row, so the check cannot race an assignment |

No plan is seeded (§1.2 item 23): the first invoice needs the owner's tiers.

### 1.2 A school's plan, cap and bill (R223, A12)

| Route | Notes |
|---|---|
| `GET /platform/schools/:id/billing` | `SchoolBillingDto { subscription: SubscriptionDto \| null, metrics: { day, activeStudents } \| null (the most recent row, any age), invoices: InvoiceDto[] (last 12, newest month first), smsCap: { value, overridden }, terminatedAt, retentionEndsOn }` |
| `POST /platform/schools/:id/assign-plan` | `{ planId, startedOn, reason }` → `SubscriptionDto { id, schoolId, planId, planName, startedOn, endedOn, pinned, assignedByPlatform, reason, createdAt }`. **Pins** the school: billed on this plan whatever its count until unpinned. Idempotent by state: the same plan already pinned → `200` with the live row, no audit. Otherwise the live row ends the day before `startedOn` (or on its own first day if it began on or after), a pinned row starts, `sms_monthly_cap` becomes the plan's allowance and `sms_cap_overridden` is cleared (R223). `startedOn` before the live row's start → `422`; unknown plan → `422 REFERENCE_NOT_FOUND` on `planId`; archived → `409 PLAN_ARCHIVED`; terminated school → `409 SCHOOL_TERMINATED`. A trial school may hold a plan |
| `POST /platform/schools/:id/unpin-plan` | `{ reason }` → `SchoolBillingDto`. Ends the pin today; when a count at most 7 days old lies in an active band, that tier starts today unpinned (`assigned_by` the actor) and, unless overridden, the cap follows its allowance; otherwise the school has no live plan until the next monthly run. Not pinned → `200`, no change |
| `POST /platform/schools/:id/use-plan-allowance` | no body → `SchoolBillingDto`. A12's explicit clear of a manual cap override: the cap becomes the live plan's allowance (no live plan: only the flag clears, the next run sets the cap). Not overridden → `200`, no change |
| `PATCH /platform/schools/:id` (existing) | a `smsMonthlyCap` change now also sets `sms_cap_overridden` (in the same `school.updated` row's `changes`) |
| `GET /platform/schools*` (existing) | `SchoolDto` gains `smsCapOverridden`, `terminatedAt`, `retentionEndsOn` (12 months after termination in Asia/Karachi, day clamped; R224) |
| `GET \| PATCH /platform/settings` (existing) | gains `invoiceDueDay` (1–28, default 10) and `graceDays` (0–90, default 15); audited as before |

### 1.3 Invoices (R220, R221, A11)

| Route | Notes |
|---|---|
| `GET /platform/invoices` | paginated; `status?`, `schoolId?`, `yearMonth?`, `suspensionEligible?` (`true`/`false`; eligible = stamped and still `issued`, R221); sort `-issuedAt` (default) or `dueOn`. `InvoiceDto { id, invoiceNo, schoolId, schoolName, yearMonth, planName, studentCount, amount, dueOn, status, issuedAt, overdueAt, suspensionEligibleAt, paidAt, voidedAt }` |
| `GET /platform/invoices/:id` | `InvoiceDto` |
| `POST /platform/invoices/:id/record-payment` | `{ amount, receivedOn, reference (1–60) }` → `200 InvoiceDto`. Full amount only: `amount` ≠ the invoice's → `422`; `receivedOn` in the future → `422`; not `issued` → `409 INVOICE_NOT_ISSUED { invoiceId, status }` (not replayable). Writes the `platform_payments` row and `issued → paid` in one transaction |
| `POST /platform/invoices/:id/void` | `{ reason }` → `200 InvoiceDto`; not `issued` → `409 INVOICE_NOT_ISSUED`. The month frees (`platform_invoices_month_key` excludes void), so the next run for it issues a new invoice with a new number |
| `POST /platform/invoices/issue-month` | `{ yearMonth }` (not later than the current month, else `422`) → `200 { issued, existing, skipped: [{ schoolId, reason: BillingSkipReason }], failed }`. The monthly run on demand; idempotent |

### 1.4 The school's side (A18)

`GET /school/billing-status` (`school.settings.manage`, school session) → `{ plan: { name,
smsAllowance } | null, currentInvoice: { invoiceNo, yearMonth, amount, dueOn, status } | null,
overdue: boolean, suspensionEligibleAt: date-time | null }`. `currentInvoice` is the latest
non-void invoice by month; `overdue` is any unpaid invoice stamped overdue; `suspensionEligibleAt`
is the oldest unpaid invoice's eligibility stamp. Read through `OwnInvoicesRepository` only.

## 2. The monthly run (R220, A11, A12, main-thread item 7)

`BillingRunService.issueMonth(yearMonth, actor | null, now)`:

1. One read each: the billable schools (`active`, `suspended`; trial and terminated are not listed
   at all), the latest metrics row per school with `day` in `[today − 7, today]` (Asia/Karachi),
   the active plans.
2. No metrics row → skipped `no_metrics`. Otherwise **one transaction per school**, lock order
   school row → plan row → subscription → invoice counter:
   - the school re-read under its lock (gone or no longer billable → ignored);
   - a non-void invoice for the month → `existing` (also the race loser of
     `platform_invoices_month_key`, recovered outside the rolled-back transaction);
   - **left trial at or after the month's first instant** (its `school.status_changed` audit row
     from `trial`) → skipped `trial`: a school turning active mid-month is free until the next 1st;
   - the plan: the live **pinned** subscription's when it started on or before the month's 1st
     (a pin starting later — a future `startedOn`, or mid-month — prices from its first full
     month and is left untouched until then), else `tierFor(count, activePlans)` (inclusive
     bands); none, or archived under the lock → skipped `no_band`;
   - not pinned: the live row continues when its plan is the tier; otherwise it ends the day before
     the 1st (or on its own start) and a new unpinned row starts on the 1st with `assigned_by`
     null — the history of the school's tiers. A run for an earlier month never touches a row
     that started after that month's 1st;
   - `sms_monthly_cap` := the plan's allowance only while `sms_cap_overridden` is false;
   - the invoice: number `INV-<year issued>-<NNNNN>` from `platform_settings.invoice_counter`
     (`UPDATE … RETURNING`, taken last; a rollback gives the number back, so numbers are gapless in
     commit order), amount the plan's monthly price, `student_count` the metrics count, `due_on` =
     `<yearMonth>-<invoiceDueDay>`. **A price-0 plan's invoice is issued `paid`**
     (`platform_payments.amount > 0` could never record it);
   - a hand run audits `platform_invoice.issued`.
3. Any other failure of one school is logged (`failed`), never stops the others.
4. The scheduled run (`actor` null) sends one `billing_tier_missing` email to
   `PLATFORM_ALERT_EMAIL` listing the `no_band` schools first, then `no_metrics` (20 named, the rest
   counted). A hand run returns the list instead.

`platform-billing` job: daily 04:00 Asia/Karachi. On the 1st it issues the month; every day it
stamps (`BillingRunService.stamp`): `overdue_at` on every issued invoice with `due_on < today`,
`suspension_eligible_at` on every issued invoice with `due_on < today − graceDays`; each stamped
once (once-set triggers). Nothing suspends a school (R221); suspension stays the existing manual
status change. A failed 1st is not retried automatically: the console's **Issue month** is the
catch-up.

`school-metrics-rollup` job: daily 00:30, every live school (trial and suspended included), inside
`runAsSchool`: `students` with status `active` or `suspended` (`StudentRepository.countOnRoll`),
upserted as `platform_school_metrics (school_id, day = today in the school's zone)`; a re-run of
the day rewrites the count.

## 3. Lint and the named exceptions

The billing boundaries are those wave H wrote (`billingRepositories`, `ownInvoicesRepository`,
`TENANT_REPOSITORY_IMPORT`, the blocks for `src/modules/platform/billing/**`,
`src/jobs/platform-billing.ts`, `src/jobs/school-metrics-rollup.ts`, `src/jobs/billing-notices.ts`
and `src/modules/school-settings/billing-status.controller.ts`); slice 26 adds only the
`test/platform-billing/**` test block. The modules that wire the two repositories spread a
provider list exported by the importing file (`BILLING_NOTICES_PROVIDERS`,
`BILLING_STATUS_PROVIDERS`, `SCHOOL_METRICS_ROLLUP_PROVIDERS`), so no module file imports them.
The billing module reads `schools` (`SchoolRepository`), `platform_settings`, and
`platform_audit_log` (the trial exit, `PlatformAuditRepository.leftTrialSince`) besides its own
tables — all platform tables; no tenant repository is importable there (R222).

**Proposed `CLAUDE.md` wording** (the main thread edits `CLAUDE.md`):

- Exception 6, replacing its heading and first sentence:
  > 6. **The platform rollups.** `platform_delivery_health` and `platform_school_metrics` are
  > non-tenant tables with a `school_id` column, like `platform_audit_log`.
  > `platform_delivery_health` is written only by `src/jobs/delivery-health-rollup.ts` and read
  > only by `src/modules/platform/messaging/**` (`GET /platform/messaging/health`): counts,
  > statuses and mapped error codes. `platform_school_metrics` (one integer per school per day: the
  > students on the roll) is written only by `src/jobs/school-metrics-rollup.ts`, inside
  > `runAsSchool` with the school's own `SchoolId`, and read only by
  > `src/modules/platform/billing/**` and `src/jobs/platform-billing.ts`. The platform never reads
  > `messages`, `message_deliveries` or `whatsapp_numbers` (R114), nor any charge, payment or other
  > ledger row (R222): a later platform-side figure is another column on these rollups, not a new
  > exception.
- Exception 1, after "Tenant code that reads its own school row uses `OwnSchoolRepository`, whose
  only predicate is `id = schoolId`":
  > , and a school reads its own platform bill — its live plan and its invoices — through
  > `OwnInvoicesRepository`, whose every tenant-keyed predicate is `school_id = schoolId` (the
  > plan row, which carries no school, is read by the id from the school's own subscription),
  > importable only from
  > `src/jobs/billing-notices.ts` and `src/modules/school-settings/billing-status.controller.ts`
  > (`GET /school/billing-status`, phase-3-financial.md A18).
- Exception 1, the platform-tables list gains `platform_plans`, `platform_subscriptions`,
  `platform_invoices`, `platform_payments` (and `platform_school_metrics` under exception 6); the
  billing repositories live in `src/repositories/platform/**` and are importable only from
  `src/modules/platform/billing/**`, `src/jobs/platform-billing.ts` and (metrics, write)
  `src/jobs/school-metrics-rollup.ts`.

## 4. Audit actions (R57, R230)

All to `platform_audit_log` with the platform actor and a subject:
`platform_plan.created | updated | archived` (subject the plan, school null),
`platform_subscription.assigned` (subject the new row; `planId`, `startedOn`, `previousPlanId`,
`smsMonthlyCap {from,to}`, `smsCapOverridden {from,to}`, the reason),
`platform_subscription.unpinned` (subject the ended pin; `planId`, `derivedPlanId`),
`school.sms_cap_override_cleared` (subject the school; `smsMonthlyCap {from,to}`, `planId`),
`platform_invoice.issued` (hand run only; `invoiceNo`, `yearMonth`, `planId`, `studentCount`,
`amount`), `platform_invoice.paid` (`invoiceNo`, `amount`, `receivedOn`, `reference`, `paymentId`),
`platform_invoice.voided` (`invoiceNo`, `yearMonth`, `amount`, the reason); `school.updated` gains
`changes.smsCapOverridden`.

**The scheduled run writes no audit row**: `platform_audit_log_actor_check` admits a null actor only
for `platform_user.seeded` and `login_failure_spike`, and A19's "system actor" exists only in the
tenant `audit_log`. Its record is the invoice row itself, the subscription's `assigned_by = null`,
and the job's log line. Auditing it would need a schema change (a third admitted action).

## 5. Messages

| Type | Vars | Subject |
|---|---|---|
| `platform_invoice_issued` | `{ invoiceNo, yearMonth, dueOn }` | `platform_invoice`, id `invoiceId × 10 + 1` |
| `platform_invoice_overdue` | `{ invoiceNo, yearMonth, dueOn, suspensionEligible }` | id `× 10 + 2` (overdue), `× 10 + 3` (eligible) |
| `billing_tier_missing` | `renderBillingTierMissing({ yearMonth, skipped })` | no `messages` row; `PlatformAlerts` |

R107 keys a message by person and subject, not type, so the three notices of one invoice are three
subject ids. `billing-notices` (daily 09:30, per live school, in `runAsSchool`, one transaction)
sends, for each **unpaid** invoice of the school (`OwnInvoicesRepository.unpaid`), the issued
notice, then the overdue notice once `overdue_at` is set and the eligibility notice once
`suspension_eligible_at` is set, to every active principal; a re-run writes nothing new and a paid
or void invoice gives no further notice. Bodies carry the invoice number, month and due date but
**no amount** (R238; the amount is on the settings page). Titles: "Subscription invoice",
"Subscription invoice overdue".

## 6. Constraints (`constraints-billing.ts`)

`platform_plans_band_excl` → `409 PLAN_BAND_OVERLAPS`; the archived-plan frozen columns → `409
PLAN_ARCHIVED`; `platform_plans_{band,name,money}_check`, `platform_payments_reference*_check`,
the `_no_id_check`s and the two settings CHECKs → `422` on the field;
`platform_subscriptions_live_key`, `platform_subscriptions_ended_on_frozen`,
`platform_invoices_month_key`, `platform_invoices_invoice_no_key` → `409 CONCURRENT_UPDATE`;
`platform_invoices_status_transition`, the paid/void frozen stamps and
`platform_payments_invoice_id_key` → `409 INVOICE_NOT_ISSUED`.

## 7. Deviations from the plan

- `assign-plan`'s `reason` is **required** (the plan wrote `reason?`): after item 7 every
  assignment is a pin, and `platform_subscriptions_pinned_check` requires a reason on a pinned row.
- `POST /platform/schools/:id/use-plan-allowance` is new: A12 names "clearing it is an explicit
  action ('use the plan's allowance')" but the route table had none.
- `POST /platform/schools/:id/unpin-plan` is new (the task's "unpin-plan"; the slice table had
  only assign-plan).
- `IssueMonthResultDto` gains `existing` and `failed` beside `issued` and `skipped`.
- `SubscriptionDto.assignedByPlatform` (boolean) instead of a platform user id.
- `BillingSkipReason` `terminated` is never produced: terminated (and trial) schools are not
  listed; `trial` is produced for a school that left trial during or after the billed month.
- The scheduled run is not audited (§4).
- A free plan's invoice is issued `paid` (§2).
- The invoice number's `NNNNN` is a global counter; past invoice 99,999 the CHECK refuses an
  issue (a widening is a schema change, far off).
