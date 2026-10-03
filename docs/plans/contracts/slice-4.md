# Slice 4 contracts — staff (full), teacher assignments, system roles

**Author:** api-designer, 2026-10-03. **Binds:** `apps/api/src/modules/people/staff/**`,
`modules/access/**` (scope resolution), `modules/users/**` (role routes),
`apps/web/app/(school)/staff/**`. **Sources:** `CLAUDE.md` (rules 4, 5, 7, 12, 13), plan §3.2–§3.6,
§4 slice 4, §5 slice 4, §7, R12–R14, R17–R24, R53, R54, R57, R59, R69–R74, R77, R79, R99.
Everything not restated follows §3.9 and `slice-1.md`. Access decorators, `UserDto`,
`identityHash`, `maskIdentityNumber` and the reset-on-link rule are those of `slice-2.md`
(§1, §5, §7). DTO fields use `common/fields.ts` (`NameField`, `TextField`, `CnicField`,
`PhoneField`, `SearchField`, `QueryBoolean`, `IfPresent`, `IfPresentNotNull`). Paths are under
`/api/v1`.

---

## 1. Access and scope

| Route | Decorator |
|---|---|
| `GET /staff`, `GET /staff/:id` | `@RequireCapability(STAFF_VIEW)` |
| `POST /staff` | `@RequireCapability(STAFF_CREATE)` |
| `PATCH /staff/:id` | `@RequireCapability(STAFF_UPDATE)` |
| `POST /staff/:id/change-status` | `@RequireCapability(STAFF_STATUS_CHANGE)` |
| `POST /staff/:id/issue-login` | `@RequireCapability(USER_ACCOUNT_MANAGE)` |
| `GET\|POST /staff/:id/teacher-assignments`, `POST /teacher-assignments/:id/end` | `@RequireCapability(CLASS_MANAGE)` |
| `GET /users/:id/roles` | `@RequireCapability(USER_ACCOUNT_MANAGE, ROLE_MANAGE)` (any of) |
| `POST /users/:id/roles`, `POST /user-roles/:id/remove` | `@RequireCapability(ROLE_MANAGE)` |

Common errors: `401` · `403 PERMISSION_DENIED` · `403 SCHOOL_SUSPENDED` (writes) · `403
ORIGIN_REJECTED` · `429`. Absent, malformed or another school's id → `404 NOT_FOUND`.

**Scope (R79).** No slice-4 route is scoped: staff and assignment rows are not student-linked and
no slice-4 key is a teacher default. Slice 4 makes scope real for slice 6: `PermissionsService.can`
keeps its signature; when the capability is held only through the teacher default it returns
`scopeSections(ids)` where `ids` =, for the caller's `staff_id`, every `teacher_assignments` row
with `voided_at IS NULL AND starts_on <= today AND (ends_on IS NULL OR ends_on >= today)` (today in
the school's timezone, R53):
- `section_id` set (class teacher, or subject teacher of one section) → that section;
- `subject_teacher` with `section_id` null → every section of the class, archived included (R54).

No rows → `scopeSections([])` → **no rows returned, never no filter**. Held via principal or
office default (later: custom role or grant) → `scopeAll()`; both → the widest (`canAny` already
does this). Computed per request (R69). Services read it with `scopeOf(session)`.

Lock order in this slice: `school_settings` (only when a principal may be lost) → target `users`
row → `staff` row → `teacher_assignments` rows. **One exception, by design: issue-login (§3.6)
locks the `staff` row first and then the user found by CNIC hash**, because that user is not known
until the staff row's CNIC is read, and the staff lock is what serialises racing issue-logins.
Amended 2026-10-03 to match the code; the wave-B audit found no deadlock path, for these reasons:

- A status change (§3.5) locks a user before the staff row only when that user already has
  `staff_id` = the staff row. Issue-login proceeds only when no user has that `staff_id`, and in
  this slice a `staff_id` is written only by issue-login, under the staff lock, so the two cannot
  hold each other's next lock. (The platform's principal issue, slice 1, also links a staff row,
  but it locks the school row and the user and takes no staff lock, so it closes no cycle.) A
  login that appears after the status change's first read (issued between that read and the
  staff lock) is **not** locked after the staff row: the status change rolls back, releasing its
  locks, and starts again with the login in its first read, so it always takes `users` →
  `staff`; after three such restarts it answers `409 CONCURRENT_UPDATE`. *Amended 2026-10-03
  (slice-7 review, auditor A10): it previously locked that user after the staff row.*
