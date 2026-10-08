# Slice 30 contracts — assessments and marks, offline on the phone

**Author:** Opus 5.5 (wave N), 2026-10-08. **Binds:** `apps/api/src/modules/assessments/**`,
`repositories/{assessment,mark}.repository.ts`, `ClassSubjectRepository.findLive`, the slice-30
lines of `common/errors/constraints-academics.ts`; the web pages `/marks` and `/marks/[id]`; the
mobile Marks tab (`src/marks/**`, `src/app/(tabs)/marks/**`), lanes `assessment_create` and
`marks_enter`, `db/local-marks.repository.ts`, device schema migration 6. **Source:**
`phase-4-academic.md` §0.25–§0.30, §3.2, §3.8, §4 "Slice 30", §5 slice 30, §7.1, R258–R266;
`contracts/slice-29.md` §7 (MarksScope); migration `20261007160000_wave_n_assessments_certificates`.
Everything not restated follows the Phase 1–3 conventions (envelope, string ids, `PageQueryDto`,
`NoQueryDto`, `@ApiErrors()`, `404` outside the caller's scope, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /assessments` | `marks.enter` \| `marks.view_all` | page of `AssessmentDto`; filters `termId, classId, sectionId, classSubjectId, kind, includeVoided` (default false); sort `-heldOn` (default) or `heldOn`; read scope minted for **today** (§2) |
| `POST /assessments` | `marks.enter` + `Idempotency-Key` (endpoint `assessments`) | `CreateAssessmentDto { classSubjectId, sectionId, testType, name 1–80, maxMarks 1–1000, heldOn }` → `201 AssessmentDto`; replay `200` + `Idempotency-Replayed: true`; tests only |
| `GET /assessments/:id` | `marks.enter` \| `marks.view_all` | `AssessmentDto` (added: the phone's and web's single read) |
| `PATCH /assessments/:id` | `marks.enter` \| `assessment.define` | `UpdateAssessmentDto { name?, heldOn?, maxMarks? }` → `AssessmentDto` |
| `POST /assessments/:id/void` | `marks.enter` \| `assessment.define` | `ReasonDto` → `200 AssessmentDto` |
| `GET /assessments/:id/marks` | `marks.enter` \| `marks.view_all` | `AssessmentMarksDto { assessment, rows }` |
| `POST /assessments/:id/submit-marks` | `marks.enter` | `AssessmentSubmitMarksDto { entries[1..200] }` → `200 AssessmentSubmitMarksResultDto`; with `Prefer: return=minimal` → `AssessmentSubmitMarksMinimalResultDto { assessmentId, entries }` + `Preference-Applied: return=minimal`; no `Idempotency-Key` |
| `POST /marks/:id/excuse` | `result.approve` | `ReasonDto` → `200 AssessmentMarkDto` |
| `POST /terms/:id/set-up-exams` | `assessment.define` | `SetUpExamsDto { classIds? }` → `200 ExamSetUpResultDto { created, existing, skipped }`; no key |

Writes (create, submit, excuse) share the per-user bucket `marks-writes` (60/min, 1,000/h).

## 2. Scope (§0.27, R263)

Every assessment and mark repository method takes a `MarksScope` and applies it **in the
predicate** (`assessmentScopeWhere`): a section in the scope and, for a **read**, a subject taught
there or the section's class teacher / cover; for a **write**, a subject taught there only. `all`
adds no condition; an empty scope reads nothing. Reads use `marksReadScopeOf`, every write
`marksWriteScopeOf` (a `MarksScope<'write'>` parameter), so `marks.view_all` never widens a write.

- The scope is minted for the assessment's `held_on` (single reads, grid, submit, edit, void,
  excuse) — `AssessmentRepository.scopeDateOf` / `MarkRepository.scopeDateOf` return that date and
  nothing else; `GET /assessments` mints for today; `POST /assessments` for the body's `heldOn`;
  set-up for the term's last day.
- Outside the scope: `404`. On create only, a section the caller holds on other dates is `403
  PERMISSION_DENIED { reason: not_assigned_on_date }` (`refuseOutsideDate`, as diary and
  registers), and a section in scope with another subject is `409 SUBJECT_NOT_ASSIGNED` (a class
  teacher writes only a subject they teach). On create the write scope is minted right after the
  section is read and checked before the class subject is looked up (wave N review), so a section
  outside it is the same `404` whether `classSubjectId` is real or not.
