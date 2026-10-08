# Slice 34 contracts — certificates

**Author:** Opus 5.5 (wave N, agent B), 2026-10-08. **Binds:** `apps/api/src/modules/certificates/**`,
`repositories/certificate.repository.ts`, the certificate lines of
`common/errors/constraints-academics.ts`, the two certificate fields of `school-settings.*` and
`SchoolSettingsRepository.defaultCertificateSignatory`, `FinanceReportsModule`'s export of
`FinanceReportsService`; the web pages `/certificates`, the student page's Certificates panel and
the settings page's Certificates card. **Source:** `phase-4-academic.md` §1.1 (rule 29 rows), §3.2
"Certificates", §3.4, §4 "Slice 34", §5.1, slice 34 (R289–R293), §7.1, and migration
`20261007160000_wave_n_assessments_certificates`. Everything not restated follows the Phase 1–3
conventions (envelope, string ids, `PageQueryDto` capped at 50, `NoQueryDto`, `@ApiErrors()`, `404`
for another school's id or a row outside the caller's scope, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /certificates` | `certificate.issue` | the register, page of `CertificateDto` (with bodies); filters `type?`, `studentId?`, `issuedFrom?`, `issuedTo?` (dates, inclusive), `voided?` (`true` only voided, `false` only valid); sort `-issuedOn` (default) or `issuedOn`, ties by id |
| `POST /students/:id/certificates` | `certificate.issue` + `Idempotency-Key` (endpoint `certificates`, path id the student) | `IssueCertificateDto { type, academicYearId?, title? 1–80, conduct? 1–100, remarks? 1–500 }` → `201 CertificateDto`; `200` + `Idempotency-Replayed: true` on a replay; §3 |
| `GET /certificates/:id` | `certificate.issue` | `CertificateDto` |
| `GET /certificates/:id/print` | `certificate.issue`, `SameSitePrintGuard`, throttle bucket `print` (20/min, 200/h per user) | HTML through `sendPrintView`; §4 |
| `POST /certificates/:id/reissue` | `certificate.issue` + `Idempotency-Key` (endpoint `certificates`, path id the certificate reissued) | `ReasonDto` → `201 CertificateDto`; §3.3 |
| `POST /certificates/:id/void` | `certificate.issue`, then `requirePrincipal` (R233's gate: the system role, never a grant) | `ReasonDto` → `200 CertificateDto`; `403 PERMISSION_DENIED { reason: 'principal_required' }`; §3.4 |
| `GET /students/:id/certificates` | `certificate.issue` or `student.view`, row scope applied | page of `CertificateSummaryDto` (no body, dues status or reason), sort as the register; a student outside the scope is `404` |

`PrintThrottleGuard` is exported from `certificates.controller.ts`; wave O's result prints join the
same bucket by importing it. `SameSitePrintGuard` (`common/print-view.ts`, wave N review) refuses a
request whose `Sec-Fetch-Site` header is present and is neither `same-origin` nor `none` with `403
ORIGIN_REJECTED`, before the print is counted or audited; it also guards the receipt and payslip
print routes (`GET /receipts/:id/print`, `GET /payslips/:id/print`,
`GET /me/staff/payslips/:id/print`). A request without the header (the mobile app) passes.

## 2. DTOs

`CertificateSummaryDto { id, studentId, studentName, admissionNo, type, number, label ('LC-0001'),
issueNo, reissueOfId, academicYearId, academicYearName, title, issuedOn, issuedByName,
printedCount, voidedAt, voidedByName, voidReason, createdAt }`. `CertificateDto` (the register,
`certificate.issue` only) adds `duesStatus`, `reason` and `body: CertificateBodyDto`; the summary
carries neither the dues status nor the reason, because a `student.view` holder without
`certificate.issue` reads it (wave N review). `studentName` and `admissionNo` are the student's **now**; the
body keeps them as issued. `title` is the stored title, else the type's own (`School Leaving
Certificate`, `Character Certificate`, `Academic Certificate`, `Completion Certificate`).
No user id, no identity number, no dues figure appears in either DTO.

`CertificateBodyDto { schoolName, studentName, fatherName, admissionNo, gender, dateOfBirth,
admittedOn, studentStatus, academicYearName, className, sectionName, attendedFrom, attendedTo,
enrolments: [{ academicYearName, className, sectionName, from, to }], conduct, remarks,
signatoryName, result }` (dates `YYYY-MM-DD`). `result` (wave P) is the marks table of an academic
or completion certificate, `CertificateResultDto` (contracts/slice-32.md §6), else null.

## 3. Behaviour

### 3.1 Issue (R289–R291)

In one transaction, in this order: the idempotency claim; the student in the caller's scope
(`404`); the student's enrolments with names (at most 50); the year — `academicYearId` must be a
year the student has an enrolment in (`422 REFERENCE_NOT_FOUND` on `academicYearId`), default the
newest enrolment's; a type other than `other` with no year at all is the same `422`; `other`
without a title is `422 INVALID_VALUE` on `title`; a title on any type but `other` is the same
`422`, and so is an `other` title containing "leav" (any case): only the `leaving` type is a
leaving certificate (wave N review; CHECK `certificates_title_other_check`, migration
`20261008090000_certificate_title_other`). Then for `leaving` only: the student's status
must be `withdrawn | transferred | alumni` (`409 CERTIFICATE_STUDENT_NOT_LEFT { studentId }`), then
`FinanceReportsService.clearance(studentId)` — the only dues read (§5.1, lint
`MONEY_REPOSITORY_IMPORT`): not cleared → `409 CERTIFICATE_DUES_BLOCK { outstanding }`; cleared by
the principal's override → `dues_status = override`, `reason` = the override's reason; cleared
because nothing is owed → `cleared`. Every other type is `not_required` and reads no dues. Then
the signatory (§6), the body (§3.2), the number **last** — `school_counters` `cert_<type>`,
upserted at 1 on first use and advanced under the row lock, so numbers are gapless in commit
order (R289, tested with two concurrent issues) — and the insert, the subject of the key, and the
audit row. Certificates are issued to students of any status (A10); the year being closed does
not matter (R291's "left in a closed year prints" is tested).

### 3.2 The body — one builder

`buildCertificateBody` (`certificate-body.ts`) is the only writer. It holds the student's name,
father's name (a live `father` link first, else the newest ended one; null if none), admission
number, gender, date of birth, admission date, status at issue, the named year's class and section
(its latest enrolment, so a section change ends where the student ended), the dates of attendance
(first enrolment's start to the last one's end, null while still enrolled), the whole enrolment
history oldest first, the conduct and remarks typed by the issuer, and the signatory. It never
holds an identity number, a phone, an address, a dues figure, a user id, an object key or a Phase 2
remark. Every string is checked with `containsIdentityNumber` before the insert (a hit is a `500`:
the inputs were validated where they were stored), and the database CHECK
`certificates_body_no_id_check` is the line behind it. The repository reads a body back field by
field and refuses (500) any other shape.

**Done in wave P (slice 32's agent):** `academic` and `completion` certificates carry the marks
table of the published result (A11: the named year's published, live final result, else its last
published term by `sort_order`, read through `ResultCardsService.certificateResultFor`) in
`body.result`, snapshotted at issue like the rest (a later correction changes nothing issued; a
reissue copies it); with none published the issue is refused `409 CERTIFICATE_NO_RESULT
{ certificateId: null }` before the signatory default or the counter. The repository parser reads a
missing `result` (bodies issued before) as null. The print view prints the table above the record
of attendance.

### 3.3 Reissue (R289)

Locks the certificate (compare-and-set on `updated_at`), then every row of its number
(`lockNumber`, `SELECT ... FOR UPDATE`, as a void does); refused with `409 CERTIFICATE_VOIDED
{ certificateId }` when **any** issue of the number is voided (a voided number is never reissued). The new row copies the student, type, number, year, title, body and dues status,
takes `issue_no` = the number's highest + 1, names the row reissued in `reissue_of_id`, and stores
the reissue's reason. A reissue of a reissue is the next issue. Two reissues of one number through
different rows at once: the loser hits `certificates_school_id_type_number_issue_no_key`, mapped to
`409 CONCURRENT_UPDATE` (retryable). The print shows **DUPLICATE** and "issue n".

### 3.4 Void (R293)

Voiding a certificate voids its **number** (wave N review). Read in scope (`404`), then the
principal gate; already voided is `409 CERTIFICATE_VOIDED`. Then every row of `(school_id, type,
number)` is locked (`lockNumber`) and every live issue of the number is stamped with the void trio
in one statement (`voidNumber`, `voided_at IS NULL` in the predicate), so a duplicate never stays
valid beside a voided original, nor the reverse. The audit row lists the issues stamped. The
number is never reused (the counter never moves back) and the rows stay in the register, marked
voided.

## 4. The print view (R292, §3.4, §7.1)

One scriptless layout for the five types (`certificate-print.ts`), built with the escaping `html`
tag and sent only through `sendPrintView` (`no-store`, the CSP, `nosniff`): the school name, the
title, `No. LC-0001` and the issue date, DUPLICATE on a reissue, a VOID banner with the reason on a
voided row, one certifying sentence per type, a details table, the record of attendance (leaving,
academic, completion), "Issued by <issuer>" and the signatory's name over "Authorised signatory".
**The B-Form number** prints only on a `leaving` certificate that is not voided while
`certificate_show_identity_no` is on: the handler path decrypts `students.b_form` under the
school-bound AAD (`bFormAad`) and passes the digits to the page; they are never stored, logged or
returned as JSON. Every print increments `printed_count` and writes `certificate.printed
{ certificateId, issueNo, identityPrinted }` in the same transaction. The web opens the URL in a new
tab (`window.open`, `noopener`) and never holds the HTML.

## 5. Errors

| Code | Status | Details | When |
|---|---|---|---|
| `CERTIFICATE_STUDENT_NOT_LEFT` | 409 | `studentId` | leaving, student still active or suspended |
| `CERTIFICATE_DUES_BLOCK` | 409 | `outstanding` | leaving, dues neither paid nor overridden |
| `CERTIFICATE_VOIDED` | 409 | `certificateId` | reissue of any issue of a voided number, or void of a voided certificate |
| `ORIGIN_REJECTED` | 403 | none | print requested with `Sec-Fetch-Site` other than `same-origin` or `none` |
| `PERMISSION_DENIED` | 403 | `reason: principal_required` | void by a non-principal |
| `CONCURRENT_UPDATE` | 409 | — | `certificates_school_id_type_number_issue_no_key` (mapped in `constraints-academics.ts`) |
| `REFERENCE_NOT_FOUND` | 422 | field `academicYearId` | a year the student was never enrolled in, or no enrolment |
| `INVALID_VALUE` | 422 | field `title` | `other` without a title; a title on another type; an `other` title containing "leav" |
| `CERTIFICATE_NO_RESULT` | 409 | `certificateId: null` | academic or completion, no published result of the year (§3.2) |

## 6. Settings

`SchoolSettingsDto` gains `certificateSignatoryName: string | null` and
`certificateShowIdentityNo: boolean`; `UpdateSchoolSettingsDto` accepts both (`school.settings.manage`,
existing route, audited in `school_settings.updated { changes }`). The name is a `NameField(1, 100)`
(trimmed, spaces collapsed, no identity number); `null` clears it. **Default at first issue:** an
issue that finds no signatory writes the first active principal's name (a conditional write, so a
name set meanwhile wins), records `signatoryDefaulted: true` in its `certificate.issued` row and
writes `school_settings.updated { changes: { certificateSignatoryName: { from: null, to } } }`
(actor the issuer, subject the settings row) as the PATCH does (wave N review); a
school with no active principal signs `Principal` and stores nothing. The body snapshots the
signatory, so a later change alters nothing issued.

## 7. Audit (R57)

`certificate.issued { studentId, type, label, academicYearId, duesStatus, signatoryDefaulted }`
(reason = the dues override's, when there is one) · `certificate.reissued { reissueOfId, studentId,
label, issueNo }` (reason) · `certificate.voided { label, issueNo, issueNos }` (reason; `issueNos` the issues the void stamped,
ascending, as text `"1, 2"`: audit metadata holds no arrays) · `school_settings.updated` when the
first issue defaults the signatory (§6) ·
`certificate.printed { certificateId, issueNo, identityPrinted }`. A replayed issue or reissue
writes no row. Subject type `certificate`, subject id the row written (the new row on a reissue).

## 8. Screens

- **`/certificates`** (nav "Certificates", `certificate.issue`): the register with type and
  valid/voided filters; badges for DUPLICATE n and Voided; dues column (Cleared / Overridden);
  row menu Print (new tab), Reissue (reason; a fresh `Idempotency-Key` per dialog), Void (principal
  only; reason). "Issue certificate" opens a student search (any status) then the issue form.
- **Issue form** (shared with the student page): type, the student's own enrolment years (blank =
  latest), title (shown and required only for Other, never "leav..."), conduct, remarks; one key per opened form so a retry after a
  refusal is the same request; refusals in the office's words (`CERTIFICATE_REFUSALS`).
- **Student page, Certificates tab** (wave N review: its own tab, so a `certificate.issue` holder
  without `fee.statement.view` reaches it): the student's certificates (summary), Print, Issue.
- **Settings**: a Certificates card with "Signed by" and "Print the B-Form number on leaving
  certificates".

## 9. Tests

`apps/api/test/certificates/certificates.e2e-spec.ts` (R289 concurrency, voids, reissue chain and
DUPLICATE; idempotent replay; R290 status and dues gates with `dues_status`; R291 snapshot, reissue
copy, closed-year print, wrong year; R292 print gating, audit, `printed_count`, no JSON carries it;
R293 principal-only void, register filters, student list without bodies; refusals and scope;
cross-school 404s; the settings fields; R16 over every response and log line of the file, the
whole `certificates.body` column and every `certificate.*` audit row). Control 4 through
`CertificateRepository` in `test/academics/isolation.spec.ts`. Lint boundaries in
`test/guardrails/lint-boundaries.spec.ts` (fixtures `certificate-repository-import.ts`,
`money-repository-import.ts`). Web: `apps/web/e2e/certificates.spec.ts` (mocked).

## 10. Deviations from the plan

- `CERTIFICATE_STUDENT_NOT_LEFT` carries `details.studentId`, not `certificateId` (no certificate
  exists when it is raised); the comment in `packages/shared/src/error-codes.ts` says so.
- `CERTIFICATE_NO_RESULT` and the marks table arrived in wave P (§3.2; tests in
  `test/results/report-cards.e2e-spec.ts`).
- A void voids the certificate number, not one row: every live issue of `(type, number)` is
  stamped in one statement, and a reissue is refused when any issue of the number is voided
  (wave N review; replaces the build's per-row void).
- The student page's panel is its own Certificates tab rather than on the Fees tab, so a holder
  of `certificate.issue` without `fee.statement.view` reaches it (wave N review).

## Phase 4 close (slice 36, 2026-10-08)

- The certificate body's marks-table subjects carry `examAbsent` and `examExcused` (snapshotted at
  issue; a body issued before slice 36 reads both as false), and `CertificateResultSubjectDto` has
  both. The print shows `Ab` / `Ex` after the subject and the legend line, as the report card does
  (`slice-32.md`, Phase 4 close).
- R16: the identity scan covers `certificates` (`body::text`, `title`, `reason`, `void_reason`),
  `assessments` (`name`, `void_reason`), `academic_terms.name` and `term_skips.reason`
  (`test/guardrails/identity-scan.e2e-spec.ts`, security L1).
