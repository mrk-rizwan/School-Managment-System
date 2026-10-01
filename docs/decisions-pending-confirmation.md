# Decisions pending client confirmation

**Status: PROVISIONAL — not settled, not approved, do not build from these.**

Produced by Wave 0 of the development planning (`solution-advisor` and `research-scout`).
Development is on hold until the client confirms. When a decision here is confirmed, move it
into the settled-rules section of `CLAUDE.md` and delete it from this file.

Date recorded: 2026-09-01

---

## Part 1 — Foundation decisions awaiting confirmation

Ranked by cost of getting wrong.

### D1. Account and identity model — HIGHEST COST IF WRONG

**Recommendation: person-first, phone + OTP, no passwords.**

`guardians`, `staff` and `students` are domain tables. `users` is a thin credential row with
nullable links to each. A person the school holds contact details for but who never logs in
does not require a half-empty account, and a teacher whose own child attends the school gets
**one login carrying both capability sets**.

- The office creates the guardian record at admission and never sets a password. The system
  sends an activation message; the guardian's **first OTP creates the credential**.
- **Guardians never self-register.** There is no way to verify that a self-registrant is that
  child's parent.
- Identifier is the mobile number. `UNIQUE(school_id, phone)` on `users`, but **no uniqueness
  on the guardian's phone** — two guardians may share a handset while one holds the login.
- Guardian phone is **nullable**. The gap becomes a worklist: "14 students have no reachable
  guardian."
- Students: build the role, gate it behind a per-school minimum-class setting, default off.
  Credential issued by the guardian, not the student. A student session must never resolve a
  finance capability.

**The deliverable is not the login screen — it is the guardian match step at admission.**
"One login, every child" fails because the office creates a *second* guardian record when the
sibling is admitted. The admission wizard must search by CNIC then phone and offer
*"Ahmed Khan — father of Ali, Class 5 — link to this record?"*, non-skippable. Add
`merged_into_id` to the guardian table in the first migration even though the merge UI comes
later.

**Two risks that must be designed for:**

1. **Pakistani telcos recycle dormant numbers.** A number change must be a first-class event:
   revoke every session, notify the old number, and mark the released number historic so it can
   never reclaim the identity. Without this, number recycling is complete account takeover of a
   child's record.
2. **OTP over WAHA is exactly the traffic pattern that gets a WhatsApp number banned.** OTP must
   default to SMS — so every guardian login costs a message. That, not convenience, is the real
   argument for long sessions (90 days) plus a device PIN.

**Enforce in Postgres from day one:** a partial unique index giving exactly one
`is_primary_contact` per student.

**Reversible:** OTP length and expiry, session lengths, whether students log in, adding email later.
**Not cheaply reversible:** users separate from persons; tenant-scoped versus global users; phone
as a historied attribute; and above all **whether guardians were deduplicated at admission**.

---

### D2. Permission model

**Recommendation: role defaults + per-user grant/revoke deltas + school-defined custom roles.
38 capabilities, staff only. Reject full per-row ABAC.**

**Guardian and student roles are fixed and closed** — not grantable. This halves the surface and
removes an entire escalation family.

**The distinction that keeps it from sprawling:** capability is *which verb*; scope is *which rows*
— and **scope comes from assignment data, not checkboxes**. A teacher marks their class because
they are assigned to it. Conflating the two is how permission systems arrive at forty switches per
employee.

Capability groups: Setup (7) · Access (2) · Students (5) · Guardians (1) · Documents (3) ·
Staff (6) · Payroll (2) · Attendance (3) · Academics (9) · Finance (11) · Comms (2).

Notable defaults: office staff receive `payment.record` but **not** `payment.verify`, **not**
`concession.grant`, and **not** `finance.report.view` — a fee clerk should not see the owner's
profit. `announcement.send.school` is off by default and grantable.

**Four rules that matter more than the list:**

1. `role.manage` is **not itself grantable**. No capability may be used to acquire capabilities.
2. **Nobody grants what they do not hold.** One line of code; closes a whole escalation family.
3. **Scope is not a grant.** Write the check as `can($capability, $subject)` from the first call
   site even while scope is always school-wide — free forward compatibility.
4. **The capability split does not prevent fraud.** Even with `payment.record` and
   `payment.verify` separated, *"an actor may not verify a claim they submitted"* and *"a
   collector may not confirm their own handover"* are **domain invariants, not permissions**.
   Every model that tries to express separation of duties as a checkbox gets this wrong.

Build the **effective-permissions view** for a staff member in Phase 1, alongside the grant screen
— otherwise "why can Ayesha do this?" becomes archaeology across role, custom role and personal grant.

**Reversible:** default sets, custom roles, adding capabilities, expiry, the UI.
**Not cheaply reversible:** capability naming and granularity once they exist in grant rows and code.

---

### D3. Multi-campus — BLOCKED ON CLIENT

**Recommendation: `school_id` remains both tenant and campus. Add one nullable
`school_group_id` on the school record now, and nothing else.**

Branches become separate tenants on separate subscriptions, preserving both the per-school
revenue model already promised to clients and clean isolation. The group exists as a row, so a
group-owner read-only cross-school report can be added later without a campus dimension on
every table.

The two features people adopt a campus dimension for are cheaper by other means: an intra-group
student transfer is already close-old-enrolment / open-new-enrolment under settled rule 6, and a
consolidated P&L is a reporting concern. **Shared staff across campuses is the only genuine loss**
— a shared teacher becomes two staff records, two contracts, two salaries, and payroll
double-counts.

