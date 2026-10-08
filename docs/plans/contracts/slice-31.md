# Slice 31 contracts — result sheets: compose, submit, approve, publish

**Author:** Opus 5.5 (wave O), 2026-10-08. **Binds:** `apps/api/src/modules/results/**`,
`repositories/{result-sheet,result,mark-reads}.repository.ts`, `TeacherAssignmentRepository.{coverAssignmentOn,hasClassTeacherOn}`,
`StudentGuardianRepository.guardianPairs`, `AttendanceReportRepository.percentageForStudents`,
`AssessmentRepository.lockingSheets`, `PermissionsService.sheetReadScopeOf`, the slice-31 lines of
`common/errors/constraints-academics.ts`, the `results` section of `GET /me/approvals`, the
`result-notify` job; the web pages `/results/sheets` and `/results/sheets/[id]` and the Approvals
page's Result sheets queue; the phone's sheet under Marks and Approvals. **Source:**
`phase-4-academic.md` §0.25–§0.30, §1.1, §1.3 (A5, A6, A9, A14), §3.2, §3.3, §3.5, §3.6, §4
"Slice 31", §5 slice 31, §7.1, §7.2, R267–R278, R296; migration
`20261008120000_wave_o_result_sheets`. Everything not restated follows the Phase 1–3 conventions
(envelope, string ids, `PageQueryDto`, `NoQueryDto`, `@ApiErrors()`, `404` outside the caller's
scope, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `POST /sections/:id/result-sheets` | `marks.enter` \| `assessment.define` | `CreateResultSheetDto { termId: string \| null }` → `201 ResultSheetDetailDto`; the open version again → `200`; §2.1 |
| `GET /result-sheets` | `marks.enter` \| `marks.view_all` \| `result.approve` | page of `ResultSheetDto`; filters `termId`, `final` (`true`: final sheets only), `classId`, `sectionId`, `status`; sort `-updatedAt` (default), `updatedAt`, `submittedAt`. Only `status=submitted` (the approvals queue) composes its rows for the own-child flags, and that page is capped at 10 (`limit` answered as 10); every other list composes nothing and carries no flags |
| `GET /result-sheets/:id` | the same | `ResultSheetDetailDto` (§2.3) |
| `PATCH /result-sheets/:id` | `marks.enter` \| `assessment.define` | `UpdateResultSheetDto { remarks: [{ enrolmentId, remark: string(1–300) \| null }] }` (1–200, the given rows only; `null` clears) → detail |
| `POST /result-sheets/:id/submit` | `marks.enter` \| `assessment.define` | no body → `200` detail |
| `POST /result-sheets/:id/return` | `result.approve` | `ReasonDto` → `200` detail |
| `POST /result-sheets/:id/approve` | `result.approve` | no body → `200` detail (published too when the approver holds `result.publish`) |
| `POST /result-sheets/:id/publish` | `result.publish` | no body → `200` detail |
| `GET /me/approvals` | existing | gains `results?: { count, items: ResultSheetDto[] }` for a `result.approve` holder: exactly `GET /result-sheets?status=submitted` (first ten, its default sort) (R278) |

The writes share the per-user bucket `result-sheet-writes` (30/min, 300/h); the two GETs (both
may compose) share `result-sheet-reads` (120/min, 2000/h).

## 2. Behaviour

### 2.0 Scope (§3.1, §0.27)

The sheet read scope is `PermissionsService.sheetReadScopeOf(session, today)`: `marks.enter`,
`marks.view_all` or `result.approve`, any-of, read mode. A school-wide key (the principal, an
office grant of `marks.view_all`) reads every section; a teacher reads the sections they
class-teach or cover today (`sheetScopeWhere`, applied by every sheet and result repository
method). A subject teacher reads no sheet. Outside: `404`.

**Authorship** (remarks, submit; §1.1 "Who submits"): the section's class teacher or cover today
(the cover's assignment id is recorded), or, when the section has no class teacher today, an
`assessment.define` holder. Anyone else who reads the sheet: `403 PERMISSION_DENIED { reason:
not_class_teacher }`.

### 2.1 Create (R267, R275)

The section in the caller's scope and either authorship or `assessment.define` (else `404`); live
(`409 SECTION_ARCHIVED`), its class active, its year not closed (`409 ACADEMIC_YEAR_CLOSED`).
`termId` must be a term of the class's year (`422 REFERENCE_NOT_FOUND` on `termId`) held for the
class (`422 INVALID_VALUE` on `termId`). `termId: null` is the final sheet: the year's term weights
sum to 100 with a held term weighing more than 0 (`422 INVALID_VALUE` on `termId`), and every
held term has a published sheet for the section (`409 RESULT_SHEET_TERMS_UNPUBLISHED {
missingTermIds }`). An open (not published) version → `200` with it. A published one and no open
one → `409 RESULT_SHEET_PUBLISHED { sheetId }` (a new version is a correction, slice 32).
Otherwise version 1, `draft`. Audit `result_sheet.created { sectionId, termId, version }`. A GET
never writes.

### 2.2 The preview and the composition (§0.25, §0.26, §3.3, R270)

`ResultComposer.term` reads, under the caller's scope: (1) every enrolment in the class of each
student with an enrolment of the section in force on the term's last day (the roster: those
in-force section enrolments, by roll number then name — a student who left before is not on it,
A9); (2) the class's non-voided assessments of the term (every section's) with the roster's live
marks; (3) one attendance aggregate over the term's dates; (4) the own-child set. An assessment
**applies** to a student when an enrolment of theirs of its section was in force on its
`held_on` (the grid's rule): a section change brings the old section's marks (§0.25); a class
change does not (A14); a joiner's earlier tests do not apply. Per live class-subject (by
`sort_order`): the applying tests with a live mark, the applying exam (the one with a mark, else
the first), printed max = the exam's max, else the class-subject's `exam_max_marks`;
`composeSubject`, then `composeResult` and `positions` (within the section, A5). A test or exam
that applies with no live mark is a **gap** (left out of the preview's figures).

`ResultComposer.final` composes each student's published, live term results of the class and year
with `composeFinal` (held terms only, A6; weights renormalised per subject), the year's
attendance, subject names and order from the latest term snapshot.

`ResultSheetDetailDto extends ResultSheetDto { source: preview | stored, settings, subjects,
preview: ResultPreviewRowDto[], flags { ownChild, cover, selfApproved, missing (≤ 100),
missingCount, examsNotSetUp }, canRemark, canSubmit, canDecide, canPublish }`. `canRemark`:
authorship (§2.0) and `draft | returned`, the final sheet included; `canSubmit`: `canRemark` on a
term sheet; `canDecide`: `result.approve`, a decidable status, and not the submitter unless the
sole active principal (asked without the settings lock: a GET takes none; the decision re-asks
under it); `canPublish`: `result.publish` and `approved`. While `draft`, `submitted`
or `returned` the preview is the live composition with the year's live settings (never stored);
once `approved` or `published` it is the stored rows with the sheet's snapshot.

**Own-child flags** (R276): per student, `[{ userId, role }]` for each contributor who is a
guardian of the student (merge-resolved, live link; `StudentGuardianRepository.guardianPairs`) —
`mark_author` (any contributing live mark's `entered_by`), `remark_author`, `submitter`,
`approver` (at approval the approver; in a preview the reader when they hold `result.approve`, so
the inbox shows the flag their approval would carry). Recomputed at every composition, never
copied; a final sheet also carries its term results' flags. `ResultSubject.ownChildOf` names a
flagged mark author of that subject. The sheet's `ownChildFlags` is the distinct union. In the
list only the `status=submitted` query carries them (the queue, at most 10 a page); the detail carries them for every status.

**Attendance** (R277): `AttendanceReportRepository.percentageForStudents`, the rules of
`GET /students/:id/attendance` in one statement (teaching days from weekly-off days and
published holidays; a day counts when the student had any enrolment in force and something was
recorded; `dayValue()`), one decimal half-up; stored as basis points (`92.3 % → 9230`).

### 2.3 Remarks

The given rows, draft or returned only (`409 RESULT_SHEET_NOT_DRAFT`; trigger
`result_sheet_remarks_open` behind it), each enrolment once (`422` on `remarks[i].enrolmentId`)
and on the sheet's roster (`422 REFERENCE_NOT_FOUND`); `null` clears (the row stays). One row per
sheet and enrolment, updated in place with its writer (`written_by`); no audit row (a draft's
text; plan §7.1 audits the transitions). Approval copies the text into `results.remark`.

### 2.4 Submit (R268)

A term sheet (`409 ILLEGAL_STATUS_TRANSITION` for the final sheet), `draft | returned`
(`409 RESULT_SHEET_NOT_DRAFT`), authorship (`403`), the year open. The live composition: a
live class-subject without the section's exam → `409 EXAM_NOT_SET_UP { classSubjectId,
sectionId, termId }` (the first); any gap → `409 MARKS_INCOMPLETE { missing: [{ enrolmentId,
assessmentId }] }` (≤ 100). Then `submitted` with `submitted_by/at` and
`submitted_under_assignment_id` (a cover's), the decision and return reason cleared. **What it
locks** (the slice-31 review): a `result_sheet_locks` row for every live test of the class-term
the sheet holds — the section's own, and any other section's carrying a live mark of a roster
student (a moved student's old-section test, §0.25) — and one for every roster student; each such
test is stamped `locked_at` once (one another sheet locked keeps its stamp). A roster student's
mark on **any** assessment of the class-term (an old-section exam included) is then locked: no
new live mark but an excusal (`asms_mark_student_locked` in the mark insert guard; the service
refuses first with `ASSESSMENT_LOCKED`), and no void of an assessment carrying one
(`assessments_void_locked`). The submission record (`submitted_by`, `submitted_at`,
`submitted_under_assignment_id`) changes only on the `draft | returned → submitted` edge
(trigger `result_sheets_submission_frozen`). Audit `result_sheet.submitted { cover,
assignmentId, lockedTests }`.

### 2.5 Return (R269, R271)

`result.approve`; `submitted | approved` (`409 RESULT_SHEET_NOT_SUBMITTED`); never by the
submitter (`409 SELF_ACTION_FORBIDDEN { reason: submitter }`) except the sole active principal;
the year open. `returned` with the decider and the reason; from `approved` that version's stored
rows are superseded (`superseded_at`); the sheet's lock rows are released (`released_at`, never
deleted) and exactly the tests it locked unlock (`locked_at` cleared), except any another
unreleased lock row still names — a test two sheets hold stays locked until both are returned. The
tests' rows are taken `FOR UPDATE` in id order on both sides, so a concurrent submission and
return serialise. Audit
`result_sheet.returned { from, supersededResults, unlockedTests }` with the reason.

### 2.6 Approve (R269–R272, R275)

Under the sheet's row lock (compare-and-set on `updated_at`): a term sheet must be `submitted`
(`409 RESULT_SHEET_NOT_SUBMITTED`); the final sheet `draft | returned | submitted` (it has no
submitter and enters review in the same transaction, so the status edges stay the six of §3.2).
The approver is not the submitter (`409 SELF_ACTION_FORBIDDEN { reason: submitter }`), except the
sole active principal (`PermissionsService.isSolePrincipal`, recorded `self_approved`). The year
open. The composition of §2.2 with the approver; a term sheet's gaps or missing exams refuse as at
submission (the roster may have changed; marks cannot, they are locked). The settings snapshot
(`test_weight`, `exam_weight`, `pass_percent`, `pass_rule`, `bands`; the final's `term_weights
[{ termId, weight, held }]`) goes onto the sheet with `approved`, `decided_by/at`,
`self_approved`; then the full row set: `results` in one `createManyAndReturn`, `result_subjects`
in one `createMany`. Audit `result_sheet.approved { results, ownChildFlags (userId:role,…),
cover, selfApproved }`. When the approver holds `result.publish`, it publishes in the same
transaction (§2.7). Measured: 60 students × 12 subjects × 15 tests in about 0.9 s on a
developer machine (budget 2 s, `test/results/approve-perf.e2e-spec.ts`).

### 2.7 Publish (R272, R273)

`result.publish`; `approved` (`409 RESULT_SHEET_NOT_APPROVED`). **Publishing after the year
closes is allowed** (decided in the slice-31 review): it changes no mark and no figure, only makes
the stored rows visible; every other transition refuses a closed year. `published` with
`published_by/at`; the live rows get `published_at`; `result-notify { sheetId }` is enqueued after
commit through `OutboxDispatcher.resultNotifyAfterCommit`. Audit `result_sheet.published
{ results }`.

## 3. Errors and constraint mappings (`constraints-academics.ts`)

`result_sheets_open_key` → `RESULT_SHEET_VERSION_OPEN`; `result_sheets_status_transition` →
`ILLEGAL_STATUS_TRANSITION`; `result_sheets_not_self`, `result_sheets_self_approved_unwarranted`
→ `SELF_ACTION_FORBIDDEN { reason: submitter }`; `result_sheet_remarks_open` →
`RESULT_SHEET_NOT_DRAFT`; `result_settings_locked`, `academic_terms_results_locked` →
`RESULT_SETTINGS_LOCKED`; `class_subjects_frozen` → `CLASS_SUBJECTS_FROZEN`;
`assessments_sheet_not_draft` → `RESULT_SHEET_NOT_DRAFT`; `assessments_void_locked` →
`ASSESSMENT_LOCKED`; `result_sheets_submission_frozen` → `ILLEGAL_STATUS_TRANSITION`;
`result_sheet_locks_sheet_submitted`, `_release_returned`, `_test_of_class_term`, `_open_test_key`,
`_open_student_key` → `CONCURRENT_UPDATE`; the version, remark, live and per-sheet uniques → `CONCURRENT_UPDATE`.

## 4. The wave-O deferrals of waves M and N

- **R256 `result_settings_locked`:** a year's composition settings (`test_weight`, `exam_weight`,
  `pass_percent`, `pass_rule`, `bands`) are frozen once any sheet of the year is approved or
  published; the display, withholding and notification toggles stay editable. Term dates and
  weights likewise (`academic_terms_results_locked`, also on a new term).
- **TERM_IN_USE:** also once a sheet of the term has left `draft`.
- **CLASS_SUBJECTS_FROZEN:** no class-subject insert or change of order, max or archiving while a
  sheet of the class is `submitted` or `approved`.
- **CLASS_SUBJECT_IN_USE:** also a class-subject on a published result.
- **The assessment lock (R265), one predicate** (`asms_assessment_sheet_locked`): an assessment
  whose section-term sheet is `submitted`, `approved` or `published` (any version) takes no live
  mark but an excusal, no new assessment (`RESULT_SHEET_NOT_DRAFT`, also refused by the service on
  `POST /assessments`), and no void (`ASSESSMENT_LOCKED`, also by the service on PATCH and void);
  submit-marks refuses it (`ASSESSMENT_LOCKED`). `AssessmentDto` gains `locked` (the test's
  `locked_at` or the sheet's lock). Exam set-up skips a section whose sheet locks it (counted
  `skipped`).
- The per-student half (the slice-31 review): a mark of a student an unreleased
  `result_sheet_locks` row of a sheet of the same class and term names is locked whatever the
  assessment's section, until that sheet is returned; a published sheet's rows are never released
  (only slice 32's correction path changes such a mark).
- Tests' `locked_at` is stamped at submission and cleared by a return (only when no other sheet
  holds the test); wave N's
  `assessments_locked_frozen` is replaced by `assessments_locked_at_guard` (set once, cleared,
  never moved).

## 5. `result-notify` (§3.5, §3.6, R273)

Queue `messaging`, payload `{ schoolId, sheetId }` (or, for slice 32, `{ schoolId, resultId }`),
job id `result-notify-<sheetId>[-s<minute>]`. In `QueueTenancy.runAsSchool`, under the 120 s job
limit: the first statement claims the target's rows that are published, live and not yet told
(`notified_at` stamped); a replay, a superseded or an unpublished row claims nothing. One message
per claimed student: `result_published` (`result_revised` for a `revised` row) to the receipt
rule's guardians (fee payers, else primary contacts, else every live guardian not merged away)
and the student's own login when student logins are on and it is active; vars name, term (`Final`
for the final) and percentage and grade only (§3.5), SMS allowed by default, push title-only
(`TITLE_ONLY_PUSH`). The outbox sweep re-enqueues a sheet whose published rows are still untold
two minutes on.

## 6. Schema (migrations `20261008120000_wave_o_result_sheets`; from the slice-31 review `20261008140000_wave_o_review_fixes` and `20261008150000_result_sheet_locks`)

`result_sheets`, `result_sheet_remarks`, `results`, `result_subjects` per plan §3.2 and §4, with
the hand-written objects listed in `test/guardrails/schema-checks.ts` (`WAVE_O_OBJECTS`):
`result_sheets_open_key` / `_version_key` (COALESCE(term_id, 0)), the version, decided,
self-approved, return-reason, published, submitted and snapshot CHECKs, the insert guard (born
`draft`; a correction's version born `published`), `asms_status_transition` with the six edges
(BEFORE UPDATE only), `result_sheets_not_self` (the sole-principal exception, the final sheet
exempt), the snapshot frozen while approved or published, the columns frozen; remarks only while
the sheet is draft or returned; results only onto an approved or published sheet, for its year
and term and an enrolment of its section, `results_live_key` (enrolment, COALESCE(term_id, 0))
and `results_sheet_enrolment_key` on live rows, the figure CHECKs, frozen after insert but
`published_at`, `superseded_at/by`, `notified_at` (each set once); result_subjects frozen after
insert, the class-subject FK with name and order snapshots; no delete, no truncate, `school_id`
immutable on all four.

From the review: `result_sheet_locks (school_id, sheet_id, assessment_id | student_id, created_at,
released_at)` — exactly one target (`result_sheet_locks_target_check`), composite foreign keys to
the sheet, the test and the student, one unreleased row per sheet and target (partial uniques),
inserted only onto a `submitted` term sheet and only a test of its class-term, released only once
the sheet is `returned`, `released_at` set once, columns frozen, no delete, no truncate, `school_id`
immutable; `asms_mark_student_locked` and the widened mark-insert and assessment-void guards;
`result_sheets_submission_frozen`. (The review's first step, `20261008140000`, put the lock sets in
two id arrays on `result_sheets`; the schema guard refuses an `*_ids` column without a foreign
key, so `20261008150000` drops them for the table. Both are kept: the first was already applied.)

## 7. Audit (R57)

`result_sheet.created`, `result_sheet.submitted`, `result_sheet.returned`,
`result_sheet.approved` (with the flags, `cover` and `selfApproved`), `result_sheet.published`.
`PATCH /result-sheets/:id` writes none (classified `none:` in `routes.e2e-spec.ts`).

## 8. Web and phone

Web: Results → Sheets (`/results/sheets`: year, term (or Final) and status filters; "Open a sheet"
for a section the caller class-teaches or covers, or any section with `assessment.define`) and the
sheet (`/results/sheets/[id]`: status, flags, the preview table with per-subject marks and grades,
totals, percentage, grade, position, attendance; remarks edited in place and saved (the changed
rows only), Submit, Return with a reason, Approve, Publish — each shown as the detail's `can*`
says). The Approvals page gains the Result sheets queue and tile. Nav "Results" for
`marks.enter | marks.view_all | result.approve`. Playwright `e2e/results.spec.ts` (mocked).

Phone (online only, secure): the class teacher's "Result sheet" on a section's Marks screen → the
term picker (`/marks/[sectionId]/sheet`) → the sheet (`/marks/sheet/[id]`: preview, remarks,
submit); the principal's Approvals → Result sheets → the sheet (`/approvals/sheet/[id]`: preview,
approve, return, publish). `ONLINE_ONLY_ACTIONS` gains `open_result_sheet`, `save_result_remarks`,
`submit_result_sheet`, `approve_result_sheet`, `return_result_sheet`, `publish_result_sheet`.
Maestro `principal-approve-result.yaml`, wired into `ci-run.sh` after `principal-approvals`.

## 9. Deviations from the plan

1. `results` is unique per sheet and enrolment on **live** rows (`results_sheet_enrolment_key`),
   not on all rows: a version returned from approved and approved again writes a second row set
   onto the same sheet row (the first superseded).
2. `result_subjects`' exam CHECK is `NOT (exam_absent AND exam_obtained IS NOT NULL)` with
   `exam_max` null when there was no exam (a final result, a subject without one), instead of
   `(exam_obtained IS NULL) = exam_absent`, which a final result could not satisfy.
3. `results.failed_subjects` is a count; `results.notified_at` added (the job's claim).
   `result_sheets.created_by` added. Remarks are nullable (a cleared remark keeps its row).
4. The final sheet passes through `submitted` inside the approving transaction (no submitter), so
   the status trigger keeps exactly the six edges.
5. The final sheet's weight rule: the year's term weights sum to 100 with a held term above 0
   (not "held weights sum to 100", which a class with a term not held could never meet; A6
   renormalises).
6. Attendance is aggregated per student (all their enrolments), matching `GET
   /students/:id/attendance` (R277), rather than per enrolment.
7. A custom role holding `result.approve` but neither `marks.*` key reads sheets through
   `sheetReadScopeOf` (it includes `result.approve`); `assessment.define` alone without a marks or
   result key reads none.
8. R274's family routes are slice 33; nothing in this slice exposes a result to a family.
9. (Review) Publication is allowed after the year closes (§2.7).
10. (Review) A submission locks more than the plan's "the section's tests": the class-term tests
    the sheet holds and its roster's marks on every assessment of the class-term (§2.4), so a
    moved student's old-section marks cannot change under a submitted sheet.

## 10. Left for slices 32, 33, 35

- **32:** corrections (`POST /marks/:id/correct`, `mark-corrections`): a new version born
  `published` (`supersedes_id`, full row set, `revised`, `supersedes_id` per row, the old rows'
  `superseded_by`), the rows not re-told inserted with `notified_at` set, `result-notify
  { resultId }` (the runner and `claimForNotify` already take it; a `revised` row sends
  `result_revised`); the published final sheet re-composed; excusal after publication; report
  cards and prints (`PrintThrottleGuard` from certificates); withholding.
- **33:** family and student routes (R274, R285–R288), reports.
- **34 (wave N's TODO):** `CERTIFICATE_NO_RESULT` and the marks table on academic/completion
  certificates now that published results exist.
- **35:** promotion reads `results` (FK target `(school_id, id, enrolment_id)` exists).

## Phase 4 close (slice 36, 2026-10-08)

- **`ResultSheetFlagsDto.ownChild` is removed** (it duplicated `ownChildFlags` on the sheet). The
  web sheet reads `ownChildFlags`.
- The final sheet's readiness (held weights summing to 100, every held term published for the
  section) is one helper, `ResultSheetsService.finalWeights`, used by create and approve; approve
  checks the year open once. `subjectHeadersOf(rows)` (result-composer) builds the subject headers
  of stored or composed rows (the detail, the final, a correction); `newResultOf(sheet, row)` maps a
  composed row to a stored result; `subjectFiguresDto` is the base of both subject DTOs. Pure
  moves: no figure or answer changes.
- A sheet's stored results and a card's subjects are read in two statements (results, then
  `result_subjects` by `(school_id, result_id)`), never a nested relation read.
- **Index** `results_unnotified_idx` on `results (school_id, sheet_id) WHERE notified_at IS NULL AND
  superseded_at IS NULL` (migration `20261008210000_phase4_close`) serves the result-notify sweep;
  partial, so not declared in `schema.prisma`; the schema guard holds it.
- `result-notify`: `NotificationService` has no batch send; the job still sends per result (the
  budget holds), as before.
- R296 is complete in `test/results/scripted-section.e2e-spec.ts`: a second held term, the two-term
  final against `composeFinal`, an unexcused exam absence composed to 0, a term remark on the card,
  own-child flags for the remark author, the submitter and the approver, a correction after
  publication that re-ranks the section and re-composes the final (every figure against the pure
  functions), and a withheld card released by a payment while `result_published` still goes out.
- `test/results/approve-perf.e2e-spec.ts` seeds 20 attendance days per student and warms the
  endpoint on another section's sheet before the timed approval.
