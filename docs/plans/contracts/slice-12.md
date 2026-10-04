# Slice 12 contracts — staff attendance

**Author:** api-designer, 2026-10-04. **Binds:** `apps/api/src/modules/attendance/staff/**` (new,
inside `AttendanceModule`), `src/repositories/staff-attendance.repository.ts` (new),
`modules/me/**` (`GET /me/staff/attendance`), `apps/web/app/(school)/staff-attendance/**`, the staff
detail's attendance tab. **Sources:** `CLAUDE.md` (rules 2, 4, 7, 13, 16), `phase-2-daily-operations.md`
§4.5, §4.6, §5 "Attendance" (`staff_attendance`), §6 slice 12, R133–R136; `slice-4.md` §2
(`StaffDto`, `StaffStatus`); `slice-10.md` §3 (`CalendarService.isStaffWorkingDay`); `slice-11.md`
§1.3 (the window), §4 (the submit and amend pattern, which this slice mirrors with fewer moving
parts). Everything not restated follows Phase 1 §3.9, `slice-1.md`, `slice-2.md` §1 and `slice-9.md`
§1. Paths are under `/api/v1`. Dates are `YYYY-MM-DD` in the school's timezone; "today" is
`SchoolClock.today`.

The tables exist: `staff_attendance` and `staff_attendance_changes` were migrated with the groundwork
(`20261004120000_phase2_attendance_diary`), with the history trigger `staff_attendance_history`
(tracked columns `status`, `note`; `reason_required`), the `staff_attendance_not_self` trigger (R134)
and the immutable, no-delete and `school_id` triggers. **This slice adds no migration.**

---

## 1. Access

| Route | Decorator | Row rule |
|---|---|---|
| `GET /staff-attendance` | `@RequireCapability(ATTENDANCE_STAFF_MANAGE)` | school-wide (the key has no teacher source) |
| `POST /staff-attendance/submit` | `@RequireCapability(ATTENDANCE_STAFF_MANAGE)` | the caller's own row is never in the payload (R134) |
| `POST /staff-attendance/:id/amend` | `@RequireCapability(ATTENDANCE_STAFF_MANAGE)` | the row is not the caller's own (R134) |
| `GET /staff/:id/attendance` | `@RequireCapability(STAFF_VIEW)` | any staff row of the school (R135) |
| `GET /me/staff/attendance` | `@RequireStaff()`, `me-reads` throttle | the caller's own staff row (R135) |

**One-sentence rules.** An `attendance.staff.manage` holder records and amends every staff member's
attendance except their own; a `staff.view` holder reads anyone's history; every active staff member
reads their own; nobody else reads it. There is no guardian or student view and no `all`/section
distinction: the key is school-wide wherever it is held (principal default, custom role or grant),
so no dated scope is involved.

Common errors on every route: `401 AUTH_REQUIRED` · `403 PERMISSION_DENIED` · `403 ORIGIN_REJECTED`
(cookie non-GET) · `426 UPGRADE_REQUIRED` (bearer) · `429 RATE_LIMITED`. Absent, malformed or another
school's `:id` → `404 NOT_FOUND`.

**Throttle:** `POST /staff-attendance/submit` and `/amend` share slice 11's
`perUserThrottle('attendance-writes', 60, 1000)`. `GET /me/staff/attendance` uses `me-reads`.

**Lock order:** `staff_attendance` rows only, locked in `staff_id` order; this slice takes no other
lock and nothing else takes a `staff_attendance` lock. It is independent of slice 11's chain.

**Text normalisation** (`reason`, `note`): as `slice-10.md` §1 — trim, collapse whitespace, no control
characters, no identity-number or phone-number pattern (`422 INVALID_VALUE`). The database also
refuses an identity pattern in `note` and `reason` (`staff_attendance_note_no_id_check`,
`staff_attendance_changes_reason_no_id_check`).

---

## 2. Shapes

Enums (`packages/shared/src/attendance.ts`, groundwork): `StaffAttendanceStatus` `present | absent |
late | on_leave` — its own set, so payroll can add a value without touching student attendance.
`MarkOutcome` `created | amended | unchanged` (shared with slice 11).

`StaffMarkDto`:

