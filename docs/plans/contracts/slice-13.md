# Slice 13 contracts — diary entries, remarks, parent and student reads

**Author:** api-designer, 2026-10-04. **Binds:** `apps/api/src/modules/diary/**` (new: diary
entries, remarks, the `/me/children/*` and `/me/student/*` diary and remark routes),
`repositories/{diary-entry,remark}.repository.ts` (new), `modules/documents/documents.controller.ts`
(`POST /uploads` widening, R171), `modules/access/permissions.service.ts`,
`common/auth/route-access.ts`, `common/auth/school-session.ts`, `tenancy/scope.ts`,
`tenancy/scope.mint.ts`, `repositories/student.repository.ts` (capacity scope, §1.2 — shared
wave-E groundwork), `modules/auth/dto.ts` (`MeDto.staffId`, `MeDto.children`),
`messaging/templates.ts`, `messaging/types.ts` (the two templates), `packages/shared/src/diary.ts`,
`apps/web/app/(school)/sections/**` (section diary), the student remarks tab. **Sources:**
`CLAUDE.md` (rules 2, 4, 13, 16, 17; conventions), `phase-2-daily-operations.md` §0.17, §1.1 item
26, §4.2, §4.3, §4.4, §4.6, §4.7, §5 "Diary and remarks", §6.1, slice 13, R137–R143, R163–R166,
R171, R175; `slice-6.md` §6 (uploads, documents, the `Idempotency-Key` mechanism); `slice-9.md`
§4 (settings), §7 (`NotificationService`, routing, templates); `slice-10.md` §7 (dated scope).
Everything not restated follows Phase 1 §3.9, `slice-1.md` (envelope, `422 VALIDATION_FAILED`
with `details.fields`, string ids, camelCase, `NoQueryDto`, `@ApiErrors()`, `@IdParam()`) and
`slice-2.md` §1 (access decorators). Paths are under `/api/v1`. Dates are `YYYY-MM-DD` calendar
dates in the school's timezone (R53); "today" is `SchoolClock.today`.

The owner's settled default (item 26): `remarkDefaultVisibility = guardian`,
`remarkNotifyGuardians = false`. Both are `school_settings` fields of `slice-9.md` §4; this slice
reads them and changes neither.

---

## 1. Access

### 1.1 Routes

| Route | Decorator | Row rule |
|---|---|---|
| `GET /sections/:id/diary-entries`, `GET /diary-entries/:id`, `GET /diary-entries/:id/attachment`, `GET /diary-entries/:id/thumbnail` | `@RequireCapability(DIARY_WRITE)` | the section is in **today's** scope (`scopeOf(session)`), else `404` |
| `POST /sections/:id/diary-entries` | `@RequireCapability(DIARY_WRITE)` | dated, role-aware scope **on `date`** (§1.3) |
| `PATCH /diary-entries/:id` | `@RequireCapability(DIARY_WRITE)` | section in today's scope (`404`), then author or all-scope (§4.4) |
| `GET /students/:id/remarks` | `@RequireCapability(STUDENT_VIEW)` | the student is in today's scope, else `404`; every visibility |
| `POST /students/:id/remarks` | `@RequireCapability(REMARK_WRITE)` | student in today's scope (`404`); the enrolment on `date` in dated scope (§1.3) |
| `POST /remarks/:id/correct` | `@RequireCapability(REMARK_WRITE)` | the remark's student in today's scope (`404`), then author or all-scope (§5.3) |
| `GET /me/children/:id/diary-entries`, `/me/children/:id/diary-entries/:entryId/attachment`, `…/thumbnail`, `GET /me/children/:id/remarks` | `@RequireCapacity('guardian')`, `MeReadsThrottleGuard` | `:id` in the guardian's scope (§1.2), else `404` |
| `GET /me/student/diary-entries`, `/me/student/diary-entries/:entryId/attachment`, `…/thumbnail`, `GET /me/student/remarks` | `@RequireCapacity('student')`, `MeReadsThrottleGuard` | the caller's own student id (§1.2) |
| `POST /uploads` | `@RequireCapability(DOCUMENT_UPLOAD, DIARY_WRITE, ANNOUNCEMENT_SEND_SCOPE, ANNOUNCEMENT_SEND_SCHOOL)` (any of, R171) | unchanged otherwise (§7) |

**One-sentence rules.** A section's diary is read and written by the staff assigned to that
section and by anyone holding `diary.write` school-wide; a diary entry is edited by its author
inside the amendment window or by a school-wide `diary.write` holder; a student's remarks are read
by anyone who may view the student and written by a `remark.write` holder whose scope covered the
student on the remark's date; a guardian reads the diary and the guardian-visible remarks of a
child linked to them with a login flag; a student reads their own diary and the student-visible
remarks; anyone who may upload a document, write a diary or send an announcement may stage an
upload, which only they can consume.

**Office staff do not read the diary by default** (plan slice 13, R142). `diary.write` is a
teacher default (section scope) and a principal default (all scope); the office default lacks it,
and there is no read-only diary key in the fixed capability list. A principal who wants a clerk to
see the diary grants `diary.write`, which also lets the clerk write it (school-wide, as every grant
is). That consequence is accepted for Phase 2 and stated on the grant screen's hint for this key.
Remarks are different: `GET /students/:id/remarks` needs `student.view`, which the office holds,
so the office reads remarks (plan: "all visibilities for staff").

Common errors on every route: `401 AUTH_REQUIRED` · `403 PERMISSION_DENIED` · `403
ORIGIN_REJECTED` (cookie non-GET) · `426 UPGRADE_REQUIRED` (bearer, R161) · `429 RATE_LIMITED`.
Every `:id` resolves in the session's school only; absent, malformed, another school's or outside
the caller's scope → `404 NOT_FOUND`, the same body as absent.

### 1.2 Guardian and student scope — shared wave-E groundwork (plan §4.3, R163, R164)

Slices 11 and 13 both ship `/me/children/:id/*` and `/me/student/*` routes and run in parallel.
**Whichever lands first builds this section; the other uses it.** It is specified once, here.

- `Scope` (`tenancy/scope.ts`) gains a third kind: `{ kind: 'students'; ids: readonly bigint[] }`,
  minted only by `scopeStudents(ids)` in `tenancy/scope.mint.ts` (access module only). An empty
  list means no rows, never no filter (control 7). `studentInScope()` in `student.repository.ts`
  maps it to `{ id: { in: ids } }` — **no enrolment condition**: a guardian keeps a child whose
  status is no longer `active` while the link is live (R164), history included.
