# Slice 42 contracts — reporting, class rankings and CSV export

**Author:** Opus 5.5 (wave U), 2026-10-15. **Binds:** `apps/api/src/common/report-export.ts`;
`modules/finance-reports/**` (financial statement, CSV), `modules/results/class-ranking.service.ts`,
`result-reports.*` (merit list, CSV), the ranking hooks in `ResultSheetsService.publishLocked` and
`ResultRevisionService.revise`; `modules/people/students/student-profile.*`;
`modules/people/staff/staff-report.*`; `modules/attendance/discrepancies.*`; the CSV of
`GET /documents/incomplete-admissions` and `GET /events/:id/report`;
`repositories/class-ranking.repository.ts`, `staff-report.repository.ts`, the new reads in
`finance-report.repository.ts` and `attendance-report.repository.ts`; the web report pages.
**Source:** `phase-5-extended.md` rule 38, §0.37, §1.1 ("Financial statement", "Class ranking",
"CSV"), §1.3 A9, §3.2 "Rankings", §3.3, §5 slice 42, §7.1 CSV, §7.2, R332–R338. Everything not
restated follows the Phase 1–4 conventions (envelope, string ids, `PageQueryDto` ≤ 50, `404`
outside the school or scope, `403 PERMISSION_DENIED` without the key, no `DELETE`). No migration:
wave U's schema (`a659e76`) holds `class_rankings`, `class_ranking_rows` and
`school_settings.financial_statement_basis`.

## 1. Routes

| Route | Guard | Throttle | Notes |
|---|---|---|---|
| `GET /finance-reports/financial-statement?from&to \| termId \| academicYearId &basis&format` | `finance.report.view` | `finance-reports` | `FinancialStatementDto` (§2.1) |
| `GET /result-reports/merit-list?classId&termId&page&limit&sort=position&format` | `marks.view_all` (`all` scope, else `404`) | `result-reports` | `MeritListDto` (§2.2) |
| `GET /students/:id/profile` | `student.view` (scoped, `404` outside) | none (as `GET /students/:id`) | `StudentProfileDto` (§2.3) |
| `GET /staff-reports/summary?from&to&staffName&page&limit&sort=staffName&format` | `staff.view` | `staff-reports` 30/300 (new) | `StaffReportDto` (§2.4) |
| `GET /attendance-reports/discrepancies?from&to&kind&page&limit&sort=-date&format` | `attendance.student.view_all` | `attendance-reports` 30/300 (new, deviation 3) | page of `DiscrepancyDto` (§2.5) |

`?format=csv` is accepted by every report route (§3): the five above except the profile, the seven
Phase 3 finance reports, the result reports (`section-summary`, `subject`, `merit-list`),
`GET /documents/incomplete-admissions` and `GET /events/:id/report`.

`GET /school/settings` gains `financialStatementBasis: received | verified`; `PATCH /school/settings`
accepts it (principal, as every setting).

## 2. Behaviour

### 2.1 Financial statement (R332)

