# Slice 5 contracts — guardians

**Author:** api-designer, 2026-10-03. **Binds:** `apps/api/src/modules/guardians/**`,
`apps/web/app/(school)/guardians/**`. **Sources:** `CLAUDE.md` (rules 2, 9, 12, 17; market
constraints), plan §3.6, §3.9, §4 slice 5, §5 slice 5, R12, R14, R16, R21, R22, R27, R31, R32, R77.
Everything not restated follows §3.9 and `slice-1.md`. Access decorators, `normalisePhone`,
`normaliseIdentityDigits`, `identityHash`, `maskIdentityNumber` and `UserDto` are those of
`slice-2.md` (§1, §2, §5). Paths are under `/api/v1`.

---

## 1. Access

| Route | Decorator |
|---|---|
| `GET /guardians`, `GET /guardians/:id`, `GET /guardians/:id/students`, `POST /guardians`, `PATCH /guardians/:id` | `@RequireCapability(Capability.GUARDIAN_MANAGE)` |
| `POST /guardians/lookup` | `@RequireCapability(Capability.STUDENT_CREATE, Capability.GUARDIAN_MANAGE)` (any of) |
| `POST /guardians/:id/issue-login` | `@RequireCapability(Capability.USER_ACCOUNT_MANAGE)` |

Guardian rows are not scoped by section: only principal and office defaults (scope `all`) hold
these keys. A teacher's view of guardians is through `GET /students/:id/guardian-links` in slice 6.

Common errors: `401` · `403 PERMISSION_DENIED` · `403 SCHOOL_SUSPENDED` (writes) · `403
ORIGIN_REJECTED` · `429`. Unknown, malformed or another school's id → `404 NOT_FOUND`.

---

## 2. Shapes

`ContactCapability` enum (rule 17; no "unknown"): `whatsapp | smartphone_data | keypad`.
`GuardianStatus` enum: `active | merged`.

`GuardianDto` (list and lookup):

| Field | Type |
|---|---|
| `id` | string |
| `fullName` | string |
| `cnicMasked` | string \| null — `35201-*****-1`; never the digits, in any response |
| `hasCnic` | boolean |
| `phone` | string \| null — E.164 |
| `hasPhone` | boolean |
| `contactCapability` | `ContactCapability` |
| `status` | `GuardianStatus` |
| `mergedIntoId` | string \| null |
| `userId` | string \| null — the login, if any (`users.guardian_id`) |
| `createdAt`, `updatedAt` | datetime |

`GuardianDetailDto` = `GuardianDto` + `email` (string | null) + `address` (string | null).

`hasCnic` / `hasPhone` back the list flags "no CNIC" and "no phone". A guardian with neither is
recordable (R27) but cannot get a login and is never found by lookup.

---

## 3. Endpoints

### 3.1 `GET /guardians` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `status` | optional `GuardianStatus`; absent = all (the web sends `active`) |
| `contactCapability` | optional enum |
| `hasCnic`, `hasPhone`, `hasLogin` | optional `true|false` |
| `q` | 2–100; any run of 13 digits (dashed or not) → `422` with message pointing at `POST /guardians/lookup`. Matches `full_name ILIKE '%q%'`; if `q` is 4–12 digits after stripping `+ -` and spaces, also `phone LIKE '%digits%'` |
| `sort` | `fullName` (default), `-fullName`, `createdAt`, `-createdAt`; `id` tiebreak |

**200** `{ data: GuardianDto[], page, limit, total }`.

### 3.2 `GET /guardians/:id` — `GuardianDetailDto`

A merged guardian is returned as stored (`status: merged`, `mergedIntoId` set); the web links to
the survivor. No redirect.

### 3.3 `GET /guardians/:id/students` — paginated

Shape fixed now, rows from slice 6: `GuardianStudentDto { linkId, studentId, studentFullName,
admissionNo, relationship, isPrimaryContact, isFeePayer, canLogin, className | null, sectionName |
null, linkEndedAt | null }`. Filter `includeEnded` (default `false`); sort `studentFullName`. Slice 5
returns an empty page for an existing guardian (`404` otherwise); slice 6 fills the query.

### 3.4 `POST /guardians`

