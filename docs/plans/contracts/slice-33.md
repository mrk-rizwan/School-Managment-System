# Slice 33 contracts — family and student views, result reports

**Author:** Opus 5.5 (wave P), 2026-10-08. **Binds:** `apps/api/src/modules/results/my-results.*`,
`result-reports.*`, `repositories/result-reads.repository.ts`; the web pages `/my-children/[id]/results`,
`/my-children/results`, `/my-results`, `/results/reports` and the student page's Results panel; the phone's Results
screens for the parent and the student. **Source:** `phase-4-academic.md` §0.29, §3.4, §5 slice 33,
§7.1 "Families" and "Withholding", §7.2, R78, R274, R282 (the family side), R285–R288. Everything not
restated follows the Phase 1–3 conventions (envelope, string ids, `PageQueryDto`, `NoQueryDto`,
`@ApiErrors()`, `404` outside the caller's scope, no `DELETE`, no `PUT`). `ResultDto` (the card) and
`ResultCardsService.{cards, withheldFor}` are slice 32's (`contracts/slice-32.md`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /me/children/:id/results` | capacity `guardian`, `me-reads` | `MyResultsQueryDto { academicYearId? }` → `MyChildResultsDto` (§2.1) |
| `GET /me/children/:id/results/:resultId` | the same | → `MyResultDto { withheld, outstanding, result: ResultDto \| null }` — `200` withheld or not; `404` unless the result is the child's, published and live |
| `GET /me/children/:id/assessments` | the same | `MyAssessmentsQueryDto { termId?, page, limit }` → page of `MyAssessmentMarkDto`, newest test first (`held_on` desc, then id desc) |
| `GET /me/student/results`, `/me/student/results/:resultId`, `/me/student/assessments` | capacity `student`, `me-reads` | the same shapes; the student from the session; `outstanding` always `null` |
| `GET /students/:id/results` | `marks.view_all` \| `student.view` | page of `ResultDto`, published and live, `published_at` desc then id desc, across years (R288); the student in the caller's student scope (else `404`); never withheld. A section-scoped caller (student scope `sections`) gets only the cards of sheets in their **sheet** scope — the sections they class-teach or cover (`sheetScopeWhere`), as `GET /results/:id` — so a subject teacher reaches the student but not the report card (`200`, empty page; security L1, fix round) |
| `GET /result-reports/section-summary` | `marks.view_all`, `result-reports` | `{ sheetId }` → `SectionSummaryReportDto` (§3.1) |
| `GET /result-reports/subject` | `marks.view_all`, `result-reports` | `{ termId, classSubjectId }` → `SubjectReportDto` (§3.2) |

Throttles: the six `/me/*` routes share `me-reads` (120/min, 2,000/h per user, R166); the two
reports share the new per-user bucket `result-reports` (30/min, 300/h). Nothing here writes, so
nothing is audited (the R57 table lists no row).

## 2. Family and student (§0.29, §7.1)

The child is resolved by the access guard's capacity scope (`contracts/slice-13.md` §1.2): a
guardian's live `can_login` links (the guardian not merged), or the student login's own id. A child
outside it is `404`, the same as absent (R78, R285); a staff caller is `403` (no capacity).

### 2.1 `MyChildResultsDto`

`{ studentId, academicYearId | null, years: [{ id, name }], terms: MyResultSummaryDto[], final:
MyResultSummaryDto | null, withheld, outstanding }`. `years` are those with a published, live
result of the child, newest first by start date; `academicYearId` defaults to the first of them
(null when there are none); an unknown year yields empty `terms`. `terms` are the year's published,
live term results in term order; `final` the year's final result. A summary carries `id`, the year,
term (`isFinal`), class and section names, `percentBp`, `grade`, `revised`, `publishedAt` — never
the per-subject table (that is the card).

### 2.2 Withholding (R282, the family side)

`ResultCardsService.withheldFor(schoolId, studentId)` (slice 32: `withhold_card_for_dues` on and
`FinanceReportsService.clearance` neither cleared nor overridden). Withheld: `withheld: true`; the
card route answers `result: null`; the guardian gets `outstanding` (whole rupees) and keeps the
summary's percentage and grade; **the student gets `outstanding: null` and `percentBp`/`grade`
null in every summary**. The screens tell the student only "Report card not available — please ask
your parent or the school office", never that it is about fees (security L3, fix round; web and
phone); the guardian's copy names the fees and the amount. Not withheld: `outstanding: null`. A later payment unlocks with no write.
Class-test marks are never withheld (rule 27: visible as entered).

### 2.3 Class tests (R286)

