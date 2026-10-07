# Slice 22 contracts — fee reminders, finance reports, dues clearance

**Author:** Opus 5.5 (wave K), 2026-10-06. **Binds:** `apps/api/src/modules/finance-reports/**`
(`finance-reports.{controller,dto,service,module}.ts`, `fee-reminders.ts`),
`apps/api/src/repositories/finance-report.repository.ts` (in `RAW_SQL_FILES`); the slice-22 lines in
`messaging/{templates,types,queues,notification.service}.ts`, `jobs/{job-runner,jobs.module,worker-host}.ts`
and `app.module.ts`; the web `app/(school)/reports/**`, the student page's clearance panel and status-dialog
warning. **Source:** `phase-3-financial.md` §0.20, §1.1 ("Reminder cadence"), §3.6–§3.8, §5 slice 22, §7.2
and R201–R205, R228, R250. **Schema:** none of its own. Reminders are messages; the override is an audit
row (wave K schema notes, migration `20261006170000_slice21_payment_claims`). Conventions not restated
follow slices 6, 13 and 18–20 (envelope, string ids, `PageQueryDto`, `@ApiErrors()`, `404` for another
school's id, no `DELETE`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /finance-reports/defaulters` | `finance.report.view`, throttle `finance-reports` (30/min, 300/h per user) | paginated; `classId?`, `sectionId?` (the student's latest enrolment), `minOutstanding?`, `overdueOnly?`; sort `-outstanding` (default), `studentName`, `className`, `oldestDueOn`, `-oldestDueOn`. Today only, every year (arrears included) |
| `GET /finance-reports/collections` | same | `receivedFrom`, `receivedTo` (≤ 92 days, `422` on `receivedTo`), `groupBy`, `basis` (default `verified`); §2 |
| `GET /finance-reports/outstanding` | same | `academicYearId` (`422 REFERENCE_NOT_FOUND`), `groupBy` (default `class`); `{ asOf, rows, total, adjustments }` |
| `GET /finance-reports/daily-cash` | same | `date`; §2 |
| `GET /finance-reports/concessions` | same | `academicYearId`, `groupBy` (default `feeHead`); `{ rows: [{ key, label, students, reduction }], total }` |
| `GET /finance-reports/expenses` | same | `spentFrom`, `spentTo` (≤ 92 days), `groupBy` (default `category`); `recorded` and `approved` rows; `pendingApproval`; `subThresholdByRecorder` (status `recorded`, R208) |
| `GET /finance-reports/payroll` | same | `from`, `to` months, at most 24 inclusive (`422` on `to`); finalised runs; `{ rows, total }` |
| `POST /fee-reminders/send` | `charge.campaign.send`, throttle `fee-reminders-send` (5/min, 30/h per user) | `{ kind: due \| overdue, classId? \| sectionId? \| studentIds?[1–50] }`; two targets `422` on `classId`; an unknown target `422 REFERENCE_NOT_FOUND`; no target = every family. `200 { families, smsUnits, enqueued, capped }` (§3) |
| `GET /students/:id/dues-clearance` | `fee.statement.view` | `{ studentId, outstanding, openCharges: ChargeDto[] (oldest due first, ≤ 100), advance, cleared, override }` (§5) |
| `POST /students/:id/dues-clearance/override` | `certificate.issue` + `requirePrincipal` | `{ reason }` (`@Reason`); `200 DuesClearanceDto`; `409 SELF_ACTION_FORBIDDEN { reason: 'own_child' }` when the principal is the child's guardian (R232, no sole-principal exception) |

Grouped reports return bounded objects (one row per group), not pages. Report rows are
`{ key, label, amount, count }`: the key is an id (class, fee head, recorder, collector), a code (method,
category), a day or a month; `feeHead` collections key by the receipt line's snapshotted head name
(`Advance` for the advance line), `class` by the student's latest enrolment in the receipt's year.

## 2. What each figure is (§0.20, R205)

- **Collections** read receipts of `verified` payments whose basis date is in the window: `received` =
  `received_on`, `verified` = the school day of `verified_at` (rule 25). A claim is not a payment and a
  carried-forward payment has no receipt, so neither is ever in `total`. `voided` = the window's receipts
  since voided (never in `total`). `refunds`, `refundReversals`, `carriedForward` and
  `carryForwardReversals` (carry-forwards undone, phase close G1) are the reversal rows **made** in the
  window (dated by `created_at`); a carry-forward undone later stays in `carriedForward` of its own window,
  and neither is ever in `total` or `net`. `net = total − refunds + refundReversals`.
  A refund of a carried payment is a refund in the target year (slice 20 §8): it appears wherever its row
  is dated, like any refund.