| Field | Type |
|---|---|
| `id` | string |
| `staffId` | string |
| `date` | date |
| `status` | `StaffAttendanceStatus` |
| `note` | string \| null — **staff-manage and `staff.view` routes only**; never on `/me/staff/attendance` (§4.3) |
| `markedBy`, `markedByName` | string, string — the first writer (frozen) |
| `markedAt` | datetime |
| `amended` | boolean — a `staff_attendance_changes` row exists |
| `lastAmendedAt`, `lastAmendedByName` | datetime \| null, string \| null — the latest changes row (there are no `last_amended_*` columns; read from the changes table) |

`StaffDayDto` (`GET /staff-attendance`): `staffId`, `fullName`, `designation` (string \| null),
`staffStatus` (`StaffStatus` — `active`, or the current status of a no-longer-active member who was
marked that day), `mark` (`StaffMarkDto` \| null).

`StaffSubmitResultDto`: `date`, `workingDay` (boolean, always `true` on success), `marks`
(`(StaffMarkDto & { outcome: MarkOutcome })[]`, in request order), `summary` (`{ staff, marked,
present, absent, late, onLeave }` — every active staff member on the date and the marks now
recorded for the date).

`StaffAttendanceDto` (`GET /staff/:id/attendance`, `GET /me/staff/attendance`):

| Field | Type |
|---|---|
| `staffId` | string |
| `dateFrom`, `dateTo` | date |
| `workingDays` | integer — staff working days in the range (§3) on or after `joined_on` and, when `left_on` is set, on or before it |
| `present`, `absent`, `late`, `onLeave` | integers — marks on working days by status |
| `unrecorded` | integer — `workingDays − (present + absent + late + onLeave)`, ≥ 0 |
| `days` | `StaffAttendanceDayDto[]` — one per calendar date in the range, ascending |

