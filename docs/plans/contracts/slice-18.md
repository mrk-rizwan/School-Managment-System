# Slice 18 contracts — fee setup, payment accounts, settings, rule 24

**Author:** Opus 5.5 (wave H), 2026-10-06. **Binds:** `packages/shared/src/{finance,money/**}.ts`,
the Phase 3 additions to `error-codes.ts`, `idempotency.ts`, `messages.ts`, `capabilities.ts`;
`apps/api/src/modules/{fees,payments}/**`, `modules/access/money-gates.ts`, the rule-24 lines in
`modules/access/permissions.service.ts` and `common/auth/route-access.ts`,
`common/{fields,print-view}.ts`, the settings and school-creation changes; migrations
`20261005180725_phase3_message_types`, `20261005181500_phase3_groundwork`,
`20261005182000_slice18_fee_setup`. **Source:** `phase-3-financial.md` §3.1, §3.2, §3.5, §3.8, §4
"Fee setup", §5.1 and slice 18 (R176–R178, R225, R233, R234). Everything not restated follows the
Phase 1 and 2 conventions (envelope, string ids, `PageQueryDto`, `NoQueryDto`, `@ApiErrors()`,
`404` for another school's id, no `DELETE`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /fee-heads`, `GET /fee-heads/:id` | finance readers: `fee_head.manage \| charge.create \| fee.statement.view \| payment.record` | sort `name \| -name`, `status?`; `FeeHeadDto` adds `seeded` (created_by null) |
| `POST /fee-heads` | `fee_head.manage` | `concessionEligible` defaults to `category ≠ fine`, `refundable` to `category ≠ admission`; `true` sent for those is `422` on the field; `409 FEE_HEAD_NAME_TAKEN` (names compared case-insensitively among live heads) / `FEE_HEAD_CATEGORY_TAKEN` (a second live tuition or fine head), each with `details.feeHeadId` |
| `PATCH /fee-heads/:id` | `fee_head.manage` | `name`, `concessionEligible`, `refundable`; `409 FEE_HEAD_ARCHIVED`; a no-op writes no audit row |
| `POST /fee-heads/:id/archive` | `fee_head.manage` | `{ reason }` (`@Reason`, 3–500); final; repeating it is `200` with no row |
| `GET /fee-structures` | finance readers | `academicYearId` required, `classId?`; pages of the year's classes (sort order, name); `heads` = per head the active row with the latest `effective_from`; `history` = every row of the class, newest month first per head |
| `POST /fee-structures` | `fee_head.manage` + `Idempotency-Key` (endpoint `fee_structures`, path id the class) | below |
| `POST /fee-structures/copy` | `fee_head.manage` | `200 { created, skipped }`; target class matched by name, case-insensitively, live classes only; the source's current row per head; skipped: no namesake, head archived, target already priced for the head; `effectiveFrom` must be a month of the target year |
| `GET /payment-accounts`, `GET /payment-accounts/:id` | finance readers | list ordered active first, then by creation |
| `POST /payment-accounts`, `POST /payment-accounts/:id/disable` | `school.settings.manage` + `requirePrincipal` | `accountNo` has spaces removed and letters upper-cased, 4–34 of `[0-9A-Za-z-]`, never 13 digits or 5-7-1; `bankName` only for `bank`; disable is final, a repeat is `200` with no row |
| `GET /me/payment-accounts` | `@RequireCapacity('guardian')`, `me-reads` throttle | `MyPaymentAccountDto { id, kind, title, accountNo, bankName }`, active only |
| `GET \| PATCH /school/settings` | `school.settings.manage` | §3.8 fields; `lateFeeEnabledAt` read-only |

### 1.1 `POST /fee-structures`, step by step (one transaction)

1. Claim the idempotency key (first statement). A replay answers `200` with the stored row.
2. Year exists (`422 REFERENCE_NOT_FOUND` on `academicYearId`) and is not closed
   (`409 ACADEMIC_YEAR_CLOSED`); `effectiveFrom` is a month of the year (`422`).
3. Class exists in that year (`422` on `classId`), not archived (`409 CLASS_ARCHIVED`).
4. The fee head is locked (every structure write for a head serialises on it); missing is `422`
   on `feeHeadId`, archived is `409 FEE_HEAD_ARCHIVED`.
5. Same month as an active row: without `reason` → `409 FEE_STRUCTURE_EXISTS { structureId }`; with
   one, the active row is marked superseded, the new row inserted, the old row's `superseded_by`
   set. Otherwise the month must be later than the latest active month
   (`409 FEE_STRUCTURE_NOT_LATER { latestEffectiveFrom }`).
6. Audit `fee_structure.created` (`supersededId`, `supersededAmount` when it replaced one).

`CHARGE_RUN_IN_PROGRESS` is not raised yet: `charge_runs` is slice 19's table. Slice 19 adds the
check to step 4.

## 2. Audit actions (R57, R230)

`fee_head.created | updated | archived`, `fee_structure.created | copied` (subject the target
year), `payment_account.created | disabled` (metadata holds `kind`, `title` and the account
number's last four characters only: a long account number can hold a 13-digit run, which
`audit_log` refuses), `school_settings.updated` (unchanged action, new fields in `changes`), and
`user.default_password_blocked` (rule 24, subject the user, `metadata.capabilities` the blocked
keys the route named). "Once per user per school day" is best-effort, accepted at review
(2026-10-06): the guard checks for a row since the school day began and then inserts, outside a
transaction, so two refusals racing in the same instant can write two rows. Nothing reads the count.

## 3. Rule 24 (R225)

`PermissionsService.load` reads `users.password_is_default` on every request. While it is set,
`role.manage` and `user.account.manage` (`DEFAULT_PASSWORD_INERT_CAPABILITIES`) are removed from
`access.capabilities` and listed in `access.blockedCapabilities`, so every check (the guard, the
R14 subset rule, in-service `holds()`) treats them as not held. `RouteAccessGuard` answers a route
none of whose capabilities is held, but one of which is blocked, with `403
DEFAULT_PASSWORD_BLOCKS_ACTION` instead of `PERMISSION_DENIED`. An in-service override that asks "does the actor hold role.manage" (staff status R12/R14, the
R74 self-assignment, the actor side of `isSubset`) reads `PermissionsService.holdsNominally`
(`access.lines`), so only the routes of the two blocked keys refuse (review fix, 2026-10-06).
`/me` drops the blocked keys from
`capabilities` and `capabilityScopes` and lists them in `blockedCapabilities`. `access.lines` (the
permissions view) still shows them as held through their role.

## 4. The principal gate and the own-child predicate (R232, R233, R253)

`requirePrincipal(session)` (`modules/access/money-gates.ts`): staff capacity and a live
`principal` system role, else `403 PERMISSION_DENIED { reason: 'principal_required' }`.
`PermissionsService.actorIsGuardianOf(schoolId, actorUserId, studentId)`: some record in the merge
family of the user's guardian has a live link to the student (`can_login` irrelevant). The family
is defined once, in SQL: `asms_guardian_merge_family(school_id, guardian_id)` follows
`merged_into_id` in both directions, at most five steps (migration
`20261006080000_slice18_review_fixes`); slice 19's own-child trigger reuses it. Refusal helper `ownChild()`
(`409 SELF_ACTION_FORBIDDEN { reason: 'own_child' }`). `PermissionsService.isSolePrincipal`
locks the school's `school_settings` row and reads `isLastActivePrincipal`; call it inside the
writing transaction. Every path that adds a principal takes the same lock first (assigning the
`principal` role, and the platform's issue-principal-login), as removing one already did. Slice 18 uses only `requirePrincipal`; the others are for slices 19–25.

## 5. Seeds (R176, §3.5)

`asms_seed_school_finance(school_id)` inserts the five heads of `SEEDED_FEE_HEADS` (created_by
null) unless the school already has a seeded head, and the `expense_no` counter `ON CONFLICT DO
NOTHING`. The school-creation transaction calls it (`FeeHeadRepository.seedForSchool`, tagged
`$executeRaw`, listed in `RAW_SQL_FILES`); the migration's backfill calls it for every school.
Academic-year creation writes `receipt_<yearId>`; the backfill wrote it for existing years. The
seed of the three leave types joins this function in slice 24.

## 6. Message types

The eighteen §3.6 types, their subject types and the audiences `fee_payer_guardians` and
`capability_holders` are declared (`MESSAGE_TYPE_TABLE`, enum `message_type`). Each type's
template variables are `Record<string, never>` and its renderer throws "written by its own slice"
until the slice that sends it writes the template; the R16 scan lists them in `TEMPLATE_PENDING`
and fails if a pending type renders. `fee_charged` is SMS-eligible but not allowed by default.

## 7. Shared helpers (§3.3)

`payslipNet` returns `{ ok: false, reason: 'adjustment_exceeds_pay', gross }` when a negative
adjustment exceeds basic + allowances, instead of clamping; slice 25's service refuses that
adjustment. Print views (`sendPrintView`) carry `frame-ancestors 'none'` in their CSP; templates
quote every attribute and never interpolate a URL.
