# Slice 37 contracts — the period timetable

**Author:** Opus 5.5 (wave R), 2026-10-09. **Binds:** `apps/api/src/modules/timetable/**`,
`repositories/{timetable,timetable-reads}.repository.ts`, the R304 hook in
`modules/attendance/attendance-access.ts`, the R305 change to `RegisterDeadlineSweep`
(`attendance-jobs.ts`) and the `register_unrecorded` template, `SectionDayDto.periods`,
`LeaveRequestDto.periodsNeedingCover`, `PermissionsService.rowScopeWith`, the slice-37 lines of
`common/errors/constraints-phase5.ts`; the web pages under `/timetable`; the phone's Classes →
Timetable and the family child screen's Timetable. **Source:** `phase-5-extended.md` §0.32–§0.33,
§1.1 (rule 33 rows), §1.3 A1–A3, §3.1, §3.2 "Timetable", §3.3, §5 slice 37, §7, R301–R309;
migration `20261009140000_slice37_timetable`. Everything not restated follows the Phase 1–4
conventions (envelope, string ids, `PageQueryDto` ≤ 50, `NoQueryDto`, `@ApiErrors()`, `404`
outside the caller's scope, `Idempotency-Key` on creates with replay `200` + `Idempotency-Replayed`,
`ReasonDto`, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /sections/:id/timetable?date=` | staff | `SectionTimetableDto` for the Monday–Sunday week holding `date` (default today, school time): per day its own live version (R309), slots and live substitutions (§2.6) |
| `GET /me/children/:id/timetable?date=` | guardian | `MyTimetableDto` (family DTO, R308, §2.7); child outside the capacity scope `404` |
| `GET /me/student/timetable?date=` | student | the same for the student's own enrolment |
| `GET /me/staff/timetable?weekOf=` | staff | `MyStaffTimetableDto`: the caller's slots and substitutions across sections for the week holding `weekOf` (default today) |
| `GET /timetable-versions` | `timetable.manage` | page of `TimetableVersionDto`; filters `sectionId`, `academicYearId`, `status` (`live` \| `future` \| `past` \| `voided`, against today); sort `-effectiveFrom` (default), `effectiveFrom` |
| `GET /timetable-versions/:id` | `timetable.manage` | `TimetableVersionDetailDto` (with slots) |
| `POST /sections/:id/timetable-versions` + key | `timetable.manage` | `CreateTimetableVersionDto` → `201 TimetableVersionDetailDto` (§2.2) |
| `POST /timetable-versions/:id/void` | `timetable.manage` | `ReasonDto` → `200 TimetableVersionDetailDto` (§2.3) |
| `POST /sections/:id/timetable-substitutions` + key | `timetable.manage` | `CreateSubstitutionDto { date, period, staffId, reason }` → `201 TimetableSubstitutionDto` (§2.4) |
| `GET /timetable-substitutions` | `timetable.manage` | page; filters `sectionId`, `staffId`, `from`, `to` (≤ 92 days apart), `includeVoided` (default false); sort `-date` (default), `date` |
| `POST /timetable-substitutions/:id/void` | `timetable.manage` | `ReasonDto` → `200 TimetableSubstitutionDto` |
| `GET /timetable/grid?academicYearId&date=&weekday=` | `timetable.manage` | `TimetableGridDto` (§2.8) |
| `GET /attendance-registers` (existing) | existing | `SectionDayDto.periods` (§3.2) |
| `LeaveRequestDto` (existing) | existing | adds `periodsNeedingCover` (§3.4); `sectionsNeedingCover` unchanged |

Writes share the per-user bucket `timetable-writes` (30/min, 300/h). The family routes use
`me-reads`. Every staff member reads any section's timetable (§1.1 "Who edits"); a parent or
student session is `403` on staff routes.

### DTOs

- `TimetableSlotInputDto { weekday 0–6, period 1–12, classSubjectId, staffId, room?: string (1–40, trimmed, no identity number) | null }`.
- `CreateTimetableVersionDto { effectiveFrom: date, slots?: TimetableSlotInputDto[] (1–84), copyFromVersionId?: id }` — exactly one of `slots` and `copyFromVersionId` (both or neither: `422` on `slots`).
- `TimetableSlotDto { id, weekday, period, classSubjectId, subjectName, staffId, teacherName, room, assignedTeacher }` — `assignedTeacher` false when the teacher no longer holds a live assignment for that subject and section on the day (or, on a version, on its first day): the screens show "no assigned teacher" (R303).
- `TimetableVersionDto { id, sectionId, sectionName, classId, className, academicYearId, effectiveFrom, effectiveTo, status, slotCount, createdByName, createdAt, voidedAt, voidedByName, voidReason }`; `status` is `live` \| `future` \| `past` \| `voided` against today. Detail adds `slots[]` (weekday, period order).
- `TimetableSubstitutionDto { id, sectionId, sectionName, classId, className, date, period, staffId, teacherName, regularStaffId, regularTeacherName, subjectName, reason, createdByName, createdAt, voidedAt, voidReason }` (staff-visible, reason included).
- `SectionTimetableDto { section { id, name, classId, className, academicYearId }, weekOf, periodsPerDay, days[7] { date, weekday, teachingDay, versionId \| null, slots: TimetableSlotDto[], substitutions: TimetableSubstitutionDto[] } }`.
- `MyTimetableDto { studentId, sectionName \| null, className \| null, weekOf, periodsPerDay, days[7] { date, weekday, teachingDay, periods: { period, subjectName, teacherName, room }[] } }` — names only; no ids, reasons, versions or staff ids (R308). A substitution replaces the teacher's name on its date.
- `MyStaffTimetableDto { weekOf, periodsPerDay, days[7] { date, weekday, teachingDay, periods: { period, sectionId, sectionName, classId, className, subjectName, room, kind: 'slot' \| 'substitution', substitutedByName: string \| null }[] } }`.
- `TimetableGridDto { academicYearId, date, weekday, periodsPerDay, sections: { sectionId, sectionName, classId, className, versionId \| null, cells: TimetableSlotDto[] }[] }` (bounded: the year's live sections × periods).

## 2. Behaviour

### 2.1 Live, future, past (R301, R309)

A version is live on day `d` when it is not voided and `effective_from ≤ d ≤ coalesce(effective_to, ∞)`
(at most one per section, `timetable_versions_live_excl`). "Today" is the school's today.

### 2.2 Create a version (R301–R303)

In one transaction after the idempotency claim: the section (live, else `404`); its class's year
not `closed` (`409 ACADEMIC_YEAR_CLOSED`); `effectiveFrom ≥ today` and inside the year (`422` on
`effectiveFrom`); the slots — given, or copied from `copyFromVersionId` (a version of the same
class, else `422 REFERENCE_NOT_FOUND` on `copyFromVersionId`); each slot: `period ≤ periods_per_day`
(`422` on `slots[i].period`), a live class-subject of the section's class (`422 REFERENCE_NOT_FOUND`
on `slots[i].classSubjectId`), an active staff member (`422` on `slots[i].staffId`); then:

1. A non-voided version of the section starting on or after `effectiveFrom` → `409
   TIMETABLE_VERSION_SUPERSEDED { versionId }` (void it first). A live substitution of the section
   dated on or after `effectiveFrom` → `409 TIMETABLE_SUBSTITUTIONS_EXIST { substitutionIds }`
   (void them first; wave R review: a substitution must not outlive its slot).
2. The shared `timetableClashes(slots, { periodsPerDay, weeklyOffDays, others })`, where `others`
   are the other sections' non-voided slots whose range meets `[effectiveFrom, ∞)`: the first clash
   answers — `off_day` → `409 TIMETABLE_OFF_DAY { weekday }`; `section`, `teacher`, `room` → `409
   TIMETABLE_SLOT_CLASH { kind, weekday, period, conflictingSlotId? , index }`.
3. R303: each slot's teacher holds a `subject_teacher` assignment for the class-subject's subject
   in that section (or the whole class) live on `effectiveFrom` → else `409
   TIMETABLE_TEACHER_NOT_ASSIGNED { staffId, classSubjectId, sectionId }`.
4. The supersede (§3.2 order): the predecessor (the version live on `effectiveFrom`, if any) gets
   `effective_to = effectiveFrom − 1` (its slots follow by trigger); the version is inserted open-
   ended; then its slots.
5. Audit `timetable_version.created { sectionId, effectiveFrom, slots, supersededVersionId }`.

The database refuses the same clashes (`timetable_slots_teacher_excl`, `_room_excl`, the
version-weekday-period unique, `timetable_slots_period_in_day`, `timetable_slots_off_day`,
`timetable_versions_in_year`); a race loser gets the mapped error (§4).

### 2.3 Void a version (R301)

Only a non-voided version with `effective_from >= today` (`409 TIMETABLE_VERSION_NOT_FUTURE`), so a
version started today can be corrected the same day (wave R review); an already voided one answers
`200` unchanged, writing nothing. A live substitution of the section dated inside the version's
range → `409 TIMETABLE_SUBSTITUTIONS_EXIST { substitutionIds }`. The predecessor is the non-voided
version of the section whose `effective_to = effective_from − 1`. Its slots are re-checked against
the other sections' live slots over the voided version's range (`409 TIMETABLE_SLOT_CLASH` naming
the other section's slot); then the version is voided (its slots leave the constraints) and the
predecessor's `effective_to` becomes the voided version's (null when it was the last). Audit
`timetable_version.voided { restoredVersionId }`.

### 2.4 Substitutions (R306)

Create: the section (`404`); `date` inside the year and a teaching day (`409 NOT_A_TEACHING_DAY`);
a past `date` only within `attendance_amend_window_days` (`422` on `date`); `period ≤
periods_per_day` (`422`); a version live on `date` with a slot at its weekday and period (`409
TIMETABLE_SUBSTITUTION_NOT_TIMETABLED`); the substitute is an active staff member (`422` on
`staffId`) who is not the slot's teacher (`409 TIMETABLE_SUBSTITUTION_SAME_TEACHER`) and is not
timetabled in another section at that weekday and period on `date` without a substitution taking
it (`409 TIMETABLE_SLOT_CLASH { kind: teacher }`); no live substitution for the section-date-period
or for the substitute at that date-period (`409 TIMETABLE_SUBSTITUTION_EXISTS`). The substitute
needs no assignment. A leave cancellation does not void it. Void: `ReasonDto`; repeat → `200`
unchanged. Audit `timetable_substitution.created|voided`.

### 2.5 Attendance (R304, R306)

In period mode, when the section has a version live on the register's date, a caller whose role
in the section is `subject_teacher` writes `(section, date, period)` only when the version's slot
there names them or a live substitution does; otherwise `403 PERMISSION_DENIED { reason:
not_timetabled_period, period }`. A caller with **no** role in the section on the date (no
assignment) but named by a live substitution for that section, date and period writes and reads
that register as a subject teacher (the row scope gains the section). Without a live version Phase
2's R120 stands. The class teacher, a cover, `all` scope and daily mode are unchanged. The regular
teacher of a substituted slot keeps their access (§1.1: they may still amend what they recorded).
Applies to submit, the register view's `canSubmit`, mark amend and the gate's arrival (the mark's
period); the view's `canSubmit` is false for an untimetabled subject teacher.

### 2.6 Section week (R309)

Each day of the week shows the version live on that day (`versionId`), its slots of that weekday
(with `assignedTeacher` for that day) and that day's live substitutions; a week across a supersede
shows each day's own version.

### 2.7 Family view (R308)

The child's enrolment in force on the week's days (the latest started); none → `sectionName` null
and empty periods. Per teaching day: `{ period, subjectName, teacherName, room }` from the live
version, the substitute's name where a live substitution names one.

### 2.8 Grid

The year's live sections (`deleted_at IS NULL`), in class then section name order, each with its
version live on `date` (default today) and that version's cells for `weekday` (default `date`'s).

## 3. Hooks into earlier slices

### 3.1 R305 — `register-unrecorded`

The deadline job reads every rostered section-day of today. A period-mode section with a version
live today: its timetabled periods (today's weekday) without a register are listed as
`periods[{ className, sectionName, period, subjectName, teacherName | null }]` (the substitute's
name where one is set; `null` — "no assigned teacher" — when the slot's teacher has no live
assignment for the subject and section today). Any other section falls back to Phase 2 (no
register at all → `sections[]`). Nothing listed → `all_recorded`. The template names periods after
sections.

### 3.2 `SectionDayDto.periods`

`periods[{ period, subjectName | null, teacherName | null, recorded }]`: in period mode one row
per period `1..periodsPerDay`, names from the version live on the date (substitute's name where
set; null untimetabled or no version); `[]` in daily mode.

### 3.3 Settings

`PATCH /school/settings` lowering `periodsPerDay` below a period a live or future slot uses →
`422` on `periodsPerDay` (trigger `school_settings_periods_timetabled`).

### 3.4 R307 — `periodsNeedingCover`

Per pending or approved leave request: the staff member's slots on each teaching day of the leave
(up to `ended_early_on`) from the version live that day, `[{ date, period, sectionId, sectionName,
subjectName }]`, date then period order, less periods already given to a live substitution.

## 4. Errors and constraint mappings (`constraints-phase5.ts`, `SLICE_37_CONSTRAINTS`)

`timetable_slots_teacher_excl`, `timetable_slots_room_excl`, `timetable_slots_version_weekday_period_key`
→ `409 TIMETABLE_SLOT_CLASH` (kind teacher / room / section); `timetable_slots_off_day` → `409
TIMETABLE_OFF_DAY`; `timetable_slots_period_in_day` → `422` on `period`;
`timetable_versions_in_year` → `422` on `effectiveFrom`; `timetable_versions_live_excl` →
`CONCURRENT_UPDATE`; `timetable_substitutions_live_key`, `_staff_live_key` → `409
TIMETABLE_SUBSTITUTION_EXISTS`; `school_settings_periods_per_day_timetabled` → `422` on
`periodsPerDay`; the room and reason CHECKs → `422` on their field.

## 5. Audit (R57)

`timetable_version.created`, `timetable_version.voided`, `timetable_substitution.created`,
`timetable_substitution.voided`. Reads write nothing.

## 6. Schema (`20261009140000_slice37_timetable`)

Per plan §3.2 with the objects listed in `test/guardrails/schema-checks.ts` (`SLICE_37_OBJECTS`):
`timetable_versions` (dates, void CHECKs, `timetable_versions_live_excl`, the guard — in-year on
insert, born live, a voided range frozen — columns frozen but `effective_to` and the void trio,
void once-set, `timetable_versions_sync_slots` AFTER UPDATE OF `effective_to`, `voided_at`);
`timetable_slots` (weekday 0–6, period 1–12, room CHECKs, `timetable_slots_teacher_excl`,
`timetable_slots_room_excl` on `lower(btrim(room))`, the version-weekday-period unique,
`timetable_slots_live_staff_idx`, the guard copying the version's range and void on every insert
and update and refusing on insert a voided version, a period beyond `periods_per_day` or a
weekly-off day; frozen columns); `timetable_substitutions` (period, reason, void CHECKs, the two
live uniques, frozen columns, void once-set); `school_settings_periods_timetabled`; no delete, no
truncate, `school_id` immutable on all three.

## 7. Web and phone

Web: nav **Timetable** for staff. `/timetable` (a section picker; the section week; for
`timetable.manage` holders an Edit action), `/timetable/sections/[id]/edit` (the week-grid editor:
weekday × period cells with subject, teacher and room; clashes highlighted live from
`timetableClashes`, others' slots fetched from the grid; effective-from date; submit creates a
version), `/timetable/versions` (list with void), `/timetable/substitutions` (list, create, void),
`/timetable/grid` (the principal's grid). Each with loading, empty, error and content states;
tablet width in `responsive.spec`. Phone: Classes → **Timetable** (the teacher's week from `GET
/me/staff/timetable`, a day at a time, substitutions marked), and the family child screen's
**Timetable** (`MyTimetableDto`); online-only, no outbox lane. Maestro `teacher-timetable.yaml`.

## 8. Deviations from the plan

1. **`timetable_slots` carries no `section_id`.** The plan's column list has none; the section is
   the version's. Reads join through the version (`TimetableReadsRepository` maps it in memory).
2. **The slot copies its range and void in a BEFORE INSERT OR UPDATE guard as well as the plan's
   AFTER UPDATE trigger on the version.** The version trigger only touches its slots; the slot
   guard copies the version's values, so a direct write of a slot's range or void is overwritten
   and a slot can never disagree with its version. The same guard refuses an insert into a voided
   version (`timetable_slots_version_voided`).
3. **Void restores the predecessor's `effective_to` to the voided version's `effective_to`**, not
   always to NULL: the same thing when the voided version was the last, and correct when a later
   future version still follows. A voided version's range is frozen
   (`timetable_versions_voided_frozen`); a version is born live (`timetable_versions_born_live`).
4. **`TIMETABLE_VERSION_SUPERSEDED`** is the refusal of a create when a non-voided version of the
   section starts on or after `effectiveFrom` (void it first). Since the wave R review a version
   starting today is voidable the same day (`effective_from >= today`, school time): a same-day
   correction is "void today's version, then create from today again", which restores and then
   re-closes the predecessor. The web editor starts a new version today when the live one began
   before today, and tomorrow when the live one began today.
5. **The weekly-off-day rule is checked on insert only.** Changing `weekly_off_days` later leaves
   existing slots alone (the calendar already makes that weekday a non-teaching day, so R304/R305
   never act on it); lowering `periods_per_day` below a live slot is refused, as the plan says.
6. **The period guard answers before the CHECK:** a period above `periods_per_day` (and so any
   above 12) raises `timetable_slots_period_in_day`; `timetable_slots_period_check` backs it.
7. **Substitution addition:** the substitute must not be timetabled in another section at that
   weekday-period on the date unless a substitution already takes that slot from them (`409
   TIMETABLE_SLOT_CLASH { kind: teacher }`) — rule 33's "a teacher in one place per period". The
   regular teacher of a substituted slot keeps write access (§1.1 lets them amend what they
   recorded); the substitute gains it.
8. **R304 placement:** the check lives in `AttendanceAccess.writeRole/readRole`, which now take the
   period; a substitute with no assignment is admitted as a subject teacher, and the register view's
   row scope gains the section through `rowScopeWith` (PermissionsService, the only Scope minter).
   The register view's `canSubmit` is false for an untimetabled subject teacher.
9. **R305:** `AttendanceRegisterRepository.unrecordedForDeadline` is replaced by
   `rosteredForDeadline` (every rostered section-day; the job splits timetabled period-mode sections
   from the Phase 2 fallback) and `periodsRecorded`. A daily-mode section with a timetable stays on
   Phase 2. The `register_unrecorded` vars gain an optional `periods[]` (optional so rows written
   before slice 37 still render).
10. **The grid** takes an optional `date` (which versions are live, default today) beside the plan's
    `academicYearId` and `weekday` (default the date's weekday); it also returns `weeklyOffDays` so
    the editor can run the shared clash function with the grid's slots as `others`.
11. **A repeated void** (version or substitution) answers `200` unchanged and writes no audit row,
    as earlier slices' repeated archives do.
12. **Performance budgets (§7.2)** are not asserted by a timing test in this slice: the R304 check
    adds at most three indexed single-row statements (none for a class teacher, cover or `all`
    scope), and the family read is five statements for one section-week.
13. **Substitutions block version changes (wave R review).** A create from `effectiveFrom`, or a void,
    that would leave a live substitution of the section without its slot is refused `409
    TIMETABLE_SUBSTITUTIONS_EXIST { substitutionIds }` (at most 50 ids); the substitutions are voided
    first. A substitution created concurrently with the version change is not locked out (the check
    reads, it does not lock); the window is one request.
14. **R305 per weekday (wave R review).** A period-mode section whose live version has no slot on
    the day's weekday falls back to Phase 2 for that day (listed when it has no register at all).
15. **A timetable cannot be retired to no timetable.** A version needs at least one lesson
    (`slots` 1–84). Deliberate: a live version with no slot would lock every subject teacher out of
    the section's registers (R304); a section that stops being timetabled keeps its last version.
16. **The editor's clash preview reads the grid at `effectiveFrom` only.** Clashes with another
    section's version starting later are found by the server on save (`TIMETABLE_SLOT_CLASH` with
    the index) and shown on the cell.

## 9. Notes for later slices (from the wave R reviews)

- **Slice 44:** the device route needs its per-school (600/h) and per-IP bad-token (10/min with
  lockout) throttles in place before `@DeviceToken()` is applied to any route.
- **Slice 46:** the R68 route snapshot must record `@DefaultPasswordInert` per route, so adding or
  dropping the marker is a visible diff.
