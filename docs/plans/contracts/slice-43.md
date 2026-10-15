# Slice 43 contracts — commencement imports (past results, opening balances)

**Author:** Opus 5.5 (wave U), 2026-10-15. **Binds:** `apps/api/src/modules/imports/**`,
`repositories/import.repository.ts`, `modules/results/result-import.service.ts`,
`AssessmentsService.importExamMarks`, `ChargesService.openingBalanceHead | openingBalanceAdvances |
createOpeningBalances`, `Advances.available`, `ResultSheetRepository.createImported | idOfImport |
existsForSectionTerm`, `MarkReadsRepository.liveMarkExists`, `ChargeRepository.createImported`,
`FeeHeadRepository.findSeededOpeningBalance`, `PermissionsService.marksImportScopeOf`, the
staged-upload sweep's `expireImports`, `ResultDto.imported`, the parsers in
`packages/shared/src/imports/`; the web page `/imports` and the card's "Imported" line. **Source:**
`phase-5-extended.md` rule 39, §0.34, §1.1 (past results file, opening balance file), §1.3 A10,
§3.1-§3.5, §5 slice 43, §7.1 Imports, §7.2, R339-R343, R355. Everything not restated follows the
Phase 1-4 conventions (envelope, string ids, `PageQueryDto` ≤ 50, `NoQueryDto`, `404` outside the
school or outside what the caller may import, no `DELETE`). **No migration:** the wave U schema
(`a659e76`) holds every table, column, CHECK and trigger this slice writes.

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `POST /imports/past-results` (multipart: `file`, `sectionId`, `termId`) | `result.publish` (route) + `assessment.define` (service, `403 PERMISSION_DENIED { reason: assessment_define_required }`); the write scope must be school-wide (`403 … school_wide_required`) | keyed (`imports`, path id 0, the file's sha-256 in the request hash); `201 ImportDetailDto`, replay `200` |
| `POST /imports/opening-balances` (multipart: `file`, `academicYearId`, `dueOn`) | `charge.create` (route) + principal role (service, `403 { reason: principal_required }`); `@DefaultPasswordInert('import.opening_balances')` | keyed as above; `201 ImportDetailDto` |
| `POST /imports/:id/commit` | `result.publish \| charge.create` (route); the kind's pair (service); an opening-balances commit on a default password is `403 DEFAULT_PASSWORD_BLOCKS_ACTION` | keyed (`imports`, path id the import); `200 ImportDetailDto`, replay `200` + `Idempotency-Replayed` |
| `GET /imports?kind&status` | `result.publish \| charge.create` | page of `ImportDto`, `-createdAt`; only the kinds the caller may import |
| `GET /imports/:id` | same | `ImportDetailDto`; `404` for another school's or a kind the caller may not import |

Throttle `import-writes` 5/min, 30/h per user on the three writes.

### 1.1 The file

The CSV travels **in the preview request** (multipart, one `file` part ≤ 2 MB, at most three text
fields of ≤ 64 bytes), is parsed in memory by the shared parsers and is **never stored**: only the
parsed rows reach the `imports` row. Both routes are added to `NON_JSON_BODY_ROUTES`; the origin
guard (R65) applies as on `/uploads`. File name: last path segment, printable ASCII, ≤ 120, else
(or if it holds an identity number) `import.csv`; shown back as text only.

A file that cannot be read at all (`too_large`, `not_utf8`, `empty`, `unterminated_quote`,
`too_many_rows` > 5,000, `too_many_columns` > 64, `cell_too_long` > 64, `ragged_row`) is `422
VALIDATION_FAILED` on `file` and writes nothing.

### 1.2 DTOs

- `ImportDto { id, kind, status, fileName, rowCount, academicYearId/Name, classId/Name?,
  sectionId/Name?, termId/Name?, dueOn?, createdByName, createdAt, expiresAt (createdAt + 24 h),
  committedByName?, committedAt?, failedAt?, error?, errorCount, errors: ImportRowErrorDto[] ≤ 100 }`.
- `ImportRowErrorDto { row (file line; header 1; 0 = a roster student the file omits), field, code,
  admissionNo? (only on missing_from_file) }` — never a refused cell's text.
- `ImportDetailDto = ImportDto + { subjects: { classSubjectId, name, maxMarks }[], rows:
  ImportRowDto[], totalAmount?, totalAdvance?, resultSheetId? }`; `ImportRowDto { row, studentId,
  admissionNo, studentName, marks? ({ classSubjectId, obtained | null }[] in subject order), amount?,
  note?, advance? }`. `rows` is empty while the file has row errors.
- `ResultDto.imported` (R343): the card's sheet has provenance `imported`; the printed card says
  "Imported from the school's earlier records".

## 2. Behaviour

### 2.1 Preview (R339) — writes the `imports` row only

Past results: the section and term (404 unless of the school and the same year); refused, in order,
`IMPORT_YEAR_CLOSED` (year closed), `SECTION_ARCHIVED`, `CLASS_ARCHIVED`, `422 termId` (term not
held for the class), `422 sectionId` (the class has no subjects), `IMPORT_SHEET_EXISTS` (any sheet of
the section-term, any status), `IMPORT_MARKS_EXIST` (any live mark on a non-voided assessment of the
class-term that is the section's, or that is a roster student's), `IMPORT_DUPLICATE_FILE { importId
}` (this file committed before). Context: the class's live subjects in print order, each with its
exam's max (the section-term's live exam if any, else the class-subject's), the roster = the
section's enrolments in force on the term's last day, the school's admission numbers the file names.

Opening balances: the year (422 `academicYearId` unknown; `IMPORT_YEAR_CLOSED`), `dueOn ≥ today`
(422), the seeded head usable (`FEE_HEAD_ARCHIVED`, or 409 `REFERENCE_NOT_FOUND` if never seeded),
`IMPORT_DUPLICATE_FILE`. Roster = students of the year with an open enrolment, active or suspended.
Each valid row carries `advance` = min(the child's unallocated advance in the year, amount).

Row errors (the shared parsers): header (`first_column`, `unknown_column`, `missing_column`,
`duplicate_column`), `required`, `identity_number` (an identity-shaped admission number or note:
refused, never stored or echoed — slice 43 added the admission-number check to both parsers),
`duplicate`, `unknown_admission_no`, `not_on_roster`, `missing_from_file` (past results: a roster
student the file omits is an error, never an absence), `invalid_mark`, `over_max`,
`invalid_amount` (≤ 0 or not whole rupees). The import is born `previewed` with `rows` (none if any
error), `errors` (first 100), `errorCount`. Audit `import.previewed { kind, rowCount, errorCount,
academicYearId, sectionId, termId, dueOn }`.

Stored rows: past results `{ row, admissionNo, studentId, enrolmentId, marks: { <classSubjectId>:
obtained | null } }`; opening balances `{ row, admissionNo, studentId, enrolmentId, amount, note,
advance }`.

### 2.2 Commit (R340-R342) — one transaction

Before the key: an import found expired (`createdAt + 24 h ≤ now`) is failed `expired` in its own
transaction (audit `import.failed { kind, reason }`) and answered `IMPORT_EXPIRED`. In the keyed
transaction: the idempotency claim; the import's row lock (`IMPORT_NOT_PREVIEWED` when committed or
failed, `IMPORT_EXPIRED` when failed expired); `IMPORT_EXPIRED` if it lapsed meanwhile (and it is then
failed after the rollback); `422 IMPORT_ROWS_INVALID { importId, rows ≤ 100, errorCount }` when the
preview had row errors; `IMPORT_DUPLICATE_FILE`. Then:

- **Past results:** every preview refusal again; the roster and subjects must be exactly those the
  preview validated (`409 STALE_STATUS` otherwise: "upload the file again"); exams created where
  missing (held on the term's last day, max from the preview, named "<term> exam"); one live mark
  per row and subject (`null` = absent, prints "Ab"); the sheet born `published`, provenance
  `imported`, `import_id`, version 1, no submitter, `decided_by = published_by = created_by =` the
  importer, snapshot = the year's pass mark, rule and bands with **test 0 / exam 100**; results by
  the shared composition (`ResultComposer.term` with those weights), inserted with `published_at`
  **and `notified_at`** = now, so result-notify and its sweep send nothing (no message, §0.34); then
  `ClassRankingService.recompute(…, 'import', importer)` (slice 42) — a version only when every
  section of the class-term is published.
- **Opening balances:** the year still open, `dueOn` not yet past (422 otherwise), every row's
  enrolment still on the roster (`STALE_STATUS`); one `manual` charge per row under the seeded head
  (`once`, no period: never a late-fee candidate; the trigger refuses a late fee on it anyway),
  description "Opening balance[: note]", `import_id`, due on the file's date; then
  `Advances.applyTo` for the year's children (R189).

Then the import is stamped `committed` (needs `error_count = 0`) and audited `import.committed {
kind, rows, sheetId, results, examsCreated, marks, rankingId | charges, amount, advanceApplied }`.

### 2.3 Expiry

The daily staged-upload sweep (`sweepAll`) calls `expireImports(schoolId, now)` per school after its
upload sweep: every preview older than 24 h → `failed`, `failed_at`, `error 'expired'`, one system
audit row `import.failed { job: staged-upload-sweep, reason: expired }` each. `sweepSchool` and its
result shape are unchanged.

## 3. Boundaries and lint

`ImportRepository` (lint group `importRepository`) is importable only from `src/modules/imports/**`,
`test/imports/**` and `src/modules/documents/staged-upload.sweep.ts` (named-exception site entry
gains the exemption). The imports module imports no money repository (`MONEY_REPOSITORY_IMPORT`),
and no assessment or result repository (already confined): marks through
`AssessmentsService.importExamMarks` (`AssessmentsModule` now exports `AssessmentsService`), sheets
and results through `ResultImportService` (exported by `ResultsModule`), charges through
`ChargesService`.

## 4. Tests

`test/imports/*.e2e-spec.ts`: R339 (preview writes only the import; every row error with its line;
identity cells refused and never stored), R340 (commit in one transaction: exams, marks, sheet,
results, no message; `IMPORT_SHEET_EXISTS`, `IMPORT_MARKS_EXIST`), R341 (duplicate file, idempotent
commit, expiry by commit and by sweep), R342 (charges under the seeded head; defaulters, statement,
reminders from `dueOn`; counter payment; no late fee; advance applies; the Phase 3 identities), R343
(the card's `imported` flag and print; ranking), rule 24, isolation, timing (60 × 12 commit ≤ 3 s).

## 5. Deviations from the plan

1. **No staged upload.** The plan sends files through `POST /uploads` with a `text/csv` branch;
   `staged_uploads` admits only JPEG/PNG/PDF (`staged_uploads_mime_check`, `_object_key_check`,
   slice 6) and this slice may not migrate. The previews take the file directly (multipart, §1.1).
   Side effects: the CSV is never written to object storage (one fewer copy of children's data),
   and the file name is available. Reverting to the plan needs a migration widening both CHECKs and
   a `text/csv` branch in `upload-processing.ts`; the services take bytes and a name, so only the
   controller changes. The constraint mappings for `imports_*` now name `file`.
2. **`ResultImportService`** (results module) instead of `ResultSheetsService.importSheet`: keeps the
   import's sheet path out of the 750-line service slice 42 was editing at the same time.
3. **`ChargesService.createOpeningBalances`** (one `createMany` + one advance application) instead of
   `createManual` per row; one `import.committed` audit row instead of a `charge.created` row each.
4. **Commit refusals added:** `409 STALE_STATUS` when the roster or subjects changed since the
   preview; `422 dueOn` when the due date passed before the commit; the opening-balances commit is
   rule-24 inert in the service (the route list names only the preview route).
5. **Fix round (wave U review).** An opening-balance amount is bounded by `MAX_RUPEES` (R229, the
   bound every request amount carries): above it, `invalid_amount` (`parseOpeningBalances`). The
   trigger `charges_import_guard` fired on every late fee (its late-fee arm made the late-fee sweep
   over budget, 5.1 s against 5 s); migration `20261016130000_wave_u_import_guard_narrow` fires it
   for an imported charge only and adds `charges_import_period_check` (`import_id IS NULL OR period
   IS NULL`). An opening balance therefore never carries a period, the late-fee sweep selects only
   charges with one, and R342 ("never late-fee'd") holds by the sweep's predicate rather than by
   the trigger (`asms_charge_import_guard`'s late-fee arm stays in the function, no longer
   reached).
