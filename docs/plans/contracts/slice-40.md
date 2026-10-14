# Slice 40 contracts — document verification

**Author:** Opus 5.5 (wave S), 2026-10-10. **Binds:** `apps/api/src/modules/documents/verification.*`,
the slice-40 methods of `repositories/student-document.repository.ts`, `StudentDocumentDto`'s
decision fields, `SchoolSettingsDto.requiredDocumentTypes`, `StudentDto.documentsIncomplete`, the
`documents` section of `GET /me/approvals`; the web pages `/documents` and
`/documents/incomplete`, the student page's Documents tab (checklist, verify, reject), the
students list badge, the settings card; the phone's Approvals → Documents. **Source:**
`phase-5-extended.md` §0.36, §1.1 (rule 36 rows), §1.3 A7, §3.2 "Documents", §3.6, §3.7, §5 slice
40, §7.1, R322–R325; schema from the groundwork (`20261009120100_phase5_groundwork`). Everything not
restated follows the Phase 1–4 conventions (envelope, string ids, `PageQueryDto` ≤ 50, `NoQueryDto`,
`@ApiErrors()`, `404` outside the caller's scope, `ReasonDto`, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /documents?status&type&classId&sort` | `document.verify` | page of `QueuedDocumentDto`; `status` default `uploaded`; `classId` = students actively enrolled in that class; sort `createdAt` (default, oldest first) \| `-createdAt`. Row scope: the `document.verify` scope (office and principal `all`) |
| `GET /documents/incomplete-admissions?admittedFrom&admittedTo&sort` | `document.verify` | page of `IncompleteAdmissionDto` (§2.4); sort `admittedOn` (default) \| `-admittedOn`. CSV comes in slice 42 |
| `POST /documents/:id/verify` | `document.verify` | no body → `200 StudentDocumentDto` (§2.2) |
| `POST /documents/:id/reject` | `document.verify` | `ReasonDto` → `200 StudentDocumentDto` |
| `GET /students/:id/document-checklist` | `document.view` | `DocumentChecklistDto` (§2.3) |
| `GET /me/children/:id/documents` | guardian | `MyDocumentChecklistDto` (§2.5); a child outside the capacity scope `404`; `me-reads` |
| `GET /me/student/documents` | student | the same for the student's own record |
| `PATCH /school/settings` (existing) | `school.settings.manage` | gains `requiredDocumentTypes` (§3) |
| `GET /me/approvals` (existing) | staff | gains `documents?` for `document.verify` holders: exactly `GET /documents` page 1 of 10, `count` = its total |

### DTOs

- `StudentDocumentDto` (staff) gains `status` (`uploaded \| verified \| rejected`), `decidedAt`,
  `decidedByName`, `rejectReason` (null unless rejected).
- `QueuedDocumentDto extends StudentDocumentDto { student { id, admissionNo, fullName, className,
  sectionName }, ownUpload }` — `ownUpload` true when the caller uploaded it (they may not decide it).
- `DocumentChecklistDto { studentId, items: { type, status: missing \| uploaded \| verified \| rejected,
  document: StudentDocumentDto \| null }[], complete }` — items are the school's required types in
  `DOCUMENT_TYPES` order; `complete` = every item verified (an empty list is complete).
- `MyDocumentChecklistDto { studentId, items: { type, status, note }[] }` — no ids, names, dates or
  reasons (R322). `note` is fixed text: rejected → "Please re-upload the <type>."; missing →
  "Please send the <type> to the school office."; otherwise null.
- `IncompleteAdmissionDto { studentId, admissionNo, fullName, admittedOn, className, sectionName,
  missing[], awaiting[], rejected[] }` (types in `DOCUMENT_TYPES` order).
- `StudentDto.documentsIncomplete: boolean | null` — null unless the caller holds `document.view`.

## 2. Behaviour

### 2.1 The queue

The school's documents of `status` whose student is in the caller's `document.verify` scope
(computed by `PermissionsService.can`, so the Approvals read on its `@RequireStaff` route gets the
same rows). A queue row of the caller's own upload stays listed, flagged `ownUpload`, as the claims
queue lists an own-family claim (slice 27).

### 2.2 Verify and reject (R322)

In one transaction: the document through the caller's scope (`404`); decided →
`409 DOCUMENT_ALREADY_DECIDED { documentId, status }`; uploaded by the caller → `409
SELF_ACTION_FORBIDDEN { reason: own_upload }` (no sole-principal exception: another staff member,
the office by default, can always decide); then one conditional `UPDATE … WHERE status =
'uploaded'`. A racing decision that got there first answers `DOCUMENT_ALREADY_DECIDED`; the
`student_documents_not_self` and transition triggers are the database's line (mapped in
`constraints-phase5.ts`). Reject needs `ReasonDto` (3–500, no identity number). Audit
`document.verified | document.rejected` (subject `student_document`, metadata `{ studentId, type }`,
the reject reason in `reason`). A decision is final; a re-upload is a new `uploaded` row (POST
`/students/:id/documents`, unchanged). No message is sent.