| Field | Rules |
|---|---|
| `fullName` | required, 2–200, trimmed, whitespace collapsed, no control characters |
| `cnic` | optional; `^[0-9]{5}-?[0-9]{7}-?[0-9]$`, normalised to 13 digits; stored encrypted (AAD `schoolId|guardians|cnic`) with `cnic_hash` |
| `phone` | optional; `normalisePhone`, failure → `422 INVALID_VALUE` |
| `email` | optional; trim, lower-case, `IsEmail`, 3–254 |
| `contactCapability` | **required** enum |
| `address` | optional, 1–500 |

`null` is accepted as "not given" for the optional fields. Status `active`. **201**
`GuardianDetailDto`. A body with a `cnic` string spends the identity-probe budget (§3.6) → `429`.
Errors: `422` · `409 GUARDIAN_CNIC_EXISTS` with `details: { guardianId }` —
the existing row, resolved to its survivor if merged (from constraint
`guardians_school_id_cnic_hash_key`; the race loser gets the same answer).

Retry-safety: a guardian with a CNIC cannot be created twice (the second submit returns the
pointer, which the web opens). Without a CNIC a double-submit could create two rows: the create
screen runs `POST /guardians/lookup` by phone first and the submit button is disabled in flight.
`Idempotency-Key` support is additive once slice 6 brings the table. Phones are not unique (one
family phone serves several guardians; R32).

### 3.5 `PATCH /guardians/:id`

Fields as create; absent = unchanged, `null` clears (`fullName` and `contactCapability` →
`null` is `422`). Guardian `merged` → `409 GUARDIAN_MERGED`. `cnic` present (set, change or clear)
while a login exists for this guardian → `409 GUARDIAN_CNIC_LOCKED` (as R24 for staff: the CNIC
is the username). New CNIC already on another guardian → `409 GUARDIAN_CNIC_EXISTS`; a body with a
`cnic` string spends the identity-probe budget (§3.6) → `429`. Clearing
`phone` while primary contact on a live link → `409 GUARDIAN_IS_PRIMARY_CONTACT` (R30; code
reserved, check added in slice 6). Concurrent edits: optimistic retry as slice 1, then `409
CONCURRENT_UPDATE`. **200** `GuardianDetailDto`.

### 3.6 `POST /guardians/lookup`

| Field | Rules |
|---|---|
| `cnic` | optional, as create |
| `phone` | optional, `normalisePhone` |

Exactly one of the two → else `422` (`INVALID_VALUE` on the body root, `path: ''`).
**Throttled by the per-user **identity-probe budget** (`slice-6.md` §3.4): 30/min and 300/hour in one bucket shared by every route that can reveal whether a CNIC or B-Form exists** (it is a CNIC existence oracle) → `429` + `Retry-After`.
Not audited; logged without the digits.

Behaviour: CNIC → by `cnic_hash`; phone → exact `phone` match. Each hit whose `merged_into_id` is
set is followed to the survivor (R31; depth ≤ 5, a longer chain is a data fault → `500` logged
without identity data); results de-duplicated by survivor id, ordered `fullName`, `id`, at most
20. R27 holds by construction (no CNIC and no phone matches nothing).

**200** `{ data: GuardianLookupHitDto[], truncated: boolean }` (unpaginated by convention §3.9):

| Field | Type |
|---|---|
| `guardian` | `GuardianDto` (the survivor) |
| `resolvedFromId` | string \| null — the merged id that was hit |
| `students` | `{ studentId, fullName, className \| null, relationship }[]` — live links; empty until slice 6 |

The CNIC is never echoed. A miss is `200` with `data: []`.

### 3.7 `POST /guardians/:id/issue-login` — empty body

Preconditions, in order, with the guardian row locked:

1. `status = merged` → `409 GUARDIAN_MERGED`.
2. No CNIC → `409 GUARDIAN_CNIC_MISSING` (R27, R21).
3. A user already has `guardian_id = :id` → `409 LOGIN_ALREADY_EXISTS` (R21).
4. **Slice 6 adds:** no live `student_guardians` link with `can_login` → `409
   GUARDIAN_NO_LOGIN_LINK`. Slice 5 reserves the code and leaves `assertLoginLink()` with an
   `it.todo` test; until slice 6 the CNIC is the only precondition.

Then user by `(schoolId, identityHash(digits))`:
- **exists** (teacher-parent, R22): its `guardian_id` is set to this guardian — never a second
  user. That user `disabled` → `409 USER_DISABLED`. R12/R14 apply to it as in `slice-2.md` §5.3
  (a principal-role holder needs `role.manage`; R14 subset check). Self → `409
  SELF_ACTION_FORBIDDEN`.
