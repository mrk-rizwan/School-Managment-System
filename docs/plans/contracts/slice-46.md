# Slice 46 contracts — the audit screen and rule 24's reach

**Author:** Opus 5.5 (wave T), 2026-10-14. **Binds:** `apps/api/src/modules/audit/**`,
`repositories/audit-reads.repository.ts`, the `@DefaultPasswordInert` placements on the R355 routes,
`MeDto.blockedActions`, the two override sites (`staff-status.service.ts`,
`teacher-assignments.service.ts`), `packages/shared/src/rule24.ts`; the web page `/audit`, the
greyed buttons, `useBlockedActions`. **Source:** `phase-5-extended.md` rule 40, §0.36, §1.1 ("Audit
screen", "Rule 24 reach"), §2, §3.1, §4 throttles, §5 slice 46, §7.1, §7.2, R354–R356;
`contracts/slice-37.md` §9 (the R68 note). Everything not restated follows the Phase 1–4
conventions (envelope, string ids, `PageQueryDto` ≤ 50, `NoQueryDto`, `404` outside the school, no
`DELETE`). No migration: the groundwork (`82c5aeb`) added `audit.view` and the three `audit_log`
indexes.

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /audit-log?actorUserId&subjectType&subjectId&createdFrom&createdTo&actionPrefix` | `audit.view` + inert `audit_log.view` | page of `AuditEntryDto`, sorted `-createdAt` then `-id`; `audit-reads` throttle 60/600 per user |
| `GET /audit-log/:id` | `audit.view` + inert `audit_log.view_entry` | `AuditEntryDto`; `404` for another school's row, an unknown id and the excluded family |

### DTOs

- `AuditEntryDto { id, createdAt, action, subjectType, subjectId | null, actor, reason | null, details }`.
- `actor: { kind: user | platform | system, userId | null, name }` — a school user by display name
  (staff name, else guardian name); a platform actor (`actor_platform_user_id`, slice 45's support
  reads, the platform's own writes) is `{ platform, null, "Platform support" }` and never carries the
  platform user's id; a job's row (no actor) is `{ system, null, "System" }`.
- `details: { key, value }[]` — `metadata` flattened (nested keys joined with `.`), sorted by key,
  every value text (§2.3).

## 2. Behaviour

### 2.1 Filters

- One of three is **required** (else `422 VALIDATION_FAILED`, field `actorUserId`): `actorUserId`;
  the pair `subjectType` + `subjectId`; the pair `createdFrom` + `createdTo`. A half pair is `422`
  on the missing half. Combinations narrow (AND).
- `createdFrom`/`createdTo` are school calendar dates, **inclusive**, at most **92 days**
  (`createdTo − createdFrom ≤ 91`), read as `[dayStart(from), dayStart(to + 1))` in the school's
  timezone; reversed or wider is `422` on `createdTo` (`assertRange`).
- `actionPrefix` (`^[a-z][a-z0-9_]{0,40}(\.[a-z0-9_]{0,40})?$`) narrows any of them and alone is
  not enough. A bare family means the family: `payment` → `payment.*` (never `payment_account.*`);
  with a dot it is the start of an action (`payment.ref` → `payment.refunded`). Served by
  `LIKE 'x%'` on the `varchar_pattern_ops` index.
- `subjectType` `^[a-z][a-z0-9_]{0,31}$`; ids are id strings.

### 2.2 The excluded family

Never listed, never served by id, whatever the filter. The plan named `user.*`, `role.*`,
`grant.*`, `default_password.*`; the action names in the code are:

| Prefix | Actions today |
|---|---|
| `user.` | `user.login_issued`, `user.principal_login_issued`, `user.office_reset`, `user.password_changed`, `user.password_reset_by_token`, `user.email_changed`, `user.email_verified`, `user.reset_on_staff_link`, `user.sessions_revoked`, `user.signed_out_everywhere`, `user.login_on_default_password`, `user.default_password_blocked` (the rule-24 refusal) |
| `user_role.` | `user_role.assigned`, `user_role.removed` |
| `custom_role.` | `custom_role.created`, `custom_role.updated`, `custom_role.archived` |
| `capability_grant.` | `capability_grant.created`, `capability_grant.ended` |

There is no `role.*`, `grant.*` or `default_password.*` action; the list is
`AUDIT_EXCLUDED_ACTION_PREFIXES` in the repository. `staff.status_changed` (which carries counts
of roles and grants ended) and `teacher_assignment.*` stay visible: they are staffing, not access.

### 2.3 Text and masking

The screen's own layer over the table's CHECKs (which refuse 13 digits and the dashed CNIC):
- an email shape → `a***@domain`;
- a run of digits, optionally `+`-led and separated by single spaces or dashes, with **10 or more
  digits** (a phone or an identity number in any spelling) → `*` for all but the last two digits.
  Ids, amounts, receipt numbers and ISO timestamps are shorter and untouched;
- a key naming a sensitive value (`cnic`, `b_form`/`bform`, `identity`, `national_id`, `phone`,
  `mobile`, `msisdn`, `whatsapp`, `email`, any case, at any depth) → the value is `***`;
- `reason` is masked like a value.

### 2.4 `audit.viewed`

Written by the list and by the entry, at most once per actor per school day
(`existsForActorSince`, subject `audit_log`, no metadata); a refused or invalid request writes
nothing. Two concurrent first views may write two rows (no lock; accepted).

### 2.5 Boundaries

`AuditReadsRepository` (`page`, `find`; no write) is importable only from `src/modules/audit/**`
and `test/audit/**` (eslint `auditReadsRepository`, fixture-tested). Slice 45 reads the school's
audit log for support through its own `SupportReadsRepository`.

## 3. Rule 24's reach (R355, R356)

- `@DefaultPasswordInert(action)` is placed on every R355 route that exists; the guard refuses after
  the access check (a caller without the key is still `PERMISSION_DENIED`), audited once a day as
  `user.default_password_blocked { action }`.
- `MeDto.blockedActions: DefaultPasswordInertAction[]` — every name in
  `DEFAULT_PASSWORD_INERT_ACTION_NAMES` while `passwordIsDefault`, else `[]` (exactly the guard's
  condition; the web shows buttons by capability already, so it greys by name).
- R356: `staff-status.service.ts` (`assertMayChange`) and `teacher-assignments.service.ts` (self
  assignment) read **`holds`** (effective) instead of `holdsNominally`. A default-password principal
  is then refused on a principal target and on self-assignment with
  `403 DEFAULT_PASSWORD_BLOCKS_ACTION`, falling back to the old refusals for a non-holder. Both
  checks run inside a transaction, so they throw `deferredDefaultPasswordRefusal([role.manage])`
  (no write) and the non-transactional entry (`StaffStatusService.changeStatus`,
  `TeacherAssignmentsService.create`) records it after the rollback with
  `recordDeferredRefusal`: `user.default_password_blocked { capabilities: "role.manage" }`, once per
  user per school day, the guard's rule. The R14 subset rule's actor side stays nominal, so a
  default-password principal may still change a clerk.

| Action | Route |
|---|---|
| `payment.refund` | `POST /payments/:id/refund` |
| `payment.void` | `POST /payments/:id/void` |
| `payment.reverse_refund` | `POST /payments/:id/reverse-refund` |
| `payment_account.create` | `POST /payment-accounts` |
| `payment_account.disable` | `POST /payment-accounts/:id/disable` (R355's "archive") |
| `payroll_run.finalise` | `POST /payroll-runs/:id/finalise` |
| `payslip.mark_paid` | `POST /payslips/:id/mark-paid` |
| `salary_advance.grant` | `POST /salary-advances` |
| `expense.approve` | `POST /expenses/:id/approve` |
| `expense.payee_change` | `PATCH /expenses/:id` (§6) |
| `cash_handover.confirm` | `POST /cash-handovers/:id/confirm` |
| `cash_handover.resolve_shortfall` | `POST /cash-handovers/:id/resolve-shortfall` |
| `charge.void` | `POST /charges/:id/void` |
| `charge.waive` | `POST /charges/:id/waive` |
| `dues_clearance.override` | `POST /students/:id/dues-clearance/override` |
| `audit_log.view` | `GET /audit-log` |
| `audit_log.view_entry` | `GET /audit-log/:id` (new action, §6) |
| `import.opening_balances` | `POST /imports/opening-balances` — **slice 43 marks it** |
| `device_token.rotate` | `POST /school/device-token/rotate` — **slice 44 marks it** |
| `device_token.revoke` | `POST /school/device-token/revoke` (fix round, security LOW-2) |

**R355 verbs with no route** (nothing to mark): a payment-account **update** (accounts are created
and disabled, never edited); a payroll **run's** mark-paid (only payslips are marked paid); a
salary-advance **approve** (an advance is granted by the principal in one step, R233).

## 4. Web

- `/audit` (nav "Audit log", `audit.view`): From/To dates (default the last seven school days,
  capped at 92 on the screen with a message and no request), "Action starts with" (debounced), and
  two narrowing chips set from a row — the actor button ("Only actions by …") and the record button
  ("History of …"). The filters may arrive in the address (`subjectType`, `subjectId`,
  `actorUserId`, `createdFrom`, `createdTo`, `actionPrefix`; slice 45's notice links here). The
  record links to its page for student, staff, guardian, announcement, event, class, section,
  payroll run, assessment, result sheet and promotion sheet. Four states through `DataTable`; a
  default password shows the "Change your password first" state (its text is now generic).
- `useBlockedActions()` and `inertRowAction()` / `DEFAULT_PASSWORD_HINT` in `lib/school-session.ts`;
  `RowAction` gains `disabled` and `hint`. Greyed where each button lives: payments (void, refund,
  reverse refund), charges (void, waive), expenses (edit, approve), handovers (count, resolve),
  payment accounts (add, disable), payroll run (finalise, mark paid), advances (grant), the dues
  panel (override).

## 5. The R68 snapshot

`test/core/route-guards.ts` records the marker per route as `<guard> + inert: <action>`; the suite
reads the marker's metadata key from the decorator (as for the access keys), so adding or dropping a
marker is a visible diff. A second test compares the marked routes with
`DEFAULT_PASSWORD_INERT_ACTIONS` both ways; the two actions whose routes slices 43 and 44 have not
built are listed there (`INERT_ROUTES_NOT_YET_BUILT`) and must be removed by those slices.

## 6. Deviations from the plan

1. **The access family's real names** (§2.2): `user_role.*`, `custom_role.*`, `capability_grant.*`
   besides `user.*`; the plan's `role.*`, `grant.*`, `default_password.*` match nothing.
2. **`audit_log.view_entry`** is a second action for `GET /audit-log/:id`, so each marked route has
   exactly one action and the snapshot stays a plain comparison; `blockedActions` lists it too.
3. **`expense.payee_change` refuses the whole expense edit.** The payee is edited only through
   `PATCH /expenses/:id`, which also edits amount and method (equally money-out details); a
   route-level marker cannot look at the body, and a body-aware refusal would escape the R68
   snapshot. A default-password recorder can still record a new expense.
4. **`createdTo` is inclusive** and "≤ 92 days" counts calendar days inclusive (91 apart).
5. **The R356 refusal is `DEFAULT_PASSWORD_BLOCKS_ACTION`**, not `PERMISSION_DENIED
   target_is_principal`, when the caller holds `role.manage` only inertly. The refusal is
   audited outside the transaction it rolls back (§3), so the row survives.

## 7. Tests

- `test/audit/audit.e2e-spec.ts` (8): the required filter, pairs and the 92-day cap; filters by
  dates (school days), actor, subject, family vs prefix, paging; the excluded family in every
  filter and by id; masking (phone, email, separated CNIC, sensitive keys, reason) and "Platform
  support"; 404 across schools; `audit.view` principal-default and grantable, office and teacher
  refused; inert on both routes and restored after a password change; `audit.viewed` once a day.
- `test/access/rule24-reach.e2e-spec.ts` (5): every built R355 route refused for a default-password
  principal (table-driven from `DEFAULT_PASSWORD_INERT_ACTIONS`), one refusal row a day, every route
  past the guard after the change; the key stays held for an office clerk (charge void refused,
  expense record reaches its handler, approve is `PERMISSION_DENIED`); `/me.blockedActions`; R356
  principal-suspends-principal refused then allowed; self-assignment refused then allowed, a clerk
  still marked left; each R356 refusal, made twice, leaves exactly one audit row.
- `test/access/default-password.e2e-spec.ts`: the R225 "everything else works" case no longer
  includes self-assignment (now R356).
- `test/core/routes.e2e-spec.ts`: the marker in the R68 table; R355 inert routes = the table.
- `test/guardrails/lint-boundaries.spec.ts`: the repository refused outside the audit module.
- Web mocked Playwright: `e2e/audit.spec.ts` (3) and a payments case (void and refund greyed).
