# Slice 10 contracts — calendar, holidays, cover teacher, section-change history

**Author:** api-designer, 2026-10-03. **Binds:** `apps/api/src/modules/calendar/**` (new),
`modules/people/staff/teacher-assignments.*` (cover), `modules/access/permissions.service.ts` and
`repositories/teacher-assignment.repository.ts` (dated scope), `modules/people/students/enrolments.*`
(section and class change), `packages/shared/src/calendar.ts` (new), `apps/web/app/(school)/calendar/**`,
the assignments and enrolments tabs. **Sources:** `CLAUDE.md` (rules 2, 3, 4, 6, 13, 14, 16),
`phase-2-daily-operations.md` §4.2, §4.4, §4.5, §5 "Calendar", §6 slice 10, R116–R118, R132, R167,
R174, R175; `slice-4.md` §1, §4 (assignments — amended here); `slice-6.md` §5 (enrolments — amended
here). Everything not restated follows §3.9 of the Phase 1 plan, `slice-1.md` (envelope, `422
VALIDATION_FAILED` with `details.fields`, string ids, camelCase, `NoQueryDto`, `@ApiErrors()`,
`@IdParam()`) and `slice-2.md` §1 (access decorators). `GET|PATCH /school/settings` is
`contracts/slice-9.md`'s; §9 here states only what slice 10 relies on. Paths are under `/api/v1`.
Dates are `YYYY-MM-DD` calendar dates in the school's timezone (R53); "today" is `SchoolClock.today`.

---

## 1. Access

| Route | Decorator |
|---|---|
| `GET /holidays`, `GET /holidays/:id`, `GET /calendar/teaching-days` | `@RequireStaff()` |
| `POST /holidays`, `PATCH /holidays/:id`, `POST /holidays/:id/publish`, `POST /holidays/:id/cancel` | `@RequireCapability(HOLIDAY_MANAGE)` |
| `GET /me/calendar` | `@AuthenticatedOnly()` (any live session: staff, guardian or student), R166's `me-reads` throttle |
| `POST /staff/:id/teacher-assignments` (`role: cover`) | `@RequireCapability(CLASS_MANAGE)` — unchanged from `slice-4.md` §1 |
| `POST /enrolments/:id/change-section`, `/change-class` | `@RequireCapability(ENROLMENT_MANAGE)`, scoped — unchanged from `slice-6.md` §1 |

**One-sentence rules.** Any active staff member may read the school calendar; only a
`holiday.manage` holder may write it; anyone signed in may read the published calendar of their own
school; only a `class.manage` holder may assign cover; only an `enrolment.manage` holder whose scope
covers the enrolment may move it.

**Drafts are not public to staff.** A caller without `holiday.manage` never sees a `draft`: the list
filters it out in the query and `GET /holidays/:id` on a draft is `404`. A draft is a plan, and a
teacher who sees "Winter break 22 Dec" in a draft will tell parents.

Common errors on every route: `401 AUTH_REQUIRED` · `403 PERMISSION_DENIED` · `403 ORIGIN_REJECTED`
(cookie non-GET) · `426 UPGRADE_REQUIRED` (bearer, R161) · `429`. `SCHOOL_SUSPENDED` no longer occurs
(slice 9 lifts R80). Every `:id` resolves in the session's school only; absent, malformed or
another school's → `404 NOT_FOUND`.

**Text normalisation** (holiday `name`, `description`, every `reason`): trim, collapse internal
whitespace runs to one space, reject control characters, and **refuse an identity-number pattern
or a phone-number pattern** (`422 INVALID_VALUE`). The name reaches every guardian's phone in the
notice body, and R111's scanner (with the slice-9 phone pattern) runs over `messages`.

---

## 2. Shapes

Enums (`packages/shared`, groundwork): `HolidayKind` `public | school` · `HolidayStatus` `draft |
published | cancelled` · `TeacherRole` gains **`cover`** → `class_teacher | subject_teacher | cover`
(the database value is added in its own migration, `phase-2` §5).

`HolidayDto`:

| Field | Type |
|---|---|
| `id` | string |
| `startsOn`, `endsOn` | date (`endsOn` = `startsOn` for a single day) |
| `name` | string, 1–100 |
| `description` | string \| null |
| `kind` | `HolidayKind` — informational; both kinds count the same for R116 |
| `appliesToStaff` | boolean — `false`: a teaching holiday on which staff still work (Phase 3 payroll, R136) |
| `status` | `HolidayStatus` |
| `publishedAt` | datetime \| null |
| `publishedBy`, `publishedByName` | string \| null — user id and that user's staff name |
| `cancelledAt` | datetime \| null |
| `cancelledBy`, `cancelledByName` | string \| null |
| `cancelReason` | string \| null |
| `announcementId` | string \| null — **always `null` until slice 14** (§4.7) |
| `createdAt`, `updatedAt` | datetime |

`TeachingDaysDto`: `dateFrom`, `dateTo` (date), `teachingDays` (integer), `weeklyOffDays`
(integer[] ascending, 0 = Sunday … 6 = Saturday), `holidays` (`[{ id, startsOn, endsOn, name, kind
}]` — published holidays overlapping the range, whole rows, ascending by `startsOn`).

