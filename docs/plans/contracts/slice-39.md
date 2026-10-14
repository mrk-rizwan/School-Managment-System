# Slice 39 contracts — staff contracts

**Author:** Opus 5.5 (wave S), 2026-10-10. **Binds:** `apps/api/src/modules/people/staff/{staff-contracts.*,contract-expiry.job.ts}`,
the R318 hook in `staff-status.service.ts`, `repositories/staff-contract.repository.ts`, the
`contract-expiry-warn` entries of `messaging/queues.ts`, `jobs/worker-host.ts` and
`jobs/job-runner.ts`, `staff.contract.manage` on `POST /uploads`; the web staff detail's
**Contracts** tab, `/staff/contracts`, and the Approvals tile. **Source:** `phase-5-extended.md`
rule 35, §1.1 (rule 35 rows), §1.3 A6, §3.2 "Contracts", §3.4 `contract_expiring`, §3.5, §5 slice
39, §7.1, R318–R321, R337 (its contract part); migration `20261010090000_wave_s_events_contracts`.
Everything not restated follows the Phase 1–4 conventions (envelope, string ids, `PageQueryDto`
≤ 50, `NoQueryDto`, `@ApiErrors()`, `404` outside the school, `Idempotency-Key` on creates with
replay `200` + `Idempotency-Replayed`, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /staff/:id/contracts` | `staff.contract.manage` | page of `StaffContractDto`, sort `-startsOn` (the only one) |
| `POST /staff/:id/contracts` + key | `staff.contract.manage` | `CreateStaffContractDto` → `201 StaffContractDto` (§2.2); endpoint `staff_contracts`, path id the staff member |
| `GET /staff-contracts?endsBy=` | `staff.contract.manage` | page of live contracts whose `endsOn ≤ endsBy` (expired, not ended, included), sort `endsOn` (§2.6) |
| `POST /staff-contracts/:id/renew` | `staff.contract.manage` | `CreateStaffContractDto` for the next → `201 StaffContractDto` (the new one) (§2.3) |
| `POST /staff-contracts/:id/end` | `staff.contract.manage` | `EndStaffContractDto { endedOn, reason }` → `200 StaffContractDto` (§2.4) |
| `GET /staff-contracts/:id/document` | `staff.contract.manage` | the scan, streamed (§2.5) |
| `GET /me/staff/contract` | staff | `MyStaffContractDto { current \| null }` |
| `GET /me/staff/contract/document` | staff | the scan of the caller's own live contract, streamed; none → `404` |
| `POST /staff/:id/change-status` (existing) | existing | to `left` also ends the live contract (§2.7) |
| `POST /uploads` (existing) | + `staff.contract.manage` | so a contract manager without `document.upload` can stage a scan |

Throttles (per user): writes `staff-contract-writes` 30/min, 300/h; scans `staff-contract-files`
60/min, 600/h (each read writes an audit row); `/me/*` reads also `me-reads`.

### DTOs

- `StaffContractDto { id, staffId, staffName, type, startsOn, endsOn | null, status, daysLeft | null,
  salaryStructureId | null, hasDocument, documentMime | null, note | null, createdByName, createdAt,
  endedAt | null, endedOn | null, endReason | null, endedByName | null }`. Never an amount (R321).
- `status` (`StaffContractStatus`), against the school's today: `ended` (end group set),
  `upcoming` (starts later), `expired` (`endsOn` before today, not ended: "expired, not ended",
  R320), `live`. `daysLeft` = days from today to `endsOn` (negative once past); null without an
  end or once ended.
- `MyStaffContractDto { current: { id, type, startsOn, endsOn, status, hasDocument } | null }` — no
  note, no structure id, no end details.
- `CreateStaffContractDto { type, startsOn, endsOn?, salaryStructureId?, stagedUploadId?, note? }`
  (`note` 1–500, trimmed, no identity number).
- `EndStaffContractDto { endedOn, reason }` (`reason` 3–500, the Phase 3 `@Reason()`).

## 2. Behaviour

Lock order everywhere: the staff row (`readLocked` + `lockIfUnchanged`), then the contracts —
the order the staff status change already takes.

### 2.1 Common checks of a new contract (create, and the next of a renewal)

The staff member not `left` (`409 ILLEGAL_STATUS_TRANSITION { staffId, status }`: re-hire first);
permanent with `endsOn`, or fixed-term / probation without it → `422 VALIDATION_FAILED`, field
`endsOn` code `STAFF_CONTRACT_END_REQUIRED`; `endsOn < startsOn` → `422` on `endsOn`;
`salaryStructureId`, when given, one of this staff member's structures (else `422
REFERENCE_NOT_FOUND` on `salaryStructureId`), when absent the structure in force on `startsOn`
(or null) — "references the structure at its start" (R321); `stagedUploadId`, when given, the
caller's unconsumed staged upload, consumed in the same transaction (else `422
REFERENCE_NOT_FOUND` on `stagedUploadId`). The document is set only at insert.

### 2.2 Create (R318)

After the idempotency claim: lock the staff row (`404` when absent); a live contract →
`409 STAFF_CONTRACT_LIVE_EXISTS { staffId, contractId }`; §2.1; insert; audit
`staff_contract.created { staffId, type, startsOn, endsOn, salaryStructureId, hasDocument }`.

### 2.3 Renew (R318)

One transaction: the contract (`404`); lock the staff row; already ended → `409
STAFF_CONTRACT_ENDED { staffId }`; permanent → `409 ILLEGAL_STATUS_TRANSITION` (no end to renew
from; end it and add a new one); `startsOn` must be the day after the current `endsOn` (`422` on
`startsOn`); the current ends (`ended_on = ends_on`, reason `renewed`, all four end columns); §2.1;
the next is inserted; audit `staff_contract.renewed` on the new contract with `renewedFromId`.
Anything refused after the end rolls the end back (R318 atomicity).

### 2.4 End (R318)

The contract (`404`); lock the staff row; already ended → `409 STAFF_CONTRACT_ENDED`;
`endedOn` from `startsOn` to `endsOn` (when it has one) — later is a renewal, not an end (`422` on
`endedOn`); a reason is required (`422`). Audit `staff_contract.ended { staffId, endedOn, via:
'end' }` with the reason. Ending changes nothing else: payroll, access and assignments are the
staff status's business (rule 35).

### 2.5 Scans (R321, R43)

Streamed by the API through `AttachmentFiles.open` (never a presigned URL), `nosniff`, `CSP
sandbox`, `no-store`, named `contract-<id>.<ext>`; only under `staff.contract.manage`, or the
owner's own live contract through `/me/staff/contract/document`. Each read audits
`staff_contract.document_viewed { staffId, own }`. No thumbnail.

### 2.6 Expired, the dashboard and the staff report (R320, R337)

Expiry changes nothing by itself: no job ends a contract, no access or payroll is touched. A
contract past `ends_on` and not ended is `status: expired`. `GET /staff-contracts?endsBy=` is the
source of the Approvals tile "Contracts ending" (principal, `staff.contract.manage`: `endsBy` =
today + 30, total) and of `/staff/contracts`, whose rows link to the staff member's Contracts tab,
where renew, end and **End employment** are. Slice 42's staff report reads the same repository
method (`liveEndingBy`, 60 days) and `contractStatus()`.

### 2.7 End employment (R318)

`POST /staff/:id/change-status` to `left`, inside its transaction after the staff lock: the live
contract (if any) ends with reason `left` on the leaving day, clamped into the contract (not
before its start; not after its agreed end, so an expired one ends on its own last day). Audit
`staff_contract.ended { via: 'end_employment' }` beside `staff.status_changed`, whose metadata
gains `contractEndedId`. Suspension and re-hire do not touch contracts.

### 2.8 `contract-expiry-warn` (R319, A6)

Daily 06:00 school time, fanned out over live schools (`listLiveForFanOut`, `runAsSchool`), one
transaction per school (60 s). Today is the school's (A6: `ends_on` is the last working day). With
`lead` = `school_settings.contract_warning_days` (*default* 30) and `second` = min(7, lead):

- first warning: live contracts with `today + second < ends_on ≤ today + lead` and no
  `warned_30_at`;
- second warning: live contracts with `today < ends_on ≤ today + second` and no `warned_7_at`.

Each is claimed by a conditional stamp (`… WHERE warned_x_at IS NULL`) before
`contract_expiring { staffName, endsOn, daysLeft }` goes to every active principal (push, else
email; never SMS). Nothing on the day itself or after it. A school with no active principal stamps
nothing, so the warning goes once a principal exists.

## 3. Errors and constraint mappings (`constraints-phase5.ts`, wave S)

`staff_contracts_live_key` → `409 STAFF_CONTRACT_LIVE_EXISTS`; `staff_contracts_type_end_check` →
`422` field `endsOn` code `STAFF_CONTRACT_END_REQUIRED`; `staff_contracts_dates_check` → `422` on
`endsOn`; `staff_contracts_ended_check` → `422` on `endedOn`; `staff_contracts_ended_at_frozen` →
`409 STAFF_CONTRACT_ENDED`; the warn stamps' and the document key's freezes → `CONCURRENT_UPDATE`;
the note and reason CHECKs → `422` on their field. The service checks first.

## 4. Audit (R57)

`staff_contract.created`, `staff_contract.renewed`, `staff_contract.ended` (also from
`POST /staff/:id/change-status`), `staff_contract.document_viewed` (a read that audits). The job
writes messages, not audit rows.

## 5. Lint

`StaffContractRepository` is importable only from `src/modules/people/staff/**` (and
`test/staff-contracts/**`): `staffContractRepository` in `eslint.config.mjs`, fixture
`staff-contract-repository-import.ts` in `test/guardrails/lint-boundaries.spec.ts`.

## 6. Web and phone

Web: the staff detail's **Contracts** tab (`staff.contract.manage`): the list with status badges,
add (type, start, end, note, scan), renew (pre-filled the day after), end (date and reason),
view scan, and **End employment** on a live or expired contract (opens the existing status dialog
set to "left"). `/staff/contracts`: live contracts ending in 30 days or expired. The Approvals tile
"Contracts ending" for a principal holding the key. Loading, empty, error and content states;
tablet width in `responsive.spec`. Phone: none (§8.5).

## 7. Deviations from the plan

1. **`GET /staff-contracts?endsBy=` is added.** The plan names a dashboard tile but no route that
   counts across staff; this read is the tile's and `/staff/contracts`' source and the staff
   report's (slice 42).
2. **The two warnings are two message subjects:** `subject_id = contractId × 10 + stage` (1 first,
   2 second), as the platform invoice notices do, because R107's per-person unique on
   `(subject_type, subject_id)` would otherwise swallow the second warning.
3. **The second warning's lead is min(7, `contract_warning_days`)**, and the first is sent only
   outside the second's window, so a school that sets fewer than 8 days, or a contract added a few
   days before its end, gets one message rather than two on the same morning.
4. **Renew is not keyed.** A retried renewal answers `409 STAFF_CONTRACT_ENDED` (the current has
   ended); the web disables the button while pending. Its `startsOn` must be the day after the
   current `endsOn` (the plan's "opens the next from the day after").
5. **No self rule.** A contract carries no pay (R321), so unlike the salary structure (R235) a
   contract manager may record their own; "end employment" keeps its own R74 refusal.
6. **`contract_warning_days` is writable** (fix round, 2026-10-14) through `PATCH
   /school/settings` as `contractWarningDays` (integer 1-90, the CHECK's range; principal, as every
   setting) and read back on `SchoolSettingsDto`; the web settings page has a "Staff contracts" card
   with the field. Tests: `contracts.e2e-spec.ts` "contractWarningDays is read and written through
   the settings, 1-90, and the job warns by it"; web `fees.spec.ts` "the contract warning lead is
   1-90 days and sent alone when changed".
7. **Mobile: nothing.** The phone has no staff profile screen to hold a read-only contract row;
   `/me/staff/contract` is ready for one.
