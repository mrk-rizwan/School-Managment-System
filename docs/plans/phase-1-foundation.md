# Phase 1 — Foundation: build plan

> ## SUPERSEDED — DO NOT EXECUTE
>
> Written against Laravel and Filament. The stack changed to NestJS, Prisma, Next.js
> and React Native on 2026-10-02. This plan is **structurally invalid**, not merely out
> of date — its package pins, Filament resources and Eloquent patterns have no
> equivalent to swap in. It must be re-planned, not edited.
>
> **Worth carrying over:** the requirements, the slice ordering, and the R1–R60 rule
> list, which are stack-independent and were reviewed and approved.


**Audience:** the Opus 5.5 session that writes the code. Self-contained; read `CLAUDE.md` and
`docs/WORKLOG.md` first, then this file top to bottom before touching anything.
**Author:** Fable 5.1, 2026-10-01. Reviewed by `data-architect`, `business-rules` and
`security-reviewer` before approval; their findings are folded in. **Status:** approved for execution.

Phase 1 delivers what the client deck calls *Foundation*: **students, staff, classes, credentials
and permissions**, on top of the tenancy and session plumbing every later phase stands on. Nothing
financial, no attendance, no mobile app. At the end a school can be created by the platform, its
principal can log in, define sessions, classes and sections, register staff, admit students with
their guardians, issue logins, and control who may do what.

---

## 0. Rules that bind every task

1. The settled rules in `CLAUDE.md` (1–17) are not revisited here. If a task below seems to
   conflict with one, the rule wins and the task is wrong — say so in `WORKLOG.md`.
2. **Every slice ends with**: tests passing (run them, paste the summary), `security-reviewer`
   and `code-auditor` run with findings closed, `phase-gate` PASS. A slice is not done on a claim.
3. **Tenant isolation test for every data-touching feature.** School A's session must not
   reach School B's rows. Write it before the feature, not after.
4. **Inspect before creating.** Laravel, Filament and the packages pinned in §2 already do
   validation, hashing, rate limiting, encryption, activity logging, file storage, mail. Do not
   hand-roll any of them.
5. **Minimal.** No abstraction with one caller. No repository layer over Eloquent. No service
   class that only forwards. Filament resources for CRUD; custom Pages only where §1 says so.
6. **Update `docs/WORKLOG.md`** at the end of every slice, and when a decision below turns out
   wrong. The next session may be a different model.
7. Commit per slice, with the message format in `.claude/agents/git-pusher.md`. Never
   `--no-verify`.
8. **Numbered rules in §7 (R1–R60) are test names.** Each one gets at least one test whose name
   says which rule it proves.

---

## 1. Shape of the system after Phase 1

```
Platform panel  (/platform)   platform admins only; creates schools, issues the first principal login
School panel    (/admin)      principal, office staff, teachers; tenant = school chosen at login, held in session
Parent / student login        exists (same users table) but has no screens yet — Phase 2
```

Modular monolith, one Laravel app, domain folders not layers:

```
app/
  Platform/      schools, platform users, platform panel
  Tenancy/       TenantContext, middleware, RLS schema helpers, the isolation test
  Academics/     academic years, classes, sections, subjects, teacher assignments
  People/        staff, guardians, students, enrolments, documents, admission page
  Access/        users, login, password flows, roles, capabilities, grants, policies
```

Filament **resources** (plain CRUD): academic years, classes, sections, subjects, staff, students
(view/edit only — creation goes through admission), guardians, custom roles, platform schools.
Filament **custom Pages** (Livewire, budgeted as real work): **Admission intake** (the wizard with
the guardian-match step), **Staff member permissions** (grant screen + effective view),
**Login / forgot password / change password** (customised Filament auth pages).

---

## 2. Stack, versions, environment

| Item | Decision |
|---|---|
| PHP / Laravel / Filament | PHP 8.3, Laravel 13.x, Filament 5.x. **Pin the exact minor in `composer.json` on day one** and record it in `WORKLOG.md`. `decisions-pending-confirmation.md` saw Filament 5.7.7 on 2026-09-01; verify current. |
| Database | PostgreSQL 16. No SQLite anywhere, including tests — RLS, partial indexes and `NULLIF` policies do not exist there. |
| Dev environment | **Docker-first.** `docker-compose.yml` with `app` (php-fpm + nginx, or `php artisan serve` for dev), `postgres`, `redis`, `mailpit`. Nothing installed on the host except Docker Desktop. Laravel Sail is acceptable if it saves time; a hand-written compose file is acceptable if Sail fights the two-role Postgres setup. |
| Tests | Pest. `RefreshDatabase` against the Postgres container, **migrating on the owner connection and running tests on the app role** (override `migrateFreshUsing()` to pass `--database=pgsql_owner`; list both connections in `$connectionsToTransact`). |
| CI | GitHub Actions on every push: `composer install`, `php artisan migrate --force` against a service Postgres with both roles, `php artisan test`, `vendor/bin/pint --test`. Red CI blocks the slice. |
| Packages allowed in Phase 1 | `filament/filament`, `spatie/laravel-activitylog`, `laravel/pint`, `pestphp/pest`, `intervention/image` (re-encode uploads). **Not** a tenancy package, **not** `spatie/laravel-permission` (§6 explains), **not** Filament's multi-tenancy feature, **not** Telescope or Debugbar. Anything else: justify in `WORKLOG.md` first. |
| IDs | `bigint` identity primary keys everywhere (rule 5). No UUIDs in Phase 1. |
| Money | None in Phase 1. When it arrives: integer whole rupees (rule 15). |
| Time | All timestamps `timestamptz`, app timezone `Asia/Karachi`, academic dates as `date`. |
| Sessions | `SESSION_DRIVER=database`. `AuthenticateSession` middleware on both panels. |
| Secrets | `.env` only; `.env.example` committed with every key and no values. Keys introduced by this plan: `IDENTITY_HASH_KEY` (separate from `APP_KEY`), `PLATFORM_ADMIN_USERNAME`, `PLATFORM_ADMIN_PASSWORD`, `DB_OWNER_USERNAME`, `DB_OWNER_PASSWORD`, `FILESYSTEM_DISK=private`. |
| Debug | `APP_DEBUG=false` everywhere but `local`. |