`MyCalendarDto`: `dateFrom`, `dateTo`, `weeklyOffDays`, `holidays` (`[{ startsOn, endsOn, name, kind
}]` — published only; no id, no description, no actor).

`TeacherAssignmentDto` (`slice-4.md` §2) gains, additively: `coversAssignmentId` (string | null)
and `coversStaffFullName` (string | null — the covered class teacher's name). `role` may now be
`cover`.

`SectionChangeResultDto` (new, also returned by change-class from this slice, §8.3): `{ closed:
EnrolmentDto, opened: EnrolmentDto }`.

---

## 3. Teaching days — the function (R116)

**Definition.** For a school with weekly-off set `W` (`school_settings.weekly_off_days`) and the
set `H` of its `published` holidays:

```
weekday(d)          = 0..6, Sunday = 0 (the DATE's UTC day: dates carry no time zone)
isTeachingDay(d)    = weekday(d) ∉ W  and  no h ∈ H with h.startsOn ≤ d ≤ h.endsOn
teachingDays(a, b)  = |{ d : a ≤ d ≤ b, isTeachingDay(d) }|
isStaffWorkingDay(d)= weekday(d) ∉ W  and  no h ∈ H with h.appliesToStaff and h.startsOn ≤ d ≤ h.endsOn
```

- Only `published` holidays count. A `draft` changes nothing; a `cancelled` one changes nothing.
- A holiday on a weekly-off day changes nothing (a set difference, not a subtraction of counts) —
  a public holiday on a Sunday is not counted twice.
- `kind` does not matter. `appliesToStaff` matters only to `isStaffWorkingDay` (R136, slice 12).
- The current `W` applies to every date, past included. Nothing stored depends on the count: the
  attendance denominator is the student's recorded days (R128), so changing `W` rewrites no row and
  affects R118 and R129 from the next evaluation only (R116). `teachingDays` over a past range is
  therefore informational, and the screen says so.

**Where it lives.** The pure functions are in `packages/shared/src/calendar.ts` over `YYYY-MM-DD`
strings and a `{ weeklyOffDays: number[]; holidays: { startsOn; endsOn; appliesToStaff }[] }`
value, so the web month view, the app and the API compute the same answer. The API's
`CalendarService` (exported by `CalendarModule`) loads that value and offers:

| Method | Used by |
|---|---|
| `calendar(schoolId, from, to)` → the value above for the range (settings read + one holiday query `status = 'published' AND starts_on <= to AND ends_on >= from`) | §5 reads |
| `isTeachingDay(schoolId, date)` | slice 11 R118 (`409 NOT_A_TEACHING_DAY`), R129's deadline job |
| `isStaffWorkingDay(schoolId, date)` | slice 12 R136 |
| `nextTeachingDay(schoolId, after)` (bounded to 400 days; `null` beyond) | the notice's "reopens" date (§4.7) |

---

## 4. Holidays

**Transitions:** `draft → published` (publish), `draft | published → cancelled` (cancel).
`cancelled` is final. A wrong date on a published holiday is cancel plus a new holiday, never an
edit (R117; the database freezes `starts_on`, `ends_on`, `kind`, `name` once published).

**No overlap among live holidays.** `holidays_live_excl` (exclusion over `daterange(starts_on,
ends_on, '[]')` where `status <> 'cancelled'`) refuses any overlap with a draft or published
holiday. A public holiday inside a vacation is not a second row: the vacation already covers it.
The constraint maps to `409 HOLIDAY_DATES_TAKEN` `details: { holidayId }` — the conflicting row's
id, read **outside** the aborted transaction in a fresh statement (oldest overlapping live row);
the in-transaction pre-check answers the same, so the race loser and the ordinary refusal are
indistinguishable.

### 4.1 `GET /holidays` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `dateFrom`, `dateTo` | optional dates; holidays **overlapping** the range (`ends_on >= dateFrom`, `starts_on <= dateTo`); either alone is open-ended; `dateTo < dateFrom` → `422` on `dateTo` |
| `status` | optional `HolidayStatus`; `draft` from a caller without `holiday.manage` → empty page (filtered in the query, never `403`) |
| `kind` | optional `HolidayKind` |
| `sort` | `startsOn` (default), `-startsOn`; `id` tiebreak |

**200** `{ data: HolidayDto[], page, limit, total }`. A month of the calendar view fits one page at
`limit=50` (at most 31 non-overlapping rows can touch a month).

### 4.2 `GET /holidays/:id` — `HolidayDto`. Draft without `holiday.manage` → `404`.

### 4.3 `POST /holidays`

| Field | Rules |
|---|---|
| `startsOn` | required date, real calendar date, within today − 366 days … today + 731 days (a typo guard) |
| `endsOn` | optional date, default `startsOn`; ≥ `startsOn`; span ≤ 366 days (`endsOn − startsOn ≤ 365`) — `422` on `endsOn` |
| `name` | required, 1–100, normalised (§1) |
| `description` | optional, 0–500, normalised; `''` and `null` both store `null` |
| `kind` | required `HolidayKind` (no default: the office chooses) |
| `appliesToStaff` | optional boolean, default `true` |

Past dates are allowed (an emergency closure recorded the next morning). Created `draft`; sends
nothing; calls no listener. **201** `HolidayDto`. Errors: `422` · `409 HOLIDAY_DATES_TAKEN`.
Retry-safety: a resubmit of the same range is `409 HOLIDAY_DATES_TAKEN` naming the first row,
which the web treats as "already created" and opens.

### 4.4 `PATCH /holidays/:id`

Fields as create; absent = unchanged; `null` on `startsOn`, `endsOn`, `name`, `kind`,
`appliesToStaff` → `422`; `description: null` clears. Date rules are checked on the merged result.
Holiday row locked (`readLocked` as every slice).

| Status | What may change |
|---|---|
| `draft` | everything |
| `published` | `description` and `appliesToStaff` only. `startsOn`, `endsOn`, `name` or `kind` present **with a value different from the stored one** → `409 HOLIDAY_NOT_DRAFT` (the same value is accepted as unchanged, so a form that resends every field works) |
| `cancelled` | nothing: any differing field → `409 HOLIDAY_NOT_DRAFT` |

New dates overlapping another live holiday (itself excluded) → `409 HOLIDAY_DATES_TAKEN`. Optimistic
retry then `409 CONCURRENT_UPDATE`. **200** `HolidayDto`. Audit `holiday.updated { changes }` only
when something changed. Editing `appliesToStaff` on a published holiday sends nothing and calls no
listener (it does not change teaching days).

### 4.5 `POST /holidays/:id/publish` — empty body

In one `@Transactional()`, in this order:
1. Lock the holiday row. `published` → **200**, unchanged, no audit, nothing sent (retry-safe).
   `cancelled` → `409 ILLEGAL_STATUS_TRANSITION` `details: { from: 'cancelled', to: 'published' }`.
2. Set `status = published`, `published_at = now`, `published_by = caller`.
3. **R167 hook:** call every registered `CalendarListener.holidayPublished` (§4.8), sequentially.
4. **Notice (R117):** if `endsOn ≥ today`, write the `holiday_notice` messages (§4.7). A holiday
   wholly in the past is published without a notice: telling families that the school was closed
   last Tuesday is noise, and the closure still reaches every percentage through R116.
5. Audit `holiday.published`.

Jobs are enqueued after commit (slice 9). **200** `HolidayDto`.

### 4.6 `POST /holidays/:id/cancel`

`{ reason: TextField(3, 500) }`, normalised (§1).

1. Lock the holiday row. `cancelled` → **200**, unchanged, no audit.
2. From `draft`: set `status = cancelled`, `cancelled_at/by`, `cancel_reason`. Nothing is sent, no
   listener is called. The dates are free again.
3. From `published`, additionally, in the same transaction:
   - **R167 hook:** `CalendarListener.holidayCancelled` (§4.8).
   - **Unsent notices are withdrawn:** one statement `UPDATE messages SET status = 'suppressed',
     suppressed_reason = 'subject_cancelled', finished_at = now() WHERE school_id = $1 AND
     subject_type = 'holiday' AND subject_id = $2 AND status = 'queued'`. The processor's claim is
     `… AND status = 'queued'` (R105), so each queued notice is either withdrawn here or already
     claimed — never both, never neither.
   - **Cancellation:** if `endsOn ≥ today`, one `holiday_notice` with subject `holiday_cancellation`
     (§4.7) to **every person whose notice was not withdrawn** (status other than `suppressed` with
     `subject_cancelled`) — exactly the people who were or may have been told, and nobody else.
4. Audit `holiday.cancelled`.

**200** `HolidayDto`.

### 4.7 The notice — wave D path, no announcement row

The `announcements` table arrives in slice 14, after this slice. Until then **publish writes the
`holiday_notice` messages directly through `NotificationService.send`** and leaves
`holidays.announcement_id` null. When slice 14 lands, publish switches to creating the announcement
(R151: `holiday_id` set, category `holiday`, audience `everyone`) and its messages; **slice 14
backfills nothing** — holidays published before it keep `announcement_id = null` and their
messages keep `subject_type = 'holiday'`. A pre-slice-14 holiday cancelled after slice 14 still
uses §4.6 step 3 (its notices have no announcement to cancel). The inbox renders a message by its
own `body`, so both kinds read the same to a parent.

| | Notice | Cancellation |
|---|---|---|
| `type` | `holiday_notice` | `holiday_notice` (same type, so a school that allows the notice by SMS also gets the correction by SMS) |
| `subject` | `{ type: 'holiday', id: holidayId }` | `{ type: 'holiday_cancellation', id: holidayId }` |
| Recipients | resolved at publish (below) | the persons of §4.6 step 3, from the notice rows |
| Template vars | `schoolName`, `name`, `startsOn`, `endsOn`, `reopensOn` (`nextTeachingDay(endsOn)`, omitted when `null`) | `schoolName`, `name`, `startsOn`, `endsOn` |

R107's partial uniques on `(school_id, subject_type, subject_id, <person>)` make each idempotent:
one notice and at most one cancellation per person per holiday.

**Recipients at publish**, one row per person (R107), resolved in the query:
- **Guardians**: not merged, with at least one live `student_guardians` row (`ended_at IS NULL`) to
  a student whose status is `active` (R164: no new notices for a child who has left). `can_login`
  does not matter — the notice travels by WhatsApp and SMS. A guardian with three children is one
  row.
- **Staff**: `status = active`, login or not.
- **Students**: `active`, with a login and `student_login_enabled` — in-app only (§4.2 of the plan).
- **Dedupe by user**: a staff member whose login also carries a guardian that is in the guardian set
  receives only the guardian row (R145's principle: one person, the guardian plan). Wave D dedupes
  by user only; slice 14's resolver adds identity-hash and phone dedupe for announcements.

Routing, the SMS allow list, the cap and suppressions are `NotificationService`'s (`slice-9.md`);
this contract names the recipients and the subject only. Templates (English, school name first,
one GSM-7 segment with the longest fixture values, the holiday name truncated with `...` to fit):

- Notice: `{schoolName}: School closed {Mon 6 Oct}[ to {Fri 10 Oct}] for {name}. Reopens {Mon 13 Oct}.`
- Cancellation: `{schoolName}: The holiday on {Mon 6 Oct}[ to {Fri 10 Oct}] ({name}) is cancelled. School is open as normal.`

**Size.** A publish writes one row per recipient inside the publish transaction (≈ 2,000 for a
large school). `NotificationService.send` must insert set-based (`createMany` or `INSERT … SELECT`
per recipient kind), never a statement per person; a test publishes to 3,000 seeded recipients
inside the 5-second interactive-transaction limit. **For slice 9**, if its `send` is per row.

### 4.8 The R167 hook — `CalendarListener`

Attendance tables arrive in slice 11. Slice 10 defines the seam; **wave D ships it with no
listener**.

```ts
// src/modules/calendar/calendar-listener.ts
export interface HolidayRange { id: bigint; startsOn: Date; endsOn: Date; appliesToStaff: boolean }
export interface CalendarListener {
  /** Inside the publish transaction, after the status write, before the notice. */
  holidayPublished(schoolId: SchoolId, holiday: HolidayRange): Promise<void>;
  /** Inside the cancel transaction, only for published → cancelled. */
  holidayCancelled(schoolId: SchoolId, holiday: HolidayRange): Promise<void>;
}
// CalendarListenerRegistry (exported by CalendarModule): register(listener) from the implementing
// module's onModuleInit. Attendance imports Calendar, never the reverse, so there is no cycle.
```

- Listeners run **sequentially** in registration order inside the caller's transaction (no
  `Promise.all`, §Transactions). A throw rolls back the publish or cancel.
- Lock order: holiday row first, then whatever the listener locks (slice 11: alert rows in id
  order). No listener may lock a holiday.
- **Slice 11 implements** (R167): on publish, pending `attendance_alerts` dated in the range →
  `cancelled`, `cancel_reason = holiday`; the summary `version` of every section-day in the range
  that has a register is bumped so the recompute excludes those days; registers are kept and the
  console flags them (computed at read: a register on a non-teaching day). On cancel: bump the same
  versions; days with no register then show unrecorded (R129, computed live), never absent.
  Slice 12 may add a listener for staff attendance on `appliesToStaff` holidays.
- Slice 10's test registers a fake listener and asserts it runs inside the transaction (its write
  rolls back with a failed publish) and is not called for a draft cancel or a no-op publish.

