# Slice 23 contracts — expenses

**Author:** Opus 5.5 (wave I), 2026-10-06. **Binds:** `apps/api/src/modules/expenses/**`,
`repositories/expense.repository.ts`, `common/errors/constraints-expenses.ts`, the two expense
templates in `messaging/templates.ts` and `messaging/types.ts`, the expense lanes and the generic
`staged_upload_patch` sender in `apps/mobile/src/outbox/**`, the mobile `src/expenses/**` screens,
the web `app/(school)/expenses/**` page. **Source:** `phase-3-financial.md` §3.1, §3.2, §3.6, §3.9,
§4 "Expenses", slice 23 (R206–R208, R244, R207, R226). Schema: migration
`20261006100200_slice23_expenses` (wave I groundwork), used as built. Everything not restated
follows the Phase 1–3 conventions.

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /expenses` | `expense.record \| expense.approve \| finance.report.view` | paginated; `spentFrom`, `spentTo`, `category`, `status`, `recordedByUserId`; `sort` `-spentOn` (default) \| `spentOn`, ties by id |
| `GET /expenses/:id` | as list | `404` for another school's id |
| `POST /expenses` | `expense.record` + `Idempotency-Key` (endpoint `expenses`, path id `0`: the route has none) | §2; `201`, replay `200` with `Idempotency-Replayed: true` |
| `PATCH /expenses/:id` | `expense.record`; recorder only (`403 PERMISSION_DENIED { reason: not_recorder }`) | the content fields, `null` clears `payee`/`reference`; while `recorded \| pending_approval`, else `409 EXPENSE_NOT_OPEN { expenseId }`; a no-op is `200` with no audit row |
| `PATCH /expenses/:id/receipt` | `expense.record`; recorder only | `{ stagedUploadId }`; set once, in any status (the receipt may land after the decision); the same upload again `200` unchanged; another `409 EXPENSE_RECEIPT_EXISTS`; an unknown, used or expired upload `422 REFERENCE_NOT_FOUND` |
| `POST /expenses/:id/approve` | `expense.approve` | `{ expectedUpdatedAt, reason? }` — compare-and-set on the `ExpenseDto.updatedAt` the approver read; edited since → `409 CONCURRENT_UPDATE`; not `pending_approval` → `409 EXPENSE_NOT_PENDING`; own → `409 SELF_ACTION_FORBIDDEN`; `expense_decided` to the recorder |
| `POST /expenses/:id/reject` | `expense.approve` | `{ expectedUpdatedAt, reason }` (`@Reason`), as approve |
| `POST /expenses/:id/void` | `expense.record \| expense.approve` | `{ reason }`; §3 |
| `GET /expenses/:id/receipt`, `GET /expenses/:id/receipt/thumbnail` | as list; 120/min, 2,000/h per user (`expense-files`) | streamed (never a URL) with `nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: no-store`; named `expense-<no>.<ext>`; a PDF has no thumbnail (`404`); no receipt `404` |

`POST /uploads` now also admits `expense.record`, so a recorder without `document.upload` can
stage a receipt (the route table row changed).

## 2. `POST /expenses`, step by step (one transaction)

1. Claim the idempotency key (first statement).
2. `spentOn` ≤ today in the school's time zone, else `422` on `spentOn`. `category` is one of the
   twelve recordable categories (`RECORDABLE_EXPENSE_CATEGORIES` in `packages/shared/src/finance.ts`, with `EXPENSE_CATEGORY_LABELS`): `salary_advance_cash` and
   `cash_shortfall` are written by the system (slices 20, 25), never on a form; `method` is a
   counter method (never `carried_forward`).
3. The threshold is `school_settings.expense_approval_threshold` (5,000 without a row).
4. A `stagedUploadId`, if sent, is consumed (the caller's own, unexpired, once); its thumbnail is
   stored after commit.
5. Status (R206): `amount ≤ threshold` → `recorded`; above it, a caller holding the live
   **principal** system role (staff capacity) → `approved`, `self_approved`, `decided_by` the
   recorder; anyone else — an `expense.approve` grantee included — → `pending_approval`.
6. `expense_no` from the school's `expense_no` counter (`UPDATE … RETURNING`), taken last.
7. Insert; record the key's subject.
8. `pending_approval` → `expense_approval_requested` to every confirmed `expense.approve` holder
   except the recorder (candidates by role, grant or custom role, each confirmed through
   `PermissionsService.load`).
9. Audit `expense.recorded`.

## 3. Rules

- **Edit:** the recorder, while open. A `recorded` expense is never raised above the threshold
  (`422` on `amount`: "void this one and record it again"), because the status cannot move from
  `recorded` to `pending_approval` (`expenses_status_transition`) and an edit must not skip the
  approval a new record would need. A pending one edited below the threshold stays pending.
- **Approve / reject:** only `pending_approval`; never the recorder (service and the
  `expenses_not_self` trigger); only the version the approver read (`expectedUpdatedAt` matched in
  the `UPDATE`'s `WHERE`, so a recorder's edit between read and decision refuses it with
  `CONCURRENT_UPDATE`). The decision notifies the recorder.
- **Void** (R206, R244): `recorded`/`pending_approval` — the recorder, holding `expense.record`
  (anyone else `403 not_recorder`); `approved` — an `expense.approve` holder who is not the
  recorder, or the principal who self-approved it (`403 capability_not_held` without the key,
  `409 SELF_ACTION_FORBIDDEN` for one's own non-self-approved row); `rejected`/`voided` →
  `409 EXPENSE_NOT_OPEN`. A void racing another write: `EXPENSE_NOT_OPEN` or `CONCURRENT_UPDATE`.
- **Separation of duties** is also the trigger `expenses_not_self` (the role is read, not the
  principal count); the sole-principal exception of R253 does not apply to expenses — a
  principal's own above-threshold expense is self-approved by R206 instead.

## 4. Messages (§3.6)

`expense_approval_requested` (approvers) and `expense_decided` (recorder): internal, push and email,
subject `expense`. Bodies carry the number, the category and the recorder's name, or the decision —
**never the amount or a reason** (R238: the push body may carry nothing about money). Titles
"Expense to approve", "Expense decided". Neither is in the processor's `TITLE_ONLY_PUSH`: the
body already carries no money, and it names the expense number the reader needs.

## 5. Audit actions (R57, R230)

`expense.recorded` (amount, category, method, status, `selfApproved`, threshold, `hasReceipt`),
`expense.updated` (changed fields, new and previous amount), `expense.receipt_attached` (mime,
size), `expense.approved`, `expense.rejected` (reason), `expense.voided` (reason, `fromStatus`).
Each carries `expenseNo`, `amount`, `category` and the recorder. A replayed create, a no-op patch
and the same receipt sent again write no row.

## 6. Mobile (§3.9, R207, R226)

- `Lane.sender` is `'json' | 'staged_upload_patch'`. The generic sender
  (`outbox/staged-upload-sender.ts`, the slice-16 diary sender generalised) uploads the file, then
  `PATCH`es the item's path with `{ stagedUploadId }`; the file row lives in the lane's
  `domainTable` — `local_attachments` (diary photo) or `local_files` (every later file). The item
  body is `{ localAttachmentId }` (the file row's id) for both. Remedies as before: 413/415 terminal;
  `REFERENCE_NOT_FOUND` re-uploads once. **Slice 21** adds `local_claims` to `FILE_LANES` in
  `db/local.repository.ts`, its owner clause to `PURGE_ORPHAN_LOCAL_ROWS`, and its two lanes.
- Device schema version 4: `local_expenses` and the generic `local_files (owner_table, owner_id,
  file_path, …)`. A receipt waits (`waiting`) until its expense has a server id, then is queued as
  `expense_receipt` in the follow-up's transaction (and at startup by `recoverWaitingAttachments`).
  The receipt file is deleted when the server accepts it; a discarded expense takes its receipt.
- Lanes: `expense` (`POST /api/v1/expenses`, `Idempotency-Key` = outbox id, `local_expenses`,
  remedies `VALIDATION_FAILED`/`INVALID_VALUE` → edit and resend) and `expense_receipt`
  (`PATCH /api/v1/expenses/:id/receipt`, `local_files`, `REFERENCE_NOT_FOUND` → retry,
  `EXPENSE_RECEIPT_EXISTS` → shown, discard).
- `ONLINE_ONLY_ACTIONS` gains the twelve Phase 3 actions of §3.9.
- Screens: Home card "Expenses" for `expense.record` holders; `/home/expenses` (on this phone,
  state lines, remedies) and `/home/expenses/new` (offline capture, receipt photo). Not secure.
  Approving and voiding stay on the web (and slice 27's Approvals tab).

## 7. Web

`/expenses` (sidebar for `expense.record | expense.approve | finance.report.view`): filters by
status and category; record (with an optional receipt, one `Idempotency-Key` per opened form);
row menu by role and ownership — edit, attach receipt, download receipt, approve, reject, void.