---

## 3. Slice plan

Slices are ordered; each is demonstrable on its own and each is a commit. Half-day tasks.
Estimates are for orientation, not commitments.

### Slice 0 — Scaffold, CI, and the RLS go/no-go (≈ 2 days)

**Goal:** an empty Laravel + Filament app that boots in Docker, has green CI, and a *proven*
answer on forced row-level security under Filament, including the login path.

Tasks
- 0.1 `laravel new`, Filament install, Docker compose, `.env.example`, Pint config, Pest. First
  commit. CI workflow. Confirm the pre-commit hook fires on a planted `.env`.
- 0.2 Two Postgres roles in the compose init script: `asms_owner` (migrations, owns tables) and
  `asms_app` (runtime, **no** `BYPASSRLS`, not the owner). Init script also runs
  `ALTER DEFAULT PRIVILEGES FOR ROLE asms_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE,
  DELETE ON TABLES TO asms_app` and `GRANT USAGE, SELECT ON SEQUENCES TO asms_app`. Two Laravel
  connections: `pgsql` (app) and `pgsql_owner` (migrations). **`pgsql_owner` is defined only when
  `APP_ENV` is `local`, `testing` or `ci`, or when running `migrate`**; it is unreachable from a
  web request in production. No model may declare `$connection = 'pgsql_owner'` (test it).
- 0.3 **RLS spike.** Throwaway tables `spike_items(id, school_id, name)` and
  `spike_tags(id, school_id, name)`, each with `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL
  SECURITY`, policy `USING (school_id = NULLIF(current_setting('app.school_id', true), '')::bigint)
  WITH CHECK (same)`. A Filament resource with a table, a form with a `Select` **relationship**
  field to `spike_tags`, and a modal action. The GUC is set with `SET LOCAL` inside a transaction
  by middleware that reads `session('school_id')`, **before** authentication runs.
  **Pass:** with school 1 in the session, the resource, the Select options, the `exists`
  validation and the modal show only school 1 rows; a raw `DB::select` also returns only school 1;
  submitting a `spike_tags` id from school 2 fails validation. With no school in the session a
  panel request aborts (H3 below), and a raw query returns **zero rows, not an error**. A queue
  job and `schedule:run` reproduce the same through the job middleware and scheduler loop. A
  `DB::reconnect()` mid-request yields zero rows afterwards (documented, not fixed).
  **Fail:** any path shows another school's rows, or Filament breaks on the forced policy.
- 0.4 Record the verdict in `WORKLOG.md`. **If PASS:** RLS is the isolation mechanism; every
  tenant table gets the policy in its migration (§4 helper). **If FAIL:** fall back to an Eloquent
  global scope applied by a `BelongsToSchool` trait plus a `DB::beforeExecuting` guard that fails
  any statement on a tenant table without `school_id` in it. State the fallback in `CLAUDE.md`
  rule 2's wording. Either way the composite tenant foreign keys (§4) and the self-enforcing test
  in 0.5 exist.
- 0.5 **Self-enforcing isolation test:** enumerate **every** table in `information_schema.tables`
  (not only those with `school_id`); each must be either RLS-forced (`relrowsecurity AND
  relforcerowsecurity`) with a policy whose expression references `app.school_id`, or in the
  allowlist `schools`, `school_groups`, `platform_users`, `migrations`, `jobs`, `failed_jobs`,
  `job_batches`, `cache`, `cache_locks`, `sessions`, `password_reset_tokens`. A new table outside
  both fails CI. The test accepts the two policy shapes in §4 (plain, and nullable-school for
  `roles`/`activity_log`).
- 0.6 `TenantContext` service: `runFor(int $schoolId, Closure $fn)` opens a transaction, runs
  `SET LOCAL app.school_id = ?`, sets the app-level current school, runs the closure. **`SET`
  without `LOCAL` is forbidden** (grep test). Called from exactly three places: the school-panel
  HTTP middleware (reads `session('school_id')`, runs before `Authenticate`), a `TenantJob`
  middleware (reads `school_id` carried on the job; throws if absent), and the scheduler loop
  (iterates active schools). In `local`/`testing`, a `DB::beforeExecuting` listener throws on any
  statement touching a non-allowlisted table when no GUC is set — **no-GUC is a hard failure in
  the application; zero rows is only the database's last line.** Queue connection has
  `after_commit => true` so nothing dispatched inside a tenant transaction fires on rollback.
  Platform panel middleware sets `SET LOCAL app.platform = '1'` instead; the `schools` policy is
  `USING (current_setting('app.platform', true) = '1' OR id = NULLIF(current_setting('app.school_id',
  true), '')::bigint)`. Delete the spike tables.

Acceptance: CI green on an empty app; the spike verdict is written down with the evidence;
`php artisan test` includes the isolation test and it passes on the allowlist alone.

### Slice 1 — Platform and the school record (≈ 1.5 days)

**Goal:** a platform admin creates a school and the school exists as a tenant.

Tables: `platform_users` (not tenant-scoped, own guard), `school_groups` (id, name — nothing
else, rule 11), `schools`.
`schools`: `name`, `short_code` (`UNIQUE`, 3–12 lower-case ASCII letters/digits; typed by users at
login, so keep it short and pronounceable), `status` (`trial|active|suspended|terminated`),
`school_group_id` nullable, `timezone` default `Asia/Karachi`, `fee_due_day` default 10
`CHECK (fee_due_day BETWEEN 1 AND 28)`, `currency` fixed `'PKR'`, `student_login_enabled` default
false, `student_login_min_class_sort` nullable, `last_admission_no` integer default 0, timestamps.
A `UNIQUE (id, short_code)` is unnecessary; `UNIQUE (short_code)` suffices.