- **absent**: create with `password = argon2id(pepper(digits))`, `password_is_default = true`,
  `status = active`, `guardian_id` set.

Race (R77): unique `(school_id, guardian_id)` or `(school_id, username_hash)` violation is caught
**outside** the transaction and re-read: guardian now has a login → `409 LOGIN_ALREADY_EXISTS`;
username taken by another user → retry once on the link path. Never `500`.

**201** `UserDto` (slice 2); a linked existing user shows as a non-null `staffId`. Audit `user.login_issued`, subject user, metadata `{ capacity: 'guardian',
linkedExistingUser }`. Retry-safety: a resubmit is `LOGIN_ALREADY_EXISTS`; the web treats it as
done and refreshes.

The guardian's `email` is contact data and is **not** copied to `users.email`; the parent sets
their own reset address after first login (rule 12). Keypad-phone guardians are reset by the
office.

---

## 4. Error codes

| Code | Status | Where |
|---|---|---|
| `GUARDIAN_CNIC_EXISTS` | 409 | create, patch — `details.guardianId` |
| `GUARDIAN_CNIC_LOCKED` | 409 | patch of `cnic` once a login exists |
| `GUARDIAN_MERGED` | 409 | patch, issue-login on a merged row |
| `GUARDIAN_CNIC_MISSING` | 409 | issue-login |
| `GUARDIAN_NO_LOGIN_LINK` | 409 | issue-login (live in slice 6) |
| `GUARDIAN_IS_PRIMARY_CONTACT` | 409 | clearing phone (live in slice 6) |
| `LOGIN_ALREADY_EXISTS` | 409 | issue-login (slices 4 and 6 reuse it for R21) |

Reused: `USER_DISABLED`, `SELF_ACTION_FORBIDDEN` (slice 2), `CONCURRENT_UPDATE`,
`REFERENCE_NOT_FOUND`. Mapper entry: `guardians_school_id_cnic_hash_key` →
`GUARDIAN_CNIC_EXISTS` (the service then reads the existing id in a fresh statement).

## 5. Audit actions

| Action | Metadata |
|---|---|
| `guardian.created` | `{ hasCnic, hasPhone, contactCapability }` |
| `guardian.updated` | `{ changes }` — for `cnic` and `phone` only `{ changed: true }`, never values (phones can hit the 13-digit audit CHECK) |
| `user.login_issued` | `{ capacity: 'guardian', linkedExistingUser }` |

---

## 6. Web screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| Guardians list | `GET /guardians?status=active` | Columns name, masked CNIC, phone, contact capability, login; flags "No CNIC", "No phone" as badges; filters for each flag, capability and login; search by name or phone. A 13-digit search shows "use Find by CNIC" and opens the lookup |
| Find guardian | `POST /guardians/lookup` | CNIC or phone; each hit as "Ahmed Khan — father of Ali, Class 5"; "merged into" note when `resolvedFromId` is set; several phone hits all shown. Digits kept only in form state and cleared after the call |
| Create guardian | `POST /guardians/lookup` (phone), `POST /guardians` | Contact capability is a required radio with no preselection; `GUARDIAN_CNIC_EXISTS` offers "Open existing guardian" |
| Guardian detail | `GET /guardians/:id`, `GET /guardians/:id/students`, `PATCH` | CNIC field read-only with an explanation when `userId` is set; merged rows read-only with a link to the survivor |
| Issue login dialog | `POST /guardians/:id/issue-login` | Shown when `userId` is null and `hasCnic`; states the username is the CNIC and the password is the CNIC until changed |

---

## Decisions made here

1. Lookup accepts any of `student.create` / `guardian.manage` through the multi-key
   `@RequireCapability` of slice 2.
2. Lookup takes exactly one of `cnic` / `phone`, returns survivors with `resolvedFromId`, at most
   20 with a `truncated` flag; throttled by the shared per-user identity-probe budget (`slice-6.md` §3.4).
3. CNIC edits are refused once the guardian has a login (`GUARDIAN_CNIC_LOCKED`), mirroring R24.
4. Issue-login's link precondition (`can_login`) lands in slice 6; slice 5 requires only an
   active guardian with a CNIC and no existing login.
5. Guardian `email` is not copied to the login's reset address.
6. No idempotency key on guardian create in slice 5; CNIC uniqueness and a phone lookup first are
   the retry protection until slice 6's table exists.
7. Audit rows record that CNIC or phone changed, never the values.
8. `GET /guardians/:id/students` ships its shape now and returns an empty page until slice 6.
