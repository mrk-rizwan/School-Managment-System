# Slice 6 contracts — students, guardian links, enrolment, documents, admission

**Author:** api-designer, 2026-10-03. **Binds:** `apps/api/src/modules/people/students/**`,
`modules/admissions/**`, `modules/documents/**`, the slice-3 and slice-5 seams in §9,
`apps/web/app/(school)/students/**`, `(school)/admissions/**`. **Sources:** `CLAUDE.md` (rules 4,
5, 6, 9, 12, 17), plan §3.2–§3.10, §4 slice 6, §5 slice 6, R25–R44, R79, R82–R92, R97. Everything
not restated follows §3.9, `slice-1.md` and `slice-2.md`; scope as `slice-4.md` §1; guardian
shapes as `slice-5.md`. DTO fields use `common/fields.ts`. Paths are under `/api/v1`.

---

## 1. Access and scope

| Route | Decorator | Scoped |
|---|---|---|
| `GET /students`, `GET /students/:id`, `/students/:id/guardian-links`, `/enrolments`, `/status-changes` | `STUDENT_VIEW` | yes |
| `GET /students/:id/documents`, `/students/:id/photo`, `GET /documents/:id/content` | `DOCUMENT_VIEW` | yes |
| `POST /students/lookup`, `POST /admissions`, `POST /students/:id/readmit` | `STUDENT_CREATE` | — |
| `PATCH /students/:id` | `STUDENT_UPDATE` | yes |
| `POST /students/:id/change-status` | `STUDENT_STATUS_CHANGE` | yes |
| `POST /students/:id/guardian-links`, `PATCH /guardian-links/:id`, `POST /guardian-links/:id/end` | `GUARDIAN_MANAGE` | yes |
| `PATCH /enrolments/:id`, `POST /enrolments/:id/change-section`, `/change-class` | `ENROLMENT_MANAGE` | yes |
| `POST /students/:id/issue-login` | `USER_ACCOUNT_MANAGE` | — |
| `POST /uploads`, `POST /students/:id/documents` | `DOCUMENT_UPLOAD` | documents: yes |

All `@RequireCapability(...)`. **Scoped** = the service passes `scopeOf(session)` to the
repository, which filters in the query: a student is in scope when it has an `active` enrolment
whose `section_id` is in `scope.ids` (`kind: 'all'` = every student). Out of scope → `404
NOT_FOUND`, the same body as absent. Empty `ids` → no rows. In Phase 1 only `student.view` is a
teacher default, so teachers see active students of their sections; everything else is
school-wide by role, but repositories take the scope regardless (a grant later must not bypass it).

Common errors as `slice-5.md` §1.

---

## 2. Shapes

Enums: `Gender` `male | female` (for `data-architect`) · `StudentStatus` `active | suspended |
withdrawn | transferred | alumni` · `Relationship` `father | mother | guardian | other` ·
`EnrolmentStatus` `active | completed | left` · `DocumentType` `b_form | photo |
previous_school_leaving | guardian_cnic | other`.

`StudentDto`: `id`, `admissionNo` (string, digits), `fullName`, `gender`, `dateOfBirth` (date),
`hasBForm`, `bFormMasked` (string | null — **null unless the caller holds `student.update`**),
`status`, `admittedOn`, `current` (`{ enrolmentId, academicYearId, academicYearName, classId,
className, sectionId, sectionName, rollNo }` | null), `userId` (string | null), `createdAt`,
`updatedAt`. `StudentDetailDto` adds `notes` (null unless `student.update`) and `photoDocumentId`
(string | null — latest `photo` document; null unless `document.view`).

`GuardianLinkDto`: `id`, `studentId`, `guardianId`, `guardianFullName`, `relationship`,
`isPrimaryContact`, `isFeePayer`, `canLogin`, `phone` (string | null), `endedAt` (datetime | null),
`contactCapability`, `guardianCnicMasked`, `guardianAddress`, `guardianUserId` — the last four
**null unless the caller holds `guardian.manage`** (a teacher sees name, relationship, phone and
the flags only).