Tasks: migrations; platform panel with a Schools resource; status change is an action with a
reason, logged by activitylog; `SchoolFactory`; seeder that creates one platform admin from
`PLATFORM_ADMIN_USERNAME` / `PLATFORM_ADMIN_PASSWORD` (fail loudly if missing). "Issue principal
login" action lives here but is built in slice 2 once `users` and `staff` exist.

Tests: platform user cannot reach `/admin`; school user cannot reach `/platform`; suspended
school's users get `403` on every write and a read-only banner (**the write block is the
deliverable**); activity log row written on status change; `fee_due_day` 29 refused.

### Slice 2 — Staff (minimal), users and login (≈ 2.5 days)

**Goal:** a person with a school account can log in with their school code, CNIC digits and the
default password, is prompted to change it, can set a verified email and reset by it, and the
office can reset anyone within the limits of §7.

**Why staff is here:** the principal is staff (rule 7) and the `users` CHECK below requires a
linked person, so the minimal `staff` table lands now; slice 4 extends it.

`staff` (minimal now): `school_id`, `full_name`, `cnic` (**encrypted cast**, nullable),
`cnic_hash char(64)` nullable, `phone` (E.164, see §4), `designation` free text, `joined_on`,
`status` (`active|suspended|left`), timestamps. `UNIQUE (school_id, cnic_hash) WHERE cnic_hash IS
NOT NULL`. `UNIQUE (school_id, id)` for composite FKs. **No soft delete** (§4 lifecycle rule).

`users`: `school_id`, `username_hash char(64)` (HMAC of the 13 digits, §4 — **there is no
plaintext username column**), `password`, `email` nullable (**not unique** — families share
addresses; email is a contact, not an identity), `email_verified_at` nullable,
`password_is_default` boolean, `password_changed_at` nullable, `status` (`active|disabled`),
`staff_id` / `guardian_id` / `student_id` nullable FKs (composite with `school_id`), `last_login_at`,
`remember_token`, timestamps. `UNIQUE (school_id, username_hash)`.
`CHECK (num_nonnulls(staff_id, guardian_id, student_id) >= 1)` — added in slice 6 once all three
tables exist; until then a deferred TODO the slice-6 gate must clear. No soft delete.

Behaviour (rule 12, and §7 R1–R16):
- **School first.** The login page has three fields: **school code, CNIC digits, password.** The
  school code is the one place client input chooses the tenant, because no session exists yet;
  `CLAUDE.md` rule 2 is amended to say so. The page looks the school up (the `schools` policy
  allows a `SELECT` of `id, short_code, status` by code without a GUC — see §4), writes
  `school_id` to the session, and only then attempts authentication through a `TenantUserProvider`
  that always adds `where school_id = session('school_id')` and compares `username_hash`. The
  last-used school code is remembered in a cookie and pre-filled. Every subsequent request asserts
  `session('school_id') === auth()->user()->school_id` or logs out.
- Rate limits via Laravel's `RateLimiter`, no columns: 5/min per school+username+IP;
  **10/min per username across all schools** (one CNIC sprayed at many school codes trips it);
  30/min per IP. Lockout after 5 consecutive failures = a 15-minute limiter window keyed
  `login:{school}:{hash}`; office reset calls `RateLimiter::clear()`. Identical generic message for
  wrong code, wrong username, wrong password, locked, disabled; the provider does a dummy
  `Hash::check` when the user is absent so timing matches.
- Default password = the 13 digits. User creation is an office action (slices 4–6); this slice
  builds "Issue principal login" on the platform panel: creates the `staff` row, then the user,
  then `user_roles → principal`.
- After login with `password_is_default = true`: a persistent banner "You are using the default
  password" linking to change-password. **Prompt, not force.** `canAccessPanel` re-checks
  `users.status = active` and `schools.status` on every request.
- Change password requires a **verified** email on the account: if `email` is null or unverified
  the form demands one and sends a verification link (`MustVerifyEmail`). Only the account holder
  sets or changes `users.email`; any change (including an office edit, which does not exist in
  Phase 1) nulls `email_verified_at`. Entering an email already used by another user in the school
  is **allowed** (shared family address). Minimum 8 characters, not equal to the username digits.
  Password change logs out other devices.
- Forgot password: form takes **school code + CNIC digits**, never an email. Response is always
  "If this account has a verified email, a link has been sent." Laravel's broker is reused: the
  `User` model overrides `getEmailForPasswordReset()` to return `"{school_id}:{id}"` (so
  `password_reset_tokens` is tenant-unique without a custom repository) and
  `routeNotificationForMail()` to return the real address. The notification is sent only if
  `email_verified_at` is set and `status = active`. Token lifetime 15 minutes, single use; a
  successful reset clears `password_is_default`, the limiter, and other sessions.
- Office reset (capability `user.account.manage`, subject to §7 R12–R14): resets the password to
  the default, sets `password_is_default = true`, clears the limiter, **deletes the target's
  `sessions` rows and `remember_token`, deletes any outstanding reset token**, keeps `email` and
  `email_verified_at`, emails the target if a verified address exists, requires a reason, is
  activity-logged, never changes `status`. **This is the fallback for users with no email**; the
  users list shows "no email" and "default password" columns (visible only to holders of
  `user.account.manage`).
- Disabling a user (any path) deletes their sessions immediately. A user cannot disable or reset
  their own account.
- A Monolog processor replaces any `\b\d{13}\b` with `[id]` on every log channel; `dontFlash`
  includes `username`, `cnic`, `b_form`; `Illuminate\Auth\Events\Failed` listeners never log the
  credentials. The office UI never displays a username; it displays the linked person's CNIC
  masked as `35201-*****-1` from the encrypted column.

Tests: R1–R16 in §7, plus: login happy path at the right school; same digits in two schools logs
into the one whose code was entered and the session carries that school; wrong-code / wrong-user /
wrong-password / locked / disabled all return byte-identical responses; limiter per username across
schools trips; default-password banner shown and gone after change; change refused without verified
email; reset by school code + digits; reset token from school A cannot reset the same digits in
school B; office reset clears sessions and keeps email; no 13-digit string appears in `storage/logs`
after the whole suite runs.

