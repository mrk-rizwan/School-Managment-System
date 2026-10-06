# Slice 19 contracts — charges, generation, concessions, campaigns, late fees

**Author:** Opus 5.5 (wave I), 2026-10-06. **Binds:** `apps/api/src/modules/fees/{charges,concessions,campaigns}.*`,
`charge-generation.ts`, `admission-fees.ts`, `campaign-audiences.ts`, `charges.shared.ts`, `fee-gates.ts`;
`apps/api/src/repositories/{charge,charge-run,charge-generation,charge-campaign,concession}.repository.ts`;
`common/errors/constraints-charges.ts`; the slice-19 lines in `messaging/{templates,types,queues,outbox-dispatcher,
notification.service,message-processor}.ts`, `jobs/{job-runner,jobs.module,worker-host}.ts` and the admission and
readmission services. **Source:** `phase-3-financial.md` §1.1, §1.3 (A1–A7), §3.1–§3.7, §4 "Concessions, charges,
runs", §5 slice 19, §7.2 and R179–R186, R205, R232, R233, R239–R242, R252, R253. **Schema:** migration
`20261006100100_slice19_charges` (the schema agent's; used as it is). Conventions not restated follow slices 6, 13
and 18 (envelope, string ids, `PageQueryDto`, `@ApiErrors()`, `404` for another school's id, no `DELETE`,
`Idempotency-Key` replays answer `200` with `Idempotency-Replayed: true`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /charges`, `GET /charges/:id` | `fee.statement.view \| charge.create` | filters `studentId, academicYearId, classId, sectionId, feeHeadId, period, status, kind, dueFrom, dueTo, voidedFrom` (the last feeds the "charges voided this week" tile); sort `-dueOn` (default), `dueOn`, `studentName` |
| `POST /charges` | `charge.create` + key (`charges`, path id the enrolment) | a `manual` charge: `STUDENT_NOT_ACTIVE` unless active or suspended, `422 enrolmentId` for an ended enrolment, `ACADEMIC_YEAR_CLOSED`, `FEE_HEAD_ARCHIVED`, `422 dueOn` before today; `applyConcession` applies the approved concession on that head in force for the due month (`concessionAmount`) |
| `POST /charges/:id/void` | `charge.create \| concession.grant` | `{ reason }`. `manual`/`campaign` need `charge.create`; `generated`/`late_fee` need `concession.grant` **and** `requirePrincipal`; `CHARGE_NOT_OPEN` (adjustment rows included), `CHARGE_HAS_ALLOCATIONS`, and `CHARGE_HAS_ALLOCATIONS { reason: 'has_credits' }` for a charge (or its open late fee) carrying a credit; own child (sole principal excepted, `selfApproved` in the audit); the charge's open late fee is voided with it |
| `POST /charges/:id/waive` | `concession.grant` + principal | late fees only: `CHARGE_NOT_LATE_FEE`, `CHARGE_NOT_OPEN`, `CHARGE_HAS_ALLOCATIONS`; own child as void |
| `POST /charges/:id/adjust` | `concession.grant` + principal + key (`charges`, path id the charge) | `{ amount ≥ 1, reason }` → `201` the `adjustment` row (settled; the trigger raises the original's `credited_amount` and settles it at zero owed). **Up to what is owed only:** `amount > outstanding` is `409 CHARGE_NOT_OPEN { chargeId, reason: 'exceeds_outstanding', outstanding }` — see §8 |
| `POST /charges/generate-month` | `charge.create` (`regenerateVoided` also needs `concession.grant` + principal) | `{ academicYearId, period, regenerateVoided? }` → `201 ChargeRunDto` (queued) or `200` with the run already queued or running for that year and month; `MONTH_NOT_GENERATABLE { reason: future \| outside_year \| year_closed }` |
| `GET /charges/generation-runs`, `/:id` | `charge.create \| finance.report.view` | newest first; `skippedClasses[]` carries `className` |
| `GET /students/:id/fee-statement` | `fee.statement.view` | `academicYearId?` (default the latest enrolment's year), `page/limit` page the charges; `adjustments`, `concessions`, `totals { charged, concession, adjustments, paid, outstanding, advance }` with `charged − concession − adjustments − paid = outstanding`; `payments: []` and `advance: 0` until slice 20 |
| `GET /concessions`, `/:id` | `concession.grant \| charge.create` | `status?`, `studentId?`, `academicYearId?`; sort `-requestedAt` (default), `requestedAt`. The principal's queue is `status=requested` |
| `POST /concessions` | `charge.create` + key (`concessions`, path id the student) | a principal holding `concession.grant` creates it `approved` (`directApproval`), else `requested` and every active principal gets `concession_requested`; `CONCESSION_EXISTS { concessionId, feeHeadId }`, `CONCESSION_HEAD_NOT_ELIGIBLE { feeHeadId }`, `FEE_HEAD_ARCHIVED`, `ACADEMIC_YEAR_CLOSED`, `422` for a percentage over 100, a month outside the year, a repeated head, a student with no enrolment in the year; own child refused on a direct approval (sole principal excepted, `selfApproved`) |
| `POST /concessions/:id/approve` | `concession.grant` + principal | `{ reason?, applyToOpenCharges? }` → `{ concession, adjustments: ChargeDto[] }`; `CONCESSION_NOT_PENDING`, `ACADEMIC_YEAR_CLOSED`, own child; `applyToOpenCharges` refuses with `CHARGE_RUN_IN_PROGRESS` while a run of the year is queued or running |
| `POST /concessions/:id/reject` | same | `{ reason }` (required); `CONCESSION_NOT_PENDING` |
| `POST /concessions/:id/end` | same | `{ reason }`; only `approved` (else `409 ILLEGAL_STATUS_TRANSITION`); future charges only |
| `GET \| POST /charge-campaigns`, `GET \| PATCH /charge-campaigns/:id` | `charge.campaign.send` (writes also need `charge.create`, §3.1) | create keyed (`charge_campaigns`, path id the academic year); the head must be live and `per_term` or `ad_hoc` (`422 feeHeadId`); `dueOn` inside the year; audiences 1–20 of `everyone \| students \| class \| section \| student` under the slice-14 shape rules (`422`), targets of the campaign's year (`422 REFERENCE_NOT_FOUND`); PATCH edits a draft only (`CAMPAIGN_NOT_DRAFT`), `audiences` replaces the set |
| `POST /charge-campaigns/preview-targets` | `charge.campaign.send` | `{ academicYearId, feeHeadId, amount, applyConcessions?, audiences }` → `{ targets: { students, enrolments }, concessions: { affected, totalReduction } }`; writes nothing |
| `POST /charge-campaigns/:id/generate` | same | draft → `generating` and a `campaign` run → `201 ChargeRunDto`; `CAMPAIGN_NOT_DRAFT`, `CAMPAIGN_NO_TARGETS`, `CHARGE_RUN_IN_PROGRESS` (any run of the year queued or running), `MONTH_NOT_GENERATABLE { reason: year_closed }`, `FEE_HEAD_ARCHIVED` |
| `POST /charge-campaigns/:id/cancel` | same | `{ reason }`; `draft \| generated` → `cancelled`, voids nothing; `generating` → `CAMPAIGN_NOT_DRAFT` |
| `POST /admissions`, `POST /students/:id/readmit` | unchanged keys | `+ admissionFee?: { decision: full \| partial \| free, amount? }`; `+ charges: ChargeDto[]` in the response (the enrolment's `once` charges; empty for a caller holding no finance key, R234). Readmit now answers `ReadmissionResultDto` (`StudentDetailDto` + `charges`) |

`POST /fee-structures` (slice 18) now refuses `409 CHARGE_RUN_IN_PROGRESS { runId }` at its step 4 while a run of
the year is queued or running (slice-18 contract §1.1).

## 2. Audit actions (R57, R230)

`charge.created`, `charge.voided` (kind, amount, period, `lateFeesVoided`, `selfApproved`), `charge.waived`,
`charge.adjusted` (amount, `outstandingBefore`, `selfApproved`), `charge.admission_fee` (one per once-head charge,
with the decision), `charge_run.requested`, `charge_run.completed` (written by the job against the requester:
counts, inserted amount, `job: 'charge-run'`), `concession.created` (`directApproval`, `selfApproved`),
`concession.approved` (`appliedToOpenCharges`, `creditedAmount`, `selfApproved`), `concession.rejected`,
`concession.ended`, `charge_campaign.created | updated | generate_requested | cancelled`.

**The system actor (A19).** Migration `20261006130000_slice19_system_actor_audit` relaxes `audit_log_actor_check`:
exactly one actor, or none at all when `metadata` carries `job` (an actorless row without it is still refused).
`AuditLogRepository.recordSystem` is the one writer. A requested run is audited against its requester
(`charge_run.completed`, `job: 'charge-run'`); every job path is audited as the system actor, in the transaction
of the work it records:
- the 1st's scheduled run and a catch-up, when they insert: `charge_run.completed` (`job: 'charge-generate'`,
  `catchUp: true` on a catch-up, the run's counts and amount);
- the late-fee sweep, once per sweep that inserted: `charge.late_fees_charged` (subject none; `job:
  'late-fee-sweep'`, `inserted`, `amount`, `perPeriod { 'YYYY-MM': n }`, `day`);
- every failed run: `charge_run.failed` (`errorCode`; `job: 'outbox-sweep'` for `stale`, `'charge-run'` otherwise).
Readmission's retired concession is audited `concession.ended` or `concession.rejected` against the caller (§5).

## 3. Generation (R179–R182, R240–R242, A1)

### 3.1 The daily job (`charge-generate`, scheduled queue, 01:00 school time)

Per live school, for every `active` year whose dates overlap the current period:
- **On the 1st** a `monthly` run row is written (`triggered_by` null) unless one for the month is already queued or
  running, then run as §3.3.
- **Every other day** is the catch-up: §3.2 runs without a row; a `done` row is written afterwards **only when it
  inserted something** (so `fee_charged` has a subject), never otherwise.

### 3.2 One class (one transaction)

Shared locks on the school's live fee heads (`FOR SHARE`, id order: a structure write waits for the class in
progress), then two `INSERT … SELECT … ON CONFLICT` statements in `ChargeGenerationRepository`:
- **The anti-join first**: per student of the class (one indexed lateral lookup of the deciding enrolment), the
  (student, head) pairs that already have a generated row on the key (voided included, unless `regenerateVoided`)
  are dropped before the structure and concession lookups, so an empty catch-up reads the class's enrolments and
  the key index only. `candidates` = pairs already charged + rows offered, so `charges_skipped` is unchanged.
- **Monthly heads**: per student, the enrolment active on the 1st (latest started), else the first started on or
  before `period-feeCutoffDay`, among the year's enrolments overlapping the period; the class of that enrolment
  pays. Every active `monthly` head with an active structure effective by the period and `amount > 0`; the
  student's `approved` concession on that head (eligible heads only) effective by the period; `amount = 0` is
  written `settled`. Skipped where any generated row exists for the student, head and period (voided included)
  unless `regenerateVoided`; `ON CONFLICT (school_id, student_id, fee_head_id, period) WHERE kind = 'generated' AND
  head_frequency = 'monthly' AND status <> 'voided' DO NOTHING`.
- **Yearly heads**: the same, cut-off ignored, `period` null, on `charges_yearly_key`, skipped where the student has
  any generated yearly row of the head in the year.
- `due_on = dueOn(period, feeDueDay, today, grace)` with `grace = lateFeeGraceDays` while late fees are on, else 7.
- Description `<head name> <Month YYYY>` (monthly) or `<head name> <year name>` (yearly); `created_by` null.

The concession arithmetic is `concessionAmount` written in SQL (`CONCEDED`); `test/fees/generation.e2e-spec.ts`
checks the two agree on every rounding case. `charges_skipped` counts the rows the keys or the voided check skipped;
`skipped_classes` lists `{ classId, reason: 'no_structure' }` for a class with an enrolment in the period that lacks a
structure for a head priced somewhere else in the year.

### 3.3 A run (`charge-run` job on the messaging queue, id `charge-run-<runId>`)

Enqueued after commit by `generate-month` and campaign generate. The job's first statement claims `queued →
running` (zero rows: replayed or failed, ends). A closed year fails the run `year_closed`; a campaign no longer
`generating` fails it `campaign_gone`; any throw fails it `error`, audited and logged, and the job ends without
rethrowing (a BullMQ retry could only find the run claimed; the office runs the month or the campaign again). A
monthly run's last transaction finishes it (`running → done` with counts; a run the sweep failed meanwhile keeps its
charges, which are idempotent, and tells nobody), sends `fee_charged` and writes `charge_run.completed`. **A
campaign run inserts and finishes in one transaction**: its campaign is `generated` exactly when its charges exist;
a failure or a run failed stale meanwhile rolls the charges back and the campaign returns to `draft`.

### 3.4 Campaigns (R184)

Targets: the year's live enrolments (`ended_on` null) the audience reaches, one per student. One `INSERT … SELECT`
on `charges_campaign_key`: `kind campaign`, the head's frequency, `period` null, the campaign's amount, the approved
concession on the head when `applyConcessions` and the head is eligible, `due_on` the campaign's date or today +
grace when created after it (R240), description the campaign's description or name.

### 3.5 Late fees (R185, `late-fee-sweep`, scheduled, 02:00 school time)

While `lateFeeEnabled` with an amount and a live fine head: candidates are open monthly `generated`/`manual`
charges with a period and something owed, due on or after the school-local day of `late_fee_enabled_at`, past
`due_on + grace`, whose student is still on the roll of that year today (any enrolment in the year not ended
before today: a section or class change ends the charge's own enrolment, not the student's place); the late fee is
written on the student's latest such enrolment. `lateFeeTarget` (shared) picks, per student, the
oldest overdue charge of each period without a live late fee; one `late_fee` charge per student and period on
`charges_late_fee_key`, under the fine head, `amount = late_fee_amount`, due today, `period` copied, `created_by` null.
Manual charges carry no period, so in practice only generated monthly charges attract one.

### 3.6 The stale sweep (R252)

From the outbox sweep (every 2 minutes, per school): runs `queued` over 10 minutes or `running` over 15 are failed
`stale`, and a campaign left `generating` goes back to `draft`. Generation is idempotent, so the next run is safe.

## 4. Concessions (R182, R183, A6)

- One live (`requested | approved`) concession per student, year and head, decided under `SELECT … FOR UPDATE` on
  the student row (a concurrent second request is `409 CONCESSION_EXISTS`).
- The originating enrolment is the student's latest-started enrolment in the year.
- `applyToOpenCharges`: open `generated | manual | campaign` charges of the named heads with no concession, from
  `effectiveFrom` (a charge without a period by its due month), locked in id order; one `adjustment` each of
  `min(concessionAmount(gross), outstanding)`, carrying the concession's id, described `Concession: <description>`.
- `concession_decided` goes to the requester (unless they decided it); R107 keeps one per person per concession, so
  an end after an approval tells the requester nothing new (the subject is the same row).

## 5. Admission and readmission (R239)

In the admission (after the guardian links) and readmission transactions: one `generated`, `head_frequency once`
charge per live `once` head with an active structure > 0 for the class by today's month, on `charges_once_key`
(a readmission is a new enrolment, so it is charged again), due `dueOn(today's period, …)`. A live concession of
the year on the admission head (an earlier admission's, the same year) is **reused** for the new once charge when
no decision is sent or the decision is the same (same fixed value); a **different** decision retires it in the same
transaction (`ended` if approved, `rejected` if still requested, audited against the caller) and writes the new one;
a live concession that also names other heads is not retired (`409 CONCESSION_EXISTS`). The decision applies to
the `admission`-category head: `partial` (needs `amount`, 1 ≤ amount < fee) or `free` writes a `fixed` concession of
`fee − amount` (or the fee) effective this month — approved when the caller is a principal holding
`concession.grant` (the charge carries it), else `requested` (the charge is written in full and the principal's
approval with `applyToOpenCharges` credits it). A principal admitting their own child, not the sole principal,
writes it `requested` rather than refusing the admission. A reduction needs `charge.create` (`403`); `amount` with
`full`/`free` is `422`. No structure, no charge, whatever the decision.

## 6. Message types

| Type | Vars | Notes |
|---|---|---|
| `fee_charged` | `label` (`October 2026 fees` or the campaign's name), `total`, `children[]`, `dueOn` | one per fee-payer guardian (live link, unmerged) whose children this run charged with a positive total; subject `charge_run` = the run id; sent through `NotificationService.sendEach` (one plan and one insert for the whole run); SMS-eligible, off by default, one segment with the longest fixtures |
| `concession_requested` | `studentName`, `requesterName` | push and email to every active principal; no amount |
| `concession_decided` | `studentName`, `decision` | push and email to the requester; no amount |

**R238:** the message processor's push leg sends the title as the body for `fee_charged`, `fee_due_reminder`,
`fee_overdue`, `receipt_issued` and `payment_claim_rejected` (`TITLE_ONLY_PUSH`), so an amount never shows on a
lock screen; WhatsApp and SMS keep it.

## 7. Performance (§7.2)

`test/fees/generation-perf.e2e-spec.ts`: 3,000 students in 30 classes, three monthly heads, 300 concessions, 2,000
families; the budgets (30 s, 5 s) are asserted. Measured alone (`--runInBand`, 2026-10-06, after the fix round):
the 1st 8.0–9.5 s (9,000 charges, 2,000 `fee_charged` rows); an empty catch-up 0.9 s on current statistics (the
test runs `ANALYZE charges` after the 1st, as autovacuum would before the next night) and 2.6–3.0 s on the stale
statistics of a bulk-loaded table. Under a loaded machine (other suites or agents running) the same test measured
up to 14.3 s and 4.5 s, inside the budgets. **The timed window ends when the run's last transaction commits:** the
~2,000 `message` jobs are enqueued to BullMQ after that commit and are not timed, nor is their delivery.

## 8. Left for wave J (slice 20), stated

- **A charge carrying a credit cannot be voided** (`has_credits`): voiding it would leave the credit pointing at
  nothing owed. Slice 20's de-allocation path can revisit this.
- **Credits beyond what is owed.** R186's de-allocation of the newest live allocations into advances needs the
  payment tables. Until then `POST /charges/:id/adjust` refuses `amount > outstanding` with `409 CHARGE_NOT_OPEN
  { reason: 'exceeds_outstanding', outstanding }`, and A6's "apply to N open charges" credits at most what each
  charge owes. Slice 20 replaces the refusal with the de-allocation and lifts the cap.
- **Advance auto-allocation (R189).** Every insert path (`generateClass`, `insertCampaign`, `lateFees`, manual
  `POST /charges`) has a marked place where slice 20 applies the child's advance (payments locked first, then the
  charges).
- **Statement payments and advance**: `payments: []`, `totals.advance: 0`; `totals.paid` is Σ `allocated_amount`.
- **A claim verified inside the grace waives the late fee** (R185's last clause) is slice 21's.

## 9. Screens (web)

`/fees/charges` (filters, void / waive / credit per role, generate-a-month dialog, the principal's "voided in the last
7 days" count via `voidedFrom`), `/fees/runs` (counts and skipped classes; polls while a run is in flight),
`/fees/concessions` (the principal's queue; approve with "apply to open charges", reject, end), `/fees/campaigns`
(composer with every-student or class audiences, preview, save draft, charge now, cancel), and a **Fees** tab on the
student record (`fee.statement.view`): the statement, "raise a charge" and "request a concession". The fee tabs show
by capability. Section and single-student campaign audiences are API-only for now (the composer offers everyone and
classes). Playwright: `apps/web/e2e/charges.spec.ts`.