`EnrolmentDto`: `id`, `studentId`, `academicYearId`, `academicYearName`, `classId`, `className`,
`sectionId`, `sectionName`, `rollNo` (integer | null), `status`, `startedOn`, `endedOn` (date |
null).

`StatusChangeDto`: `id`, `fromStatus` (null for admission), `toStatus`, `reason` (string | null —
null for the admission row), `effectiveOn`, `changedBy` (user id), `changedByName`, `createdAt`.

`StudentDocumentDto`: `id`, `studentId`, `type`, `mime`, `sizeBytes`, `uploadedBy`,
`uploadedByName` (string | null — null when the uploader has no staff name), `createdAt`. The object key never leaves the server.

---

## 3. Students

### 3.1 `GET /students` — paginated, scoped

| Param | Rules |
|---|---|
| `status` | optional; absent = all (web sends `active`) |
| `academicYearId`, `classId`, `sectionId` | optional ids, applied to the active enrolment; unknown → empty page |
| `gender`, `hasBForm`, `hasLogin` | optional |
| `admittedOnFrom`, `admittedOnTo` | optional dates |
| `q` | `SearchField` 2–100: `full_name ILIKE` or `admission_no` prefix; a 13-digit run → `422` pointing at `POST /students/lookup` |
| `sort` | `fullName` (default), `-fullName`, `admissionNo`, `-admissionNo`, `admittedOn`, `-admittedOn`, `rollNo` (nulls last); `id` tiebreak |

### 3.2 `GET /students/:id` — `StudentDetailDto`.

### 3.3 `GET /students/:id/enrolments`, `/status-changes` — paginated, sort `-startedOn` / `-createdAt`.

### 3.4 `POST /students/lookup`

`{ bForm: CnicField }`. Throttle per user **30/min, 300/hour** → `429`. This is the per-user
**identity-probe budget**, one bucket shared by every route that can reveal whether an identity
number exists: this lookup, `POST /guardians/lookup`, `POST /admissions`, `PATCH /students/:id`
when the body carries a `bForm` string, and `POST /guardians`, `PATCH /guardians/:id`, `POST
/staff`, `PATCH /staff/:id` when the body carries a `cnic` string. Spreading probes across routes gains nothing. The budget counts identity numbers, not requests: a request spends one per number it can test (`POST /admissions` up to five). Not audited; logged without
digits. By `b_form_hash`. **200** `{ data: [{ student: StudentDto, readmissible: boolean }],
truncated: false }` — at most one hit (unique); `readmissible` = status `withdrawn | transferred |
alumni` (R26). A miss is `data: []`.

### 3.5 `PATCH /students/:id`

| Field | Rules |
|---|---|
| `fullName` | `NameField(2, 200)` |
| `gender` | enum |
| `dateOfBirth` | date, ≤ today, ≥ today − 30 years |
| `bForm` | `CnicField` or `null`; encrypted (AAD `schoolId\|students\|b_form`) with `b_form_hash` |
| `notes` | `TextField(0, 2000)` or `null` |

`null` on the first three → `422`. `bForm` present while a user has `student_id = :id` → `409
STUDENT_BFORM_LOCKED`. Taken in this school → `409 STUDENT_BFORM_EXISTS` `details: { studentId }`
(R25; constraint `students_school_id_b_form_hash_key`). A body with a `bForm` string spends the
identity-probe budget (§3.4) → `429` once it is spent. **200** `StudentDetailDto`.

### 3.6 `POST /students/:id/change-status`

`{ status, reason: TextField(3, 500), effectiveOn: date }`. Student row locked. R36:

| From → to | Result |
|---|---|
| `active → suspended` | enrolment kept |
| `active → withdrawn \| transferred` | active enrolment → `left`, `ended_on = effectiveOn` |
| `suspended → active` | — |
| `withdrawn \| transferred \| alumni → active` | `409 ILLEGAL_STATUS_TRANSITION`, `details.hint = 'readmit'` |
| `→ alumni`, same status, anything else | `409 ILLEGAL_STATUS_TRANSITION` `details: { from, to }` |