- A status change of another staff member may hold the found user (it carries that member's
  `staff_id`) while issue-login waits on it; that status change never wants this staff row, so
  the wait ends and issue-login then refuses `LOGIN_ALREADY_EXISTS`.
- The user-account actions (slice-2 §5) lock `school_settings` and/or one `users` row and no
  `staff` row.

---

## 2. Shapes

`StaffStatus`: `active | suspended | left`. `SystemRole`: `principal | office_staff | teacher`.
`TeacherRole`: `class_teacher | subject_teacher`.

`StaffDto`:

| Field | Type |
|---|---|
| `id` | string |
| `fullName` | string |
| `cnicMasked` | string \| null — never the digits |
| `hasCnic` | boolean |
| `phone` | string (E.164) |
| `designation` | string \| null |
| `joinedOn` | date \| null |
| `status` | `StaffStatus` |
| `userId` | string \| null — login whose `staff_id` is this row |
| `systemRoles` | `SystemRole[]` — live rows of that user; `[]` without a login |
| `customRoleNames` | `string[]` — names of that user's live custom-role rows, in assignment order (an archived role's name too, while a row names it); `[]` without a login. *Added 2026-10-03 (slice-7 review A4), so a custom-role-only staff member is not shown as having no role* |
| `createdAt`, `updatedAt` | datetime |

`TeacherAssignmentDto`: `id`, `staffId`, `staffFullName`, `academicYearId`, `academicYearName`,
`classId`, `className`, `sectionId | null`, `sectionName | null`, `subjectId | null`, `subjectName
| null`, `role`, `startsOn` (date), `endsOn` (date | null), `voidedAt` (datetime | null),
`activeToday` (boolean), `createdAt`.

`UserRoleDto`: `id`, `userId`, `systemRole` (`SystemRole | null`), `customRoleId` (string | null,
always null until slice 7), `assignedBy` (string | null — null for platform-issued), `assignedAt`,
`endedAt | null`, `endedBy | null`.

---

## 3. Staff

### 3.1 `GET /staff` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `status` | optional `StaffStatus`; absent = all (web sends `active`) |
| `role` | optional `SystemRole` — staff whose login holds a live row of it (`role=teacher` per plan) |
| `hasLogin`, `hasCnic` | `QueryBoolean` |
| `q` | `SearchField` 2–100: `full_name ILIKE`, `designation ILIKE`; 4–12 digits also `phone LIKE`; a 13-digit run → `422` |
| `sort` | `fullName` (default), `-fullName`, `joinedOn`, `-joinedOn`, `createdAt`, `-createdAt`; `id` tiebreak |

**200** `{ data: StaffDto[], page, limit, total }`.

### 3.2 `GET /staff/:id` — `StaffDto`.

### 3.3 `POST /staff`

| Field | Rules |
|---|---|
| `fullName` | required, `NameField(2, 200)` |
| `cnic` | optional, `CnicField`; stored encrypted (AAD `schoolId\|staff\|cnic`) with `cnic_hash`; `null` = not given |
| `phone` | required, `PhoneField` |
| `designation` | optional, `NameField(1, 100)` or `null` |
| `joinedOn` | optional date, ≤ today + 366 days |

Created `active`, no login, no roles. A body with a `cnic` string spends the per-user identity-probe
budget (`slice-6.md` §3.4: 30/min, 300/hour, shared with the lookups) → `429`. **201** `StaffDto`.
Errors: `422` · `409 STAFF_CNIC_EXISTS`
`details: { staffId }` for any status (R20) — constraint `staff_school_id_cnic_hash_key`; the race
loser gets the same answer (existing id read in a fresh statement). Retry-safety: with a CNIC a
resubmit returns the pointer; without one the button is disabled in flight (as guardians).

