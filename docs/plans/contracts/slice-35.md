# Slice 35 contracts — promotion and year end

**Author:** Opus 5.5 (wave P, Agent C), 2026-10-08. **Binds:** `apps/api/src/modules/promotion/**`,
`repositories/promotion.repository.ts`, `EnrolmentRepository.{findManyByIds,completeMany,createMany,sectionsAwaitingPromotion}`,
`EnrolmentsService.completeYearMany`, `StudentsService.{withdrawForPromotion,promoteMany,lockMany}` (the plan's
"StudentStatusService.promote": the status code lives in `StudentsService`),
`AcademicYearsService.assertPromotionsApplied`, the slice-35 lines of
`common/errors/constraints-academics.ts`; the web pages `/promotion`, `/promotion/[id]` and the
academic years page's close dialog. **Source:** `phase-4-academic.md` §1.1 rule 30, §1.3 A7, A8,
§3.2 "Promotion" and "Enrolments and students", §4 "Slice 35", §5 slice 35, §7.1, R294–R300;
migrations `20261008170000_wave_p_promotion` and `20261008190000_wave_p_review_fixes`. Everything not restated follows the Phase 1–3
conventions (envelope, string ids, `PageQueryDto`, `NoQueryDto`, `@ApiErrors()`, `404` outside the
caller's scope, no `DELETE`, no `PUT`).

## 1. Routes

Every route needs `assessment.define`. The writes share the per-user bucket `promotion-writes`
(30/min, 300/h).

| Route | Notes |
|---|---|
| `POST /sections/:id/promotion-sheets` + `Idempotency-Key` | `OpenPromotionSheetDto { targetYearId }` → `201 PromotionSheetDetailDto`; a replay of the key `200` with `Idempotency-Replayed: true`; §2 |
| `GET /promotion-sheets` | page of `PromotionSheetDto`; filters `academicYearId`, `sectionId`, `status`; sort `-openedAt` (default) or `openedAt` |
| `GET /promotion-sheets/:id` | `PromotionSheetDetailDto` |
| `PATCH /promotion-sheets/:id` | `UpdatePromotionSheetDto { decisions: [{ enrolmentId, decision, reason?, targetClassId?, targetSectionId? }] }` (1–200, the given rows only) → detail; §3 |
| `POST /promotion-sheets/:id/apply` + `Idempotency-Key` | no body → `200` detail (`applied`); a replay `200` with `Idempotency-Replayed`; §4 |
| `POST /promotion-sheets/:id/cancel` | `ReasonDto` → `200` detail (`cancelled`); the principal only (`requirePrincipal`: `403 PERMISSION_DENIED { reason: principal_required }` to a grant of `assessment.define`); an open sheet only (`409 PROMOTION_SHEET_NOT_OPEN`). Its rows stay (frozen by `promotion_decisions_guard`); the section's open slot is freed, so a new sheet may be opened; the year-close guard counts only applied sheets. Audit `promotion_sheet.cancelled { sectionId, targetYearId }` with the reason (fix round) |
| `POST /academic-years/:id/close` | existing; gains `409 PROMOTION_INCOMPLETE { sections: [{ sectionId, sectionName, className }] }` before R44; §5 |

`PromotionSheetDto { id, academicYearId/Name, classId, className, classIsFinal, sectionId, sectionName,
targetYearId/Name, status: open | applied | cancelled, rows, undecided, openedByName, openedAt, appliedByName,
appliedAt, updatedAt }`. `PromotionSheetDetailDto` adds `targetYearHasClasses` (the screen's hint)
and `decisions: PromotionDecisionDto[]` (by roll number, then name): `{ id, enrolmentId, studentId,
studentName, admissionNo, studentStatus, rollNo, enrolmentStatus, resultId, resultSuperseded,
percentBp, grade, passed, proposed, decision, reason, targetClassId/Name, targetSectionId/Name,
arrearsFlag, decidedByName, decidedAt, appliedAt, skipped, newEnrolmentId, revisedAfterApply }`.

## 2. Open (R294)

The section in the caller's scope (else `404`); no open sheet for it (`409 PROMOTION_SHEET_OPEN
{ sheetId }`; `promotion_sheets_open_key` behind it); the section's year not closed and the target
year another year (`422 INVALID_VALUE` on `targetYearId`; unknown `422 REFERENCE_NOT_FOUND`), not
closed (`409 ACADEMIC_YEAR_CLOSED`).

**The source** (A7): the terms held for the class (no live `term_skips` row). Two or more → the
final sheet; one → that term's sheet; none → no source (every proposal null). The section's newest
version of the source sheet must be `approved` or `published` (`409 PROMOTION_FINAL_NOT_APPROVED
{ sectionId }`). The class's `next_class_id`, when set, must be a class of the target year
(`409 PROMOTION_TARGET_INVALID { reason: other_year }`) and not archived (`{ reason: archived }`).

**Rows:** the section's `active` enrolments of the year (suspended students included). Per row:
the live result of the source term on an approved or published sheet (`result_id`, FK on the same
enrolment); `proposed` = `complete` (passed, final class) | `promote` (passed) | `detain` (failed)
| null (no result or nothing assessed). The default target: `promote` → the next class; `detain` →
the target year's class with the same name; the section with the same name as the current one, else
the class's only live section. A proposal whose target is whole (or needs none) is pre-filled as the
decision; otherwise the row is undecided. `arrears_flag` = the dues endpoint
(`FinanceReportsService.clearance`) shows money owed — a flag, never a block (rule 30). Audit
`promotion_sheet.opened { sectionId, targetYearId, source, rows, proposed{...}, arrears }`.

## 3. Decide (R295, R298)

On an open sheet (`409 PROMOTION_SHEET_NOT_OPEN`) under its row lock, the year open. Each given row
once (`422` on `decisions[i].enrolmentId`), on the sheet (`422 REFERENCE_NOT_FOUND`). Each row
**re-reads** its live result and proposal (a correction since opening re-proposes it). A decision
other than the proposal, or with none, needs a reason (`422` on `decisions[i].reason`; `@Reason()`
3–500). `promote`/`detain`: `targetClassId` (default as §2) must be a live class of the target year
(`409 PROMOTION_TARGET_INVALID { reason: other_year | archived }`), `targetSectionId` (default as
§2) a live section of it (`422 REFERENCE_NOT_FOUND`); `complete`/`not_continuing` take no target
(`422`). `complete` only on a final class's sheet (`422 INVALID_VALUE` on `decisions[i].decision`,
"Only a final class completes"; R295, fix round; the web offers Complete only when `classIsFinal`).
`not_continuing` needs `student.status.change` over the section (`403 PERMISSION_DENIED
{ reason: capability_not_held, capabilities: [student.status.change] }`) and an active student
(`409 STUDENT_NOT_ACTIVE { enrolmentIds }`: reactivate a suspended student first). Audit
`promotion_sheet.decided { decisions: { <enrolmentId>: { from, to, proposed, reason, targetClassId,
targetSectionId } } }`.

## 4. Apply (R297, R298)

One transaction under the sheet's row lock: open (`409 PROMOTION_SHEET_NOT_OPEN`, also a second
apply), both years not closed. The results the rows name are taken `FOR SHARE` before the rows are
read (`PromotionRepository.lockResults`): a correction superseding one waits for apply to commit (its
trigger then flags the applied row `revised_after_apply`), and apply waits for a correction already
under way (and then reads the row superseded). Over the rows whose enrolment is still active: any undecided →
`409 PROMOTION_INCOMPLETE { enrolmentIds }`; any whose result was superseded since read →
`409 PROMOTION_RESULT_SUPERSEDED { enrolmentIds }` (re-decide the row); `not_continuing` re-checks
`student.status.change` and an active student; a `complete` row on a class no longer final →
`409 PROMOTION_TARGET_INVALID { reason: not_final, enrolmentIds }`; an enrolment that starts after
the year's end (it cannot close on that end, `enrolments_ended_check`) → `409
PROMOTION_ENROLMENT_AFTER_YEAR { enrolmentIds }`; each target class live with the target section
live (`409 PROMOTION_TARGET_INVALID { reason: archived | other_year | no_target, enrolmentIds }`),
then each target is locked once (`EnrolmentsService.lockTarget`).

**Dates.** The preferred `effectiveOn` = min(today, the year's end); per student it is raised to
the student's admission, active enrolment start or last status change when later (never a future
date), so a status change recorded after the year's end (a suspension, a reactivation) moves the
student's date forward instead of failing the dates check (fix round).

**Order** (§7.2 batching; the same invariants as the single-row services). 1. `not_continuing`
rows: `StudentsService.withdrawForPromotion` — the status route's own withdrawal (`withdrawn`, the
enrolment `left` on the student's date, sessions revoked). 2. `complete` rows:
`StudentsService.promoteMany` while the enrolment is still active (so a section-scoped caller still
reaches the student): one row lock statement in id order, the dates per student, one status update,
the status rows, the sessions and one audit row each (active or suspended → `alumni`; the status
route still refuses `alumni`). 3. Every other live row: `EnrolmentsService.completeYearMany` — the
students locked, the enrolments `completed` on the year's end in one statement, and for
`promote`/`detain` the next enrolments opened in one statement in the target section on the target
year's first day with **no roll number**. Both status writes audit `student.status_changed` with
`source: promotion`. A row whose enrolment was not active when read is skipped (recorded in the
audit row; `skipped` in the DTO); one that stops being active while apply runs is a race →
`409 CONCURRENT_UPDATE` (retry). Rows get `applied_at` and `new_enrolment_id` in one statement
(`markDecisionsApplied`; fewer rows changed than given → `CONCURRENT_UPDATE`), then the sheet
`applied` (not exactly one → `CONCURRENT_UPDATE`). Audit `promotion_sheet.applied { sectionId, targetYearId, promote, detain, complete,
not_continuing, effectiveOn, skipped{ <enrolmentId>: reason } }`.

**After apply** a result superseded (a slice-32 correction re-composing the final sheet, or a
return) sets `revised_after_apply` on its applied row — a database trigger on `results`
(`results_promotion_revised`), so the correction code needs no hook; the applied enrolments stand.

**Budget (§7.2):** a 60-student final class applies in ≤ 3 s; the statements are a fixed number,
not per student (`test/promotion/apply-perf.e2e-spec.ts`; about 230 ms locally, from 2.7 s before
batching).

## 5. Year close (R299)

`AcademicYearsService` refuses closing while a section of the year had an enrolment in force on
the year's last day and has no applied promotion sheet (`EnrolmentRepository.sectionsAwaitingPromotion`),
before R44. A section with nobody in force on that day needs no sheet. The web close dialog shows
the sections from the error's details.

## 6. Schema (migrations `20261008170000_wave_p_promotion`, `20261008190000_wave_p_review_fixes`)

`promotion_outcome`, `promotion_sheet_status`; `promotion_sheets` and `promotion_decisions` per
plan §3.2/§4, with the hand-written objects listed in `test/guardrails/schema-checks.ts`
(`WAVE_P_OBJECTS`): `promotion_sheets_open_key` (one open sheet per section), the target-year and
applied CHECKs, `asms_status_transition('open:applied')`, the columns frozen, applied frozen;
decisions' composite FKs (sheet + target year, enrolment + student, result + enrolment, target
class + target year, target section + target class, new enrolment + student + target year,
decided_by), the target, reason (`decision IS NOT DISTINCT FROM proposed OR reason IS NOT NULL`),
decided and applied CHECKs, `asms_promotion_decision_guard` (written only while the sheet is open,
for an enrolment of its section and year; an applied row frozen but for `revised_after_apply`,
false → true only), `results_promotion_revised`; no delete, no truncate, `school_id` immutable on
both. `enrolments_status_transition` = `asms_status_transition('active:completed', 'active:left')`.
The review-fix migration adds `cancelled` to `promotion_sheet_status` and makes the status edges
`asms_status_transition('open:applied', 'open:cancelled')` (cancelled is final).
Constraint mappings: `promotion_sheets_open_key` → `PROMOTION_SHEET_OPEN`; the status edge, the
sheet-open and applied-frozen guards → `PROMOTION_SHEET_NOT_OPEN`; the per-sheet unique and the
enrolment edge → `CONCURRENT_UPDATE`.

## 7. Tests

`test/promotion/promotion.e2e-spec.ts` (R294–R299, revised after apply, 404 across schools),
`year-end.e2e-spec.ts` (R300: two sections, a detained student, an alumnus, a withdrawn student, a
suspended student promoted, arrears carried, a correction after apply, the year closed, next year's
charges finding exactly the new enrolments), `promotion-guards.e2e-spec.ts` (direct writes),
`isolation.spec.ts` (both tables, and the batch writes), `promotion-fixes.e2e-spec.ts` (dates after the
year's end, an enrolment starting after it, a section-scoped caller completing a final class,
`complete` only on a final class, the results held still during apply, cancel), `apply-perf.e2e-spec.ts`
(60 completions ≤ 3 s); web `e2e/promotion.spec.ts`; lint boundary fixtures `promotion-repository-import.ts`,
`student-repository-import.ts`.

## 8. Deviations from the plan

1. No `StudentStatusService` class exists: `promote` (and the not-continuing withdrawal) are
   `StudentsService` methods sharing the status route's code; lint confines the promotion module
   away from the enrolment, student and status-change repositories.
2. `promotion_decisions.target_class_id/target_section_id` may hold the proposal's target while
   undecided; the target CHECK binds them once decided (section too, not only the class).
3. A decided proposal is pre-filled at open when its target is whole, so a principal accepting the
   sheet only overrides; the reason rule compares with the proposal, as the plan says.
4. Skipped rows carry no column: `skipped` is derived (applied sheet, row not applied) and the
   reason is in the audit row.
5. `revised_after_apply` is set by a trigger on `results`, not by the correction service.
6. ~~No route cancels an open sheet~~ — added in the fix round: `POST /promotion-sheets/:id/cancel`
   (the principal, with a reason; §1).
7. Arrears are read per student through `clearance` at open (a section's few dozen calls).
8. Two new refusals beyond the plan: `PROMOTION_ENROLMENT_AFTER_YEAR` and
   `PROMOTION_TARGET_INVALID { reason: not_final }` (§4).
9. The web's Promotion page pages the sheets, classes and sections to their totals (more than 50
   sections); changing a row's decision clears its chosen class and section so the server's
   default for the new decision applies.