`effectiveOn` ≤ today, ≥ `admitted_on`, ≥ the active enrolment's `started_on`, ≥ the last status
change's `effective_on` — else `422`. Leaving `active` revokes the student user's sessions (student
capacity now requires `status = active`, §9). Retry-safety: a resubmit gets `409` with `from = to`;
the web treats that as done. Inserts `student_status_changes`. **200** `StudentDetailDto`.

### 3.7 `POST /students/:id/readmit` (R26)

`{ classId, sectionId, rollNo?, readmittedOn?: date (default today), reason: TextField(3, 500) }`.
Student locked; status not `withdrawn | transferred | alumni` → `409 ILLEGAL_STATUS_TRANSITION`.
Target checks as admission (§6.3). Status → `active`; new `active` enrolment (`started_on =
readmittedOn`); status-change row; admission number unchanged; live guardian links kept (R28/R29
must still hold, else `409 PRIMARY_CONTACT_REQUIRED` / `FEE_PAYER_REQUIRED` — fix links first).
Retry: a resubmit is `409 ILLEGAL_STATUS_TRANSITION`. **200** `StudentDetailDto`.

### 3.8 `POST /students/:id/issue-login` (R40) — `{ reason? }`

Amended 2026-10-03 (R57): the body is `IssueLoginDto` — `reason` optional, 3–500, trimmed, no
identity number; an absent body is the same as `{}`. The `user.login_issued` row always carries a
reason: the one given, else `LOGIN_ISSUED_REASONS.student` (`'Login issued from the student
record'`, `@asms/shared`). From the admission wizard (§9, step 5 offers) both the student dialog
and the guardian offers send `LOGIN_ISSUED_REASONS.admission` (`'Login issued at admission'`)
when the clerk gives none; the reason field there stays optional.

Student locked, in order: `school_settings.student_login_enabled` false → `409
STUDENT_LOGIN_DISABLED`; status ≠ `active` → `409 STUDENT_NOT_ACTIVE`; no B-Form → `409
IDENTITY_NUMBER_MISSING`; user with `student_id = :id` → `409 LOGIN_ALREADY_EXISTS`; **any** user
with `username_hash = identityHash(bForm)` → `409 USERNAME_IN_USE` — **never links**. Create with
the default password, `password_is_default = true`. Race outside the transaction: `staff_id`-style
unique on `student_id` → `LOGIN_ALREADY_EXISTS`; `username_hash` → `USERNAME_IN_USE`. **201**
`UserDto`. Audit `user.login_issued` `{ capacity: 'student', linkedExistingUser: false }`.

---

## 4. Guardian links (rule 9)

All writes lock the **student** row, which serialises R28/R29.

`GET /students/:id/guardian-links` — paginated, `includeEnded` (default `false`), sort primary
first then `guardianFullName`.

`POST /students/:id/guardian-links` — `{ guardianId, relationship, isPrimaryContact, isFeePayer,
canLogin }` (all required). Guardian merged → `409 GUARDIAN_MERGED` `details: { mergedIntoId }`;
live link exists → `409 GUARDIAN_LINK_EXISTS` `details: { linkId }`; `isPrimaryContact` and the
guardian has no phone → `409 PRIMARY_CONTACT_NEEDS_PHONE` (R30). `isPrimaryContact: true` clears it
on the current primary first, then sets it (partial unique `student_guardians_primary_key`). **201**.

`PATCH /guardian-links/:id` — `relationship`, `isPrimaryContact`, `isFeePayer`, `canLogin`; `null`
→ `422`. Ended → `409 GUARDIAN_LINK_ENDED`. `isPrimaryContact: false` on the primary → `409
PRIMARY_CONTACT_REQUIRED` (move it by setting `true` on another link). `isFeePayer: false` on the
last fee payer → `409 FEE_PAYER_REQUIRED` (R29). `true` on a phoneless guardian → R30 as above.
`canLogin` only gates guardian issue-login; it does not end an existing login. **200**.

`POST /guardian-links/:id/end` — `{ reason: TextField(3, 500) }`. Already ended → `200`, no audit.
Primary → `409 PRIMARY_CONTACT_REQUIRED`; last fee payer → `409 FEE_PAYER_REQUIRED`. Sets
`ended_at`. **200**.

---

## 5. Enrolments