### Slice 3 — Academic structure (≈ 1.5 days)

**Goal:** the principal defines sessions, classes, sections and subjects.

Tables (tenant-scoped):
- `academic_years`: `name` ("2026–27 April"), `starts_on`, `ends_on`, `status`
  (`planned|active|closed`). Several may be active at once (rule 15). `CHECK (ends_on > starts_on)`.
  No soft delete; `closed` is the end state.
- `classes` — **one row per class per academic year, immutable once enrolments exist**:
  `academic_year_id` not null, `name` ("Class 5"), `sort_order`, `attendance_mode`
  (`daily|period`, default `daily` — rule 14 stores per period; this is the per-class *practice*
  setting Phase 2 reads), `status` (`active|archived`). `UNIQUE (school_id, academic_year_id,
  name)`; `UNIQUE (school_id, id)` and `UNIQUE (id, academic_year_id)` for composite FKs. The April
  and September sessions of "Class 5" are two rows, exactly as two years are. **There is no
  "current session" pointer; rollover (Phase 4) copies class and section rows into the new
  session.** Changing a class's `academic_year_id` is refused once any enrolment or assignment
  references it.
- `sections`: `class_id`, `name` ("A"), `capacity` nullable, `deleted_at` (config table — soft
  delete allowed). `UNIQUE (school_id, class_id, name) WHERE deleted_at IS NULL`;
  `UNIQUE (school_id, id)`.
- `subjects`: `name`, `code` nullable, `deleted_at`. `UNIQUE (school_id, name) WHERE deleted_at IS
  NULL`. Timetable is **not** Phase 1; subjects exist so teacher assignments can name them.

Filament resources for all four. Closing an academic year is an action, not an edit, and is
refused while any enrolment in it is `active` (lands in slice 6; stub it to pass with a TODO that
slice 6 must remove). Creating a class offers "copy sections from" another class.

Tests: CRUD per resource; isolation per table; a section cannot be soft-deleted while an active
enrolment references it; year date check; two active years allowed; class year change refused
once referenced.

### Slice 4 — Staff (full) and teacher assignments (≈ 1.5 days)

**Goal:** the office registers staff; teachers get date-bounded assignments; each staff member
can be issued a login; leaving and suspension behave (§7 R17–R24).

- `staff` gains `photo_path` nullable, `left_on` nullable. CNIC becomes required for "Issue
  login" only, not for the record.
- `teacher_assignments`: `school_id`, `staff_id`, `academic_year_id`, `class_id`, `section_id`
  nullable, `subject_id` nullable, `role` (`class_teacher|subject_teacher`), `starts_on` not null,
  `ends_on` nullable. Composite FKs `(school_id, staff_id)`, `(class_id, academic_year_id)`,
  `(school_id, section_id)`. `CHECK (role <> 'class_teacher' OR section_id IS NOT NULL)`.
  `CREATE UNIQUE INDEX ... ON teacher_assignments (school_id, academic_year_id, section_id) WHERE
  role = 'class_teacher' AND ends_on IS NULL` — one *current* class teacher per section. Active =
  `ends_on IS NULL`. Reassignment = end the old row + insert the new in one transaction; rows are
  never deleted. A `subject_teacher` row with `section_id IS NULL` scopes every section of the
  class. **This table is the only scope source for teacher permission checks** (rule 13).
- Staff resource with a "Teaching assignments" relation manager (end / add, never edit dates of
  an ended row). "Issue login" action: HMACs the CNIC, looks up `users` by `(school_id,
  username_hash)`; if a user exists (the person is already a guardian) **links** `staff_id` on
  that user; otherwise creates the user with the default password. Refused when CNIC is missing,
  when staff status is not `active`, or when this staff row already has a user.
- CNIC edit is **refused once a login exists** (rule 12: username does not change). Flagged to the
  owner as a Phase 2 question; do not build a correction flow.

Tests: R17–R24; CNIC stored encrypted (raw column is not the digits); duplicate CNIC in the same
school refused with a pointer to the existing record, same CNIC in two schools allowed; one
current class teacher per section, two sequential ones allowed; issue login idempotent and linking;
leaving a staff member who is also a guardian keeps the login; isolation.

### Slice 5 — Guardians (≈ 1 day)

- `guardians`: `school_id`, `full_name`, `cnic` encrypted + `cnic_hash` (**nullable** — a guardian
  without a CNIC on file is allowed; they cannot have a login until it is entered), `phone`
  nullable E.164, `email` nullable (contact only; not the login email), `contact_capability`
  (`whatsapp|smartphone_data|keypad` — **not null**, rule 17), `address` nullable,
  `merged_into_id` nullable self FK (rule 12; the merge UI is later, the column is now), `status`
  (`active|merged`), timestamps. No soft delete. `UNIQUE (school_id, cnic_hash) WHERE cnic_hash IS
  NOT NULL`; `UNIQUE (school_id, id)`; index `(school_id, phone)`. **No uniqueness on phone** — two
  guardians may share a handset.
- Guardian resource: list (flags "no CNIC", "no phone"), view, edit; creation happens inside
  admission (slice 6) and from an "Add guardian" action on a student. "Issue login" as in slice 4,
  linking `guardian_id` on an existing user if the CNIC already has one (the teacher-parent case).
- CNIC lookups are POST actions by hash, never a `searchable()` column; `cnic` is never in a
  query string.

Tests: nullable CNIC; shared phone allowed; login refused without CNIC; phone normalised to E.164
on save and matched regardless of input format; isolation.

### Slice 6 — Students, enrolment, admission (≈ 3.5 days)

The heaviest slice and the one the office will live in. Rules R25–R44 in §7.