---

## 5. Calendar reads

### 5.1 `GET /calendar/teaching-days`

| Param | Rules |
|---|---|
| `dateFrom`, `dateTo` | both required dates; `dateTo ≥ dateFrom`; at most 366 days inclusive (`dateTo − dateFrom ≤ 365`) — `422` on `dateTo` |

**200** `TeachingDaysDto`. Not paginated: a bounded object (plan §6 conventions). Informational
(R116); nothing is stored.

### 5.2 `GET /me/calendar`

Same query rules. **200** `MyCalendarDto` — published holidays only, for the session's school.
Carries no id, description, actor or reason, so a guardian or student sees exactly what the notice
told them. Throttled by `me-reads` (R166).

---

## 6. Cover assignments (amends `slice-4.md` §4.3; R132)

`POST /staff/:id/teacher-assignments` with `role: 'cover'`. `:id` is the **covering** staff member.

| Field | Rules for `cover` |
|---|---|
| `role` | `'cover'` |
| `classId` | required, as slice 4 |
| `sectionId` | **required**; a section of `classId` (`422 REFERENCE_NOT_FOUND` otherwise) |
| `subjectId` | must be absent or `null` → else `422 INVALID_VALUE` |
| `startsOn` | optional, default `max(today, year.startsOn)`; ≥ today (no backdated scope); within the year |
| `endsOn` | **required** (a cover always lapses, R132); ≥ `startsOn`; ≤ `year.endsOn` |
| `coversAssignmentId` | optional id string (absent or `null` = covering a section with no class teacher). Not in the school → `422 REFERENCE_NOT_FOUND`. Must be a `class_teacher` row of the same `sectionId`, not voided, overlapping `startsOn..endsOn` by at least one day, and not the covering staff member's own row → else `422 INVALID_VALUE` on `coversAssignmentId` |
| `replaceCurrent` | must be absent → else `422 INVALID_VALUE` |