`PATCH /enrolments/:id` — `{ rollNo: integer 1–9999 | null }` (**for `data-architect`: integer**).
Not `active` → `409 ENROLMENT_NOT_ACTIVE`; taken in the section → `409 ROLL_NO_TAKEN` `details: {
enrolmentId }` (R37; constraint `enrolments_section_roll_no_key`). **200** `EnrolmentDto`.

`POST /enrolments/:id/change-section` — `{ sectionId, reason?: TextField(3, 500) }`. Edited in
place: `section_id` set, **`roll_no` cleared** (R37). Section of another class → `422 INVALID_VALUE`
("use change-class"); same section → `200` unchanged. Refusals: `ENROLMENT_NOT_ACTIVE`,
`SECTION_ARCHIVED`, `CLASS_ARCHIVED`, `ACADEMIC_YEAR_CLOSED`. **200** `EnrolmentDto`.

`POST /enrolments/:id/change-class` — `{ classId, sectionId, effectiveOn: date, reason:
TextField(3, 500) }`. Class in another academic year → `409 CLASS_IN_OTHER_YEAR` (R38); same class
→ `422` ("use change-section"). `effectiveOn` ≥ `started_on`, ≤ today. One transaction (R39): old
enrolment `left`, `ended_on = effectiveOn`; new `active` enrolment, `started_on = effectiveOn`,
`roll_no` null. Never an edit. Retry: a resubmit is `ENROLMENT_NOT_ACTIVE`. **200** the new
`EnrolmentDto`.

---

## 6. Uploads, documents, admission

### 6.1 `POST /uploads` — the one multipart route

Field `file` only (`files: 1`, no other fields → `422`). Multer memory, limit 5 MB → `413
PAYLOAD_TOO_LARGE`. Throttle per user 20/min, 200/hour. Sniffed with `file-type`: `image/jpeg`,
`image/png`, `application/pdf` only, else `415 UNSUPPORTED_MEDIA_TYPE` (declared type and name
ignored; SVG, HTML, GIF refused). Images re-encoded by `sharp` (`limitInputPixels` 40 MP,
`failOn: 'error'`, first frame, EXIF stripped, same format); decode failure or pixel bomb → `415`
`details.reason = 'image_rejected'`; output > 5 MB → `413`. At most 4 re-encodes at once per
process; a wait over 10 s → `503 SERVICE_UNAVAILABLE`. Stored once at `{schoolId}/{ulid}.{ext}`
(ext from the sniffed type), private bucket, SSE. The `staged_uploads` row (`expires_at = now +
24 h`) is inserted **first**, then the object is written, so no crash between the two can leave an
object without a row for the sweep to find. If the write fails the row is expired at once
(`expires_at` = `created_at` + 1 ms, the earliest the CHECK allows: unusable, and the first sweep
past the grace period deletes the object if it landed, then the row); if even that fails, the row
expires in 24 hours. **201** `{ id, mime, sizeBytes,
expiresAt }`. **No read endpoint for staged content** (R41).

### 6.2 Documents

`GET /students/:id/documents` — paginated, filter `type`, sort `-createdAt`.

`POST /students/:id/documents` — `{ stagedUploadId, type }`. Consumed by one conditional update
(`uploaded_by = caller AND consumed_at IS NULL AND expires_at > now()`); no row → `422
REFERENCE_NOT_FOUND` on `stagedUploadId` — expired, consumed or another user's look identical
(R91). `type = photo` with a PDF → `422 INVALID_VALUE` on `type`. Inserts `student_documents` with
**the same object key**, nothing moved. Retry-safe: the same `stagedUploadId` already consumed into
a document of this student by this user → `200` with that document. **201**
`StudentDocumentDto`.

