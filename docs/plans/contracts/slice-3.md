# Slice 3 contracts — academic structure

**Author:** api-designer, 2026-10-03. **Binds:** `apps/api/src/modules/academic/**`,
`apps/web/app/(school)/academic/**`. **Sources:** `CLAUDE.md` (rules 2, 3, 4, 14, 15), plan §3.8,
§3.9, §4 slice 3, §5 slice 3, R44, R62–R68, R80. Everything not restated follows §3.9 and
`slice-1.md` (envelope, `422 VALIDATION_FAILED` with `details.fields`, string ids, camelCase,
`NoQueryDto`, `@ApiErrors()`, `@IdParam()`). Access decorators are those of `slice-2.md` §1.
Paths are under `/api/v1`.

---

## 1. Access

| Routes | Decorator |
|---|---|
| Every `GET` below | `@RequireStaff()` |
| Academic-year writes | `@RequireCapability(Capability.ACADEMIC_YEAR_MANAGE)` |
| Class writes, copy-sections | `@RequireCapability(Capability.CLASS_MANAGE)` |
| Section writes | `@RequireCapability(Capability.SECTION_MANAGE)` |
| Subject writes | `@RequireCapability(Capability.SUBJECT_MANAGE)` |

**Why `@RequireStaff()` and not `@AuthenticatedOnly()` plus a check.** R78 asserts, by
enumerating the router, that a parent-only or student-only session gets `403` everywhere except
`/auth/*` and `/me/*`. An `@AuthenticatedOnly` read would fail that test unless every handler
remembered a staff check — the kind of rule that gets forgotten. `@RequireStaff()` makes "any
active staff role" a declared, enumerable access rule enforced by the guard (`slice-2.md` §1.1:
staff record `active` and at least one live role). Teachers see the whole structure; it holds no
student data.

Common errors on every route: `401 AUTH_REQUIRED` · `403 PERMISSION_DENIED` · `403
SCHOOL_SUSPENDED` (every write) · `403 ORIGIN_REJECTED` (cookie non-GET) · `429`. Every `:id`
resolves in the session's school only; absent, malformed or another school's → `404 NOT_FOUND`.

**Name normalisation** (all four resources): trim, collapse internal whitespace runs to one
space, reject control characters. Uniqueness is exact after normalisation, as the database
constraint declares.

Lists: `page`, `limit` per `PageQueryDto`; `sort` from the stated allowlist, `id` ascending as
tiebreak, anything else `422`. Booleans in query strings are the literal strings `true|false`.

---

## 2. Academic years

`AcademicYearDto`: `id`, `name`, `startsOn` (date), `endsOn` (date), `status` (enum
`AcademicYearStatus`: `planned | active | closed`), `createdAt`, `updatedAt`.

**Transitions:** `planned → active` (activate), `planned | active → closed` (close). `closed` is
final. Several years may be `active` at once (rule 15: an April and a September session side by
side). Same-status request → `200`, unchanged, no audit row. Anything else → `409
ILLEGAL_STATUS_TRANSITION` with `details: { from, to }`.

### 2.1 `GET /academic-years` — paginated
Filters `status`. `sort`: `-startsOn` (default), `startsOn`, `name`, `-name`.

### 2.2 `GET /academic-years/:id` — `AcademicYearDto`.

### 2.3 `POST /academic-years`
| Field | Rules |
|---|---|
| `name` | required, 2–50 (e.g. `2026-27`, `Sept 2026`) |
| `startsOn`, `endsOn` | required, `YYYY-MM-DD`, real calendar dates; `endsOn > startsOn`; span ≤ 731 days (a typo guard) — `422` on `endsOn` |

Created `planned`. **201**. Errors: `409 ACADEMIC_YEAR_NAME_TAKEN` (`details: { field: 'name' }`,
from constraint `academic_years_school_id_name_key`).

### 2.4 `PATCH /academic-years/:id`
`name`, `startsOn`, `endsOn`, same rules; the date rule is checked against the merged result.
`null` → `422`. Year `closed` → `409 ACADEMIC_YEAR_CLOSED`. **200**. Audit with `{ changes }`
only when something changed.

### 2.5 `POST /academic-years/:id/activate` — empty body
`planned → active`. **200**.

### 2.6 `POST /academic-years/:id/close` — empty body
Lock the year `FOR UPDATE`. **R44:** refused `409 ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS` while any
enrolment in the year has `status = active`. Enrolments arrive in slice 6: slice 3 reserves the
code, writes the R44 test as `it.todo`, and leaves a single named method
`assertNoActiveEnrolments(schoolId, yearId)` that slice 6 implements inside this transaction.
Closing does not archive classes. **200**.

---

## 3. Classes

`ClassDto`: `id`, `academicYearId`, `academicYearName`, `name`, `sortOrder` (integer),
`attendanceMode` (enum `AttendanceMode`: `daily | period`), `status` (enum `ClassStatus`:
`active | archived`), `createdAt`, `updatedAt`.