- `UserAccess` gains `studentId: bigint | null` (`findAccess` already reads it).
- `RouteAccessGuard`, on a `@RequireCapacity` route, computes the capacity scope and binds it with
  `bindRequestScope`, exactly as it binds a capability scope, so every service reads
  `scopeOf(session)` the same way on every route:
  - `guardian`: `PermissionsService.guardianScope(schoolId, access)` → `scopeStudents(ids)` where
    `ids` = the `student_id`s of `student_guardians` rows with `guardian_id = access.guardianId`,
    `ended_at IS NULL` **and `can_login = true`**, the guardian row not merged (R163). One
    query per request (R69); no caching. A guardian with no such link gets `scopeStudents([])`:
    the route is permitted and returns nothing.
  - `student`: `scopeStudents([access.studentId])`. Student capacity already requires the
    student `active` and `student_login_enabled` (slice 6 §9), so no further check.
- A `/me/children/:id/*` path whose `:id` is not in `scope.ids` → `404 NOT_FOUND`. Ending a link
  removes the child on the next request (R164).
- `MeDto` gains, additively: `staffId` (string | null — the caller's staff id, so a client can tell
  its own authorship) and `children` (`MyChildDto[]`, §2.2 — the guardian scope's students with
  their current enrolment; `[]` without guardian capacity). The app composes the guardian tab from
  `children` (R156); there is no `GET /me/children` list route (decision 2).
- R165 holds on every `/me/*` response of this slice: no other student, no other guardian's
  name, phone, relationship or flags, no staff phone number, no identity number; teachers appear
  by name only (`authorName`, never `authorStaffId`).

### 1.3 Dated, role-aware scope for writes (plan §4.4, `slice-10.md` §7, R175)

Diary and remark writes call `PermissionsService.scopeOf(session, { capability, on: date })`:

- `null` is unreachable here (the route decorator already required the capability).
- `kind: 'all'` → any section, any subject.
- `kind: 'sections'`: the section must be a key of `sections`, else **`403 PERMISSION_DENIED`,
  `details.reason = 'not_assigned_on_date'`** — the section exists and is visible to staff, so
  `404` would hide nothing and would tell a cover teacher outside their dates "not found" instead
  of why. (Slice 11 should answer R175's "a register dated before the assignment began" and "a
  cover outside its dates" with the same code and reason.) Then, for the diary, the role decides
  the subject: `classTeacher || cover` → any subject (R137, R132: cover is full class-teacher
  scope); otherwise `subjectIds` must contain `subjectId` → else `409 SUBJECT_NOT_ASSIGNED`. For a
  remark any role suffices (decision 9).

Reads use today's scope (`scopeOf(session)`), as every list does (plan §4.4).

### 1.4 Throttles

`/me/*` routes: `MeReadsThrottleGuard` (`me-reads`, 120/min, 2,000/hour per user, R166). No new
bucket for staff writes: creates are idempotent and the per-IP throttles bound a browser or a
phone. Thumbnails share the uploads `ConcurrencyLimit` (4 re-encodes per process, `503
SERVICE_UNAVAILABLE` after a 10 s wait, `slice-6.md` §6.1); that limit, not a throttle, is the
backstop for a client that fetches thumbnails in a loop.

### 1.5 Lock order

Whole system after slice 13: `slice-9.md` §1.7's order, then **`diary_entries` row → `remarks`
row → `staged_uploads` row** (the conditional consume). Creates take no section, class, year or
subject lock: references are read, the natural unique index settles a race, and the loser is
re-read outside the transaction (§4.3 step 8). `idempotency_keys` is inserted as the first
statement of the transaction (as admissions) and locks nothing else. No path in this slice locks
a `users`, `staff`, `sessions` or `school_settings` row.

### 1.6 Text normalisation (R139, R111)

| Field | Rule |
|---|---|
| `topic` | `NoticeTextField(1, 500)`: trimmed, whitespace runs collapsed, no control characters, **no identity number, no phone number** — it is rendered into the `diary_posted` body, which the R111 scanner covers |
| `assignment`, `learningOutcome` | `TextField(0, 1000)` / `TextField(0, 500)`: trimmed, no identity number; line breaks allowed (homework is multi-line); `''` and `null` both store `null` |
| remark `text` | `TextField(1, 1000)`: no identity number; line breaks allowed; never rendered into a message (§5.4) |
| `reason` (diary edit, remark correction) | `TextField(3, 500)` |

Every text column has the `_no_id_check` CHECK as well (plan §5), so a refused value is a `422`
before it can be a `500`.

---

## 2. Shapes

### 2.1 Enums (`packages/shared/src/diary.ts`, groundwork; `enum` + `enumName` on every DTO use)

`RemarkCategory` `academic | behaviour | homework | attendance | participation | general` ·
`RemarkVisibility` `internal | guardian | student`. New helper, one definition for API, web and
app:

```ts
export const REMARK_VISIBILITY_LEVEL = { internal: 0, guardian: 1, student: 2 } as const;
/** The lowest visibility a capacity may read: guardians read guardian-or-above, students student. */
export const MIN_REMARK_VISIBILITY = { guardian: 'guardian', student: 'student' } as const;
export const remarkVisibleTo = (v: RemarkVisibility, c: 'guardian' | 'student'): boolean =>
  REMARK_VISIBILITY_LEVEL[v] >= REMARK_VISIBILITY_LEVEL[MIN_REMARK_VISIBILITY[c]];
```

Visibility is a level (R140): `student` implies `guardian`; `internal` is staff only.

### 2.2 DTOs

`DiaryEntryDto` (staff routes):

| Field | Type |
|---|---|
| `id` | string |
| `sectionId`, `classId`, `academicYearId` | string |
| `date` | date |
| `subjectId`, `subjectName` | string |
| `authorStaffId`, `authorName` | string — the staff row and its `full_name` |
| `topic` | string, 1–500 |
| `assignment` | string \| null |
| `learningOutcome` | string \| null |
| `dueOn` | date \| null |
| `hasAttachment` | boolean |
| `attachmentMime` | `image/jpeg \| image/png \| application/pdf` \| null |
| `attachmentSizeBytes` | integer \| null |
| `editWindowEndsOn` | date — the last day the author may edit without a reason (§4.4) |
| `createdAt`, `updatedAt` | datetime — `updatedAt > createdAt` means "edited" |

`MyDiaryEntryDto` (`/me/*` routes, R165): `DiaryEntryDto` minus `authorStaffId`, `academicYearId`
and `editWindowEndsOn`, plus `className` and `sectionName` (the child may have moved sections;
the label comes with the row).

`RemarkDto` (staff routes):

| Field | Type |
|---|---|
| `id` | string |
| `studentId`, `enrolmentId` | string |
| `date` | date |
| `category` | `RemarkCategory` |
| `text` | string, 1–1000 |
| `visibility` | `RemarkVisibility` |
| `subjectId`, `subjectName` | string \| null |
| `authorStaffId`, `authorName` | string |
| `supersedesId` | string \| null — the row this one corrects |
| `supersededAt`, `supersededById` | datetime \| null, string \| null — set once a correction exists |
| `correctionReason` | string \| null — non-null exactly when `supersedesId` is |
| `createdAt` | datetime |

`MyRemarkDto` (`/me/*` routes): `RemarkDto` minus `authorStaffId`, `enrolmentId`, `visibility`
and `correctionReason`.

`MyChildDto` (`MeDto.children`): `studentId`, `fullName`, `status` (`StudentStatus`),
`relationship` (`Relationship` — this guardian's own link), `current` (`StudentDto.current`'s
shape — `{ enrolmentId, academicYearId, academicYearName, classId, className, sectionId,
sectionName, rollNo }` \| null). Nothing else: no admission number, no identity number, no photo
in this slice.

`StagedUploadDto`, `UploadFileDto`: unchanged (`slice-6.md` §6.1).

---

## 3. The `Idempotency-Key` mechanism as applied here (plan §4.7, R143; `slice-6.md` §6.3)

`POST /sections/:id/diary-entries` and `POST /students/:id/remarks` are the two offline writes of
this slice (the mobile outbox, plan §4.7). Both take the slice-6 header and store the key in
`idempotency_keys` with `endpoint = 'diary_entries'` / `'remarks'` (`IDEMPOTENT_ENDPOINTS`,
groundwork). The mechanism is slice 6's with three statements made explicit:

1. **Header.** Required, `^[A-Za-z0-9_-]{16,64}$`, no run of 13 digits; missing or malformed →
   `422`, `details.fields[0].path = 'Idempotency-Key'`. Clients use `newIdempotencyKey()`
   (`packages/shared`, a dashed UUID) generated when the form opens, kept in memory (web) or in
   the outbox row (app), never in `localStorage`.
2. **Request hash.** `HMAC-SHA256(IDENTITY_HASH_KEY, '<endpoint>|<pathId>|' + canonicalJson(body))`
   — the path id is part of the hash, so one key sent to two sections (or two students) is a
   **reuse**, not a replay. Nothing of the body is stored.
3. **Replay.** Same user, same endpoint, same key, same hash → the subject is **re-read under the
   caller's current scope** and returned with **`200`** and `Idempotency-Replayed: true` (R143;
   admissions returns its stored `201` and is unchanged — decision 4). A subject no longer in the
   caller's scope → `404`. A different hash, or a key whose subject was never set (a crashed
   transaction) → `409 IDEMPOTENCY_KEY_REUSED`. Another user's equal key is a different row (R84).
