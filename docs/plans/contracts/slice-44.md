# Slice 44 contracts — biometric staff attendance and disputes

**Author:** Opus 5.5 (wave T), 2026-10-14. **Binds:** `apps/api/src/modules/staff-attendance/**`
(the device-punch service, the punch intake, the device token rotation, the disputes),
`repositories/device-punch.repository.ts`, `repositories/attendance-dispute.repository.ts`, the
`deviceTokenRotatedAt` / `staffLateAfter` fields of the school settings, `deviceUserId` on the staff
record, the Disputes section of `GET /me/approvals`; the web settings card, staff edit field,
`/staff-attendance/punches`, `/staff-attendance/disputes`, the dispute action on `/my-attendance`;
the phone's Approvals Disputes section and the staff member's own attendance. **Source:**
`phase-5-extended.md` rule 40, §1.1 (rule 40 rows), §1.3 A11, §3.1 "Exception 4 widened", §3.2
"Biometric", §3.4, §3.6, §5 slice 44, §5.1 throttles, §7.1 "Device punches", R344–R348; migrations
`20261009120100_phase5_groundwork` and `20261014120100_wave_t_transport_biometric`; the carried note
in `contracts/slice-37.md` §9. Everything not restated follows the Phase 1–4 conventions (envelope,
string ids, `PageQueryDto` ≤ 50, `NoQueryDto`, `@ApiErrors()`, `404` outside the school or the
caller's own rows, `Idempotency-Key` on creates with replay `200` + `Idempotency-Replayed`, no
`DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `POST /school/device-token/rotate` | `school.settings.manage`, `@DefaultPasswordInert('device_token.rotate')` | no body → `200 DeviceTokenDto { token, rotatedAt }`; the token is shown once (§2.1) |
| `POST /school/device-token/revoke` | `school.settings.manage`, `@DefaultPasswordInert('device_token.revoke')` | no body → `200 DeviceTokenRevokedDto { revoked }` — "Turn off device" (§2.1; fix round, security LOW-2) |
| `POST /device-punches` | `@DeviceToken()` | `DevicePunchBatchDto` → always `200 DevicePunchBatchResultDto` (§2.2); OpenAPI tag `device`, bearer security |
| `PATCH /staff/:id/device-user` | `attendance.staff.manage` | `{ deviceUserId: string \| null }` → `200 StaffDeviceUserDto` (§2.3) |
| `GET /device-punches?date&staffId&unmapped` | `attendance.staff.manage` | page of `DevicePunchDto`, sort `punchedAt` (§2.4) |
| `POST /me/staff/attendance-disputes` + key | staff | `RaiseDisputeDto` → `201 AttendanceDisputeDto` (§2.5), endpoint `attendance_disputes`, path id the mark |
| `GET /me/staff/attendance-disputes?status` | staff | page of the caller's own, `-createdAt` |
| `POST /me/staff/attendance-disputes/:id/withdraw` | staff | no body → `200 AttendanceDisputeDto` |
| `GET /staff-attendance-disputes?status&staffId` | `attendance.staff.manage` | page, `-createdAt` |
| `POST /staff-attendance-disputes/:id/approve` | `attendance.staff.manage` | `{ reason? }` → `200 AttendanceDisputeDto` (§2.6) |
| `POST /staff-attendance-disputes/:id/reject` | `attendance.staff.manage` | `ReasonDto` → `200 AttendanceDisputeDto` |
| `GET /me/approvals` (existing) | staff | gains `disputes?` for `attendance.staff.manage` holders (R347) |
| `GET /school/settings`, `PATCH` (existing) | existing | gain `deviceTokenRotatedAt` (read-only) and `staffLateAfter` (`HH:MM` or null) |
| `GET /staff-attendance` (existing) | existing | `StaffDayDto` gains `disputeId`, `disputeStatus`, `punch`, `punchConflict` (§2.7) |
| `GET /me/staff/attendance`, `GET /staff/:id/attendance` (existing) | existing | each day gains `markId`, `source`, `disputeId`, `disputeStatus` |

Throttles: the punch route `device-punches` **600 an hour per school**, counted after the token
resolves, and a **per-IP bad-token bucket**: 10 refused tokens from one address within a minute lock
that address out of the route for 15 minutes (`429 RATE_LIMITED` with `Retry-After`), checked
before the token is read, so a locked address learns nothing more. Dispute writes (raise,
withdraw, approve, reject) `dispute-writes` 20/min, 120/h per user; `/me/*` reads also `me-reads`;
rotation and the device user id share `device-admin` 10/min, 60/h per user.

### DTOs

- `DeviceTokenDto { token, rotatedAt }` — `token` is 43 base64url characters (32 random bytes);
  only its sha-256 is stored (`schools.device_token_hash`).
- `DevicePunchBatchDto { punches: DevicePunchInDto[1..500] }`, `DevicePunchInDto { deviceUserId
  (1–40 printable ASCII, no spaces), punchedAt (ISO 8601 instant with offset), direction?: in | out }`.
- `DevicePunchBatchResultDto { results: [{ deviceUserId, punchedAt, outcome, staffAttendanceId |
  null }] }` in request order; `outcome` ∈ `marked | stored | unmapped | duplicate | inactive |
  rejected` (deviation 1). **No name, no staff id** is ever returned to the device.
- `StaffDeviceUserDto { staffId, deviceUserId | null }`; `StaffDto` gains `deviceUserId`.
- `DevicePunchDto { id, deviceUserId, staffId | null, staffName | null, punchedAt, direction |
  null, outcome, receivedAt, staffAttendanceId | null }`.
- `RaiseDisputeDto { attendanceId, requestedStatus, reason (@Reason 3–500) }`.
- `AttendanceDisputeDto { id, attendanceId, staffId, staffName, date, markStatus, markSource,
  requestedStatus, reason, status, createdAt, decidedByName | null, decidedAt | null,
  decisionReason | null, withdrawnAt | null }` — `markStatus` is the mark's status now.
- `ApproveDisputeDto { reason? }` (@Reason when present).

## 2. Behaviour

### 2.1 Rotation (R344)

`newSessionToken()` makes the token and its hash; `OwnSchoolRepository.setDeviceToken(schoolId,
hash, now)` writes both columns (predicate `id = schoolId`). The previous token stops working at
commit (its hash is gone; the lookup is by hash). Audit `device_token.rotated { first }` (subject
the school). The token is never logged, never audited, never returned again;
`SchoolSettingsDto.deviceTokenRotatedAt` says whether one exists. Rule 24: inert on a default
password (`403 DEFAULT_PASSWORD_BLOCKS_ACTION` after the capability check).

**Revoke** (fix round): `OwnSchoolRepository.clearDeviceToken` nulls `device_token_hash` and
`device_token_rotated_at` (predicate `id = schoolId` and a hash set); at commit the token answers the
same `401 DEVICE_TOKEN_INVALID` as any unknown one. Audit `device_token.revoked` (subject the school, no
metadata) when a token was set; with none, `{ revoked: false }` and nothing is written. Same key, same
throttle and the same rule-24 marker as the rotation.

### 2.2 Punch intake (R345, R348, A11)

`RouteAccessGuard` calls `DevicePunchService.authorise`: the per-IP lock is checked first; then the
bearer token (exactly `Authorization: Bearer <43>`, no cookie, no `Origin`) is hashed and looked up;
missing, malformed, unknown, rotated-out, or a terminated school are all the same `401
DEVICE_TOKEN_INVALID` with no detail, and each counts one failure against the address; then the
school's hourly bucket is charged. The handler takes the school only from `@CurrentDevice()`.

`PunchIntakeService.receive(schoolId, punches)` — one transaction (retried once on
`staff_attendance_natural_key`, a manual mark landing in the same instant):

1. `now` is the receipt time. A punch outside `now − 7 days … now + 5 minutes`, or whose device
   user id has the shape of an identity number, is `rejected`: never stored.
2. The school's time zone and `staff_late_after`; the staff currently holding each device user id
   (`staff.device_user_id`, A11: the mapping at receipt); existing replay keys; the marks already
   recorded for those staff on the punches' school days; the staff calendar over those days.
3. In `punchedAt` order (request order breaking ties): a key seen before (stored, or earlier in
   this batch) is `duplicate`; no holder → `unmapped`; holder not `active` → `inactive`; else
   `marked` when the school day is a staff working day (R136), the holder had joined by it, no mark
   exists for that day and no earlier punch of this batch marked it — with `markFromPunch(
   punchedAt, staff_late_after, tz)` (`late` strictly after the setting, else `present`); otherwise
   `stored`.
4. `device_punches` rows are inserted with `ON CONFLICT DO NOTHING` (`createManyAndReturn` +
   `skipDuplicates`); a row the database did not return lost a replay race and is `duplicate`.
   Then, for each `marked` punch, the mark: `source = 'device'`, `marked_by` null,
   `device_punch_id`, `date` = the punch's school day (the wave T trigger checks the day and the
   outcome). A punch never amends an existing mark.
5. Audit: one `device_punch.rejected { count, job: 'device' }` row (no actor, subject the school)
   when any punch was rejected. Marks are not audited row by row: the punch row is their record.

### 2.3 Device user id (A11)

`attendance.staff.manage`; never one's own record (`409 SELF_ACTION_FORBIDDEN { reason:
own_attendance }`); any staff status (a left member keeps theirs until cleared); the id held by
another staff member → `422 VALIDATION_FAILED` on `deviceUserId` (`INVALID_VALUE`, "already used by
another staff member"); a race loser lands on the unique (`409 CONCURRENT_UPDATE`). Unchanged is a
`200` with no audit. Audit `staff.device_user_set { staffId, from, to }`. A later mapping does not
repair old punches.

### 2.4 The punches day view

`date` (required, a school day, not in the future) selects `punched_at` in that day in the
school's time zone; `staffId` narrows to one member; `unmapped=true` to unmapped punches. Sorted by
`punchedAt`, then id.

### 2.5 Raise and withdraw (R346)

Raise: the mark must be the caller's own (`422 VALIDATION_FAILED`, `REFERENCE_NOT_FOUND` on
`attendanceId` otherwise, another school's included: the id is a body reference); a pending
dispute on it → `409 ATTENDANCE_DISPUTE_PENDING_EXISTS { disputeId }`; `requestedStatus` equal to
the mark's status → `422` on `requestedStatus`. Insert (`raised_by` the caller, the trigger
re-checks it is the staff member's own login); audit `attendance_dispute.raised { attendanceId,
date, from, to }`; `attendance_disputed { staffName, date }` to every other active
`attendance.staff.manage` holder (in-app, push title-only, email; never SMS). Withdraw: own and
pending (`409 ATTENDANCE_DISPUTE_NOT_PENDING { disputeId, status }` otherwise); audit
`attendance_dispute.withdrawn`.

### 2.6 Decide (R346)

Lock the dispute (`readLocked`); not pending → `409 ATTENDANCE_DISPUTE_NOT_PENDING`; the decider's
own → `409 SELF_ACTION_FORBIDDEN { reason: own_attendance }` (also the database trigger; no
sole-principal exception: another holder decides, or it waits). **Approve** amends the mark
through `StaffAttendanceService.amend` with `fromStatus` = the mark's current status (read under
its lock, so it never goes stale), `status` = the requested one and the dispute's reason as the
change reason (the history row and `staff_attendance_mark.amended` with `disputeId`); when the mark
already holds the requested status it is a no-op approval (no amendment, `amended: false`).
Audit `attendance_dispute.approved { amended, from, to }`. **Reject** needs a reason; audit
`attendance_dispute.rejected`. Both send `attendance_dispute_decided { date, decision }` to the
staff member.

### 2.7 Day views

`StaffDayDto`: `disputeId`/`disputeStatus` of the mark's latest dispute (pending first); `punch {
firstPunchAt, count } | null` (the member's punches of that school day, any outcome); and
`punchConflict` — a mark exists, a punch exists and the mark's status differs from what the first
punch would have marked (`markFromPunch`, today's setting), so an office "absent" beside a punch
reads as a conflict. History days (`/me/staff/attendance`, `/staff/:id/attendance`) gain `markId`,
`source` and the dispute pair, so the staff member can dispute a day.

## 3. Errors and constraint mappings

Reused from wave T (`constraints-phase5.ts`): `staff_attendance_disputes_pending_key` →
`ATTENDANCE_DISPUTE_PENDING_EXISTS`; `…_status_transition` → `ATTENDANCE_DISPUTE_NOT_PENDING`;
`…_not_self` → `SELF_ACTION_FORBIDDEN own_attendance`; `device_punches_replay_key` and
`staff_attendance_device_punch_id_key` → `CONCURRENT_UPDATE` (the service answers `duplicate`
first). The service checks first in every case.

## 4. Audit (R57)

`device_token.rotated`, `device_token.revoked`, `device_punch.rejected` (no actor, `job: 'device'`, subject the school),
`staff.device_user_set`, `attendance_dispute.raised|withdrawn|approved|rejected`, and the existing
`staff_attendance_mark.amended` (with `disputeId`) on an approval that changes the mark.

## 5. Lint

`DevicePunchRepository` and `AttendanceDisputeRepository` are importable only from
`src/modules/staff-attendance/**` (and their test suites). `device-punch.service.ts` stays the
named-exception site and imports no tenant repository: it resolves the token, enforces the
throttles and binds the school; `PunchIntakeService` does the tenant work from the handler.

## 6. Web and phone

Web: **Settings → Biometric device** card (`school.settings.manage`): whether a token exists and
when it was rotated, **Rotate** (confirm; the new token shown once with a copy button; greyed with a
note on a default password), **Turn off device** (shown while a token is set; confirm; greyed the same
way), and **Staff late after**. **Staff edit**: "Device user id"
(`attendance.staff.manage`, not on one's own record). **Staff attendance → Punches** (day view,
unmapped filter) and **Disputes** (queue, approve with optional reason, reject with reason); the day
sheet shows a punch time beside a mark and a "Conflict" badge. **My attendance**: "Dispute" on a
marked day, a dialog (requested status, reason), the dispute status, and **Withdraw**. Approvals
nav entry also for `attendance.staff.manage`. Phone: Approvals gains **Disputes** (approve/reject,
online-only); the staff member's own attendance gains **Dispute** (online-only).

## 7. Deviations from the plan

1. **`rejected` per-punch outcome.** §7.1 audits `device_punch.rejected (count)` but the outcome
   list had no value for a punch outside the window. A punch outside −7 days … +5 minutes (or
   whose device user id is shaped like an identity number) answers `rejected` and is not stored, so
   one bad clock cannot make the device agent resend a whole batch forever ("always 200").
   `PUNCH_RESULT_OUTCOMES` gains it (a response value, not a stored one). A malformed body (not
   JSON, > 500 punches, a device user id with spaces) is still `422`.
2. **`PATCH /staff/:id/device-user`** instead of `PATCH /staff/:id { deviceUserId }`: the existing
   `PATCH /staff/:id` is guarded by `staff.update`; one route cannot carry two keys for two fields.
3. **History days gain `markId` and `source`**: a staff member cannot dispute a mark without its id.
4. **"First punch of the day"** is enforced as "no mark exists yet for that day": a punch that
   arrives after a later punch already marked the day is stored, never re-marks (a punch never
   amends a mark, §7.1).
5. **`punchConflict`** is defined in §2.7 (the plan said only "shown as a conflict").
6. **`attendance_disputed` excludes the disputer** even when they hold `attendance.staff.manage`.
7. The per-IP lockout is 15 minutes after 10 refused tokens within a minute (the plan: "10/min with
   lockout", no duration). `RedisLockout`'s policy gains an optional `windowMs` (the failure
   count's lifetime, default the lock's), so the count lapses after a minute while the lock lasts 15.
8. **A request with no `Authorization` header at all** is refused before the device route by the
   existing Origin check (`403 ORIGIN_REJECTED`, R65: a school non-GET with neither
   `Authorization` nor `X-App-Version` must carry the app's Origin). Every request that presents
   a credential gets the one `401 DEVICE_TOKEN_INVALID`, so unknown and rotated stay
   indistinguishable.
9. **The app-version floor (R161) exempts `POST /device-punches`** when no `X-App-Version` is sent
   (`src/common/http.ts`): a device sends a bearer token but is not the mobile app.
