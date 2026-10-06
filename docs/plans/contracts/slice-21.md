# Slice 21 contracts — deposit claims, the guardian's view, the app's Fees tab

**Author:** Opus 5.5 (wave K), 2026-10-06. **Binds:** `apps/api/src/modules/payments/{claims.service,claims.controller,
claims.dto,my-fees.service}.ts`, `repositories/payment-claim.repository.ts`, `common/errors/constraints-claims.ts`, the
slice-21 lines in `modules/payments/{payments.service,payments.module}.ts`, `repositories/{payment,receipt}.repository.ts`,
`messaging/{templates,types,queues}.ts`, `jobs/{job-runner,jobs.module,worker-host}.ts`, `common/http.ts`; web
`app/(school)/fees/claims`, `app/(school)/my-children`, `lib/api/school-claims-contract.ts`, the nav capacity filter; mobile
`src/fees/**`, `children/[studentId]/{fees,deposit-slip}.tsx`, lanes `payment_claim` and `payment_claim_image`, local
table `local_claims` (migration 5), Maestro `parent-deposit-slip.yaml` and `parent-receipt.yaml`. **Source:**
`phase-3-financial.md` §1.1 ("Verifier corrects the paid date", "Claim limits"), §3.1, §3.2, §3.6, §3.7, §3.9, §4 "Claims",
slice 21, §7.1 and R196–R200, R243, R249. **Schema:** migration `20261006170000_slice21_payment_claims` (the schema
agent's; used as it is). Conventions not restated follow slices 6, 13, 18 and 20.

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /me/children/:id/dues` | `@RequireCapacity('guardian')`, `me-reads` | `MyDuesDto { studentId, academicYearId, outstanding, advance, nextDueOn, charges: MyChargeDto[] ≤ 50, claimsAccepted }`. `academicYearId?` filters; absent = every year. `outstanding` sums every open charge, not only the 50 listed; `nextDueOn` = the earliest open due date today or later. `claimsAccepted` = the school has an active payment account (the app's "Upload deposit slip"). `MyChargeDto` has no actor, void or waive reason |
| `GET /me/receipts`, `GET /me/receipts/:id` | guardian, `me-reads` | receipts with a line for one of the caller's live login children, newest first; `studentId?` narrows to one (404 outside scope). `MyReceiptDto { id, receiptLabel, academicYearId, academicYearName, amount, paidOn, method, lines (own children only), otherChildrenAmount, issuedAt, voidedAt }` — no collector, no payer |
| `POST /me/uploads` | guardian; `upload` throttle (20/min, 200/h, shared with `/uploads`) + a daily cap of 20 (`guardian-upload-day`, Redis, 24 h) | **Deviation:** the plan widened `POST /uploads`; a parent session must reach nothing outside `/me` (R78, a routes-test invariant), so the guardian's upload is its own route calling the same `UploadsService` (5 MB, jpg/png/pdf, sniffed and re-encoded, consumable only by its uploader). Added to `NON_JSON_BODY_ROUTES` |
| `GET /me/children/:id/payment-claims`, `GET …/:claimId` | guardian, `me-reads` | every live login link of the child sees status and amounts (R198); `MyClaimDto` adds `submittedByMe` and `verifiedPaidOn` (the plan's shape plus two fields the screens need) |
| `POST /me/children/:id/payment-claims` | guardian, `claim-writes` (20/min, 120/h) + `Idempotency-Key` (`payment_claims`, path id the student) | §1.1 |
| `PATCH /me/children/:id/payment-claims/:claimId` | guardian, the submitter's guardian record only (else 404), `claim-writes` | `{ stagedUploadId }`: the same upload replays `200` with no row; another one is `409 CLAIM_IMAGE_EXISTS`; a claim that is no longer pending `409 CLAIM_NOT_PENDING`; an upload not the caller's, used or expired `422 REFERENCE_NOT_FOUND` on `stagedUploadId`. Audit `payment_claim.image_attached`; `payment_claim_submitted` to the verifiers |
| `POST /me/children/:id/payment-claims/:claimId/withdraw` | submitter only | `{ reason? }` (`@Reason`); pending only; `decided_by` = the submitter's user, `decided_at` now (schema notes §4). Audit `payment_claim.withdrawn` |
| `GET /me/children/:id/payment-claims/:claimId/image` (+ `/thumbnail`) | submitter's user only (another linked guardian 404) | streamed by `AttachmentFiles` (`CSP sandbox`, `nosniff`, `no-store`), named `deposit-slip-<id>`, logged by claim id only |
| `GET /payment-claims`, `GET /payment-claims/:id` | `payment.verify` | `status?` (default `pending`), `hasImage?` (default **true**; image-less claims only on request, R243), `studentId?`, `createdFrom/To` (school days), sort `createdAt` (default, oldest first) \| `-createdAt`. `ClaimDto` adds `studentName`, `className` (latest enrolment), `guardianName`, `imageMime`, `decidedByName`, `verifiedPaidOn`, `paymentId` (live link), `receiptId`, `reopenedAt`, `possibleDuplicate`, `duplicateOfClaimId` |
| `GET /payment-claims/:id/image` (+ `/thumbnail`) | `payment.verify` | never in a list |
| `POST /payment-claims/:id/verify` | `payment.verify` | §1.4 → `200 VerifiedClaimDto` (`ClaimDto` + `payment: PaymentDto`) |
| `POST /payment-claims/:id/reject` | `payment.verify` | `{ reason }` (`@Reason` **and no phone number**: it goes out by WhatsApp or SMS). Pending only; not the family (R197). `payment_claim_rejected` to the submitter (merge survivor). Audit `payment_claim.rejected` |

### 1.1 Create, step by step (one transaction)

1. The child must be in the caller's capacity scope (404). 2. Claim the key (first statement). 3. No active payment
account → `409 CLAIMS_NOT_ACCEPTED` (R196). 4. `paidOn` ≤ school today (`422`). 5. **R199:** lock the caller's guardian
row (`PaymentRepository.lockGuardian`, `FOR UPDATE`), count their claims since the school day began; at 10 →
`409 CLAIM_LIMIT_REACHED { limit: 10 }` (image-less, expired, withdrawn and rejected ones count). 6. Consume the staged
upload when given. 7. Insert (the trigger checks the live `can_login` link). 8. Audit `payment_claim.submitted`. 9. With an
image: `payment_claim_submitted` (once per claim: the image is set once, and R107 keeps one row per person per subject);
the thumbnail is made after commit.

### 1.2 `possibleDuplicate` (R249)

Derived on every read: the earliest **other** pending or verified claim with the same method, reference and `paid_on`.
A claim with no reference is never flagged. A warning, never a refusal; a rejected or withdrawn twin no longer flags.
Counter payments keep their own flag (slice 20); a claim is not compared with counter payments.

### 1.3 Who decides (R197)

Refused with `409 SELF_ACTION_FORBIDDEN { reason: 'own_child' }` when the decider's user is the submitter's guardian
record (merge family, `asms_user_is_guardian`) or a live guardian of the child (`actorIsGuardianOf`); the trigger
`payment_claims_not_self` holds the same rule. No exception (cash rule of R253).

### 1.4 Verify, step by step (one transaction, retried once on `CONCURRENT_UPDATE`)

1. **Lock the claim** (`readLocked` + `lockIfUnchanged`, a compare-and-set UPDATE — no raw SQL). 2. Not pending →
`CLAIM_NOT_PENDING`; no image → `CLAIM_IMAGE_MISSING`; the family → §1.3. 3. `verifiedAmount` (default the claimed) above
the claimed → `422 verifiedAmount` (A15: an upward correction is reject-and-resubmit). `paidOn` (default the guardian's)
after today or after the claim's creation day (school time) → `422 paidOn`. A lower amount or a different date without a
`reason` → `422 reason`. 4. `academicYearId` default: the year of the child's active enrolment, else the latest; none →
`422 academicYearId`. `advanceForStudentId` may only name the claim's child (`422`). 5. **The payment, through slice 20's
path** (`PaymentsService.recordForClaim`, the counter's `write`): the counter's checks (`payerGuardianId` = the submitter's
merge survivor, live-linked to the child; the child enrolled in the year, else `PAYMENT_SPANS_YEARS`; never the actor's own
child), `change_context` set, then the locks in R236's order (the child's advances, the open charges by id), **the in-grace
late-fee waiver** (§1.5) under those locks, allocation, the payment (`method` the claim's, `amount` = verified,
`received_on` = the verified date, `reference` = the claim's or `'Claim ' || id`, `claim_id` = the claim, recorded and
verified by the verifier, `verified_at` now), the allocations, the receipt counter last, the receipt, `payment.recorded`
(with `claimId`), `receipt_issued`. `PAYMENT_NOTHING_DUE` when nothing is owed and no advance child is named. 6. **UPDATE the
claim**: `verified`, `decided_by/at`, `verified_amount`, `verified_paid_on` only when the date differs, `payment_id`,
`decision_reason` as given. 7. Audit `payment_claim.verified` (`paymentId`, amounts, dates, `lateFeesWaived`).

### 1.5 The in-grace late-fee waiver (slice 19's rule, read from the verified date)

Before allocation, every open late fee of the child in the payment's year with no allocation, whose target charge's
`due_on + late_fee_grace_days ≥` the verified paid date, is waived **when the verified payment settles the charge in
full** (`waived_by` = the verifier, reason `paid_on_time_verified_late`, audited `charge.waived` with `claimId` and
`paidOn`). "Settles in full" is a dry run of the allocation the write performs (the child's advances first, then the
verified amount, oldest due first) over the child's open charges in that year without their late fees: the target's
outstanding must reach 0. A token deposit inside the grace waives nothing; the late fee stays open. Waiving first means the
payment never pays it.

### 1.6 What the guardian is told

A rejection: `payment_claim_rejected` (WhatsApp/SMS with the amount and the reason; push title only). A verification:
`receipt_issued` to the fee-payer guardians as at the counter; the claim's `verifiedAmount`, `verifiedPaidOn` and
`decisionReason` are on `MyClaimDto` for every linked guardian. There is no `payment_claim_verified` type (the plan's §3.6
has none): a submitter who is not a fee payer learns of a lower amount from the app or the web page only. Raised for the
main thread.

## 2. Audit actions (R57, R230)

`payment_claim.submitted`, `payment_claim.image_attached`, `payment_claim.withdrawn`, `payment_claim.verified` (+ the
payment's `payment.recorded` and any `charge.waived`), `payment_claim.rejected`, and the job's system-actor
`payment_claim.expired` (`metadata.job = 'claim-image-sweep'`, `expired` count; one row per run that expired something).

## 3. The void hook

The schema's `asms_payment_reversal_apply` returns a claim-backed payment's claim to `pending` with `reopened_at` and clears
the decision. `PaymentDto.claimId` reads `payments.claim_id`, which survives the void; the claim's `payment_id` is the live
link and is cleared. Tested end to end (verify → void → back in the queue).

## 4. The job (R200)

`claim-image-sweep`, daily at 02:15 school time on the `scheduled` queue, per live school: pending claims with no image
created more than 24 hours before the run expire (`decided_at` now, `decided_by` null). They still count towards the
day's cap. Pinned in `test/jobs/worker.e2e-spec.ts`.

## 5. Messages

| Type | Vars | Notes |
|---|---|---|
| `payment_claim_submitted` | `studentName` | push and email to every confirmed `payment.verify` holder (by role, grant or custom role, confirmed through the permission service), except a guardian of the child; no amount. Title `Deposit slip to verify` |
| `payment_claim_rejected` | `studentName`, `amount`, `paidOn`, `reason` | to the submitter; SMS-allowed: one segment with the longest fixtures, the reason cut to fit; never a link; push title only (`TITLE_ONLY_PUSH`). Title `Deposit slip not accepted` |

## 6. Constraints (`constraints-claims.ts`)

Mapped: amounts, method, the identity checks, `payment_claims_dates_check` (`422 paidOn`), `…_guardian_link` (404),
the image key and uniqueness (`422 stagedUploadId`), `…_image_frozen` (`CLAIM_IMAGE_EXISTS`), `…_image_not_pending`,
`…_status_transition`, `…_decision_frozen` (`CLAIM_NOT_PENDING`), `…_image_status_check` (`CLAIM_IMAGE_MISSING`),
`…_verified_amount_check`, `…_verified_reason_check`, `…_payment_key` (`CONCURRENT_UPDATE`), `…_not_self`
(`SELF_ACTION_FORBIDDEN own_child`). Left unmapped (a 500 says "bug"): born-pending, the frozen stated columns, the decided
and verified pairings, the reopen stamps, `payment_claims_payment_matches`, `payments_claim_method_check`.

## 7. Screens

**Web.** Fees tab **Deposit slips** (`payment.verify`): the queue (status, with or without slip), "Review" opens the
claim beside its slip (thumbnail on tap, the original in a new tab) and the family's dues (`GET /guardians/:id/dues`, when
the reader holds `payment.record` or `fee.statement.view`); verify with amount, the slip's date and a reason (required when
either differs), reject with a reason. The Fees nav entry also shows to `payment.verify` holders. **Children's fees**
(`/my-children`, guardian capacity: `NavItem.capacity`, `AppShell` gains `capacities`): where to pay, per child the dues,
"Send a deposit slip" (upload then claim, one key per form), the slips sent (withdraw, view own slip), and the receipts
(rendered from `MyReceiptDto` in a dialog). Playwright: `apps/web/e2e/claims.spec.ts` (mocked).

**Mobile.** The child card gains **Fees** (`/children/[studentId]/fees`, secure): dues cached for offline "as of", the
slips on this phone with their state lines, the slips on the server (a sheet with the office's reason; withdraw is
online-only, `withdraw_claim`), and the receipts rendered natively and shared as text. **Upload deposit slip**
(`/children/[studentId]/deposit-slip`, secure, offline-capable): method, amount, paid date, reference, note, photo (camera
or gallery). Lanes: `payment_claim` (POST, `Idempotency-Key` = outbox id, `local_claims`) and `payment_claim_image`
(`staged_upload_patch`, **`uploadPath: /api/v1/me/uploads`** — `Lane.uploadPath` is new, default `/api/v1/uploads`;
`local_files`). `local_claims` joins `FILE_LANES` (whose path builder now takes the owner `{ serverId, studentId }`),
`PURGE_ORPHAN_LOCAL_ROWS`, the discard, the startup recovery and `LOCAL_TABLES`. The local slip is deleted once the server
has it. `CLAIM_IMAGE_EXISTS` after a re-upload is read as done by the sender (the claim already holds this phone's slip);
`CLAIM_NOT_PENDING` is shown and discarded. Maestro (CI only): `parent-deposit-slip.yaml` (airplane mode, `addMedia`
gallery image) → `ci-run.sh` verifies over `curl` as the principal → `parent-receipt.yaml`.

## 8. Tests

`test/payments/claims.e2e-spec.ts` (R196–R200, R243, R249, the waiver, the void hook, `payment_claims` isolation including
`lockGuardian`), `src/modules/payments/claim-messages.spec.ts`, the identity scan renders both templates; web
`e2e/claims.spec.ts`; mobile `src/fees/fees.spec.tsx`, the slice-21 block of `outbox/staged-upload-sender.spec.ts`,
`lanes.spec.ts`, `secure-screens.spec.tsx`, `database.spec.ts` (schema version 5).
