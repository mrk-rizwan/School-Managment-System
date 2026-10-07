# Slice 20 contracts — payments, receipts, reversals, carry-forward, cash custody

**Author:** Opus 5.5 (wave J), 2026-10-06. **Binds:** `apps/api/src/modules/payments/{payments,payment-reversals,
cash-handovers}.service.ts`, `advances.ts`, `payments.{controller,dto,shared}.ts`, `receipt-print.ts`;
`apps/api/src/repositories/{payment,payment-allocation,receipt,payment-reversal,cash-handover}.repository.ts`;
`common/errors/constraints-payments.ts`; the slice-20 lines in `messaging/{templates,types}.ts`, `modules/fees/{charges,
concessions}.service.ts`, `charge-generation.ts`, `charges.dto.ts`, `fees.module.ts`, `repositories/charge.repository.ts`;
web `app/(school)/fees/{counter,payments,handovers}`. **Source:** `phase-3-financial.md` §1.1, §1.3 (A5, A6, A8, A13),
§3.1–§3.5, §4 "Payments", §5 slice 20, §7.2 and R186–R195, R228–R233, R236, R237, R242, R249, R251. **Schema:** migration
`20261006140000_slice20_payments` (the schema agent's; used as it is). Conventions not restated follow slices 6, 13, 18
and 19 (envelope, string ids, `PageQueryDto`, `@ApiErrors()`, `404` for another school's id, no `DELETE`,
`Idempotency-Key` replays answer `200` with `Idempotency-Replayed: true`).

## 0. Guardian merge (the plan's first task)

There is **no guardian-merge verb** in `apps/api/src/modules/people/guardians` (routes: list, create, lookup, get,
students, patch, issue-login). `merged_into_id` exists and lookups follow it, but nothing merges. Money therefore needs
nothing yet: the counter refuses a merged payer (`422 GUARDIAN_MERGED` on `payerGuardianId`), `receipt_issued` goes only
to unmerged guardians (as `fee_charged`), and a historical `payer_guardian_id` stays as written. The own-child predicate
already reads the merge family (`asms_guardian_merge_family`). When a merge verb lands, `fee_payer_guardians` and
`/me/receipts` (slice 21) resolve survivors.

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /guardians/:id/dues` | `payment.record \| fee.statement.view` | `GuardianDuesDto`: one row per child per academic year that has something owed, an advance, or is the child's latest year; ≤ 10 children (live links), ≤ 50 open charges each, oldest due first; `academicYearName`, `academicYearClosed` added |
| `POST /payments/preview` | `payment.record`, throttle `payment-preview` 60/min, 600/h | `PaymentIntentDto` → `{ allocations[{ chargeId, studentId, studentName, feeHeadName, period, dueOn, amount, fromAdvance }], remainder, outstanding, advanceUsed }`; the same checks as the record (§1.1 steps 2–5); writes nothing |
| `POST /payments` | `payment.record` + key (`payments`, path id the payer guardian, else the walk-in's student) | §1.1 |
| `GET /payments`, `GET /payments/:id` | `payment.record \| fee.statement.view` | filters `receivedFrom/To, method, status, recordedByUserId, studentId` (allocated to the child, or holding their advance), `academicYearId`; sort `-receivedOn`. `PaymentDto` adds `reversals[]` (`ReversalDto` with `reversed`), `possibleDuplicate` and `duplicateOfPaymentId` (R249, computed on every read), and `receipt` is `null` for a carried-forward payment |
| `GET /receipts/:id`, `GET /receipts/:id/print` | same | `ReceiptDto`; the print view through `sendPrintView` only (R237): school, number, payer, method and reference, lines (an advance line reads "Advance (kept for later fees)"), total, a VOIDED notice |
| `POST /payments/:id/void` | `payment.void` | `{ reason }` → `200 PaymentDto`. §1.2 |
| `POST /payments/:id/refund` | `payment.void` + `requirePrincipal` + key (`payment_reversals`, path id the payment) | `{ amount ≥ 1, reason, method (counter methods), reference? }` → `201 ReversalDto`; `REFUND_EXCEEDS_UNALLOCATED { paymentId, unallocated }`, `PAYMENT_VOIDED`, own child |
| `POST /payments/:id/reverse-refund` | same | `{ reversalId, reason }` → `201 ReversalDto` (`refund_reversal`, the refund's amount); `422 reversalId` unless a refund of this payment; a second reversal `409 ILLEGAL_STATUS_TRANSITION` |
| `POST /payments/:id/carry-forward` | `payment.record` + key (`payment_reversals`, path id the payment) | **New route (R251; the plan named the verb, not the route).** §1.3 |
| `POST /payments/:id/carry-forward/undo` | same | **Added at the Phase 3 close (G1).** `{ reversalId, reason }` → `201 ReversalDto` (`carry_forward_reversal`, the carry-forward's amount). §1.3a |
| `GET /me/staff/custody` | `@RequireStaff()` | `{ cashInHand, paymentCount, since }` of the session's user |
| `GET /me/staff/cash-handovers` | `@RequireStaff()` | the session user's handovers as collector, newest first |
| `POST /me/staff/cash-handovers` | `payment.record` | `{ note? }`; §1.4 |
| `POST /cash-handovers` | `collection.handover.confirm` | `{ collectorUserId, note? }`; the collector's staff record must be `left` or `suspended` (`422 collectorUserId` otherwise) |
| `GET /cash-handovers`, `/:id`, `/:id/payments` | `collection.handover.confirm` | filters `status?`, `collectorUserId?`, `unresolvedShortfall=true` (the principal's banner) |
| `POST /cash-handovers/:id/confirm` | `collection.handover.confirm` | `{ countedAmount ≥ 0, note? }`; collector or opener → `409 SELF_ACTION_FORBIDDEN { reason: collector \| opener }`; `HANDOVER_NOT_OPEN`; a shortfall sends `handover_shortfall` to every active principal |
| `POST /cash-handovers/:id/resolve-shortfall` | `collection.handover.confirm` + `requirePrincipal` | `{ resolution: recovered \| written_off \| explained_by_void, reason, reversalId? }` (`reversalId` iff `explained_by_void`); never by the collector; `HANDOVER_NOT_CONFIRMED`, `HANDOVER_NO_SHORTFALL` (none, or already resolved); `written_off` writes an `approved`, `self_approved` expense of category `cash_shortfall` for the shortfall, recorded by the resolving principal |

### 1.1 `POST /payments`, step by step (one transaction, retried once on `CONCURRENT_UPDATE`)

1. Claim the key. 2. The year exists (`422 academicYearId`); a closed year is accepted (R242). 3. Exactly one of
`payerGuardianId` / `payerName` (`422 payerGuardianId`); children named once and existing (`422 studentIds[i]`); a walk-in
names one child (`422 studentIds`); a guardian payer is unmerged and live-linked to every child (`422 studentIds[i]`).
4. Every child has an enrolment in the year, else `409 PAYMENT_SPANS_YEARS { studentId, academicYearId }` (one academic
year per payment). 5. The actor is a guardian of none of them (`409 SELF_ACTION_FORBIDDEN { reason: own_child }`, no
exception). 6. A non-cash method needs `reference` (`422`); `receivedOn` ≤ school today (`422`); `advanceForStudentId` is
one of the children (`422`). 7. **Locks (R236):** the children's advances in the year (`FOR UPDATE` by payment id), then
their open charges in the year (by id). 8. `allocate(amount, children, open, advances)`. If nothing is owed after the
advances and no `advanceForStudentId` was named: `409 PAYMENT_NOTHING_DUE`. A remainder binds to `advanceForStudentId`,
or to the only child; with several children and none named, `422 advanceForStudentId`. 9. The payment (verified by its
recorder, now), then all allocations in **one** insert (new money and advances alike). 10. **The receipt counter last**
(`receipt_<yearId>`, an upsert that creates a missing counter at 1), the receipt and its lines (one per charge the new money
paid, plus the advance line). 11. Audit `payment.recorded`; `receipt_issued` (§4). Replies `201 PaymentDto`.

### 1.2 Void (R191)

Payment locked first; `PAYMENT_VOIDED`; a carried-forward payment is never voided (`409 ILLEGAL_STATUS_TRANSITION`: refund
or carry its advance instead); the recorder → `409 SELF_ACTION_FORBIDDEN { reason: 'recorder' }`; a standing refund or
carry-forward (net of refund reversals) → `PAYMENT_HAS_REFUND`; cash inside an **open** handover → `PAYMENT_IN_CUSTODY`
(in custody with no handover, or after confirmation, it is allowed); own child (every child it paid or holds an advance
for). The `void` reversal row then does the rest in its triggers. Audit `payment.voided` with `custody: none |
before_handover | after_handover` (the daily cash report's `voidedBeforeHandover` / `voidedAfterHandover`). The claim reopen
stays the schema's wave K hook (slice 21).

### 1.3 Carry-forward (R251, A5)

Body `{ academicYearId (target), amount? (default: all of the unallocated), reason }`. Locks the source payment together with
the child's advances in the target year, in id order. `PAYMENT_VOIDED`; `NOTHING_TO_CARRY_FORWARD { unallocated }` when
nothing is unallocated, no child is bound, or `amount` exceeds it; `422 academicYearId` for an unknown year, the same year,
or a child with no enrolment in the target year; own child. Writes the `carried_forward` reversal, then a
`carried_forward` payment in the target year (same payer, received today, recorded by the actor, advance bound to the
child), links the reversal to it, applies the child's advance there (§3), audits `payment.carried_forward`. Replies
`201 { reversal, payment }`. **No receipt**: no money was received, and a receipt would put it in collections (§0.20).

### 1.3a Carry-forward undone (Phase 3 close, G1)

Body `{ reversalId (a carry-forward of this payment), reason }`, path id the **source** payment. `422 reversalId` unless a
`carried_forward` reversal of this payment; a second undo `409 ILLEGAL_STATUS_TRANSITION`; `PAYMENT_VOIDED`. Locks the
source and the carried payment in id order (R236). Allowed only while the carried payment is live and **wholly
unallocated** with no refund or carry-forward of its own standing; otherwise `409 ILLEGAL_STATUS_TRANSITION
{ reason: 'carried_spent', carriedPaymentId }` (the database refuses the same: `payment_reversals_carried_spent`). Writes a
`carry_forward_reversal` row on the source naming the carry-forward (`reverses_id`, once: `payment_reversals_reverses_key`);
the trigger raises the source's `unallocated_amount` back and **voids the carried payment** (it never had a receipt or an
allocation). Nothing is edited or deleted (rule 4). The restored advance then pays the child's open charges in its own year
(§3, A5). Own child refused, as the carry-forward. Audits `payment.carry_forward_reversed` (`reversalId`,
`carryForwardId`, `carriedPaymentId`, `amount`, `fromAcademicYearId`, `toAcademicYearId`, `studentId`, `applied`). The
carry-forward's `ReversalDto.reversed` becomes true. A void of the source nets the undo against the carry-forward.

### 1.4 Handover open (R193)

Refuses `HANDOVER_OPEN { handoverId }` while the collector has one open; locks the collector's live, unhanded cash payments
by id; none → `HANDOVER_NOTHING_TO_HAND_OVER`; writes the handover with the stored `expected_amount` and count, gathers the
payments (checked at commit), audits `cash_handover.opened` (`onBehalf`).

## 2. Audit actions (R57, R230)

`payment.recorded`, `payment.voided`, `payment.refunded`, `payment.refund_reversed`, `payment.carried_forward`,
`payment.carry_forward_reversed` (Phase 3 close),
`cash_handover.opened`, `cash_handover.confirmed`, `cash_handover.shortfall_resolved`; `charge.adjusted` gains `deallocated`;
`charge.created` gains `advanceApplied`. A job's advance application is the system actor's `charge.advance_applied`
(subject none; `job: charge-generate | campaign-generate | late-fee-sweep`, `academicYearId`, `allocations`, `students`,
`amount`), one row per application that moved money, in the inserting transaction (A19).

## 3. What slice 19 left, finished (contract slice-19 §8)

- **Advance auto-apply (R189, A5):** `Advances.applyTo(schoolId, year, children)` locks the children's advances in that
  year by payment id, then their open charges by id, and runs `allocate(0, …)` (oldest due first, fines and late fees
  included), inserting the allocations in one statement. Called after every insert path: per class in generation, the
  campaign insert, the late-fee sweep (per year of the fees written) and a manual charge (whose response then shows it
  paid). An application covers all the child's open charges of that year, not only the new one, so oldest-first holds.
- **Statement:** `payments[]` lists the verified payments that paid the child's charges of the year (live allocations) or
  hold their advance, with what each allocated to the child; `receiptLabel` is nullable (a carried-forward payment);
  `totals.advance` is the child's unallocated advance in the year.
- **Credits beyond what is owed (R186, A6):** `POST /charges/:id/adjust` now accepts an open **or settled** charge.
  `Advances.lockForCredit` locks the payments of the charge's live allocations, then the charge (a payment that allocated
  in between fails the request as `CONCURRENT_UPDATE`, retried once). `Advances.deallocate` frees `amount − outstanding`
  from the newest live allocations: each is reversed, and a part that stays is written again; the freed money stays on its
  payment as an advance bound to the same child. Skipped: allocations of a payment whose advance belongs to another child,
  and every admission-head allocation. What cannot be freed is refused: `409 CHARGE_NOT_OPEN { reason:
  'exceeds_outstanding', outstanding, creditable }`. Concession "apply to open charges" uses the same path and credits
  `min(concession, outstanding + freed)` per charge (the admission head caps there instead of refusing). Σcredit =
  Δoutstanding + Δunallocated holds by construction (tested).
- The void of a charge carrying a credit stays refused (`has_credits`), unchanged.

## 4. Messages

| Type | Vars | Notes |
|---|---|---|
| `receipt_issued` | `receiptLabel`, `amount`, `children[]`, `yearName`, `balance` (what the named children still owe in the year) | to the paid children's live fee-payer guardians, else their primary contacts, else every live guardian (unmerged); subject `receipt`; SMS-allowed; one segment with the longest fixtures (label and year cut to 30 and 20, names cut to fit); never a link. Title `Fee receipt` (static: titles are per type, so not "Receipt 17/2026-27"); push is title-only (already in `TITLE_ONLY_PUSH`, checked) |
| `handover_shortfall` | `collectorName` | push and email to every active principal; no amount |

## 5. Lock order (R236) and performance (§7.2)

Every path takes the payments first (by id), then the charges (by id), and the receipt counter last: the counter, voids
(the reversal trigger), refunds, carry-forward, handover open (the collector's payments), credits, and the advance
application (after an insert of a charge only this transaction can see). `test/payments/concurrency.e2e-spec.ts`
interleaves counter payments, voids and credits over one family and finds no deadlock or `CONCURRENT_UPDATE`; racing
payments on one child never over-allocate; receipt numbers stay 1..n. **Counter budget:** preview + record for a family
of three with twelve open charges measured **312 ms** in-process (budget 400 ms, asserted), on a machine running another
agent's suites.

## 6. Screens (web)

Fee tabs **Counter** (`payment.record`: find the guardian, dues grouped by year with each child's advance, choose children,
amount, method, reference, date, the advance's child when several; preview, save with a key, print link), **Payments**
(`payment.record | fee.statement.view`: list with print links and the duplicate flag; void, refund the advance, reverse a
refund, carry an advance forward, each per role), **Cash handovers** (my cash and hand over; for confirm-key holders the
queue with count; principals see the unresolved-shortfall banner and resolve as recovered or written off). The statement
shows payments and the advance; a credit may be given on a settled charge. On-behalf handovers and `explained_by_void` are
API-only for now. Playwright: `apps/web/e2e/payments.spec.ts`.

## 7. Review fixes (wave J review, 2026-10-06)

Migration `20261006150500_slice20_review_fixes` (CREATE OR REPLACE only, listed in `WAVE_J_OBJECTS`):

- **The acting user, not the recorder (R232).** `payment_allocations_own_child` and the UPDATE branch of
  `payments_own_child` (binding a payment's advance to a child later) read `asms.actor_user_id` and are skipped when it is
  unset: a job is the system actor. Every request path that moves money sets it with
  `ChangeContextRepository.setChangeContext(userId, null)`: the counter's record, void, refund, refund reversal,
  carry-forward, a credit and a concession's credits (except the sole principal's own child, R253, which moves money as the
  system would once the service has decided). The INSERT branch of `payments_own_child` (the recorder against the payer
  and the advance child) and every service check stand. So a clerk later linked as a child's guardian no longer stops
  that child's generation, late fees or a colleague's credit, and still cannot pay or void for the child.
- **No void of a carried payment** in the database too: `payment_reversals_carried_forward_void` (→ `409
  ILLEGAL_STATUS_TRANSITION`).
- The own-child refusal on void, refund and carry-forward also checks the payer guardian through the merge family
  (`PaymentRepository.userIsGuardian`, `asms_user_is_guardian`; the access module has no such method and is not slice
  20's file).
- `explained_by_void` is checked in the service first: the reversal must be a void of a payment this handover gathered,
  else `422 REFERENCE_NOT_FOUND` on `reversalId`.
- **Carry-forward moves forward only** (main-thread decision): the target year must start after the source year, else
  `422` on `academicYearId`.
- **Advances re-applied after money is freed** (main-thread decision): after a credit's de-allocation (adjust, a
  concession's credits) and after a void's reversal, `Advances.applyTo` runs for the affected children, so a child's own
  advance pays their reopened or other open charges at once; `applied` is in the `charge.adjusted`, `payment.voided` and
  (`advanceApplied`) `concession.approved` audit rows. Both lock everything they will need first, in R236's order
  (`Advances.lockFamily`: the payments and the children's advances by id, then the charges and the children's open charges
  by id). A top-up of a charge the same payment already pays part of is written as one live row (the old one reversed
  and rewritten with the sum, `payment_allocations_live_key`); an admission-head top-up is left as advance.
- `receipt_issued` names every child the money reached, an existing advance's allocations included.
- `onceMore` counts its retries (`onceMoreRetries`, with a cause: `stale_read` for a service's own re-check under its
  locks, else the database's constraint or `deadlock`). The R236 interleaving (payments, voids, credits, a handover, a
  carry-forward and a month's generation) shows no Postgres deadlock (`pg_stat_database.deadlocks` unchanged) and no
  database-caused retry; its stale-read re-checks (a void reopening a charge a credit was about to lock) do retry, and are
  counted (4 in the measured run).
- The counter's 400 ms budget moved to `test/payments/counter-perf.e2e-spec.ts` (run it with `--runInBand`); its scenario
  stays in the concurrency suite.

## 8. For slice 22 (reports and daily cash)

- A refund of a carried-forward payment is a refund **in the target year** (the carried payment's year); the source
  year shows the carry-forward reversal, never a refund.
- A carried payment is never voided, only refunded (or carried again).
- A written-off shortfall is an `approved` expense of category `cash_shortfall` paid in **cash**: daily-cash
  reconciliation counts it among cash expenses, and the handover still shows the shortfall as resolved `written_off`.