- **Window:** exactly one of `from`+`to` (inclusive, `to − from ≤ 366` days), `termId` (the term's
  dates) or `academicYearId` (the year's dates); none or two is `422` on `from`; an unknown term or
  year is `422 REFERENCE_NOT_FOUND`. **Basis:** `basis`, else the school's
  `financial_statement_basis` (*default* `received`).
- **Lines** (`FinanceReportRepository.statementLines`, summed by the shared `financialStatement`):
  receipts = non-voided payments with a receipt, `carried_forward` excluded (exactly the
  collections report's rows), by `received_on` (received) or `verified_at`'s school day (verified);
  refunds and refund reversals by the day made (as collections, both bases); expenses = `recorded |
  approved` by `spent_on` (received) or the decision day, else the recorded day (verified), with
  `cash_shortfall` rows as **shortfall write-offs** and **an advance's own expense row
  (`salary_advances.expense_id`) excluded** — the advance is counted once, from `salary_advances`;
  salaries = `paid` payslips' net by `paid_on`; advances paid by `granted_on` (received) or the day
  recorded (verified); advance recoveries (paid payslips' `advance_recovery`) shown, never
  subtracted.
- **Shape:** `{ basis, from, to, months: StatementFiguresDto[], total }`, a row per calendar month
  the window touches, clipped to it (`period = YYYY-MM`), and the total (`period = total`). Each row:
  `receipts, refundReversals, refunds, netReceipts, expenses, shortfallWriteOffs, salaries,
  advancesPaid, advanceRecoveries, staff, expenditure, net`. The months sum to the total.

### 2.2 Class ranking and merit list (R333, A9)

- `ClassRankingService.recompute(schoolId, classId, termId, trigger, actorUserId) → rankingId | null`
  (results module, exported). **Slice 43 calls it after committing a past-results sheet** with
  `trigger = 'import'`, inside the commit's transaction.
- Called from `ResultSheetsService.publishLocked` for a term sheet (`publish`; also the approval
  that publishes) and from `ResultRevisionService.revise` after the term version is written
  (`correction`, so the old `results` rows are already superseded).
- **Complete:** the class holds the term (no live `term_skips` row: `not_held` needs none), and every
  section with an enrolment of the class in force on the term's last day has a `published` sheet of
  the term. Otherwise nothing is written and `null` returned.
- **Recompute**, in the caller's transaction: `pg_advisory_xact_lock` on the class-term (two
  sections published at once: the later commit ranks); read every live published term result of
  the class; `classRanking` (standard competition, ties share, `percent_bp` null → listed, no
  position); stamp the live version `superseded_at` and take its id in one statement
  (`updateManyAndReturn`); insert the new version with `supersedes_id` (null only for the first)
  and its rows; the completeness check is one statement after the lock (a fresh snapshot); audit `class_ranking.computed
  { classId, termId, trigger, rows, positioned, supersedesId? }`. `results` is never written; the card
  keeps the section position (R279).
- **Merit list:** `MeritListDto { status: ranked | pending | not_held, classId, className, termId,
  termName, rankingId, computedAt, trigger, pendingSections: [{ sectionId, sectionName }], data:
  MeritListRowDto[], page, limit, total }`. Reads only the live version, best first (unranked last,
  then by name). `pending`: no live version — the sections still to publish are named, no rows. An
  unknown class or a term not of the class's year is `404`.

### 2.3 Student profile (R334)

`StudentProfileDto { studentId, fullName, admissionNo, status, admittedOn, dateOfBirth, current,
attendance, latestResult, dues, documents, transport, asOf }`, each section read through its owning
service in the caller's scope: the student (`StudentsService.get`, `404` outside scope); attendance =
the current year to date (`AttendanceReadsService.forStaff`, ≤ 365 days, null before the year
starts); the latest result (`MyResultsService.ofStudent`, the caller's sheet scope) with its class
position from the live ranking; **dues only with `fee.statement.view`** and **documents only with
`document.view`** (null otherwise — the profile never widens a read); transport = the assignment in
force. No identity number. The web prints it.

### 2.4 Staff report (R337)

Window `from`/`to` (default 1 January of today's year to today; ≤ 366 days). Staff not left before
`from`, by name (`staffName` filters). Per member: `present, late, absent, onLeave` from
`staff_attendance`; `attendancePercent = (present + late) ÷ (present + late + absent)`, one decimal,
null when none; `leaveTakenDays` = working days of `approved | ended_early` requests starting in the
window; `contractStatus` of the newest contract: `none | live | expired_not_ended | ended`;
`contractType`, `contractEndsOn`; `contractEndingSoon` = live and ending within 60 days of today.

### 2.5 Attendance discrepancies (R335)

`from`/`to` ≤ 92 days; `kind` optional. `mixed_day`: a student present or late in one period and
absent in another of one day, with no `attendance_arrivals` row on any of that day's marks (one row
per student-day: `presentPeriods`, `absentPeriods`). `amended_register`: a register amended more
than once (`period`, `amendments`). An amendment is an event, not a change row: one correction of
several students writes one `attendance_mark_changes` row per mark in one transaction, sharing
`changed_by` and `changed_at` (the column defaults to `now()`, the transaction's start), so
`amendments` counts the distinct `(changed_by, changed_at)` pairs of the register's marks' change
rows (fix round). Newest day first.

## 3. CSV (R336)

- One helper, `common/report-export.ts`: `@CsvExport({ family, report, rows?, columns })` +
  `CsvExportInterceptor`; `@CsvFormatField()` on the query DTO; `csvCost` on the family throttle;
  `pageWindow(query)` in a paged service (every row up to 10,001 for an export).
- `format=csv` with `page` or `limit` → `422` on that field; more than 10,000 rows → `422` on
  `format`; a cross-site request (`Sec-Fetch-Site` neither `same-origin` nor `none`) → `403
  ORIGIN_REJECTED` (the print views' rule).
- `200 text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<report>-<YYYY-MM-DD>.csv"`
  (school day), `nosniff`, `no-store`; the shared `toCsv` (header row, CRLF, cells starting
  `= + - @ TAB CR` prefixed `'`).
- **Rows = the rows the tab shows:** paged lists their rows; grouped finance reports their groups;
  payroll and the statement their months then a `Total` row; daily cash and the event report their
  summary lines (`Line, Amount/Value`); section summary its subjects; subject report its sections.
- Audit `<family>.exported { report, filters, rowCount }`, subject type `report`, families
  `finance_report`, `result_report`, `staff_report`, `attendance_report`, `document_report`; the
  filters are the query's scalar values, paging and format left out. The only write a report GET
  makes.
- Cost 5 in the family's bucket: `finance-reports` (+ the event report), `result-reports`,
  `staff-reports`, `attendance-reports`, `document-reports`.

## 4. Deviations from the plan

1. `recompute` takes a fifth argument, `actorUserId`: `audit_log_actor_check` needs an actor on a
   request's row.
2. Racing recomputes are serialised by an advisory lock rather than answered `CONCURRENT_UPDATE`;
   the unique-index mappings (`class_rankings_live_key`, `_first_key`, `_supersedes_key` →
   `CONCURRENT_UPDATE`) stay as the backstop. Without the lock two sections published at once could
   each see the other unpublished and the class would never rank.
3. Two family throttles the plan does not list: `attendance-reports` 30/300 (discrepancies) and
   `document-reports` 30/300 (incomplete admissions), so their CSV has a bucket to cost 5 in. The
   event report joins `finance-reports` (it is a finance report, §3.1). The Phase 2 attendance
   reports (daily summary, absentees, late, percentage) gain no CSV in this slice (not in its list;
   adding a bucket to the teacher's daily summary is a behaviour change for the owner to decide).
4. The student profile has no CSV: it is a printed page, not a table.
5. The merit list's body is a page with a header (`status`, `pendingSections`, the version read),
   not the plain `Page<T>`.
6. Statement: an advance recorded as an expense is counted once, as an advance (the plan's lines
   would count it twice).
7. **Fix round (wave U review).** `amended_register` counts amendment events, not change rows
   (§2.5): before, one correction of two students counted as two amendments and listed the
   register. Cross-school probes for `statementLines`, `discrepancies` and every
   `StaffReportRepository` read are in `test/reports/isolation.e2e-spec.ts` (School B seeded inside
   the window; School A's figures unchanged; School B's staff ids read as School A return nothing).
   The verified-basis expense proof (spent 3 days ago, approved today) is in
   `test/finance-reports/reconciliation.e2e-spec.ts`.

## 5. Web

Finance reports gain a **Financial statement** tab; **Results → Reports** gains **Merit list**;
**Staff report** (`/staff/report`) and **Attendance discrepancies** (a tab of attendance reports);
the student page links **Print profile** (`/students/[id]/profile`, a print-friendly page). Every
report tab gets **Download CSV** (the Phase 3 finance tabs, result reports, incomplete admissions,
the event report). Four states (loading, empty, error, data), tablet widths, mocked Playwright.

## 6. Tests

R332 (statement reconciles with collections, expenses and payroll over the R228 scripted year on
both bases; months sum to the total; windows; an advance counted once), R333 (ranked on the last
section's publish, pending before, ties shared, unassessed unpositioned, a correction a new version
with the old superseded and `results` untouched, racing recomputes, `not_held`, the merit list reads
only the live version), R334 (profile scope `404`, sections gated by their keys), R335 (both
discrepancy kinds), R336 (each report's CSV equals its JSON rows, injection prefix, file name,
audit, cost 5, page/limit refused, cross-site refused), R337, R338 (`404` outside scope, `403`
without the key), R16 (the identity scan reads the CSV exports and the profile), §7.2 budgets
(statement over a year ≤ 1.5 s; ranking of 5 sections ≤ 500 ms).