4. **Order inside the request.** Guard → header → `ValidationPipe` (`422`, nothing stored, R87) →
   hash → key lookup (replay or reuse) → `@Transactional()` whose **first statement inserts the
   key row** (`response_status 201`, `subject_type 'diary_entry' | 'remark'`); every refusal below
   rolls the key back, so a corrected resubmit may use the same key; the subject id is set before
   commit. A key-insert conflict (a racing same-key submit) is caught **outside** the transaction
   and answered from a fresh read: same hash → replay, else `409 IDEMPOTENCY_KEY_REUSED`.

`POST /remarks/:id/correct` and `PATCH /diary-entries/:id` take no key: both are online-only
actions (R162) and are retry-safe by state (§4.4, §5.3).

---

## 4. Diary entries

A diary entry is unique per `(section, date, subject)` (R137,
`diary_entries_school_id_section_id_date_subject_id_key`). It is **edited in place** with a
`diary_entry_changes` row per edit written by the §4.6 trigger (plan §4.6) — not superseded, because
the natural key forbids a second row. Its identity columns (`section_id`, `class_id`,
`academic_year_id`, `date`, `subject_id`, `author_staff_id`, `created_at`) are frozen by trigger;
`topic`, `assignment`, `learning_outcome`, `due_on` and the attachment triple are the five
editable fields.

### 4.1 `GET /sections/:id/diary-entries` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `dateFrom`, `dateTo` | optional dates; `date` within the range; either alone is open-ended; both → at most 366 days inclusive; `dateTo < dateFrom` → `422` on `dateTo` |
| `subjectId` | optional id; unknown → empty page |
| `sort` | `-date` (default), `date`; `id` tiebreak |

Section not in today's scope, absent or archived-and-not-in-scope → `404`. An archived section
in scope still lists (history). **200** `{ data: DiaryEntryDto[], page, limit, total }`. A week
of one section fits one page at `limit=50` (≤ 8 subjects × 6 days).

### 4.2 `GET /diary-entries/:id` — `DiaryEntryDto`. Entry's section not in today's scope → `404`.

### 4.3 `POST /sections/:id/diary-entries` — `Idempotency-Key` required (§3)

| Field | Rules |
|---|---|
| `date` | required calendar date; **≤ today**; within the class's academic year (`startsOn ≤ date ≤ endsOn`) → else `422 INVALID_VALUE` on `date`. A future date is refused: tomorrow's homework is today's entry with a `dueOn` |
| `subjectId` | required id string; unknown → `422 REFERENCE_NOT_FOUND` |
| `topic` | required, §1.6 |
| `assignment`, `learningOutcome` | optional, §1.6 |
| `dueOn` | optional date; `≥ date`; `≤` the academic year's `endsOn` → else `422 INVALID_VALUE` on `dueOn` |
| `stagedUploadId` | optional id string; one attachment (image or PDF) |

Order, one `@Transactional()` after the §3 pre-steps:
1. Key row inserted (first statement).
2. Section read with its class and year; absent in the school → `404`. Section archived (`deleted_at`)
   → `409 SECTION_ARCHIVED`; class archived → `409 CLASS_ARCHIVED`; year closed → `409
   ACADEMIC_YEAR_CLOSED`. `date` checks above (`422`).
3. **Dated scope** (§1.3): `scopeOf(session, { capability: DIARY_WRITE, on: date })` → `403
   not_assigned_on_date` · `409 SUBJECT_NOT_ASSIGNED`.
4. Subject read: absent → `422 REFERENCE_NOT_FOUND` on `subjectId`; archived → `409
   SUBJECT_ARCHIVED`.
5. **Retry-safety:** an entry for `(section, date, subject)` exists → `409 DIARY_ENTRY_EXISTS`
   `details: { entryId }` (rolled back; key not consumed). The web treats it as "already written"
   and opens the entry; the app shows the server message and opens the entry.
