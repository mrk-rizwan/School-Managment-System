# Slice 24 contracts — staff leave

**Author:** Opus 5.5 (wave I), 2026-10-06. **Binds:** `apps/api/src/modules/leave/**`,
`repositories/leave-{type,request}.repository.ts`, `common/errors/constraints-leave.ts`, the
`approvedLeave` lines of `modules/staff-attendance/**`, the two leave templates in
`messaging/{types,templates}.ts`; the web pages `/my-leave` and `/leave` and the day sheet's leave
line; the mobile `leave/**` and `/home/my-leave`. **Source:** `phase-3-financial.md` §3.1, §3.2,
§4 "Leave", slice 24 (R209–R212, R226, R248, R253) and migration `20261006100300_slice24_leave`.
Everything not restated follows the Phase 1–3 conventions (envelope, string ids, `PageQueryDto`,
`NoQueryDto`, `@ApiErrors()`, `404` for another school's id, no `DELETE`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /leave-types` | `@RequireStaff()` | paginated, `status?`; active first, then by name; `LeaveTypeDto { id, name, code, daysPerYear, paid, status, archivedAt, seeded }` |
| `POST /leave-types` | `school.settings.manage` | `{ name 1–40, code, daysPerYear? 1–366, paid }`; `unpaid` + `paid: true` is `422` on `paid`; `409 LEAVE_TYPE_NAME_TAKEN { field, leaveTypeId }` (case-insensitive among live types) |
| `POST /leave-types/:id/archive` | `school.settings.manage` | `{ reason }` (`@Reason`); final; a repeat is `200` with no audit row. A type is never edited (its columns are frozen): archive and add another |
| `GET /me/staff/leave-balance` | `@RequireStaff()`, `me-reads` | `year?` (4 digits, 2000–2100; default the school's current year) → `LeaveBalanceDto { year, types: [{ leaveTypeId, name, code, paid, entitlement, used, pending, balance }] }`, one row per live type (bounded) |
| `GET /me/staff/leave-requests`, `GET …/:id` | `@RequireStaff()`, `me-reads` | the caller's own only (another's id is `404`); `status?`; newest first |
| `POST /me/staff/leave-requests` | `@RequireStaff()` + `Idempotency-Key` (endpoint `leave_requests`, path id the staff member) | `{ leaveTypeId, startsOn, endsOn, reason }`; §2 |
| `POST /me/staff/leave-requests/:id/cancel` | `@RequireStaff()`, own only | `{ reason }`; pending, or approved with `startsOn > today` (`409 LEAVE_STARTED` once started); any other status `409 ILLEGAL_STATUS_TRANSITION { status }`; ends the cover (§3) |
| `GET /leave-requests`, `GET /leave-requests/:id` | `staff.leave.approve` | `status?`, `staffId?`, `startsFrom/To?`; sort `-requestedAt` (default) or `startsOn` |
| `POST /leave-requests` | `staff.leave.approve` + `Idempotency-Key` (same endpoint, path id the staff member) | `{ staffId, leaveTypeId, startsOn, endsOn, reason }` → `pending`, `onBehalf: true`; one's own staff id is `422` on `staffId` (use My leave); another school's is `422 REFERENCE_NOT_FOUND` |
| `POST /leave-requests/:id/approve` | `staff.leave.approve` | `{ reason?, cover?: { sectionId, coverStaffId } }`; §3 |
| `POST /leave-requests/:id/reject` | `staff.leave.approve` | `{ reason }` (required); never one's own, the sole principal included |
| `POST /leave-requests/:id/end-early` | `staff.leave.approve` | `{ endedOn, reason }`: `startsOn ≤ endedOn < endsOn` (`422`); approved only, else `409 ILLEGAL_STATUS_TRANSITION`; §3 |
| `GET /staff/:id/leave-balance`, `GET /staff/:id/leave-requests` | `staff.view` | as the `/me` reads for any staff row of the school; unknown id `404`. The list is `StaffLeaveRequestDto`: **`LeaveRequestDto` without `reason` and `decisionReason`**, which can be medical (fix round, 2026-10-06); those stay on `/me/staff/*` and the `staff.leave.approve` routes |

`LeaveRequestDto` is the plan's shape plus `selfApproved`, `coverEndedOn` (§3) and, in
`sectionsNeedingCover`, each section's `classId` (the web cover picker needs it). Status verbs are not replayable: a second
decision on a moved row is `409 LEAVE_NOT_PENDING { status }`.

## 2. Creating a request (one transaction)

1. Claim the idempotency key (first statement).
2. Lock the staff row (serialises one member's requests, so the balance is read stable); unknown
   is `404` on `/me`, `422` on `staffId` on behalf; not active is `409 STAFF_NOT_ACTIVE`.
3. Leave type (`422` on `leaveTypeId`); dates: `startsOn ≥ today − 7`, `endsOn ≥ startsOn`, at most
   60 days inclusive (`422`); `working_days` = staff working days (weekly offs and staff holidays
   out, the published calendar now) and frozen; **0 working days is `422` on `endsOn`**.
4. `409 LEAVE_TYPE_ARCHIVED`; `409 LEAVE_OVERLAPS { leaveRequestId }` against live requests
   (pending, approved, ended early up to its last day taken). The exclusion constraint catches the
   race loser and maps to the same code.
5. R209 for a paid type with a yearly limit, per calendar year the dates touch: the request's
   working days in that year must not exceed `balance − pending` →
   `409 LEAVE_BALANCE_EXCEEDED { balance, year }` (the days available).
6. Insert, audit `leave_request.created` (`onBehalf`, dates, `workingDays`), and
   `leave_requested` to every holder of `staff.leave.approve` (role, custom role or grant) except
   the person on leave and the approver who recorded it.

**Balance (R209).** `entitlement = leaveBalance(daysPerYear, joinedOn, year, used)` from
`@asms/shared`: pro-rated by whole months from `joined_on`, full when null. `used` counts approved
and ended-early requests (an ended-early one to its last day taken), `pending` pending ones, each
in working days inside the year: the frozen count for a request wholly inside the year and not
ended early, otherwise counted over the current calendar.

## 3. Decisions, cover, end early

- **Approve.** Lock the row; `pending` only. Own leave (`staffId` = the caller's): refused
  `409 SELF_ACTION_FORBIDDEN { reason: 'own_leave', leaveRequestId }` unless
  `PermissionsService.isSolePrincipal` (under the `school_settings` lock), then
  `self_approved = true` (R253). The balance is checked again against approved days only.
  **A cover needs `class.manage`** (fix round, 2026-10-06; main-thread decision): the cover is a
  teacher assignment, whose own route requires that key. Without it the approval is refused
  `403 PERMISSION_DENIED { reason: 'cover_needs_class_manage' }` as the first step, before any
  lock or write, so an approver who holds only `staff.leave.approve` gets a clear refusal rather
  than a 403 halfway through; approving without a cover still works. Plan note: slice 24's table
  names only `staff.leave.approve` for approve; with `cover` the caller also needs `class.manage`
  (a principal holds both by default; the web hides the picker without it).
  `cover` (R212): `sectionId` must be a section the person is class teacher of on some day of the
  leave (`422 cover.sectionId`), `coverStaffId` not the person (`422 cover.coverStaffId`); the
  cover runs from `max(startsOn, today, the class-teacher row's start)` to `min(endsOn, its end)`
  (`422 cover` when nothing is left) and is created by **`TeacherAssignmentsService.create`**
  (slice 10: R132's capability check, `cover_assigned`, `teacher_assignment.created`) in the same
  transaction, `coversAssignmentId` the class-teacher row. Audit `leave_request.approved`
  (`selfApproved`, `coverAssignmentId`); `leave_decided` to the person (not on a self-approval).
- **Reject.** `{ reason }`; own always refused; audit `leave_request.rejected`; `leave_decided`.
- **Cancel** (own) and **end early** end the cover through **`TeacherAssignmentsService.end`**:
  on the leave's last day taken when that is today or later, otherwise from today (the slice-10
  rule: last day yesterday if it had begun, else voided). A cancel before the start therefore
  voids the cover. **Deviation (kept in the fix round):** an end-early dated in the past cannot
  backdate the cover's last day (slice 10 refuses a past `endsOn`); a cover that had begun ends
  yesterday instead (one that had not begun is voided). The response states it:
  **`coverEndedOn`** is the cover's last day once the request is cancelled or ended early, null
  when there was no cover or it was voided; it can differ from `endedEarlyOn`, and the web says
  "Its cover ended on <day>" when it does.
- **End early (R248).** `ChangeContextRepository.setChangeContext(actor, reason)` first in the
  transaction: the trigger reads `asms.actor_user_id` (fail-closed). Own refused unless the leave
  was self-approved and the caller is still the sole principal. The later dates are freed (the
  exclusion range ends at `ended_early_on`). Audit `leave_request.ended_early`.
- `sectionsNeedingCover` on pending and approved requests: the person's class-teacher sections
  overlapping the leave, less the section its own cover covers; `[]` otherwise.

## 4. Audit actions (R57)

`leave_type.created | archived`, `leave_request.created | cancelled | approved | rejected |
ended_early`; approve with a cover also writes `teacher_assignment.created`, cancel and end early
may write `teacher_assignment.ended`.

## 5. Messages

`leave_requested { staffName, typeName, startsOn, endsOn, workingDays }` and
`leave_decided { typeName, startsOn, endsOn, decision }`, subject `leave_request`, internal (push,
email). Titles "Leave request" and "Leave decided" never carry a name (R111); the body does.

## 6. Constraint map (`constraints-leave.ts`)

`leave_requests_live_excl` → `409 LEAVE_OVERLAPS`; `leave_types_live_name_key` →
`409 LEAVE_TYPE_NAME_TAKEN`; `leave_requests_not_self`, `leave_requests_self_approved_unwarranted`
→ `409 SELF_ACTION_FORBIDDEN { reason: 'own_leave' }`; `leave_types_paid_check` → `422` on `paid`.
`leave_requests_actor_required` stays a `500`: it means a code path forgot the change context.

## 7. Staff day sheet

`GET /staff-attendance` rows gain `approvedLeave: { leaveRequestId, typeName } | null`: an approved
request covering the date, or an ended-early one up to its last day taken. Approved leave writes no
`staff_attendance` row; payroll reads both (R245). The web sheet shows "On approved leave: <type>".

## 8. Clients

**Web:** `/my-leave` (every staff member: balance cards, requests, request dialog with a key per
opening, cancel with a reason) and `/leave` (`staff.leave.approve`: the queue, approve with the
cover picker, reject, end early, record on behalf; `school.settings.manage`: leave types).
**Mobile:** Home card "My leave" → `/home/my-leave`. **Online only (R226):** reads use TanStack
Query without the SQLite cache and are not made offline; writes go straight to the API through
`useOnlineOnly('request_leave' | 'cancel_leave')`; nothing enters the outbox. Approving on the
phone is slice 27's Approvals tab.