### 2.3 The checklist (R323)

Per required type, the newest row of the type (`created_at DESC, id DESC`): none → `missing`,
else its status.

### 2.4 Incomplete admissions (R323)

Students admitted between `admittedFrom` and `admittedTo` inclusive (default: today in school
time and 90 days before; `422` on `admittedTo` if reversed or more than 3,660 days apart), status
`active` or `suspended` (on the roll), in the caller's scope, with at least one required type whose
newest row is missing, `uploaded` or `rejected`. One SQL statement pages it (`LIMIT/OFFSET`) and a
second counts the same set. No required types → empty.

### 2.5 The family view (R322)

The capacity scope's child (guardian) or the student's own record (student): status and fixed note
per required type. Never the reason, the decider, the uploader or a document id.

### 2.6 The list badge

`StudentsService.toDtos` adds `documentsIncomplete` for `document.view` holders: one DISTINCT ON
statement per page (newest row per student and required type). A school without its settings row
(a data fault) reads the column default for the badge only; the checklist and report answer `500`
as every other settings reader does.

### 2.7 Never a gate (R324)

Nothing in admission, readmission, enrolment, promotion, certificates or status changes reads a
document's status.

## 3. Settings

`SchoolSettingsDto.requiredDocumentTypes: DocumentType[]` (in `DOCUMENT_TYPES` order). PATCH:
distinct (`ArrayUnique`), each a `DocumentType`, `null` → `422`; an empty list requires nothing.
Audited with the other settings (`school_settings.updated`, comma-joined from/to).

## 4. Web

- `/documents` (nav "Documents", `document.verify`): the queue with type, class and status filters;
  Verify and Reject (reason dialog) per row, disabled with a hint on the caller's own uploads;
  download through the existing content route. A link to `/documents/incomplete`.
- `/documents/incomplete`: the report with an admission date range.
- Student page → Documents tab: the checklist card (status badge per required type) above the
  list; the list gains a Status column and, for `document.verify` holders, Verify / Reject.
- `/students`: a "Documents incomplete" badge beside the name when `documentsIncomplete`.
- `/settings`: a "Required documents" card (checkboxes per type) for `school.settings.manage`.
- The Approvals nav entry also shows for `document.verify`; the board gains a Documents section.

## 5. Mobile

Approvals (principal/office): a Documents section from `GET /me/approvals` → `documents`; Verify
and Reject (reason) online-only (`verify_document`, `reject_document` in `ONLINE_ONLY_ACTIONS`),
refreshed after; own uploads show no actions. No outbox lane. The document is shown through the
existing `Attachment` (tap to load, never presigned), which gains an optional `thumbnailPath`
because a student document has no thumbnail route: the preview loads `GET /documents/:id/content`.

## 6. Deviations from the plan

1. **Family routes added** (`/me/children/:id/documents`, `/me/student/documents`): the plan names a
   family DTO but no route; without one the family DTO had no reader. No family screen is built in
   this slice (the API carries it for the phone's child screen later).
2. **`GET /students/:id/document-checklist`** under `document.view`: the plan puts the checklist on
   the student page but names no route; the office cannot read `/school/settings`.
3. **Incomplete admissions count only students on the roll** (active, suspended); a withdrawn,
   transferred or alumni student's missing papers are not an admission query.
4. **`missing` has fixed family text** too ("Please send the <type> to the school office.").
5. **The list badge** is a nullable boolean on `StudentDto`, computed for every caller holding
   `document.view` (the plan says "a query badge on the student list").
6. **The badge's read takes the row scope** (security L1, fix round 2026-10-14):
   `StudentDocumentRepository.newestOfTypes(schoolId, scope, …)` adds `studentInScopeSql` to its
   DISTINCT ON statement, and `DocumentVerificationService.incompleteAmong` takes the caller's
   `Scope` from `StudentsService.toDtos`. Test: `verification-isolation.e2e-spec.ts` "the badge's
   newest row per type is read through the caller's row scope".
7. **Identity scans are not disk-cached on the phone** (security L3): `Attachment` takes
   `cachePolicy` (default `disk`); the approvals document sheet passes `none`. Test:
   `src/approvals/documents.spec.tsx` (and `family.spec.tsx` keeps a diary photo on `disk`).

## 7. Tests

`test/documents/verification.e2e-spec.ts` (R322–R325, the queue, the checklist, the badge, the
setting, the report, the family DTO), `test/documents/verification-isolation.e2e-spec.ts`
(control 4 for the new reads and the decision), plus `test/approvals` (the section),
`test/core` (route guards, the no-capability snapshot, the audit table); web
`e2e/documents.spec.ts` (mocked); mobile `src/approvals/documents.spec.tsx`.
