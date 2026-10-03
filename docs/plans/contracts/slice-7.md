# Slice 7 contracts — custom roles, grants and revokes, the permissions view

**Author:** Opus 5.5 (slice-7 API agent), 2026-10-03. **Binds:** `apps/api/src/modules/access/**`,
`modules/people/staff/user-roles.service.ts` (custom-role assignment),
`modules/people/staff/staff-status.service.ts` (R17 grant ending),
`apps/web/app/(school)/staff/**` and `apps/web/app/(school)/settings/roles/**` (or wherever the web
agent puts the custom-roles screen). **Sources:** `CLAUDE.md` rule 13, plan §3.3, §3.4, §4 slice 7,
§5 slice 7, §7, R13, R17–R19, R45–R59, R69, R75, R79, R94–R96. Everything not restated follows
§3.9, `slice-2.md` and `slice-4.md` (access decorators, error envelope, `UserRoleDto`). Paths are
under `/api/v1`. Identity numbers appear nowhere in this slice.

---

## 1. Access, lock order, effective permissions

| Route | Decorator |
|---|---|
| `GET /custom-roles`, `GET /custom-roles/:id` | `@RequireCapability(USER_ACCOUNT_MANAGE, ROLE_MANAGE)` (any of) |
| `POST /custom-roles`, `PATCH /custom-roles/:id`, `POST /custom-roles/:id/archive` | `@RequireCapability(ROLE_MANAGE)` |
| `GET /users/:id/permissions` | `@RequireCapability(ROLE_MANAGE)` |
| `POST /users/:id/grants`, `POST /grants/:id/end` | `@RequireCapability(ROLE_MANAGE)` |
| `POST /users/:id/roles` (now also `{ customRoleId }`) | `@RequireCapability(ROLE_MANAGE)` (unchanged) |

Common errors: `401` · `403 PERMISSION_DENIED` · `403 SCHOOL_SUSPENDED` (writes) · `403
ORIGIN_REJECTED` · `429`. Absent, malformed or another school's id → `404 NOT_FOUND`. Office staff
(no `role.manage`) get `403` on every write here and on `GET /users/:id/permissions` (R55); the
plan lets them read custom roles (`user.account.manage`), so the user screens can name a custom
role.