**This is structurally the least reversible of the three, in either direction.** Adding
`campus_id` later is not hard to backfill — it is hard because every query in the system must be
audited for a scope it never had, which is the same work and the same failure mode as an
isolation audit.

**Coupling that must not be missed: D3 constrains D1.** If branches become separate tenants
**and** head-office staff must span them, then tenant-scoped users is wrong and global identity
with membership rows is right. **Answer D3 before freezing D1.**

---

## Part 2 — Stack findings

### Multi-tenancy: no package, own trait + forced Postgres RLS

Both `stancl/tenancy` and `spatie/laravel-multitenancy` are Eloquent global scopes — the same
security posture as writing it yourself, with more vendor code and, for stancl, an undated v4
major transition. stancl's own docs: *"can't do anything with low level database queries."*

**Postgres RLS is the only option that changes the security posture**, and the only one covering
the Filament gap below. Requires: two database roles (owner for migrations, non-owner without
`BYPASSRLS` for the app), `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, `SET LOCAL` inside a
transaction — never plain `SET`, which persists across pool checkout — and index-leading policy
predicates.

Set the tenant in **exactly one place**: a `TenantContext` service with `runFor(School, Closure)`,
called from HTTP middleware, job middleware and the scheduler loop. Three call sites, one
implementation.

**Self-enforcing test, worth more than either package:** query `pg_class` for every table carrying
a `school_id` column and assert `relrowsecurity AND relforcerowsecurity`. A new table without a
policy fails CI.

**Do not use Filament's built-in tenancy** — it places the tenant in the URL, contradicting
settled rule 2.

**Unproven:** no public evidence of anyone running Filament on forced RLS. **Prototype before
schema freeze, not after.**

### Filament: keep it, with three standing rules

Current versions: **Filament v5.7.7, Laravel 13.** Pin both before Phase 1.

Filament's own docs: *"Filament does not provide any guarantees about the security of your
application."* Specifically **not** tenant-scoped: `Select`, `CheckboxList`, `Repeater` and
`SelectFilter` options. Every fee-head, class and guardian picker is an unscoped query by default.
This is why RLS is not optional.

The performance ceiling is Livewire payload size — **rows on screen is the cost driver, not
database size.**

1. **Cap table page size at 50** in the panel config.
2. **Five screens are custom Pages from day one**, budgeted as Livewire work rather than Filament
   resources: attendance marking, fee verification queue, admission intake, bulk promotion,
   principal approvals. Do not attempt them as resources first.
3. **Bulk actions are a queued job over a filter, never over a selection.** Selection state
   round-trips through the browser.

**Urdu:** Filament ships a first-party `ur` locale carrying `'direction' => 'rtl'`. However user
reports on whether RTL actually renders are contradictory, with no maintainer statement.

### Flutter offline: Drift + own outbox, idempotency in the database

The offline surface is **two screens**, not an offline-first application. A sync framework
(PowerSync, brick) costs more complexity than the roughly 500 lines it replaces.

Drift (MIT, verified publisher, isolate support) plus one `outbox` table. Domain row and outbox
row written in a single transaction, so the intent to sync cannot be lost if the app dies before
the HTTP call.

**Idempotency belongs at the database constraint, not in HTTP middleware.** Middleware
idempotency depends on cache retention; **a teacher can be offline for three days.**

- Attendance has a natural key: `UNIQUE (school_id, enrolment_id, date, period)`. Retries safe by
  construction, permanently.
- Expenses have none: client-generated UUIDv7, `UNIQUE (school_id, client_reference)`.

**Conflict handling follows settled rule 4.** Where server state changed while offline, the server
accepts the write as a **correction row referencing the original** with `marked_by` and
`marked_at`, or rejects it outright if the period is locked. Never last-write-wins, never a silent
drop.

**Photos need their own queue item**, or one failed receipt upload blocks every item behind it.

**Sync state must be honest:** *saved on device* → *sending* → *saved on server* → *failed, with
reason*. Never a green tick before the server acknowledges. A teacher who believes attendance was
submitted, and a parent who never received the absence alert, is a trust failure.

`connectivity_plus` explicitly cannot confirm the internet works — use as a hint to attempt, never
as a gate. iOS background sync is unreliable by design; do not promise teachers it syncs while the
app is closed.

---

## Part 3 — Outstanding

### Questions for the client

1. **Campus structure** — *"Does the school operate more than one campus, and do any teachers work
   at two campuses in the same month?"* Blocks D3, which blocks D1.
2. **Attendance granularity** — daily or per period. Now blocks the schema **and** the mobile app,
   because the offline idempotency key is `(enrolment_id, date, period)`. If daily-only, `period`
   disappears and the offline contract changes.
3. The remaining items in the `CLAUDE.md` register and slide 24 of the school presentation.

### Two prototypes, before schema freeze

Both can invalidate an expensive choice while it is still free to change.

| Prototype | Effort | What it settles |
|---|---|---|
| **Urdu / RTL in Filament** — one throwaway resource with a table, a form with a `Select`, and a modal; set `APP_LOCALE=ur` | ~2 hours | Closes open decision 19 for the web admin, or invalidates the Filament choice |
| **Forced RLS under a Filament panel** with a `Select` relationship field | ~1 day | Confirms or breaks the entire tenancy recommendation |

### Unconfirmed by research

The stancl v4 release date · whether Laravel's connection hooks give a clean place to set the GUC
in a long-lived queue worker (needs a one-day spike) · RLS performance at ASMS scale · whether the
`ur` locale is identical on Filament's 5.x branch · Drift's behaviour under aggressive Android
background-process killing on low-end devices.
