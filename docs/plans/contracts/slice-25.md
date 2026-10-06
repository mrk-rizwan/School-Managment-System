# Slice 25 contracts — salary structures, advances, payroll runs, payslips

**Author:** Opus 5.5 (wave J), 2026-10-06. **Binds:** `apps/api/src/modules/payroll/**`,
`repositories/{salary-structure,salary-advance,payroll-run,payslip}.repository.ts`,
`common/errors/constraints-payroll.ts`, the `payroll-prepare` lines of `src/jobs/**` and
`messaging/queues.ts`, the `payslip_ready` lines of `messaging/{types,templates,message-processor}.ts`;
the web `/payroll`, `/payroll/[id]`, `/my-payslips` and the staff page's Salary tab; the mobile
`payslips/**` and `/home/my-payslips`. **Source:** `phase-3-financial.md` §3.1, §3.3, §3.5, §4
"Payroll", slice 25 (R213–R218, R235, R245–R247, R253) and migration
`20261006140100_slice25_payroll`. Everything not restated follows the Phase 1–3 conventions
(envelope, string ids, `PageQueryDto`, `NoQueryDto`, `@ApiErrors()`, `404` for another school's
id, no `DELETE`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /staff/:id/salary-structure` | `staff.contract.manage \| payroll.view` | paginated, newest `effectiveFrom` first (current and history) |
| `POST /staff/:id/salary-structure` | `staff.contract.manage` + `Idempotency-Key` (`salary_structures`, path id the staff member) | §2 |
| `GET /me/staff/salary-structure` | `@RequireStaff()`, `me-reads` | `MySalaryStructureDto { current, upcoming }`: the active row in force today and the next recorded one, each nullable |
| `GET /salary-advances`, `GET /salary-advances/:id` | `payroll.view` | `staffId?`, `status?`; newest grant first |
| `POST /salary-advances` | `payroll.run` + `requirePrincipal` + `Idempotency-Key` (`salary_advances`, path id the staff member) | §3 |
| `POST /salary-advances/:id/write-off` | `payroll.run` + `requirePrincipal` | `{ reason }`; never one's own; `409 ADVANCE_NOT_OPEN` |
| `GET /payroll-runs`, `GET /payroll-runs/:id` | `payroll.view` | newest month first; `PayrollRunDto` as the plan, plus `finaliseReason` |
| `GET /payroll-runs/:id/payslips` | `payroll.view` | by staff name; a draft's payslips carry `days` (§4) |
| `POST /payroll-runs` | `payroll.run` | `{ yearMonth }`; §4 |
| `POST /payroll-runs/:id/payslips` | `payroll.run` | `{ staffId, reason }`: a correction payslip (§5); draft only (`409 PAYROLL_RUN_FINALISED`); a staff id not of the school `404`; a payslip already in the run `409 PAYROLL_RUN_EXISTS { runId, payslipId }`; never a structure `422 SALARY_STRUCTURE_MISSING`; audited `payslip.added` |
| `POST /payroll-runs/:id/recompute` | `payroll.run` | draft only, else `409 PAYROLL_RUN_FINALISED` |
| `POST /payroll-runs/:id/finalise` | `payroll.run` | `{ reason? }`; §5; `409 PAYROLL_RUN_NOT_DRAFT` |
| `GET /payslips/:id`, `GET /payslips/:id/print` | `payroll.view` | print through `sendPrintView` |
| `POST /payslips/:id/adjust` | `payroll.run` + `Idempotency-Key` (`payslip_adjustments`, path id the payslip) | `200 PayslipDto` (a replay too, `Idempotency-Replayed`); §5 |
| `POST /payslips/:id/mark-paid` | `payroll.run` | `{ paidOn ≤ today, paidMethod, paidReference? }`; finalised run only (`409 ILLEGAL_STATUS_TRANSITION { status: 'draft' }`), once (`409 PAYSLIP_PAID`) |
| `GET /me/staff/payslips`, `GET …/:id`, `GET …/:id/print` | `@RequireStaff()`, `me-reads` | own payslips of **finalised** runs only; anyone else's, or a draft's, is `404` (R217) |

`PayslipDto` is the plan's shape plus `runStatus`, `paidReference`, `deductionsNotTaken
[{ name, amount }]` (what each named deduction wanted, pro-rated, and could not take: §3.3 "listed,
not carried", derived from the structure at read) and `days` (§4). Lines carry `id`, `kind`,
`name`, `amount`, `adjustsPayslipId`, `reason`. Print routes declare `text/html` as the 200's own
content (not `@ApiProduces`, which would turn the error envelope into HTML too).

## 2. Salary structures (one transaction)

1. Claim the key; lock the staff row (`404` when absent).
2. Component names unique per kind, case-insensitively (`422 components.<i>.name`); position =
   the index, deductions taken in that order.
3. Own row: refused `409 SELF_ACTION_FORBIDDEN { reason: 'own_salary' }` unless
   `PermissionsService.isSolePrincipal` (under the settings lock), then `self_approved` (R253).
4. Against the latest active row: an earlier `effectiveFrom` is `422 effectiveFrom`; R213 — when a
   payslip of a finalised run of a month **≥ the month of `effectiveFrom`** references that row,
   `409 SALARY_STRUCTURE_IN_USE { structureId, yearMonth }`; the same day **supersedes** it (the new
   row inherits its `ended_on`; `superseded_by` set after the insert); a later day **closes** it on
   `effectiveFrom − 1`.
5. Audit `salary_structure.created` (`staffId`, `basic`, totals, `selfApproved`, `supersededId` or
   `closedId`).

## 3. Advances

Principal only (R233) and never one's own (`409 { reason: 'own_advance' }`, no exception). Staff
must be active; `grantedOn ≤ today`; `instalmentAmount ≤ amount`; `recoverFrom` defaults to the
month after `grantedOn` and may not be before its month. `recordAsExpense` writes a
`salary_advance_cash` expense in the same transaction (expense counter taken just before it):
above the school's threshold it is `approved` and `self_approved` by the granting principal (R206's
rule), otherwise `recorded`; audited `expense.recorded` with `source: 'salary_advance'`. Audit
`salary_advance.granted`, `salary_advance.written_off`.

## 4. The run (R214, R245–R247; `PayrollEngine`)

**Preparable months:** before the current month, or the current month from its last staff working
day (`422 yearMonth` otherwise). One run per month (`409 PAYROLL_RUN_EXISTS { runId }`; the race
loser maps from `payroll_runs_month_key`). **Inputs, read once per run:** candidates = staff joined
by the month's end (or no join date) and active, suspended, or left on/after its 1st; their active
structures overlapping the month; staff attendance marks; approved and ended-early leave (to the day
taken) with the type's `paid`; open advances with `recover_from ≤` the month, grant order.
**Per staff member:** suspended → skipped `suspended`; employed window = later of the 1st and
`joined_on` to the earlier of the month end and `left_on`; the structure active on the window's last
day, else skipped `no_salary_structure`; then `computePayslip` (`proRate`, `unpaidDays`,
`absenceDeduction` on the **full** basic, `payslipNet`). Lines: allowances, deductions taken,
`Unpaid absence, N days`, `Advance of <d Mon yyyy>` per recovery. **Recompute** rewrites each
existing slip in place (computed lines deleted and rewritten, adjustment lines kept), adds slips for
new staff, and — because a payslip is never deleted — keeps a slip of someone the run now skips with
nothing computed (net = its adjustments; reason `not_employed` unless suspended). **Review days:**
for a draft, each payslip read (`GET …/payslips`, `GET /payslips/:id`) recomputes from today's data
the working days behind the counts: `days { unpaid, unmarked, unapprovedLeave }` (the matrix applied
one day at a time). Null for a finalised run and on `/me`.

`payroll-prepare` (scheduled daily 03:00 school time): on the school's `pay_day` **or any later day
of the month** (a missed pay day is caught up) prepares the previous month if it has no run
(`findByMonth` keeps it idempotent); audited as the system actor, action **`payroll_run.auto_prepared`**
(a route's action may never be actorless).

## 5. Correction payslips, adjust, finalise

**R214 note — corrections for people the run does not pay (R216).** The run computes only staff
employed in the month with a structure, so someone who left before it, is suspended, or had no
structure when it was prepared has no payslip to carry a correction. `POST /payroll-runs/:id/payslips`
adds one with nothing computed (basic, allowances and every computed figure 0, no computed line) on
the person's latest structure of **any** status, and lists them in `skipped` with the reason
(`suspended`; `not_employed` when they left before the month; else `no_salary_structure`). Adjust,
recompute and finalise then treat it as any payslip the run keeps: recompute leaves it empty (net =
its adjustments) unless the person has become payable, when it is computed normally. A payslip with
nothing computed is **not a use of its structure** for R213 (`usedByFinalisedFrom` counts only
payslips with a basic, allowances or a computed line) and **earns no `payslip_ready`**.


**Adjust:** draft only (`409 PAYROLL_RUN_FINALISED`); never one's own slip
(`409 { reason: 'own_payslip' }`, trigger `payslip_adjust_not_self`); `adjustsPayslipId` must be a
payslip of the same staff member in a finalised run of an **earlier month** than this run
(`422 adjustsPayslipId` otherwise). The slip is recomputed
with the new line and the run's total moved by the change. **payslipNet's refusal** (adjustments
beyond basic + allowances) is `422 VALIDATION_FAILED` on `amount`, naming the pay — the transaction,
line included, rolls back. On a recompute or finalise the same refusal is `422` on `adjustments`.
**Finalise:** a finaliser whose own slip carries an adjustment and who is not a principal is
`403 PERMISSION_DENIED { reason: 'principal_required' }`; the open advances are locked in id order,
the draft is **recomputed from today's data** (so recoveries are what is still owed), the run is
finalised, then `salary_advance_recoveries` are written (the trigger raises each advance). One
`payslip_ready` per staff member with a computed payslip, subject `{ type: 'payslip', id: <runId> }`.
**No attendance lock:** finalise reads attendance and leave as they stand; a mark amended while it
runs, or after, is not in the frozen payslips and becomes an adjustment in the next run (§1.1
"attendance amended after finalise becomes an adjustment in the next run").
Recompute and finalise rewrite the existing payslips in bulk (`PayslipRepository.rewriteMany`: one
delete of computed lines, one figure update per payslip, one insert of every line); the advances a
finalise recovers from are locked one by one in id order (a single `updateMany` would not lock in a
guaranteed order, and raw SQL is not used for it).

## 6. Constraint map (`constraints-payroll.ts`)

Not-self triggers → `409 SELF_ACTION_FORBIDDEN` with `own_salary | own_advance | own_payslip`;
`payroll_runs_month_key` → `PAYROLL_RUN_EXISTS`; finalised-run triggers and frozen run columns →
`PAYROLL_RUN_FINALISED`; paid columns → `PAYSLIP_PAID`; advance status/write-off columns →
`ADVANCE_NOT_OPEN`; recovery counter races → `CONCURRENT_UPDATE`; `_no_id_check`s → `422` on their
field. `payslips_net_check`, `payslip_lines_adjustment_kept` and the paid-together CHECK stay `500`.

## 7. Messages

`payslip_ready { yearMonth }`, internal (push, email), title "Payslip ready", body "<School>: Your
payslip for <Mon yyyy> is ready. Open ASMS to see it." — no amount (R238); also in
`TITLE_ONLY_PUSH`.

## 8. Audit actions (R57)

`salary_structure.created`, `salary_advance.granted` (+ `expense.recorded`),
`salary_advance.written_off`, `payroll_run.prepared | recomputed | finalised`, `payslip.adjusted`,
`payslip.added`, `payslip.paid`; the job's `payroll_run.auto_prepared` (actor null, `metadata.job`).

## 9. Clients

**Web:** `/payroll` (Runs: list, prepare a month; Advances: list, grant and write off for a
principal holding `payroll.run`), `/payroll/[id]` (summary, skipped list, payslips with the review
days, Adjust, Recompute, Finalise, Mark paid, Print), the staff page's **Salary** tab
(`staff.contract.manage | payroll.view`; history; set or change salary), `/my-payslips` (every staff
member). Print opens the API's print route in a new tab with the session cookie. **Mobile:** Home
card "My payslips" → `/home/my-payslips`: salary and finalised payslips read online only (no cache,
no outbox), a payslip rendered natively in a sheet and shared as text through the share sheet.

## 10. Measured (§7.2)

`test/payroll/payroll-perf.e2e-spec.ts`, asserted at **500 staff** (3 components each, 26 marks
each, leave for 125, advances for 100): prepare **2.7 s** (budget 5 s, which §7.2 sets for 200);
recompute **5.2 s** and finalise **5.7 s** over HTTP, each asserted under **10 s** (the request
transaction limit is 15 s). At 200 staff before the bulk rewrite: prepare 0.66 s, recompute 2.3 s,
finalise 2.6 s. The per-payslip figure update is what remains linear.
