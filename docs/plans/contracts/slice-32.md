# Slice 32 contracts — report cards, withholding, corrections

**Author:** Opus 5.5 (wave P, agent A), 2026-10-08. **Binds:** `modules/results/{result-cards.service,
result-print,result-revision.service}.ts`, the slice-32 routes of `results.controller.ts`, `ResultDto`
in `results.dto.ts`, `modules/assessments/mark-corrections.{controller,service,dto}.ts`, the excusal
cascade in `marks.service.ts`, the slice-32 methods of `repositories/{result,result-sheet,mark}.repository.ts`,
`OutboxDispatcher.resultRevisedNotifyAfterCommit`; web `/results/corrections`, the print actions on
`/results/sheets/[id]`, "Request correction" in the marks grid; mobile `src/results/ReportCardView.tsx`.
**Source:** `phase-4-academic.md` §0.25-§0.30, §1.1 ("Correction cascade", "Withheld card"), §3.2,
§3.4, §3.5, §5 slice 32, §7.1, R279-R284, R296. The schema is wave O's and wave N's; the fix round's
migration `20261008190000_wave_p_review_fixes` adds R281's database half (§4.2).
Everything not restated follows the Phase 1-3 conventions.

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /results/:id` | `marks.view_all` | `ResultDto`; a row that is published or superseded, in the caller's sheet scope (`404` otherwise); never withheld |
| `GET /results/:id/print` | `marks.view_all`, `SameSitePrintGuard`, `PrintThrottleGuard` (bucket `print`, 20/min 200/h) | HTML via `sendPrintView`; audited `result.printed { resultId, sheetId }` |
| `GET /result-sheets/:id/print` | the same | every live card of the sheet, one per page, roll then name; audited `result_sheet.printed { sheetId, cards }` |
| `POST /marks/:id/correct` | `marks.enter` + `Idempotency-Key` (endpoint `assessments`, path id the mark) | `CorrectMarkDto { obtained? \| absent: true, reason }` → `201 MarkCorrectionDto` (`200` + `Idempotency-Replayed` on a replay) |
| `GET /mark-corrections` | `result.approve` \| `marks.view_all` | page of `MarkCorrectionDto`; `status` pending \| approved \| rejected, `sectionId`, `termId`; newest request first |
| `GET /mark-corrections/:id` | the same | `MarkCorrectionDto` |
| `POST /mark-corrections/:id/approve` | `result.approve` | `MarkCorrectionDecisionDto { mark, revisedResult: ResultDto }` |
| `POST /mark-corrections/:id/reject` | `result.approve` | `ReasonDto` → `MarkCorrectionDto` |
| `POST /mark-corrections/:id/withdraw` | `marks.enter` | `ReasonDto` → `MarkCorrectionDto`; the requester's own pending correction only (anyone else's `404`; decided `409 MARK_CORRECTION_NOT_PENDING`) |

`MarkCorrectionDto` carries `withdrawn` (rejected by its own requester). The marks grid's rows
(`GET /assessments/:id/marks`) carry `pendingCorrectionId` and `pendingCorrectionMine`.

Writes share `marks-writes` (60/min, 1,000/h). Scope: the request, approve and reject run in the
caller's marks **write** scope minted for the assessment's `held_on` (the principal's is `all`); the
list in the read scope of today; a single correction in the read scope of its `held_on`.

## 2. The card (`ResultDto`, R279)

The stored `results` row with its subjects and what the card prints around it: school name, year,
term (`termName` null and `isFinal` on the final), class, section, roll number, the student's name
and admission number **now** (subject names as snapshotted). The year's display toggles
(`show_position`, `show_attendance`, `show_remark`, editable after approval) null the figures they
hide and travel as `showPosition`, `showAttendance`, `showRemark`. `revised` with `publishedAt` prints
"Revised on <date>"; `supersededAt` prints "SUPERSEDED". No user id (no `ownChildOf`) is on it.
`ResultSheetDetailDto.preview[].resultId` (added) names a stored row's card.

`ResultCardsService` (exported by `ResultsModule`) builds it for every reader:
`cards(schoolId, resultIds) → ResultDto[]` (in the order given, missing ids omitted; tenant-scoped
only — **the caller resolves the ids inside its own scope first**), `staffCard`, `printCard`,
`printSheet`, `certificateResultFor` (§6) and `withheldFor` (§5).

## 3. Print views (R283, R284)

One scriptless layout (`result-print.ts`) through the escaping `html` tag and `sendPrintView`
(`no-store`, the CSP, `nosniff`): school, "Report card · term · year", the stamp (Revised /
Superseded), student, class and section, roll, the subject table (obtained / max / percentage /
grade; "—" when not assessed), the total row, the verdict, position `n / m`, attendance, the class
teacher's remark, "Class teacher" and "Principal" signature lines. A sheet prints one card per page
(`page-break-after`). The web opens the URL in a new tab and never holds the HTML.

## 4. Corrections (R280, R281)

**Request.** The live mark in the caller's write scope (else `404`); the assessment not voided
(`ASSESSMENT_VOIDED`); the year open (`ACADEMIC_YEAR_CLOSED`); the student's term result of the
assessment's **class** and term published and live (`409 MARK_CORRECTION_SHEET_NOT_PUBLISHED
{ markId }` otherwise — the class, not the section, so a moved student's old-section mark is
correctable); `obtained ≤ max` (`MARK_EXCEEDS_MAX`); a value different from the live one (`422` on
`obtained`); one pending correction per mark (`409 ILLEGAL_STATUS_TRANSITION`). A `pending` mark row
superseding the live one, with the reason. Audit `mark_correction.requested`.

**Approve.** Under the assessment's row lock: pending (`409 MARK_CORRECTION_NOT_PENDING`); the year
open; never the requester (`409 SELF_ACTION_FORBIDDEN { reason: author }`) except the sole active
principal; never the decider's own child (`ownChildCheck`, `{ reason: own_child }`, the same
exception); never the submitter of the term sheet it revises (`409 SELF_ACTION_FORBIDDEN { reason:
submitter }`, the same exception, recorded `self_approved` on the new version — checked in the
cascade, so an excusal after publication is held to it too). The mark it corrects is superseded
(still live, else `CONCURRENT_UPDATE`), the correction becomes `live` with `decided_by/at`, then the
cascade (§4.1). Audit `mark_correction.approved { assessmentId, supersedesId, enrolmentId, resultId,
termSheetId, finalSheetId, revised, selfRequest, ownChild, selfSubmitter, selfApproved }` — each
sole-principal exception on its own, `selfApproved` when any applied.

**Reject.** Pending; own child refused; `rejected` with `decided_by/at`; the reason in the audit row
`mark_correction.rejected`.

**Withdraw** (fix round, a contract decision). The requester takes back their own pending request:
`marks.enter`, under the assessment's lock, the year open; `rejected` decided by the requester
(`withdrawn: true` in the DTO); audit `mark_correction.withdrawn` with the reason and `withdrawn:
true`. Web: "Withdraw correction" on the requester's row of the marks grid (the row shows
"Correction waiting" to everyone; no second request is offered meanwhile) and "Withdraw" on the
requester's own row of Mark corrections.

**Excusal after publication** (`POST /marks/:id/excuse`, slice 30) is a correction decided at once:
when the student's term result is published the excusal runs the same cascade in its transaction
(`mark.excused` gains `revisedResultId`, `ownChild`, `selfSubmitter`). No second person: excusing is
`result.approve`'s decision. With no published row, an excusal while the student's term row is
stored on an **approved, unpublished** version is refused, `409 RESULT_SHEET_VERSION_OPEN { sheetId }`
("publish or return the sheet first"): its stored rows would go stale (fix round). Before approval
nothing is stored and the excusal simply counts.

### 4.1 The cascade (`ResultRevisionService.revise`)

1. The version holding the student's live published term row is locked by a compare-and-set that
   moves its `updated_at` (`bumpPublished`); the live row is re-read under it (a racing correction
   of the same version answers `CONCURRENT_UPDATE`, retryable).
2. `ResultComposer.term` over the live marks with **the version's snapshot settings**, over **the
   class-subjects of the old version's rows** (with their stored names and order — a subject listed
   since publication is not on this term's cards), and the version's submitter; the approver is the correction's decider (own-child flags recomputed;
   remark-author flags carried).
3. The full row set for the old version's enrolments (an enrolment the composition no longer finds
   keeps its figures), **re-ranked** (`positions`), attendance and remark copied from the stored
   rows (a correction changes marks only). `revised` where any printed figure changed (totals,
   percentage, grade, verdict, failed count, position, any subject figure — subjects compared by
   class-subject, so a print-order change is not a revision). A student the re-composition no longer
   finds on the roster refuses the correction, `409 CONCURRENT_UPDATE { sheetId }` (no version that
   changes nothing).
4. The old rows are superseded (`superseded_at`), then version n+1 is inserted born `published`
   (`supersedes_id`, the submission record and snapshot copied, decided and published by the
   approver), then its rows (`supersedes_id` each, `published_at` now). Rows already told stay told
   (`notified_at` set), except the corrected student's when revised.
5. The student's published final result (if any) is re-composed the same way from the new term
   rows with the final version's snapshot and term weights; its rows are not told again. A final
   sheet of the section waiting `approved` (not published) refuses the correction with `409
   RESULT_SHEET_VERSION_OPEN { sheetId }` (publish or return it first). The section's open final
   sheet is locked (compare-and-set on `updated_at`) before its status is read — lock order
   assessment → term sheet → final sheet — so a final approval or publication racing the correction
   serialises with it (`CONCURRENT_UPDATE` to the loser, retryable).
6. `result-notify { resultId }` after commit (`resultRevisedNotifyAfterCommit`, job id
   `result-notify-r<id>`) for the corrected student's term row when it is `revised`: one
   `result_revised` to that family and student (A15: one per correction). A revised row whose
   family was never told any row of its chain (the publication's message not yet sent) goes out as
   `result_published` instead (the job walks the `supersedes_id` chain for a told row).
7. Promotion: an applied decision naming a superseded result is flagged `revised_after_apply` by the
   database (slice 35's trigger); an open promotion sheet re-checks at apply.

### 4.2 R281 in the database (fix round, migration `20261008190000_wave_p_review_fixes`)

`marks_not_self` (BEFORE UPDATE OF `decided_by`): a row made `live` is never decided by its
`entered_by`, unless `asms_is_sole_principal`; a rejection by the author (a withdrawal) stays
allowed. `result_sheets_not_self` now fires on INSERT as well: a correction's version (born decided)
with `decided_by = submitted_by` needs `self_approved` and the sole principal; `self_approved` with
another decider is `result_sheets_self_approved_unwarranted`. Direct-write tests:
`test/academics/marks-guards.e2e-spec.ts`, `test/results/sheet-guards.e2e-spec.ts`.

## 5. Withholding (R282)

`ResultCardsService.withheldFor(schoolId, studentId, academicYearId?) → { withheld, outstanding }`:
the year's `withhold_card_for_dues` (the given year, else the student's newest enrolment's); off →
`{ false, 0 }` and no dues read; on → `FinanceReportsService.clearance` (the only dues read):
cleared (nothing owed, or the principal's override) → not withheld; else `{ true, outstanding }`.
Read at request time, so a payment unlocks the card with no write. Slice 33's family routes call it;
staff reads never do.

## 6. Certificates (slice 34's TODO, A11, R291)

`academic` and `completion` certificates carry `body.result` (`CertificateResultDto { termName,
isFinal, className, sectionName, subjects: [{ subjectName, obtained, max, percentBp, grade }],
totalObtained, totalMax, percentBp, grade, passed }`): the named year's published live final
result, else its last published term (by `sort_order`), snapshotted at issue (a later correction
changes nothing issued; a reissue copies it). None → `409 CERTIFICATE_NO_RESULT { certificateId:
null }`. Other types carry `result: null`; bodies issued before wave P parse as `null`. The print
view adds the marks table above the record of attendance.

## 7. Audit (R57)

`result.printed`, `result_sheet.printed` (GETs), `mark_correction.requested|approved|rejected|withdrawn`,
`mark.excused` (+ `revisedResultId`).

## 8. Screens

- Web `/results/sheets/[id]`: on a stored sheet a `marks.view_all` holder gets "Print report cards"
  and per row "Print card" (new tab). Nav "Mark corrections" (`result.approve | marks.view_all`) →
  `/results/corrections`: Waiting / Approved / Rejected, from → to, reason, requester; Approve,
  Reject with a reason. Marks grid: "Request correction" on a locked assessment's marked row for a
  `marks.enter` holder (mark or absent, reason; one key per opened dialog). Playwright
  `e2e/report-cards.spec.ts`.
- Mobile `ReportCardView({ result: ResultDto })`: the card natively (subjects, totals, percentage,
  position, attendance, remark, Revised / Superseded), **shared as text** (`Share`); slice 33's
  secure card screen renders it. `src/results/report-card.spec.tsx` (with a snapshot).

## 9. Deviations from the plan

1. `superseded_by` stays null on corrected rows: `results_superseded_frozen` freezes it with
   `superseded_at`, and the live key needs the old rows out of the live set before the new ones go
   in, so the two cannot be set together. **Decided in the fix round: no migration;** every read of
   the chain uses the new rows' `supersedes_id` (the section summary included, slice-33 §3.1).
2. ~~R281's trigger half is not in the database~~ — added in the fix round (§4.2).
3. `POST /marks/:id/correct` answers `MarkCorrectionDto` (with context) rather than
   `AssessmentMarkDto`; its idempotency endpoint is `assessments` with the mark as path id (no new
   `IDEMPOTENT_ENDPOINTS` value).
4. A correction that leaves the corrected student's figures unchanged tells nobody.
5. Excusal after publication is applied at once by the approver (not a pending row).
6. The phone shares the card as text, not as an image: the app has no view-capture library and
   none can be added on this machine (pnpm). The plan's "image of the view" is a later dependency.
7. A correction is refused while the section's final sheet is `approved` but unpublished; an
   excusal while the term sheet is.
8. The web "withheld list" print view is not built (withholding is a family read-time rule; staff
   prints are never withheld).
9. The requester may withdraw a pending correction (`POST /mark-corrections/:id/withdraw`), which
   the plan does not list.

## 10. Fix round tests (2026-10-08)

`test/results/report-cards.e2e-spec.ts`: excusal refused while the term sheet is approved and
unpublished; a racing final sheet (held by another transaction) answers `CONCURRENT_UPDATE`, an
approved final refuses, a published one is re-composed; the term sheet's submitter is refused as
decider and the audit names each exception; a subject listed after publication is not composed into
a correction; `result_published` for a never-told revised row, `result_revised` once told; a student
off the re-composed roster refuses; withdraw (and the grid's pending fields).
`src/modules/results/result-revision.spec.ts`: `changed` by class-subject. Direct writes:
`marks-guards` and `sheet-guards` (§4.2). Web `e2e/report-cards.spec.ts`: withdraw from the grid and
from Mark corrections.