- `students`: `school_id`, `admission_no` (`UNIQUE (school_id, admission_no)`; formatted
  `S-000123` from `schools.last_admission_no` taken with `UPDATE schools SET last_admission_no =
  last_admission_no + 1 WHERE id = ? RETURNING last_admission_no` inside the admission
  transaction — no gaps on rollback, consecutive under concurrency), `full_name`, `gender`,
  `date_of_birth`, `b_form` encrypted + `b_form_hash` nullable, `status`
  (`active|suspended|withdrawn|transferred|alumni`), `admitted_on`, `photo_path` nullable,
  `merged_into_id` nullable self FK (duplicate repair later; column now), `notes`, timestamps. No
  soft delete. `UNIQUE (school_id, b_form_hash) WHERE b_form_hash IS NOT NULL`; `UNIQUE (school_id,
  id)`. Rule 4: every status change is a row in `student_status_changes` (`school_id`,
  `student_id`, `from_status`, `to_status`, `reason`, `changed_by`, `effective_on`); index
  `(school_id, student_id)`.
- `student_guardians`: `school_id`, `student_id`, `guardian_id`, `relationship`
  (`father|mother|guardian|other`), `is_primary_contact`, `is_fee_payer`, `can_login`, timestamps.
  Composite FKs to both parents. `UNIQUE (school_id, student_id, guardian_id)`; index
  `(school_id, guardian_id)`. **Partial unique index: exactly one primary contact per student**
  (`CREATE UNIQUE INDEX ... ON student_guardians (school_id, student_id) WHERE is_primary_contact`).
  Enforced in Postgres, not only in the form. A guardian with no phone cannot be primary contact
  (R30).
- `enrolments` (rule 6, the hub): `school_id`, `student_id`, `academic_year_id`, `class_id`,
  `section_id`, `roll_no` nullable, `status` (`active|completed|left`), `started_on`, `ended_on`
  nullable, timestamps. Composite FKs `(school_id, student_id)`, `(class_id, academic_year_id)`,
  `(school_id, section_id)`. `CREATE UNIQUE INDEX ... (school_id, student_id) WHERE status =
  'active'` — one body, one class, across sessions. `CREATE UNIQUE INDEX ... (school_id,
  section_id, roll_no) WHERE roll_no IS NOT NULL AND status = 'active'`. Indexes `(school_id,
  section_id, status)`, `(school_id, student_id)`.
- `student_documents`: `school_id`, `student_id`, `type` (`b_form|photo|previous_school_leaving|
  guardian_cnic|other`), `path`, `mime`, `size_bytes`, `status` (`uploaded|verified|rejected`),
  `verified_by` nullable, `rejection_reason` nullable, timestamps. **Only upload and view are built
  in Phase 1**; the verify/reject screen waits for the document-verification spec. Storage rules
  are in §4 "Uploads".
- **Admission intake page** (custom Filament Page, multi-step; the whole thing commits in one
  transaction at the last step, with an idempotency token generated when the page opens):
  1. **Student lookup first.** Office enters the B-Form digits if known. A hit on an existing
     student (any status) is shown; a hit on `withdrawn|transferred|alumni` offers **readmit**
     (status row + new enrolment, never a new student); a hit on `active|suspended` stops with a
     link. Then student details.
  2. **Guardian match — non-skippable.** CNIC digits (POST, hashed) then phone. Shows
     "Ahmed Khan — father of Ali, Class 5 — link to this record?" Phone hits may be several
     (shared handset): show all, office picks. A hit whose `merged_into_id` is set resolves to the
     survivor. Link or create. At least one guardian, exactly one primary contact (who must have a
     phone), at least one fee payer. The CNIC input is `wire:model.blur`, cleared after the search;
     only `guardian_id` is retained in page state.
  3. Class and section (the class row implies the academic year) → creates the `enrolment`.
  4. Documents, optional. Files are staged under a temp prefix on the private disk and moved on
     commit; an abandoned or failed admission leaves no document rows and no reachable files
     (daily sweep of the temp prefix).
  5. Review → creates everything; `status = active`; writes the status row; offers "Issue guardian
     login" and, if `student_login_enabled` and the class qualifies, "Issue student login"
     (username = B-Form digits; **never** links to an existing user — a B-Form colliding with a
     CNIC username is refused as a data error).
  A repeat submit with the same idempotency token returns the first result and writes nothing;
  the token is single-use for 24 hours (cache). Name + DOB + primary guardian matching an existing
  student is a **warning**, not a block.
- Student resource: view, edit details, status actions (`suspend`, `reactivate`, `withdraw`,
  `transfer`) each a modal with reason, each writing the status row, transitions per R36.
  **What happens to dues on exit is open decision 11 — do nothing financial; there is nothing
  financial yet.** Enrolment relation manager: "Change section" (same class; clears `roll_no`),
  "Set roll number"; a move to a class in another academic year is refused (a session transfer is
  not Phase 1). Moving class in-year is a new enrolment row closing the old one, never an edit.

Tests: R25–R44; admission creates student + guardian link + enrolment atomically and a failure
in step 5 leaves nothing (including no files); guardian match links instead of duplicating;
second primary contact refused by the database; one active enrolment per student; double submit
creates one student; two concurrent admissions get consecutive admission numbers; document not
reachable without capability, by guessing the path, or by a user of another school with the
signed URL; SVG upload refused; EXIF stripped from a photo; status transitions; isolation for
every table.

### Slice 7 — Roles, capabilities, grants (≈ 2.5 days)

**Goal:** rule 13 in code, with the effective-permissions view. Rules R45–R60.

Capabilities are a **PHP backed enum** (`App\Access\Capability`) holding the 51 keys in §6 and
their group — no `capabilities` table, no seed dance; the key is stored as `varchar(64)` and
validated against the enum.

Tables:
- `roles`: `school_id` **nullable** — null rows are the five system roles (`principal`,
  `office_staff`, `teacher`, `parent`, `student`; **platform admin is not a role here**, the
  platform guard is its gate), non-null rows are school-defined custom roles for staff. `key`,
  `name`, timestamps. `CREATE UNIQUE INDEX ... ON roles (key) WHERE school_id IS NULL`;
  `... (school_id, key) WHERE school_id IS NOT NULL`. RLS policy (second shape):
  `USING (school_id IS NULL OR school_id = GUC) WITH CHECK (school_id = GUC)`.
