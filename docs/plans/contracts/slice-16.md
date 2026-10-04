# Slice 16 contract — mobile feature screens (teacher, parent, student; principal)

**Author:** implementation-planner (Fable 5.1), 2026-10-04. **Binds:** `apps/mobile/**` (route
folders, lanes, local tables, components, tests, Maestro flows), `apps/api/scripts/seed-dev-school.ts`
and `seed-dev-guard.ts` (the classroom fixture, §15.3 — a main-thread edit), `.github/workflows/ci.yml`
(the `mobile` job gains MinIO, the worker and the new flows — main thread), `apps/mobile/maestro/ci-run.sh`.
**Sources:** `CLAUDE.md` (rules 2, 4, 13, 14, 16, 17; Design; market constraints; conventions
table), `phase-2-daily-operations.md` §0.13–0.15, §3 (Mobile, Tests, CI), §4.3, §4.7, slice 14
table, slice 16, R155–R162, R163–R166, R173; `contracts/slice-15.md` (whole, especially §5, §6,
§7, §7.6 as decided 2026-10-04, §8, §9, §12, §16); `contracts/slice-11.md` §1–§5, §10, §13;
`contracts/slice-12.md` §4.4, §8; `contracts/slice-13.md` §1–§7, §11; `contracts/slice-10.md` §5.2,
§6; `contracts/slice-9.md` §2.2, §3.5, §3.6, §5.2; `contracts/slice-6.md` §6.1; `contracts/slice-3.md`
§1; the code under `apps/mobile/src` as committed in `f923b85`. Everything not restated follows
slice 15 (request layer, cache, outbox machine, wipe, theme, states) and Phase 1 §3.9.

**Status:** build specification for wave F. It plans no production code; Opus writes the code from
it. Every "must" below is a test, a lint rule or a Maestro assertion.

---

## 0. Scope, and what this contract settles against the plan

Slice 16 turns the slice-15 shell into the app the plan describes: a teacher marks a register in
airplane mode and it reaches the server on the walk back; a parent sees each child's day, diary and
remarks; a student sees their own; a principal sees what was not recorded and fixes it, and sends a
short notice with the SMS it will cost in front of them.

It is built in two parts, as the plan says, and the second depends on an API that does not exist
yet:

| Part | Screens | Depends on | State |
|---|---|---|---|
| **16a** | Teacher: my classes, register (offline, coalesced), per-mark amendment (online), diary entry with queued photo, remark. Parent: children, child attendance, child diary, child remarks, calendar. Student: own attendance, diary, remarks. Staff: "my attendance" card | slices 11, 12, 13, 15 — **all built** (`f923b85`), every route in `apps/api/openapi/school.json` | **Buildable now** |
| **16b** | Everyone: inbox. Principal: today (summary, unrecorded registers, record now, assign cover), announce (new short notice with the reduced audience picker and SMS units, SMS usage) | slice 14 (`GET /me/inbox`, `POST /announcements`, `/preview-audience`, `/send`) — **not written; `contracts/slice-14.md` does not exist** on 2026-10-04 | **Specified against the plan's slice-14 table; every such item is marked "align with slice-14 contract"** and its build task (§16, task 16.7) starts only after slice 14's OpenAPI document is committed |

What this contract decides that the plan leaves open (full list in "Decisions made here"):

1. **A diary photo is attached after the entry, not with it.** The entry goes through the
   `diary_entry` lane as text; its photo goes through the `diary_attachment` lane as upload +
   `PATCH /diary-entries/:id { stagedUploadId }` once the entry has a server id. The plan's
   "photo attachment queued separately" and R158 ("a failed attachment never blocks") require
   this: a 5 MB photo on a 2G signal must not delay the homework, and `diary_posted` goes out only
   for an entry dated today (slice-13 decision 7), so the text must land the same day.
2. **The register's save path is always `POST /sections/:id/submit-register`**, offline-capable and
   coalesced, including amendments with a reason. The online per-mark `POST /attendance-marks/:id/amend`
   with `fromStatus` is the row-level action on an already recorded register (R162, "amendment with
   reason within the window (online, with `fromStatus`)" in the plan's text) and never enters the
   outbox.
3. **A fresh register is pre-filled `present`**; the teacher taps the exceptions. The first submit
   must cover the whole roster (R119), so the pre-fill is what makes "under a minute" true.
4. **FLAG_SECURE on every screen that shows a child's name** (the wave-E security review's advice
   to this slice), through one `secure` prop on `Screen`.
5. **The scripted-day budget stays at 50 KB** (R160) and is measured against a 30-student roster.
   If the real recording exceeds it, the slice reports the number and stops; it does not raise the
   budget (§14).

Not in slice 16: change-email, dark mode, iOS, background sync, a crash reporter, a longer
announcement composer (schedule, attachment, expiry, roles other than parents+students, `student`,
`guardian` or `staff_member` audiences — web only), staff attendance marking (web only, slice-12
§4.2), arrivals at the gate (the office records them on the web; the plan lists it as online-only
and no mobile screen asks for it in Phase 2), the mark-history drawer beyond one list, diary editing
of text (web; the app edits only by attaching the queued photo), remark corrections (web).

---

## 1. Dependencies and decisions this slice waits on

| Item | State | Effect |
|---|---|---|
| Slices 11, 12, 13 routes and DTOs (`RegisterViewDto`, `RegisterSubmitResultDto`, `StudentAttendanceDto`, `MyStaffAttendanceDto`, `DiaryEntryDto`, `MyDiaryEntryDto`, `RemarkDto`, `MyRemarkDto`, `MyChildDto`, `MeDto.staffId/children`) | **Built**; in `school.json`; `pnpm --filter @asms/mobile api:generate` regenerates `src/api/school.d.ts` | None |
| Slice 15 foundation: client, cache, outbox machine and worker, lanes, coalesce rule, wipe and §7.6, tabs, registry, states, theme, Maestro job | **Built** (`f923b85`); 18 suites / 200 tests green | 16 adds to it and rebuilds none of it (§16 of slice 15 is binding) |
| Slice 14 (`contracts/slice-14.md`, `GET /me/inbox`, `/me/inbox/:id/attachment|thumbnail`, `GET|POST /announcements`, `/preview-audience`, `/:id/send`, `/:id/delivery`) | **Not written** | 16b (§7, §8) is specified against the plan's slice-14 table and marked; task 16.7 waits for the contract and the regenerated `school.json`. **16a does not wait** |
| The classroom seed (§15.3): a teacher, a daily-mode section with 30 students, a second unrecorded section, a guardian with a login, one diary entry with a PNG attachment | **To be written** (API script; main-thread edit under the wave process) | The Maestro flows (§15.2) cannot run without it; the Jest suites can |
| MinIO and the worker in the CI `mobile` job (§15.4) | **To be added** (main thread) | The parent flow's attachment and child-card steps need them; nothing else does |
| Firebase project / `google-services.json` | **Owner, pending** | Deep links are proven by `push/routing.spec.ts`; no device shows a push until the file exists |
| Android SDK, JDK, Maestro on this machine | **Absent** (slice-15 §15, WORKLOG) | Everything in §15.1 runs here; the flows run only in CI |
| New native modules: `expo-image-picker`, `expo-image-manipulator`, `expo-file-system`, `expo-sharing`, `expo-screen-capture` | To install with `npx expo install` (slice-15 §2.2 rule); versions recorded in WORKLOG | Each gets one lint door (§13.1); `expo-image` is already installed and already has its door (`src/ui/Attachment.tsx`) |
| `/me` does not say where a capability comes from (WORKLOG wave-E leftover) | **Not needed by 16, deferred.** A teacher holding a school-wide `diary.write` or `attendance.student.mark` grant with no assignment gets no Classes tab (rule 13: scope comes from assignments; the `today` tab needs `view_all`). Such a user works on the web in Phase 2. Adding a capability-source or scope field to `/me` is a slice-17 / Phase 3 item, recorded here so it is not forgotten | None for 16 |
| Register item 30 | Open; not needed | None |
| Owner decisions | **None open for 16a.** 16b inherits slice 14's (none named in the plan) | — |

Blocker summary for the caller: **nothing blocks 16a.** 16b is blocked by slice 14's contract and
OpenAPI, as the plan already sequences (wave F builds 14 and 16 together; 16b is the tail of 16).

---

## 2. Tab composition and registry — what changes

`composeTabs` in `src/auth/tabs.ts` **does not change** (slice-15 §16). Three things do:

1. **`SCREEN_REGISTRY`** (`src/auth/screen-registry.ts`) gains `classes`, `children`, `student`
   in 16a and `inbox`, `today`, `announce` in 16b — each added in the same commit as its route
   folder, so a registered tab always has a screen. A test asserts the registry equals the set of
   `(tabs)/<tab>` route entries (file or folder) present on disk, and that `(tabs)/_layout.tsx`'s
   `ROUTES` lists exactly the registry plus `more`.
2. **`(tabs)/_layout.tsx`** `ROUTES` gains the same ids. The bottom bar stays at five slots with
   `more` (slice-15 §5); the teacher-parent sees Home, Classes, Children, Inbox, More.
3. **Home** becomes a folder (`(tabs)/home/_layout.tsx` Stack, `index.tsx`, `my-attendance.tsx`)
   and gains one card for `staff`: "My attendance" (R135) → `/home/my-attendance` (§6). Nothing
   else moves onto Home: the role tabs carry their own screens.

Tab titles (`TAB_TITLES`, already in `shell.ts`): `student` is "My school" and stays so.

**`routeForNotification`** (`src/push/routing.ts`) is extended; the table is normative and every
row is a test:

| `subjectType` | Route | Needs |
|---|---|---|
| `announcement`, `holiday`, `holiday_cancellation`, `sms_cap`, `messaging_test` | `/inbox/[messageId]` | `inbox` registered (16b); until then `home` |
| `attendance_alert`, `diary_entry`, `remark` | `/inbox/[messageId]` — the inbox item names the child through `viaStudents`, and the item screen offers "Open <child>" into `/children/[studentId]/attendance|diary|remarks` by `subjectType` (16b). **16a interim:** `/children` when `guardian`, `/student/<attendance|diary|remarks>` when only `student`, else `home` | — |
| `register_deadline` | `/today` when registered and the user has `today`, else `home` | 16b |
| `teacher_assignment` (`cover_assigned`) | `/classes` when the user has `classes`, else `home` | 16a |
| unknown, malformed | `/home` | — |

`routeForNotification` keeps its signature `(data, hasScreen)` and gains a third argument, the
user's `TabId[]` from `composeTabs`, so a route is never produced for a tab the user does not have
(R156).

---

## 3. Rules every slice-16 screen obeys

### 3.1 Reads: one cache key per screen, all through `useCachedQuery`

Every list and detail read goes through `useCachedQuery(queryKey, path, params, fetcher)`
(slice-15 `src/db/use-cached-query.ts`), so it hydrates from SQLite with its "as of" and refetches
when online. `src/api/query-keys.ts` is the only place a key is written; the cache key is derived by
`cacheKey(path, params)`. **Normative key table** (dates `YYYY-MM-DD` in school time; `limit` is
always `25` unless stated; `page` is part of the key):