`GET /documents/:id/content` and `GET /students/:id/photo` (latest `photo`, `404` if none) —
**streamed by the API** (R43) after capability and scope; key asserted to start with
`${schoolId}/` (else `500`, logged). Headers: stored `Content-Type`, `Content-Length`,
`Content-Disposition: attachment; filename="<type>-<id>.<ext>"`, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox`. No presigned URL, ever. Access logged (id only), not
audited (no GET writes).

**Sweep (daily job):** deletes object then row for `consumed_at IS NULL AND expires_at < now()`
only, every school including suspended and terminated (R41, R90).

### 6.3 `POST /admissions`

**Header `Idempotency-Key`**: required, `^[A-Za-z0-9_-]{16,64}$`, generated once when the wizard
opens; missing or malformed → `422`, `details.fields[0].path = 'Idempotency-Key'`.

| Field | Rules |
|---|---|
| `student.fullName`, `.gender`, `.dateOfBirth`, `.bForm?`, `.notes?` | as §3.5 |
| `student.admittedOn` | optional date, ≤ today, default today; the enrolment's `started_on` |
| `guardians` | array 1–4; each exactly one of `guardianId` / `newGuardian` (`slice-5.md` §3.4 create fields), plus `relationship`, `isPrimaryContact`, `isFeePayer`, `canLogin` |
| `enrolment` | `{ classId, sectionId, rollNo?: 1–9999 }` |
| `documents` | optional array 0–10 of `{ stagedUploadId, type }` |
| `acknowledgedDuplicateStudentIds` | optional array ≤ 20 ids; **excluded from the request hash** |

Shape refusals (`422`): not exactly one `isPrimaryContact`; no `isFeePayer`; a repeated
`guardianId`, CNIC or `stagedUploadId`; unknown ids (`REFERENCE_NOT_FOUND` on the path); staged
upload unusable (R91); `photo` not an image.

Order:
1. Guard (`student.create`) — before any key lookup (R85). Then the identity-probe budget (§3.4):
   an admission spends one per identity number it carries — the student's `bForm` and each
   `guardians[].newGuardian.cnic` — and never less than one (amended 2026-10-03, Phase 1 security
   review F3: the budget is per number, not per request). Then, when any guardian is a `newGuardian` or has `canLogin: true`,
   the caller must also hold `guardian.manage` (as `POST /guardians` and the link routes require)
   → `403 PERMISSION_DENIED`; linking an existing guardian without a login needs `student.create`
   only.
2. Validation (`422`, nothing stored, R87).
3. `requestHash = HMAC-SHA256(IDENTITY_HASH_KEY, 'admissions|' + canonical JSON)` of the
   normalised body without `acknowledgedDuplicateStudentIds`. No digits are stored (R82).
4. Read `idempotency_keys` by `(school, user, endpoint 'admissions', key)`: same hash → **replay**;
   different hash → `409 IDEMPOTENCY_KEY_REUSED` (R83). A key is per user: another user's equal key
   is independent (R84).
5. `@Transactional()`: **first statement** inserts the key row (`response_status 201`,
   `subject_type 'student'`, `subject_id` set before commit). Then the references, in this order:
   guardians (`guardianId` unknown → `422 REFERENCE_NOT_FOUND`; merged → `409 GUARDIAN_MERGED`;
   locked in id order), staged uploads (`422`), then the target section, class and year, locked
   in that order (as §5; an unknown `classId` → `422 REFERENCE_NOT_FOUND` on
   `enrolment.classId`). Guardians are locked before the section: no other path locks a section,
   class or year and then a guardian, so the order cannot deadlock. Then:
   - **Duplicate check:** existing students with the same normalised name (case-insensitive),
     same `date_of_birth`, and a live link to the submitted primary guardian (only when it is a
     `guardianId`). Matches not in `acknowledgedDuplicateStudentIds` → `409
     ADMISSION_POSSIBLE_DUPLICATE` `details: { matches: [{ studentId, admissionNo, fullName,
     dateOfBirth, status, className | null }] }` — rolled back, key and number not consumed (R87,
     R88). The client resubmits with the **same key** and the ids.
   - Refusals: B-Form taken → `409 STUDENT_BFORM_EXISTS` `{ studentId, readmissible }`; new
     guardian CNIC taken → `409 GUARDIAN_CNIC_EXISTS` `{ guardianId }`; `guardianId` merged → `409
     GUARDIAN_MERGED` `{ mergedIntoId }`; primary without phone → `409
     PRIMARY_CONTACT_NEEDS_PHONE`; class/section/year as §5; `ROLL_NO_TAKEN`.
   - Admission number `UPDATE school_counters … RETURNING` (R34); student `active`; new guardians;
     links; enrolment; documents consumed; status row (`from null`); audit; key `subject_id`.
6. Key-insert conflict (R89), caught **outside** the transaction, fresh read: same hash → replay;
   else `409 IDEMPOTENCY_KEY_REUSED`. A B-Form, guardian CNIC or roll-number unique violation
   (a concurrent write after the in-transaction check) is likewise re-read outside the
   transaction and answered as the in-transaction refusal, with its details
   (`STUDENT_BFORM_EXISTS { studentId, readmissible }`, `GUARDIAN_CNIC_EXISTS { guardianId }`,
   `ROLL_NO_TAKEN { enrolmentId }`). Readmission does the same for `ROLL_NO_TAKEN`.

**201** `AdmissionResultDto { student: StudentDetailDto, enrolment: EnrolmentDto, guardianLinks:
GuardianLinkDto[], documents: StudentDocumentDto[], loginOffers: { student: boolean, guardians: [{
guardianId, fullName, available: boolean }] } }`. **Replay** re-reads the student and returns the
stored status with `Idempotency-Replayed: true`. A warning is never a 2xx. An expired session is
`401` before step 1 (R97).

---

## 7. Error codes (new)

| Code | Status | Where |
|---|---|---|
| `STUDENT_BFORM_EXISTS` | 409 | patch, admission — `details.studentId` |
| `STUDENT_BFORM_LOCKED` | 409 | patch of `bForm` once a login exists |
| `STUDENT_NOT_ACTIVE` | 409 | student issue-login |
| `STUDENT_LOGIN_DISABLED` | 409 | student issue-login with the school setting off |
| `IDEMPOTENCY_KEY_REUSED` | 409 | admission (R83) |
| `ADMISSION_POSSIBLE_DUPLICATE` | 409 | admission — `details.matches` |
| `GUARDIAN_LINK_EXISTS` | 409 | link create |
| `GUARDIAN_LINK_ENDED` | 409 | link patch |
| `PRIMARY_CONTACT_REQUIRED` | 409 | link patch, end, readmit (R28) |
| `PRIMARY_CONTACT_NEEDS_PHONE` | 409 | link create/patch, admission (R30) |
| `FEE_PAYER_REQUIRED` | 409 | link patch, end, readmit (R29) |
| `ENROLMENT_NOT_ACTIVE` | 409 | enrolment actions |
| `ROLL_NO_TAKEN` | 409 | roll number, admission, readmit (R37) |
| `CLASS_IN_OTHER_YEAR` | 409 | change-class (R38) |

Reused: `USERNAME_IN_USE` (slice 4), `ILLEGAL_STATUS_TRANSITION`, `IDENTITY_NUMBER_MISSING`,
`LOGIN_ALREADY_EXISTS`, `GUARDIAN_*`, `SECTION_ARCHIVED`, `CLASS_ARCHIVED`,
`ACADEMIC_YEAR_CLOSED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `SERVICE_UNAVAILABLE`.

