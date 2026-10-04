# Slice 11 contracts — student attendance: registers, marks, arrivals, alerts, reports

**Author:** api-designer, 2026-10-04. **Binds:** `apps/api/src/modules/attendance/**` (new; the
two `/me` routes are its `my-attendance.controller.ts`),
`src/repositories/{attendance-register,attendance-mark,attendance-alert,attendance-summary,
attendance-report}.repository.ts` and `attendance-sql.ts` (new: arrivals live in the mark
repository, `attendance_day_status` and `attendance_daily_summary` in the summary and report
repositories), `src/jobs/**` (the `attendance` queue, two scheduled jobs, two outbox-sweep sources),
`src/messaging/templates.ts` and `types.ts` (the four attendance types go live),
`modules/people/students/attendance-history-probe.ts` (the real probe),
`modules/access/permissions.service.ts` and `tenancy/scope*.ts` (the `students` scope kind),
`common/school-settings-reader.ts` (the settings reader, shared with the diary),
`packages/shared/src/attendance-calc.ts` (the pure functions; the enums stay in `attendance.ts`), `apps/web/app/(school)/attendance/**`, the
student detail's attendance tab, the principal console tile. **Sources:** `CLAUDE.md` (rules 2, 3,
4, 6, 13, 14, 16, 17), `phase-2-daily-operations.md` §1.1 (items 23, authorised absence, window,
alert time), §4.3, §4.4, §4.5, §4.6, §4.7, §5 "Attendance", §6 slice 11, R118–R131, R163–R165
(for the two `/me` routes only), R167, R168, R174, R175; `slice-9.md` §7 (`NotificationService`,
the four message types, the worker patterns, §7.9's reserved sweep sources); `slice-10.md` §3
(`CalendarService`), §4.8 (`CalendarListener`), §7 (dated scope), §8 (`AttendanceHistoryProbe`,
`ATTENDANCE_RECORDED_AFTER`). Everything not restated follows Phase 1 §3.9, `slice-1.md` (envelope,
`422 VALIDATION_FAILED` with `details.fields`, string ids, camelCase, `NoQueryDto`, `@ApiErrors()`,
`@IdParam()`), `slice-2.md` §1 and `slice-9.md` §1 (access decorators, pipeline, throttles),
`slice-6.md` §1 (scope on student-linked reads). Paths are under `/api/v1`. Dates are `YYYY-MM-DD`
calendar dates in the school's timezone (R53); "today" is `SchoolClock.today`; times of day are
`HH:MM` in the school's timezone.

Owner's answers already settled and relied on here: **office staff hold `attendance.student.mark`
with `all` scope by default** (§1.2; `SYSTEM_ROLE_DEFAULTS`), and **a cover teacher has full
class-teacher scope** for the section and dates (R132).

---

## 1. Access and scope

### 1.1 Routes

| Route | Decorator | Row rule (the service) |
|---|---|---|
| `GET /sections/:id/register` | `@RequireCapability(ATTENDANCE_STUDENT_MARK, ATTENDANCE_STUDENT_VIEW_ALL)` (any of) | §1.2 **read** rule on the register's date |
| `POST /sections/:id/submit-register` | `@RequireCapability(ATTENDANCE_STUDENT_MARK)` | §1.2 **write** rule on the register's date |
| `POST /attendance-marks/:id/amend` | `@RequireCapability(ATTENDANCE_STUDENT_MARK)` | write rule on the mark's date, for the mark's section |
| `POST /attendance-arrivals` | `@RequireCapability(ATTENDANCE_STUDENT_MARK)` | write rule on `date`, for the section of the day's first mark |
| `GET /attendance-marks/:id/changes` | `@RequireCapability(ATTENDANCE_STUDENT_MARK, ATTENDANCE_STUDENT_VIEW_ALL)` | read rule on the mark's date |
| `GET /attendance-registers` | `@RequireCapability(ATTENDANCE_STUDENT_VIEW_ALL, ATTENDANCE_STUDENT_MARK)` | **today's** scope (`scopeOf(session)`, plan §4.4: list reads) |
| `GET /attendance-reports/daily-summary` | same as above | today's scope |
| `GET /attendance-reports/absentees`, `/late`, `/percentage` | `@RequireCapability(ATTENDANCE_STUDENT_VIEW_ALL)` | school-wide (the key has no teacher source) |
| `GET /students/:id/attendance` | `@RequireCapability(STUDENT_VIEW)`, scoped as `slice-6.md` §1 | student in today's scope → else `404` |
| `GET /me/children/:id/attendance` | `@RequireCapacity('guardian')`, `me-reads` throttle | `:id` ∈ the guardian scope (§1.4) → else `404` |
| `GET /me/student/attendance` | `@RequireCapacity('student')`, `me-reads` throttle | the session's own student |

**One-sentence rules.** A staff member may read a register when, on its date, they hold a role in
its section or hold a school-wide attendance key; may write it when, on its date, they are its class
teacher or cover (any period), its subject teacher (period mode only), or hold `attendance.student.mark`
school-wide; a guardian reads only the children linked to them with `can_login`; a student reads
only themself; `attendance.student.view_all` reads everything and writes nothing (R130). A
register of a section the caller is assigned to only on other dates is `403 not_assigned_on_date`
(§1.2); a section never in the caller's assignments is `404`.

Common errors on every route: `401 AUTH_REQUIRED` · `403 PERMISSION_DENIED` · `403 ORIGIN_REJECTED`
(cookie non-GET) · `426 UPGRADE_REQUIRED` (bearer) · `429 RATE_LIMITED`. Every `:id` resolves in the
session's school and inside the caller's scope only; absent, malformed, another school's or out of
scope → `404 NOT_FOUND`, identical body.

### 1.2 Dated, role-aware scope (R120, R175; `slice-10.md` §7)

For a section `S` and date `d`, the service calls `PermissionsService.scopeOf(session, { capability,
on: d })` with the one capability the action needs (`MARK` for writes; for reads `VIEW_ALL` first,
then `MARK`), and applies:

| Result | Read | Write |
|---|---|---|
| `null` (not held) | try the next admitted key; none left → `404` (the row is outside what the caller may see) | cannot occur after the decorator |
| `kind: 'all'` | allowed; `callerRole = 'all'` | allowed, unbounded by the window (R123), audited `afterWindow` when past it |
| `kind: 'sections'`, `S` absent from the map, and the caller holds **no** live assignment reaching `S` on any date | `404 NOT_FOUND` | `404 NOT_FOUND` |
| `kind: 'sections'`, `S` absent from the map, but the caller holds a live (not voided) assignment reaching `S` on **another** date (a section row, or a whole-class subject row of its class) | `403 PERMISSION_DENIED` `details.reason = 'not_assigned_on_date'` | the same `403` |
| `S` present, `classTeacher` or `cover` | allowed | allowed, any period, any mode; bounded by the window |
| `S` present, `subjectIds` non-empty only | allowed | period mode: allowed, any period (no timetable, plan §7); **daily mode: `403 PERMISSION_DENIED` `details.reason = 'subject_teacher_daily_mode'`** — the row is visible, the role is insufficient, so this is the one `403` that follows a successful scope check |

Cover inside its dates is a class teacher (owner's answer); the day after `endsOn` the map has no
entry and, because the cover row reaches the section, the answer is `403 not_assigned_on_date`. A
teacher with a row starting after `d` is `403 not_assigned_on_date` on `d` (R175's "dated before
their assignment began"). A section the caller has never been assigned to stays `404`.
*Ruling of the main thread, 2026-10-04: aligned with `slice-13.md` decision 13 so both slices
answer a dated-out assignment alike (the section is visible to the caller; `404` would hide
nothing and would not say why). One implementation decides it for both slices:
`PermissionsService.refuseOutsideDate` over `TeacherAssignmentRepository.everAssigned`.*

**Student-linked reads take the scope (control 7).** Every repository read keyed by a student —
the student's enrolments in force or overlapping, their materialised days, their periods, the alert
rows of the roster and the reports — takes a `Scope` and joins through the student
(`studentInScope`, or its raw-SQL form `studentInScopeSql`). A read gated on the row's own date (the
register view's alert state, the arrival's enrolments) passes `rowScope` of the dated scope that
admitted the caller and uses `studentInScopeOn(scope, date)`: an enrolment of the student in one of
its sections in force on that date, whatever its status now, so a child who has since moved or left
keeps their alert state on the register they were marked in (R174).

### 1.3 The amendment window (R123, R125)

`windowOpen(d) = today − d ≤ school_settings.attendance_amend_window_days` (whole days; `0` = the
day itself only). **The window bounds every section-scoped write for date `d`** — first submit, later
submit, amend and arrival — not only amendments: a register created ten days late is as suspect as a
mark changed ten days late, and the plan's own reason for the window ("a teacher offline on Friday
syncs on Monday") is a late first write. A section-scoped write past the window → `409
ATTENDANCE_LOCKED` `details: { date, windowDays }`. An **identical replay** is `200` regardless of the
window (R125), so an outbox always clears. `all`-scope holders are never locked; a write past the
window by them carries `afterWindow: true` in its audit metadata.

### 1.4 Guardian and student scope — shared wave-E groundwork (plan §4.3, R163, R164)

Specified once, in **`slice-13.md` §1.2**, and not restated: `Scope` gains `{ kind: 'students'; ids }`
(minted by `scopeStudents` in the access module); `RouteAccessGuard` binds the capacity scope on a
`@RequireCapacity` route exactly as it binds a capability scope, so the two `/me` routes here read
`scopeOf(session)` like every other route; a guardian's ids are the students of live
`student_guardians` rows with `can_login = true` (guardian not merged), one query per request, no
enrolment condition (R164: a child who has left stays readable while the link is live); a student's
is their own id. **Whichever of slices 11 and 13 lands first builds it; the other uses it.** On the
two routes here, `:id ∉ scope.ids` → `404`. `MeDto.children` (slice 13 §2.2) is how the app knows
which `:id`s to ask for; there is no list route under `/me/children`.

### 1.5 Throttles

| Bucket | Limit | Key |
|---|---|---|
| `POST /sections/:id/submit-register`, `POST /attendance-marks/:id/amend`, `POST /attendance-arrivals` (`AttendanceWritesThrottleGuard` in `modules/attendance/attendance-throttles.ts`, `perUserThrottle('attendance-writes', 60, 1000)`, the one definition slice 12's writes import too) | 60/min, 1,000/hour | school + user |
| `GET /me/children/:id/attendance`, `GET /me/student/attendance` | `me-reads` (120/min, 2,000/hour) | school + user |
| everything else | the global per-IP throttler | IP |

Sixty a minute covers an outbox burst of a week's registers; the gate's arrivals share the bucket.

### 1.6 Lock order (whole system after slice 11)

`slice-9.md` §1.7's chain, extended at the end: `… → whatsapp_numbers → `**`students` (FOR SHARE, id
order) → `attendance_registers` → `attendance_marks` → `attendance_alerts` (id order) → `messages`**
(written by `NotificationService`). The summary trigger (§8.1) takes `attendance_daily_summary` rows
after marks; the recompute job takes `attendance_day_status` then `attendance_daily_summary` and
never a mark, register or student. The `CalendarListener` (§7) takes the holiday row (slice 10) and
then alert rows; it never takes a register. The alert processor (§6.4) takes one alert row and then
writes messages; it never takes a register or a student. No path takes a student after a register, or
a register after an alert.

Why students are locked `FOR SHARE`: the section- and class-change routes lock the **student** row and
then probe `lastRecordedOn` (`slice-10.md` §8.2 step 5). A submit that only read enrolments could
insert a mark between that probe and the change's commit, leaving a mark on an enrolment that ended
before it. Sharing the student rows of the roster during the submit makes the probe exact: the change
waits for the submit, or the submit waits for the change and then reads the new roster.

---

## 2. Shapes

### 2.1 Enums (`packages/shared`, groundwork; `enum` + `enumName` on every DTO use)

| Enum | Values |
|---|---|
| `AttendanceStatus` | `present \| absent \| late \| on_leave` |
| `DayStatus` | `present \| absent \| late \| on_leave \| partial` |
| `LateCountsAs` | `present \| half_day \| absent_after_cutoff` |
| `LeaveCountsAs` | `excused \| absent` |
| `AttendanceMode` | `daily \| period` (slice 3) |
| `RegisterSource` | `app \| web` — from the session channel: `bearer → app`, `cookie → web` (database enum `register_source`, migrated) |
| `MarkOutcome` *(new, shared)* | `created \| amended \| unchanged` |
| `AttendanceAlertKind` | `absence \| late \| corrected` (migrated) |
| `AttendanceAlertStatus` | `pending \| sent \| cancelled` (migrated; `sent` and `cancelled` final by trigger `attendance_alerts_status_final`) |
| `AttendanceAlertCancelReason` | `mark_changed \| holiday \| link_ended \| backdated` (migrated). **`link_ended` means "no eligible guardian remained at send time"** (§6.3) — the value is kept as shipped; its meaning is fixed here |
| `AttendanceSort`, report sorts | per route below |

The four attendance enums above exist in `schema.prisma` and the groundwork migration
(`20261004120000_phase2_attendance_diary`); `packages/shared/src/attendance.ts` exports the first
three as `const` arrays and gains `MARK_OUTCOMES`, `ATTENDANCE_ALERT_KINDS`, `ATTENDANCE_ALERT_STATUSES`,
`ATTENDANCE_ALERT_CANCEL_REASONS`, `REGISTER_SOURCES` for the DTOs.

### 2.2 DTOs

`RegisterDto`:

| Field | Type |
|---|---|
| `id` | string |
| `sectionId`, `sectionName`, `classId`, `className`, `academicYearId` | string / string / string / string / string |
| `date` | date |
| `period` | integer 1–12 |
| `mode` | `AttendanceMode` — copied from the class at first submit, frozen |
| `teachingDay` | boolean — `isTeachingDay(date)` **now**; `false` on a register later covered by a holiday (R167) |
| `submittedBy`, `submittedByName` | string, string — user id and that user's staff name |
| `submittedAt` | datetime |
| `lastAmendedBy`, `lastAmendedByName`, `lastAmendedAt` | string \| null ×3 |
| `source` | `RegisterSource` |

`AttendanceMarkDto`:

| Field | Type |
|---|---|
| `id`, `registerId`, `enrolmentId`, `studentId` | string |
| `date` | date |
| `period` | integer |
| `status` | `AttendanceStatus` |
| `arrivedAt` | string `HH:MM` \| null — only ever set on a `late` mark |
| `note` | string \| null — the teacher's text; **staff routes only** (never in a `/me` DTO, R165) |
| `amended` | boolean — at least one `attendance_mark_changes` row exists |

`RosterRowDto`: `enrolmentId`, `studentId`, `studentFullName`, `rollNo` (integer \| null), `onRoster`
(boolean — `false` for a row kept only because it is already marked: a child moved or exited after
the mark), `mark` (`AttendanceMarkDto` \| null), `alert` (`AlertSummaryDto` \| null).

`AlertSummaryDto` (the child-day's alert state, §6; one shape for the roster and the reports):

| Field | Type |
|---|---|
| `absence` | `AttendanceAlertStatus` \| null — the latest-`seq` `absence` row's status; null when none |
| `absenceCancelReason` | `AttendanceAlertCancelReason` \| null |
| `absenceDueAt` | datetime \| null — while `pending` |
| `absenceResolvedAt` | datetime \| null — the row's `updated_at` once `sent` or `cancelled` (the only update a final row ever receives) |
| `lateAdvice` | `AttendanceAlertStatus` \| null — the `late` row |
| `corrections` | integer 0–3 — `corrected` rows |
| `correctionsCapped` | boolean — a fourth `absence` or `corrected` row of this child-day was due and refused, so nothing was sent for it (a row carries `capped_at`, §6.2). False while three or fewer were due: three sent is not yet capped |

`RegisterViewDto` (`GET /sections/:id/register`):

| Field | Type |
|---|---|
| `section` | `{ id, name, classId, className, academicYearId, attendanceMode }` |
| `date` | date |
| `period` | integer |
| `periodsPerDay` | integer — the setting now |
| `teachingDay` | boolean — now |
| `register` | `RegisterDto` \| null — null when unrecorded |
| `roster` | `RosterRowDto[]` — §3.1's order; the whole roster (≤ 200), not paginated |
| `canSubmit` | boolean — the §1.2 write rule for this caller, ignoring the window |
| `amendable` | boolean — `canSubmit` and (`all` scope or `windowOpen(date)`) |
| `callerRole` | `'all' \| 'class_teacher' \| 'cover' \| 'subject_teacher' \| 'viewer'` — the strongest that applies |

`RegisterSubmitResultDto`: `created` (boolean — this request created the register), `register`
(`RegisterDto`), `marks` (`(AttendanceMarkDto & { outcome: MarkOutcome })[]`, in request order),
`summary` (`RegisterCountsDto`), `alerts` (`{ absencePending: integer, absenceBackdated: integer,
lateAdvicePending: integer, cancelled: integer, corrections: integer }` — what this request did to
alert rows; zeros on a replay).

`RegisterCountsDto`: `roster`, `marked`, `present`, `absent`, `late`, `onLeave` (integers; the
register's marks after the write).

`MarkChangeDto`: `id`, `markId`, `fromStatus`, `toStatus` (`AttendanceStatus`), `noteChanged`
(boolean), `fromArrivedAt`, `toArrivedAt` (`HH:MM` \| null), `changedBy`, `changedByName`,
`changedAt`, `reason`.

`SectionDayDto` (`GET /attendance-registers`):

| Field | Type |
|---|---|
| `sectionId`, `sectionName`, `classId`, `className`, `academicYearId` | strings |
| `date` | date |
| `mode` | `AttendanceMode` — the class's now |
| `rosterCount` | integer — enrolments in force that day (§3.1, without the union) |
| `registersExpected` | integer — `1` in daily mode, else `periodsPerDay` now |
| `registersRecorded` | integer — **live** count of `attendance_registers` rows |
| `recorded` | boolean — `registersRecorded > 0` |
| `submittedBy`, `submittedByName`, `submittedAt` | string \| null ×3 — the day's earliest register |
| `classTeacherStaffId` | string \| null — that assignment's staff id (the console links to the staff page) |
| `classTeacherName` | string \| null — the class-teacher assignment active on the date |
| `coverStaffIds` | string[] — every cover active on the date, by assignment id |
| `coverStaffName` | string \| null — a cover active on the date (first by id) |
| `declaredHolidayAfter` | boolean — `recorded` and not a teaching day now (R167) |

`DailySummaryDto` (`GET /attendance-reports/daily-summary`): `sectionId`, `sectionName`, `classId`,
`className`, `date`, `mode`, `registersExpected` (integer — set at first computation and never
changed after; **`0` until then**, the column's migrated default), `registersRecorded`, `rosterCount`, `present`, `absent`, `late`, `onLeave`,
`partial`, `unrecorded` (`rosterCount − (present + absent + late + onLeave + partial)`, ≥ 0),
`teachingDay` (boolean, now), `computedAt` (datetime \| null), `stale` (boolean — `computed_version ≠
version`).

`StudentAttendanceDto` (three routes; **no `note` anywhere in it**, R165):

| Field | Type |
|---|---|
| `studentId` | string |
| `dateFrom`, `dateTo` | date |
| `percentage` | number \| null — one decimal; null when `countedDays = 0` (R128: "no recorded days", never 100 or NaN) |
| `countedDays` | integer — §5.3 |
| `teachingDays` | integer — teaching days in the range on which the student had an enrolment in force |
| `present`, `absent`, `late`, `onLeave`, `partial` | integers — counted days by derived status |
| `excludedLeaveDays` | integer — `on_leave` days left out of the denominator under `leaveCountsAs = excused` |
| `unrecorded` | integer — `teachingDays − countedDays − excludedLeaveDays` |
| `days` | `StudentDayDto[]` — one per calendar date in the range, ascending |

`StudentDayDto`: `date`, `teachingDay` (boolean), `enrolled` (boolean — an enrolment in force),
`status` (`DayStatus` \| null — null when nothing recorded), `value` (number \| null — §5.2; null
when excluded or unrecorded), `periods` (`[{ period, status, arrivedAt }]`, ascending; `[]` when
none).

Report rows:

- `AbsenteeRowDto` (`/absentees`, `/late`): `studentId`, `fullName`, `rollNo`, `enrolmentId`,
  `classId`, `className`, `sectionId`, `sectionName`, `status` (`DayStatus`), `arrivedAt`
  (`HH:MM` \| null — the first late period's), `alert` (`AlertSummaryDto` \| null).
- `PercentageRowDto` (`/percentage`): `studentId`, `fullName`, `rollNo`, `classId`, `className`,
  `sectionId`, `sectionName` (the current active enrolment's; null set when none), `percentage`
  (number \| null), `countedDays`, `teachingDays`.

---

## 3. The roster and the register's date

### 3.1 Roster query (R124, R174)

For section `S` on date `d`:

```
onRoster(S, d) = enrolments e
  WHERE e.section_id = S
    AND e.started_on <= d AND (e.ended_on IS NULL OR e.ended_on >= d)   -- ended_on is the LAST day in force
    AND statusOn(e.student_id, d) <> 'suspended'
roster(S, d, register) = onRoster(S, d)  ∪  { e : a mark of `register` references e }
```

- **`ended_on` is the last day the enrolment is in force**, in every path that sets it: a section or
  class change closes on `effectiveOn − 1` (slice 10), and a student exit (`slice-6.md` §3.6) sets
  `ended_on = effectiveOn`, so **an exit's `effectiveOn` is the child's last day on roll** — the
  question slice 10 §8.3 left to this slice. The register of `effectiveOn` still lists the child.
- `statusOn(student, d)` is the `to_status` of the latest `student_status_changes` row with
  `effective_on ≤ d` (the admission row counts; none → `active`). A student suspended from the 10th
  is on the roster of the 9th and off it from the 10th; reactivation returns them. The current
  `students.status` is not used, so a past register's roster does not change when a status changes
  later.
- The union keeps a marked child visible after a move or exit dated on or after the mark (R174, rule
  4); such rows carry `onRoster: false`. The ordinary case never produces one: a section or class
  change dated on or before a mark is refused (`ATTENDANCE_RECORDED_AFTER`, §9.1).
- Order: `roll_no` ascending with nulls last, then `students.full_name`, then `enrolments.id`.
- The read takes `FOR SHARE OF students` in id order on writes only (§1.6); reads take no lock.

### 3.2 Date and period rules (R118, R121, R124)

Applied to `GET /sections/:id/register`, submit and arrivals, in this order after the scope check:

| Check | Refusal |
|---|---|
| `date` is a real calendar date | `422 VALIDATION_FAILED` on `date` |
| `date ≤ today` (school timezone) | `422 INVALID_VALUE` on `date` ("in the future") |
| `year.startsOn ≤ date ≤ year.endsOn` for the class's academic year | `422 INVALID_VALUE` on `date` ("outside the academic year") |
| `isTeachingDay(date)` (`CalendarService`, slice 10 §3) — **writes only**; a read returns `teachingDay: false` and whatever exists | `409 NOT_A_TEACHING_DAY` |
| `period` integer 1–12 | `422` on `period` |
| mode `daily` → `period = 1`; mode `period` → `period ≤ periodsPerDay` — **writes only**; a read accepts 1–12 so a register recorded under a larger setting stays readable | `422 INVALID_VALUE` on `period` |

A register that exists on a day that is **no longer** a teaching day (a holiday published later,
R167) is read normally with `teachingDay: false` and `amendable: false`; its submit is `409
NOT_A_TEACHING_DAY`; its marks may still be amended through `POST /attendance-marks/:id/amend` (the
mark exists; the day is excluded from every percentage and its alerts are already cancelled).

---

## 4. Registers and marks

### 4.1 `GET /sections/:id/register` — `{ date, period }` both required

Section `:id` in the school (archived included: a past register of an archived section is readable)
→ else `404`. Scope per §1.2 (read) → `404`. Date and period per §3.2 (read variant). Then the roster
(§3.1, no lock) left-joined to the register's marks and to the child-day's alert rows.

**200** `RegisterViewDto`. `register: null` when unrecorded; the roster is still returned so the
screen is the empty register to fill in. Not paginated: a section has at most 200 enrolments in force
(the submit bound), a bounded object.

### 4.2 `POST /sections/:id/submit-register`

| Field | Rules |
|---|---|
| `date` | required date (§3.2) |
| `period` | required integer 1–12 (§3.2) |
| `reason` | optional `TextField(3, 500)`, normalised (`slice-10.md` §1: trim, collapse, no control, no identity or phone pattern); **required when any mark is an amendment** |
| `marks` | required array 1–200 of `SubmitMarkDto`; a repeated `enrolmentId` → `422 INVALID_VALUE` on `marks[i].enrolmentId` |
| `marks[].enrolmentId` | required id string |
| `marks[].status` | required `AttendanceStatus` |
| `marks[].note` | optional `TextField(1, 200)`, normalised as `reason`; absent → the mark has no note (each item is the complete intended mark) |
| `marks[].arrivedAt` | optional `HH:MM` (`^([01][0-9]\|2[0-3]):[0-5][0-9]$`); allowed only with `status = late` → else `422 INVALID_VALUE` on `marks[i].arrivedAt` |

**Order, one `@Transactional()`:**

1. Shape (`422`), before any read. Throttle (§1.5).
2. Section `:id` in the school, its class, year and `attendance_mode` read → else `404`.
3. Dated scope on `date` (§1.2 write rule) → `404` / `403`.
4. Date, teaching day, period (§3.2) → `422` / `409 NOT_A_TEACHING_DAY`.
5. **Roster** (§3.1) read with `FOR SHARE OF students`, id order. Every `marks[].enrolmentId` must be
   in `onRoster(S, d)` or already marked in this register → else `422 REFERENCE_NOT_FOUND` on
   `marks[i].enrolmentId`, **all-or-nothing** (R124): nothing is written.
6. **Register row:** `INSERT INTO attendance_registers (…, mode, submitted_by, submitted_at, source) …
   ON CONFLICT ON CONSTRAINT attendance_registers_natural_key DO NOTHING RETURNING id`; then `SELECT …
   FOR UPDATE` by the natural key. A concurrent first submit's insert blocks the second until the first
   commits; the second then finds and locks the row. `created = (the insert returned a row)`.
7. **First submit** (`created`): `marks` must cover every `onRoster` enrolment → else `422
   ROSTER_INCOMPLETE` `details: { missing: [enrolmentId…] }` (R119). Rolled back: no register.
8. **Diff** against the existing marks of the register: each item is `created` (no mark),
   `unchanged` (same `status`, `note` and `arrivedAt`, `IS DISTINCT FROM` semantics) or `amended`.
   - Any `amended` and the caller is section-scoped and `!windowOpen(date)` → `409 ATTENDANCE_LOCKED`.
     Any `created` under the same conditions → the same (§1.3). (Both checks before the reason check:
     a locked write is locked whatever the body says.)
   - Any `amended` and `reason` absent → `409 AMENDMENT_REASON_REQUIRED` `details: { amendments: [{
     enrolmentId, markId, from, to, noteChanged }] }` (R122) — the list is **also how a second teacher
     racing on one register sees the first teacher's result**: their differing marks come back as
     amendments to confirm or drop.
   - Nothing `created` or `amended` → **identical replay**: `200`, no write, no history, no audit, no
     alert work (R125). Not subject to the window.
9. **Write:** `ChangeContextRepository` sets the transaction-local actor and reason
   (`set_config('asms.actor_user_id', …, true)`, `set_config('asms.change_reason', …, true)`, plan
   §4.6) once; then **one statement** `INSERT … ON CONFLICT ON CONSTRAINT
   attendance_marks_natural_key DO UPDATE SET status, note, arrived_at … WHERE (marks.status,
   marks.note, marks.arrived_at) IS DISTINCT FROM (EXCLUDED…)` over the items, `Prisma.join`,
   ordered by `enrolment_id`. The `attendance_marks_history` trigger writes `attendance_mark_changes`
   only for rows whose tracked columns changed (a missing actor or reason is refused as
   `attendance_mark_changes_actor_required` / `_reason_required`, mapped to `500` — a programming
   error, because step 8 has already demanded the reason). Not `created`: `last_amended_by/at` set
   on the register.
10. **Alerts** (§6.2) for every child whose mark was created or amended.
11. **Audit** (§11): `attendance_register.submitted` when `created`; else
    `attendance_register.amended` (reason required when any `amended`; a subset submit that only adds
    marks records `amended: 0`).
12. After commit: the `attendance-rollup` job for `(section, date)` (§8.2) and any alert jobs (§6.4).

**201** `RegisterSubmitResultDto` when `created`, **200** otherwise. The returned `marks` cover the
items sent, in request order, each with its `outcome`.

Errors: `422` (shape, `REFERENCE_NOT_FOUND`, `ROSTER_INCOMPLETE`, `INVALID_VALUE`) · `404` · `403
PERMISSION_DENIED` (`subject_teacher_daily_mode`) · `409 NOT_A_TEACHING_DAY` · `409
ATTENDANCE_LOCKED` · `409 AMENDMENT_REASON_REQUIRED` · `409 CONCURRENT_UPDATE` (the natural-key race
on marks that step 6's lock should make impossible; mapped defensively, retried by the client) ·
`429`.

**Retry-safety and the outbox (plan §4.7, R158).** The natural keys make the whole request
idempotent: the app coalesces every write to one `(section, date, period)` into one body and sends
it with the latest `reason`; a `201`/`200` is "saved on server"; `409` is terminal with the server's
message (the teacher resolves it online); `401` pauses; `426` updates. The first submit's
`ROSTER_INCOMPLETE` cannot occur from the app, which always sends the full roster it downloaded —
unless the roster changed meanwhile (an admission that morning), which is exactly when the teacher
should be told.

### 4.3 `POST /attendance-marks/:id/amend`

| Field | Rules |
|---|---|
| `fromStatus` | required `AttendanceStatus` — the status the client last saw |
| `status` | required `AttendanceStatus` |
| `reason` | required `TextField(3, 500)`, normalised |
| `note` | optional; absent = unchanged; `null` clears; a string per §4.2 |
| `arrivedAt` | optional `HH:MM`; absent = unchanged; `null` clears; a value requires `status = late` (`422 INVALID_VALUE`); a change to a status other than `late` clears it |

Order: shape → mark `:id` resolved with its register (`404`) → dated scope on the mark's date for the
mark's section (§1.2 write; `404` / `403`) → **lock the register row, then the mark** → compare:

| State | Result |
|---|---|
| `status`, `note` (if sent) and `arrivedAt` (if sent) all equal the current | **200**, no write, no audit (replay; `fromStatus` is not checked) |
| `fromStatus ≠ current status` | `409 STALE_STATUS` `details: { currentStatus }` — a stale phone never silently reverses a colleague (R125) |
| section-scoped and `!windowOpen(date)` | `409 ATTENDANCE_LOCKED` |
| otherwise | `set_config` actor and reason; `UPDATE attendance_marks`; the trigger writes the change; register `last_amended_by/at`; alerts (§6.2); audit `attendance_mark.amended` |

**200** `AttendanceMarkDto`. After commit: `attendance-rollup` for the section-day and alert jobs.
The route is **online-only** in the app (R162): it never enters the outbox.

### 4.4 `POST /attendance-arrivals` — the gate (R168)

| Field | Rules |
|---|---|
| `studentId` | required id string |
| `date` | required date; `≤ today` (§3.2) — the gate sends today |
| `arrivedAt` | required `HH:MM` |

Order: shape → student `:studentId` in the school **and in today's `student.view`-style visibility of
the caller**: an enrolment in force on `date` whose section is in `scopeOf(session, { capability:
MARK, on: date })` (`all` = any) → else `404` → the day's marks for the student (every enrolment,
every register of that date), ordered by `period`:

| First (lowest-period) mark | Result |
|---|---|
| none recorded | `409 ARRIVAL_NOT_ABSENT` `details: { status: null }` — the register comes first |
| `absent` | proceed |
| `late` with the same `arrived_at` and an `attendance_arrivals` row for it with the same time | **200** `AttendanceMarkDto` — a replay of this arrival |
| anything else | `409 ARRIVAL_NOT_ABSENT` `details: { status }` |

Then teaching-day check (`409 NOT_A_TEACHING_DAY`), window (§1.3 → `409 ATTENDANCE_LOCKED` for a
section-scoped caller), **lock the register, then the mark**; `set_config` actor and reason
`Arrived at HH:MM` (`ARRIVAL_REASON(arrivedAt)` in `@asms/shared`, the automatic reason R168 names);
`UPDATE … SET status = 'late', arrived_at = $t`; insert `attendance_arrivals (mark_id, arrived_at,
recorded_by, recorded_at)`; alerts exactly as an amendment (§6.2); audit
`attendance_mark.arrival_recorded`. Only the lowest-period mark changes: a second `absent` period
recorded by another teacher stays as it is and the day derives `partial` until that teacher amends
(R127: both entries remain visible).

**200** `AttendanceMarkDto`. Online-only in the app (R162). Errors: `422` · `404` · `409
ARRIVAL_NOT_ABSENT` · `409 NOT_A_TEACHING_DAY` · `409 ATTENDANCE_LOCKED` · `429`.

### 4.5 `GET /attendance-marks/:id/changes` — paginated

Mark `:id` resolved (`404`), read scope on its date (§1.2). `PageQueryDto`; sort `-changedAt`
(default), `changedAt`; `id` tiebreak. **200** `{ data: MarkChangeDto[], page, limit, total }` from
`attendance_mark_changes`. Reasons are shown to staff only; this route has no `/me` twin.

---

## 5. Derived status and percentage — normative, pure, shared

All three functions live in `packages/shared/src/attendance-calc.ts` over plain values, so the API, the web
heat map and the app compute the same answer; the API's recompute job (§8) and read services call
them, never a reimplementation. Each row of each table below is a named test.

### 5.1 `deriveDayStatus(periods: { period, status }[]) → { status: DayStatus, counts }` (R127)

Input: the **recorded** periods of one enrolment-day (any subset of 1…12; unrecorded periods are
absent from the list), ascending by period. Rules, first match wins:

| # | Condition | `status` |
|---|---|---|
| 1 | every recorded period `on_leave` | `on_leave` |
| 2 | every recorded period `absent` | `absent` |
| 3 | any recorded period `absent` or `on_leave` (mixed) | `partial` |
| 4 | the **first recorded** period is `late` and every other is `present` or `late` | `late` |
| 5 | otherwise (all `present`, or `late` only after a `present` first period) | `present` |

`counts = { recorded, present, late, absent, leave }`. Daily mode is the one-period case. Examples
(P1…Pn): `[A]` → absent · `[L]` → late · `[P, L]` → **present** (rule 5: a late to a later period is
not a late day) · `[L, P, P]` → late · `[A, P, P]` → partial · `[A, L]` → partial · `[OL, OL]` →
on_leave · `[OL, P]` → partial · `[A, A, A]` → absent. The `[P, L]` case is the plan's rule applied
literally and is tested as such.

### 5.2 `dayValue(day, settings) → number | null` (R128)

`day = { status: DayStatus, counts, firstLateArrivedAt: 'HH:MM' | null }`, `settings = { lateCountsAs,
lateCutoffTime, leaveCountsAs }`. `null` means **excluded** (not a counted day).

| `status` | `value` |
|---|---|
| `present` | `1` |
| `absent` | `0` |
| `late` | `lateCountsAs = present` → `1` · `half_day` → `0.5` · `absent_after_cutoff` → `0` when `firstLateArrivedAt` is known and `> lateCutoffTime`, else `1` (an unknown arrival time is not penalised) |
| `on_leave` | `leaveCountsAs = absent` → `0` · `excused` → **`null`** (excluded from the denominator) |
| `partial` | `(counts.present + counts.late) / counts.recorded` — late inside a partial day counts as present; an `on_leave` period inside a partial day counts as not present whatever `leaveCountsAs` says (the plan's rule, applied literally: a day with any absent period is counted) |

### 5.3 `attendancePercentage(days, settings) → { percentage, countedDays, … }` (R128)

Input: one entry per calendar date in the requested range: `{ date, teachingDay, enrolled, day |
null }` where `day` is §5.1's result when anything was recorded.

```
countable(d)   = d.teachingDay ∧ d.enrolled ∧ d.day ≠ null
value(d)       = dayValue(d.day, settings)
counted        = { d : countable(d) ∧ value(d) ≠ null }
excludedLeave  = { d : countable(d) ∧ value(d) = null }
percentage     = |counted| = 0 ? null : round(Σ value(d) / |counted| × 100, 1 dp)
teachingDays   = |{ d : d.teachingDay ∧ d.enrolled }|
unrecorded     = teachingDays − |counted| − |excludedLeave|
```

- `teachingDay` is evaluated **now**, against the current weekly-off set and published holidays
  (slice 10 §3): a holiday declared after the fact removes those days from both numerator and
  denominator with no stored change (R116, R167); cancelling it restores them.
- Aggregation is by **`student_id`** over every enrolment in force on each date, so a mid-year section
  or class change adds nothing and loses nothing; a date belongs to exactly one enrolment (slice 10
  §8.1).
- Rounding is half-up to one decimal, done once at the end. `100` and `0` are legitimate values of a
  non-empty set; `null` is the only answer for an empty one.

---

## 6. Alerts (R126, R168) — the lifecycle

### 6.1 The rows

`attendance_alerts (enrolment_id, student_id, date, kind, seq, due_at, status, cancel_reason,
created_at, updated_at)` (migrated), `attendance_alerts_natural_key UNIQUE (school_id, student_id,
date, kind, seq)`. Every outbound
attendance message has exactly one alert row as its subject: `messages.subject_type =
'attendance_alert'`, `subject_id = alert.id`, so R107's per-person unique makes the send idempotent
per alert row per guardian, and the reports read the row.

| `kind` | Message when sent | Created by | `due_at` |
|---|---|---|---|
| `absence` | `absence_alert` | a write that leaves the child's day **all-absent** and no live `absence` row exists (§6.2) | **today's register:** `max(now + 30 min, dayStart(today) + absenceAlertTime)`. **Any earlier date:** the row is inserted directly as `cancelled`, `cancel_reason = backdated`, `due_at = now` (R126: a backdated absence sends nothing; the parent sees it in the app) |
| `late` | `late_advice` | a write that gives the child's day a `late` period while the day is not all-absent, **only when `lateAdviceEnabled` is true at that moment**, and no `late` row exists for the day; or §6.4's absence branch | as `absence`; backdated → `cancelled:backdated` |
| `corrected` | `attendance_corrected` | a write that changes the child's day after an `absence` row is `sent` (§6.2), when no `corrected` row is `pending` and fewer than 3 exist | `now` |

`seq` is `1` except: an `absence` row created after an earlier one was `cancelled:mark_changed` (the
day went absent → not absent → absent again before anything was sent) takes `seq + 1`; `corrected`
rows take `1, 2, 3`. At most **3 `absence`** and **3 `corrected`** rows per child-day; a fourth is not
created and the write's audit metadata carries `correctionCapped: true` (§6.2 step 5).

**State machine** (`attendance_alerts_cancelled_check` ties `cancel_reason` to `cancelled`;
`attendance_alerts_status_final` refuses any change to a `sent` or `cancelled` row; `updated_at` is
the resolution time):

| From | To | By |
|---|---|---|
| (insert) | `pending` | the writer (§6.2), today's register |
| (insert) | `cancelled:backdated` | the writer, a past date |
| `pending` | `sent` | the processor (§6.4) |
| `pending` | `cancelled:mark_changed` | the writer when the day no longer matches the kind (§6.2); the processor at due time (§6.4) |
| `pending` | `cancelled:holiday` | the `CalendarListener` (§7) |
| `pending` | `cancelled:link_ended` | the processor: no eligible guardian at send time (§6.3) |
| `sent`, `cancelled` | — | terminal |

### 6.2 The writer's alert step — every mark write, inside the same transaction

After the mark statement, for each **child-day** `(student, date)` touched by a `created` or `amended`
mark (not `unchanged`), in `student_id` order:

1. **Lock** the child-day's alert rows: `SELECT … FROM attendance_alerts WHERE school_id AND
   student_id AND date ORDER BY id FOR UPDATE` (R126: the alert row is locked by both the sender and
   the amend path).
2. Re-read **every recorded period for that child on that date**, across every register and
   enrolment of that date; `day = deriveDayStatus(periods)`.
3. Find `A` = the latest-`seq` `absence` row, `L` = the `late` row, `C*` = `corrected` rows.
4. Apply, in order:

| Day now | `A` | Effect |
|---|---|---|
| all-absent (`day.status = absent`) | none, or `cancelled:mark_changed` | insert `absence` (`seq` = next; cap 3: a fourth is refused, `A.capped_at` stamped once and `correctionCapped` set) — `pending` with the §6.1 `due_at` for today, else `cancelled:backdated` |
| all-absent | `pending` or `sent` | nothing (the pending one will send; the sent one is still true) |
| all-absent | `cancelled:holiday` / `cancelled:backdated` / `cancelled:link_ended` | nothing (the day is settled) |
| **not** all-absent | `pending` | `cancelled:mark_changed` |
| not all-absent | `sent` and the latest `C` is not `pending` and `|C*| < 3` | insert `corrected` `seq = |C*| + 1`, `pending`, `due_at = now` |
| not all-absent | `sent`, a `C` `pending` | nothing — the pending correction will state the day as it is when sent (natural debounce) |
| not all-absent | `sent`, `|C*| = 3` | nothing sent; the latest `C` gets `capped_at` (written once; the one change a final row accepts, migration `20261004140000_slice11_alert_capped_at`); `correctionCapped: true` in the audit metadata; the reports show `correctionsCapped` |
| **back to** all-absent after a `sent` `A` | `sent` | the first row's rule does not apply (`A` is `sent`): a `corrected` row is inserted as above, stating `absent` — R126's "a reversal sends a further corrected notice" |
| any `late` period and not all-absent, `date = today`, `lateAdviceEnabled`, no `L`, no `A` `sent` | — | insert `late` `pending` with the §6.1 `due_at` |
| any `late` period, `date < today`, `lateAdviceEnabled`, no `L` | — | insert `late` as `cancelled:backdated` |
| no `late` period, `L` `pending` | — | `L` → `cancelled:mark_changed` |

A late arrival after the absence alert was sent is a **correction**, not a late advice (the deck's
"corrected notice after a late arrival at 10:00"): the `A sent` branch wins and no `late` row is
created. Known limitation, recorded as the plan does: present in period 1 and absent for the rest
derives `partial` and sends nothing (early departure is item 23's sibling).

### 6.3 Recipients, resolved at send time

Guardians of the child through **live** `student_guardians` rows (`ended_at IS NULL`) whose guardian
is not merged: those with `is_primary_contact`; if none, every one with `can_login` **or** a phone
(R126). `can_login` is not required: the alert travels by WhatsApp and SMS to a keypad phone (rule
17). Resolved **when the processor sends**, never stored on the row: an ended link simply is not
there (R164's "cancels that guardian's pending alerts" is met by this and by R107 — a message is
written per guardian only at send). No eligible guardian at send time → `cancelled:link_ended` (the
migrated value; it records that every link that could have carried the alert has ended or never
qualified). The student's own login never
receives an attendance message (`slice-9.md` §7.3: students get no WhatsApp, SMS or email, and the
attendance types address guardians).

### 6.4 The processor — queue `attendance`, job `attendance-alert`

Payload `{ schoolId, alertId }`, id `alert:<alertId>` (the sweep's recovery `alert:<alertId>:s<minute>`,
as `slice-9.md` §7.6), enqueued **after commit** with `delay = max(due_at − now, 0)`; `schoolId`
through `fromQueuePayload`; body in `runAsSchool`, one `@Transactional()`:

1. **Claim:** `SELECT … FROM attendance_alerts WHERE school_id = $1 AND id = $2 AND status = 'pending'
   AND due_at <= now() FOR UPDATE` (the first statement; zero rows → the job ends, nothing sent — a
   replay, a cancelled row or a not-yet-due sweep re-enqueue). Rows of the same child-day are then
   locked in id order too (same order as §6.2).
2. `!isTeachingDay(date)` → `cancelled:holiday` (a publish that raced the listener). Done.
3. Re-read the child's recorded periods for the date; `day = deriveDayStatus(…)`. Decide:

| `kind` | Condition | Action |
|---|---|---|
| `absence` | `day.status = absent` | **send `absence_alert`** → `sent` |
| `absence` | any period `late` | `cancelled:mark_changed`; if `lateAdviceEnabled` **now** and no `late` row exists: insert `late` as `sent` and **send `late_advice`** with it as subject |
| `absence` | otherwise (a `present` or `on_leave` period, or nothing recorded) | `cancelled:mark_changed` |
| `late` | any period `late` and `day.status ≠ absent` | **send `late_advice`** → `sent` |
| `late` | otherwise | `cancelled:mark_changed` |
| `corrected` | always | **send `attendance_corrected`** stating `day.status` (and the first late `arrivedAt`) as it is now → `sent` |

4. "Send" = recipients per §6.3 (none → `cancelled:link_ended`, nothing written) then
   `NotificationService.send(schoolId, { type, subject: { type: 'attendance_alert', id: alert.id },
   recipients: [{ guardianId }…], vars })`. The message jobs are enqueued after this transaction
   commits (slice 9). Worker transitions are not audited (no actor); the row is the record.

**Timing table** (deck's worked example; `absenceAlertTime = 09:30`):

| Register submitted | Child | `due_at` | At due |
|---|---|---|---|
| 08:00, absent | nothing else | 09:30 | `absence_alert` |
| 08:00, absent | arrival recorded 08:40 | 09:30 (`A` cancelled at 08:40; `L` pending 09:30) | `late_advice` (if enabled) |
| 08:00, absent | arrival 10:00 | sent 09:30 | `corrected` due 10:00 → "now marked late (arrived 10:00)" |
| 09:20, absent | — | 09:50 (`now + 30 min`) | `absence_alert` |
| 14:00, absent (afternoon register) | — | 14:30 | `absence_alert` |
| yesterday's register, absent | — | `cancelled:backdated` | nothing; the app shows the day |

### 6.5 Templates (English, school name first, one GSM-7 segment with the longest fixture values —
`templates.spec.ts`, R110)

Longest fixtures: school name 30, student name 40, `{class} {section}` 16 (longer values are cut
with `…` → `...` at a word boundary by the template, never by the sender). `TemplateVarsMap`
(`src/messaging/types.ts`) gains the four shapes; `templates.ts` replaces the four `notWritten`
entries. Vars never carry a phone, identity number or token (R111); the service supplies the school
name.

| Type | Vars | Body (push title in brackets) |
|---|---|---|
| `absence_alert` | `{ studentName, className, sectionName, date }` | `{school}: {studentName} ({class} {section}) is absent today, {Mon 6 Oct}. Contact the school if unexpected.` [`Absent today`] |
| `late_advice` | `{ studentName, className, sectionName, date, arrivedAt: 'HH:MM' \| null }` | `{school}: {studentName} ({class} {section}) arrived late today, {Mon 6 Oct}[ at {08:40}].` [`Arrived late`] |
| `attendance_corrected` | `{ studentName, className, sectionName, date, status: DayStatus, arrivedAt }` | `{school}: Correction for {studentName} ({class} {section}), {Mon 6 Oct}: now marked {present \| late (arrived {08:40}) \| late \| partly absent \| on leave \| absent}.` [`Attendance corrected`] |
| `register_unrecorded` (§8.4) | `{ date, deadlineTime: 'HH:MM', sections: [{ className, sectionName, coverStaffName \| null }] }` | title `Registers not recorded`; body `{school}: {n} register(s) not recorded by {10:00} on {Mon 6 Oct}: {Class 5 A (cover: Name)}, {Class 6 B}[, … (+{k} more)]` — the first 5 sections named; push and email only, so no segment limit, body ≤ 2,000 |

`partial` is written "partly absent" to a parent; "partial" is a screen word.

---

## 7. Holidays after the fact (R167) — the `CalendarListener`

`AttendanceModule` imports `CalendarModule` and registers `AttendanceCalendarListener` from
`onModuleInit` (`slice-10.md` §4.8). Inside the publish transaction, after the holiday row:

- `holidayPublished(schoolId, { startsOn, endsOn })`: lock every `attendance_alerts` row with `status =
  'pending' AND date BETWEEN startsOn AND endsOn` in id order; set `cancelled`, `cancel_reason =
  holiday`. Their delayed jobs find no `pending` row and end. **Nothing else is
  written:** registers and marks are kept (rule 4); `attendance_day_status` and
  `attendance_daily_summary` store nothing calendar-dependent, so the exclusion from every
  percentage and the console flag (`declaredHolidayAfter`, `teachingDay: false`) are computed at read
  from the current calendar (slice 10 §3: "nothing stored depends on the count"). The plan's and
  slice 10 §4.8's "bump the summary `version`" is therefore not needed and is not done — a bump would
  recompute identical rows.
- `holidayCancelled(…)`: **no write**. Days in the range are teaching days again at the next read; a
  day with no register shows as unrecorded (R129, live), never absent; alerts cancelled as `holiday`
  are not revived (the day has passed, or the pending set is empty for a future day).
- The deadline job (§8.4) skips non-teaching days by the same function.
- Phase 4 and anything reading `attendance_day_status` must apply `isTeachingDay` at read as this
  slice does; recorded in §12 for `data-architect` and in the module header.

---

## 8. Rollup, recompute, deadline — the worker side

### 8.1 Trigger (R131) — migrated

`attendance_marks_summary_bump_insert` and `_update` (statement-level, `REFERENCING NEW TABLE AS
changed_marks`, function `asms_attendance_summary_bump`) upsert one `attendance_daily_summary` row per
distinct section-day of the changed marks: insert with `version = 1`, else `version + 1`. Counts and
`registers_expected` keep their defaults (`0`) until the first recompute. No code path can forget it.

### 8.2 `attendance-rollup` — queue `attendance`, payload `{ schoolId, sectionId, date }`

Job id `att-rollup:<sectionId>:<YYYYMMDD>:<version>` (the version read in the writer's
transaction after its statement, so two writes in one minute collapse to one job per version),
enqueued after commit by every mark write. Body, one transaction per section-day:

1. Read the summary row's `version` → `v` (none → done).
2. For every enrolment with a mark in any register of `(section, date)`: `deriveDayStatus` over its
   periods → upsert `attendance_day_status (enrolment_id, student_id, section_id, date, status,
   periods_*, first_late_arrived_at, computed_at)` on `attendance_day_status_natural_key`
   (`first_late_arrived_at` = the `arrived_at` of the lowest-period `late` mark, or null — the
   column §5.2's `absent_after_cutoff` needs; §12 item 1).
3. `roster_count = |onRoster(section, date)|` (§3.1, no lock); `registers_recorded` = count of
   registers; `registers_expected` set **only while `0`** (frozen at first computation: `1` in daily
   mode, else `periodsPerDay` then); status counts from step 2.
4. `UPDATE attendance_daily_summary SET …, computed_version = v, computed_at = now() WHERE school_id
   AND section_id AND date AND version = v` — a write that landed meanwhile bumped `version`, the
   update matches nothing, and the next job (already enqueued by that write) recomputes. No lost
   update.

Rows of `attendance_day_status` are never deleted (marks are never deleted). Concurrency on the
`attendance` queue: 5.

### 8.3 Sweeps — `outbox-sweep` sources and the nightly job

`slice-9.md` §7.9 reserved two sources; this slice registers them with `DeliverySweeps.outboxSweep`
(per school, every 2 minutes, oldest first, ≤ 500 rows):

- `attendance_alerts` `pending` with `due_at <= now − 2 min` → enqueue `attendance-alert`
  (`alert:<id>:s<minute>`), index `(school_id, status, due_at)`;
- `attendance_daily_summary` with `computed_version <> version` → enqueue `attendance-rollup` for
  the row's current `version`. No age filter is needed: the job id carries the version, so a row
  whose own job is still pending collapses onto it, a row whose job was lost is recovered, and a row
  whose version moved on is enqueued under the new version — the same id its own write used. Partial
  index `(school_id, date) WHERE computed_version <> version` (§12 item 3).

`attendance-nightly-recompute`: repeatable on `scheduled`, **00:30 Asia/Karachi**, fan-out per live
school: every stale section-day (as above, no age filter) **plus every section-day of the last 7
days that has a summary row**, each through §8.2's body in its own transaction, 200 section-days
per school per run at most (the rest next night; logged as a count). This is the net under the
trigger-and-job path, as the plan requires; it never finds work when the path is healthy.

### 8.4 `register-deadline-sweep` (R129) — repeatable on `scheduled`, every 5 minutes

Fan-out per live school. For each: `today`, `deadline = dayStart(today) + registerDeadlineTime`. Skip
when `now < deadline`, when `!isTeachingDay(today)`, or when a `messages` row with `subject_type =
'register_deadline' AND subject_id = <YYYYMMDD of today>` exists (sent already; cheap EXISTS on the
`(school_id, subject_type, subject_id)` index). Otherwise the **unrecorded set**: every section
whose class's academic year covers `today`, with `|onRoster(section, today)| > 0` and **no
`attendance_registers` row for today at all** (anti-join on `(school_id, date, section_id)`). Period
mode's "unrecorded periods" needs a timetable and is not deliverable (plan §7); only "no register at
all" is. Empty set → nothing, and the next run re-evaluates (a section may gain its first enrolment
later that day). Non-empty → one transaction: `NotificationService.send(schoolId, { type:
'register_unrecorded', subject: { type: 'register_deadline', id: YYYYMMDD }, recipients, vars })`;
R107 makes a second run write nothing.

**Recipients (`register_watchers`):** staff users, active with a login, whose effective set holds
`attendance.student.mark` with `all` scope — candidates are users with a live `principal` or
`office_staff` role row, a live grant of the key, or a live custom role containing it; each is
confirmed with `PermissionsService.load` (revokes honoured). Teachers are never watchers (their key is
section-scoped). `vars.sections` lists each unrecorded section with its cover teacher's name when a
cover is active today (R129: "naming the sections and any cover teacher"). The console
(`GET /attendance-registers?date=today&recorded=false`) stays live; the push is not repeated.

### 8.5 Jobs at a glance (additions to `slice-9.md` §7.12)

| Queue | Job | Id | Payload | Trigger |
|---|---|---|---|---|
| `attendance` *(new, concurrency 5)* | `attendance-alert` | `alert:<alertId>` (sweep: `…:s<minute>`) | `{ schoolId, alertId }` | after commit, delayed to `due_at`; outbox sweep |
| `attendance` | `attendance-rollup` | `att-rollup:<sectionId>:<YYYYMMDD>:<version>` | `{ schoolId, sectionId, date }` (`date` zod `^\d{4}-\d{2}-\d{2}$`) | after commit; outbox sweep; nightly |
| `scheduled` | `register-deadline-sweep` | repeatable, 5 min | none (fan-out) | — |
| `scheduled` | `attendance-nightly-recompute` | repeatable, daily 00:30 Asia/Karachi | none (fan-out) | — |

`QUEUE.attendance` and the four `JOB` names join `src/messaging/queues.ts`; the runner gains an
`attendance(name, payload)` branch. Payload `date` is the only non-id field a payload may carry; it
is validated by pattern and resolved to a `DATE`.

---

## 9. Seams this slice fills

### 9.1 `AttendanceHistoryProbe` (`slice-10.md` §8.2 step 5)

`AttendanceModule` exports `MarkHistoryProbe extends AttendanceHistoryProbe` —
`lastRecordedOn(schoolId, enrolmentId) = MAX(date) FROM attendance_marks WHERE school_id AND
enrolment_id` (index `(school_id, enrolment_id, date, period)` — the natural key serves). `StudentsModule`
imports `AttendanceModule` and binds `{ provide: AttendanceHistoryProbe, useExisting: MarkHistoryProbe
}`, dropping `NoAttendanceHistory`. `409 ATTENDANCE_RECORDED_AFTER` `details: { lastRecordedOn }` on
section and class change goes live; its `it.todo` becomes a test. The probe runs under the student
lock the change already holds, and §1.6's `FOR SHARE` makes it exact.

### 9.2 Students, enrolments and `/me`

- `GET /students/:id/attendance` (`STUDENT_VIEW`, today's scope) — §10.4.
- The capacity scope of `slice-13.md` §1.2 (§1.4 here), built by whichever slice lands first.
- `MeModule` gains `MeAttendanceController` for the two `/me` routes; `CalendarModule`'s pattern
  (`@Controller('me')`, `MeReadsThrottleGuard`). The R68 snapshot gains the two `@RequireCapacity`
  routes and asserts they live under `/me/children/` and `/me/student/`.

---

## 10. Reads

### 10.1 `GET /attendance-registers` — paginated (R129's console)

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `date` | **required** date, `≤ today` |
| `classId`, `sectionId` | optional ids; unknown → empty page |
| `recorded` | optional `QueryBoolean` |
| `sort` | `className` (default), `sectionName`, `-registersRecorded`; `id` (section) tiebreak |

Rows: every section (archived included) of a class whose academic year covers `date`, with
`rosterCount > 0`, inside the caller's today's scope (`sections` kind filters `section_id`), left-joined
to a **live** count and the earliest row of `attendance_registers` for the date, the class-teacher and
cover assignments active on the date. The summary table is not read here: the console must be live,
and the live join is one date. **200** `{ data: SectionDayDto[], page, limit, total }`. The principal's
tile is `?date=today&recorded=false`.

### 10.2 `GET /attendance-reports/daily-summary` — paginated

| Param | Rules |
|---|---|
| `dateFrom`, `dateTo` | required dates, `dateTo ≥ dateFrom`, `dateTo − dateFrom ≤ 91` (≤ 92 days) → `422` on `dateTo` |
| `classId`, `sectionId` | optional |
| `sort` | `-date` (default), `date`, `className`; then `sectionName`, section `id` |

From `attendance_daily_summary` (R131), today's scope. **200** `{ data: DailySummaryDto[], … }`.
`stale: true` rows are shown with their `computedAt`.

### 10.3 `GET /attendance-reports/absentees`, `GET /attendance-reports/late` — paginated

| Param | Rules |
|---|---|
| `date` | required, `≤ today` |
| `classId`, `sectionId` | optional |
| `status` | `/absentees` only: optional `absent \| partial \| on_leave`; absent = all three |
| `sort` | `className` (default; then `sectionName`, `rollNo` nulls last, `fullName`), `rollNo`, `fullName`; `enrolmentId` tiebreak |

From `attendance_day_status` for the date joined to the roster rows and the alert rows: `/absentees`
lists derived `absent`, `partial` and `on_leave` (the `status` column says which); `/late` lists
derived `late`. `arrivedAt` is the first late period's. Rows lag writes by up to a minute (R131);
the register view is the live source. **200** `{ data: AbsenteeRowDto[], … }`.

### 10.4 `GET /students/:id/attendance`, `GET /me/children/:id/attendance`, `GET /me/student/attendance`

| Param | Rules |
|---|---|
| `dateFrom`, `dateTo` | required dates, `dateTo ≥ dateFrom`, `dateTo − dateFrom ≤ 365` (≤ 366 days) → `422` on `dateTo`; `dateTo` may be in the future (the days are `enrolled: false`/unrecorded) |

`:id` in scope (`slice-6.md` §1 for staff; §1.4 for a guardian; the session's student for
`/me/student`) → else `404`. Reads `attendance_day_status` by `(school_id, student_id, date)`, the
student's enrolments overlapping the range, and the calendar for the range; builds §5.3's input and
returns **200** `StudentAttendanceDto` — the same DTO on all three routes. It carries no note, no
teacher, no other student, no section roster, no alert state (R165). A guardian sees a child whose
status is no longer `active` while the link is live (R164). A bounded object, not a page.

### 10.5 `GET /attendance-reports/percentage` — paginated

| Param | Rules |
|---|---|
| `dateFrom`, `dateTo` | as §10.4 |
| `classId`, `sectionId` | optional, applied to the **current active** enrolment |
| `below` | optional integer 0–100: rows with `percentage < below` (null percentages excluded) |
| `sort` | `percentage` (nulls last), `-percentage` (nulls last), `fullName`, `className` (then `sectionName`, `rollNo`); `studentId` tiebreak |

One query computes §5.2–§5.3 **in SQL** per student over `attendance_day_status` for the range
(`CASE` on status and the three settings; teaching-day exclusion by `EXTRACT(dow)` against
`weekly_off_days` and an anti-join on published holidays; `countedDays`, `teachingDays` from the
enrolment ranges), scoped to students with an active enrolment in the filter. A property test asserts
the SQL and the shared function agree on seeded data. Students: those `active` or `suspended` now
(the report is "who is below 75 %", a live question). **200** `{ data: PercentageRowDto[], … }`. CSV
is Phase 5.

---

## 11. Error codes and audit actions

### 11.1 Error codes

All of this slice's codes were added by the groundwork (`error-codes.ts`): `NOT_A_TEACHING_DAY` 409 ·
`ATTENDANCE_LOCKED` 409 (`details: { date, windowDays }`) · `AMENDMENT_REASON_REQUIRED` 409
(`details.amendments`) · `ROSTER_INCOMPLETE` 422 (`details.missing`) · `STALE_STATUS` 409
(`details.currentStatus`) · `ARRIVAL_NOT_ABSENT` 409 (`details.status`, null when unrecorded) ·
`ATTENDANCE_RECORDED_AFTER` 409 (live from this slice, `details.lastRecordedOn`). Reused:
`PERMISSION_DENIED` with `details.reason = 'subject_teacher_daily_mode'` *(new reason value, added to
the reason union)*, `REFERENCE_NOT_FOUND`, `INVALID_VALUE`, `CONCURRENT_UPDATE`, `NOT_FOUND`. **No new
code.**

### 11.2 Audit actions (school `audit_log`)

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `attendance_register.submitted` | attendance_register | — | `{ sectionId, date, period, mode, marks, source }` |
| `attendance_register.amended` | attendance_register | required when `amended > 0`, else as given | `{ date, period, created, amended, afterWindow, correctionCapped, source }` |
| `attendance_mark.amended` | attendance_mark | required | `{ enrolmentId, studentId, date, period, from, to, noteChanged, afterWindow, correctionCapped }` |
| `attendance_mark.arrival_recorded` | attendance_mark | — (the automatic reason is on the change row) | `{ studentId, date, period, arrivedAt, afterWindow }` |

Not audited: reads; the alert processor, the rollup, the sweeps and the deadline job (no actor;
rows and messages are the record); an identical replay. No metadata carries a name, a note or a
phone number.

---

## 12. For `data-architect` — the slice-11 migration over the shipped groundwork

The seven tables, their enums, natural keys, the history trigger (`asms_record_change`, refusing
`attendance_mark_changes_actor_required` / `_reason_required`), the summary-bump triggers, the
`status_final`, immutable-column, no-delete and `school_id` triggers all exist
(`20261004120000_phase2_attendance_diary`). This slice adds **one migration** with:

1. `attendance_day_status.first_late_arrived_at time(0)` nullable — the arrival time of the
   lowest-period `late` mark, written by the recompute (§8.2). Without it `absent_after_cutoff`
   (§5.2) cannot be computed from the table, and the plan forbids reading raw marks for the
   percentage. Not in the immutable list (recomputed in place like the counts).
2. `attendance_mark_changes.old_arrived_at time(0)`, `new_arrived_at time(0)` nullable, and
   `attendance_marks_history` re-created with `'status', 'note', 'arrived_at'` as its tracked
   columns — a change to the arrival time is a correction of record and takes the same reason. (The
   generic trigger's `old_/new_<col>` convention makes this two columns and one argument.)
3. Partial index `attendance_daily_summary_stale_idx (school_id, date) WHERE computed_version <>
   version` for §8.3's sweep source and the nightly job.
4. Nothing else changes: `registers_expected` stays `NOT NULL DEFAULT 0` (`0` = not yet computed,
   §2.2); `attendance_alerts` keeps `updated_at` as its resolution time and `link_ended` as the
   migrated reason value (meaning fixed in §6.3); `seq` keeps `CHECK (seq >= 1)` and the cap of 3 is
   the service's (a database cap would need a per-day count); `attendance_arrivals` keeps no unique
   on `mark_id` (a reversal and a second arrival are possible).
5. Table comment on `attendance_day_status`: readers (Phase 4 report cards included) must apply the
   school calendar at read — nothing stored says whether the date is a teaching day (§7).
6. The `students` scope kind and `first_late_arrived_at`'s consumer are code; `data-architect`
   reviews the SQL of items 1–3 before it is generated (plan §5).

---

## 13. Web and app screens → endpoints

Write controls render only when `GET /me` lists the capability and the view says `canSubmit`; a
`403` still shows the no-permission state.

| Screen | Calls | Behaviour |
|---|---|---|
| Register (web and app) | `GET /sections/:id/register?date&period`, `POST /sections/:id/submit-register` | Section from `/me` assignments; date defaults to today, period picker in period mode (hidden in daily); one row per child, keyboard P/A/L/O; shows "recorded by X at HH:MM" and "amended by Y"; `amendable: false` → read-only with the reason ("window closed", "holiday", "no permission"); amendments open the shared confirm-with-reason; `AMENDMENT_REASON_REQUIRED` lists the diffs as "changed since you loaded"; the app writes offline and coalesces by `(section, date, period)` (plan §4.7) |
| Arrival dialog (web; office) | `POST /attendance-arrivals` | Student search, time (default now); `ARRIVAL_NOT_ABSENT` → "X is marked {status} today — amend the register instead" |
| Mark history | `GET /attendance-marks/:id/changes` | Drawer from a mark cell |
| Principal console tile | `GET /attendance-registers?date=today&recorded=false` | "N registers not recorded" with cover names; "Record" opens the register as `all` scope; "Arrange cover" (slice 10) |
| Unrecorded / registers list | `GET /attendance-registers` | Filters date, class, section, recorded; flag "recorded on a day later declared a holiday" |
| Section summary | `GET /attendance-reports/daily-summary` | Per section-day counts; `stale` shows "updating…" |
| Student → Attendance tab | `GET /students/:id/attendance` | Calendar heat map (`days[]`), "{percentage}% — {countedDays} recorded of {teachingDays} teaching days", "no recorded days" when null |
| Reports | `/absentees`, `/late`, `/percentage` | Date or range, class, section, `below`; alert column from `alert` ("told 09:31", "pending 09:30", "cancelled: arrived", "backdated", "corrected ×2", "corrections capped") |
| App — guardian child screen (slice 16) | `GET /me/children/:id/attendance` | Heat map and percentage; no notes, no teacher |
| App — student "my attendance" (slice 16) | `GET /me/student/attendance` | Same |
| Settings | `GET\|PATCH /school/settings` (slice 9) | Window, deadline, alert time, late advice, late/leave rules — unchanged screen |

---

## 14. Tests this contract adds

R118 (write on weekly-off and on a published holiday → `409`; read → `teachingDay: false`) · R119
(first submit missing one → `ROSTER_INCOMPLETE`; subset later; `201` then `200`; `submitted_by` vs
`last_amended_by`) · R120/R175 (named: subject teacher daily → `403 subject_teacher_daily_mode`;
subject teacher period → ok; cover inside dates → ok, day after → `403 not_assigned_on_date`; row starting after the date →
`403 not_assigned_on_date`; a section never assigned → `404`; principal and office → ok; `VIEW_ALL` only → read ok, submit `403` at the decorator) · R121
(daily period 2 → `422`; period > `periodsPerDay` → `422`; read of period 10 after the setting dropped
to 8 → `200`) · R122 (change without reason → `409` with the list; a direct `UPDATE` without
`set_config` refused by the database; note-only change is an amendment) · R123 (teacher after window
→ `ATTENDANCE_LOCKED` on submit, amend and arrival; principal after window → `200`, `afterWindow:
true` audited; first submit after the window by a teacher → locked) · R124 (future, outside year,
non-roster enrolment, all-or-nothing; suspended-from-the-10th on the 9th and 10th; exit's
`effectiveOn` still on roll; moved child's old register still amendable with `onRoster: false`) ·
R125 (identical replay `200` no history after the window; `STALE_STATUS`; same-status amend `200`;
two teachers concurrently: one `201`, the other `409 AMENDMENT_REASON_REQUIRED` naming the diffs, no
duplicate marks) · R126 (every row of §6.2 and §6.4; the timing table; alert sent exactly once under a
replayed job; arrival at 08:40 cancels and `late_advice` at 09:30 only when enabled; arrival at 10:00
→ `corrected`; reversal → `corrected seq 2`; three sent is not capped, a refused fourth sets
`correctionsCapped` and the guardian has exactly four messages; a fourth `absence` row is refused the
same way; backdated →
`cancelled:backdated`, nothing sent; primary contacts, else login-or-phone; keypad parent gets SMS;
`smartphone_data` without a device gets SMS; no live link → `cancelled:link_ended`) · R127 (the §5.1 table,
every combination over 1–3 periods) · R128 (the §5.2 and §5.3 tables over every status × mode ×
setting; zero counted → null; holiday declared after → excluded; SQL vs shared function property
test) · R129 (deadline job: before/after time, non-teaching day skipped, once per day, watchers =
principal + office + grantee − revokee, cover named) · R130 (teacher reads only scope; guardian only
linked `can_login` children, ended link gone next request; student only self; `view_all` everything;
every `/me` DTO field scanned for notes and names) · R131 (trigger bumps `version` per section-day on
insert and update; rollup within a minute sets `computed_version`; a write during recompute leaves it
stale and the next job catches it; nightly recomputes stale and last 7 days) · R167 (publish over a
recorded day cancels pending alerts with `holiday`, keeps registers, flags the console, excludes the
day; cancel restores the denominator and shows unrecorded) · R168 (arrival on first-absent → `late` +
reason + arrivals row; on present/late/none → `409`; replay `200`; second absent period stays, day
`partial`) · R174 (`ATTENDANCE_RECORDED_AFTER` live: change dated on or before a mark refused; the
race through `FOR SHARE`) · isolation tests for the six tables · `attendance_marks` natural-key
conflict mapped · payload with another school's `alertId` touches nothing · templates fit one segment.

Playwright: class teacher records; office records an arrival; principal amends after the window with
a reason; parent view (web impersonation is not a thing — the guardian route is tested through the
API) shows the corrected day.

---

## Decisions made here

1. **The amendment window bounds every section-scoped write** (first submit, subset, amend,
   arrival), not amendments alone; an identical replay is always `200`; `all` scope is never locked
   and is audited `afterWindow`.
2. **`ended_on` is the last day in force everywhere**: an exit's `effectiveOn` is the child's last
   day on roll (slice 10 §8.3's open question), matching the section change's `effectiveOn − 1`.
3. **Suspension is read from `student_status_changes` by date** (`statusOn`), not from the current
   status, so past rosters are stable.
4. **A subject teacher in daily mode is `403 PERMISSION_DENIED` with `details.reason =
   'subject_teacher_daily_mode'`**; a caller assigned to the section on another date but not on the
   register's is `403 PERMISSION_DENIED` with `details.reason = 'not_assigned_on_date'` (main-thread
   ruling 2026-10-04, as `slice-13.md` decision 13); a section never in the caller's assignments
   stays `404`.
5. **Students are locked `FOR SHARE` during a submit** so the section/class-change probe
   (`ATTENDANCE_RECORDED_AFTER`) is exact; lock order students → registers → marks → alerts →
   messages.
6. **The register row is created with `ON CONFLICT DO NOTHING` then locked**, which serialises
   racing teachers; the loser sees the winner's marks as `AMENDMENT_REASON_REQUIRED`.
7. **A submit item is the complete intended mark** (`note` absent = none); the amend route keeps
   PATCH semantics (absent = unchanged, `null` clears). `arrivedAt` is allowed only on `late`.
8. **Every outbound attendance message has an `attendance_alerts` row as its subject**, including
   `late` and `corrected`; the writer only creates and cancels rows, the processor is the only
   sender; `corrected` rows are due at once, `absence` and `late` at `max(now + 30 min,
   absenceAlertTime)`; a `pending` correction debounces further changes; caps of 3 on `absence` and
   `corrected` rows, with `correctionCapped` in the audit and `correctionsCapped` in the reports
   once a fourth was refused (review fix 2026-10-04: stored as `attendance_alerts.capped_at`).
9. **A `late` row is created only when `lateAdviceEnabled` at that moment** and sent regardless at
   due time (no `disabled` cancel reason; the window is under two hours).
10. **`link_ended` is kept as migrated and means "no eligible guardian at send time"**: recipients
    are resolved when the processor sends, so an ended link needs no cancellation of its own, and
    the only thing left to record is that nobody remained to tell.
11. **A `[present, late]` day derives `present`** — the plan's rule 4 applied literally and tested
    as such; a partial day counts `on_leave` periods as not present whatever `leaveCountsAs` says.
12. **The holiday listener cancels pending alerts and writes nothing else**: no summary bump,
    because nothing stored depends on the calendar; exclusion and the console flag are computed at
    read. `holidayCancelled` is a no-op. Phase 4 must apply the calendar at read too.
13. **`GET /attendance-registers` reads registers live**, not the summary: the console must not lag
    the push; `SectionDayDto` gains `rosterCount`, `classTeacherName`, `coverStaffName`.
14. **`/absentees` lists `absent`, `partial` and `on_leave`** (filterable), `/late` lists `late`;
    both from `attendance_day_status` and may lag a minute.
15. **`StudentAttendanceDto` carries no `note` and no `mode`** on any route; `days[]` is one entry
    per calendar date with `teachingDay`, `enrolled`, `status`, `value`, `periods`; the staff route
    and the two `/me` routes return the identical shape.
16. **Guardian and student scope follow `slice-13.md` §1.2** (shared wave-E groundwork: the
    `students` scope kind bound by `RouteAccessGuard`, `MeDto.children`); whichever slice lands
    first builds it, and this contract adds nothing of its own to it.
17. **The deadline job is a 5-minute sweep**, idempotent by R107's subject `register_deadline /
    YYYYMMDD`, sent once at the first run past the deadline that finds an unrecorded section;
    watchers are confirmed through `PermissionsService.load`.
18. **Rollup jobs are versioned** (`att-rollup:<section>:<date>:<version>`) and the recompute's final
    update is conditional on `version`; the outbox sweep recovers stale rows; the nightly job
    recomputes stale plus the last 7 days.
19. **No new error code**; `PERMISSION_DENIED` gains one reason value. `ARRIVAL_NOT_ABSENT` carries
    `details.status` (null when nothing is recorded).
20. **One small migration over the shipped groundwork** (§12): `attendance_day_status.
    first_late_arrived_at` (the cutoff rule cannot be computed without it), arrival-time tracking in
    `attendance_mark_changes`, and the stale-summary partial index. `registers_expected` stays
    `0` until first computed; alerts use `updated_at` as their resolution time.