| Screen | Endpoint (+ params) | Query key | Staleness / notes |
|---|---|---|---|
| My classes | none (from `['me']`) | — | `me.assignments`; refetch `/me` on pull-to-refresh only |
| Class sections for a whole-class subject row | `GET /classes/:classId/sections?limit=50` | `['classes', classId, 'sections']` | dropdown-style, 50 allowed (slice-15 §9 rule 3) |
| Register | `GET /sections/:id/register?date&period` | `['sections', id, 'register', date, period]` | the roster of one day; invalidated when its outbox item is `done` |
| Mark changes (online read, row sheet) | `GET /attendance-marks/:id/changes?limit=25` | `['attendance-marks', id, 'changes', page]` | not hydrated offline (opened online only) |
| Section diary | `GET /sections/:id/diary-entries?dateFrom&dateTo&limit=25&page` | `['sections', id, 'diary', dateFrom, dateTo, page]` | default range: Monday of this week to today; "earlier" pages back a week |
| Subjects (class teacher / cover compose) | `GET /subjects?limit=50` | `['subjects']` | dropdown-style |
| Student remarks (staff) | `GET /students/:id/remarks?limit=25&page` | `['students', id, 'remarks', page]` | every visibility (staff route) |
| Children cards | per child: `GET /me/children/:id/attendance?dateFrom=<1st of month>&dateTo=<today>` | `['me','children', id, 'attendance', dateFrom, dateTo]` | one request per child (`me.children` ≤ a handful); the same key the month view uses for the current month |
| Child attendance month | `GET /me/children/:id/attendance?dateFrom&dateTo` | as above | per month |
| Child diary | `GET /me/children/:id/diary-entries?dateFrom&dateTo&limit=25&page` | `['me','children', id, 'diary', dateFrom, dateTo, page]` | default: last 14 days; "earlier" pages back 14 days |
| Child remarks | `GET /me/children/:id/remarks?limit=25&page` | `['me','children', id, 'remarks', page]` | |
| Student attendance / diary / remarks | `GET /me/student/attendance`, `/diary-entries`, `/remarks` with the same params | `['me','student', 'attendance'|'diary'|'remarks', …]` | same components as the child screens |
| My attendance (staff) | `GET /me/staff/attendance?dateFrom&dateTo` | `['me','staff','attendance', dateFrom, dateTo]` | per month |
| Inbox (16b) | `GET /me/inbox?limit=25&page[&category]` | `['me','inbox', category ?? 'all', page]` | align with slice-14 contract |
| Today — unrecorded | `GET /attendance-registers?date=<today>&recorded=false&limit=25&page` | `['attendance-registers', date, 'unrecorded', page]` | live on the server; `staleTime` 0 for this key (always refetch on open) |
| Today — summary | `GET /attendance-reports/daily-summary?dateFrom=<today>&dateTo=<today>&limit=50&page` | `['attendance-reports','daily-summary', date, page]` | 50 allowed: one row per section, a bounded school |
| Cover sheet — staff picker | `GET /staff?status=active&limit=50&page` | `['staff','active', page]` | dropdown-style |
| Cover sheet — class teacher's assignments | `GET /staff/:id/teacher-assignments?limit=50` | `['staff', id, 'assignments']` | to find `coversAssignmentId` |
| Announce — usage (16b) | `GET /messaging/usage` | `['messaging','usage']` | shown only with `cap(school.settings.manage)` (slice-9 §1.1) |
| Announce — recent (16b) | `GET /announcements?limit=25&sort=-createdAt` | `['announcements', page]` | align with slice-14 contract |
| Announce — classes / sections pickers | `GET /classes?limit=50`, `GET /classes/:id/sections?limit=50` | `['classes', page]`, `['classes', id, 'sections']` | `@RequireStaff()` reads (slice 3) |
| Calendar | unchanged from 15 | | |