## 8. Audit actions

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `student.admitted` | student | — | `{ enrolmentId, classId, sectionId, newGuardianIds, linkedGuardianIds, documentCount, acknowledgedDuplicateStudentIds }` — the three id lists are **comma-joined strings** (`''` when empty), because audit metadata holds scalars, not arrays |
| `guardian.created` | guardian | — | as slice 5 (one per new guardian) |
| `student.readmitted` | student | required | `{ enrolmentId, classId, sectionId, fromStatus }` |
| `student.updated` | student | — | `{ changes }`; `bForm` as `{ changed: true }` |
| `student.status_changed` | student | required | `{ from, to, effectiveOn, enrolmentClosed }` |
| `guardian_link.created` / `.updated` / `.ended` | student_guardian | end: required | `{ studentId, guardianId }`; `{ changes }`; `{}` |
| `enrolment.roll_no_set` / `.section_changed` / `.class_changed` | enrolment | as given | `{ from, to }`; `{ fromSectionId, toSectionId }`; `{ newEnrolmentId, toClassId }` |
| `document.added` | student_document | — | `{ studentId, type, mime, sizeBytes }` |
| `user.login_issued` | user | as given, else `'Login issued from the student record'` (or `'Login issued at admission'` from the wizard) (R57) | `{ capacity: 'student', linkedExistingUser: false }` |

