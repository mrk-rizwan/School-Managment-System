# Slice 29 contracts — terms, result settings, class subjects

**Author:** Opus 5.5 (wave M), 2026-10-07. **Binds:** `apps/api/src/modules/academics/{terms,result-settings}.*`,
the subject-list and promotion-link parts of `modules/academics/classes.*`,
`repositories/{academic-term,result-settings,class-subject}.repository.ts`,
`AcademicYearRepository.seedResults`, `common/errors/constraints-academics.ts`; the web pages
`/academics/terms` and the class page's Subjects panel. **Source:** `phase-4-academic.md` §1.1,
§3.2, §3.7, §4 "Slice 29", §5.1, slice 29 (R254–R257) and migrations
`20261007120000_phase4_message_types`, `20261007120100_phase4_groundwork`,
`20261007130000_result_bands_values` (fix round, security LOW-2). Everything not
restated follows the Phase 1–3 conventions (envelope, string ids, `PageQueryDto`, `NoQueryDto`,
`@ApiErrors()`, `404` for another school's id, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /academic-years/:id/terms` | `@RequireStaff()` | page of `TermDto`, sort `sortOrder` (default) or `-sortOrder`; unknown year `404` |
| `POST /academic-years/:id/terms` | `assessment.define` | `CreateTermDto { name 1–40, startsOn, endsOn, weight? 0–100 }` → `201 TermDto`; §2 |
| `PATCH /terms/:id` | `assessment.define` | `UpdateTermDto { name?, startsOn?, endsOn?, weight? }` (given fields) → `TermDto`; §2 |
| `POST /terms/:id/skip-class` | `assessment.define` | `SkipClassDto { classId, reason }` → `200 TermDto`; §3 |
| `POST /terms/:id/unskip-class` | `assessment.define` | the same body → `200 TermDto`; §3 |
| `GET /academic-years/:id/result-settings` | `@RequireStaff()` | `ResultSettingsDto`; unknown year `404` |
| `PATCH /academic-years/:id/result-settings` | `assessment.define` | `UpdateResultSettingsDto` (given fields) → `ResultSettingsDto`; §4 |
| `GET /classes/:id/subjects` | `@RequireStaff()` | page of `ClassSubjectDto` (live rows), sort `sortOrder` (default) or `-sortOrder`; unknown class `404` |
| `PATCH /classes/:id` | `class.manage` | existing route; gains `subjects?`, `nextClassId?`, `isFinal?`, `reason?`; returns `ClassDto` (gains `nextClassId`, `nextClassName`, `isFinal`); §5 |

**Not in this wave:** `POST /terms/:id/set-up-exams` (`ExamSetUpResultDto { created, existing,
skipped }`) needs the `assessments` table and arrives with wave N (slice 30); so does R257's
"set-up creates exactly one exam per class-subject per live section per term".

## 2. Terms (R254)

`TermDto { id, academicYearId, name, sortOrder 1–6, startsOn, endsOn, weight 0–100,
createdByUser, skippedClasses: [{ classId, className, reason, createdAt }], createdAt, updatedAt }`.
`createdByUser` is false for the two terms `asms_seed_year_results` writes with the year.

- **Seeds.** Creating a year (`POST /academic-years`) calls `asms_seed_year_results(school, year)`
  in the same transaction: the year's `result_settings` row (column defaults) and two terms,
  `Mid-term` = `[startsOn, startsOn + ⌊span ÷ 2⌋]` and `Annual` = the rest, weights 50 / 50. The
  migration ran it for every existing year, closed ones included. Idempotent.
- **Every write locks the year first** (`readLocked`), so a year's terms change one transaction
  at a time; a closed year is `409 ACADEMIC_YEAR_CLOSED`.
- **Checks, in order** (the service; the database holds the same lines):
  `endsOn < startsOn` → `422` on `endsOn`; outside the year → `409 TERM_OUTSIDE_YEAR { termId }`
  (`null` on create; trigger `academic_terms_inside_year`); overlapping another term →
  `409 TERM_OVERLAPS { termId: the other term }` (EXCLUDE `academic_terms_no_overlap`); a name the
  year has, case-insensitively → `409 TERM_NAME_TAKEN { field: 'name' }`
  (`academic_terms_name_key`); a seventh term → `422` on `startsOn`.
- **Weight default** on create: `max(0, 100 − Σ other terms' weights)`; other terms are not
  re-weighted. Term weights summing to 100 is **not** refused on `PATCH` (a re-weighting takes
  several requests); the final result renormalises over the terms assessed (A6), and the final
  sheet (wave O) is where an unequal sum is refused.
- **`sortOrder` is the rank by date** (1..n), renumbered by the service after any create or date
  change; unique per year through the deferred EXCLUDE `academic_terms_sort_order_excl`.
- **A year's dates** (`PATCH /academic-years/:id`) cannot move past a term: `409
  TERM_OUTSIDE_YEAR { termId }` (trigger `academic_years_terms_inside` behind it). New behaviour
  on an existing route: shrink the term first.
- **Deferred:** `TERM_IN_USE` (a term with an assessment or a submitted sheet cannot change dates
  or weight) arrives with `assessments` (wave N) and `result_sheets` (wave O).
- Audit: `academic_term.created { academicYearId, name, startsOn, endsOn, weight }`,
  `academic_term.updated { changes }`. A no-op `PATCH` writes nothing.

## 3. Not held for a class (§1.1)

`skip-class` marks the term not held for a class **of the term's year** (another year's class, or
an unknown one, is `422 REFERENCE_NOT_FOUND` on `classId`). A live skip already present: `200`,
no row. `unskip-class` ends the live skip (`ended_at/by`); none present: `200`, no row. Skipping
again after lifting inserts a new row; the ended one stays as history (`term_skips_live_key` is
partial on `ended_at IS NULL`). Both write `academic_term.skipped` with the reason and
`{ classId, held: false | true }` — one action, so the plan's audit list (§7.1) is unchanged.
Who reads it: the final result and the year close (waves O, P) skip a term not held for the
class; exam set-up (wave N) skips it.

## 4. Result settings (R255, §3.7)

`ResultSettingsDto { academicYearId, testWeight, examWeight, passPercent, passRule, bands:
[{ grade, minPercent }], showPosition, showAttendance, showRemark, withholdCardForDues,
notifyClassTests, locked, updatedAt }`. `locked` is always false until wave O adds result sheets
and the lock (`RESULT_SETTINGS_LOCKED`, trigger `result_settings_locked`, R256).

`PATCH` takes any of the fields; the merged row must satisfy: `testWeight + examWeight = 100`
(`422` on `testWeight`; CHECK `result_settings_weights_check`), `passPercent` 0–100, `passRule`
`all_subjects | overall`, and `bands` — the **whole table**, validated by
`@asms/shared` `bandsProblem` (1–12 bands, grades 1–4 of `[A-Za-z0-9+-]` and unique, minimums
whole percents strictly descending, the last at 0) → `422` on `bands` with the problem as the
message. Each band's `grade` is also checked by the DTO (`@Matches(/^[A-Za-z0-9+-]{1,4}$/)` on
`GradeBandDto.grade` → `422` on that band's field), and the database holds the same line: CHECK
`result_settings_band_values_check` (every element of an array `bands` is an object whose
`grade` is a string matching `^[A-Za-z0-9+-]{1,4}$` and whose `minPercent` is a whole number
0–100; a non-array is `result_settings_bands_check`'s refusal alone). The order, the band at 0 and
unique grades stay `bandsProblem`'s. A year closed → `409 ACADEMIC_YEAR_CLOSED`. Audit `result_settings.updated {
academicYearId, changes }` (bands as `A+:90 A:80 … F:0`); a no-op writes nothing.

## 5. Class subjects and the promotion link (R257, rule 30)

`ClassSubjectDto { id, classId, subjectId, subjectName, subjectCode, sortOrder 0–999,
examMaxMarks 1–1000 }`.

`PATCH /classes/:id` with `subjects: [{ subjectId, sortOrder, examMaxMarks? (default 100) }]` (at
most 40) replaces the **whole live list** (sent together with `academicYearId` → `422` on `subjects`, "Change the year
and the subjects in separate requests", refused before any lock or write, even when the year is
the class's own): a listed subject without a live row is added, one with
a row is re-ordered or re-maxed in place, a live row left out is archived (`archived_at/by`, then
frozen). Refusals: a subject listed twice → `422` on `subjects[i].subjectId`; a subject not live
in the school → `422 REFERENCE_NOT_FOUND` on `subjects[i].subjectId`; a removal without `reason`
→ `422` on `reason`. Deferred: `409 CLASS_SUBJECT_IN_USE { classSubjectId }` (archiving a subject
with marks or published results, waves N and O) and `409 CLASS_SUBJECTS_FROZEN { classId }`
(while a sheet of the class is submitted or approved, wave O). One audit row
`class.subjects_updated { added, changed, removed, removedSubjectIds }` with the reason when
anything was removed.

`nextClassId` (string or `null` to clear): another class of the school, not archived (its year is
checked when a promotion sheet opens, slice 35); itself or unknown → `422 REFERENCE_NOT_FOUND`;
archived → `422 INVALID_VALUE`. `isFinal`: a final class has no next class → `422` on `isFinal`
(CHECK `classes_next_class_check`). Both are recorded in the existing `class.updated { changes }`.

The class's lock and its year's lock are taken first, as for every class edit; an archived class
or a closed year refuses as before. The class's year cannot change once it has subjects or
skips (`class_subjects_class_id_fkey`, `term_skips_class_id_fkey`, ON UPDATE RESTRICT →
`409 CLASS_YEAR_IMMUTABLE`).

## 6. Errors added (`packages/shared` `ErrorCode`)

Every Phase 4 code of plan §5.1 is declared now (`TERM_OVERLAPS` … `PROMOTION_TARGET_INVALID`);
this slice raises `TERM_OVERLAPS`, `TERM_OUTSIDE_YEAR`, `TERM_NAME_TAKEN` (added, not in the
plan's table: a taken term name) and the existing `ACADEMIC_YEAR_CLOSED`, `REFERENCE_NOT_FOUND`,
`INVALID_VALUE`, `CLASS_YEAR_IMMUTABLE`, `CONCURRENT_UPDATE`.

## 7. Groundwork delivered with this slice

- **Message types** `result_published`, `result_revised` (SMS-eligible and allowed by default;
  default and existing rows backfilled) and `test_marked` (low, push and in-app, never SMS);
  templates in `messaging/templates.ts`; all three title-only pushes (`push-results.spec.ts`).
  Audience `result_recipients`; subject types `result`, `assessment`.
- **Enums** (`packages/shared/src/academics.ts`): every Phase 4 value set; only `pass_rule`
  exists in Postgres yet (the rest arrive with their tables).
- **Pure functions** (`packages/shared/src/results/`): `composeSubject`, `composeResult`,
  `positions`, `composeFinal`, `gradeFor`, `bandsProblem`, `defaultTermWeights`,
  `formatPercentBp`. `bandsProblem` stands in for the plan's "zod schema for bands":
  `packages/shared` has no zod dependency and pnpm cannot add one on this machine; the web wraps
  it in its zod schema (`academics/terms/_lib`).
- **`MarksScope<M>`** (`tenancy/scope.ts`, minted only in `tenancy/scope.mint.ts`), split by the
  fix round (security LOW-1): `PermissionsService.marksReadScopeOf(session, on)` →
  `MarksScope<'read'>` (marks.enter **or** marks.view_all, any-of: a school-wide view_all widens a
  teacher's read to `all`) and `marksWriteScopeOf(session, on)` → `MarksScope<'write'>`
  (marks.enter only; view_all never widens it). The scope carries a literal `mode`, so
  `MarksScope<'read'>` is not assignable to `MarksScope<'write'>`. **For wave N:** every
  repository method that writes marks or assessments takes `MarksScope<'write'>`; a method that
  only reads takes `MarksScope` (either mode); a service gets a write scope only from
  `marksWriteScopeOf`. `test/staff/marks-scope.e2e-spec.ts` holds the read/write split and the
  compile-time proof.
- **Counters and keys:** `SchoolCounterName` gains `cert_<type>`; `IDEMPOTENT_ENDPOINTS` gains
  `assessments`, `certificates`, `promotion_sheets` (the `idempotency_keys.endpoint` CHECK is a
  pattern, so no migration).
- **School settings** gain `certificate_signatory_name` and `certificate_show_identity_no`
  (columns only; their API arrives with certificates, slice 34).

## 8. Deviations from the plan

1. `set-up-exams` moves to wave N (no `assessments` table yet).
2. `academic_terms.sort_order` is unique through a **deferred** exclusion constraint rather than a
   plain unique index, so the service can renumber terms by date in one transaction.
3. `term_skips` carries `academic_year_id` (its two composite FKs bind the class and the term to
   one year) and its uniqueness is on live rows only (`ended_at IS NULL`).
4. The lock triggers that read `result_sheets` / `assessments` (`result_settings_locked`, the term
   lock, the class-subject freeze) are deferred to the waves that create those tables.
5. `TERM_NAME_TAKEN` is a new code; the bands rule is a pure function, not a zod schema in shared.
6. Plan §3.1 lists office staff as a default holder of `class.manage`; the Phase 1 role defaults
   (`packages/shared/src/capabilities.ts`) do not give it to office staff, and this wave does not
   change role defaults. The principal (or a grant) manages class subjects.
7. Fix round (2026-10-07): `PATCH /classes/:id` refuses `academicYearId` with `subjects` (§5);
   the marks scope is two typed scopes, read and write (§7); grade labels and band minimums are
   checked by the DTO and by a second CHECK in a new migration (§4).