**Invalidation on `done`** (the lane's follow-up in `runtime.ts`, §10.3): `submit_register` →
`['sections', id, 'register', date, period]`, `['attendance-registers', date, …]` and
`['attendance-reports', …, date, …]`; `diary_entry` → `['sections', id, 'diary', …]`;
`diary_attachment` → the same plus the entry's detail; `remark` → `['students', id, 'remarks', …]`.
Parents' keys are never touched by a teacher's write (different user, different device).

No `refetchInterval` anywhere (lint). Pull-to-refresh (`RefreshControl`) is the one manual refresh,
and it is disabled while offline.

### 3.2 States — every screen, four plus offline

Every screen renders `LoadingState`, `EmptyState`, `ErrorState` (with retry), `NoPermissionState`
(a `403` — should not occur, R156; logged as a composition bug) from `src/ui/states.tsx`, and the
`OfflineNotice` banner with the cached row's "as of" when offline or when the last refetch failed
(the Calendar screen is the template). A screen that has **both** cached data and an error shows the
data with the notice, never the error. Online-only actions (§3.5) render disabled with the detail
"Needs a connection" when `useOnline()` is false — never a toast after the tap.

### 3.3 Layout — 360 px, 48 dp, one hand

Every screen lays out in one column at 360 dp width with no horizontal scrolling and no text
truncation of a child's name (names wrap). Every tappable element is at least `TAP_TARGET` (48 dp)
tall; status chips in the register are 48 × 48 dp minimum and the whole row is the tap target.
Primary actions sit at the bottom of the screen (thumb reach). Lists are `FlatList` with
`initialNumToRender` 20 and `getItemLayout` where rows are fixed height (the register).

**Attendance status colours** are added to `src/ui/theme.ts` once (slice-15 §12) and used only
through `statusTone(status)`; a colour is never the only carrier of meaning — every chip also
carries its one-letter or word label, and the legend names each:

| Status | Hex | Label in a chip | Word |
|---|---|---|---|
| `present` | `#15803D` | P | Present |
| `absent` | `#B91C1C` | A | Absent |
| `late` | `#B45309` | L | Late |
| `on_leave` | `#475569` | O | On leave |
| `partial` | `#B45309` with a dashed border | — | Partly absent |
| unrecorded / `null` | `#F5F5F5` (muted) with `#737373` text | — | Not recorded |

Chip foreground is `#FFFFFF` on the four solid colours (contrast ≥ 4.5:1 on each). No gradients, no
icons for status, no animation beyond the platform transition (Design rules).

### 3.4 Outbox bodies carry ids, never names (slice-15 §7.6, binding here)

A body is built only by one of three pure builders in `src/outbox/bodies.ts` —
`buildRegisterBody`, `buildDiaryBody`, `buildRemarkBody` — and the attachment lane's row carries
`{ localAttachmentId }` only. The test `outbox/bodies.spec.ts` builds each from a fixture that
contains names, a phone and a 13-digit number in the surrounding screen data, serialises the body,
and asserts: no key matches `/name/i`, the R16 identity regex does not match, the phone regex does
not match, and the key set equals exactly the contract's field list for that lane (§9). The
teacher's `note` and `reason`, the diary `topic`/`assignment`/`learningOutcome` and the remark
`text` are typed text and are the body — the server already refuses an identity or phone pattern in
them (slice-11 §4.2, slice-13 §1.6), and the app refuses the same patterns before saving
(`containsIdentityNumber` from `@asms/shared`, the phone regex from `scrub.ts`) so a refused body
never waits in the queue to fail.

What this buys: after a `401` the pending register shows "32 marks, 2 absent — saved on device"
with **no names** until the user signs in again and the roster cache is refetched (the cache was
wiped, the outbox row kept — §7.6). The register screen must render that state (§4.2).

### 3.5 Online-only actions (R162) — the list, extended

`ONLINE_ONLY_ACTIONS` in `src/outbox/lanes.ts` gains `amend_mark`, `create_announcement`,
`preview_audience`. The full list after 16: `change_password`, `revoke_other_sessions`, `sign_out`,
`arrivals`, `amend_after_window`, `amend_mark`, `assign_cover`, `create_announcement`,
`preview_audience`, `send_announcement`. `lanes.spec.ts` asserts none is a lane key and that every
screen action calling one of them is wrapped in `useOnlineOnly()` (a hook returning `{ enabled,
reason }`; a grep test over `src/app/**` asserts every `api.POST(` outside `src/outbox/**` and
`src/auth/**` sits in a file that imports it).

### 3.6 Data cost (R160, R166) — carried forward

Lists ask `limit=25` (pickers 50); no image renders before a tap; `src/ui/Attachment.tsx` is the one
`expo-image` importer; the thumbnail loads on the first tap and the original on a second; no
prefetch; `GET /me` runs at sign-in, cold start, pull-to-refresh on My classes / Children and after
change-password. The scripted-day test is extended (§14).

### 3.7 Log hygiene — new dropped keys

`scrub.ts` `DROPPED_KEYS` gains `topic`, `assignment`, `learningOutcome`, `reason`, `title`,
`studentFullName`, `fullName` (already), `viaStudents`, `marks`, `audiences`. Screens log only
events and ids: `register.saved_on_device { sectionId, date, period, marks: <count> }` — the count,
not the array (the scrubber drops `marks` if an array slips through; the test plants one).

---

## 4. 16a — Teacher screens

### 4.1 My classes — `/classes`

**Data:** `me.assignments` (cached `/me`), grouped by section: one row per distinct `sectionId`
(class teacher, cover and section-level subject rows merge into one row listing the roles); a
**whole-class subject row** (`sectionId: null`, R54) expands to that class's sections through
`GET /classes/:classId/sections` (cached) so each is a row. Rows carry: "Class 5 A", roles ("Class
teacher", "Covering until 10 Oct", "English, Urdu"), `attendanceMode` as a caption ("Daily
register" / "Period register").

**Actions per row** (each a 48-dp row inside the section card):

| Action | Shown when | Opens |
|---|---|---|
| Register | `cap(attendance.student.mark)`; **disabled** with "Daily register is the class teacher's" when the caller's only role on the section is subject teacher and the mode is `daily` (slice-11 §1.2's one `403` after a successful scope check) | `/classes/[sectionId]/register?date=<today>&period=1` |
| Diary | `cap(diary.write)` | `/classes/[sectionId]/diary` |
| Students | `cap(student.view)` (teacher default) | `/classes/[sectionId]/students` — the roster from the register view of today (`period=1`), each student → `/classes/[sectionId]/students/[studentId]` (§4.6) |

A principal has no assignments and no Classes tab; they reach a register from Today (§7.1). Empty
state: "No classes assigned to you today. Ask the office." Pull-to-refresh refetches `/me`.

### 4.2 Register — `/classes/[sectionId]/register?date&period`

**Data:** `GET /sections/:id/register?date&period` (cached per section-date-period) **overlaid** with
the local register for the same natural key when one exists (`local_registers` + `local_marks`,
§8). Header: class and section, date (tappable → date sheet, ≤ today; 30 days back), period picker
when `section.attendanceMode = 'period'` (1…`periodsPerDay`; hidden in daily mode, where period is
always 1). Below: "Recorded by <submittedByName> at HH:MM" and "Amended by <lastAmendedByName>"
when `register` is not null; the outbox state line (below); `canSubmit`/`amendable` drive the mode.

**Roster rows** (fixed 56-dp height): roll number, name (wraps), status chip (48 × 48). Rows with
`onRoster: false` show "left" and are read-only. Order is the server's (slice-11 §3.1).

**Modes**, decided from the view and the local state:

| Condition | Mode | Behaviour |
|---|---|---|
| `register === null` and `teachingDay` and `canSubmit` | **New register** | every row pre-filled `present` (decision 3); tap cycles `present → absent → late → on_leave → present`; long-press opens the row sheet (note 1–200, `arrivedAt` HH:MM when `late`); the footer shows live counts "P 30 · A 2 · L 1 · O 0" and **Save register** |
| `register !== null`, `amendable` | **Amend** | rows show the server mark; a tap cycles as above and marks the row "changed"; Save requires a **reason** (3–500) when any row differs from the server's mark — the reason sheet opens on Save, listing the changed rows ("Ali: present → absent"); nothing is enqueued without it. Rows that did not change are **not sent** (a subset submit; slice-11 §4.2 step 8 compares only the items sent) |
| `register !== null`, not `amendable`, `canSubmit` | **Read-only, window closed** | banner "The amendment window closed. Ask the principal." (`ATTENDANCE_LOCKED` would be the server's answer; the app does not try) |
| `!teachingDay` | **Read-only** | banner "Not a teaching day." (`register` shown if any — R167's "recorded on a day later declared a holiday") |
| `!canSubmit` (viewer, `view_all` only) | **Read-only** | no Save; `callerRole = 'viewer'` caption |
| cached view present, offline | any of the above from the cache | `OfflineNotice` with the view's "as of"; Save still works (it writes to the device) |
| no cached view, offline | — | `ErrorState` "Cannot load this register offline. Open it once while connected." — a register never seen cannot be marked blind (the roster is unknown) |

**Save** (new or amend) — one SQLite transaction (`enqueueIn`):

1. Build the body with `buildRegisterBody` (§9): `{ date, period, marks: [{ enrolmentId, status,
   note?, arrivedAt? }], reason? }` — in new mode every roster row with `onRoster: true`; in amend
   mode only changed rows. Identity/phone patterns in a note or reason are refused before this
   step with a field error.
2. Upsert `local_registers` (natural key) and replace its `local_marks` for the enrolments in the
   body; `enqueueIn` with `lane: 'submit_register'`, `naturalKey: registerNaturalKey(sectionId,
   date, period)`, `domainTable: 'local_registers'`, `domainId`. A pending row for the key merges
   (`mergeMarksBody`: latest mark per enrolment wins, newer non-empty reason wins — slice-15 §7.4);
   a `sending` row leaves a new pending row behind it.
3. The screen shows the **state line**: "Saved on device" (pending; "retrying in n min" when backed
   off), "Sending", "Saved on server at HH:MM" (only after `2xx`, R157, with the response's
   `summary` counts), "Not saved: <server message>" (failed) with the lane's remedy (§9).
   `outboxWorker.trigger('enqueued')` runs when online.

**Row sheet** (long-press, or tap on a recorded register in amend mode when the user chooses
"details"): status, note, arrival time, "amended" badge; **Mark history** (`GET
/attendance-marks/:id/changes`, online only — `MarkChangeDto` rows "from → to, by <name>, reason");
**Amend this mark** → §4.3 (online only).

**After a `401`** (cache wiped, pending row kept): the screen opens from `local_registers` alone and
shows "32 marks saved on device (2 absent, 1 late) — sign in to see names"; nothing else renders
(§3.4). The sign-in screen already says "n unsent items will be sent after you sign in".

**Secure:** `<Screen secure>` (§13.2).

### 4.3 Amend one mark — online (`POST /attendance-marks/:id/amend`, R162)

From the row sheet when `register !== null`, `amendable`, the mark exists and `useOnline()`.
Fields: new status (chips), reason (3–500, required), note (optional; absent = unchanged; clear →
`null`), arrival time when `late`. Body `{ fromStatus: <the mark's status as the screen holds it>,
status, reason, note?, arrivedAt? }`. Outcomes:

| Status / code | Screen |
|---|---|
| `200 AttendanceMarkDto` | the row updates from the DTO; the register query is invalidated (not refetched offline) |
| `409 STALE_STATUS` | "This mark was changed by a colleague to <currentStatus>. Reload and amend again." → refetch, sheet stays open with the new `fromStatus` (R125) |
| `409 ATTENDANCE_LOCKED`, `NOT_A_TEACHING_DAY` | message from the server; sheet closes |
| `403 PERMISSION_DENIED` (`not_assigned_on_date`, `subject_teacher_daily_mode`) | `NoPermissionState` text inline |
| `422` | field errors |
| network | "No connection. Amending needs a connection." (the action is already disabled offline; this is the race) |

Never enqueued; `lanes.spec.ts` asserts `amend_mark` is in `ONLINE_ONLY_ACTIONS`.

### 4.4 Section diary — `/classes/[sectionId]/diary` and `/classes/[sectionId]/diary/new`

**List:** `GET /sections/:id/diary-entries` for the current week (Monday–today), cached; rows grouped
by date, then subject: subject, topic (two lines), "Due Fri 10 Oct", "edited" when `updatedAt >
createdAt`, an attachment marker ("Photo" / "PDF", no image). "Earlier" loads the previous week
(new key). **Local entries** not yet on the server render in the same list with their state line
("Saved on device", "Sending", "Not saved: …") from `local_diary_entries`, above the server rows for
their date. Tap → entry sheet (all fields; attachment through `Attachment.tsx` on tap, §5.3's rules;
the queued photo's own state line when it exists).

**Compose** (`new`, `cap(diary.write)`):

| Field | Rule |
|---|---|
| Date | default today; ≤ today; within 30 days back (the server checks the academic year) |
| Subject | **subject-teacher only on this section** (no class-teacher/cover row): the subjects of the caller's assignments for the section; **class teacher or cover:** `GET /subjects?limit=50` (cached); exactly one. A principal (all scope) reaching this screen from Today gets the full list |
| Topic | required, 1–500, no identity or phone pattern (refused before save) |
| Assignment | optional, 0–1000, multi-line |
| Learning outcome | optional, 0–500 |
| Due on | optional, ≥ date |
| Photo | optional, **one**, via `expo-image-picker` (camera or library) → §4.5 |

Save — one SQLite transaction: `local_diary_entries` row + `enqueueIn({ lane: 'diary_entry', path:
'/api/v1/sections/<id>/diary-entries', body: buildDiaryBody(...), domainTable, domainId })`; the
outbox id **is** the `Idempotency-Key` (slice-15 §7.3; `lane.idempotencyHeader = true`). If a photo
was chosen, `local_attachments` gets a row in state `waiting` in the same transaction (§4.5). The
form closes to the list with the local entry shown "Saved on device".

Remedies (§9): `409 DIARY_ENTRY_EXISTS` → "Already written for this date and subject" with **Open**
(`details.entryId` → the server entry; the local row is marked `superseded_by_server` and its
waiting photo is offered "Attach to the existing entry?" which re-targets the attachment lane to
`entryId`, or discard); `409 SUBJECT_NOT_ASSIGNED`, `SUBJECT_ARCHIVED`, `SECTION_ARCHIVED`,
`CLASS_ARCHIVED`, `ACADEMIC_YEAR_CLOSED`, `403 not_assigned_on_date`, `404` → shown, "Edit and
resend" (opens the form pre-filled; saving creates a **new** pending row with a new key) or
discard; `422` → "Edit and resend" with the field errors.

**Secure:** the list shows no child names; the compose shows none. Not `secure`.

### 4.5 The photo — `diary_attachment` lane (R158: its own lane)

**Capture.** `src/media/picker.ts` is the only importer of `expo-image-picker` and
`expo-image-manipulator`: it asks for the camera or the library (JPEG/PNG only; `allowsEditing:
false`; `exif: false`), downscales to **1600 px on the longest side, JPEG quality 0.8**
(`expo-image-manipulator`; the output carries no EXIF), and copies the result to
`<documentDirectory>/outbox/<attachmentId>.jpg` through `src/media/files.ts` (the only
`expo-file-system` importer). The picker's temporary file is deleted. Nothing is written to the
camera roll (`saveToPhotos` is never set). Size after downscale is typically 200–600 KB; a result
over 5 MB is refused on the device with "Photo too large" before it is stored (the server limit,
slice-6 §6.1).

**Local row** (`local_attachments`, §8): `id`, `local_entry_id`, `file_path`, `mime`, `size_bytes`,
`state ∈ waiting | queued | done | failed | discarded`, `staged_upload_id`, `staged_expires_at`,
`outbox_id`, timestamps.

**When it is queued.** Not at save: the entry has no server id yet. The `diary_entry` lane's
`onSaved` follow-up (§10.3) writes `server_id` on `local_diary_entries` and then, for each
`waiting` attachment of that entry, `enqueue({ lane: 'diary_attachment', method: 'PATCH', path:
'/api/v1/diary-entries/<serverId>', body: { localAttachmentId } })` and sets the attachment `queued`
with its `outbox_id`. **Startup recovery:** `recoverWaitingAttachments()` runs beside
`recoverStaleItems()` and enqueues any `waiting` attachment whose entry already has a `server_id`
(a crash between the two writes), and marks `failed: entry_discarded` any attachment whose entry was
discarded. Idempotent: an attachment with an `outbox_id` is never enqueued twice.

**Sending** — the one lane whose `sender` is not `json` (§10.1). `sendAttachment(item)`:

1. Read the local row; file missing → outcome `{ kind: 'response', status: 422, code:
   'ATTACHMENT_FILE_MISSING', message: 'The photo is no longer on this phone' }` (terminal; a
   client-side code, never sent to the server).
2. If `staged_upload_id` is null or `staged_expires_at ≤ now + 5 min`: **upload**
   `sendMultipart('/api/v1/uploads', field 'file', file, mime)` (§11) → `201 { id, mime, sizeBytes,
   expiresAt }` → stored on the row. Upload refusals map to the outcome unchanged: `413
   PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE` (→ the machine's unexpected-status branch is
   **not** wanted here: these never heal, so the lane marks them terminal by returning status `422`
   with the server's code and message — decision 7); `429`, `503 SERVICE_UNAVAILABLE`, `5xx`,
   network → returned as they are (retry with backoff).
3. **PATCH** `/api/v1/diary-entries/<serverId>` body `{ stagedUploadId }` (no `Idempotency-Key`;
   slice-13 §3: retry-safe by state) → `200 DiaryEntryDto` with `hasAttachment: true` → `done`:
   the local file is deleted, the entry's cache keys invalidated. `422 REFERENCE_NOT_FOUND` on
   `stagedUploadId` (expired or consumed meanwhile): the lane clears `staged_upload_id` and returns
   `{ kind: 'network' }` **once** (a retry re-uploads); a second `REFERENCE_NOT_FOUND` in a row is
   returned as the terminal `422` it is. `409 DIARY_ENTRY_LOCKED` (the window closed before the
   photo got through — more than `attendanceAmendWindowDays` offline) → terminal: "The entry can no
   longer be edited from the app; ask the principal to attach it on the web." `409
   AMENDMENT_REASON_REQUIRED` cannot occur for the author inside the window and is terminal if it
   does. `401` / `426` → the machine's pause / block as for any lane.

One request in flight per lane; a slow upload never delays `submit_register` or `diary_entry`
(worker test). The sync sheet labels the lane "Diary photo" and shows "Waiting for its diary entry"
for `waiting` rows (read from `local_attachments`, not the outbox), with discard.

**Files at rest:** `<documentDirectory>/outbox/` is deleted whole by `wipeAll()` and by
`wipeForSessionLoss()` **only for rows not kept** (a kept pending entry keeps its waiting photo);
`purgeFinished` deletes the files of `done`/`failed` attachments with their rows after 7 days.
`android:allowBackup="false"` already excludes the folder from backup. The folder holds photos of
homework, not of children, by instruction on the capture screen ("Photograph the board or the
book, not the children") — stated, not enforced.

### 4.6 Student sheet and remark — `/classes/[sectionId]/students/[studentId]`

**Data:** the student's name and roll number come from the roster already cached for the section
(today's register view, period 1); remarks from `GET /students/:id/remarks?limit=25` (staff route;
every visibility, `includeSuperseded` false). The list shows category, date, text, visibility badge
("Staff only" for `internal`), author, "corrected" marker when `supersededAt` is set (hidden by
default, as the server does). Local remarks render above with their state line.

**New remark** (`cap(remark.write)`), a form sheet:

| Field | Rule |
|---|---|
| Date | default today; ≤ today; 30 days back (the server checks the enrolment in force) |
| Category | `REMARK_CATEGORIES` (`academic`, `behaviour`, `homework`, `attendance`, `participation`, `general`) |
| Text | required, 1–1000, multi-line; identity pattern refused before save |
| Visibility | select with **"School default"** (omit the field; the server applies `remarkDefaultVisibility`, slice-13 §5.2 — the app cannot read settings) plus `internal` / `guardian` / `student` |
| Subject | optional, from the caller's subjects on the section (subject teacher) or `GET /subjects` (class teacher / cover); "None" default |

Save: `local_remarks` row + `enqueueIn({ lane: 'remark', path: '/api/v1/students/<studentId>/remarks',
body: buildRemarkBody(...) })`, outbox id = `Idempotency-Key`. Remedies (§9): `409
STUDENT_NOT_ACTIVE`, `ACADEMIC_YEAR_CLOSED`, `SUBJECT_ARCHIVED`, `403 not_assigned_on_date`, `404`
→ shown, discard; `422` (date with no enrolment, text pattern, `REFERENCE_NOT_FOUND` on subject) →
"Edit and resend" (new pending row, new key) or discard.

**Secure:** `<Screen secure>` (a child's name and remarks about them).

---

## 5. 16a — Parent and student screens

### 5.1 Children — `/children`

One card per `me.children` row (`MyChildDto`): name, "Class 5 A · Roll 12" from `current` (or
"No current class"), a status badge when `status !== 'active'` ("Left", "Suspended" — R164: the
link is live, history stays readable, nothing new arrives). Below: **today's derived status**
(`days[today].status` → word and chip; `null` → "Not recorded yet"; `teachingDay: false` → "No
school today") and **this month** "`percentage`% — `countedDays` of `teachingDays` days" (`null`
→ "No recorded days yet"), both from `GET /me/children/:id/attendance?dateFrom=<1st>&dateTo=<today>`
(one request per child, cached; the same key the month view hydrates from). Card tap →
`/children/[studentId]/attendance`; two secondary rows: Diary, Remarks. Empty state (no children):
"No children are linked to your account. Ask the school office." Pull-to-refresh refetches `/me`
and the cards.

**Secure:** yes.

### 5.2 Child attendance — `/children/[studentId]/attendance?month`

The shared **`AttendanceMonth`** component (also §5.5 and §6): month title with previous/next
(like Calendar); a 7-column grid (Sunday first — Pakistan's week ends Sunday; the weekly-off days
come from `GET /me/calendar` already cached, not from this DTO) of `StudentDayDto` cells: date
number, chip colour by `status` (§3.3), hollow for `teachingDay && status === null` (unrecorded),
muted for `!teachingDay` or `!enrolled`; a legend row; the summary line "`percentage`% ·
`present` present · `absent` absent · `late` late · `onLeave` on leave · `partial` partly absent ·
`unrecorded` not recorded"; `excludedLeaveDays > 0` → "n leave days not counted". Tap a cell →
a sheet listing `periods[]` ("Period 1 — Absent", "Period 3 — Late (arrived 08:40)"). **No note,
no teacher** exist in the DTO (R165); the component renders no field it does not have. Cached per
month with "as of".

The staff variant (§6) renders `MyStaffAttendanceDto` days (`workingDay`, `employed`, `status`,
`amended`) through the same grid with "working day" wording; the component takes a `kind:
'student' | 'staff'` prop and nothing else differs.

**Secure:** yes (the child's name is the header).

### 5.3 Child diary — `/children/[studentId]/diary`

`GET /me/children/:id/diary-entries` for the last 14 days (cached; "Earlier" pages back 14 days);
grouped by date; each row: `className sectionName · subjectName`, topic, "Due …", "Photo" / "PDF"
marker (no image). Tap → entry sheet: topic, assignment, learning outcome, due date, author's name
(`authorName`, R165), "edited" marker, and the **attachment**:

- `attachmentMime` image → an "Show photo" button → `Attachment.tsx` loads
  `GET /me/children/:id/diary-entries/:entryId/thumbnail` with `expo-image` (`cachePolicy: 'disk'`,
  `source.headers = authHeaders()` — the bearer travels in a header, never in the URL); a second tap
  loads `…/attachment` full size. Size caption from `attachmentSizeBytes` ("1.2 MB — opens on tap")
  so a metered parent decides.
- `application/pdf` → "Open PDF (`size`)" → `src/media/files.ts` downloads `…/attachment` to the
  cache directory with the bearer header, hands it to `expo-sharing` (`shareAsync`, the system
  chooser — the only `expo-sharing` importer is `files.ts`), and deletes the file when the share
  sheet closes. No PDF is kept.

`404` on an attachment → "This file is no longer available." **expo-image's disk cache is cleared**
(`Image.clearDiskCache()`) by `wipeAll()` and `wipeForSessionLoss()` (§13.3).

**Secure:** yes.

### 5.4 Child remarks — `/children/[studentId]/remarks`

`GET /me/children/:id/remarks?limit=25` (guardian-visible rows only — filtered by the server,
slice-13 §6.4). Rows: category, date, subject, text, author; a row with `supersededAt` renders
muted with "Corrected — see the newer remark" and no strike-through (readable). Empty state: "No
remarks." **Secure:** yes.

### 5.5 Student — `/student` (tab "My school")

An index with three rows — Attendance, Diary, Remarks — each opening the §5.2–5.4 component bound
to `GET /me/student/attendance`, `/me/student/diary-entries` (+ attachments through
`/me/student/diary-entries/:entryId/attachment|thumbnail`), `/me/student/remarks` (student-visible
rows only). Same components, same keys with the `['me','student', …]` prefix, same states. The
student's own name is in the header → **secure**.

### 5.6 Calendar

Unchanged from slice 15; already in every user's tabs. Holidays here are the parent's "calendar
(holidays)" of the plan.

---

## 6. Home — the staff "My attendance" card

For `staff` capacity: a card "My attendance — October: 18 of 20 working days" from
`GET /me/staff/attendance?dateFrom=<1st>&dateTo=<today>` (cached) → `/home/my-attendance`, the
`AttendanceMonth` component in `staff` kind. The DTO has no `note` and no `markedByName`
(slice-12 decision 6); the screen renders neither. Not secure (the user's own data).

Home otherwise stays as in 15 (name, school, "as of", banners).

---

## 7. 16b — Principal screens (every endpoint in this section that is slice 14's is marked)

### 7.1 Today — `/today` (`staff ∧ cap(attendance.student.view_all)`)

Two sections for `today` (school time), both cached with "as of":

**Not recorded** — `GET /attendance-registers?date=<today>&recorded=false&limit=25` (live on the
server, `staleTime` 0): one row per `SectionDayDto`: "Class 5 A", `classTeacherName` ("no class
teacher" when null), "Cover: `coverStaffName`" when set, `rosterCount` students, `mode`. Empty state:
"Every register is recorded." `teachingDay` false on every row or an empty day → "Not a teaching
day." Actions per row:

| Action | Shown when | Behaviour |
|---|---|---|
| **Record now** | `cap(attendance.student.mark)` | opens `/classes/[sectionId]/register?date=<today>&period=1` — the §4.2 screen; the caller's `all` scope makes `canSubmit` true without an assignment; offline-capable like any register |
| **Assign cover** | `cap(class.manage) ∧ cap(staff.view)` ∧ online (R162) | the cover sheet below |

**Cover sheet** (online only; `assign_cover` is in `ONLINE_ONLY_ACTIONS`): covering staff from
`GET /staff?status=active&limit=50` (search box filters client-side; 13 digits typed → the box
says "search by name"); dates `startsOn` (default today) and `endsOn` (required, default today);
`coversAssignmentId` resolved from `GET /staff/:classTeacherStaffId/teacher-assignments?limit=50`
(the live `class_teacher` row for the section; none → omitted, "covering a section with no class
teacher", slice-10 §6). `POST /staff/:coverStaffId/teacher-assignments { role: 'cover', classId,
sectionId, startsOn, endsOn, coversAssignmentId? }` → `201` → "Cover arranged; <name> has been
told." (the `cover_assigned` push is the server's), the unrecorded list refetches (the row stays
until a register exists — cover does not record). Errors: `409 CAPABILITY_NOT_HELD` → "<name>
cannot mark registers"; `409 SELF_ACTION_FORBIDDEN` → "You already hold every class"; `409
ASSIGNMENT_EXISTS` → treated as done; `409 STAFF_NOT_ACTIVE`, `ACADEMIC_YEAR_CLOSED`,
`SECTION_ARCHIVED`, `CLASS_ARCHIVED`, `422` → server message.

**Summary** — `GET /attendance-reports/daily-summary?dateFrom=<today>&dateTo=<today>&limit=50`
grouped by `className`: one line per section "A: 28 P · 2 A · 1 L · 0 O · 1 partly · 2 not
recorded" (`DailySummaryDto`), `stale: true` → "updating…" caption; `registersExpected = 0` (not
yet computed) → "not yet computed". A school with more than 50 sections pages ("Next 50").

No student names on Today → not `secure`. The `register_deadline` push opens here (§2).

### 7.2 Announce — `/announce` (`staff ∧ cap(announcement.send.school)`) — **align with slice-14 contract**

**SMS usage card** (built endpoint, slice-9 §5.2; shown only with `cap(school.settings.manage)`,
the route's capability): "SMS this month: `used` of `cap` · `remaining` left" from
`GET /messaging/usage` (`months[0].byChannel` where `channel = 'sms'`, `cap`, `remaining`); cached
with "as of". Without the capability the card is absent and the compose screen still shows the
units `preview-audience` returns.

**Recent** — `GET /announcements?limit=25&sort=-createdAt` *(slice 14)*: title, status badge
(`draft` · `scheduled` · `sending` · `sent` · `cancelled`), `sentAt`, `recipientCount`. Tap →
`/announce/[id]`: the fields and, when sent, `GET /announcements/:id/delivery` *(slice 14)* as
"Accepted / Delivered / Failed / Suppressed" per channel — **never the word "read"** (plan §0.13).

**New announcement** — `/announce/new`, online only (`create_announcement`, `preview_audience`,
`send_announcement` in `ONLINE_ONLY_ACTIONS`; the whole screen shows "Needs a connection" and a
disabled form when offline). A **short notice**: longer composition stays on the web (plan).

| Field | Rule |
|---|---|
| Title | 1–120 |
| Body | 1–2000; a counter; a hint at 160 characters "Longer than one SMS" when urgent |
| Urgent | toggle → `priority: 'urgent'` (WhatsApp + SMS legs by the slice-9 matrix) else `normal` |
| Category | `ANNOUNCEMENT_CATEGORIES`, default `general` |
| Audience — **reduced picker** | exactly one of: **Everyone** (`{ kind: 'everyone' }`), **Class** (`GET /classes?limit=50` → `{ kind: 'class', targetId, roles: ['parents','students'] }`), **Section** (class then `GET /classes/:id/sections?limit=50` → `{ kind: 'section', targetId, roles: [...] }`); a "Parents only" switch drops `students` from `roles`. No `student`, `guardian`, `staff`, `staff_member`, `parents`-only-school kinds on mobile |
| Schedule, expiry, attachment | not on mobile |

**Preview:** on every audience or priority change (debounced 600 ms, at most one in flight)
`POST /announcements/preview-audience { audiences, priority, body }` *(slice 14; 30/min per user)*
→ "Reaches `recipients.total` people (`guardians` parents, `students` students, `staff` staff) ·
SMS: `sms.units` units of `sms.remaining` left" — the plan's "with the SMS units it will spend". `429`
→ the preview line says "Counting paused — try again in n s" (`rateLimitMessage`); the Send button
still works (the server recounts).

**Send:** confirm sheet repeating the preview line → `POST /announcements` with an
`Idempotency-Key` generated **when the form opened** (`newIdempotencyKey()`, kept in component
state only — never in the outbox, never persisted) → `201 { id }` → `POST /announcements/:id/send`
→ `200` → back to the list, the new row `sending`/`sent`. Errors: `409 SMS_CAP_EXCEEDED details {
smsUnits, remaining, cap }` → "This needs `smsUnits` SMS units; `remaining` are left this month.
Send as normal (no SMS) or ask the platform to raise the cap." with a "Send without SMS" button
that re-creates as `normal` (a **new** key: a different body is not a replay); `409 SMS_TOO_LONG` →
"Shorten the message or send as normal"; `409 ANNOUNCEMENT_NO_RECIPIENTS` → shown; `409
IDEMPOTENCY_KEY_REUSED` (double tap after a crash) → the list refetches and the draft is opened;
`422` on `audiences[0].targetId` (`REFERENCE_NOT_FOUND`) → "That class or section is not available";
`403 audience_requires_school` cannot occur (the tab needs `.school`); a network failure **between
create and send** leaves a `draft` on the server: the list shows it with a **Send** action
(`POST /announcements/:id/send`, retry-safe: already sending/sent → `200`).

No names on Announce → not `secure`.

### 7.3 Inbox — `/inbox` and `/inbox/[id]` (everyone) — **align with slice-14 contract**

`GET /me/inbox?limit=25[&category]` *(slice 14; `-sentAt`)*: category chips (All, Holiday, Exam,
Fee, Event, General) as the one filter; rows: title, `sentAt` (relative today, date otherwise),
`priority = 'urgent'` badge, `viaStudents[].fullName` as small chips ("via Ali", "via Sara"), an
attachment marker. Expired items are not returned (R147). Tap → `/inbox/[id]`: title, body
(selectable text), category, sent time, "Open <child>" buttons for `viaStudents` (→
`/children/[studentId]/…` by `messageType`: attendance types → attendance, `diary_posted` → diary,
`remark_posted` → remarks), attachment through `Attachment.tsx` on tap
(`GET /me/inbox/:id/thumbnail` then `/attachment`; `404` → "no longer available"). Deep links from
pushes land here (§2). **Nothing is marked read** — there is no such field (R150, plan §0.13).
Empty state: "Nothing from the school yet."

**Secure:** yes when the user has `guardian` capacity (child names in `viaStudents`); the prop is
set from `me.capacities` at render.

---

## 8. Local domain tables — SQLite migration 2 (normative)

Appended to `MIGRATIONS` in `src/db/schema.ts` as entry 2 (never editing entry 1). Each row links to
its outbox row by `outbox_id`; a domain row and its outbox row are written in **one
`withExclusiveTransactionAsync`** through `enqueueIn` (slice-15 §7.1, plan §4.7). The outbox row's
`domain_table`/`domain_id` point back. `src/db/local.repository.ts` holds the only SQL on these
tables.

**`local_registers`**

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PK | `newIdempotencyKey()` |
| `section_id`, `date`, `period` | TEXT, TEXT, INTEGER NOT NULL; `UNIQUE (section_id, date, period)` | the natural key; mirrors the outbox natural key |
| `mode` | TEXT NOT NULL CHECK IN (`new`,`amend`) | pre-filled first submit, or a subset of changes |
| `reason` | TEXT NULL | |
| `outbox_id` | TEXT NULL | the pending/sending/done/failed row; NULL after the outbox row was purged |
| `server_register_id` | TEXT NULL | from `RegisterSubmitResultDto.register.id` on `done` |
| `saved_on_server_at` | TEXT NULL | the response `Date` on `done` — what the state line shows |
| `summary` | TEXT NULL | the response `summary` JSON (counts only) |
| `created_at`, `updated_at` | TEXT NOT NULL | |

**`local_marks`** — `local_register_id` (FK, cascade), `enrolment_id` TEXT, `status` TEXT CHECK IN
the four statuses, `note` TEXT NULL, `arrived_at` TEXT NULL; `UNIQUE (local_register_id,
enrolment_id)`. **No student id, no name.**

**`local_diary_entries`** — `id` PK, `section_id`, `date`, `subject_id`, `topic`, `assignment` NULL,
`learning_outcome` NULL, `due_on` NULL, `outbox_id` NULL, `server_id` NULL, `saved_on_server_at`
NULL, `state` CHECK IN (`queued`,`done`,`failed`,`superseded_by_server`,`discarded`), timestamps.

**`local_attachments`** — §4.5's columns; `local_entry_id` FK cascade; `file_path` relative to
`<documentDirectory>/outbox/`.

**`local_remarks`** — `id` PK, `student_id`, `date`, `category`, `text`, `visibility` NULL,
`subject_id` NULL, `outbox_id` NULL, `server_id` NULL, `saved_on_server_at` NULL, `state` as the
diary's minus `superseded_by_server`, timestamps. **The student id is the only identifier**; the
name is read from the roster cache when present.

**Lifecycle rules** (each a test in `db/local-tables.spec.ts`):

| Event | Effect on local rows |
|---|---|
| save | row + outbox row in one transaction; a failure in either leaves neither |
| outbox `done` | `server_*` and `saved_on_server_at` set; row kept **7 days** (shown "Saved on server" in lists until the server row is in the cache), then purged with the outbox row by `purgeFinished` |
| outbox `failed` | row kept with the outbox row (the list shows "Not saved: …"); purged together after 7 days |
| discard (sync sheet or screen) | outbox row deleted, local row `discarded` then deleted in the same transaction; an attachment file deleted |
| remedy (new pending row) | `outbox_id` repointed to the new row |
| `wipeAll()` | file deleted → everything gone; `outbox/` folder deleted; expo-image disk cache cleared |
| `wipeForSessionLoss()` | local rows whose outbox row is `pending`/`sending` are **kept**; rows whose outbox row was deleted (done/failed) are deleted; attachment files of deleted rows are deleted; `waiting` attachments of kept entries are kept |
| `discardExpiredUnsent()` (7-day window) | the kept rows go with their outbox rows; the notice names lanes and dates as in 15 |
| startup | `recoverStaleItems()` then `recoverWaitingAttachments()` |

---

## 9. Lanes — the four new rows (normative; `src/outbox/lanes.ts`)

`Lane` gains `sender: 'json' | 'diary_attachment'` and `domainTable: string | null`, and its
`method` widens from `'POST'` to `'POST' | 'PATCH'` (the attachment lane's final request is a
`PATCH`; `sendRaw` already takes any method). The table after 16:

| Lane | Method, path | Idempotency | Natural key | Body (ids only) | Sender | Domain table | Remedies on `failed` (per `response_code`) | Follow-up on `done` |
|---|---|---|---|---|---|---|---|---|
| `device_register` | `POST /api/v1/me/devices` | server-side | — | `{ platform, pushToken }` | json | — | none | store the token (15) |
| `submit_register` | `POST /api/v1/sections/:id/submit-register` | natural key + coalescing (`mergeMarksBody`) | `section:<id>\|date:<d>\|period:<n>` | `{ date, period, marks: [{ enrolmentId, status, note?, arrivedAt? }], reason? }` | json | `local_registers` | `AMENDMENT_REASON_REQUIRED` → **"Add a reason and resend"**: sheet lists `details.amendments` ("changed since you loaded"), the new pending row carries the reason (`remedyItem` with the new body) · `ROSTER_INCOMPLETE` → **"Reload and save again"**: refetch the view, merge local marks over it, missing enrolments pre-filled `present`, new pending row · `ATTENDANCE_LOCKED`, `NOT_A_TEACHING_DAY`, `CONCURRENT_UPDATE` (retry once automatically, then shown), `PERMISSION_DENIED`, `NOT_FOUND`, `REFERENCE_NOT_FOUND`, `INVALID_VALUE` → shown, **discard** | `server_register_id`, `saved_on_server_at`, `summary`; invalidate §3.1 keys |
| `diary_entry` | `POST /api/v1/sections/:id/diary-entries` | `Idempotency-Key` = outbox id | — | `{ date, subjectId, topic, assignment?, learningOutcome?, dueOn? }` — **never `stagedUploadId`** | json | `local_diary_entries` | `DIARY_ENTRY_EXISTS` → **"Open the existing entry"** (+ re-target or discard the waiting photo) · `SUBJECT_NOT_ASSIGNED`, `SUBJECT_ARCHIVED`, `SECTION_ARCHIVED`, `CLASS_ARCHIVED`, `ACADEMIC_YEAR_CLOSED`, `PERMISSION_DENIED`, `NOT_FOUND`, `VALIDATION_FAILED`/`INVALID_VALUE`/`REFERENCE_NOT_FOUND` → **"Edit and resend"** (new row, new key) or discard · `IDEMPOTENCY_KEY_REUSED` → shown, discard (cannot occur from one device) | `server_id`, `saved_on_server_at`; enqueue waiting attachments; invalidate |
| `remark` | `POST /api/v1/students/:id/remarks` | header | — | `{ date, category, text, visibility?, subjectId? }` | json | `local_remarks` | `STUDENT_NOT_ACTIVE`, `ACADEMIC_YEAR_CLOSED`, `PERMISSION_DENIED`, `NOT_FOUND` → shown, discard · `SUBJECT_ARCHIVED`, `422` codes → "Edit and resend" or discard | `server_id`; invalidate |
| `diary_attachment` | `PATCH /api/v1/diary-entries/:serverId` (after `POST /api/v1/uploads`) | retry-safe by state (slice-13 §3) | — | `{ localAttachmentId }` (the request body is built by the sender: multipart, then `{ stagedUploadId }`) | diary_attachment | `local_attachments` | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `ATTACHMENT_FILE_MISSING` → shown, discard · `DIARY_ENTRY_LOCKED`, `AMENDMENT_REASON_REQUIRED`, `PERMISSION_DENIED`, `NOT_FOUND` → shown, discard · `REFERENCE_NOT_FOUND` (second time) → **"Retry"** (new row; re-upload) | delete the file; invalidate the entry |

Lane labels in the sync sheet: "Register", "Diary entry", "Remark", "Diary photo", "Notification
registration". `lanes.spec.ts` asserts: five lanes; `submit_register` is the only coalescing lane;
`diary_entry` and `remark` are the only header lanes; `diary_attachment` is the only non-json
sender; every `ONLINE_ONLY_ACTIONS` entry is absent.

---

## 10. Outbox machine and worker — what 16 adds without a second queue

### 10.1 Sender dispatch

`runtime.ts` `sendItem(item)` becomes a dispatch on `laneOf(item.lane).sender`: `json` → the
existing `sendRaw` path unchanged; `diary_attachment` → `sendAttachment` (`src/outbox/attachment-sender.ts`,
§4.5). Both return an `Outcome`; **the pure machine (`machine.ts`) does not change** — no new state,
no new event. The `stale_token` rule, the terminal set `{403, 404, 409, 422}`, `401`/`426`, `429`
and backoff apply to the attachment lane exactly as to the others; the sender's two client-side
adjustments (upload `413`/`415` → terminal `422`; a first `REFERENCE_NOT_FOUND` → `network`) are
in the sender and table-tested there.

### 10.2 Coalescing — the register merge body

`coalesce.ts` already merges `marks[]` by `enrolmentId` and keeps the newer non-empty reason. 16
adds `mirrorMerge(txn, localRegisterId, body)`: after `enqueueIn` merges into an existing pending
row, `local_marks` is replaced from the merged body so the screen and the body never disagree
(`coalesce.spec.ts` extended: two offline edits of one register → one outbox row, one
`local_registers` row, `local_marks` equal to the merged body; an edit while `sending` → a second
pending row **and** the same `local_registers` row repointed to it, with `local_marks` showing the
latest intent).

### 10.3 Per-lane follow-ups

`WorkerDeps.onSaved` becomes a lookup `ON_SAVED[lane]` in `runtime.ts`: `device_register` →
`onDeviceRegistered` (15); `submit_register` → write `server_register_id`, `saved_on_server_at`,
`summary`, invalidate; `diary_entry` → write `server_id`, enqueue waiting attachments, invalidate;
`remark` → write `server_id`, invalidate; `diary_attachment` → delete the file, invalidate. Each
reads the response body it needs from the outcome: `Outcome` (response kind) gains an optional
`body: unknown` on `2xx`, parsed with zod inside the follow-up and ignored when malformed (the item
is still `done`: the server has it).

### 10.4 Worker

Unchanged: one in flight per lane, three lanes at once, oldest first. `worker.spec.ts` gains: a
`diary_attachment` item stuck in a 30-second upload does not delay a `submit_register` item queued
later; a `submit_register` terminal failure does not stop the next register in the lane.

---

## 11. Request layer additions (`src/api/client.ts` stays the only `fetch` caller)

| Export | Purpose |
|---|---|
| `sendMultipart(path, field, file: { uri, name, mime }, extraHeaders?)` | `POST` with `FormData` (React Native's file part: `{ uri, name, type }`), the same `applyHeaders`, the write timeout (30 s; a 5 MB upload on 2G may need it — a timeout is a network error and retries), `inspect` for `401`/`426`. Used by the attachment sender only |
| `authHeaders()` | `{ Authorization: 'Bearer …', 'X-App-Version': … , Accept: 'image/*' }` for `expo-image` sources and the PDF download in `files.ts`. The token never enters a URL (lint: a test asserts no string literal in `src/**` concatenates `Bearer` outside `client.ts`) |
| `downloadToCache(path)` | streams `GET` to `<cacheDirectory>/asms-<random>.<ext>` through `expo-file-system`'s download with `authHeaders()`; returns the file URI; the caller deletes it. In `src/media/files.ts`, which imports `authHeaders` and `apiUrl` only |

`api/client.spec.ts` gains: a multipart request carries the bearer and `X-App-Version`, no
`Content-Type: application/json`, no `Origin`, no cookie; `authHeaders()` never includes the token
when signed out.

---

## 12. Theme and components added once

`theme.ts`: the §3.3 status colours as `statusColors` and `statusTone(status | null, teachingDay?)`.
New components in `src/ui/`: `StatusChip` (48 × 48, label + colour), `AttendanceMonth`
(§5.2), `MonthHeader` (extracted from Calendar and reused there — the one refactor 16 makes to a
15 screen), `Attachment` (the `expo-image` door; thumbnail then full), `ReasonSheet` (reason
3–500 with the change list; used by the register and the amend action), `StateLine` (the outbox
state of a local row: device / sending / server at HH:MM / not saved), `SegmentedPicker` (status
in the amend sheet, visibility, category, audience kind), `DateSheet` (a list of the last 30 days,
no calendar widget), `RefreshableList` (`FlatList` + `RefreshControl` disabled offline + paging
footer). Nothing is built per screen that two screens need (code-quality at slice 17 checks).

---

## 13. Security

### 13.1 Lint doors — one importer per native capability (extends slice-15 §11)

| Module | Door |
|---|---|
| `expo-image` | `src/ui/Attachment.tsx` (already) |
| `expo-image-picker`, `expo-image-manipulator` | `src/media/picker.ts` |
| `expo-file-system` | `src/media/files.ts` |
| `expo-sharing` | `src/media/files.ts` |
| `expo-screen-capture` | `src/ui/Screen.tsx` |

`__tests__/boundaries.spec.ts` gains one `DOORS` row per module (refused in `src/app/fixture.tsx`
and `src/outbox/fixture.ts`, allowed at the door).

### 13.2 FLAG_SECURE — `Screen secure` (the wave-E security review's advice)

`Screen` gains `secure?: boolean`; when true it calls `usePreventScreenCapture()` from
`expo-screen-capture` (Android `FLAG_SECURE`: no screenshots, no recent-apps thumbnail, no screen
recording of the window). **Normative list of secure screens:** register (§4.2), students list and
student sheet (§4.6), children (§5.1), child attendance / diary / remarks (§5.2–5.4), student
attendance / diary / remarks (§5.5), inbox list and item when the user has `guardian` capacity
(§7.3). Not secure: home, my attendance, my classes, section diary list and compose, calendar,
account, today, announce, sign-in.

Test `ui/secure-screens.spec.ts`: reads every route file under `src/app/(tabs)/{classes,children,
student,inbox}/**` and asserts each renders `<Screen … secure` (or `secure={…capacities…}` for the
inbox), and that no route under `home/`, `today/`, `announce/`, `account/` does; a second test
renders `<Screen secure>` under RNTL with `expo-screen-capture` mocked and asserts
`preventScreenCaptureAsync` was called and `allowScreenCaptureAsync` on unmount.

### 13.3 Residue at rest

Added to the wipe rule (slice-15 §4.6, §7.6): `<documentDirectory>/outbox/` (photos) and
`expo-image`'s disk cache (`Image.clearDiskCache()`) are cleared by `wipeAll()`; on session loss the
image cache is cleared and only files of kept rows survive (§8). PDFs opened through the share sheet
are deleted after the sheet closes and, defensively, every `asms-*` file in the cache directory is
deleted at startup. `secure_delete` is already on for SQLite.

### 13.4 Bodies, logs, tokens

§3.4 (ids only, tested), §3.7 (dropped keys), §11 (the bearer in headers only; the
`authHeaders()` test). The announcement `Idempotency-Key` lives in component state only. The
preview-audience body carries ids and the text, no names. R165 holds by construction: the `/me/*`
DTOs the screens render have no note, no teacher id, no phone; the component tests snapshot the
rendered text of each parent screen against fixtures that **contain** a note and a phone in
unrelated staff DTOs and assert neither appears.

### 13.5 Review scope for the wave-F `security-reviewer`

Named for the reviewer: the attachment lane's file handling and headers; `sendMultipart`;
FLAG_SECURE coverage; the local tables under §7.6; the ids-only test; the cover sheet's staff list
(names and designations of staff shown to a principal — permitted by `staff.view`; no phone or
CNIC is rendered from `StaffDto`); the announcement flow's key handling and the create-then-send
gap; `expo-image` cache clearing.

---

## 14. Data cost — the scripted day, extended (R160)

`scripts/capture-fixtures.ts` gains the teacher's legs, captured against the classroom seed
(§15.3, **30 students**) as the teacher: `GET /sections/:id/register` × 3 (three dates or periods),
`POST /sections/:id/submit-register` × 3 (full roster, pre-filled present, two absent), `GET
/sections/:id/diary-entries` once, `POST /sections/:id/diary-entries` once (no photo), and — when
slice 14 lands — `GET /me/inbox` once. `__tests__/scripted-day.spec.ts` runs the whole day through
the real client and outbox (the register legs through the `submit_register` lane with coalescing
off the critical path: three distinct natural keys), asserts request count ≤ 60, no
`/thumbnail`/`/attachment` path, and **bytes < 50 KB**.

If the real recording exceeds 50 KB the task **fails and reports the number**; the two candidate
fixes are an API change (a brief submit response — slice-11 amendment through `api-designer`) or a
rule change (R160's figure — a plan amendment at slice 17). Neither is 16's to take; the budget is
not edited to pass (decision 5). The expected figure, from the DTO shapes: about 6.5 KB per register
view and 10 KB per submit round-trip at 30 students, so roughly 50 KB for the three registers alone
— the measurement decides, which is why the fixture roster is 30 and not 10.

**Measured and taken (2026-10-04):** the teacher's day recorded 56 KB against the 50 KB budget; the
full submit response (about 7.9 KB for 30 marks) was about 41% of it. The brief-response option was
taken: `POST /sections/:id/submit-register` honours `Prefer: return=minimal` (slice-11 §4.2,
amended), answering each mark as `{ id, enrolmentId, outcome }` with `Preference-Applied:
return=minimal`. The app's `submit_register` lane is to send the header (mobile side); the web sends none and is
unchanged. R160's figure is not edited.

---

## 15. Tests, flows, CI

### 15.1 Jest — must pass locally (no SDK, no emulator, no network)

All under `pnpm --filter @asms/mobile test`; RNTL suites render with `jest-expo` and the
`src/test/fake-api.ts` fake behind the real client; SQLite through `src/test/sqlite-adapter.ts`
(`node:sqlite`). `jest.setup.ts` gains mocks for `expo-image-picker`, `expo-image-manipulator`,
`expo-file-system` (an in-memory file map with `documentDirectory`/`cacheDirectory`), `expo-sharing`,
`expo-screen-capture` and `expo-image` (a `View` recording its `source`).

| Suite | Proves |
|---|---|
| `outbox/lanes.spec.ts` (ext.) | §9 table: five lanes, flags, labels, remedies keyed by code; `ONLINE_ONLY_ACTIONS` absent; `useOnlineOnly` wraps every direct `POST` in `src/app/**` |
| `outbox/bodies.spec.ts` | §3.4: each builder's key set equals the contract; no `/name/i` key; no identity or phone pattern; a note with 13 digits is refused before building |
| `outbox/coalesce.spec.ts` (ext.) | §10.2 mirror merge; sending → second pending row repointed |
| `outbox/attachment-sender.spec.ts` | §4.5: upload then PATCH; staged id reused within expiry; expired → re-upload; `413`/`415` → terminal `422`; first `REFERENCE_NOT_FOUND` → network, second → terminal; `DIARY_ENTRY_LOCKED` terminal; file missing → terminal; `401` pauses; file deleted on `done` |
| `outbox/follow-ups.spec.ts` | §10.3 per lane: server ids written, keys invalidated, waiting attachments enqueued exactly once, malformed body still `done` |
| `outbox/worker.spec.ts` (ext.) | §10.4 |
| `db/local-tables.spec.ts` | §8 lifecycle table, every row; same-transaction atomicity (a failing `enqueueIn` leaves no domain row); `wipeForSessionLoss` keeps and deletes exactly as stated; `recoverWaitingAttachments` idempotent |
| `attendance/register-screen.spec.tsx` (RNTL) | §4.2: pre-fill present; tap cycle order; long-press note and arrival; counts; Save offline → one outbox row + `local_registers` + "Saved on device"; a second edit coalesces; amend mode requires a reason and sends only changed rows; read-only modes (window closed, not a teaching day, viewer, `onRoster: false`); "Saved on server" appears **only** after the fake API's `201`; `AMENDMENT_REASON_REQUIRED` remedy produces a new pending row with the reason; after-401 nameless rendering; `secure` set |
| `attendance/amend-mark.spec.tsx` | §4.3 outcomes incl. `STALE_STATUS` reload; disabled offline; never enqueued |
| `attendance/attendance-month.spec.tsx` | §5.2: every `DayStatus` and `null` renders its word and chip; unrecorded vs non-teaching vs not enrolled; percentage line; `null` → "No recorded days yet"; period sheet text; no note or teacher field rendered from a fixture that has none; staff kind wording |
| `classes/my-classes.spec.tsx` | §4.1 grouping, roles, whole-class subject expansion, daily-mode subject-teacher disabled register, principal has no tab |
| `diary/compose.spec.tsx`, `diary/list.spec.tsx` | §4.4: subject source by role; key = outbox id; body shape; photo creates a `waiting` row in the same transaction; `DIARY_ENTRY_EXISTS` remedy re-targets the photo; local rows render with state lines |
| `remarks/compose.spec.tsx`, `remarks/student-sheet.spec.tsx` | §4.6: "School default" omits `visibility`; identity pattern refused; remedies; staff list shows `internal` |
| `children/children.spec.tsx`, `children/diary.spec.tsx`, `children/remarks.spec.tsx` | §5.1–5.4: cards with today's status and month line; "Left" badge; one request per child; attachment loads **only** on tap with the bearer in a header; PDF through the share sheet and deleted; superseded wording; R165 negative snapshot |
| `student/student.spec.tsx` | §5.5 bindings |
| `home/my-attendance.spec.tsx` | §6 |
| `today/today.spec.tsx`, `today/cover.spec.tsx` | §7.1: unrecorded rows and actions by capability; record-now route; cover sheet online-only, `coversAssignmentId` resolution, every error code's text |
| `announce/compose.spec.tsx`, `announce/list.spec.tsx`, `inbox/inbox.spec.tsx` (16b) | §7.2–7.3: reduced picker shapes; preview debounce and `429`; key generated once per open; `SMS_CAP_EXCEEDED` "send without SMS" uses a new key; create-then-send gap leaves a sendable draft; inbox chips, no "read" anywhere (a grep over `src/app/inbox/**` for the word), attachment on tap, deep-link buttons |
| `auth/screen-registry.spec.ts` | §2: registry = route folders on disk = `(tabs)/_layout.tsx` ROUTES |
| `push/routing.spec.ts` (ext.) | §2 table incl. the capacity-aware fallbacks |
| `ui/secure-screens.spec.ts` | §13.2 |
| `api/client.spec.ts` (ext.) | §11 |
| `platform/scrub.spec.ts` (ext.) | §3.7 keys |
| `__tests__/boundaries.spec.ts` (ext.) | §13.1 doors |
| `__tests__/scripted-day.spec.ts` (ext.) | §14 |

### 15.2 Maestro — CI only (this machine has no Android SDK, JDK or Maestro)

Flows live in `apps/mobile/maestro/flows/`, select by `testID`, and are run by `ci-run.sh` in this
order after the two slice-15 flows. Env from the job: `SCHOOL_CODE`, `PRINCIPAL_CNIC`,
`TEACHER_CNIC`, `GUARDIAN_CNIC` (each user's default password is their digits). Airplane mode is
Maestro's `setAirplaneMode` command; `ci-run.sh` toggles it with `adb shell cmd connectivity
airplane-mode enable|disable` **before** each flow as the stated fallback if the emulator ignores the
in-flow command (recorded by the first CI run).

| Flow | Steps | Asserts |
|---|---|---|
| `register-offline.yaml` (16a) | `launchApp clearState`; sign in as the teacher; `tabs.classes`; tap `classes.section.<id>.register`; wait for `register.roster`; **airplane mode on**; tap the first two rows' chips once each (present → absent); tap `register.save`; | `register.stateLine` text "Saved on device"; `sync.chip` visible; **airplane mode off**; `extendedWaitUntil` `register.stateLine` contains "Saved on server" (≤ 60 s). Then `ci-run.sh` signs in as the teacher over `curl` and asserts `GET /sections/:id/register?date=today&period=1` returns `register != null` with two `absent` marks — "the server has it" is checked outside the app |
| `teacher-diary.yaml` (16a) | same session; `tabs.classes` → section → Diary → New; subject; topic "Pages 12–14"; save | the entry appears with "Saved on device" then "Saved on server" (online); no photo step (the emulator has no camera; the photo path is Jest's) |
| `parent-child.yaml` (16a) | `ci-run.sh` first waits (≤ 90 s, polling as the guardian over `curl`) until `GET /me/children/:id/attendance` shows today's `status = absent` — the rollup job must have run; then `launchApp clearState`; sign in as the guardian; | `children.card.<studentId>` visible with text "Absent"; tap → `attendanceMonth.grid`; back; Diary → the seeded entry → `attachment.show` → `attachment.thumbnail` visible (the seeded PNG) — the parent "opens a diary attachment"; Remarks → `state.empty` or a row |
| `principal-today.yaml` (16b; 16a ships the Today-less version as `principal-record.yaml` that reaches the register through a deep link `asms://classes/<sectionB>/register`) | `launchApp clearState`; sign in as the principal; `tabs.today`; | `today.unrecorded.<sectionB>` visible with the class teacher's name; tap `today.recordNow.<sectionB>`; the register opens pre-filled; `register.save`; "Saved on server"; back → `today.unrecorded.<sectionB>` not visible |
| `principal-announce.yaml` (16b) | `tabs.announce` → New; title, body; audience Section → class → section A; | `announce.preview` contains "Reaches" and "SMS"; Send → confirm → the list shows the title with a status badge; Inbox as the guardian (a second sign-in in the same flow) shows the title |

Element ids are of the form `screen.element[.id]` as in 15 (`register.row.<enrolmentId>`,
`register.chip.<enrolmentId>`, `children.card.<studentId>`, `today.unrecorded.<sectionId>`).

### 15.3 The classroom seed — `apps/api/scripts/seed-dev-school.ts` (main-thread edit)

Behind `DEV_SCHOOL_CLASSROOM=1`, after the school and principal exist, idempotent (prints
`classroom created` or `classroom exists`), through the API's own services (never SQL):

| Creates | Detail |
|---|---|
| Academic year | "2026–27", active, covering today |
| Class "Class 5", mode `daily` | with sections **A** and **B** |
| Subject "English" | |
| Teacher | staff + login from `DEV_SCHOOL_TEACHER_CNIC` (+ `_PHONE`), role `teacher`; `class_teacher` of 5 A from today; `subject_teacher` English on 5 B |
| Students | **30** in 5 A (roll 1–30), **5** in 5 B; names from a fixed list; no B-Form (no student login) |
| Guardian | from `DEV_SCHOOL_GUARDIAN_CNIC` (+ `_PHONE`), `contact_capability = smartphone_data`, linked to 5 A roll 1 as `father`, `is_primary_contact`, `fee_payer`, `can_login`; login issued |
| Diary entry | 5 A, English, dated today, topic "Reading: chapter 3", with a **64 × 64 PNG** generated in the script (`sharp`) staged through the uploads service as the teacher and consumed by the diary service — needs object storage reachable |
| Nothing else | no register (5 A and 5 B must be unrecorded for the flows), no remark, no announcement |

`seed-dev-guard.ts` admits the CI numbers `3520299999992` (teacher) and `3520299999993` (guardian)
under the same loopback-only rule as the principal's. The README's "Mobile app" section documents
the flag.

### 15.4 CI `mobile` job changes (main thread)

- **MinIO** started as in the `ci` job (same Chainguard image and digest, same health wait),
  before the seed. Without it the seed's attachment step and the parent flow's thumbnail fail.
- **The worker** started beside the API: `node apps/api/dist/worker.js` (the build already emits
  it), with `WORKER_HEALTH_PORT=3002` and a health wait on `http://127.0.0.1:3002/`; restarted by
  `ci-run.sh` together with the API when `MOBILE_MIN_APP_VERSION` changes. Without it no
  `attendance_day_status` row is ever written and the parent card never says "Absent".
- Env: `DEV_SCHOOL_CLASSROOM=1`, `DEV_SCHOOL_TEACHER_CNIC`, `DEV_SCHOOL_TEACHER_PHONE`,
  `DEV_SCHOOL_GUARDIAN_CNIC`, `DEV_SCHOOL_GUARDIAN_PHONE`, `TEACHER_CNIC`, `GUARDIAN_CNIC`.
- `ci-run.sh`: the new flows in §15.2's order, the airplane-mode fallback, the `curl` checks, the
  rollup wait; artefacts unchanged. `timeout-minutes` raised to 60 (five more flows).

### 15.5 What must pass locally before a commit

`pnpm --filter @asms/shared build` · `pnpm --filter @asms/mobile lint` · `typecheck` · `test` ·
`expo export --platform android` · `expo-doctor` · the hook dry run · `pnpm --filter @asms/api
build` and `pnpm --filter @asms/api test -- seed` for the seed's unit test (the classroom fixture
against the test database, asserting idempotency and that no identity number is printed). The
Maestro flows and the CI job are **not** a local gate; the first green `mobile` run is the proof
and is recorded in WORKLOG.

---

## 16. Build sequence (half-day tasks; each is demonstrable)

**16.1 — Local tables, lanes, bodies, follow-ups (1 day)**
Goal: the three offline writes exist as lanes with local rows, provable without a screen.
Requirements: slice 15 as built. Dependencies: none. Tasks: migration 2 (§8), `local.repository.ts`,
lanes table rows and `sender`/`domainTable` (§9), `bodies.ts` builders, `ON_SAVED` follow-ups and
`Outcome.body` (§10.3), `mirrorMerge` (§10.2), `wipeForSessionLoss`/`purgeFinished`/`discard` rules
for local rows, `recoverWaitingAttachments` stub, scrub keys, new `ONLINE_ONLY_ACTIONS`. Expected
result: a Jest-driven register body enqueued with coalescing lands on the fake API and its local
row says "saved on server" with the server id. Tests: `lanes`, `bodies`, `coalesce`, `follow-ups`,
`local-tables`, `scrub` (ext.). Acceptance: **pass** if every §8 lifecycle row and every §9 row has
a named passing test and `pnpm -r lint typecheck test` is green; **fail** if any outbox body can be
built with a name key or if `machine.ts` changed.

**16.2 — Register screen, amend, my classes (1.5 days)**
Goal: a teacher marks a register offline and sees honest states. Requirements: 16.1. Tasks: §4.1,
§4.2, §4.3; `StatusChip`, `ReasonSheet`, `StateLine`, `DateSheet`, `RefreshableList`; theme status
colours; `Screen secure` and the `expo-screen-capture` door; registry `classes`; `(tabs)/classes/**`
routes. Expected result: in a dev build with the API stopped, a register saved shows "Saved on
device"; starting the API turns it into "Saved on server at HH:MM" within one backoff step (recorded
as a screen capture if a device exists, else by the RNTL suite). Tests: `register-screen`,
`amend-mark`, `my-classes`, `secure-screens`, `screen-registry`, `boundaries` (ext.). Acceptance:
**pass** if "Saved on server" cannot be rendered in any test before the fake API's `2xx`, the
pre-fill/tap-cycle/reason rules hold, and the after-401 render shows no name.

**16.3 — Diary entry, photo lane, remark, student sheet (1.5 days)**
Goal: the two header lanes work end to end, the photo in its own lane. Requirements: 16.2.
Tasks: §4.4, §4.5 (picker, files, attachment sender, `sendMultipart`), §4.6; doors for picker,
file system, sharing; `recoverWaitingAttachments` real. Expected result: a diary entry with a photo
saved offline becomes, online, an entry on the server and then an attachment on it, with the text
reaching the server first. Tests: `attachment-sender`, `diary/*`, `remarks/*`, `api/client` (ext.),
`worker` (ext.). Acceptance: **pass** if the attachment lane's every §4.5 outcome has a test, a
slow attachment never delays a register in `worker.spec.ts`, and the file is gone after `done`,
discard and wipe.

**16.4 — Parent, student and staff read screens (1.5 days)**
Goal: a parent sees each child's day, month, diary and remarks; a student their own; staff their
attendance. Requirements: 16.1 (cache keys), 16.2 (components). Tasks: `AttendanceMonth`,
`MonthHeader` refactor of Calendar, `Attachment.tsx`, §5.1–5.5, §6, Home folder, registry
`children`/`student`, `authHeaders`, `downloadToCache`, image-cache clearing in the wipes. Expected
result: with the API stopped, Children shows cached cards with "as of"; online, a thumbnail loads
only on tap. Tests: `attendance-month`, `children/*`, `student`, `home/my-attendance`, `client`
(ext.). Acceptance: **pass** if no image request occurs in any test before a tap, R165's negative
snapshots hold, and every parent screen is `secure`.

**16.5 — Data cost and the classroom seed (1 day; the seed is a main-thread edit)**
Goal: R160 measured on a real roster; the fixtures CI needs exist. Requirements: 16.2, 16.3;
the API's services. Tasks: §15.3 seed and guard; capture the teacher legs (§14); extend
`scripted-day.spec.ts`; README. Expected result: the scripted day's byte count is a number in the
build report. Tests: `scripted-day`, the seed's API-side test. Acceptance: **pass** if the day is
< 50 KB and the seed is idempotent; **fail and report** (do not raise the budget) if ≥ 50 KB.

**16.6 — Maestro flows and the CI job for 16a (0.5 day + the first CI run)**
Goal: the emulator proves the offline register and the parent's view. Requirements: 16.2–16.5.
Tasks: §15.2 flows (16a set, `principal-record.yaml` deep-link variant), §15.4 job changes
(MinIO, worker, env, `ci-run.sh`). Expected result: the `mobile` job green on the 16a commit.
Acceptance: **pass** if `register-offline`, `teacher-diary`, `parent-child` and `principal-record`
pass in CI with the `curl` proof that the server holds the register; the airplane-mode mechanism
that worked is recorded in WORKLOG.

**16.7 — 16b: inbox, today, announce (2 days) — starts only after `contracts/slice-14.md` and its `school.json` are committed**
Goal: the principal's day and the everyone-inbox. Requirements: slice 14 built; 16.4. Tasks: §7.1
(Today needs no slice-14 route and may be built earlier as a sub-task once 16.2 is done; its
`register_deadline` route too), §7.2, §7.3, registry `inbox`/`today`/`announce`, routing table
rows, `principal-today.yaml`, `principal-announce.yaml`, the inbox leg of the scripted day, the
inbox step of `parent-child.yaml`. Expected result: an unrecorded section recorded from Today
disappears from the list; a short notice shows its SMS units before send and appears in a parent's
inbox. Tests: `today/*`, `announce/*`, `inbox/*`, `routing` (ext.), `scripted-day` (ext.).
Acceptance: **pass** if every slice-14 shape used here matches the committed contract (a typecheck
against the regenerated `school.d.ts`), no screen uses the word "read", the announcement key is
generated once per form open and never persisted, and both principal flows pass in CI.

**16.8 — Wave-F review and close (0.5 day + review)**
`security-reviewer` on §13.5's list; the combined correctness-and-quality review (one component
per concern; no duplicated screens between child and student); `test-engineer` on R155–R162,
R165, R166 (16's parts). WORKLOG: versions of the five new modules, the byte figure, the
airplane-mode mechanism, the first device run if any. Acceptance: every high or critical finding
fixed with a proving test; the `mobile` job green on the final wave-F commit.

Phase gate for the slice: implemented → tested → security-reviewed → audited → no critical bug,
per `CLAUDE.md`; a FAIL at any step returns the slice.

---

## 17. Blockers and environment findings (2026-10-04)

1. **`contracts/slice-14.md` does not exist.** 16b (§7.2, §7.3 and the inbox parts of §2, §14,
   §15.2) is specified against the plan's slice-14 table and marked; task 16.7 cannot start until
   the contract and the regenerated OpenAPI document are committed. 16a does not wait.
2. **No Android SDK, JDK or Maestro on this machine** (unchanged from slice 15). The app has never
   run on a device; CI's `mobile` job is the first run of every flow. Everything in §15.5 runs here.
3. **The CI `mobile` job has no object storage and no worker today.** Both are needed by the
   parent flow (§15.4). Without the worker the derived day status is never materialised, so the
   child card cannot say "Absent".
4. **The seed creates only a principal.** The classroom fixture (§15.3) is new API-side work and a
   shared-file edit under the wave process.
5. **R160's 50 KB may not survive a 30-student roster** (§14). Measured, reported, not edited.
6. **Firebase still pending**; deep links are proven by unit test only.
7. **Maestro's `setAirplaneMode`** may be ignored by the emulator image; the `adb` fallback is
   stated and the working mechanism is recorded after the first run.
8. **No owner decision blocks 16a.**

---

## Decisions made here

1. **The photo is attached after the entry** through its own lane (upload + `PATCH`), enqueued when
   the entry is `done`; the entry's body never carries `stagedUploadId`. A `waiting` photo survives
   with its pending entry and is recovered at startup.
2. **The register's save path is always `submit-register`** (offline, coalesced, reason on
   amendment); the per-mark `amend` route is the online row action with `fromStatus`.
3. **A new register is pre-filled `present`**; a register never opened online cannot be marked
   offline (the roster is unknown); only changed rows are sent in amend mode.
4. **`Screen secure`** (`expo-screen-capture`) on the normative list of screens with children's
   names; a test enforces the list by route folder.
5. **The 50 KB budget is measured against 30 students and not edited** by this slice; an overrun is
   reported to the main thread with the two candidate fixes.
6. **Local domain tables** (`local_registers`, `local_marks`, `local_diary_entries`,
   `local_attachments`, `local_remarks`) are written in the outbox row's transaction, hold ids only,
   follow the outbox row through `done`/`failed`/discard/purge, and survive a `401` exactly when
   their outbox row does.
7. **The attachment sender maps upload `413`/`415` to a terminal `422`** and treats a first
   `REFERENCE_NOT_FOUND` on the PATCH as a network outcome (re-upload once); the pure machine is
   unchanged — the adjustments live in the lane's sender and are table-tested there.
8. **Photos are downscaled on the device** (1600 px, JPEG 0.8, no EXIF), stored under the app's
   private `outbox/` folder, never in the camera roll, deleted on `done`, discard and wipe;
   `expo-image`'s disk cache is cleared on every wipe and session loss; opened PDFs are deleted after
   the share sheet.
9. **The reduced audience picker** offers everyone, class and section (parents and students, or
   parents only); everything else stays on the web. The announcement `Idempotency-Key` is generated
   at form open and lives in component state; a changed body (send-without-SMS) is a new key.
10. **Visibility on a mobile remark defaults to "School default"** (field omitted) because the app
    cannot read `school_settings`; the server applies the owner's default.
11. **The staff "My attendance" card is on Home**, not a tab (slice-15 §5); the child, student and
    staff month views are one `AttendanceMonth` component with a `kind`.
12. **`routeForNotification` becomes capacity-aware** (a third argument, the user's tabs) so a push
    never opens a tab the user does not have; `register_deadline` → Today, `teacher_assignment` →
    Classes, child-linked types → the inbox item (16b) with "Open <child>" buttons, interim
    fallbacks in 16a.
13. **The classroom seed, MinIO and the worker join the CI `mobile` job**; the server-side proof of
    an offline register is a `curl` from `ci-run.sh`, not an app assertion.
14. **`/me` capability-source data is deferred**: a grant-holding teacher without assignments uses
    the web in Phase 2; recorded for slice 17 / Phase 3.
15. **No arrivals, no staff-attendance marking, no remark correction, no diary text edit on
    mobile** in Phase 2 — each is a web action and is listed as out of scope rather than half-built.