- Matrix (tested): the Maths teacher of 6-A reads neither 6-B nor 6-A English (`404`); the class
  teacher reads every subject of 6-A and writes none they do not teach; a cover reads the section
  on its dates only; the principal and an office grant of `marks.enter` are `all`; a teacher with
  a `marks.view_all` grant reads every section and still writes only their assignments.
- `AssessmentDto.canEnterMarks` says whether the caller's write scope **on held_on** reaches it and
  it is neither voided nor locked (one mint per distinct date in a list page).

## 3. The grid and submit-marks (R261, R262, R265)

`AssessmentMarksDto.rows`: the section's enrolments in force on `held_on` (a joiner after it is
not listed; a student who moved section after it stays on the old section's grid), by roll number
then name, each `{ enrolmentId, student { id, fullName, admissionNo, rollNo }, markId, obtained,
absent, excused, status (live | null), enteredAt, ownChildOf }`. `ownChildOf` is the caller's user
id when the caller's guardian record has a live link to the student (display only; refusals use
the merge-resolved `actorIsGuardianOf`).

`MarkEntryDto { enrolmentId, obtained? | absent: true, clientEntryKey (^[A-Za-z0-9_-]{16,64}$, no
13-digit run), basedOnMarkId (string | null) }`. One transaction under the assessment's row lock
(compare-and-set on `updated_at`, schema notes). Refused whole: `422` for a repeated enrolment or
an entry with both or neither of a mark and an absence; `409 MARK_EXCEEDS_MAX { enrolmentId, max }`;
`409 ASSESSMENT_VOIDED`, `409 ASSESSMENT_LOCKED` (a test with `locked_at`), `409
ACADEMIC_YEAR_CLOSED`. Then per entry, in request order:

1. not on the grid → **omitted** from `entries` (nothing written);
2. a row already written with this `clientEntryKey` for this enrolment (a resend) → its original
   outcome (`created` / `superseded`) and id while it is live, else `changed_elsewhere`;
3. the live mark id ≠ `basedOnMarkId` (null = "I saw none") → `changed_elsewhere`, `markId` = the
   live one, nothing written;
4. the same value as the live mark → `unchanged`;
5. otherwise the live row is marked `superseded` and a new live row inserted (`supersedes_id`, no
   reason: a plain re-entry) → `superseded`, or `created` when there was none.

No audit row (plan §7.1: the supersedes chain with `entered_by/at` is the history). `test_marked`
(R266): only for a test, only with the year's `notify_class_tests` on, only for a student's
**first** mark (`created`), one message per student to the live guardians (not merged away) and
the student's own active login when student logins are on; the type's channels are push (title
only) and in-app, never SMS.

## 4. Edit, void, excuse

- **PATCH**: the creator or an `assessment.define` holder, inside the caller's write scope of
  `held_on` (else `404`; in scope but neither → `403 not_author`). Refused once any mark of any
  status exists → `409 ASSESSMENT_HAS_MARKS` (also the trigger and `marks_assessment_max_fkey`); a
  `heldOn` outside the assessment's term → `409 ASSESSMENT_OUTSIDE_TERM`; a new `heldOn` the
  caller does not hold → `422` on `heldOn`; voided `409 ASSESSMENT_VOIDED`; locked `409
  ASSESSMENT_LOCKED`. A no-op is free (no audit). Audit `assessment.updated { changes }`.
- **void**: same gate; the void trio set once; marks stay as history. Audit `assessment.voided`
  with the reason and `{ kind, sectionId, termId }`. A voided assessment frees `TERM_IN_USE` and
  the exam slot (set-up recreates it).
- **excuse** (`result.approve`, within the caller's marks write scope — the principal's is `all`):
  a live, not yet excused absence → a new live row `absent, excused, correction_reason = reason,
  entered_by = approver` superseding it, under the assessment's lock; a locked test still takes
  it. Otherwise `409 ILLEGAL_STATUS_TRANSITION { markId }`. Own child: `409 SELF_ACTION_FORBIDDEN
  { reason: own_child }` unless the sole principal (`ownChildCheck`, audited `selfApproved`).
  Audit `mark.excused { markId, supersedesId, enrolmentId, selfApproved }`.

## 5. Exam set-up (R257)