Live marks of the child on non-voided assessments of `kind = test`, optionally of one term. Never an
exam mark, a superseded or pending (correction) row, a rejected row, or a voided test's mark.
`MyAssessmentMarkDto { markId, assessmentId, name, testType, heldOn, termId, termName, subjectName,
maxMarks, obtained | null, absent, excused }` — no author, no section, no other student.

## 3. Reports (R287)

Both read only stored rows (never recompose) and are school-wide (`marks.view_all`), so no row
scope applies. An average is the mean of the stored `percent_bp` over the assessed rows, rounded
half-up.

### 3.1 Section summary

The sheet must be `approved` or `published` (`409 RESULT_SHEET_NOT_APPROVED { sheetId }`; unknown
`404`). Its rows are the version's stored set: live rows and rows a later correction's version
replaced (a row naming them by `supersedes_id`; `superseded_by` stays null, slice-32 §9.1) — never a
set a return from approved discarded (no row names those). So version 1 of a corrected section still
reports its original figures and version 2 its corrected ones (fix round: it answered zeros). `students`, `assessed`
(`percent_bp` not null), `passed` / `failed` (the stored `passed`), `averageBp`, `grades` (overall,
most frequent first), and per subject in card order: `assessed`, `passed` / `failed` (printed
obtained × 100 ≥ the sheet's `pass_percent` × max, the composition's own check, §0.26), `averageBp`,
`grades`.

### 3.2 Subject report

The term and the class-subject of the term's year (else `404`). Live stored subject rows
(`superseded_at` null) of the class-subject in the term, across sections (approved or published
sheets; `published` says whether all of a section's are): per section `students`, `assessed`,
`averageBp`, `top` (highest three) and `bottom` (lowest three, lowest first); overall `assessed`
and `averageBp`.

## 4. Repository

`ResultReadsRepository` (`src/repositories/result-reads.repository.ts`), read-only, importable only
from `src/modules/results/**` (the `resultRepositories` lint boundary gains `result-reads`). Every
statement filters `school_id`; family reads take a student the service has already resolved and add
`published_at IS NOT NULL AND superseded_at IS NULL`. Isolation: `test/results/result-reads-isolation.spec.ts`.

## 5. Web and phone

Web: **Children's results** (`/my-children/results`, the guardian's children) → the child
(`/my-children/[id]/results`: year picker, term and final
results, the card (`ReportCard`), the withheld notice with the amount, class tests by term), **My
results** (`/my-results`, the student: the same without the amount), **Result reports**
(`/results/reports`, nav for `marks.view_all`: tabs Section summary (pick a published sheet, labelled
"Class – Section · version n", a corrected section's versions newest first; the API also answers an
approved one) and Subject (term, class, subject)), and the student page's **Results** panel (`GET /students/:id/results`). Phone
(online only, never cached; secure screens): the parent's child card and the student's home gain
**Results** (`/children/[studentId]/results`, `/student/results`) → the year's terms and final and
the class tests (a page of 25, newest first; **Load older** appends the next page until the total)
→ the card (`…/results/[resultId]`, slice 32's `ReportCardView` with its Share).
Maestro `parent-report-card.yaml` (after `principal-approve-result` in `ci-run.sh`).

## 6. Deviations from the plan

1. `MyChildResultsDto` gains `studentId`, `academicYearId` and `years` (the year picker needs them).
2. The withheld student also loses `percentBp` and `grade` from the summaries (plan §1.1 "the
   student's login sees no figure").
3. The subject report's top and bottom are three students each.
4. No `sort` parameter on these lists: each has one stated order.
5. The web report page is `/results/reports`, not `/reports/results`: `/reports` is the finance
   reports area with its own layout and `finance.report.view` tabs.
6. The phone reads results online only and caches nothing: withholding is decided at read time
   (R282) and a correction replaces a card (R280), so a stored copy could show a card the school no
   longer serves. Wave O's sheets follow the same rule.
7. Withholding is asked for the year shown (`withheldFor(schoolId, studentId, academicYearId)`:
   the result's year on a card, the chosen year on the list).

## 7. Fix round (2026-10-08, from the wave P reviews)

Tests: `test/results/family-results.e2e-spec.ts` — the section summary of v1 and v2 after a
correction; a pending correction never reaches the family and the superseded row is `404` to them
once approved; a guardian with `can_login` off, an ended link or merged away reads `404` on every
family route; a subject teacher gets no cards on the student page, the class teacher does. Web
`e2e/my-results.spec.ts` (the student's withheld copy; the versions in the section picker); phone
`src/family/results.spec.tsx` (the student's withheld copy; Load older).