- `role_capabilities`: `school_id` nullable (mirrors its role), `role_id`, `capability_key`.
  System-role defaults seeded by migration from §6. Same nullable policy. A school cannot edit
  system defaults; it creates a custom role instead.
- `user_roles`: `school_id`, `user_id`, `role_id`. `UNIQUE (school_id, user_id, role_id)`. A user
  may hold several (teacher + parent).
- `user_capability_grants`: `school_id`, `user_id`, `capability_key`, `effect` (`grant|revoke`),
  `granted_by`, `reason`, `revoked_at` nullable, `revoked_by` nullable, timestamps. Append-only
  (rule 4); ending a row sets `revoked_at`. **No expiry in Phase 1** (not in rule 13; add the
  column when a need appears).

Logic, in one class `EffectivePermissions`:
`effective(user) = (∪ defaults of roles whose capacity is active) − active revoke rows ∪ active
grant rows`, order-independent (R50), cached per request. "Capacity active" means: staff roles
count only while `staff.status = active`; the parent role only while `guardian_id` is set; the
student role only while `student_id` is set. `Gate::define` for every enum case, plus
`can($capability, $subject)` with scope from assignment data: a teacher `can('student.view',
$student)` only if an active `teacher_assignment` of theirs matches the student's active
enrolment's class or section. Office staff and principal: school-wide. Parents and students: a
fixed closed set resolved in code, no grant rows. Platform users: nothing in `/admin`.