`coversAssignmentId` with any other role → `422 INVALID_VALUE`.

**Checks, in order** (slice 4's order, with two insertions):
1. Shape (`assertShape`, before any read).
2. Lock the covering staff row. **Self (F1, R74):** the staff row's login is the caller's and the
   caller lacks `role.manage` → `409 SELF_ACTION_FORBIDDEN`. A principal may cover a class
   themselves (they hold all-scope `attendance.student.mark` already; the row only puts them on the
   console's cover list). R132's "cannot be self-assigned" is read as F1, as the plan's slice-10
   table says.
3. References and dates, as slice 4 (class and year locked, section read under the class lock),
   then `coversAssignmentId` (read under the same locks; the covered row is **not** locked: the
   cover does not change it).
4. State: `STAFF_NOT_ACTIVE`, `ACADEMIC_YEAR_CLOSED`, `CLASS_ARCHIVED`, `SECTION_ARCHIVED`.
5. **Assignee capability (R132):** the covering staff member's login must currently hold
   `attendance.student.mark` (any source, any scope: `PermissionsService.load` + `holds`). No login,
   or not held → `409 CAPABILITY_NOT_HELD` `details: { capability: 'attendance.student.mark' }`.
   Checked once, here; afterwards the register routes re-check the capability on every request
   (R69), so a later revoke needs no cover-side handling.
6. **Retry-safety:** a live `cover` row of the same staff, class and section overlapping the dates →
   `409 ASSIGNMENT_EXISTS` `details: { assignmentId }`.
7. Insert. **Never `CLASS_TEACHER_EXISTS`**: a cover does not displace the class teacher (it sits
   outside `teacher_assignments_class_teacher_excl` by construction). Two covers of one section on
   overlapping dates by different staff are allowed (a split week).
8. **Push (R132):** `NotificationService.send(schoolId, { type: 'cover_assigned', subject: { type:
   'teacher_assignment', id }, recipients: [{ staffId: :id }], vars: { schoolName, className,
   sectionName, startsOn, endsOn } })`, enqueued after commit. Template: `{schoolName}: You are
   covering {className} {sectionName} from {Mon 6 Oct} to {Fri 10 Oct}.`
9. Audit `teacher_assignment.created` with `coversAssignmentId` in the metadata.

**201** `TeacherAssignmentDto`.

**Scope.** A cover row has `section_id`, so slice 4's today-scope (`activeSectionIds`) already gives
the section for exactly `startsOn..endsOn` and drops it the day after — **it lapses without any
write** (R132). `MeDto.assignments` (slice 9) lists it on those dates. Its role-aware meaning is §7.

**Ending a cover** uses `POST /teacher-assignments/:id/end` unchanged (§4.4 of slice 4): a planned
earlier last day, or ended/voided now. No message is sent on ending. Staff leaving ends it (R17).
A cover cannot be extended: create another from the day after it ends.

**Message type** — added to the §4.2 code table (`packages/shared/src/messages.ts`) and to the
`message_type` database enum in the groundwork migration:

| Type | Priority | Audience | Channels in order | SMS by default | Trigger |
|---|---|---|---|---|---|
| `cover_assigned` | internal | the covering staff member | push · email | — | R132 |

As every internal type it is never in `smsAllowedTypes` (the settings `PATCH` refuses an internal
type there, `slice-9.md`). A cover teacher with no live device and no verified email gets a
`suppressed:no_channel` delivery row, visible to the office.

---

## 7. Dated, role-aware scope (R175; plan §4.4)

Slice 11 (registers) and slice 13 (diary) use this; it is defined here because `cover` is.

### 7.1 `TeacherAssignmentRepository`

```ts
export interface SectionRoles {
  readonly classTeacher: boolean;
  readonly cover: boolean;
  /** Subjects taught in the section on that date; a whole-class subject row counts for every section. */
  readonly subjectIds: readonly bigint[];
}

/** Every section the staff member holds any role in on `on`, with the roles. */
sectionsOn(schoolId: SchoolId, staffId: bigint, on: Date): Promise<ReadonlyMap<bigint, SectionRoles>>;

/** The roles in one section on `on`; all-false and [] when none. */
rolesOn(schoolId: SchoolId, staffId: bigint, sectionId: bigint, on: Date): Promise<SectionRoles>;
```

A row counts on `on` iff `voided_at IS NULL AND starts_on <= on AND (ends_on IS NULL OR ends_on >=
on)` — the same predicate as today's scope. `class_teacher` sets `classTeacher`, `cover` sets
`cover`, `subject_teacher` adds its `subject_id`; a `subject_teacher` row with `section_id IS NULL`
applies to every section of its class, archived included (R54). At most two sequential statements
(rows, then the sections of whole-class rows). `rolesOn` is `sectionsOn(...).get(sectionId)` with the
empty value as default — one implementation, and `activeSectionIds(today)` becomes the key set of
`sectionsOn(today)`, so today's scope and dated scope cannot disagree (a test asserts it).

### 7.2 `PermissionsService.scopeOf(session, { capability, on })`

An **async method** on the permission service, distinct from the synchronous free function
`scopeOf(session)` (today's guard scope, unchanged). Returns `DatedScope | null`:

```ts
// tenancy/scope.ts — branded like Scope, minted only in tenancy/scope.mint.ts (access module only)
type DatedScope =
  | { kind: 'all'; on: Date }
  | { kind: 'sections'; on: Date; sections: ReadonlyMap<bigint, SectionRoles> };
```

- `null` when the caller does not hold `capability` (no staff capacity counts as not held, R59).
- `all` when the capability has a school-wide source (principal or office default, custom role,
  grant) — the same rule as `canAny`.
- Otherwise `sections` from `sectionsOn(schoolId, caller.staffId, on)`. An empty map means nothing,
  never no filter.
- `capability` is required because a route may admit several keys (register reads take `MARK` or
  `VIEW_ALL`) while the row action needs one; the service names the one it needs.
- `rowScope(dated): Scope` (in the access module) turns it into the ordinary `Scope` for a
  repository call, so student-linked repositories keep one scope type (control 7).

**The service gates the row; the decorator gates the route.** Register reads, submits and amends
use the scope **on the register's date**; list reads keep today's scope. Slice 10 tests the function
directly (R175's register and diary cases are named tests in slices 11 and 13):
cover inside its dates → `cover: true`; the day after `endsOn` → absent; a voided row → absent; a
row before `startsOn` → absent; a whole-class subject row → its subject in every section, archived
included; principal → `all`; teacher with no rows → empty map.

---

## 8. Section change and class change (amends `slice-6.md` §5; R37, R39, R174)

### 8.1 What changes

Until this slice `change-section` edited `enrolments.section_id` in place and cleared `roll_no`.
From this slice **a section change is close-old/open-new**, so the roster of any past date is
reconstructible from `started_on`/`ended_on` (R174, R124). R37 is amended: *a roll number is unique
per section among active enrolments; a section change opens a new enrolment without one, and the
closed enrolment keeps the number it had.* After this slice nothing edits `section_id` (the
database freezes it, §12).

**Dates.** The old enrolment ends on **`effectiveOn − 1`**; the new one starts on `effectiveOn`. No
date belongs to two enrolments, so a child is on exactly one roster per day. When `effectiveOn` is
the old enrolment's `started_on` (the section was wrong from the first day — a same-day admission
correction), the old enrolment ends on `started_on − 1`: **a zero-length enrolment, never in force
on any date**, kept as history (rule 4) instead of edited. The enrolment history shows it as "not
in force (corrected)".

### 8.2 `POST /enrolments/:id/change-section`

| Field | Rules |
|---|---|
| `sectionId` | required id string. Not in the school → `422 REFERENCE_NOT_FOUND`; a section of another class → `422 INVALID_VALUE` ("use change-class"); **the current section → `422 INVALID_VALUE`** ("already in that section") |
| `effectiveOn` | required date; ≥ the enrolment's `started_on`; ≤ today (no future moves: the one-active-enrolment index forbids two live rows) — `422` on `effectiveOn` |
| `reason` | **required** `TextField(3, 500)`, normalised (§1) — was optional |

Order, one `@Transactional()`, slice 6's lock order (student, then target section → class → year):
1. Enrolment read in scope (`404` outside it), student locked, enrolment re-read.
2. Not `active` → `409 ENROLMENT_NOT_ACTIVE`. **Retry-safety:** a resubmit after success lands
   here; the web refetches the enrolment list and treats it as done (as change-class).
3. Field refusals above.
4. `lockTarget` → `409 SECTION_ARCHIVED`, `CLASS_ARCHIVED`, `ACADEMIC_YEAR_CLOSED`.
5. **Attendance seam:** `AttendanceHistoryProbe.lastRecordedOn(schoolId, enrolmentId)` (an
   interface owned by the enrolments module; **wave D binds a stub returning `null`**; slice 11
   binds the real one). A mark on the old enrolment dated ≥ `effectiveOn` → `409
   ATTENDANCE_RECORDED_AFTER` `details: { lastRecordedOn }` — marks are never moved or orphaned,
   so the move is dated after them. Code reserved here; its test is `it.todo` until slice 11.
6. Old enrolment: `status = left`, `ended_on = effectiveOn − 1`; `section_id` and `roll_no`
   untouched. New enrolment: same student, year and class, `section_id = sectionId`, `roll_no =
   null`, `status = active`, `started_on = effectiveOn`. The old row is closed **before** the new
   insert (the one-active index).
7. Audit `enrolment.section_changed` on the old enrolment.

**200** `SectionChangeResultDto { closed, opened }`. The roll number is set afterwards with `PATCH
/enrolments/:id` on `opened.id`, unchanged from slice 6.

### 8.3 `POST /enrolments/:id/change-class` — aligned

R174 says a section change works "as a class change does"; slice 6's class change ended the old
enrolment **on** `effectiveOn`, which puts the child on two rosters that day. Aligned in this slice:
`ended_on = effectiveOn − 1` (zero-length when `effectiveOn = started_on`), step 5's attendance
seam applies, and the response becomes `SectionChangeResultDto { closed, opened }` like its twin.
Request, refusals and audit action are otherwise unchanged. (Student exits, `slice-6.md` §3.6,
still set `ended_on = effectiveOn`; whether `effectiveOn` is the last day or the first day away is
register item 11 — slice 11 must state it before it reads exits into the roster.)

---

## 9. Settings slice 10 relies on

The fields, DTO, validation and the single audit action of `GET|PATCH /school/settings` are
`contracts/slice-9.md` (§4.5 of the plan). Slice 10 relies on **`weeklyOffDays`** only: integers
0–6, **0 = Sunday**, unique, stored and returned ascending, fewer than seven, empty allowed (a school
open every day), default `[0]`. A change takes effect on the next evaluation of §3 and writes
nothing else (R116). `periodsPerDay`, the attendance fields and the messaging fields are slices 9
and 11's.

---

## 10. Error codes

| Code | Status | Where |
|---|---|---|
| `HOLIDAY_DATES_TAKEN` | 409 | holiday create, patch — `details.holidayId` (constraint `holidays_live_excl`, SQLSTATE 23P01) |
| `HOLIDAY_NOT_DRAFT` | 409 | holiday patch of a frozen field on a published holiday, or any change to a cancelled one |
| `CAPABILITY_NOT_HELD` | 409 | **new**: cover assignee lacks `attendance.student.mark` — `details.capability`. Not `403`: the caller is permitted; the target is not eligible |
| `ATTENDANCE_RECORDED_AFTER` | 409 | **new, reserved; live in slice 11**: section or class change dated on or before a recorded mark — `details.lastRecordedOn` |

Both new codes are added to `packages/shared/src/error-codes.ts` under `// slice 10`. Reused:
`ILLEGAL_STATUS_TRANSITION` (publish a cancelled holiday), `ASSIGNMENT_EXISTS`,
`SELF_ACTION_FORBIDDEN`, `STAFF_NOT_ACTIVE`, `ACADEMIC_YEAR_CLOSED`, `CLASS_ARCHIVED`,
`SECTION_ARCHIVED`, `ENROLMENT_NOT_ACTIVE`, `REFERENCE_NOT_FOUND`, `INVALID_VALUE`,
`CONCURRENT_UPDATE`. `NOT_A_TEACHING_DAY` is slice 11's (it uses §3). Mapper entry:
`holidays_live_excl` → `HOLIDAY_DATES_TAKEN`.

## 11. Audit actions

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `holiday.created` | holiday | — | `{ name, startsOn, endsOn, kind, appliesToStaff }` |
| `holiday.updated` | holiday | — | `{ changes }` |
| `holiday.published` | holiday | — | `{ startsOn, endsOn, noticeGuardians, noticeStaff, noticeStudents }` (counts; `0`s when the notice was skipped as past) |
| `holiday.cancelled` | holiday | required | `{ from, noticesWithdrawn, cancellationRecipients }` (counts) |
| `teacher_assignment.created` | teacher_assignment | — | slice 4's, plus `coversAssignmentId` (string \| null) |
| `enrolment.section_changed` | enrolment (the closed one) | required | `{ fromSectionId, toSectionId, newEnrolmentId, effectiveOn }` |
| `enrolment.class_changed` | enrolment (the closed one) | required | slice 6's `{ newEnrolmentId, toClassId }` plus `effectiveOn` |

No recipient names or phone numbers in any metadata (R152's rule, applied early).

## 12. For `data-architect`

1. `enrolments_ended_check` becomes `… AND (ended_on IS NULL OR ended_on >= started_on - 1)` (the
   zero-length enrolment of §8.1).
2. `enrolments_columns_immutable` adds `section_id` (R174: never edited in place).
3. `teacher_assignments.covers_assignment_id`: composite FK `(school_id, covers_assignment_id,
   section_id) → teacher_assignments (school_id, id, section_id)` (needs `UNIQUE (school_id, id,
   section_id)`), so the database refuses a cover pointing at another section's row; index `(school_id,
   covers_assignment_id)`; `CHECK (covers_assignment_id IS NULL OR role = 'cover')`; frozen by the
   existing trigger.
4. `message_type` enum gains `cover_assigned`; `suppression_reason` gains `subject_cancelled`
   (§4.6) — both in the groundwork migration, which slice 9 also builds on.
5. `holidays` as plan §5; add `published_by`/`cancelled_by` composite FKs to `users` with indexes.

---

## 13. Web screens → endpoints

Write controls render only when `GET /me` lists the capability; a `403` still shows the
no-permission state.

| Screen | Calls | Behaviour |
|---|---|---|
| Calendar — month view | `GET /calendar/teaching-days?dateFrom&dateTo` (the month), `GET /holidays?dateFrom&dateTo&limit=50` | Weekly-off days greyed, published ranges filled, drafts outlined (holiday.manage only), cancelled hidden unless toggled; "N teaching days" with "(informational for past months)" |
| Holidays list | `GET /holidays` | Filters status, kind, dates; status badge |
| Create / edit holiday | `POST /holidays`, `PATCH /holidays/:id` | Range picker; on a published holiday only description and "staff also off" are editable, the rest read-only with "cancel and create a new one to change dates"; `HOLIDAY_DATES_TAKEN` → "Overlaps <name>" with a link |
| Publish | `POST /holidays/:id/publish` | Confirm: "Every parent and staff member will be told by WhatsApp, SMS or the app. Dates cannot be changed after publishing." Past range: "No notice is sent for dates already past." |
| Cancel | `POST /holidays/:id/cancel` | Shared confirm-with-reason; for a published future holiday: "Everyone who was told will receive a cancellation." |
| Settings | `GET\|PATCH /school/settings` | Weekly-off checkboxes on the existing screen (slice 9 owns the screen) |
| Staff — Assignments tab | `POST /staff/:coverId/teacher-assignments` | "Arrange cover" on a class-teacher row of the absent teacher: pick the covering staff (`GET /staff?status=active`), dates (end required); posts to **the cover teacher's** staff id with `role: cover`, `sectionId`, `coversAssignmentId`; `CAPABILITY_NOT_HELD` inline ("X cannot mark registers"); cover rows show "Covering for <name>" |
| Student — Enrolment history | `POST /enrolments/:id/change-section`, `/change-class` | Dialog: section, date (default today), reason; text "Closes the current enrolment on <effectiveOn − 1> and opens a new one from <effectiveOn>. The roll number must be set again."; a zero-length row shows "not in force (corrected)" |

The mobile app shows `GET /me/calendar` on the guardian and student calendar screens (slice 16) and
opens the register tab from a `cover_assigned` push.

---

## 14. Tests this contract adds

R116 (table over weekly-off × holiday × draft/cancelled; Sunday public holiday counted once; past
range uses current setting) · R117 (one notice per guardian/staff/student-with-login; guardian of
three once; draft sends nothing; published frozen fields `409`; cancellation only to the told;
queued notice withdrawn on cancel; past range no notice) · R132 (cover appears in `/me` assignments
and today-scope for its dates, gone the day after with no write; self refused for a non-principal;
`CAPABILITY_NOT_HELD`; never `CLASS_TEACHER_EXISTS`; one `cover_assigned` message) · R167 (fake
listener in the transaction, rolled back on failure, not called for a draft cancel) · R174 (close/open
with `effectiveOn − 1`; zero-length same-day; `section_id` update refused by the database; roster of
every date has the child once) · R175 function cases of §7.2 · isolation test for `holidays` ·
`ATTENDANCE_RECORDED_AFTER` as `it.todo`.

---

## Decisions made here

1. **Wave-D notice path:** publish writes `holiday_notice` messages directly through
   `NotificationService` with `subject_type = 'holiday'` and leaves `announcement_id` null; slice 14
   switches publish to an announcement and **backfills nothing**.
2. **Cancellation reuses `holiday_notice`** with subject `holiday_cancellation` (so R107's unique
   index allows it and the SMS allow list covers it), goes only to persons whose notice was not
   withdrawn, and queued notices are withdrawn as `suppressed:subject_cancelled` (new reason).
3. A holiday wholly in the past is published or cancelled **without a message**; listeners still
   run.
4. Drafts are invisible to staff without `holiday.manage` (`404`, filtered in the query).
5. A published holiday's `description` and `appliesToStaff` stay editable; the four frozen fields
   accept their current value and refuse a different one with `HOLIDAY_NOT_DRAFT`.
6. Holiday name and description refuse identity and phone patterns (they reach every phone).
7. Notice recipients: guardians with a live link to an active child, active staff, students with a
   login; deduped by user, guardian plan wins.
8. `CalendarListener` is a registry the attendance module registers into, run sequentially inside
   the transaction; wave D has none.
9. Teaching days are a pure shared function over published holidays and the current weekly-off set;
   `0 = Sunday`; the count is informational for past ranges.
10. **Cover self-assignment follows F1** (a principal may), as the plan's slice-10 table says;
    R132's wording is read that way. The assignee-capability refusal is a new `409
    CAPABILITY_NOT_HELD` — no existing code fits (`PERMISSION_DENIED` would blame the caller).
11. `cover_assigned` is a new internal message type (push · email). Cover dates must overlap the
    covered class-teacher row; overlapping covers by different staff are allowed; ending a cover
    sends nothing.
12. Dated scope is `PermissionsService.scopeOf(session, { capability, on })` → branded `DatedScope`;
    `rolesOn` and today's `activeSectionIds` share one implementation (`sectionsOn`).
13. **Section change closes on `effectiveOn − 1`**, not on `effectiveOn`; a same-day correction
    produces a zero-length enrolment (the CHECK is relaxed by one day); `reason` becomes required;
    the current section is `422`; `section_id` is frozen in the database.
14. **Change-class is aligned** to the same dates and the `{ closed, opened }` response — a
    behaviour change to a shipped slice-6 endpoint, made because R174 says "as a class change does"
    and a same-day overlap would put a child on two rosters (R124). The web enrolments tab and the
    slice-6 change-class tests change with it.
15. A section or class change dated on or before a recorded mark is refused (`ATTENDANCE_RECORDED_AFTER`,
    reserved now, live in slice 11) — marks are never orphaned.