- **Outstanding** = Σ `amount − allocated_amount − credited_amount` over the year's open charges
  (adjustment rows are settled, so never in it); `adjustments` = the year's live adjustment rows.
- **Daily cash** is over the cash payments **received that day**: each is voided while with its collector
  (`voidedBeforeHandover`), still with its collector (`withCollectors`, per recorder, `since` = the oldest
  `recorded_at`), or in a handover (`handedOver`, open or confirmed; `fromDay` is the day's part, the other
  figures the whole handover's; a void after the handover stays in it and is `voidedAfterHandover`). So
  `cashReceived − voidedBeforeHandover = Σ withCollectors.amount + Σ handedOver.fromDay`, and per handover
  `counted − expected = surplus − shortfall`. Cash out on the day: `refundsPaidCash` (cash refunds made that
  day minus the reversals of cash refunds made that day), `cashExpenses` (recorded and approved cash
  expenses spent that day; a written-off shortfall is one, slice 20 §8, and is also `shortfallWrittenOff`),
  `salariesPaidCash` (payslips paid that day in cash, Σ net).
- **Concessions** = Σ `concession_amount` of live non-adjustment charges (taken at birth) + Σ live
  adjustment rows carrying a `concession_id` (A6's credits); `students` counts each student once.
- **Payroll** per finalised month: `gross` = Σ basic + allowances, `deductions` = Σ named deductions +
  absence + advance recoveries, `adjustments` = Σ signed adjustments, `net = gross − deductions +
  adjustments`; `paid` / `unpaid` split `net` by payslip status.

## 3. Fee reminders (R201, R202, R250)

No table. A reminder is a `messages` row with subject (`fee_reminder`, `YYYYMM × 10 + n`): `n = 0` for the
due reminder of the due date's month, `n = 1, 2` for the month's overdue reminders. R107's
`messages_subject_guardian_key` therefore makes "one due reminder per family per due month" and "at most
two overdue reminders per family per month" database facts; a retried or racing send writes nothing twice.

- **Families**: live fee-paying links to unmerged guardians of every child with an open charge (one scan of
  the open charges, `reminderLinks`). A family whose children's pending claims sum to at least what it owes
  is skipped (R201). Ordered oldest overdue first, then nearest due date, then guardian id (R202).
- **Due** (`fee_due_reminder { total, children, dueOn }`): the family's nearest upcoming due date is within
  `feeReminderDaysBefore` days (scheduled), or any upcoming date (manual; the already-sent check reads the
  subject of each family's own due month, however far ahead); total = everything the family
  owes; children = those owing anything.
- **Overdue** (`fee_overdue { overdue, children, since }`): the family's oldest past-due charge is at least
  the grace past its due date (scheduled: `lateFeeGraceDays` while late fees are on, else 7, as slice 19's
  `chargeGrace`; manual: anything past due), fewer than two overdue reminders this month, and the last one
  (this month's or last month's subjects) at least `overdueReminderEveryDays` school days ago. The cadence
  reads the message's `created_at`: a backdated clock in a test does not move it.
- **SMS allowance** (R250): units left = `sms_monthly_cap − message_usage` this month − the SMS units of
  messages written but not yet attempted on SMS (queued or sending, an always-SMS leg, no SMS delivery
  row yet; their segments), one budget for the overdue and due reminders of a run, spent **overdue
  families first, then due** (the oldest debts keep SMS, R202). The figure is advisory: two concurrent
  runs can read the same budget; the processor's `reserveSms` is what holds the cap. In family order, a family whose plan has an always-SMS leg (not the
  WhatsApp after-failure leg) spends one unit (every reminder body is one segment, R110) while units remain;
  after that every SMS leg is dropped, so the family goes by WhatsApp or push, or is suppressed
  `cap_reached` when SMS was its only way (`fitSmsBudget`). `NotificationService.sendEach` gained an
  optional precomputed `planned` (as `send` has) to write the narrowed plan. When any family lost SMS and the
  allowance ran out during the run (units were left when it started; a cap of 0 or a month already used
  up tells nobody) the active principals get `reminder_sms_capped { families }`, subject (`fee_reminder`,
  `YYYYMMDD`): once per school day across the job and manual sends.
- **The job** `fee-reminder` (scheduled queue, 09:00 school time, `REMINDER_JOB_TIMEOUT_MS` 60 s, one
  transaction per school): overdue, then due; audited as the system actor `fee_reminder.scheduled_sent`
  (`job: 'fee-reminder'`, counts) when it reminded anyone (A19; a route's action is never actorless).
- **The route** runs the same dispatch for the target's families in the request transaction; audited
  `fee_reminder.sent` (subject `fee_reminder` = the school day `YYYYMMDD`, R57 needs one; kind, target kind, families, smsUnits, cappedFamilies). `families` = reminders
  written now; `enqueued` = those with a WhatsApp, SMS or push leg; `capped` = families that lost SMS.

## 4. Messages

| Type | Vars | Notes |
|---|---|---|
| `fee_due_reminder` | `total`, `children[]`, `dueOn` | "School: Fee reminder: Rs 7,000 for Hamza Tariq, Hira Tariq is due Sat 10 Oct. Please pay at the school office." One segment with the longest fixtures (names cut to fit); title `Fee reminder`; push title-only (`TITLE_ONLY_PUSH`, R238) |
| `fee_overdue` | `overdue`, `children[]`, `since` | "School: Fees overdue: Rs 6,000 for …, unpaid since Mon 10 Aug. Please pay at the school office."; title `Fees overdue`; push title-only |
| `reminder_sms_capped` | `families` | internal (push, email) to the principals; no amount; title `Reminder SMS capped`: "School: 3 families could not be reminded by SMS because this month's SMS allowance is used up." (true whether a family went by WhatsApp or push, or was suppressed) |

The three left `TEMPLATE_PENDING` in the identity scan, which is now empty.

## 5. Dues clearance (R204, A7)

`outstanding` is across every enrolment and every year; `advance` is the child's unspent advance in every
year (refundable, rule 20). `cleared` = nothing owed, or an override that is newer than the newest open
charge's `created_at` **and** overrode at least what the student owes now (`outstanding ≤
metadata.outstanding`). The override is the audit row `dues_clearance.overridden` (subject the student, `reason`,
`metadata.outstanding`); `GET` reports the latest one only while both hold, so a charge
opened afterwards, or a voided payment that reopens an old charge and raises the outstanding, makes the
student uncleared again. Phase 4's certificate issue calls this; until
then the web shows it on the student page and as a **warning** in the status-change dialog when the new
status is a leaving one (rule 20 blocks the certificate, not the status). An override of a student who
owes nothing is accepted and recorded.

## 6. Audit actions (R57, R230)

`fee_reminder.sent` (route), `fee_reminder.scheduled_sent` (job, system actor),
`dues_clearance.overridden`. The reports write nothing.

## 7. Performance (§7.2)

`test/finance-reports/reports-perf.e2e-spec.ts` (run it `--runInBand`): 3,000 students in 30 classes, 2,000
families, 36,000 open charges (twelve months, the defaulter list's worst case) and 9,000 receipted
payments over 92 days, loaded in bulk SQL and `ANALYZE`d. Measured 2026-10-06 on a machine running another
agent's suites: defaulters first page **≈ 50 ms** (median of five; budget 300 ms; the aggregate reads
`charges_open_by_student_idx` index-only, no heap fetches), collections over 92 days **≤ 140 ms** for every
grouping and basis (budget 500 ms; `class` is the slowest: one enrolment lookup per receipt line), the
fee-reminder job **≈ 2.9–4.3 s** for 2,000 overdue families, **10.3 s** on a day both kinds fired (2,000 due
and 2,000 overdue reminders; budget 20 s). On statistics left stale by a
bulk load the defaulter page measured 500–900 ms and the `class` grouping 4 s: the figures assume
autovacuum's analyze, as live tables have.

## 8. Tests

`test/finance-reports/`: `reports.e2e-spec.ts` (R203, R205, R208, the daily-cash identity, payroll, R234),
`reminders.e2e-spec.ts` (R201, R202, R250, the manual send), `clearance.e2e-spec.ts` (R204, R233, A7),
`reconciliation.e2e-spec.ts` (**R228**: a scripted year through the APIs — admission after the cut-off, a
concession applied to open charges, late fees and a waiver, sibling and partial payments, an advance, a
void, a refund and its reversal, a carry-forward and a second one undone, a deposit claim verified 35 days after it was paid
through slice 21's verify, a handover shortfall written off, unpaid leave, a payroll run and its correction
— then every §0.20 identity against the database and the reports), `isolation.e2e-spec.ts` (control 4 for
the raw statements), `reports-perf.e2e-spec.ts` (§7.2); `src/modules/finance-reports/reminder-messages.spec.ts`
(templates in one segment, `fitSmsBudget`). The month's unpaid leave in the R228 year is written directly:
the leave API takes a request at most seven days back (slice 24).