---

## 9. Seams this slice fills

- **R44:** `assertNoActiveEnrolments(schoolId, yearId)` inside year close; the `it.todo` becomes a test.
- Class archive → `CLASS_HAS_ACTIVE_ENROLMENTS`; `assertSectionUnused` adds active enrolments →
  `SECTION_IN_USE`; `CLASS_YEAR_IMMUTABLE` adds any enrolment.
- Guardian issue-login: no live link with `can_login` → `409 GUARDIAN_NO_LOGIN_LINK`; an existing
  user with `student_id` set → `409 USERNAME_IN_USE`.
- Guardian `PATCH` clearing `phone` while primary on a live link → `409
  GUARDIAN_IS_PRIMARY_CONTACT` (R30).
- `GET /guardians/:id/students` fills `GuardianStudentDto` (unscoped: `guardian.manage` is
  school-wide); guardian lookup fills `students`.
- `users.student_id` + `CHECK (num_nonnulls(...) >= 1)`; `UserDto.studentId`; `GET /users?kind=student`.
- Student capacity = `users.student_id` set, `student_login_enabled`, **and student `active`**.

---

## 10. Web screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| Students list | `GET /students?status=active` | Filters year, class, section, status, login; 13-digit search opens "Find by B-Form"; teachers see their sections only, read-only |
| Student detail | `GET /students/:id`, `/guardian-links`, `/enrolments`, `/status-changes`, `/documents`, `/photo` | Tabs: details (edit, status), guardians (add/edit/end), enrolment history (roll no, change section/class), documents (upload, download), status history; controls by `/me` capabilities |
| Admission wizard 1 — student | `POST /students/lookup`, then form | Hit `readmissible` → "Readmit" (goes to readmit); hit active/suspended → stop with a link |
| 2 — guardians (cannot be skipped) | `POST /guardians/lookup` (CNIC, then phone) | Hits as "Ahmed Khan — father of Ali, Class 5 — link?"; all phone hits shown; merged resolves to survivor; keeps `guardianId`, never digits; new guardian form otherwise; one primary with a phone, one fee payer |
| 3 — class and section | `GET /classes`, `/classes/:id/sections` | Years not closed |
| 4 — documents (optional) | `POST /uploads` | Per file; staged ids kept in memory |
| 5 — review and submit | `POST /admissions` | Key generated at step 1, in memory only (no `localStorage`); `ADMISSION_POSSIBLE_DUPLICATE` lists matches with "These are different children" → resubmit with ids; `401` → re-login in place, same key; then issue-login offers |
| Readmit | `POST /students/:id/readmit` | Class, section, date, reason |
| Issue student login | `POST /students/:id/issue-login` | Shown when the setting is on and the student has a B-Form |

---

## Decisions made here

1. Scope = an active enrolment in a scoped section; every student-linked repository takes it, even
   for school-wide routes.
2. `bFormMasked`, `notes`, guardian CNIC/address/contact capability/login are nulled for callers
   without `student.update` / `guardian.manage` / `document.view` (`photoDocumentId`).
3. §5 slice 6's "different user → `IDEMPOTENCY_KEY_REUSED`" is unreachable under the per-user
   unique key; R84 governs. The request hash is an HMAC under `IDENTITY_HASH_KEY` with an
   `admissions|` prefix.
4. Admission creates new guardians inline; duplicate check matches only an existing primary
   guardian.
5. Exits and class moves set the old enrolment `left`; `completed` is reserved for year end.
   Class move uses one date for both `ended_on` and `started_on`; section change is in place.
6. `suspended → withdrawn` is refused (R36 literal): reactivate first. Same status is `409`.
7. Student capacity requires `status = active`; leaving `active` revokes the student's sessions.
8. `rollNo` is an integer; `gender` is `male | female` (for `data-architect`).
9. Document re-post of the same staged id is a `200` replay; downloads are logged, not audited.
10. Upload concurrency: 4 per process, `503` after 10 s.