6. Attachment: `stagedUploadId` consumed by the slice-6 conditional update (`uploaded_by = caller
   AND consumed_at IS NULL AND expires_at > now()`); no row → `422 REFERENCE_NOT_FOUND` on
   `stagedUploadId` (expired, consumed or another user's look identical, R91). The entry stores
   **the staged object's key**, nothing moved. Any stored type is accepted (image or PDF).
7. Insert (`author_staff_id = caller.staffId`, `created_at = updated_at = now`); key `subject_id`
   set.
8. **`diary_posted` (R138)** — only when `date = today` (decision 7): `NotificationService.send`
   with subject `{ type: 'diary_entry', id }`, recipients and vars per §4.6. A backdated entry
   writes no message.
9. Audit `diary_entry.created`.

A unique violation on the natural key after step 5 (a concurrent create) is re-read outside the
transaction and answered as step 5, with `entryId`. **201** `DiaryEntryDto`; replay **200** (§3).
Jobs are enqueued after commit (slice 9).

### 4.4 `PATCH /diary-entries/:id` — the edit window

Body: `topic?`, `assignment?`, `learningOutcome?`, `dueOn?`, `stagedUploadId?`, `reason?`
(`TextField(3, 500)`). Absent = unchanged. `topic: null` → `422`; `assignment`, `learningOutcome`,
`dueOn: null` clear; `stagedUploadId: null` removes the attachment, a value replaces it (consumed
as §4.3 step 6). `dueOn` is checked against the entry's `date` and year on the merged result.
`date`, `subjectId`, `sectionId` are not declared → `422 UNKNOWN_FIELD` (a wrong date or subject is
a new entry plus the old one left or corrected; the natural key is identity).

**The window.** The school's amendment window `attendanceAmendWindowDays` (W, `slice-9.md` §4,
default 3) governs registers **and** the diary (decision 5): an entry is *inside the window*
while `today ≤ createdDay + W`, where `createdDay` is `created_at` as a school-local date. The DTO's
`editWindowEndsOn = createdDay + W`. Measured from creation, not from `date`, so a backdated
entry written today is editable today.

Order: entry row locked (`readLocked`); absent or its section not in today's scope → `404`. Then:

