# Decisions pending client confirmation

**Status: PROVISIONAL implementation recommendations — not settled, prototype before relying on them.**

Produced by Wave 0 of the development planning (`solution-advisor` and `research-scout`).
Date recorded: 2026-09-01.

**Part 1 (account model, permission model, multi-campus) was confirmed by the product owner on
2026-10-01 and deleted from this file.** The outcome, including the parts of the original
recommendation that survived (office-created accounts, guardian dedup by CNIC at admission,
`merged_into_id`, capability-versus-scope, `role.manage` not grantable, one tenant per campus), is
settled rules 11–16 in `CLAUDE.md`. The one material change from the recommendation: login is
CNIC digits plus a password, not phone plus OTP, so the phone-recycling and OTP-over-WhatsApp risks
no longer apply to login (they still apply if SMS OTP is later used for password reset).

---

> ## SUPERSEDED IN PART — stack changed 2026-10-02
>
> **Tenancy is resolved and is no longer provisional here.** Scoping is enforced in the
> repository layer; the database does not enforce it. Row-level security was considered and
> rejected as unproven under Prisma 7. See `CLAUDE.md`, "How tenant isolation is
> implemented".
>
> The stack is now **NestJS (Node + TypeScript) · PostgreSQL + Prisma · Next.js · React Native**.
> It was Laravel + Filament + Flutter when this document was written.
>
> **Void:** every reference to Laravel, Filament, Eloquent, Artisan, Blade, Livewire, Flutter,
> Drift and the PHP package pins.
> **Still valid:** the requirements, the slice ordering, the numbered rules, the Postgres
> reasoning, forced row-level security, and idempotency enforced as database constraints.
>
> `CLAUDE.md` is the authority. Where this file disagrees with it, this file is wrong.


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

**Urdu:** no longer relevant — the platform is English-only (settled rule 16).

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

Campus structure and attendance granularity were answered on 2026-10-01. The remaining items are
the `CLAUDE.md` register and slide 24 of the school presentation.

### One prototype, before schema freeze

It can invalidate an expensive choice while it is still free to change. (The Urdu/RTL prototype
was dropped on 2026-10-01: English only.)

| Prototype | Effort | What it settles |
|---|---|---|
| **Forced RLS under a Filament panel** with a `Select` relationship field | ~1 day | Confirms or breaks the entire tenancy recommendation |

### Unconfirmed by research

The stancl v4 release date · whether Laravel's connection hooks give a clean place to set the GUC
in a long-lived queue worker (needs a one-day spike) · RLS performance at ASMS scale · Drift's behaviour under aggressive Android
background-process killing on low-end devices.