For the term's year (closed → `409 ACADEMIC_YEAR_CLOSED`), every active class (or `classIds`, each
an active class of that year, else `422 REFERENCE_NOT_FOUND` on `classIds[i]`): one exam per live
class-subject per live section, named `<Term> exam`, `max_marks` from `exam_max_marks`, `held_on`
the term's last day (both editable until a mark exists), created by the caller. Idempotent:
`assessments_exam_key` with `skipDuplicates`; a pair with a live exam counts as `existing`; a class
the term is not held for counts its pairs as `skipped`. Pairs outside the caller's write scope are
left out (the principal's is `all`). Audit `exams.set_up { classIds, created, existing, skipped }`
only when something was created.

## 6. Errors (constraint mappings, `constraints-academics.ts`)

`assessments_held_on_in_term` → `ASSESSMENT_OUTSIDE_TERM`; `assessments_has_marks`,
`marks_assessment_max_fkey` → `ASSESSMENT_HAS_MARKS`; `assessments_voided_frozen`,
`marks_assessment_voided` → `ASSESSMENT_VOIDED`; `marks_assessment_locked` → `ASSESSMENT_LOCKED`;
`marks_obtained_check` → `MARK_EXCEEDS_MAX`; `assessments_exam_key`, `marks_live_key`,
`marks_pending_key`, `marks_client_entry_key`, `marks_supersedes_key` → `CONCURRENT_UPDATE`.
`TERM_IN_USE` and `CLASS_SUBJECT_IN_USE` (wave M's deferred locks) answer from the wave-N triggers.

## 7. Audit (R57)

`assessment.updated`, `assessment.voided`, `mark.excused`, `exams.set_up`. `POST /assessments` and
`submit-marks` write none (classified `none:` in `routes.e2e-spec.ts`).

## 8. Web

`/marks`: the caller's assessments (section filter chips from `/me` assignments), "New test"
(sections where the caller teaches a subject, the class's subjects they teach, a key per opened
form). `/marks/[id]`: the grid — Enter / ↓ / ↑ move between rows, a mark or "Absent", Save sends
only the changed rows, each with its own entry key (kept while its value is unchanged, so a retry
is a replay) and `basedOnMarkId`; a "Changed elsewhere" banner names the rows not saved; read-only
with the reason when `canEnterMarks` is false; "Excuse" on a live absence for `result.approve`.
Nav "Marks" for `marks.enter | marks.view_all`. Playwright `e2e/marks.spec.ts`.

## 9. Mobile (§3.8)

- **Marks tab** (`composeTabs`: staff with assignments holding `marks.enter` or `marks.view_all`),
  after Classes. A teacher's bar becomes Home, Classes, Marks, Inbox, More (Calendar, Account).
  Sections (from assignments) → the section's tests (`GET /assessments?sectionId&limit=50`, cached)
  with the tests made on the phone above them → the grid (`GET /assessments/:id/marks`, cached;
  **secure**). "New test" for a subject the caller teaches on the section.
- **Lanes** (`lanes.ts`): `assessment_create` → `POST /assessments`, `idempotencyHeader: true`,
  `domainTable: 'local_assessments'`, remedies `ASSESSMENT_OUTSIDE_TERM | SUBJECT_NOT_ASSIGNED |
  VALIDATION_FAILED | INVALID_VALUE | REFERENCE_NOT_FOUND → edit_resend`. `marks_enter` → `POST
  /assessments/:id/submit-marks`, `idempotencyHeader: false`, `Prefer: return=minimal`,
  `coalesces: true` (natural key `assessment:<id>`, entries merged by enrolment, latest wins),
  `domainTable: 'local_assessment_marks'`, remedies `MARK_EXCEEDS_MAX → edit_resend` (the grid
  offers "Discard and enter again"), `ASSESSMENT_LOCKED → discard`; `changed_elsewhere` is a
  per-row outcome of a 200: the row is marked and the grid offers "Reload".
- **Re-target**: marks typed on a test still on the phone wait (no outbox row) and are queued as
  one `marks_enter` row in the transaction that writes the test's server id
  (`markAssessmentSaved`); `recoverWaitingMarks` at startup. Their roster comes from the newest
  cached grid of another test of the section ("open one once while connected" otherwise).
- **Claim** (wave N review, every lane): the worker moves a row from `pending` to `sending` with
  one conditional `UPDATE ... WHERE state = 'pending'` (`claimPending`) and sends the row as read
  after the claim. It never writes back the body the scan read, so a Save that merged into the
  pending row between the scan and the send is part of what is sent (`outbox/claim.spec.ts`, for
  `marks_enter` and `submit_register`).
- **Re-base**: when a `marks_enter` row lands, an entry queued behind it for the same student and
  based on the same mark is re-based on the mark it made (pending outbox body and local row), so it
  never comes back `changed_elsewhere` against the phone's own write.
- `ONLINE_ONLY_ACTIONS` gains `edit_assessment`, `void_assessment`, `excuse_mark` (none is offered
  on the phone yet).
- Maestro `teacher-marks-offline.yaml`, wired into `ci-run.sh` after `teacher-diary` (English put
  on Class 5's list and a 5 B test created over `curl`; two marks checked over `curl` after).
  Every `curl` that carries a bearer token reads it from a config on a file descriptor
  (`-K <(auth "$token")`), never from its command line.

## 10. Deviations from the plan

1. `GET /assessments/:id` added (a single read for the web and the phone).
2. The mobile mark table is `local_assessment_marks`, not `local_marks` (the plan's name is taken
   by the attendance register's marks since slice 16); tests made on the phone live in
   `local_assessments`.
3. `GET /assessments` mints the read scope for today (a list spans many dates); single reads mint
   for `held_on`. A cover therefore lists a section's tests while covering and opens only those
   held inside the cover's dates.
4. PATCH / void by an `assessment.define` holder still run inside the caller's marks write scope
   (the repositories take it); the principal's is `all`. A custom role holding `assessment.define`
   or `result.approve` without `marks.enter` cannot edit, void or excuse (none exists by default).
5. An entry for a student not on the grid is omitted from the answer rather than refused
   (plan: "omitted with 404 semantics"); the phone drops such a local row.
6. `test_marked` only for a student's first mark on a test (not on a re-entry).
7. Exams are dated the term's last day at set-up.

## 11. Left for wave O (result sheets)

- The exam half of "locked": an exam whose section-term sheet is `submitted` or later takes no
  live mark (trigger and service), and its void after a sheet is submitted; tests' `locked_at`
  set at sheet submission.
- `POST /assessments` refusing `RESULT_SHEET_NOT_DRAFT` when the section-term sheet is submitted.
- `TERM_IN_USE` for a submitted sheet; `CLASS_SUBJECT_IN_USE` for published results.
- `MarkReadsRepository` (read-only) for the results module; corrections (`pending` rows) in
  slice 32; excusal after publication is a correction.

## Phase 4 close (slice 36, 2026-10-08)

- **Set-up date.** `POST /terms/:id/set-up-exams` takes an optional `heldOn` (YYYY-MM-DD) inside
  the term; default the term's last day. Outside: 422 `VALIDATION_FAILED`, field `heldOn`, code
  `ASSESSMENT_OUTSIDE_TERM`. Exams that already exist keep their date. The set-up's own write scope
  is minted for that date.
- **The marks scope of an exam is the day of entry.** For an **exam**, every marks read and write
  (grid, `GET /assessments/:id`, `canEnterMarks`, submit-marks, excusal, correction request and
  decision, `GET /mark-corrections/:id`) mints its scope for **today (school time) when today lies
  inside the exam's term**, else for `held_on` (`marksDateOf`, `assessments.shared.ts`): exam marks
  are entered after the exam by whoever teaches then, so a cover or substitute whose dates hold the
  day of entry reaches an exam dated the term's end. **A test stays on its `held_on`**, and an
  assessment's edit and void stay on `held_on` whatever the kind. A `cover` row still writes no
  subject the cover does not teach (R263 unchanged): the substitute needs a dated subject
  assignment. Test: `test/assessments/assessments.e2e-spec.ts` ("slice 36: set-up takes a heldOn…").
- **submit-marks writes in two statements.** Every entry is decided in memory first (resend,
  `changed_elsewhere`, `unchanged`, the lock), then one `updateMany` supersedes the replaced live
  rows and one `createManyAndReturn` inserts the new ones (`MarkRepository.supersedeMany`,
  `insertLiveMany`); the per-row outcomes and `marks_live_key` are unchanged. Under the
  assessment's row lock the live rows cannot move; should the supersede count differ, the whole
  request is `409 CONCURRENT_UPDATE` (before, that row alone answered `changed_elsewhere`; it cannot
  happen under the lock). Budget: 60 rows within 500 ms (`test/assessments/submit-perf.e2e-spec.ts`,
  warmed once; measured 190 ms locally).
- The term's assessments and their live marks are read in two statements (no nested relation),
  so the planner uses the marks indexes (`MarkReadsRepository.termAssessmentsWithMarks`).
- `TEST_TYPE_LABELS` and `markDraftProblem(text, max)` ("Whole number" / "At most N") moved to
  `packages/shared` `academics`; the web grid and the phone use them.