### 3.4 `PATCH /staff/:id`

Fields as create; absent = unchanged, `null` clears (`fullName`, `phone` → `null` is `422`). Any
status may be edited. **`cnic` present (set, change or clear) while a user has `staff_id = :id` →
`409 STAFF_CNIC_LOCKED`** (R24; the CNIC is the username). New CNIC on another staff row → `409
STAFF_CNIC_EXISTS`; a body with a `cnic` string spends the identity-probe budget → `429`. Optimistic
retry then `409 CONCURRENT_UPDATE`. **200** `StaffDto`.

### 3.5 `POST /staff/:id/change-status`

`{ status: StaffStatus, reason: TextField(3, 500) }`.

| From → to | Allowed |
|---|---|
| `active → suspended`, `active → left` | yes |
| `suspended → active`, `suspended → left` | yes |
| `left → active` (re-hire) | yes |
| `left → suspended` | `409 ILLEGAL_STATUS_TRANSITION` `details: { from, to }` |
| same status | `200`, unchanged, no audit (retry-safe) |

Checks, in order, under the locks of §1: target staff row is the caller's own (`caller.staffId =
:id`) → `409 SELF_ACTION_FORBIDDEN` (R74). If a login exists: it holds a live `principal` row and
the caller lacks `role.manage` → `403`, `details.reason = 'target_is_principal'` (R12); caller lacks
`role.manage` and the target's set (live **and** dormant role defaults, `isSubset`) is not within
the caller's → `403`, `'target_exceeds_actor'` (R14). To `left|suspended` and the target is a
needed principal → `409 LAST_PRINCIPAL` (R72, R73; `school_settings` locked first).

Effects, one transaction:
- **`left` (R17):** every live `user_roles` row of the user ended (`ended_at = now`, `ended_by =
  caller`); every not-yet-ended assignment ended as §4.4 with no `endsOn`; active grants ended
  with reason "staff left" — **slice 7 implements this** via `GrantsRepository.endAllForUser`,
  slice 4 leaves the call site with an `it.todo`; every session of the user revoked, cookie and
  bearer, even if a guardian capacity remains (R70). `users.status` is not written (R71).
- **`suspended` (R18):** sessions revoked (R70); roles, assignments and grants untouched — inert
  by R59, counting again on reactivation.
- **`active` from `suspended`:** nothing else changes. **From `left` (R19):** nothing is restored;
  roles must be assigned (§5) and assignments added (§4).

**200** `StaffDto`. Audit `staff.status_changed`.

### 3.6 `POST /staff/:id/issue-login`

| Field | Rules |
|---|---|
| `systemRole` | required `SystemRole` |
| `confirmLinkExisting` | optional boolean; must be `true` when a login with this CNIC already exists |

Preconditions, staff row locked, in order:
1. `status ≠ active` → `409 STAFF_NOT_ACTIVE` (R21).
2. No CNIC → `409 IDENTITY_NUMBER_MISSING` (R21).
3. A user has `staff_id = :id` → `409 LOGIN_ALREADY_EXISTS` (R21).
4. Caller lacks `role.manage` and `SYSTEM_ROLE_DEFAULTS[systemRole]` ⊄ caller's effective set →
   `403`, `details.reason = 'role_exceeds_actor'` (R13). `principal` therefore always needs
   `role.manage`.

Then user by `(schoolId, identityHash(digits))`, locked (R99):
- **exists** (R22, teacher-parent): it is the caller → `409 SELF_ACTION_FORBIDDEN`; `disabled` →
  `409 USER_DISABLED`; `student_id` set → `409 USERNAME_IN_USE` (never link a student login);
  `staff_id` already set → `409 LOGIN_ALREADY_EXISTS`; `confirmLinkExisting !== true` → `409
  LINK_EXISTING_LOGIN_UNCONFIRMED`, nothing written. Otherwise set `staff_id` and apply **wave
  A's reset-on-link** in the same transaction, exactly as `slice-2.md` §7: every session revoked,
  outstanding tokens voided, password back to the default digits, `password_is_default = true`,
  `email` and `email_verified_at` cleared, audit `user.reset_on_staff_link` `{ capacity:
  systemRole }`.
- **absent**: create with the default password, `password_is_default = true`, `status = active`.

Insert `user_roles(system_role, assigned_by = caller)`. **201** `UserDto`.

Race (R77), caught **outside** the transaction, fresh read: `users_school_id_staff_id_key` → `409
LOGIN_ALREADY_EXISTS`; `users_school_id_username_hash_key` → rerun once on the link path (which
then needs `confirmLinkExisting`). Never `500`. Retry-safety: a resubmit is `LOGIN_ALREADY_EXISTS`;
the web refreshes and treats it as done. Audit `user.login_issued`.

---

## 4. Teacher assignments

### 4.1 Dates

"Today" is the school's timezone. An assignment counts on `starts_on..ends_on` inclusive.
**Ending** means "no longer counts from today". **Voided** means "never counted" (a row that had
not begun, or began today, and is withdrawn); rule 4 forbids deleting it.
**For `data-architect`:** add `voided_at timestamptz(3)` and `voided_by` (composite FK to users)
nullable, `CHECK ((voided_at IS NULL) = (voided_by IS NULL))`; the exclusion constraint's
predicate becomes `WHERE (role = 'class_teacher' AND voided_at IS NULL)`; name it
`teacher_assignments_class_teacher_excl`.

### 4.2 `GET /staff/:id/teacher-assignments` — paginated

Filters `includeEnded` (`QueryBoolean`, default `false`: hides rows voided or with `ends_on <
today`), `academicYearId`. Sort `-startsOn` (default), `startsOn`, `className`. **200**
`{ data: TeacherAssignmentDto[], page, limit, total }`.

### 4.3 `POST /staff/:id/teacher-assignments`

| Field | Rules |
|---|---|
| `role` | required `TeacherRole` |
| `classId` | required id; not in tenant → `422 REFERENCE_NOT_FOUND`. The academic year is taken from the class, never from input |
| `sectionId` | `class_teacher`: required. `subject_teacher`: optional, `null` = every section of the class (R54). Not a section of `classId` → `422 REFERENCE_NOT_FOUND` |
| `subjectId` | `subject_teacher`: required; `class_teacher`: must be absent or `null` (`422 INVALID_VALUE`) |
| `startsOn` | optional date, default `max(today, year.startsOn)`; must be ≥ today (no backdating scope) and within the year |
| `endsOn` | optional date or `null`; ≥ `startsOn`, ≤ `year.endsOn` |
| `replaceCurrent` | optional boolean, `class_teacher` only |

Refusals: staff not `active` → `409 STAFF_NOT_ACTIVE`; year `closed` → `409
ACADEMIC_YEAR_CLOSED`; class archived → `409 CLASS_ARCHIVED`; section archived → `409
SECTION_ARCHIVED`; subject archived → `409 SUBJECT_ARCHIVED`. The staff member need not hold the
teacher role yet (the web shows a hint when not).

**Retry-safety:** with the staff row locked, a live row of the same `(staff, role, class,
section, subject)` overlapping the new dates → `409 ASSIGNMENT_EXISTS` `details: {
assignmentId }`.

**One class teacher per section (R23).** An overlapping live `class_teacher` row on the section →
`409 CLASS_TEACHER_EXISTS` `details: { conflicts: [{ assignmentId, staffId, staffFullName,
startsOn, endsOn }] }`, unless `replaceCurrent: true`, in which case, in one transaction with
those rows locked, each conflict is ended at `startsOn − 1` if it started before `startsOn`,
otherwise voided; then the new row is inserted. The constraint
`teacher_assignments_class_teacher_excl` maps to the same `409` for a race.

**201** `TeacherAssignmentDto`. Audit `teacher_assignment.created` (plus
`teacher_assignment.ended` per replaced row).

### 4.4 `POST /teacher-assignments/:id/end`

`{ endsOn?: date, reason?: TextField(3, 500) }`.
- `endsOn` absent: started before today → `ends_on = today − 1`; otherwise voided.
- `endsOn` present (a planned last day): ≥ today, ≥ `starts_on`, and ≤ the current `ends_on` if
  set, else `422` on `endsOn`.
- Already voided, or `ends_on < today` → `200`, unchanged, no audit.

**200** `TeacherAssignmentDto`. Audit `teacher_assignment.ended`.

### 4.5 Seams this slice fills

- `classes.service` `CLASS_YEAR_IMMUTABLE`: any teacher assignment (voided included) references
  the class.
- `assertSectionUnused`: a live assignment with `ends_on IS NULL OR ends_on >= today` on the
  section → `409 SECTION_IN_USE`.

---

## 5. System roles

### 5.1 `GET /users/:id/roles` — paginated

Filter `includeEnded` (default `false`). Sort `-assignedAt`. **200** `{ data: UserRoleDto[], … }`.

### 5.2 `POST /users/:id/roles`

`{ systemRole: SystemRole, reason: TextField(3, 500) }` (slice 7 adds `customRoleId`, exactly one
of the two; `null` for either is `422`, never read as absent). Target user locked. Target = caller → `409 SELF_ACTION_FORBIDDEN` (R74). Target has no
`staff_id`, or its staff is not `active` → `409 STAFF_NOT_ACTIVE`. Live row of that role → `409
ROLE_ALREADY_ASSIGNED` `details: { userRoleId }` (the partial unique maps to it on a race; the web
treats it as done). R13 holds by the decorator. Assigning `principal` ends every live grant and
revoke row of the user (`slice-7.md` §4.4). **201** `UserRoleDto`. Audit `user_role.assigned`.

### 5.3 `POST /user-roles/:id/remove`

`{ reason: TextField(3, 500) }`. Lock `school_settings` when the row is `principal`, then the user.
Row's user = caller → `409 SELF_ACTION_FORBIDDEN` (R74). Already ended → `200`, unchanged, no
audit. Removing it would leave no active principal → `409 LAST_PRINCIPAL` (R72, R73). Sets
`ended_at`, `ended_by`. Takes effect on the target's next request (R69); if no capacity remains
their sessions are refused by resolution (R71). **200** `UserRoleDto`. Audit `user_role.removed`.

---

## 6. Error codes (new)

| Code | Status | Where |
|---|---|---|
| `STAFF_CNIC_EXISTS` | 409 | staff create, patch — `details.staffId` (R20) |
| `STAFF_CNIC_LOCKED` | 409 | staff patch of `cnic` once a login exists (R24) |
| `USERNAME_IN_USE` | 409 | staff issue-login onto a student login; slice 6 student issue-login (R40) |
| `CLASS_TEACHER_EXISTS` | 409 | assignment create without `replaceCurrent` — `details.conflicts` |
| `ASSIGNMENT_EXISTS` | 409 | duplicate overlapping assignment — `details.assignmentId` |
| `ROLE_ALREADY_ASSIGNED` | 409 | role assign — `details.userRoleId` |

Reused: `SELF_ACTION_FORBIDDEN`, `LAST_PRINCIPAL`, `STAFF_NOT_ACTIVE`, `USER_DISABLED`,
`IDENTITY_NUMBER_MISSING`, `LOGIN_ALREADY_EXISTS`, `LINK_EXISTING_LOGIN_UNCONFIRMED`,
`ILLEGAL_STATUS_TRANSITION`, `ACADEMIC_YEAR_CLOSED`, `CLASS_ARCHIVED`, `SECTION_ARCHIVED`,
`SUBJECT_ARCHIVED`, `SECTION_IN_USE`, `CLASS_YEAR_IMMUTABLE`, `CONCURRENT_UPDATE`,
`REFERENCE_NOT_FOUND`. Mapper entries: `staff_school_id_cnic_hash_key` → `STAFF_CNIC_EXISTS`;
`teacher_assignments_class_teacher_excl` (SQLSTATE 23P01) → `CLASS_TEACHER_EXISTS`;
the `user_roles` system-role partial unique → `ROLE_ALREADY_ASSIGNED`.

## 7. Audit actions

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `staff.created` | staff | — | `{ hasCnic }` |
| `staff.updated` | staff | — | `{ changes }`; `cnic`, `phone` as `{ changed: true }` only |
| `staff.status_changed` | staff | required | `{ from, to, rolesEnded, assignmentsEnded, sessionsRevoked }` (counts) |
| `user.login_issued` | user | — | `{ capacity: 'staff', systemRole, linkedExistingUser }` |
| `user.reset_on_staff_link` | user | — | `{ capacity: systemRole }` |
| `user_role.assigned` / `user_role.removed` | user | required | `{ systemRole, userRoleId }` |
| `teacher_assignment.created` | teacher_assignment | — | `{ staffId, role, classId, sectionId, subjectId, startsOn, endsOn }` |
| `teacher_assignment.ended` | teacher_assignment | as given | `{ endsOn }` or `{ voided: true }`; `{ replacedBy }` when by replace |

---

## 8. Web screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| Staff list | `GET /staff?status=active` | Columns name, masked CNIC, phone, designation, roles, login, status; filters status, role, login, no CNIC; 13-digit search refused with a message |
| Create staff | `POST /staff` | `STAFF_CNIC_EXISTS` offers "Open existing staff member" |
| Staff detail — Details | `GET /staff/:id`, `PATCH` | CNIC read-only with an explanation when `userId` is set |
| Change status dialog | `POST /staff/:id/change-status` | Shared confirm-with-reason; states what `left` ends and that re-hire restores nothing; `LAST_PRINCIPAL` shown inline. Hidden on the caller's own row |
| Issue login dialog | `POST /staff/:id/issue-login` | Role select limited to roles the caller may give (`principal` only with `role.manage`); on `LINK_EXISTING_LOGIN_UNCONFIRMED` a second confirmation ("an existing login with this CNIC will be reset to the default password, its email cleared and signed out") resubmits with `confirmLinkExisting: true` |
| Staff detail — Login and roles | `GET /users/:id/roles`, `POST /users/:id/roles`, `POST /user-roles/:id/remove` | Write controls only with `role.manage`; history toggle |
| Staff detail — Assignments | `GET /staff/:id/teacher-assignments`, `POST`, `POST /teacher-assignments/:id/end` | Class, section and subject pickers from slice-3 lists; `CLASS_TEACHER_EXISTS` opens a confirm listing the current class teacher, then resubmits with `replaceCurrent: true`; "Active today" badge |

---

## Decisions made here

1. No slice-4 route is section-scoped; slice 4 delivers teacher scope for slice 6 through
   `PermissionsService.can` without changing its signature.
2. `teacher_assignments` gains `voided_at` / `voided_by` (for `data-architect`); ending means "not
   from today" (`ends_on = today − 1`) and a row not yet begun is voided. Assignments cannot be
   backdated; the year comes from the class.
3. Class-teacher reassignment is an explicit `replaceCurrent: true` resubmit after a `409` listing
   the conflict.
4. Staff status: `left → suspended` refused; same status is a `200` no-op; R12 and R14 apply to
   status change as to reset and disable.
5. Staff issue-login without a CNIC reuses `IDENTITY_NUMBER_MISSING`; it never links onto a
   student login (`USERNAME_IN_USE`) and always applies reset-on-link with `confirmLinkExisting`.
6. Role assignment needs an `active` staff record; `GET /users/:id/roles` is added for the roles
   tab; role removal does not revoke sessions (R69/R71 handle it).
7. Grant ending on `left` is a slice-7 call site, stubbed here.