Screens: Roles resource (custom roles only; capability checklist excludes `role.manage`, and every
ticked capability must be held by the creator). **Staff member permissions** page (gated by
`role.manage`): left, the role defaults; middle, the deltas with who/why/when; right, the
effective list with the source of each line ("from role Office staff", "granted by Principal
2026-10-01"). Role assignment and office reset obey R12–R14. Filament resource `authorize*` methods
and policies call the Gate; **every resource in slices 3–6 is retrofitted in this slice** to use
capabilities instead of "logged in".

Tests: R45–R60; each system role's defaults; grant then revoke, revoke then grant, both active;
`role.manage` refused everywhere; granting or revoking what you do not hold refused; office staff
cannot reset or re-role the principal; teacher sees own section's students and not another's, and
loses scope the day after reassignment; audit rows exist for grant and revoke; effective view
matches `EffectivePermissions` output; last active principal cannot be disabled.

### Slice 8 — Phase close (≈ 1 day)

- Audit trail review: activitylog covers school status, user issue/reset/disable, student status,
  enrolment changes, grants, role assignment. `activity_log` carries `school_id` (nullable; second
  policy shape) via `tapActivity`. Every model uses `logExcept(['cnic','cnic_hash','b_form',
  'b_form_hash','password','remember_token','username_hash'])`. Grep the table after the suite for
  any 13-digit string.
- `docs-maintainer` sweep; `README.md` with "clone, copy `.env.example`, `docker compose up`,
  `migrate --seed`, log in" that a fresh machine can follow. Verify by following it.
- `security-reviewer` on the whole phase; `performance-engineer` only on the admission search and
  the students list.
- `phase-gate` on the Definition of Done. `WORKLOG.md` updated with what Phase 2 inherits.

---

## 4. Schema and migration conventions

**Tenant columns and RLS.** Every table except the allowlist in 0.5 carries `school_id bigint not
null references schools`. The shared helper `Tenancy\Schema::tenantTable(Blueprint $t)` adds
`school_id`, timestamps, and `UNIQUE (school_id, id)`; `Tenancy\Schema::enableRls('table',
nullableSchool: false)` enables and forces RLS and creates the policy
`school_id = NULLIF(current_setting('app.school_id', true), '')::bigint` (or the nullable-school
shape for `roles`, `role_capabilities`, `activity_log`). Both are called in the same migration.
`schools` has its own policy (slice 0.6) plus a `SELECT` grant on a view `school_lookup(id,
short_code, status)` for the pre-auth login lookup.

**Composite tenant foreign keys.** A child row references its parent as
`FOREIGN KEY (school_id, parent_id) REFERENCES parent (school_id, id)`, and enrolments and
assignments reference classes as `(class_id, academic_year_id) REFERENCES classes (id,
academic_year_id)`. A cross-tenant id is then a constraint error even if RLS were bypassed.

**Indexes.** Postgres does not index FK columns. Every FK column gets an index, `school_id`-led on
tenant tables; the slice texts list the ones that matter. Partial uniques are **indexes**, created
with `DB::statement('CREATE UNIQUE INDEX ...')` — `$table->unique()` cannot express `WHERE`, and
Laravel's `unique` validation rule does not know the predicate (validate in the form too).

**Lifecycle: one mechanism per table.** People and record tables (`users`, `staff`, `guardians`,
`students`, `enrolments`, `student_guardians`, `teacher_assignments`, `user_capability_grants`)
have a `status` or an end date and **no `deleted_at`**, so their unique indexes stay meaningful.
Config tables (`sections`, `subjects`) have `deleted_at` and every unique index on them carries
`AND deleted_at IS NULL`.

**Identity numbers.** `cnic` / `b_form` are `text` with the `encrypted` cast; `*_hash` is
`char(64)` = `hash_hmac('sha256', $digits, config('asms.identity_hash_key'))` from
`IDENTITY_HASH_KEY`, a secret separate from `APP_KEY` so key rotation of one does not break the
other. Rotation is an explicit `identity:rehash` command run from the decrypted columns. No
per-school salt (the key is the secret, and the user's hash must match the person's hash within a
school). Lookups use the hash; display is masked.

**Phones.** `varchar(16)`, E.164, `CHECK (phone ~ '^\+[1-9][0-9]{7,14}$')`; a cast normalises
`0300-1234567`, `03001234567`, `+92 300 1234567` to `+923001234567`, defaulting to `+92` when no
country code is given.

**Status columns** are `varchar` with `CHECK (status IN (...))`, not Postgres enums. PHP backed
enums in the model.

**Reserved words.** Never name a column `from`, `to`, `order`, `group`.

**Uploads.** `FILESYSTEM_DISK=private` and `livewire.temporary_file_upload.disk=private`; the
bucket or directory is never web-reachable. Allowlist by `finfo` sniff, not extension:
`image/jpeg`, `image/png`, `application/pdf`; 5 MB; stored as `{school_id}/{student_id}/{ulid}.
{ext}` with `ext` from the sniffed type and the original filename discarded. Images are re-encoded
(strips EXIF, including the GPS of a child's home). Served only by `GET /documents/{id}` requiring
an authenticated session **and** `can('document.view', $document)` (document loaded under RLS, so
zero rows is a 404) **and** a signed URL with a 5-minute lifetime; headers
`Content-Disposition: attachment` for PDF, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox`.

**Migrations** run on the owner connection; the app connection owns nothing. Never `->change()` a
column with data in Phase 1; there is no data. From Phase 2 onward, expand-and-contract (see the
`devops` agent).

---

## 5. Open items that Phase 1 must not pre-empt

| Register item | Phase 1 stance |
|---|---|
| 7–10 partial payment, sibling discount, concession scope, proration | No money tables. Nothing to pre-empt. |
| 11 exit states | Status rows exist (R36); no financial consequence is implemented. |
| 12 staff leave | No leave tables. The date-bounded `teacher_assignments` row is what a covering teacher would use; do not build it. |
| 13 grace and retention | `schools.status = suspended` makes writes `403`. Days and months are not computed anywhere. |
| 21–26 | Untouched. |
| Document verification | Columns exist, nullable; no verify screen; verification gates nothing. |
| Capability list (§6) | Names are fixed in Phase 1. Which ones a screen *enforces* is only what Phase 1 has screens for. |
| CNIC correction after a login exists | Refused in Phase 1; flagged to the owner. |

---

## 6. Capability registry (51 keys) and system-role defaults

Fixing the names now is the point; later phases add screens, not keys. Keys are
`noun.verb[.qualifier]`, lower-case, dot-separated, and live in the `Capability` enum.

| Group | Keys | Principal | Office staff | Teacher |
|---|---|---|---|---|
| Setup (7) | `school.settings.manage` `academic_year.manage` `class.manage` `section.manage` `subject.manage` `fee_head.manage` `holiday.manage` | all | — | — |
| Access (2) | `user.account.manage` `role.manage`* | both | `user.account.manage` | — |
| Students (5) | `student.view` `student.create` `student.update` `student.status.change` `enrolment.manage` | all | all | `student.view` (own classes) |
| Guardians (1) | `guardian.manage` | yes | yes | — |
| Documents (3) | `document.view` `document.upload` `document.verify` | all | `document.view` `document.upload` | — |
| Staff (6) | `staff.view` `staff.create` `staff.update` `staff.contract.manage` `staff.status.change` `staff.leave.approve` | all | `staff.view` | — |
| Payroll (2) | `payroll.view` `payroll.run` | both | — | — |
| Attendance (3) | `attendance.student.mark` `attendance.student.view_all` `attendance.staff.manage` | all | `attendance.student.view_all` | `attendance.student.mark` (own classes) |
| Academics (9) | `assessment.define` `marks.enter` `marks.view_all` `result.approve` `result.publish` `diary.write` `remark.write` `timetable.manage` `certificate.issue` | all | `certificate.issue` | `marks.enter` `diary.write` `remark.write` (own classes) |
| Finance (11) | `charge.create` `charge.campaign.send` `concession.grant` `payment.record` `payment.verify` `payment.void` `collection.handover.confirm` `expense.record` `expense.approve` `finance.report.view` `fee.statement.view` | all | `charge.create` `payment.record` `fee.statement.view` `expense.record` — **not** `payment.verify`, `concession.grant`, `finance.report.view` | — |
| Comms (2) | `announcement.send.scope` `announcement.send.school` | both | `announcement.send.scope` | `announcement.send.scope` (own classes) |

\* `role.manage` is held by the principal by default and **can never appear in a grant row or a
custom role**. Parent and student roles have a fixed, closed set resolved in code, not in these
tables. Platform admin has no rows anywhere in `roles`; the platform panel is gated by guard.

**Why not `spatie/laravel-permission`:** it has roles and direct permissions, but no revoke delta,
no `granted_by`/`reason`, and no "cannot grant what you do not hold". Every one of those is a
requirement, so the package would be a wrapper we fight. Four small tables and one class is less
code than the adapter would be. Opus: do not relitigate this without a concrete reason in
`WORKLOG.md`.

---

## 7. Numbered rules (each is a test)

**Login, password, reset (slice 2)**
- R1 The login form requires a school code; a username that exists in two schools is never
  resolved to "the first match".
- R2 Forgot-password takes school code + digits, never an email, and always returns the same
  message.
- R3 A reset link is sent only to a verified email on an `active` user.
- R4 Office reset keeps `email` and `email_verified_at`, announces itself to that email, sets
  `password_is_default`, clears the limiter.
- R5 Office reset deletes the target's sessions, `remember_token` and outstanding reset tokens.
- R6 Office reset never changes `status`; resetting a disabled user leaves them disabled.
- R7 Changing a verified email nulls `email_verified_at`; password change is blocked until
  re-verified.
- R8 The same email on two users in a school is allowed.
- R9 Setting `status = disabled` deletes the user's sessions immediately.
- R10 A user may not disable or office-reset their own account.
- R11 After 5 failures the username is locked for 15 minutes; all failure responses are
  byte-identical.
- R12 Office reset of a principal-role holder requires the actor to hold `role.manage`.
- R13 Assigning a role whose defaults exceed the actor's effective set requires `role.manage`.
- R14 The target's effective set after any reset or role change must be a subset of the actor's,
  or the actor holds `role.manage`.
- R15 A school always has at least one `active` user holding `principal`; disabling the last is
  refused (the platform panel issues a replacement).
- R16 No 13-digit string appears in any log line, URL, activity row or Livewire payload after a
  full test run.

**Staff (slice 4)**
- R17 `staff.status = left` removes the user's staff roles, ends every active grant row with
  reason "staff left", ends active assignments, deletes sessions; `users.status` becomes
  `disabled` only if no guardian or student capacity remains.
- R18 `suspended` behaves as R17 for login and effective capabilities, but assignments and grants
  are kept inert and return on reactivation.
- R19 Re-hire (`left → active`) re-enables login only if the user is otherwise disabled; grants
  are not restored.
- R20 A second staff row for a CNIC already present in the school (any status) is refused with a
  pointer to the existing row.
- R21 "Issue login" is refused for `suspended`/`left` staff, when CNIC is missing, and when a
  login already exists for this staff row.
- R22 Issue login links an existing user with the same `username_hash` (teacher-parent) instead
  of creating a second user.
- R23 One current class teacher per section; reassignment ends the old row and inserts a new one
  in one transaction; nothing is deleted.
- R24 CNIC edit is refused once a login exists.

**Admission and students (slice 6)**
- R25 Same B-Form digits in one school is refused with a link to the existing student, including
  withdrawn ones; the same digits in two schools is allowed.
- R26 A B-Form hit on `withdrawn|transferred|alumni` offers readmission (status row + new
  enrolment); a new student is never created for them.
- R27 A guardian with neither CNIC nor phone may be recorded but cannot be issued a login and
  cannot be found by the match step.
- R28 Exactly one primary contact per student, enforced by the database.
- R29 At least one fee payer per student.
- R30 A guardian with no phone cannot be primary contact.
- R31 A match hit whose `merged_into_id` is set resolves to the survivor.
- R32 Phone search returning several guardians shows all; the office picks.
- R33 Final submit requires the page's idempotency token; a repeat with the same token returns
  the first result and writes nothing; two racing submits produce one student.
- R34 Admission numbers are consecutive under concurrency and have no gaps after a rollback.
- R35 The wizard creates the student as `active` with an active enrolment, in one transaction;
  any failure leaves no student, guardian link, enrolment, document row or file.
- R36 Status transitions: `active → suspended|withdrawn|transferred`; `suspended → active`;
  `withdrawn|transferred → active` only via readmission; `active → alumni` only via year-end
  (Phase 4). Anything else, including repeating the current status, is refused.
  `withdrawn|transferred` close the active enrolment (`left`, `ended_on`); `suspended` does not.
- R37 Roll-number uniqueness is per section among `active` enrolments only; a section change
  clears `roll_no`.
- R38 A move to a class in another academic year is refused in Phase 1.
- R39 Moving class in-year closes the old enrolment and opens a new one; never an edit.
- R40 "Issue student login" never links to an existing user; a B-Form colliding with a CNIC
  username is refused.
- R41 Files staged before commit are not reachable and are removed if the admission does not
  commit.
- R42 Uploads are accepted only by sniffed type (`jpeg`, `png`, `pdf`), ≤ 5 MB, re-encoded if
  image, stored under a ULID name.
- R43 A document URL is useless without a session holding `document.view` on that document; a
  user of another school gets 404.
- R44 Closing an academic year is refused while any enrolment in it is `active`.

**Permissions (slice 7)**
- R45 `role.manage` cannot appear in a grant row or a custom role.
- R46 Nobody grants or revokes a capability they do not hold.
- R47 `granted_by != user_id`: nobody grants or revokes on themselves, including the principal.
- R48 Grants and revokes targeting a `role.manage` holder require `role.manage`.
- R49 Grants to users whose staff record is not `active`, or who hold only parent/student roles,
  are refused.
- R50 Effective = role defaults − active revokes ∪ active grants; a revoke row removes a default
  only; a grant ends solely by `revoked_at`; an active grant and an active revoke on the same key
  → grant wins; ending a grant twice is a no-op.
- R51 A grantor later losing a capability does not cascade to grants they made.
- R52 Custom roles may not contain `role.manage`; every capability in a custom role must be held
  by its creator; a custom role held by any user cannot be deleted.
- R53 Teacher scope is evaluated against assignments active today; history follows the section,
  not the person (a reassigned teacher loses all scope over the old section, the new one gains
  all of it).
- R54 A `subject_teacher` row with `section_id IS NULL` scopes every section of the class.
- R55 Office staff cannot open the permissions page.
- R56 Platform users have no access to `/admin`; school users have none to `/platform`.
- R57 Every grant, revoke, role assignment and office reset writes an activity row with actor,
  target, reason.
- R58 The effective-permissions screen shows the same set `EffectivePermissions` computes.
- R59 A staff user whose `staff.status` is not `active` has no staff capability regardless of
  stored rows.
- R60 Every table outside the allowlist is RLS-forced (the 0.5 test) and every child row's
  `school_id` matches its parent's (composite FK).

---

## 8. Definition of done for the phase

All of `CLAUDE.md`'s Definition of Done, read literally, plus:

- A fresh clone on a machine with only Docker follows `README.md` to a logged-in principal in
  under 15 minutes.
- The isolation test enumerates every table and CI is red if a new one lacks RLS or allowlisting.
- Every slice's tests exist and pass on the app role, not the owner role.
- R1–R60 each have a named test.
- No CNIC, B-Form, password or token appears in any log, URL, activity row or error page.
- `WORKLOG.md` says what Phase 2 (attendance, diary, notices, WhatsApp/SMS, first Flutter
  screen) inherits and what was deferred, with register numbers.

---

## 9. What Phase 2 will need from Phase 1 (so do not paint over it)

- `classes.attendance_mode` and the per-period storage rule (rule 14) — Phase 2 writes the
  `attendance` table with `UNIQUE (school_id, enrolment_id, date, period)`.
- `guardians.contact_capability` (rule 17) — every routing rule reads it.
- Date-bounded `teacher_assignments` as the only scope source — the mobile app's "my classes" is
  this table, and open item 12 (covering teacher) would be a row in it.
- `users` with `guardian_id` and `student_id` — the Flutter login hits the same table, with the
  same school code + digits + password.
- The capability keys for attendance, diary and announcements already exist in the enum.