### 3.1 `GET /classes` — paginated
Filters `academicYearId` (id string; unknown → empty page, not `422`), `status`, `q` (2–50, `name
ILIKE`, `%_\` escaped). `sort`: `sortOrder` (default), `-sortOrder`, `name`, `-name`.

### 3.2 `GET /classes/:id` — `ClassDto`.

### 3.3 `POST /classes`
| Field | Rules |
|---|---|
| `academicYearId` | required id string; not in tenant → `422 REFERENCE_NOT_FOUND` |
| `name` | required, 1–50 |
| `sortOrder` | optional int 0–999, default 0 |
| `attendanceMode` | required enum (rule 14: the school chooses per class; no default) |

Year `closed` → `409 ACADEMIC_YEAR_CLOSED`. **201**. Errors: `409 CLASS_NAME_TAKEN` (constraint
`classes_school_id_academic_year_id_name_key`).

### 3.4 `PATCH /classes/:id`
`name`, `sortOrder`, `attendanceMode`, `academicYearId`; `null` → `422`. Class `archived` → `409
CLASS_ARCHIVED`; its year or the target year `closed` → `409 ACADEMIC_YEAR_CLOSED`.
**`academicYearId` changes only while the class is unreferenced**: any section (archived
included), enrolment or teacher assignment → `409 CLASS_YEAR_IMMUTABLE`. Slice 3 checks sections;
slices 4 and 6 extend the same check; the `ON UPDATE RESTRICT` composite foreign keys are the
database's second line, and their constraint names map to the same code. Changing
`attendanceMode` is unrestricted in Phase 1 (no attendance rows exist). **200**.

### 3.5 `POST /classes/:id/archive` — `{ reason?: 3–500, no identity pattern }`
Already archived → `200`, no audit. Refused `409 CLASS_HAS_ACTIVE_ENROLMENTS` while an active
enrolment references it (code reserved; slice 6 implements; `it.todo` here). An archived class
accepts no new sections or enrolments and no edits. No unarchive in v1. **200**.

### 3.6 `POST /classes/:id/copy-sections`
| Field | Rules |
|---|---|
| `fromClassId` | required id string; not in tenant → `422 REFERENCE_NOT_FOUND`; equal to `:id` → `422 INVALID_VALUE` |

Target must be `active` and its year not `closed` (`409 CLASS_ARCHIVED` / `ACADEMIC_YEAR_CLOSED`).
In one transaction, every **live** section of the source is copied (`name`, `capacity`) unless the
target already has a live section of that name. **Retry-safe by construction**: a repeat creates
nothing. **200** `{ created: SectionDto[], skippedNames: string[] }`. One audit row
`class.sections_copied` `{ fromClassId, created: <count> }`.

---

## 4. Sections

`SectionDto`: `id`, `classId`, `name`, `capacity` (integer | null), `archivedAt` (datetime |
null — the `deleted_at` column), `createdAt`, `updatedAt`.

### 4.1 `GET /classes/:id/sections` — paginated
Class `404` if not in tenant. Filter `includeArchived` (default `false`). `sort`: `name`
(default), `-name`.

### 4.2 `GET /sections/:id` — archived sections are returned (history follows the section).

### 4.3 `POST /classes/:id/sections`
`name` required 1–20; `capacity` optional int 1–200 or `null`. Class `archived` → `409
CLASS_ARCHIVED`; year `closed` → `409 ACADEMIC_YEAR_CLOSED`. **201**. Errors: `409
SECTION_NAME_TAKEN` (partial unique among live sections of the class). An archived section's name
may be reused.

### 4.4 `PATCH /sections/:id`
`name`, `capacity` (`null` clears). Archived → `409 SECTION_ARCHIVED`. **200**. Capacity is
informational in Phase 1: not enforced against enrolment counts.

### 4.5 `POST /sections/:id/archive` — `{ reason?: as 3.5 }`
Already archived → `200`, no audit. Refused `409 SECTION_IN_USE` while an `active` enrolment
(slice 6) or a teacher assignment not yet ended (`ends_on IS NULL OR ends_on >= today`, slice 4)
references it; slice 3 reserves the code and leaves `assertSectionUnused(schoolId, sectionId)` for
those slices, with `it.todo` tests. Sets `deleted_at = now()`. **200**.

---

## 5. Subjects

`SubjectDto`: `id`, `name`, `code` (string | null), `archivedAt` (datetime | null), `createdAt`,
`updatedAt`.

### 5.1 `GET /subjects` — paginated
Filters `includeArchived` (default `false`), `q` (2–50; `name ILIKE` or `code` prefix). `sort`:
`name` (default), `-name`, `code`, `-code`.

### 5.2 `GET /subjects/:id`.

### 5.3 `POST /subjects`
`name` required 1–100; `code` optional, trimmed, upper-cased, `^[A-Z0-9-]{1,20}$`. **201**.
Errors: `409 SUBJECT_NAME_TAKEN`, `409 SUBJECT_CODE_TAKEN` (partial uniques among live rows; the
code index is `(school_id, code) WHERE deleted_at IS NULL AND code IS NOT NULL` —
**for `data-architect`**, §4 of the plan lists only the name index).

### 5.4 `PATCH /subjects/:id`
`name`, `code` (`null` clears). Archived → `409 SUBJECT_ARCHIVED`. **200**.

### 5.5 `POST /subjects/:id/archive` — `{ reason? }`
No reference check in Phase 1 (subject teacher assignments keep pointing at the archived row; the
history stays readable). Already archived → `200`. **200**.

---

## 6. Error codes

| Code | Status | Where |
|---|---|---|
| `ACADEMIC_YEAR_NAME_TAKEN` | 409 | year create/patch |
| `ACADEMIC_YEAR_CLOSED` | 409 | edits to a closed year, or to classes/sections in one |
| `ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS` | 409 | close (R44; live in slice 6) |
| `CLASS_NAME_TAKEN` | 409 | class create/patch |
| `CLASS_YEAR_IMMUTABLE` | 409 | class patch of `academicYearId` once referenced |
| `CLASS_ARCHIVED` | 409 | edits, new sections, copy target |
| `CLASS_HAS_ACTIVE_ENROLMENTS` | 409 | class archive (live in slice 6) |
| `SECTION_NAME_TAKEN` | 409 | section create/patch |
| `SECTION_ARCHIVED` | 409 | section patch |
| `SECTION_IN_USE` | 409 | section archive (live in slices 4 and 6) |
| `SUBJECT_NAME_TAKEN` | 409 | subject create/patch |
| `SUBJECT_CODE_TAKEN` | 409 | subject create/patch |
| `SUBJECT_ARCHIVED` | 409 | subject patch |

Reused: `ILLEGAL_STATUS_TRANSITION`, `REFERENCE_NOT_FOUND`, `CONCURRENT_UPDATE`. Constraint-name
mappings are added to the slice-1 mapper for each `_TAKEN` code and for the class-year foreign
keys.

## 7. Audit actions

| Action | Reason | Metadata |
|---|---|---|
| `academic_year.created` / `.updated` / `.activated` / `.closed` | — | `{ name, startsOn, endsOn }` on create; `{ changes }`; `{ from, to }` |
| `class.created` / `.updated` / `.archived` | archive: as given | `{ academicYearId, name }`; `{ changes }`; `{}` |
| `class.sections_copied` | — | `{ fromClassId, created }` |
| `section.created` / `.updated` / `.archived` | archive: as given | `{ classId, name }`; `{ changes }`; `{}` |
| `subject.created` / `.updated` / `.archived` | archive: as given | `{ name, code }`; `{ changes }`; `{}` |

---

## 8. Web screens → endpoints

One "Academic structure" area, four tabs. Write controls render only when `GET /me` lists the
capability; a `403` still shows the no-permission state.

| Screen | Calls | Behaviour |
|---|---|---|
| Academic years | `GET /academic-years`, `POST`, `PATCH`, `/activate`, `/close` | Status badge; close via the shared confirm dialog stating that a closed year cannot be reopened; `ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS` shown in the dialog |
| Classes | `GET /classes?academicYearId=…`, `POST`, `PATCH`, `/archive`, `/copy-sections` | Year select (from the years list, `limit=50`) drives the table; year field read-only once `CLASS_YEAR_IMMUTABLE` applies; "Copy sections from…" picks a class in any year and reports created / skipped |
| Sections (class detail) | `GET /classes/:id/sections`, `POST`, `PATCH /sections/:id`, `/archive` | "Show archived" toggle |
| Subjects | `GET /subjects`, `POST`, `PATCH`, `/archive` | Code shown upper-case |

---

## Decisions made here

1. Staff-wide reads use `@RequireStaff()` (defined in slice 2), not `@AuthenticatedOnly()`, so R78
   holds by declaration.
2. An explicit `POST /academic-years/:id/activate` is added (the plan listed no way to make a year
   active); years start `planned`; several may be active; `closed` is final.
3. `academic_years` needs `UNIQUE (school_id, name)` and `subjects` a partial unique on `code` —
   flagged for `data-architect`.
4. A class counts as referenced once it has any section, so the year-immutability rule is
   testable in slice 3; slices 4 and 6 add their references to the same check.
5. Edits inside a closed year are refused; archived classes and sections are frozen; no unarchive.
6. Section capacity is informational in Phase 1.
7. Copy-sections skips existing names, making it retry-safe without an idempotency key.
8. Year span capped at 731 days as a typo guard.