| Caller | Inside the window | After the window |
|---|---|---|
| the author (`author_staff_id = caller.staffId`) | edits; `reason` optional | `409 DIARY_ENTRY_LOCKED` |
| all-scope `diary.write` (principal, custom role, grant), not the author | edits; `reason` optional | edits; **`reason` required** → else `409 AMENDMENT_REASON_REQUIRED` `details: { amendments: [<changed field names>] }` |
| another section-scoped teacher (class teacher over a subject teacher's entry, or the reverse) | `403 PERMISSION_DENIED`, `details.reason = 'not_author'` — the row is visible to them | the same |

Then year closed → `409 ACADEMIC_YEAR_CLOSED`; field refusals (`422`); **no change → `200`
unchanged, no history row, no audit** (a replay is free: the trigger writes no row for a no-op
update, plan §4.6). Otherwise one `UPDATE` under the transaction-local actor and reason
(`set_config(..., true)`, §4.6 of the plan); the trigger writes `diary_entry_changes` with the
old and new values of every changed field (`old_attachment_object_key` keeps a replaced object
referenced, so no object is ever deleted), `changed_by`, `changed_at`, `reason` (nullable here).
`updated_at = now`. **No message is sent on an edit** (decision 7). Audit `diary_entry.updated`.

**200** `DiaryEntryDto`. No optimistic retry and no `CONCURRENT_UPDATE`: the row is locked.

### 4.5 `GET /diary-entries/:id/attachment`, `GET /diary-entries/:id/thumbnail`

Entry's section in today's scope, else `404`; no attachment → `404`. **Streamed by the API**
exactly as `GET /documents/:id/content` (`slice-6.md` §6.2, R43): key asserted to start with
`${schoolId}/` (else `500`, logged); headers `Content-Type` (stored mime), `Content-Length`,
`Content-Disposition: attachment; filename="diary-<id>.<ext>"`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox`; `Cache-Control: no-store` as every response. Never a
presigned URL. Logged with the entry id only; not audited (no GET writes).

**Thumbnail** (decision 6): the stored attachment is an image → the bytes are read and resized
**on demand** with `sharp` (`resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement:
true })`, JPEG quality 70, `limitInputPixels` as uploads, first frame) under the uploads
`ConcurrencyLimit` (wait > 10 s → `503`), and streamed with `Content-Type: image/jpeg`,
`Content-Disposition: attachment; filename="diary-<id>-thumb.jpg"` and the same security headers.
The source is the stored object, which is already the re-encode pipeline's output (EXIF stripped,
pixel-bounded), so the thumbnail never derives from original bytes (R171). A PDF attachment → `404`
(the DTO's `attachmentMime` tells the client not to ask). Nothing is stored: a replaced attachment
needs no thumbnail housekeeping. If measurement at slice 17 shows the resize is a bottleneck, a
stored thumbnail column is the additive fix.

### 4.6 The `diary_posted` message (R138; `slice-9.md` §7)

| | |
|---|---|
| `type` | `diary_posted` (low: push · in-app; **never** WhatsApp, SMS or email — not SMS-eligible, so it can never appear in `smsAllowedTypes`) |
| `subject` | `{ type: 'diary_entry', id: entryId }` — R107 makes one row per person per entry |
| Recipients, resolved in the create transaction | **Guardians:** every guardian, not merged, with a live `student_guardians` row (`ended_at IS NULL`, `can_login` irrelevant — a guardian without a login gets a visible suppression, not silence) to a student who is `active` (R164: no new notices for a child who has left) and whose enrolment is **in force on the entry's `date`** in this section (`started_on ≤ date ≤ coalesce(ended_on, ∞)`). A guardian of two children in the section is one row. **Students:** the same enrolments' students, `active`, with a login and `student_login_enabled`. **Dedupe by user:** a staff member whose login carries a guardian in the set receives the guardian row only (slice 10 §4.7's rule) |
| Routing | `slice-9.md` §7.3's "low" column: `whatsapp` and `smartphone_data` guardians → `push` (if a live device), `in_app` (if a login); a **keypad** guardian → `suppressed: no_channel` (decision 8; the plan's slice-13 test text says `not_allowed`, which is the matrix's word for an SMS leg refused by the allow list, and no SMS leg exists here); students → push and in-app |
| `TemplateVarsMap.diary_posted` | `{ className, sectionName, subjectName, date: Date, topic: string, dueOn: Date \| null }` |
| Template | Title `Diary posted`. Body `{schoolName}: {className} {sectionName} {subjectName} diary for {Mon 6 Oct}: {topic}[. Due {Fri 10 Oct}]` — `topic` already refuses identity and phone patterns (§1.6); the body never names the author or a student |
| Push payload | `{ type, subjectType: 'diary_entry', subjectId, messageId }`, the title and the body — the app deep-links to the entry (slice 15) |
| Size | ≤ 60 students × their guardians ≈ 150 rows, set-based (`slice-10.md` §4.7's requirement on `send`) |

Only an entry dated **today** sends (decision 7). Edits send nothing. A suppression is visible to
the office through the delivery rows (slice 14's delivery view), so "the keypad parent never gets
the diary" is a fact on screen, not a mystery.

---

## 5. Remarks

A remark is **never edited** (R141). A correction is a new row with `supersedes_id` pointing at the
row it replaces; `UNIQUE (school_id, supersedes_id) WHERE supersedes_id IS NOT NULL` makes the
history a chain, never a tree; an `AFTER INSERT` trigger sets the original's `superseded_at`, the
only column of a remark that ever changes. A remark hangs off the **enrolment in force on its
`date`** (composite FK to `enrolments (school_id, id, student_id)`, so the row can never name a
different child than its enrolment).

### 5.1 `GET /students/:id/remarks` — paginated, `student.view` scoped

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `category` | optional `RemarkCategory` |
| `visibility` | optional `RemarkVisibility` |
| `dateFrom`, `dateTo` | optional dates on `date`; either alone open-ended; both ≤ 366 days; `dateTo < dateFrom` → `422` |
| `includeSuperseded` | `QueryBoolean`, default `false`: hide rows with `superseded_at` set |
| `sort` | `-date` (default), `date`; `id` tiebreak |

Student not in today's scope → `404`. Staff see **every visibility** (R140), `internal` included,
across every enrolment of the student. **200** `{ data: RemarkDto[], page, limit, total }`.

### 5.2 `POST /students/:id/remarks` — `Idempotency-Key` required (§3)

| Field | Rules |
|---|---|
| `date` | required calendar date, **≤ today**; the student must have an enrolment in force on it (below) |
| `category` | required `RemarkCategory` |
| `text` | required, §1.6 |
| `visibility` | optional `RemarkVisibility`; **default = `school_settings.remark_default_visibility`** (owner's default `guardian`) |
| `subjectId` | optional id string; `null` and absent are the same |

Order, one `@Transactional()` after the §3 pre-steps:
1. Key row inserted.
2. Student read in today's scope → `404`. Status `withdrawn | transferred | alumni` → `409
   STUDENT_NOT_ACTIVE` ("the student has left"; a `suspended` student may receive a remark —
   behaviour remarks are the point).
3. `date > today` → `422 INVALID_VALUE` on `date`. The enrolment in force on `date` (`started_on
   ≤ date ≤ coalesce(ended_on, ∞)`, exact after R174) is read; none → `422 INVALID_VALUE` on
   `date` ("the student had no enrolment on this date"); its academic year closed → `409
   ACADEMIC_YEAR_CLOSED`.
4. **Dated scope** (§1.3): `scopeOf(session, { capability: REMARK_WRITE, on: date })`; the
   enrolment's `section_id` must be in it, **any role** (class teacher, cover or subject teacher
   of any subject, decision 9) → else `403 not_assigned_on_date`.
5. `subjectId` given: absent → `422 REFERENCE_NOT_FOUND`; archived → `409 SUBJECT_ARCHIVED`. No
   assignment check: the subject is a tag on an observation, not a right (decision 9).
6. Insert (`enrolment_id`, `student_id`, `author_staff_id = caller.staffId`, `supersedes_id =
   null`, `correction_reason = null`); key `subject_id` set.
7. **`remark_posted` (R140)** — only when `school_settings.remark_notify_guardians` is true **and**
   `visibility ≠ internal`: §5.4. Otherwise nothing: a guardian-visible remark simply appears in the
   app ("on enquiry", item 26).
8. Audit `remark.created`.

**201** `RemarkDto`; replay **200** (§3). There is no natural-key conflict: two remarks on one child
on one day are two remarks.

### 5.3 `POST /remarks/:id/correct` — the supersede chain (R141)

| Field | Rules |
|---|---|
| `text` | required, §1.6 — the corrected text |
| `reason` | required `TextField(3, 500)` — stored on the new row as `correction_reason` and carried by the audit row |
| `visibility` | optional `RemarkVisibility`; absent = the original's (decision 10: a wrong visibility is also a correction) |

`category`, `date`, `subjectId`, `enrolmentId`, `studentId` are copied from the original and
cannot be changed by a correction (a wrong child or date is a new remark; the old one is
corrected to say so). The body does not accept them → `422 UNKNOWN_FIELD`.

Order, one `@Transactional()`:
1. Original row locked (`readLocked`); absent, or its student not in today's scope → `404`.
2. **Permission:** caller is the author (`author_staff_id = caller.staffId`) or holds `remark.write`
   school-wide (`scopeOf(session).kind === 'all'`) → else `403 PERMISSION_DENIED`,
   `details.reason = 'not_author'`.
3. **Already superseded** (`superseded_at IS NOT NULL`) → `409 REMARK_SUPERSEDED` `details: {
   supersededById }`. This is the retry-safety: a resubmit after success lands here and the web
   treats it as done; a genuine second correction targets the latest row (`supersededById`).
4. The original's academic year closed → `409 ACADEMIC_YEAR_CLOSED`. Student status
   `withdrawn | transferred | alumni` → `409 STUDENT_NOT_ACTIVE` (a closed record is not corrected
   in Phase 2; decision 11).
5. Insert the new row: the copied identity, `text`, `visibility` (given or copied),
   `author_staff_id = caller.staffId` (**the corrector is the author of the correction**),
   `supersedes_id = :id`, `correction_reason = reason`. The trigger sets the original's
   `superseded_at = now`.
6. **`remark_posted`** for the new row only if `remark_notify_guardians` is on, the new row is
   guardian-visible **and the original was not** (`internal → guardian | student`): the correction
   is then the first time guardians can see it. A text-only correction sends nothing (the app
   shows the current text; decision 10).
7. Audit `remark.corrected`.

A violation of the partial unique on `supersedes_id` (a concurrent correction that committed
between the read and the insert — impossible under the row lock, kept as the backstop) is re-read
outside the transaction and answered as step 3. **201** `RemarkDto` (the new row).

**Reading a chain.** Every list returns rows by their own visibility; `supersededAt` and
`supersededById` mark the old one. The original shows as superseded to **every reader who could
see it** (R141) — including a guardian when the correction lowered visibility to `internal`: the
guardian then sees the old row marked superseded and cannot fetch the successor. That is the
honest outcome of rule 4 and is accepted (decision 10).

### 5.4 The `remark_posted` message (R140)

| | |
|---|---|
| `type` | `remark_posted` (low: push · in-app; never WhatsApp, SMS or email) |
| `subject` | `{ type: 'remark', id: remarkId }` |
| Recipients | every guardian of the student with a live link, not merged, `can_login` irrelevant (a suppression row is the visible outcome, as §4.6); one row per guardian; deduped by user with the staff set (no staff recipients here, so only the staff-who-is-also-guardian case applies) |
| Gate | `remark_notify_guardians = true` **and** `visibility ∈ { guardian, student }` (§5.2 step 7, §5.3 step 6). Students never receive `remark_posted`: a `student`-visible remark reaches them in the app without a push (the message type's audience is guardians, `MESSAGE_TYPE_TABLE`) |
| `TemplateVarsMap.remark_posted` | `{ studentName: string, category: RemarkCategory, date: Date }` |
| Template | Title `New remark`. Body `{schoolName}: A new {category} remark for {studentName} dated {Mon 6 Oct}. Open the app to read it.` — **the remark text never enters a message** (a behaviour remark on a lock screen is not the school's call to make; it is read inside the app) |
| Push payload | `{ type, subjectType: 'remark', subjectId, messageId }`, title, body |

---

## 6. Guardian and student reads (`/me/*`)

All under `MeReadsThrottleGuard`; scope per §1.2; R165 on every response.

### 6.1 Which diary entries a child sees

An entry is visible for student `S` iff `S` had an enrolment **in force on the entry's `date`** in
the entry's section (`e.student_id = S AND e.section_id = d.section_id AND e.started_on ≤ d.date
AND (e.ended_on IS NULL OR e.ended_on ≥ d.date)`). A child who moved sections sees the old
section's entries up to the move and the new section's from it; a child who joined mid-year never
sees entries from before they joined; a child who left keeps their history (R164). The current
section's roster is never the predicate. One query, driven by `enrolments (school_id, student_id)`
and `diary_entries (school_id, section_id, date)`, both indexed.

### 6.2 `GET /me/children/:id/diary-entries`, `GET /me/student/diary-entries` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `dateFrom`, `dateTo` | optional; both ≤ 366 days; `dateTo < dateFrom` → `422` |
| `sort` | `-date` (default), `date`; `id` tiebreak |

`:id` outside the guardian scope → `404`. **200** `{ data: MyDiaryEntryDto[], page, limit, total }`.

### 6.3 `GET /me/children/:id/diary-entries/:entryId/attachment`, `…/thumbnail`; `GET /me/student/diary-entries/:entryId/attachment`, `…/thumbnail`

The entry must satisfy §6.1 for that child (or the caller's own student id) → else `404`; no
attachment, or a PDF for `thumbnail` → `404`. Streamed exactly as §4.5 (same headers, same
on-demand thumbnail, same concurrency limit). A non-recipient — another guardian, a guardian whose
link ended, a student of another section — gets `404` from the predicate, never the bytes (the
plan's named test).

### 6.4 `GET /me/children/:id/remarks`, `GET /me/student/remarks` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `category` | optional `RemarkCategory` |
| `dateFrom`, `dateTo` | optional; both ≤ 366 days |
| `sort` | `-date` (default), `date`; `id` tiebreak |

**Visibility is filtered in the query**, never in the serialiser: a guardian route adds
`visibility IN ('guardian', 'student')`, a student route `visibility = 'student'`
(`remarkVisibleTo`, §2.1). `internal` rows do not exist to these routes — not in `total`, not as a
superseded stub. Superseded rows **are** included and carry `supersededAt`/`supersededById` (R141);
there is no `includeSuperseded` parameter here (plan: "superseded rows shown as superseded"). **200**
`{ data: MyRemarkDto[], page, limit, total }`.

---

## 7. `POST /uploads` — capability widening (R171)

The decorator becomes `@RequireCapability(DOCUMENT_UPLOAD, DIARY_WRITE, ANNOUNCEMENT_SEND_SCOPE,
ANNOUNCEMENT_SEND_SCHOOL)` (any of). Nothing else changes: the route ignores the bound scope (a
staged upload is not student-linked), the throttle (20/min, 200/hour per user), the sniff, the
re-encode, the 5 MB limit, the 24 h expiry and the sweep are `slice-6.md` §6.1's. **Consumption
stays bound to the uploader** (`consume(... uploadedBy = userId ...)`): a teacher's staged id in
a clerk's `POST /students/:id/documents`, or a clerk's in a teacher's diary entry, is `422
REFERENCE_NOT_FOUND`. `POST /students/:id/documents` still requires `document.upload`, so a
teacher who can now stage a file cannot attach it to a student record. OpenAPI and the web client
are regenerated (the route's security requirement changes).

---

## 8. Error codes

All already in `packages/shared/src/error-codes.ts` (groundwork §6.1); this contract fixes their
`details`:

| Code | Status | Where |
|---|---|---|
| `DIARY_ENTRY_EXISTS` | 409 | diary create — `details.entryId` (constraint `diary_entries_school_id_section_id_date_subject_id_key`, mapper entry) |
| `DIARY_ENTRY_LOCKED` | 409 | diary patch by the author after the window |
| `AMENDMENT_REASON_REQUIRED` | 409 | diary patch by an all-scope holder after the window without `reason` — `details.amendments: string[]` (the changed field names; slice 11 uses the same key for its mark list) |
| `SUBJECT_NOT_ASSIGNED` | 409 | diary create by a subject teacher for a subject they do not teach in that section on that date |
| `REMARK_SUPERSEDED` | 409 | remark correct on an already corrected row — `details.supersededById` (also the mapper entry for `remarks_school_id_supersedes_id_key`) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | both creates (§3) |
| `PERMISSION_DENIED` | 403 | `details.reason = 'not_author'` (patch, correct); **`'not_assigned_on_date'`** (new reason value: dated scope, §1.3) |

Reused unchanged: `NOT_FOUND`, `VALIDATION_FAILED` / `INVALID_VALUE` / `UNKNOWN_FIELD` /
`REFERENCE_NOT_FOUND`, `SECTION_ARCHIVED`, `CLASS_ARCHIVED`, `ACADEMIC_YEAR_CLOSED`,
`SUBJECT_ARCHIVED`, `STUDENT_NOT_ACTIVE`, `SERVICE_UNAVAILABLE` (thumbnail concurrency),
`PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` (uploads). `NOT_A_TEACHING_DAY` is **not** used: a
diary entry or remark may be dated a holiday or a weekly-off day (decision 12).

## 9. Audit actions

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `diary_entry.created` | diary_entry | — | `{ sectionId, date, subjectId, hasAttachment, notified: boolean, recipientGuardians, recipientStudents }` (counts; zeros when not notified) |
| `diary_entry.updated` | diary_entry | as given (required by the service after the window) | `{ changes, afterWindow: boolean, byAuthor: boolean }` — `changes` names fields; never the text |
| `remark.created` | remark | — | `{ studentId, enrolmentId, date, category, visibility, subjectId, notified: boolean }` |
| `remark.corrected` | remark (the **new** row) | required | `{ studentId, originalId, visibilityFrom, visibilityTo, notified: boolean }` |

No topic, assignment, remark text or recipient name in any metadata (R152's rule). A replayed
create and a no-op patch write no audit row. `test/core/routes.e2e-spec.ts` classification:

```
'POST /api/v1/sections/:id/diary-entries': ['diary_entry.created'],
'PATCH /api/v1/diary-entries/:id': ['diary_entry.updated'],
'POST /api/v1/students/:id/remarks': ['remark.created'],
'POST /api/v1/remarks/:id/correct': ['remark.corrected'],
```

The R68 snapshot gains the eight `@RequireCapacity` routes of §1.1 and asserts they live under
`/me/`.

## 10. For `data-architect` (beyond plan §5)

1. `diary_entries`: `author_staff_id` composite FK to `staff`, indexed `(school_id,
   author_staff_id, date)` (plan); `attachment_object_key varchar(64)`, `attachment_mime
   varchar(32)`, `attachment_size_bytes int` **all null or all set** (`diary_entries_attachment_check`);
   object key prefix CHECK as `student_documents_object_key_check`; `UNIQUE (school_id,
   attachment_object_key) WHERE attachment_object_key IS NOT NULL` (a staged object is consumed
   once); `diary_entries_due_on_check (due_on IS NULL OR due_on >= date)`; `topic`,
   `assignment`, `learning_outcome` `_no_id_check`; frozen columns per §4 by trigger; `updated_at`.
2. `diary_entry_changes`: `old_topic/new_topic`, `old_assignment/new_assignment`,
   `old_learning_outcome/new_learning_outcome`, `old_due_on/new_due_on`,
   `old_attachment_object_key/new_attachment_object_key` (mime and size are derivable and not
   history), `changed_by` composite FK to `users`, `changed_at`, `reason varchar(500)` **nullable**
   (`_no_id_check`); append-only (refuses UPDATE and DELETE); written only by the §4.6 trigger,
   which raises `diary_entry_changes_actor_required` when `asms.actor_user_id` is unset and writes
   nothing for a no-op update. Index `(school_id, diary_entry_id)`.
3. `remarks`: add **`correction_reason varchar(500)` nullable**, `_no_id_check`, `CHECK
   ((supersedes_id IS NULL) = (correction_reason IS NULL))` (`remarks_correction_check`);
   `remarks_supersedes_self_check (supersedes_id IS NULL OR supersedes_id <> id)`;
   `remarks_date_check` is not needed (the service bounds `date ≤ today`; a DATE cannot express
   "today" in a CHECK); `superseded_at` set once by the `AFTER INSERT` trigger on the successor and
   otherwise frozen with every other column (`remarks_columns_immutable`); `author_staff_id`
   composite FK to `staff`; `subject_id` composite FK to `subjects`, nullable.
4. `enrolments_school_id_id_student_id_key` already exists (wave D) — the target of
   `remarks_enrolment_id_fkey (school_id, enrolment_id, student_id)`.
5. No new `school_settings` column: the diary edit window reuses `attendance_amend_window_days`
   (decision 5); the remark fields exist since slice 9.
6. `message_type` values `diary_posted`, `remark_posted` and `message_subject_type` values
   `diary_entry`, `remark` exist since the groundwork migration; nothing to add.
7. Isolation tests for `diary_entries`, `diary_entry_changes`, `remarks` (one per table, control 4).

---

## 11. Web screens → endpoints

Write controls render only when `GET /me` lists the capability; a `403` still shows the
no-permission state.

| Screen | Calls | Behaviour |
|---|---|---|
| Section → Diary tab (day and week views) | `GET /sections/:id/diary-entries?dateFrom&dateTo&limit=50`, `GET /subjects` | Rows grouped by date then subject; "edited" badge when `updatedAt > createdAt`; attachment icon opens `GET /diary-entries/:id/attachment` (image thumbnails from `…/thumbnail` on hover or tap, never in the list by default — R160's spirit on the web too) |
| New entry | `POST /sections/:id/diary-entries` with `Idempotency-Key` from `newIdempotencyKey()` at dialog open | Date defaults to today (max today); subject list limited to the caller's subjects when `GET /me` shows a subject-teacher row for the section and no class-teacher or cover row; one attachment through `POST /uploads`; `DIARY_ENTRY_EXISTS` → "Already written for this date and subject" with a link; `SUBJECT_NOT_ASSIGNED` inline on the subject field; `not_assigned_on_date` inline on the date field |
| Edit entry | `PATCH /diary-entries/:id` | Reason field shown when `me.staffId !== entry.authorStaffId` **or** today > `editWindowEndsOn`; `DIARY_ENTRY_LOCKED` → "The edit window closed on <editWindowEndsOn>; ask the principal"; `not_author` → controls hidden, message if forced |
| Student → Remarks tab | `GET /students/:id/remarks`, `POST /students/:id/remarks`, `POST /remarks/:id/correct` | Filters category, visibility, dates, "show corrected" (`includeSuperseded`); visibility select defaults from `GET /school/settings` (`remarkDefaultVisibility`) when the caller may read settings, else from the server's answer after save; "Correct" opens a dialog with the text, visibility and a required reason; the superseded row renders struck through under its correction; `REMARK_SUPERSEDED` → refetch and open `supersededById` |
| School settings → Remarks | `GET\|PATCH /school/settings` (slice 9 owns the screen) | `remarkDefaultVisibility`, `remarkNotifyGuardians`; the amendment-window field is relabelled "Amendment window (registers and diary)" |
| Grants screen | — | Hint on `diary.write`: "Also lets this user read every section's diary" |

Mobile (slice 16): the teacher diary tab lists `GET /me` assignments' sections and calls
`GET /sections/:id/diary-entries`; the compose screen writes to the outbox and posts with the
stored key; the guardian "child diary" and "remarks" screens call §6.2–§6.4; thumbnails load on
tap (R160); a `diary_posted` push deep-links by `subjectId`.

---

## 12. Tests this contract adds

R137 (one entry per section-date-subject; class teacher any subject; subject teacher own subject
only → `SUBJECT_NOT_ASSIGNED` for another; cover inside dates any subject; cover the day after
`endsOn` → `not_assigned_on_date`; author edit inside the window without reason writes a changes
row; author after the window `DIARY_ENTRY_LOCKED`; all-scope after the window without reason
`AMENDMENT_REASON_REQUIRED` naming the fields, with reason succeeds and the changes row carries
it; another section teacher `not_author`; a no-op patch writes no changes row and no audit; a
direct `UPDATE` without the transaction-local actor is refused by the database) · R138 (an entry
dated today writes one `diary_posted` per guardian and per student-with-login of the enrolments
in force on that date; a guardian of two children in the section once; a staff-guardian once on
the guardian plan; a keypad guardian's delivery row is `suppressed: no_channel`; no WhatsApp,
SMS or email leg ever; a backdated entry writes no message; an edit writes no message) · R139
(identity pattern refused in `topic`, `assignment`, `learningOutcome`, remark `text`, `reason`;
phone pattern refused in `topic`) · R140 (default visibility from settings; `student` ⊇
`guardian`; `/me/children` returns `guardian` and `student` rows and never `internal`, `total`
included; `/me/student` returns `student` rows only; staff list returns all; `remark_posted` only
when `remarkNotifyGuardians` and visibility ≠ `internal`; students never receive it; the body has
no remark text) · R141 (correct inserts a new row, sets `superseded_at` on the original, copies
the identity, carries `correction_reason`; a second correct of the original → `REMARK_SUPERSEDED
{ supersededById }`; the original lists as superseded to a guardian who could see it; an
`internal → guardian` correction sends `remark_posted`, a text-only one does not; a correction
by a non-author section teacher → `not_author`; a direct `UPDATE` of a remark is refused) · R142
(office staff `403` on every diary route; a teacher of another section `404`; a guardian sees
only entries of the child's enrolment-in-force sections and dates — moved child, joined-mid-year
child, left child; a student sees their own; a non-recipient cannot fetch an attachment or
thumbnail; a PDF attachment's thumbnail is `404`) · R143 (replay returns the same row with `200`
and `Idempotency-Replayed: true` for both creates; the same key with a different body or a
different path id → `IDEMPOTENCY_KEY_REUSED`; another user's equal key is independent; a refused
create leaves the key unconsumed; a racing same-key pair yields one row; no `client_reference`
column exists — schema guard) · R163/R164 (guardian scope = live links with `can_login`; an
ended link → `404` on the next request; a child whose status is `withdrawn` stays readable and
receives no `diary_posted`) · R165 (`/me/*` DTO snapshot: no `authorStaffId`, no phone, no
identity field) · R171 (a teacher stages an upload and attaches it; a clerk's staged id in a
teacher's entry → `REFERENCE_NOT_FOUND`; a teacher's staged id in `POST /students/:id/documents`
→ `403` on the route; the thumbnail bytes differ from the original bytes and carry no EXIF) ·
`PermissionDenied` reason `not_assigned_on_date` for a remark dated before the teacher's
assignment began · `STUDENT_NOT_ACTIVE` for a remark on a withdrawn student · the R68 snapshot
with the eight `/me/*` routes · isolation tests for the three tables · `routes.e2e-spec.ts`
classification for the four mutating routes.

---

## Decisions made here

1. **Capacity scope is a third `Scope` kind, `students`, bound by the guard** on
   `@RequireCapacity` routes exactly as capability scope is, so services call `scopeOf(session)`
   on every route; the guardian's ids are live links with `can_login`, with no enrolment or
   status condition (R164). Shared wave-E groundwork: the first of slices 11 and 13 to land builds
   it. `UserAccess.studentId` is added.
2. **No `GET /me/children` route**: `MeDto.children` (`MyChildDto[]`) and `MeDto.staffId` are
   added to `GET /me` instead — one round-trip for the app (R160) and the same pattern as
   `assignments`.
3. **The request hash includes the path id** (`'diary_entries|<sectionId>|…'`,
   `'remarks|<studentId>|…'`): one key sent to two sections or two students is a reuse, never a
   false replay.
4. **Replays answer `200`** with `Idempotency-Replayed: true` (R143), re-reading the subject under
   the caller's current scope; admissions keeps returning its stored `201` and is not changed in
   this slice.
5. **The diary edit window is the school's `attendanceAmendWindowDays`**, measured from the
   entry's creation day, not its date — plan §4.6 names "a per-school window" and there is exactly
   one; a separate diary setting is a later addition if a school asks. The settings screen
   relabels the field. Inside the window the author (and any all-scope holder) edits without a
   reason; after it the author is locked and an all-scope holder needs a reason.
6. **Thumbnails are produced on demand** from the stored (already re-encoded) attachment under the
   existing upload concurrency limit; nothing is stored, so a replaced attachment needs no
   housekeeping. A PDF has no thumbnail (`404`). A stored thumbnail column is the additive fix if
   slice 17's measurements call for it.
7. **`diary_posted` is sent only for an entry dated today**; a backdated entry and every edit send
   nothing (mirrors R126's today-only rule; the diary screen shows the entry regardless). Same-day
   sync is the mobile norm, so the offline teacher's entry still notifies.
8. **A keypad guardian's `diary_posted` row is `suppressed: no_channel`**, per the slice-9 routing
   matrix; the plan's slice-13 test text ("`not_allowed`") is read as that — `not_allowed` is the
   word for an SMS leg refused by the allow list, and a low-priority type has no SMS leg.
9. **A remark hangs off the enrolment in force on its `date`**, which must lie in the caller's dated
   scope with any role (class teacher, cover or any subject teacher); the optional `subjectId` is
   a tag and needs no assignment. A date with no enrolment is `422` on `date`.
10. **A correction may change `visibility`** as well as `text` (a wrong visibility is also a
    correction); it sends `remark_posted` only when it first makes the remark guardian-visible. A
    superseded original stays visible, marked superseded, to every reader its own visibility
    admitted — even when the correction lowered visibility (rule 4, R141).
11. **No remark on a student who has left** (`withdrawn | transferred | alumni` → `STUDENT_NOT_ACTIVE`);
    a `suspended` student may receive one. Corrections follow the same rule.
12. **Diary entries and remarks may be dated non-teaching days**; `NOT_A_TEACHING_DAY` is not used
    here. Diary `date` is ≤ today and within the class's year; `dueOn` ≥ `date` and ≤ the year's end.
13. **Dated-scope refusals are `403 PERMISSION_DENIED` with `details.reason = 'not_assigned_on_date'`**,
    not `404`: the section or student is visible to the caller, so `404` would hide nothing and
    would mislead a cover teacher outside their dates. Slice 11 is asked to use the same code for
    R175's register cases.
14. **Office staff cannot read the diary**; granting `diary.write` to a clerk also lets them write
    it (school-wide). Accepted for Phase 2 (the plan says so) and shown as a hint on the grant
    screen. Office staff do read remarks (`student.view`).
15. **`remark.correction_reason` is a column on the new row** (with a CHECK pairing it to
    `supersedes_id`), not only an audit field: the correction carries its own reason (rule 4).
16. **The remark text never enters a message body**; `remark_posted` names the student, the
    category and the date and says "open the app". The diary `topic` does enter `diary_posted`,
    so `topic` refuses phone patterns as well as identity patterns.
17. **No `GET /diary-entries/:id/changes` route** in this slice: the audit log carries the actor,
    the reason and the changed fields of every edit, and no screen asks for the old values yet; a
    changes read is added when one does.
18. **`PATCH /diary-entries/:id` locks the row**, so there is no optimistic retry and no
    `CONCURRENT_UPDATE`; `date`, `subjectId` and `sectionId` are not editable (`UNKNOWN_FIELD`) —
    the natural key is the entry's identity.