`StaffAttendanceDayDto`: `date`, `workingDay` (boolean — §3, now), `employed` (boolean — on or after
`joined_on`, and on or before `left_on` when set; `true` when `joined_on` is null), `status`
(`StaffAttendanceStatus` \| null), `note` (string \| null — `null` always on `/me/staff/attendance`),
`markedByName` (string \| null — **omitted from the `/me` route's DTO**, §4.3), `amended` (boolean).
A mark on a day that is no longer a working day (a staff holiday published after the fact) is still
listed with `workingDay: false` and is not counted.

`StaffMarkChangeDto` is not exposed in Phase 2: amendments are visible as `amended`,
`lastAmendedAt`, `lastAmendedByName`; the full change list is an audit-log question (plan §7: the
audit screen still needs its capability). Recorded as decision 7.

---

## 3. Working days and dates (R136)

`isStaffWorkingDay(date)` (`CalendarService`, `slice-10.md` §3): not a weekly-off day and inside no
**published** holiday with `appliesToStaff = true`. A teaching holiday on which staff work
(`appliesToStaff = false`) is a working day for this slice and a non-teaching day for slice 11.

Date rules on every write, after the shape check:

| Check | Refusal |
|---|---|
| `date` a real calendar date | `422` on `date` |
| `date ≤ today` | `422 INVALID_VALUE` on `date` ("in the future") |
| `date ≥ today − 366 days` | `422 INVALID_VALUE` on `date` (a typo guard; staff attendance has no academic-year bound) |
| `isStaffWorkingDay(date)` | `409 NOT_A_TEACHING_DAY` — the groundwork gave attendance one code for a closed day; the message reads "Not a working day for staff" and `details: { reason: 'weekly_off' \| 'staff_holiday' }` says why |

**Who may be marked on `date`** (`REFERENCE_NOT_FOUND` otherwise, per item): a `staff` row of the
school whose `status` is `active` **now** and whose `joined_on` is null or `≤ date`. A member who has
`left` cannot be marked for any date (their past marks stay readable); a `suspended` member likewise.
The current status is used because `staff` has no dated status history to read (slice 4 records
status changes in the audit log only) — recorded as decision 3.

**No amendment window.** `attendance.staff.manage` is school-wide wherever it is held, and slice 11
never locks a school-wide holder (R123's lock applies to section-scoped teachers, who do not exist
here). A write dated past `attendance_amend_window_days` is allowed and audited `afterWindow: true`,
as slice 11 does for `all` scope.

---

## 4. Routes

### 4.1 `GET /staff-attendance` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `date` | **required** date, `≤ today` |
| `status` | optional `StaffAttendanceStatus \| 'unrecorded'` |
| `q` | optional `SearchField` 2–100: `full_name ILIKE`; a 13-digit run → `422` (identity numbers are never a search key) |
| `sort` | `fullName` (default), `-fullName`, `status` (then `fullName`; unrecorded last); `staffId` tiebreak |

Rows: every staff member **active now with `joined_on` null or `≤ date`**, **union** every staff member
with a `staff_attendance` row on `date` (a member who has since left stays on the day they were
marked, with their current `staffStatus`), left-joined to the day's row. `status = unrecorded`
filters to `mark IS NULL`. **200** `{ data: StaffDayDto[], page, limit, total }`. A staff list of 150
fits three pages at `limit = 50`; the web screen pages, the summary comes with the submit.

### 4.2 `POST /staff-attendance/submit`

| Field | Rules |
|---|---|
| `date` | required date (§3) |
| `reason` | optional `TextField(3, 500)`, normalised; **required when any mark is an amendment** |
| `marks` | required array 1–500 of `StaffSubmitMarkDto`; a repeated `staffId` → `422 INVALID_VALUE` on `marks[i].staffId` |
| `marks[].staffId` | required id string |
| `marks[].status` | required `StaffAttendanceStatus` |
| `marks[].note` | optional `TextField(1, 200)`, normalised; absent → no note (each item is the complete intended mark, as slice 11 §4.2) |

There is no roster-completeness rule: the office may record only the absentees, and an unmarked
member is simply `unrecorded` (R133 says one row per member per date, not one row for every member).
Decision 4.

**Order, one `@Transactional()`:**

1. Shape (`422`), before any read. Throttle.
2. Date rules (§3) → `422` / `409 NOT_A_TEACHING_DAY`.
3. **Self (R134):** any `marks[].staffId` equal to the caller's `staffId` → `409 SELF_ACTION_FORBIDDEN`
   `details: { staffId }` — the **whole request** is refused, nothing written. A caller with no staff
   row cannot hold the key (R59), so the comparison always has a value.
4. Every `staffId` resolves to a markable member (§3) → else `422 REFERENCE_NOT_FOUND` on
   `marks[i].staffId`, all-or-nothing.
5. Existing rows for `(date, staffIds)` read `FOR UPDATE` in `staff_id` order (the only lock).
6. **Diff:** each item is `created` (no row), `unchanged` (same `status` and `note`) or `amended`.
   Any `amended` and `reason` absent → `409 AMENDMENT_REASON_REQUIRED` `details: { amendments: [{
   staffId, markId, from, to, noteChanged }] }` (R133) — also how two office users racing on one day
   see each other's result. Nothing `created` or `amended` → **identical replay**: `200`, no write,
   no history, no audit.
7. **Write:** `ChangeContextRepository` sets the transaction-local actor and reason once; new rows
   inserted (`marked_by = caller`, `marked_at = now`); changed rows updated — the
   `staff_attendance_history` trigger writes `staff_attendance_changes` for each; the
   `staff_attendance_not_self` trigger is the database's own R134 check and cannot fire after step 3
   (a test drives the trigger directly, §7). An insert that loses a race on
   `staff_attendance_natural_key` (two office users creating the same member's row at once) is
   caught **outside** the transaction and answered `409 CONCURRENT_UPDATE`; the client resubmits and
   lands in step 6 as an amendment or a replay.
8. **Audit** (§6): `staff_attendance.recorded` when every item is `created`; else
   `staff_attendance.amended` (reason required when `amended > 0`).

**200** `StaffSubmitResultDto` (there is no parent row to create, so no `201`). Errors: `422` (shape,
`REFERENCE_NOT_FOUND`, `INVALID_VALUE`) · `409 NOT_A_TEACHING_DAY` · `409 SELF_ACTION_FORBIDDEN` ·
`409 AMENDMENT_REASON_REQUIRED` · `409 CONCURRENT_UPDATE` · `429`.

Retry-safety: the natural key makes a resubmit a replay (`200`, unchanged) or a reasoned amendment.
This route is web-only in Phase 2 (the app reads "my attendance" and does not mark staff); it needs
no outbox behaviour.

### 4.3 `POST /staff-attendance/:id/amend`

| Field | Rules |
|---|---|
| `fromStatus` | required `StaffAttendanceStatus` — the status the client last saw |
| `status` | required `StaffAttendanceStatus` |
| `reason` | required `TextField(3, 500)`, normalised |
| `note` | optional; absent = unchanged; `null` clears; a string per §4.2 |

Order: shape → row `:id` resolved (`404`) → **self:** the row's `staff_id` is the caller's → `409
SELF_ACTION_FORBIDDEN` `details: { staffId }` (R134) → row locked → compare:

| State | Result |
|---|---|
| `status` and `note` (if sent) equal the current | **200**, no write, no audit (replay; `fromStatus` not checked) |
| `fromStatus ≠ current status` | `409 STALE_STATUS` `details: { currentStatus }` (R133) |
| otherwise | actor and reason set; `UPDATE staff_attendance`; the trigger writes the change; audit `staff_attendance_mark.amended` |

The day's working-day status is **not** re-checked: the row exists, and a holiday published after
the fact leaves it correctable (as slice 11 §3.2 does for marks). **200** `StaffMarkDto`.

### 4.4 `GET /staff/:id/attendance` and `GET /me/staff/attendance`

| Param | Rules |
|---|---|
| `dateFrom`, `dateTo` | required dates, `dateTo ≥ dateFrom`, `dateTo − dateFrom ≤ 365` (≤ 366 days) → `422` on `dateTo`; `dateTo` may be in the future (those days are `workingDay` as the calendar says, `status: null`) |

`/staff/:id`: the staff row in the school (`404`), any status (a `left` member's history is still
history, rule 4). `/me/staff`: the caller's own `staffId`; a caller with staff capacity always has
one (R59). Reads the member's rows in the range and the calendar (`isStaffWorkingDay` per date, now).
**200** `StaffAttendanceDto` — the same shape on both routes, except that **the `/me` route's DTO
class omits `note` and `markedByName`** (`MyStaffAttendanceDto`, a subclass without the two fields,
so OpenAPI shows the difference): the note is the office's remark about the member, written for the
office; who marked it is not the member's business (R135 grants the history, not the office's
working notes). Decision 6. Bounded objects, not pages.

---

## 5. Error codes

No new code. Used: `NOT_A_TEACHING_DAY` 409 (`details.reason ∈ { weekly_off, staff_holiday }`;
message "Not a working day for staff") · `SELF_ACTION_FORBIDDEN` 409 (`details.staffId`) ·
`AMENDMENT_REASON_REQUIRED` 409 (`details.amendments`) · `STALE_STATUS` 409 (`details.currentStatus`)
· `CONCURRENT_UPDATE` 409 · `REFERENCE_NOT_FOUND` / `INVALID_VALUE` 422 · `NOT_FOUND` 404.

Mapper entries: `staff_attendance_natural_key` → `CONCURRENT_UPDATE` (the race of §4.2 step 7);
`staff_attendance_not_self` → `SELF_ACTION_FORBIDDEN` (defensive: unreachable after step 3, present so
a future caller cannot turn the trigger into a `500`); `staff_attendance_changes_actor_required` /
`_reason_required` → `500` (a programming error: the service always sets both before a change).

## 6. Audit actions (school `audit_log`)

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `staff_attendance.recorded` | the caller's user (there is no day row to be the subject) | as given, else — | `{ date, created, staffIds }` — `staffIds` comma-joined (audit metadata holds scalars) |
| `staff_attendance.amended` | the caller's user | required when `amended > 0` | `{ date, created, amended, afterWindow, staffIds }` |
| `staff_attendance_mark.amended` | staff_attendance | required | `{ staffId, date, from, to, noteChanged, afterWindow }` |

Not audited: reads; identical replays. No note text in any metadata.

---

## 7. Tests this contract adds

R133 (one row per member per date: a second submit for the same member and date is `unchanged`,
`amended` with reason, or `AMENDMENT_REASON_REQUIRED`; `STALE_STATUS` on a stale amend; every change
has a `staff_attendance_changes` row with actor and reason; a direct `UPDATE` without the
transaction-local actor is refused by the database) · R134 (a principal's payload naming themself →
`SELF_ACTION_FORBIDDEN`, nothing written, even when the other 40 items are valid; amend of own row →
`409`; a second office user marks the principal → `200`; the trigger refuses a direct `INSERT` whose
`marked_by` is a login of the same staff member, and a direct `UPDATE` whose `asms.actor_user_id`
is) · R135 (any active staff member reads `/me/staff/attendance` and gets no `note` and no
`markedByName`; `staff.view` reads `/staff/:id/attendance` with both; a teacher without `staff.view`
gets `403` on `/staff/:id/attendance`; a `left` member's history is readable by `staff.view`) · R136
(Sunday → `409` with `reason: weekly_off`; a published holiday with `appliesToStaff` → `409
staff_holiday`; the same holiday with `appliesToStaff: false` → `200`; a draft holiday → `200`; amend
on a day later declared a staff holiday → `200`, the day listed with `workingDay: false` and not
counted) · markable set (a `left` or `suspended` member → `REFERENCE_NOT_FOUND`; `joined_on` after the
date → `REFERENCE_NOT_FOUND`; a member who left after being marked still appears in
`GET /staff-attendance` for that date) · `workingDays`/`unrecorded` arithmetic over a range crossing
a weekly-off day, a staff holiday, a teaching-only holiday and `joined_on` · two office users
concurrently creating one member's row: one `200`, the other `409 CONCURRENT_UPDATE` then a replay ·
isolation tests for `staff_attendance` and `staff_attendance_changes` · the R68 snapshot includes
`GET /me/staff/attendance` under `/me/staff/`.

Playwright: office records the day with two absentees, amends one with a reason, the principal's own
row is greyed out ("you cannot mark your own attendance"), a teacher sees "my attendance".

---

## 8. Web and app screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| Staff attendance — day view (web) | `GET /staff-attendance?date`, `POST /staff-attendance/submit` | Date picker (default today, non-working days disabled with the reason); one row per member, status buttons P/A/L/O and a note; the caller's own row is read-only with the R134 hint; "Save" sends every row the user touched; an amendment opens the shared confirm-with-reason; `AMENDMENT_REASON_REQUIRED` shows "changed since you loaded" per member |
| Amend one mark | `POST /staff-attendance/:id/amend` | From the row's menu; `STALE_STATUS` → reloads the row and asks again |
| Staff detail → Attendance tab | `GET /staff/:id/attendance` | Month heat map, counts, "n unrecorded of m working days"; notes and "marked by" visible |
| App — "my attendance" (slice 16) | `GET /me/staff/attendance` | Read-only month view; no notes, no marker |

---

## Decisions made here

1. **`NOT_A_TEACHING_DAY` is reused for a staff non-working day** with `details.reason ∈ {
   weekly_off, staff_holiday }` and a staff-specific message; the groundwork gave attendance one
   closed-day code and a second would say nothing a detail cannot.
2. **No amendment window for staff attendance**: the key is school-wide wherever held, and slice 11
   never locks a school-wide holder; late writes are audited `afterWindow`.
3. **Markable = `active` now, `joined_on ≤ date`**, read from the current `staff` row because the
   staff table has no dated status history; a `left` or `suspended` member's past marks stay
   readable and listed on their day.
4. **No roster-completeness rule**: a subset submit is normal (mark the absentees), and an unmarked
   member is `unrecorded`; the summary says how many.
5. **The self check is on the whole payload before any read** (R134: refused whole), and the
   database trigger is kept as the second line, mapped to the same code.
6. **`/me/staff/attendance` omits `note` and `markedByName`** through a subclass DTO; the staff-view
   route returns both.
7. **No change-list route for staff marks** in Phase 2: `amended`, `lastAmendedAt` and
   `lastAmendedByName` on the mark, the rest in the audit log (which still needs its capability,
   plan §7).
8. **Submit is always `200`** (no parent row is created), with the day's summary; the lock is the
   existing rows `FOR UPDATE` in `staff_id` order, and a losing insert race is `409
   CONCURRENT_UPDATE` recovered by resubmitting.
9. **The amend route does not re-check the working day**; the submit does.
10. **No migration**: the groundwork's `staff_attendance` and `staff_attendance_changes` are used as
    shipped; `lastAmended*` on the DTO comes from the changes table.