**Lock order (whole system after slice 7):** `school_settings` (only when a principal may be lost)
→ target `users` row → `staff` row → `custom_roles` row → `teacher_assignments` rows. Grants,
revokes and role rows of a user are written only under that user's row lock, so racing grants,
ends and role changes on one user serialise. Custom-role edits and archive lock only the
`custom_roles` row. That lock is a compare-and-set that rewrites `updated_at` with its own value
(`readLocked`, as the other repositories' `lockIfUnchanged`), and the row is read again under it,
so taking the lock changes nothing visible: a no-op edit, an archive of an archived role and a
custom-role assignment leave `updatedAt` alone; only a real edit (name or keys) or the archive
itself moves it. *Amended 2026-10-03 (review A6): the lock was an `updated_at` touch, which bumped
it on every no-op.* Assignment of a custom role locks the user, then the role row; archive locks the
role row and counts holders under it — so archive racing assign yields either "assigned, archive
refused `CUSTOM_ROLE_IN_USE`" or "archived, assign refused `CUSTOM_ROLE_ARCHIVED`", never an
archived role with a holder (R96). No path takes `custom_roles` before `users`.

**EffectivePermissions (R50, R59)** is one pure function, `effectivePermissions()` in
`modules/access/effective-permissions.ts`, and the only computation used by `can()`, `GET /me` and
`GET /users/:id/permissions` (R58):

```
if the user has no staff capacity (staff_id null, staff not active, or no live role row): ∅  (R59)
defaults = ∪ SYSTEM_ROLE_DEFAULTS[r] for each live system-role row
         ∪ capabilities of each live custom-role row whose role is `active` (archived → nothing, R52)
effective = (defaults − keys of active revoke rows) ∪ keys of active grant rows
```

- A revoke row removes a default only — from system **and** custom-role defaults — never a grant;
  a key with an active grant and an active revoke is held (grant wins).
- Keys are resolved through a `Map` of the 51 registry keys; an unknown key in the database, and
  `role.manage` from any custom role or grant row, is ignored.
- Parent and student capacities contribute nothing in Phase 1.
- Each effective line carries its **sources** (`system_role` + role, `custom_role` + id and name,
  `grant` + grant id) and its **scope**: `assigned_sections` when every source is the `teacher`
  system role, otherwise `all` (R79 — custom role or grant → school-wide; widest wins).
- Staff capacity (unchanged meaning, plan §6 / R71) now counts custom-role rows as well as
  system-role rows. Grants alone are not a capacity.
- R14's dormant set (`isSubset`) is the same function evaluated as if the staff record were active.

---

## 2. Shapes

`GrantEffect`: `grant | revoke`. `CustomRoleStatus`: `active | archived`.
`CapabilitySourceKind`: `system_role | custom_role | grant`. `CapabilityScope`: `all |
assigned_sections`. `Capability` is the 51-key enum of `@asms/shared` (`enumName: 'Capability'`).

`CustomRoleDto`:

| Field | Type |
|---|---|
| `id` | string |
| `key` | string — `^[a-z][a-z0-9_]{1,31}$`, immutable after create |
| `name` | string |
| `status` | `CustomRoleStatus` |
| `capabilities` | `Capability[]` — live keys, registry order, unknown keys dropped |
| `holderCount` | number — live `user_roles` rows on this role, any user or staff status |
| `createdAt`, `updatedAt` | datetime |

`GrantDto`:

| Field | Type |
|---|---|
| `id`, `userId` | string |
| `capability` | `Capability` |
| `effect` | `GrantEffect` |
| `reason` | string — why it was made |
| `grantedBy` | string — user id |
| `grantedByName` | string \| null — that user's staff full name |
| `grantedAt` | datetime |
| `revokedAt` | datetime \| null — when it was ended |
| `revokedBy` | string \| null |
| `revokedByName` | string \| null |
| `endReason` | string \| null — `"staff left"` when ended by R17 |

A stored row whose key is not a delegable registry key (impossible through the API) is omitted
from `deltas` and is `404` by id, like every unknown key on read.

`UserRoleDto` (slice 4) gains `customRoleName: string | null`; `customRoleId` is now real. Exactly
one of `systemRole` / `customRoleId` is non-null.

`StaffDto` (slice-4 §2) and `UserDto` (slice-2 §5) gain `customRoleNames: string[]`: the names of
the user's live custom-role rows, in assignment order, beside `systemRoles`, so a staff member who
holds only a custom role is not shown as having no role. *Added 2026-10-03 (review A4).*

`UserPermissionsDto` (`GET /users/:id/permissions`):

| Field | Type |
|---|---|
| `userId` | string |
| `staffId` | string \| null |
| `staffStatus` | `StaffStatus` \| null |
| `staffCapacity` | boolean — false → `effective` is empty (R59) |
| `roles` | `PermissionRoleDto[]` — column 1, live role rows with their defaults |
| `deltas` | `GrantDto[]` — column 2, active grant and revoke rows (all rows with `includeEnded=true`), newest first |
| `effective` | `EffectiveCapabilityDto[]` — column 3, registry order |

`PermissionRoleDto`: `userRoleId`, `systemRole | null`, `customRoleId | null`, `customRoleName |
null`, `customRoleStatus | null`, `capabilities: Capability[]` (the role's defaults; an archived
custom role shows its keys but contributes nothing).

`EffectiveCapabilityDto`: `capability`, `group` (`CapabilityGroup`), `scope` (`CapabilityScope`),
`sources: CapabilitySourceDto[]`. `CapabilitySourceDto`: `kind`, `systemRole | null`,
`customRoleId | null`, `customRoleName | null`, `grantId | null`.

---

## 3. Custom roles

### 3.1 `GET /custom-roles` — paginated

| Param | Rules |
|---|---|
| `page`, `limit` | `PageQueryDto` |
| `status` | optional `CustomRoleStatus`; absent = all |
| `q` | `SearchField` 2–50: `name ILIKE` or `key ILIKE` |
| `sort` | `name` (default), `-name`, `createdAt`, `-createdAt`; `id` tiebreak |

**200** `{ data: CustomRoleDto[], page, limit, total }`.

### 3.2 `GET /custom-roles/:id` — `CustomRoleDto`.

### 3.3 `POST /custom-roles`

| Field | Rules |
|---|---|
| `key` | required, `^[a-z][a-z0-9_]{1,31}$`, not `principal`, `office_staff`, `teacher`, `parent`, `student`, no 13 consecutive digits (an identity number never reaches the audit log): `422`. One rule for API and web: `CUSTOM_ROLE_KEY_PATTERN`, `RESERVED_CUSTOM_ROLE_KEYS` and `customRoleKeyProblem()` in `@asms/shared` |
| `name` | required, `NameField(2, 100)` |
| `capabilities` | required array, 0–50 distinct registry keys; `role.manage` or an unknown key → `422 INVALID_VALUE` on `capabilities` (R45, R52; also `CHECK custom_role_capabilities_no_role_manage_check`) |

Refusal order: `422` (shape) → caller does not hold every listed key → `403 PERMISSION_DENIED`
`details: { reason: 'capability_not_held', capabilities: [...] }` (R94) → an `active` role with
the key → `409 CUSTOM_ROLE_KEY_TAKEN` `details: { customRoleId }` (partial unique
`custom_roles_school_id_key_key`; the race loser gets the same, read fresh). Created `active`.
**201** `CustomRoleDto`. Audit `custom_role.created`.

### 3.4 `PATCH /custom-roles/:id`

| Field | Rules |
|---|---|
| `name` | optional, as create |
| `capabilities` | optional — the **complete** new set, as create |
| `reason` | `TextField(3, 500)`; **required when the new set removes any key** (R95), **and when it adds any key to a role that has holders** (the keys reach every holder at once); else optional |

Absent fields are unchanged; `null` for any of the three is `422` (it is never read as absent).
Role row locked. Refusal order: absent → `404` → `422` shape → `archived` → `409
CUSTOM_ROLE_ARCHIVED` → keys removed and no `reason` → `422` on `reason` → keys added, the role has
holders (`holderCount > 0`) and no `reason` → `422` on `reason` → keys **added** that the
caller does not hold → `403` `'capability_not_held'` (R94; keys already in the role are not
re-checked, and a creator later losing a key does not cascade). *Amended 2026-10-03 (review L2,
A1).* Added rows are inserted; removed
rows get `removed_at`/`removed_by` (never deleted). Takes effect on every holder's next request
(R69, R95). No change at all → `200`, no audit. **200** `CustomRoleDto`. Audit
`custom_role.updated` — one row per edit naming the role, `added`, `removed`, `holderCount`.

### 3.5 `POST /custom-roles/:id/archive`

`{ reason: TextField(3, 500) }`. Role row locked. Already archived → `200`, unchanged (`updatedAt`
too), no audit.
Held by any live `user_roles` row, **including a suspended or left staff member's** → `409
CUSTOM_ROLE_IN_USE` `details: { holderCount }` (R52, R96). Sets `status = archived` (the key is
then free for a new active role). **200** `CustomRoleDto`. Audit `custom_role.archived`. There is no
unarchive in Phase 1.

### 3.6 `POST /users/:id/roles` — custom role (extends slice-4 §5.2)

`{ systemRole?: SystemRole, customRoleId?: id, reason }` — **exactly one** of `systemRole`,
`customRoleId`, else `422 INVALID_VALUE` on the missing/extra field; `null` for either is `422`. Target user locked. Order:
absent → `404` → target = caller → `409 SELF_ACTION_FORBIDDEN` (R74) → no `staff_id` or staff not
`active` → `409 STAFF_NOT_ACTIVE` → role row locked: not in the school → `422
REFERENCE_NOT_FOUND` on `customRoleId` → `archived` → `409 CUSTOM_ROLE_ARCHIVED` → live row of it
→ `409 ROLE_ALREADY_ASSIGNED` `details: { userRoleId }` (partial unique
`user_roles_school_id_user_id_custom_role_key` maps the race to the same). R13 holds by the
decorator (only `role.manage` holders assign). **201** `UserRoleDto`. Audit `user_role.assigned`
`{ customRoleId, userRoleId }`. Removal is the slice-4 `POST /user-roles/:id/remove`, unchanged.
Assigning the `principal` system role ends the user's live grant and revoke rows (§4.4); the audit
row then carries `grantsEnded`.

---

## 4. Grants and revokes

### 4.1 `POST /users/:id/grants`

| Field | Rules |
|---|---|
| `capability` | required registry key; `role.manage` or unknown → `422 INVALID_VALUE` (R45, R75; also `CHECK user_capability_grants_no_role_manage_check`) |
| `effect` | required `GrantEffect` |
| `reason` | required `TextField(3, 500)` |

Target user locked. Refusal order: absent → `404` → target = caller → `409
SELF_ACTION_FORBIDDEN` (R47) → target holds a live `principal` role row → `409
TARGET_IS_PRINCIPAL` (§4.4) → caller does not hold `capability` → `403 PERMISSION_DENIED`
`details: { reason: 'capability_not_held', capabilities: [capability] }` (R46) → target has no
`staff_id`, staff not `active`, or no live role row → `409 STAFF_NOT_ACTIVE` `details: { reason:
'staff_not_active' | 'no_staff_role' }` (R49) → an active row of the same key **and effect** →
`409 GRANT_EXISTS` `details: { grantId }` (partial unique `user_capability_grants_live_key`; the
race loser gets the same, read fresh). R48 holds by the decorator (`role.manage` on every route).

A grant of a key the user already holds by default, and a revoke of a key they do not hold by
default, are both accepted: the row records intent and takes effect if the roles change. The
permissions view shows what is in force.

**201** `GrantDto`. Audit `capability_grant.created` `{ grantId, capability, effect }`.

### 4.2 `POST /grants/:id/end`

`{ reason: TextField(3, 500) }`. Row read; absent, or its stored key is not a delegable registry
key (§2), → `404`. Its user locked, row re-read. Order:
row's user = caller → `409 SELF_ACTION_FORBIDDEN` (R47) → caller does not hold the key → `403`
`'capability_not_held'` (R46 — ending a revoke restores a capability) → already ended → `200`,
unchanged, no audit (R50 "ending twice is a no-op") → sets `revoked_at`, `revoked_by`,
`end_reason`. The target's staff status is not checked (clean-up of a suspended user's rows is
allowed), and neither is a principal target: ending a row only restores a key, and a row on a
principal can exist only from before §4.4 or by writing the database directly. The database
refuses `revoked_by = user_id` (`CHECK user_capability_grants_not_self_end_check`). **200** `GrantDto`. Audit `capability_grant.ended` `{ grantId, capability, effect }`.

A grantor later losing the key changes nothing about grants they made (R51): nothing is
re-checked on read.

### 4.3 Staff status (slice-4 §3.5, filled here)

- `left` (R17): every active grant **and revoke** row of the user is ended in the same transaction
  (`revoked_by` = caller, `end_reason = 'staff left'`); the audit row's metadata gains
  `grantsEnded` (count).
- `suspended` (R18): rows untouched, inert by R59; they count again on reactivation.
- Re-hire (R19): nothing restored.

### 4.4 Principals are unrestricted peers

*Decided 2026-10-03 by the main thread after the slice-7 review; recorded for the product owner.*
A principal holds every key by default and is never the target of a grant or revoke row:

- `POST /users/:id/grants` on a user with a live `principal` role row → `409 TARGET_IS_PRINCIPAL`
  (§4.1), whatever the effect.
- Becoming principal **ends** the user's live grant and revoke rows in the same transaction (rather
  than leaving them inert, where a stale revoke would still bite the principal), with
  `end_reason = 'became principal'`: through `POST /users/:id/roles` (`revoked_by` = caller; the
  `user_role.assigned` audit row gains `grantsEnded` when any were ended), and through the
  platform's issue-principal-login onto an existing staff login (`revoked_by` NULL: there is no
  school-user actor, as `user_roles.assigned_by` is NULL for that row; the
  `user.principal_login_issued` audit row gains `grantsEnded`). `CHECK
  user_capability_grants_revoked_check` allows a NULL `revoked_by` on an ended row for that end
  reason only.
- Nothing is restored if the principal role is later removed.
- `effectivePermissions()` is unchanged: it does not special-case principals, so a row written
  straight to the database would still apply.

---

## 5. `GET /users/:id/permissions`

Query: `includeEnded` (`QueryBoolean`, default `false`). Target any user of the school (a parent-
or student-only user shows `staffCapacity: false` and empty columns). **200**
`UserPermissionsDto`. `effective` is exactly what `effectivePermissions()` returns for the target
(R58) — the same set the target's `GET /me` lists.

---

## 6. Schema (migration `slice7_roles_grants`)

- `custom_roles`: `key varchar(32)`, `name varchar(100)`, `status custom_role_status` (`active |
  archived`), timestamps. Partial unique `custom_roles_school_id_key_key (school_id, key) WHERE
  status = 'active'`; `CHECK` key format and name trimmed.
- `custom_role_capabilities`: `custom_role_id`, `capability_key varchar(64)`, `added_by`,
  `added_at`, `removed_at`, `removed_by` (composite FKs to `custom_roles` and `users`). Partial
  unique `(school_id, custom_role_id, capability_key) WHERE removed_at IS NULL`. `CHECK
  capability_key <> 'role.manage'`; `CHECK` removed pair. `custom_role_id`, `capability_key`,
  `added_*` frozen by trigger.
- `user_capability_grants`: `user_id`, `capability_key varchar(64)`, `effect grant_effect`,
  `granted_by`, `reason varchar(500)`, `created_at`, `revoked_at`, `revoked_by`, `end_reason
  varchar(500)`. Partial unique `user_capability_grants_live_key (school_id, user_id,
  capability_key, effect) WHERE revoked_at IS NULL` (also the plan's index on live rows). `CHECK
  capability_key <> 'role.manage'`; `CHECK` revoked triple set together; no identity number in
  `reason` / `end_reason`. **Append-only except ending:** a trigger refuses DELETE and TRUNCATE,
  refuses a change to any column but the three end columns, and refuses any change to a row already
  ended.
- `user_roles.custom_role_id` nullable, composite FK to `custom_roles`; `user_roles_one_role_check`
  becomes `num_nonnulls(system_role, custom_role_id) = 1`; partial unique
  `user_roles_school_id_user_id_custom_role_key` on live rows; index `(school_id, custom_role_id)`.
- Every new table: `school_id` FK, `UNIQUE (school_id, id)`, the school_id immutability trigger.

History guards (migration `slice7_history_guards`, 2026-10-03, review L3, L4, A8). Each raises
23514 naming itself; none is reachable through the API, so none is mapped to an API error:

- `custom_roles`, `custom_role_capabilities`: DELETE and TRUNCATE refused (`<table>_no_delete`,
  function `asms_forbid_delete`).
- `custom_roles`: `archived` never goes back (`custom_roles_archive_final`).
- `custom_role_capabilities`: once `removed_at` is set, `removed_at` and `removed_by` are frozen
  (`*_removed_at_frozen`, `*_removed_by_frozen`, function `asms_forbid_change_once_set`).
- `user_roles`: `user_id`, `system_role`, `custom_role_id` frozen (`asms_forbid_columns_change`);
  once `ended_at` is set, `ended_at` and `ended_by` are frozen; an INSERT naming an archived
  custom role is refused (`user_roles_custom_role_active`, reading the role `FOR SHARE`);
  `user_roles_assigned_by_check` becomes `assigned_by IS NOT NULL OR system_role IS NOT DISTINCT
  FROM 'principal'` (the old form passed on NULL for a custom-role row).
- `user_capability_grants`: `CHECK (revoked_by IS NULL OR revoked_by <> user_id)`
  (`user_capability_grants_not_self_end_check`); `user_capability_grants_revoked_check` as §4.4.

---

## 7. Error codes (new)

| Code | Status | Where |
|---|---|---|
| `CUSTOM_ROLE_KEY_TAKEN` | 409 | custom role create — `details.customRoleId` |
| `CUSTOM_ROLE_ARCHIVED` | 409 | edit or assign an archived role |
| `CUSTOM_ROLE_IN_USE` | 409 | archive a held role — `details.holderCount` |
| `GRANT_EXISTS` | 409 | a live row of the same key and effect — `details.grantId` |
| `TARGET_IS_PRINCIPAL` | 409 | a grant or revoke aimed at a principal (§4.4) |

Reused: `SELF_ACTION_FORBIDDEN`, `STAFF_NOT_ACTIVE`, `ROLE_ALREADY_ASSIGNED`, `PERMISSION_DENIED`
(with `details.reason = 'capability_not_held'`), `REFERENCE_NOT_FOUND`, `INVALID_VALUE`.

## 8. Audit actions

Key lists in metadata are comma-joined strings (as slice-6 §8 id lists), `""` when empty:
`capabilities` and `added` in registry order, `removed` alphabetical (it may hold a stored key
outside the registry).

| Action | Subject | Reason | Metadata |
|---|---|---|---|
| `custom_role.created` | custom_role | — | `{ key, capabilities }` |
| `custom_role.updated` | custom_role | when given | `{ added, removed, nameChanged, holderCount }` |
| `custom_role.archived` | custom_role | required | `{ key }` |
| `capability_grant.created` | user | required | `{ grantId, capability, effect }` |
| `capability_grant.ended` | user | required | `{ grantId, capability, effect }` |
| `user_role.assigned` | user | required | `{ customRoleId, userRoleId }` for a custom role; adds `grantsEnded` when assigning `principal` ended rows (§4.4) |
| `user.principal_login_issued` | user | when given | adds `grantsEnded` when linking a staff login ended rows (§4.4) |
| `staff.status_changed` | staff | required | adds `grantsEnded` |

## 9. Web screens → endpoints

| Screen | Calls | Behaviour |
|---|---|---|
| Custom roles list | `GET /custom-roles` | Write controls only with `role.manage`; status filter |
| Create / edit custom role | `POST /custom-roles`, `PATCH /custom-roles/:id` | Checklist by `CAPABILITY_GROUPS`, `role.manage` never shown; a key the editor does not hold (from `GET /me`) is disabled unless already in the role; removing any key asks for a reason; `CUSTOM_ROLE_KEY_TAKEN` inline on `key` |
| Archive | `POST /custom-roles/:id/archive` | Confirm-with-reason; `CUSTOM_ROLE_IN_USE` shows the holder count |
| Staff member → Permissions | `GET /users/:id/permissions`, `POST /users/:id/grants`, `POST /grants/:id/end` | Three columns: role defaults · deltas with who / why / when and an End action · effective list with sources and scope ("all" or "assigned sections"). Add grant/revoke: capability select limited to keys the caller holds, effect, reason. Hidden for office staff (R55) and on the caller's own row (R47) |
| Staff member → Login and roles | `POST /users/:id/roles` | Role select now includes active custom roles |

---

## Decisions made here (ambiguities resolved)

1. **Revoke removes custom-role defaults too.** R50 says "role defaults"; the plan's formula is
   "defaults of roles", and custom roles are roles.
2. **Leaving ends revoke rows as well as grants** (R17 says "grants"); R19 says nothing is restored,
   and a stale revoke would silently bite a re-hire.
3. **Ending needs the key too** (R46 says "grants or revokes"; ending a revoke restores a key, so
   it is a grant in effect). Ending your own row is refused (R47).
4. **R49 "no staff capacity"** = no `staff_id`, staff not `active`, or no live role row; one code
   `STAFF_NOT_ACTIVE` with `details.reason`.
5. **Duplicate live rows** of the same key and effect are refused `GRANT_EXISTS` (retry-safe; the
   web treats it as done). A grant and a revoke of one key may coexist (grant wins).
6. **`PATCH /custom-roles/:id`** carries a `reason` (required only when removing keys), because the
   plan names PATCH for this route while R95 requires a reason for removal.
7. **Custom-role membership rows are ended (`removed_at`), not deleted**, so the history of a role's
   keys is kept beside the audit row.
8. **`grants.end_reason`** is a column the plan's schema does not list: R17's "staff left" and the
   end endpoint's reason need somewhere to live on the row.
9. **Archive has no unarchive** in Phase 1; an archived key may be reused by a new active role.
10. **`GET /custom-roles`** is readable with `user.account.manage` *or* `role.manage` (the plan
    lists `user.account.manage`; a principal always has both).
11. **Principals are unrestricted peers** (main thread, 2026-10-03; §4.4): no grant or revoke row
    targets a principal, and becoming principal ends the existing ones.
12. **Adding keys to a held role needs a reason** (review L2): it changes every holder's
    capabilities at once, exactly as removing does.
13. **The custom-role lock writes nothing visible** (review A6): `updatedAt` means "edited", not
    "locked".
