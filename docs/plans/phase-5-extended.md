# Phase 5 — Extended: build plan

**Audience:** the Opus 5.5 session that writes the code. Self-contained; read `CLAUDE.md` (rules
1, 2, 13, 14, 18, 22, 24, 25 and the 2026-10-09 rules 32–40, the tenancy section, the register),
then `docs/WORKLOG.md` ("What Phase 5 inherits from Phase 4", "Left to do", the process notes),
then this file top to bottom. **Author:** Fable 5.1, 2026-10-09. **Builds on** Phases 1–4
(R1–R300), all complete; nothing from them is restated unless Phase 5 changes it. **Reviewed
2026-10-09** by `business-rules`, `data-architect`, `security-reviewer` (FAIL as drafted → PASS
with the four High items reshaped, all folded in) and `api-designer`; every finding is folded
into this revision, and the per-slice contracts (`contracts/slice-37.md` …) are written from it.
**Status:** awaiting the owner's approval of the revised estimate and the §1.2 items.

Phase 5 is the last phase and delivers what was stated to the client and not yet built: the period
timetable that finally lets the system say which period a teacher should be in and which registers
went unrecorded; events and parent-teacher meetings with duties, participation, charges and a
report; staff contracts with the 30-day expiry warning; document verification and the
incomplete-admissions report; transport routes with a monthly fee; the financial statement, merit
lists and the other reports the deck promised, each downloadable; commencement imports of past
results and opening balances; biometric staff attendance as a device-agnostic punch endpoint;
platform support access that is governed and recorded; the audit-log screen; and rule 24's reach.

**Size, stated honestly.** About **38 working days** — well above the 20 the Phase 1 close
guessed, because that guess covered three items, rule 31 moved the timetable, events and the
imports here, "advanced reporting" now has a list, and the reviews added the shapes that make
support access, event money and the timetable safe (a class-ranking table, an event payment route,
a closed set of support views, date-range exclusion constraints). Slices 37–47 continue Phase 4's
numbering; rules continue from R301; waves from R.

---

## 0. Rules that bind every task

Phase 1 §0 rules 1–10, Phase 2 §0 rules 11–17, Phase 3 §0 rules 18–24 and Phase 4 §0 rules 25–31
apply unchanged, with the wave process from `WORKLOG.md`: groundwork commit, waves, one security
and one correctness review per wave, one fix round, the main thread's full check, one `phase-gate`
at slice 47. Additions for Phase 5:

32. **Scope comes from assignment, duty or timetable data, never from a checkbox** (rule 13
    extended): an event officer reaches only their duty's event; a subject teacher in period mode
    marks only their timetabled periods once the section has a timetable; a driver reaches only
    the routes whose vehicle names them. Repository methods take the branded scope; an empty
    scope reads nothing.
33. **A timetable is versioned, never edited.** A version is a date range; a change opens a new
    version from a date and closes the old one the day before; slots carry their version's range
    so the clash constraints see "live on a day" without a join. Registers already recorded keep
    their period numbers.
34. **Imports never invent data.** An imported row carries `provenance = 'imported'`, the import
    id and the officer; an imported result sheet is born `published` with no message sent; an
    opening balance is a manual charge under its own head. Preview before commit; commit is one
    transaction per file; a failed row fails the file; a roster student missing from the file is
    an error, never an absence.
35. **Support access never writes** (rule 40). The session is the seventh named exception: its
    `SchoolId` is minted by its own constructor; it reads through **one closed repository of
    named views** that never selects an identity column; its transaction is opened `READ ONLY`
    in the database; the query guard refuses any write under it; every read is written to both
    audit logs with the session id and the subject ids returned; it is time-boxed, one per
    school, revocable by the principal and visible to every staff user while it lasts.
36. **Two capability keys are added and that is the end of the list** — `audit.view` (rule 40)
    and `transport.manage` (§1.1); events run under the calendar key `holiday.manage`
    (relabelled "Calendar and events"). `document.verify` joins the office defaults (rule 36).
    Rule 13's count becomes 53 (rule 40 says "52nd"; the extra key is the transport one, §1.2).
37. **Reports read stored rows and never recompute a published figure; a GET never writes**
    (Phase 4 §0.25, slice 31 §2.1). The merit list reads the live class ranking; the financial
    statement reads charges, payments, expenses and payslips on the rule-25 basis; every report
    has a CSV download of exactly the rows shown, audited.
38. **Money through an event is Phase 3 money.** An event charge is a campaign; an event payment
    is a `payments` row in the collector's custody with a receipt and the ordinary handover; a
    cancelled event's paid charges become the child's advance through the adjustment path. No
    new ledger, no new allocation rule except the one stated in §1.1 (an event payment settles
    only that event's charge).

---

## 1. Decisions Phase 5 needs

Rules 32–40 are settled ("go with default", 2026-10-09). Everything below marked **main-thread
default** is a choice inside them; each is open to the owner's correction and changes a named
slice, not the schema.

### 1.1 Main-thread defaults

| Rule | Item | Default in this plan | First used |
|---|---|---|---|
| 33 | Weekdays | Numbered 0–6 like `weekly_off_days` (0 = Sunday); a slot on a weekly-off day is refused; holidays are days, not slots | 37 |
| 33 | Rooms | A free-text room name per slot (≤ 40, trimmed); the room clash is on the lower-cased name; no rooms table | 37 |
| 33 | Substitution | One date and period, a named teacher who need not hold an assignment (that is its point); the substitute may mark that register; the regular teacher may still amend what they recorded; a leave cancellation does not void it | 37 |
| 33 | Who edits | `timetable.manage` (principal by default); every staff member reads any section's timetable; a family reads its child's through a family DTO (teacher name, subject, period, room — nothing else) | 37 |
| 34 | Events key | `holiday.manage` creates, edits, publishes, cancels and completes events ("Calendar and events"); an event **with a charge** additionally needs `charge.create` and `charge.campaign.send` to publish and `charge.create` to cancel; cancelling an event with **paid** charges needs the principal | 38 |
| 34 | Event charge | A campaign under the seeded "Event" head (category `event`, ad hoc, concession-eligible, `apply_concessions` default false, refundable), audience = the event's sections, due date = the event date by default and never before today; a student who joins a section after publish is neither invited nor charged (the office raises a manual charge if it wants) | 38 |
| 34 | Collection duty | `POST /events/:id/payments` — cash only, one student, settles only that student's open charge of the event's campaign, remainder refused; a `payments` row in the officer's custody with a receipt; handover as Phase 3; the officer never reaches `/payments/*`, dues or statements | 38 |
| 34 | Cancel with money | Unallocated charges voided (reason "event cancelled"); a charge with allocations gets a full-amount adjustment, which turns the paid money into the child's advance (Phase 3 R186), refundable by the principal or consumed by the next fee; no cash moves at cancel | 38 |
| 34 | Participation | Per student (unique per event and student): attended / absent / excused; roster = enrolments live in the event's sections on the event date ∪ students with a non-voided campaign charge; recorded by a duty holder or the section's class teacher; edited in place until the event is completed | 38 |
| 35 | Contract types | `permanent`, `fixed_term`, `probation`; permanent has no end; one live contract per staff member; `renew` ends the current on its last day and opens the next from the day after in one transaction; "end employment" ends the live contract (reason `left`) | 39 |
| 35 | Warning | 30 days before `ends_on` (*default* `contract_warning_days`, 1–90) and again at 7 days, once each, `contract_expiring` to every principal; nothing on the day; a contract past `ends_on` and not ended shows "expired, not ended" on the staff report | 39 |
| 36 | Required documents | A typed array per school (*default* B-Form and photo); the checklist reads the **newest row per type** (uploaded = awaiting, verified = satisfied, rejected = query); the incomplete-admissions report defaults to students admitted in the last 90 days (a filter, not the definition) | 40 |
| 36 | Who verifies | `document.verify` (office by default); the verifier is never the uploader (`SELF_ACTION_FORBIDDEN`); the family sees fixed text ("please re-upload <type>"), never the clerk's reason | 40 |
| 37 | Transport fee | Seeded head "Transport" (`transport`, monthly, concession-eligible); the daily charge run charges the route amount for a student whose live assignment started on or before the school's `fee_cutoff_day` of the period, once per student-period under the Phase 3 generated-charge key; an assignment ended mid-month is charged in full; two children are two assignments (a sibling bus rate is a concession per child) | 41 |
| 37 | Route amount | Append-only `transport_route_amounts` rows effective from a period; a change applies from the next period, so a period's catch-up run charges what its first run charged | 41 |
| 37 | Vehicle | Registration, capacity 1–120, driver (staff); a route has at most one vehicle; capacity is a warning, audited, never a block | 41 |
| 38 | Financial statement | *default* basis `received`; the explicit line list of R332 | 42 |
| 38 | Class ranking | A `class_rankings` version per class-term, computed when the last section of the class publishes, after a correction cascade and after an import; standard competition ranking of the live published term result's `percent_bp` across sections, ties shared; the report card keeps printing the section position (R279) | 42 |
| 38 | CSV | `?format=csv`: UTF-8 with a header, the rows shown, ≤ 10,000, cells beginning `= + - @ \t \r` prefixed with `'`, fixed ASCII file name, same-site guard, audited, cost 5 in the family's throttle | 42 |
| 39 | Past results file | One CSV per section and term into an **open** year: admission number, then one column per class-subject (exam obtained or `Ab`); tests are not imported; the created exam is held on the term's last day; roster = enrolments live that day; refused when any live mark exists for the section-term; composes with exam weight 100 % (the sheet's snapshot says so) | 43 |
| 39 | Opening balance file | Admission number, amount > 0, note; `dueOn` per file (≥ today); one manual charge per row under the seeded "Opening balance" head (`other`, once), never a late fee, visible to reminders from its due date; a credit balance is a counter payment, not an import row | 43 |
| 40 | Device token | One per school on the school row, sha-256 of 32 random bytes, shown once, rotatable; a punch carries `deviceUserId` (≤ 40 ASCII), `punchedAt`, `direction?`; the first punch of a school day marks `present`, or `late` when the school sets `staff_late_after`; later punches are stored; a punch on a non-teaching day, for a day that already has a mark, or for an unmapped or inactive id is stored and shown, never marked | 44 |
| 40 | Dispute | Any staff mark (manual or device) may be disputed with a reason; an `attendance.staff.manage` holder who is not the staff member approves (the mark is amended through the Phase 2 path with the dispute as reason) or rejects; mirrors the leave-request shape | 44 |
| 40 | Support session | 4 h *default* (`support_session_hours`, ≤ 24); one open per school, at most 3 per platform user; opened with a reason, a ticket reference and a fresh second factor; the principal's inbox and email say who, why, until when and link to the audit screen filtered by the session; every staff user's `/me` carries the banner | 45 |
| 40 | Support views | School settings; a student by admission number (name, class, section, status, guardian names and phones); a student's charges and payments; the school's own audit log. **No messages** (R114 stands), no documents, slips, payroll or staff identity data, no list over 50 rows | 45 |
| 40 | Audit screen | `audit.view`, inert on a default password; filters: actor, action prefix, subject, date range ≤ 92 days (one required); the access-management family (`user.*`, `role.*`, `grant.*`, `default_password.*`) is excluded — it would list who still signs in with a CNIC; metadata rendered as text with identity, phone and email shapes masked; a platform actor shows as "Platform support" | 46 |
| 40 | Rule 24 reach | A route-level marker `@DefaultPasswordInert()` on the exact verbs (R355 lists them), refused with `DEFAULT_PASSWORD_BLOCKS_ACTION`; `/me` gains `blockedActions` (stable action names from `packages/shared`) so the web greys the buttons | 46 |

### 1.2 Open to the owner (the plan does not guess)

| # | Question | Phase 5 stance |
|---|---|---|
| 37 | **Event-duty collection by a teacher** — the deck's slide 20 promised a collection duty; Phase 3 keeps teachers away from money. The scoped route above is the smallest shape that honours both | Built; "office collects only" = drop the route |
| 38 | **School-group reports** (slide 02) — ruled out by rule 38 | Not built |
| 39 | **Biometric device vendor** — the agent that reads the device and posts punches is the owner's or the vendor's; the endpoint is ours | Endpoint only |
| 40 | **`transport.manage` as a 53rd key** (rule 40 counts 52): transport set-up under its own key, office and principal by default — or under `fee.structure.manage`? | Own key |
| 41 | **Support reads of message delivery** — R114 says the platform never reads messages; support staff will ask "did the SMS go?". Not built; the school's own screen answers it | Not built |

### 1.3 Assumptions (each marked A*n*; correcting one changes the named slice)

- A1 A timetable belongs to a section; sections of a class may differ (37).
- A2 One slot per section per weekday per period; a double period is two slots (37).
- A3 A substitution does not change the timetable version (37).
- A4 An event belongs to one academic year and to sections of that year (38).
- A5 PTM participation is recorded per student (the family came or not), not per guardian (38).
- A6 A contract's `ends_on` is the last working day; the job compares in school time (39).
- A7 Verification applies to existing documents too; old rows start `uploaded` (40).
- A8 A student has at most one live route assignment per year; a change is close-old/open-new;
  promotion apply and withdrawal end live assignments (41).
- A9 The ranking reads `percent_bp` of the live published term result; ties share (42).
- A10 Imports target an open academic year; a truly past year is "create the year, classes,
  sections and enrolments, import, then promote as normal" and is the provider's service (43).
- A11 A device user id maps to one staff member at receipt; an unmapped punch is stored and
  reported, never marked; a later mapping does not repair old rows (44).
- A12 A support request carries the support-minted `SchoolId`, the `support: true` context and
  no school session; nothing it calls needs a `SchoolSessionContext` (45).

---

## 2. Shape of the system after Phase 5

```
apps/api/src/modules/
  timetable/            NEW  versions, slots, substitutions, views, the R120/R129 hooks   (37)
  events/               NEW  events, duties, participation, payments, report             (38)
  people/staff/         + contracts, contract documents, contract-expiry job             (39)
  documents/            + verification, required list, incomplete-admissions, approvals  (40)
  transport/            NEW  vehicles, routes, stops, amounts, assignments               (41)
  finance-reports/      + financial statement, CSV                                       (42)
  results/              + class rankings, merit list, CSV                                (42)
  attendance/           + discrepancies report, CSV; SectionDayDto.periods               (37, 42)
  people/staff/         + staff report                                                   (42)
  imports/              NEW  past results, opening balances                               (43)
  staff-attendance/     + device token, punches, disputes                                (44)
  platform/support/     NEW  support sessions and the closed views (exception 7)         (45)
  audit/                NEW  audit.view screen                                            (46)
  access/               + rule 24 reach                                                   (46)
apps/api/src/tenancy/   + schoolIdFromSupportSession, schoolIdFromDeviceToken
apps/api/src/jobs/      + contract-expiry-warn (daily), support-session-expire (5 min)
apps/web/app/(school)/  timetable/, events/, staff/[id]/contracts, documents/, transport/,
                        reports (+ CSV on every tab), imports/, audit/
apps/web/app/platform/  support/
apps/mobile/src/        timetable (teacher week, family view), events (duties,
                        participation), disputes; no new outbox lane
```

Boundaries (lint): `timetable` reads assignments and writes slots; `attendance` reads the
timetable only through `TimetableReadsRepository`; `events` writes campaigns only through
`CampaignsService`, announcements through `AnnouncementsService`, payments through
`PaymentsService.recordForEvent`, voids and adjustments through `ChargesService`; the charge job
reads assignments only through `TransportReadsRepository`; `imports` writes through
`ResultSheetsService.importSheet` and `ChargesService.createManual`; `platform/support` reads
tenant data only through `SupportReadsRepository` (§3.1); `audit` reads `audit_log` only through
`AuditReadsRepository`.

---

## 3. Cross-cutting conventions new in Phase 5

### 3.1 Keys, scopes, and the two new constructors

| Capability | Routes | Default holders |
|---|---|---|
| `timetable.manage` | versions, slots, substitutions, grid | principal |
| staff (any) | read any section timetable | all staff |
| `holiday.manage` (+ campaign keys for a charge) | events: create, edit, publish, cancel, complete, duties | principal, office |
| duty scope | participation, event payments for the officer's event | the assigned staff |
| `staff.contract.manage` | contracts, contract documents | principal |
| `document.verify` | verify, reject, required list, pending queue, incomplete admissions | principal, **office (new default)** |
| `transport.manage` (new) | vehicles, routes, stops, amounts, assignments | principal, office |
| `charge.create` + principal | opening-balance import | principal |
| `result.publish` + `assessment.define` | past-results import | principal |
| `finance.report.view` | financial statement, event report | principal |
| `marks.view_all` (`all` scope) | merit list | principal |
| `student.view` (scoped) | student profile | staff by scope |
| `staff.view` | staff report | principal, office |
| `attendance.student.view_all` | discrepancies | principal |
| `school.settings.manage` | device token rotate (rule-24 inert) | principal |
| `attendance.staff.manage` | device mapping, punches day view, dispute decisions (not own) | principal, office |
| `audit.view` (new, rule-24 inert) | the audit screen | principal |
| platform `full` + step-up TOTP | support sessions | platform admin |

**Exception 7 — support sessions.** `schoolIdFromSupportSession` (`school-id.mint.ts`) mints from
a `platform_support_sessions` row that is open (`closed_at IS NULL AND expires_at > now()`) and
owned by the calling platform user. The only tenant reads under it go through
`src/repositories/platform/support-reads.repository.ts`: a fixed list of methods, each taking the
support `SchoolId`, selecting into `Support*Dto`s that **do not select** CNIC, B-Form, hashes,
object keys or message bodies, and recording the subject ids returned. Three layers make it
read-only: the request's interactive transaction is opened `SET TRANSACTION READ ONLY`; the query
guard throws `SUPPORT_WRITE_REFUSED` on any non-read operation when the CLS context carries
`support: true`; lint confines `src/modules/platform/support/**` to that repository and
`SupportSessionRepository` (fixture-tested). Opening, closing and revoking are platform writes
that run **without** `support: true` and write both audit logs and the two messages (the
exception-1 principal-login precedent); the expiry job closes sessions and sends
`support_session_closed` through `runAsSchool` (exception 3). Platform logout closes the user's
open sessions.

**Exception 4 widened — device token.** `device_token_hash` lives on `schools` (non-tenant, like
`sms_monthly_cap`). `DeviceTokenRepository.findByTokenHash(hash) → { schoolId } | null`
(`src/repositories/platform/`, named exception site `src/modules/staff-attendance/device-punch.service.ts`)
and `schoolIdFromDeviceToken` establish the tenant from a credential hash, as the session token
does. Rotation writes through `OwnSchoolRepository`.

CLAUDE.md records both constructors, the repository and the lint sites at the close.

### 3.2 Invariants, in the database

Every Phase 5 tenant table: `school_id NOT NULL`, `(school_id, id)` unique, composite FKs, the
Phase 3 trio (no-delete, no-truncate, `school_id` immutable), FK and list indexes, schema-guard
entries, reason columns with the no-identity CHECK. The one exception is `event_sections`, which
may be deleted while the event is draft (the campaign-audience precedent). Weekday CHECKs are
`0–6`. Dates are `date`, instants `timestamptz(3)`.

- **Timetable.** `timetable_versions (section_id, class_id, academic_year_id, effective_from,
  effective_to NULL, created_by, voided_at/by/reason)`: `EXCLUDE USING gist (school_id =,
  section_id =, daterange(effective_from, effective_to, '[]') &&) WHERE voided_at IS NULL`
  (btree_gist exists); `effective_to ≥ effective_from`; `effective_from` inside the year
  (trigger); frozen except `effective_to` (restored to NULL when a successor is voided) and the
  void trio; unique `(school_id, id, class_id)`. `timetable_slots (version_id, class_id, weekday
  0–6, period 1–12, class_subject_id, staff_id, room ≤ 40, effective_from, effective_to,
  voided_at)`: range and void copied from the version by an `AFTER UPDATE OF effective_to,
  voided_at` trigger; unique `(school_id, version_id, weekday, period)`; `EXCLUDE` on
  `(school_id, staff_id, weekday, period, range) WHERE voided_at IS NULL` and on `(school_id,
  lower(btrim(room)), weekday, period, range) WHERE voided_at IS NULL AND room IS NOT NULL`;
  FKs `(school_id, class_subject_id, class_id)`, `(school_id, version_id, class_id)`,
  `(school_id, staff_id)`; `period ≤ periods_per_day` (trigger; the settings PATCH refuses
  lowering it below a live slot); the assignment check is in the service. **Order of a
  supersede:** in one transaction, update the predecessor's `effective_to` (its slots follow),
  insert the version, insert the slots. `timetable_substitutions (section_id, class_id, date,
  period, staff_id, reason, created_by, voided_at/by/reason)`: partial uniques on `(school_id,
  section_id, date, period)` and `(school_id, staff_id, date, period) WHERE voided_at IS NULL`;
  index `(school_id, staff_id, date)`.
- **Events.** `events (academic_year_id, type, title ≤ 120, starts_at, ends_at ≥ starts_at,
  venue ≤ 120, details ≤ 1000, status draft|published|completed|cancelled, campaign_id?,
  announcement_id?, cancel_announcement_id?, cancelled_at/by/reason, completed_at)`: edges
  `draft:published`, `published:completed`, `draft:cancelled`, `published:cancelled`; content
  changes only while draft (`asms_forbid_change_unless_status`); once-set campaign,
  announcements and the cancel trio; unique `(school_id, id, academic_year_id)`; FKs to
  `charge_campaigns (school_id, id, academic_year_id)` and `announcements`. `event_sections
  (event_id, section_id, class_id, academic_year_id)` unique per event-section, FKs binding the
  section to the event's year, writable only while draft. `event_duties (event_id, staff_id, duty,
  note, ended_at/by/reason)` unique live per `(event_id, staff_id, duty)`.
  `event_participation (event_id, student_id, enrolment_id, status, recorded_by, recorded_at)`
  unique per `(event_id, student_id)`, FK `(school_id, enrolment_id, student_id)`, writable only
  while the event is `published` (trigger), edited in place. `expenses.event_id` nullable FK,
  mutable only through `tag-event` (added to the frozen list's exception), index.
- **Contracts.** `staff_contracts (staff_id, type, starts_on, ends_on?, salary_structure_id?,
  document_object_key/mime/size?, note, created_by, ended_at/by/reason, warned_30_at,
  warned_7_at)`: partial unique `(school_id, staff_id) WHERE ended_at IS NULL`; `(type =
  'permanent') = (ends_on IS NULL)`; `ends_on ≥ starts_on`; FK `(school_id, salary_structure_id,
  staff_id)` (informational: the structure at start); document columns with the expenses receipt
  CHECK; frozen except the end trio and the two warn stamps (each once-set); index `(school_id,
  ends_on) WHERE ended_at IS NULL`.
- **Documents.** `student_documents` loses `append_only` and gains the Phase 3 trio: `status
  uploaded|verified|rejected` (default `uploaded`), `decided_by/at`, `reject_reason ≤ 500`
  (no-identity CHECK); edges `uploaded:verified`, `uploaded:rejected` only (a re-upload is a new
  row); `(status = 'uploaded') = (decided_at IS NULL)`, `(status = 'rejected') = (reject_reason IS
  NOT NULL)`; decider ≠ uploader (trigger); partial index on pending. `school_settings.
  required_document_types student_document_type[]` (no nulls, distinct, default `{b_form,photo}`).
- **Transport.** `vehicles (registration ≤ 20, capacity 1–120, driver_staff_id?, status
  active|retired, retired trio)`: unique `(school_id, upper(btrim(registration))) WHERE status =
  'active'`. `transport_routes (name, vehicle_id?, status active|archived, archived trio)`:
  unique live lower-cased name; archive refused with live assignments (trigger). `transport_route_
  amounts (route_id, effective_period char(7), amount ≥ 0, created_by)` append-only, unique per
  route-period. `transport_stops (route_id, sort_order, name, pickup_time?, ended_at)`: unique
  `(school_id, route_id, sort_order) DEFERRABLE INITIALLY DEFERRED WHERE ended_at IS NULL`;
  unique `(school_id, id, route_id)`. `transport_assignments (student_id, academic_year_id,
  enrolment_id, route_id, stop_id?, starts_on, ends_on?, ended_at/by/reason, created_by)`: partial
  unique `(school_id, student_id, academic_year_id) WHERE ended_at IS NULL`; FKs `(school_id,
  enrolment_id, student_id, academic_year_id)`, `(school_id, stop_id, route_id)`; `(ended_at IS
  NULL) = (ends_on IS NULL)`; frozen except the end trio; indexes `(school_id, route_id) WHERE
  ended_at IS NULL`, `(school_id, academic_year_id, starts_on)`. A trigger on `fee_structures`
  refuses a head of category `transport` or `event`; the structure run skips those categories.
- **Rankings.** `class_rankings (class_id, academic_year_id, term_id, computed_at, supersedes_id?,
  superseded_at?, trigger import|publish|correction)`: one live per class-term (partial unique);
  `class_ranking_rows (ranking_id, result_id, student_id, class_position, position_of)` with
  `class_position BETWEEN 1 AND position_of`; FKs to `results` and `enrolments`. `results` is
  untouched.
- **Imports.** `imports (kind past_results|opening_balances, file_hash ^[0-9a-f]{64}$,
  file_name, row_count 0–5000, rows jsonb ≤ 1 MB, errors jsonb, status previewed|committed|
  failed, academic_year_id, section_id?, class_id?, term_id?, due_on?, created_by,
  committed_by/at, error ≤ 2000)`: unique `(school_id, kind, file_hash) WHERE status =
  'committed'`; `(kind = 'past_results') = (section_id IS NOT NULL AND term_id IS NOT NULL)`;
  edges `previewed:committed`, `previewed:failed`; a `previewed` row expires after 24 h (status
  `failed`, error "expired"). `result_sheets.provenance manual|imported` + `import_id` with
  `(provenance = 'imported') = (import_id IS NOT NULL)`, both added to the frozen list;
  `result_sheets_born_draft` widened to admit `imported` + `published` (then `decided_by =
  published_by = importer`, `submitted_by NULL`). `charges.import_id` (frozen) with unique
  `(school_id, import_id, enrolment_id) WHERE import_id IS NOT NULL`.
- **Biometric.** `schools.device_token_hash` (`^[0-9a-f]{64}$`, unique where not null, in
  `NON_SCHOOL_LEADING_INDEXES`) + `device_token_rotated_at`; `staff.device_user_id varchar(40)`
  unique per school where not null (a `left` member keeps it; the office clears it to reuse).
  `device_punches (staff_id?, device_user_id, punched_at, direction in|out?, received_at)`
  append-only like `platform_audit_log`; unique `(school_id, device_user_id, punched_at)`; indexes
  `(school_id, punched_at)`, `(school_id, staff_id, punched_at)`. `staff_attendance` gains
  `source manual|device` (default `manual`), `device_punch_id?` FK, `marked_by` nullable with
  `(source = 'device') = (marked_by IS NULL) = (device_punch_id IS NOT NULL)`; the frozen list
  gains both; `staff_attendance_not_self` passes a NULL actor; new unique `(school_id, id,
  staff_id)`. `staff_attendance_disputes (attendance_id, staff_id, raised_by, requested_status,
  reason, status pending|approved|rejected, decided_by/at, decision_reason)`: FK `(school_id,
  attendance_id, staff_id)`; one pending per attendance row; edges `pending:approved`,
  `pending:rejected`; decider ≠ staff member and raiser = staff member (triggers, no
  sole-principal exception); indexes for Approvals, staff, decider.
- **Support.** `platform_support_sessions` (in `NON_TENANT_MODELS`, like `platform_audit_log`):
  `platform_user_id, school_id, reason ≤ 500, ticket_ref ≤ 40, opened_at, expires_at, closed_at?,
  revoked_at/by?`; unique `(school_id) WHERE closed_at IS NULL`; `opened_at < expires_at ≤
  opened_at + 24 h`; close, revoke and expiry all set `closed_at`; frozen except the two once-set
  groups; index `(expires_at) WHERE closed_at IS NULL`.
- **Audit.** Indexes `(school_id, created_at)`, `(school_id, action varchar_pattern_ops,
  created_at)`, `(school_id, actor_platform_user_id, created_at)`. `payslips (school_id, paid_on)
  WHERE paid_on IS NOT NULL` for the statement.

### 3.3 Pure functions (`packages/shared/src/`)

- `timetable/clashes.ts`: a version's slots → teacher, room, section and off-day clashes (the
  web and the app validate before submit; the API re-checks; the database holds the constraints).
- `reports/statement.ts`: `financialStatement(lines, basis, period)` → the R332 lines and net;
  table-tested against the Phase 3 identities.
- `results/ranking.ts`: `classRanking(rows)` → standard competition ranking by `percentBp`
  across sections, ties shared (reuses the Phase 4 position function).
- `imports/past-results.ts`, `imports/opening-balances.ts`: CSV parsing (≤ 2 MB, ≤ 5,000 rows,
  ≤ 64 columns, ≤ 64 chars per cell, UTF-8, header validated) and row validation with
  row-numbered errors.
- `attendance/punches.ts`: `markFromPunch(firstPunchAt, staffLateAfter | null)` → present | late.
- `csv.ts`: `toCsv(rows, columns)` with the injection prefix.
- `rule24.ts`: `DEFAULT_PASSWORD_INERT_ACTIONS` (action name → route) and the two inert keys.

### 3.4 Message types

`contract_expiring` (principals), `support_session_opened` and `support_session_closed`
(principals; who, why, until when, link to the audit screen), `attendance_disputed` (to
`attendance.staff.manage` holders), `attendance_dispute_decided` (to the staff member). All
in-app and email; push title-only; none SMS. Event invitations and cancellations are
announcements (category `event`) the event generates, so they reach families by the existing
routing with its dedupe. A school with no active principal gets the support notice in the
platform log only; the session still opens.

### 3.5 Jobs

`contract-expiry-warn` (daily 06:00 school time, `listLiveForFanOut`): live contracts ending in
≤ 30 or ≤ 7 days not yet warned. `support-session-expire` (every 5 min, platform): closes sessions
past `expires_at`, notifies through `runAsSchool`. `register-unrecorded` (Phase 2) gains the
timetable (R305). `charge-generate` (Phase 3) gains the transport rule in its daily catch-up
(R327). Import expiry folds into the staged-upload sweep.

### 3.6 Settings

`school_settings`: `required_document_types`, `contract_warning_days` (30, 1–90),
`staff_late_after` (time, null = never late), `financial_statement_basis` (received|verified).
`schools`: `device_token_hash`, `device_token_rotated_at` (through `OwnSchoolRepository`;
`SchoolSettingsDto.deviceTokenRotatedAt`, never the hash). `platform_settings`:
`support_session_hours` (4, 1–24).

### 3.7 Mobile

No new outbox lane: timetable, events, participation and disputes are online-only
(`ONLINE_ONLY_ACTIONS`). Teachers' Classes tab gains **Timetable** (the week) and **Events** (my
duties, participation); families' child screen gains the section timetable, events and
transport; the principal's Approvals gains **Disputes** and, for `document.verify` holders,
**Documents**. Secure screens: none new.

---

## 4. Schema, complete for Phase 5 — the schema-freeze checklist

§3.2 applies. **Migration order:** (1) `_phase5_enums` — every `ALTER TYPE … ADD VALUE`
(`message_type` ×5, `fee_head_category` `event` and `transport`) and nothing else; (2)
`_phase5_groundwork` — the new types (`event_type`, `event_status`, `duty_kind`,
`participation_status`, `contract_type`, `document_status`, `vehicle_status`,
`transport_route_status`, `import_kind`, `import_status`, `sheet_provenance`,
`staff_attendance_source`, `dispute_status`, `statement_basis`), the `schools`,
`school_settings` and `platform_settings` columns, `result_sheets.provenance/import_id`,
`charges.import_id`, `expenses.event_id`, `staff.device_user_id`, the `staff_attendance` changes,
the `student_documents` trigger swap and columns, the three seeded heads for every school
(`asms_seed_school_finance` redefined with per-category and per-name guards, plus a direct
backfill; `SEEDED_FEE_HEADS` in shared updated), the `fee_structures` category trigger, the
`audit_log` and `payslips` indexes, the `result_sheets_born_draft` widening; (3) one migration
per wave for its tables.

Per slice the tables are those of §3.2: 37 `timetable_versions`, `timetable_slots`,
`timetable_substitutions`; 38 `events`, `event_sections`, `event_duties`, `event_participation`;
39 `staff_contracts`; 40 the document columns (groundwork); 41 `vehicles`, `transport_routes`,
`transport_route_amounts`, `transport_stops`, `transport_assignments`; 42 `class_rankings`,
`class_ranking_rows`; 43 `imports`; 44 `device_punches`, `staff_attendance_disputes`; 45
`platform_support_sessions`.

**Not in Phase 5:** no rooms table, no PTM slot booking, no GPS, no school-group reports, no OCR,
no vendor agent, no guardian merge, no inbound WhatsApp matching, no applications, no iOS, no
support reads of messages. **Existing data touched:** three seeded heads per school (skipping a
school whose hand-made head collides by name), `student_documents.status = uploaded`,
`result_sheets.provenance = manual`, `staff_attendance.source = manual` with `marked_by` made
nullable (no row changes), new indexes built inside the migration transaction (fine at current
sizes). No money, result or attendance row is rewritten.

---

## 5. Slice plan

Estimates sum to 38 days. **Waves**: **R** = groundwork + 37 · **S** = 38 + 39 + 40 in parallel ·
**T** = 41 + 44 + 46 in parallel · **U** = 42 + 43 + 45 in parallel · **V** = 47. The groundwork
commit adds to `packages/shared` the enums, error codes, message types, the two keys (and
`document.verify` to the office defaults; the `capabilities.ts` header rewritten), the §3.3
functions, `IDEMPOTENT_ENDPOINTS` entries (`timetable_versions`, `timetable_substitutions`,
`events`, `event_payments`, `staff_contracts`, `transport_assignments`, `imports`,
`attendance_disputes`), migrations (1) and (2), the lint boundaries, the two mints and the
`@DeviceToken()` and `@DefaultPasswordInert()` access markers. Agents own disjoint files;
migrations, `app.module.ts`, `eslint.config.mjs`, `packages/shared`, `school-id.mint.ts`,
`route-access.ts` and `lanes.ts` are edited by the main thread. Phase 3/4 conventions
(`PageQueryDto` ≤ 50 with a stated sort, out-of-range 422, `ReasonDto`, `Idempotency-Key` on
creates with replay `200`, `404` outside scope, `403 PERMISSION_DENIED { reason }`, prints and
CSV behind `SameSitePrintGuard`, `me-reads` on every `/me/*` read, every `/me/children/:id/*`
with its `/me/student/*` twin) are not restated; the per-slice contracts supersede the shapes
below.

### 5.1 Groundwork: shared enums, codes, helpers, lint

Error codes (`409` unless stated; `details.<id>`):

| Code | Details | Raised by |
|---|---|---|
| `TIMETABLE_SLOT_CLASH` | `{ kind: teacher \| room \| section, weekday, period, conflictingSlotId }` | versions |
| `TIMETABLE_TEACHER_NOT_ASSIGNED`, `TIMETABLE_OFF_DAY`, `TIMETABLE_VERSION_SUPERSEDED`, `TIMETABLE_VERSION_NOT_FUTURE` | ids | versions (period range is `422 VALIDATION_FAILED` on `slots[i].period`) |
| `TIMETABLE_SUBSTITUTION_EXISTS`, `TIMETABLE_SUBSTITUTION_NOT_TIMETABLED`, `TIMETABLE_SUBSTITUTION_SAME_TEACHER` | `sectionId, date, period` | substitutions |
| `403 PERMISSION_DENIED { reason: not_timetabled_period, period }` | | attendance (R304) |
| `EVENT_NOT_DRAFT`, `EVENT_NOT_PUBLISHED`, `EVENT_NO_SECTIONS`, `EVENT_DUTY_EXISTS { dutyId }`, `EVENT_PAYMENT_EXCEEDS_CHARGE { outstanding }`, `EVENT_NO_CHARGE` | `eventId` | events (completed → `ILLEGAL_STATUS_TRANSITION`) |
| `STAFF_CONTRACT_LIVE_EXISTS { contractId }`, `STAFF_CONTRACT_ENDED`, `STAFF_CONTRACT_END_REQUIRED` (`422`, field `endsOn`) | `staffId` | contracts |
| `DOCUMENT_ALREADY_DECIDED { documentId, status }` | | verification |
| `VEHICLE_RETIRED`, `VEHICLE_IN_USE { routeId }`, `TRANSPORT_ROUTE_ARCHIVED`, `TRANSPORT_ROUTE_HAS_ASSIGNMENTS`, `TRANSPORT_ASSIGNMENT_LIVE { assignmentId }`, `TRANSPORT_AMOUNT_PERIOD_PAST` | ids | transport |
| `IMPORT_DUPLICATE_FILE { importId }`, `IMPORT_NOT_PREVIEWED`, `IMPORT_ROWS_INVALID { rows: [{ row, field, code }] ≤ 100, errorCount }` (`422`), `IMPORT_SHEET_EXISTS`, `IMPORT_MARKS_EXIST`, `IMPORT_YEAR_CLOSED`, `IMPORT_EXPIRED` | `importId` | imports |
| `DEVICE_TOKEN_INVALID` (`401`), `ATTENDANCE_DISPUTE_PENDING_EXISTS { disputeId }`, `ATTENDANCE_DISPUTE_NOT_PENDING { status }` | | biometric (unmapped, duplicate, inactive are per-punch outcomes, not errors) |
| `SUPPORT_SESSION_OPEN { sessionId }`, `SUPPORT_SESSION_ENDED { reason: expired \| revoked \| closed }` (`403`), `SUPPORT_WRITE_REFUSED` (`403`), `SUPPORT_SESSION_LIMIT` | | support |
| reused: `SELF_ACTION_FORBIDDEN { reason: own_child \| own_attendance \| own_upload \| submitter }`, `ILLEGAL_STATUS_TRANSITION`, `CONCURRENT_UPDATE`, `REFERENCE_NOT_FOUND`, `ACADEMIC_YEAR_CLOSED`, `DEFAULT_PASSWORD_BLOCKS_ACTION`, `PERMISSION_DENIED`, `SCHOOL_TERMINATED`, `STALE_STATUS` | | |

Throttles (per user, `perUserThrottle`): reuse `me-reads`, `print`, `upload`,
`attendance-writes`, `finance-reports`, `result-reports`, `claim-writes`; new `timetable-writes`
30/300, `event-writes` 30/300, `import-writes` 5/30, `dispute-writes` 20/120, `staff-reports`
30/300, `audit-reads` 60/600, `support-reads` 120/2000 per platform user; `device-punches` 600/h
**per school** after token resolution plus a per-IP bad-token bucket 10/min with lockout; CSV
costs 5 in its family bucket.

Lint: each new repository confined to its module as §2; `SupportReadsRepository` and
`SupportSessionRepository` importable only from `src/modules/platform/support/**` and the expiry
job; `schoolIdFromSupportSession` only from that module; `DeviceTokenRepository` and
`schoolIdFromDeviceToken` only from the device-punch service; a fixture plants a write-repository
import in the support module and a tenant-repository import in the device service.

### Slice 37 — Period timetable (≈ 6 days)

| Method and path | Access | Request | Response |
|---|---|---|---|
| `GET /sections/:id/timetable?date=` | staff | default today | `TimetableDto { version, slots[], substitutions[] }` for that week, the version live on each day |
| `GET /me/children/:id/timetable`, `GET /me/student/timetable` | family | `date?` | `MyTimetableDto` (family DTO, §1.1) |
| `GET /me/staff/timetable?weekOf=` | staff | one week | the caller's slots and substitutions across sections |
| `GET /timetable-versions?sectionId&academicYearId&status=live\|future\|past\|voided` | `timetable.manage` | page, sort `-effectiveFrom` | page of `TimetableVersionDto` |
| `GET /timetable-versions/:id` | `timetable.manage` | | `TimetableVersionDto` with slots |
| `POST /sections/:id/timetable-versions` + key | `timetable.manage` | `CreateTimetableVersionDto { effectiveFrom ≥ today, slots[] \| copyFromVersionId }` (both → 422) | `201`; whole-week replace; clashes 409; supersedes the live version from `effectiveFrom` |
| `POST /timetable-versions/:id/void` | `timetable.manage` | `ReasonDto` | only a future version; restores the predecessor's `effective_to`; re-checks clashes (`TIMETABLE_SLOT_CLASH` if another section took the slot meanwhile) |
| `POST /sections/:id/timetable-substitutions` + key | `timetable.manage` | `{ date, period, staffId, reason }` | `201`; not the slot's own teacher, a teaching day, a timetabled period, past dates only inside the amend window |
| `GET /timetable-substitutions?sectionId&from&to` | `timetable.manage` | page, sort `-date` | |
| `POST /timetable-substitutions/:id/void` | `timetable.manage` | `ReasonDto` | |
| `GET /timetable/grid?academicYearId&weekday` | `timetable.manage` | | `TimetableGridDto` (bounded: sections × periods) |
| `GET /attendance-registers?date&recorded=false` (existing) | existing | | `SectionDayDto` gains `periods[{ period, subjectName, teacherName, recorded }]` in period mode |
| `LeaveRequestDto` (existing) | | | keeps `sectionsNeedingCover`, **adds** `periodsNeedingCover[{ date, period, sectionName, subjectName }]` |

**Behaviour:** R304 — in period mode, when the section has a version live on the register's
`date`, a subject teacher's register write for `(section, date, period)` needs that version's
slot or a substitution naming them for that weekday and period; without a live version, Phase 2
R120 stands; class teacher, cover and `all` scope unchanged; daily mode unchanged. R305 — the
`register-unrecorded` job lists, per section with a live version, the timetabled periods without
a register; a slot whose teacher's assignment has ended shows "no assigned teacher" in the push.
**Screens:** web Timetable (week-grid editor with clash highlighting from the shared function,
versions list, substitutions, the principal's grid); mobile teacher week and family view.
**Tests:** R301–R309; isolation; Maestro `teacher-timetable`.

### Slice 38 — Events and PTM (≈ 5.5 days)

| Method and path | Access | Request / response |
|---|---|---|
| `GET /events?academicYearId&type&status&startsFrom&startsTo` | staff; drafts only for `holiday.manage` | page, sort `-startsAt`; `EventDto { …, sections[], duties[], announcementId, campaignId, campaignStatus }` |
| `GET /me/children/:id/events`, `GET /me/student/events` | family | page, `-startsAt`; `MyEventDto` (published events of the child's sections; no duties, no amounts beyond the child's own charge) |
| `POST /events` + key | `holiday.manage` (+ campaign keys when `charge` is set) | `CreateEventDto { type, title, startsAt, endsAt, venue, details?, sectionIds[], charge?: { amount, dueOn? ≥ today } }` → `201` |
| `PATCH /events/:id` | `holiday.manage` | `UpdateEventDto` (same fields; `sectionIds` replaces the set); draft only |
| `POST /events/:id/duties` | `holiday.manage` | `AddEventDutyDto { staffId, duty, note? }` |
| `POST /event-duties/:id/end` | `holiday.manage` | `ReasonDto` |
| `POST /events/:id/publish` | `holiday.manage` (+ campaign keys) | no body; creates the announcement (category `event`, audience = sections) and, with a charge, the campaign; both enqueued after commit |
| `POST /events/:id/cancel` | `holiday.manage` (+ `charge.create`; principal when any charge has allocations) | `ReasonDto`; §1.1 "Cancel with money"; a cancellation announcement |
| `POST /events/:id/complete` | `holiday.manage` | no body; freezes participation |
| `GET /events/:id/participation` | duty holder / section class teacher / `holiday.manage` | bounded roster |
| `POST /events/:id/record-participation` | duty holder / section class teacher | `RecordEventParticipationDto { rows: [{ studentId, status }] }`; published only; naturally idempotent |
| `POST /events/:id/payments` + key (`event_payments`, path id the student) | `collection` duty on this event, or `payment.record` | `{ studentId, amount, receivedOn, reference? }` → `201 PaymentDto`; cash; settles only the student's open charge of the event's campaign (`PaymentsService.recordForEvent`); remainder refused; own child refused without exception |
| `GET /events/:id/payments` | the duty holder (own rows) / `payment.record` | page, `-receivedOn` |
| `GET /events/:id/report` | `finance.report.view` or `holiday.manage` | `EventReportDto { participants, collections, expenses, net }` (published or completed; live, not a snapshot) |
| `POST /expenses/:id/tag-event` | `expense.record` | `{ eventId }`; expense not voided, event published or completed; audited |
| `GET /payments?eventId=`, `GET /charges?campaignId=`, `GET /expenses?eventId=` (existing) | existing | read filters |

**Tests:** R310–R317; the duty scope matrix; isolation; Playwright; Maestro `teacher-event-duty`.

### Slice 39 — Staff contracts (≈ 2.5 days)

`GET /staff/:id/contracts` (page, `-startsOn`), `POST /staff/:id/contracts` + key
(`CreateStaffContractDto { type, startsOn, endsOn?, salaryStructureId?, stagedUploadId?, note? }`),
`POST /staff-contracts/:id/end { endedOn, reason }`, `POST /staff-contracts/:id/renew`
(`CreateStaffContractDto` for the next; ends the current on its `ends_on` with reason `renewed`),
`GET /staff-contracts/:id/document` (streamed under `staff.contract.manage`, never presigned,
R43), `GET /me/staff/contract` (`MyStaffContractDto { current | null }`, no note, no structure id;
own document streamed). "End employment" ends the live contract in the same transaction. The job,
the dashboard tile "contracts ending in 30 days" linking to end employment, the message.
**Tests:** R318–R321.

### Slice 40 — Document verification (≈ 2 days)

`GET /documents?status=uploaded&type&classId` (page, sort `createdAt`), `POST /documents/:id/verify`
(no body), `POST /documents/:id/reject` (`ReasonDto`), `GET /documents/incomplete-admissions?
admittedFrom&admittedTo` (page, `admittedOn`, default last 90 days, CSV), `PATCH /school/settings {
requiredDocumentTypes }`; `StudentDocumentDto` gains `status, decidedAt, decidedByName,
rejectReason` (staff) — the family DTO carries status only; `GET /me/approvals` gains
`documents?` for `document.verify` holders. Student page Documents tab shows the checklist; a query
badge on the student list. **Tests:** R322–R325.

### Slice 41 — Transport (≈ 4.5 days)

`GET/POST /vehicles` (page, `registration`; `+ key`), `PATCH /vehicles/:id`, `POST
/vehicles/:id/retire`; `GET/POST /transport-routes` (page, `name`), `PATCH /transport-routes/:id {
name?, vehicleId?, stops?: [{ sortOrder, name, pickupTime? }] }` (stops replaced as a whole;
removal needs `reason`), `POST /transport-routes/:id/amounts { amount, effectivePeriod ≥ next }`,
`POST /transport-routes/:id/archive`; `GET /transport-routes/:id/assignments?includeEnded` (page,
`studentName`), `POST /transport-routes/:id/assignments` + key (`{ studentId, stopId?, startsOn }`),
`POST /transport-assignments/:id/end { endedOn, reason }`, `GET /students/:id/transport`;
`GET /me/children/:id/transport`, `GET /me/student/transport` (`MyTransportDto`: route, stop,
pickup time, driver name); `GET /me/staff/transport-routes` (`MyDriverRouteDto[]`: the routes
whose vehicle names the caller as driver, each with student names and stops). Charge generation
per §1.1 in the daily run under the generated-charge key on the Transport head; promotion apply
and withdrawal end live assignments. **Tests:** R326–R331 incl. the identity in the R228 year.

### Slice 42 — Reporting, rankings and CSV export (≈ 5 days)

`GET /finance-reports/financial-statement?from&to | termId | academicYearId &basis` →
`FinancialStatementDto` (bounded); `GET /result-reports/merit-list?classId&termId` (page, sort
`position`, `MeritListRowDto`, reads the live ranking; "ranking pending" when a section is not yet
published) with the ranking computed in `ResultSheetsService.publish` (last section of the
class-term, counting sections with a live enrolment on the term's last day and `not_held` classes
as none), in the correction cascade and in the import; `GET /students/:id/profile`
(`StudentProfileDto`: attendance %, latest result, dues, documents, transport); `GET
/staff-reports/summary` (page, `staffName`: attendance %, leave taken, contract status incl.
"expired, not ended", ending within 60 days); `GET /attendance-reports/discrepancies?from&to ≤ 92
days` (page, `-date`: a student marked present and absent in different periods of one day with no
arrival record, and registers amended more than once); the event report (38) and incomplete
admissions (40). Every report accepts `format=csv` (page/limit refused with it) and the web adds
Download on every report tab including Phase 3's. **Tests:** R332–R338; the statement reconciles
with the Phase 3 reports over the scripted year.

### Slice 43 — Commencement imports (≈ 3.5 days)

Files go through `POST /uploads` (CSV branch: `text/csv` ≤ 2 MB, capability widened). `POST
/imports/past-results { stagedUploadId, sectionId, termId }` (`result.publish` +
`assessment.define`) and `POST /imports/opening-balances { stagedUploadId, academicYearId, dueOn }`
(`charge.create` + principal, rule-24 inert) → `201 ImportDto` (status `previewed`, rows ≤ 5,000,
errors ≤ 100 + `errorCount`), keyed; `POST /imports/:id/commit` + key → `200 ImportDto`; `GET
/imports?kind&status` (page, `-createdAt`), `GET /imports/:id`. Commit: past results create the
exams if missing (held on the term's last day), marks, the sheet born `published` with provenance
`imported`, results by the shared functions with exam weight 100 %, the class ranking if the class
is complete, no message; opening balances one manual charge per row under the seeded head (an
existing advance applies, shown in the preview). Web Imports page with the preview table and row
errors. **Tests:** R339–R343.

### Slice 44 — Biometric staff attendance (≈ 2.5 days)

`POST /school/device-token/rotate` (`school.settings.manage`, rule-24 inert; → `DeviceTokenDto {
token, rotatedAt }` once); `POST /device-punches` (`@DeviceToken()`, in OpenAPI under tag
`device`; `DevicePunchBatchDto { punches ≤ 500 }` → always `200 DevicePunchBatchResultDto {
results: [{ deviceUserId, punchedAt, outcome: marked | stored | unmapped | duplicate | inactive,
staffAttendanceId }] }`; `punchedAt` within −7 days … +5 min); `PATCH /staff/:id { deviceUserId }`
(`attendance.staff.manage`, not own); `GET /device-punches?date&staffId&unmapped` (page,
`punchedAt`); `POST /me/staff/attendance-disputes` + key, `GET /me/staff/attendance-disputes`,
`POST …/:id/withdraw`; `GET /staff-attendance-disputes?status=pending&staffId` (page,
`-createdAt`), `POST …/:id/approve { reason? }`, `POST …/:id/reject { reason }`;
`MyStaffAttendanceDto` and `StaffDayDto` rows gain `disputeId, disputeStatus`, the day view shows
a stored punch beside an existing mark as a conflict; Approvals gains **Disputes**. **Tests:**
R344–R348.

### Slice 45 — Platform support access (≈ 3 days)

Platform: `POST /platform/schools/:id/support-sessions { reason, ticketRef }` (`full` + step-up
TOTP) → `201 SupportSessionDto`; `GET /platform/support-sessions?schoolId&status` (page,
`-openedAt`), `GET …/:id`, `POST …/:id/close { reason? }`; the views `GET
/platform/support-sessions/:id/settings`, `…/students?admissionNo=`, `…/students/:studentId`,
`…/students/:studentId/charges`, `…/students/:studentId/payments`, `…/audit-log` (filters as
slice 46), each `SupportSessionGuard`-ed (open, owned by the caller else 404, ended → 403) and
read through `SupportReadsRepository` under `READ ONLY`. School: `GET /school/support-sessions`
(principal; page, `-openedAt`), `POST /school/support-sessions/:id/revoke { reason }`; `MeDto`
gains `supportSession: { id, reason, expiresAt } | null`; the web banner; the two messages; the
expiry job. **Tests:** R349–R353.

### Slice 46 — Audit screen and rule 24's reach (≈ 2 days)

`GET /audit-log?actorUserId | subjectType+subjectId | createdFrom+createdTo (≤ 92 days) &actionPrefix`
(`audit.view`; page, `-createdAt`; `AuditEntryDto`), `GET /audit-log/:id`; web Audit page with
filters and subject links. Rule 24: `@DefaultPasswordInert()` on the R355 routes; the two
`holdsNominally` call sites (`staff-status.service.ts`, `teacher-assignments.service.ts`) read
`holds`; `MeDto.blockedActions`. **Tests:** R354–R357.

### Slice 47 — Phase close (≈ 1.5 days)

Whole-phase `security-reviewer` (§7.1), `performance-engineer` (§7.2), `business-rules` on the
scripted term (R357), `code-quality`, `docs-maintainer`; CLAUDE.md gains exception 7, the widened
exception 4, the 53-key count and the lint sites; `phase-gate`; WORKLOG with what go-live needs.

---

## 6. Open items Phase 5 must not pre-empt

| Item | Phase 5 stance |
|---|---|
| Guardian merge, inbound WhatsApp matching, application intake, iOS | Deferred to after go-live (rule 32) |
| School-group reports (item 38); support reads of messages (item 41) | Not built |
| PTM slot booking, rooms table, GPS | Not built |
| 22 SMS allow list, 23 late arrival, 26 remark visibility | Phase 2 defaults stand |
| Real-driver proof | Owner-blocked, go-live precondition ("Left to do" item 1) |
| Vendor agent for biometric devices | Not ours (item 39) |

---

## 7. Security-sensitive points and performance budgets

### 7.1 Security (the whole-phase review checks each)

- **Support sessions**: §3.1 in full — the closed repository, `READ ONLY`, the query guard, lint,
  step-up TOTP, the per-user cap, ownership, both audit logs with subject ids, no identity columns
  selected, no files, no messages, open/close/revoke outside the support context.
- **Device punches**: token hashed, shown once, rotatable, on the school row; the route has no
  session and takes no tenant from the client; per-school and per-IP throttles with lockout; 401
  does not distinguish unknown from rotated; punches append-only with the replay unique; bounded
  ids and body; a punch never carries a name; a punch never amends an existing mark.
- **Event money**: the duty route reaches one charge of one campaign while the event is
  published; cash only; own child refused; custody and handover as Phase 3; `/payments/*` stays
  refused to the officer.
- **Timetable**: the family DTO carries names only; substitution reasons are staff-visible.
- **Imports**: bounded parser; admission numbers only; rows stored on the import row ≤ 1 MB and
  expired after 24 h; the committed-file hash prevents replay; commit idempotent by key;
  opening balances rule-24 inert; echoed cell text rendered as text.
- **CSV**: injection prefix; `<family>.exported { report, filters, rowCount }` audited; cost 5;
  same-site guard; the R16 scan runs over every CSV fixture.
- **Audit screen**: the access family excluded; inert on a default password; phone and email
  shapes masked besides identity; `GET /audit-log/:id` 404 outside the school.
- **Contracts and documents**: contract scans streamed under `staff.contract.manage` only;
  verifier ≠ uploader; reject reason internal.
- **R57** audit actions: `timetable_version.created|voided`, `timetable_substitution.created|voided`,
  `event.created|updated|published|cancelled|completed`, `event_duty.added|ended`,
  `event_participation.recorded`, `event_payment.recorded`, `expense.event_tagged`,
  `staff_contract.created|renewed|ended|document_viewed`, `document.verified|rejected`,
  `vehicle.*`, `transport_route.*`, `transport_amount.set`, `transport_assignment.started|ended`,
  `transport.capacity_exceeded`, `class_ranking.computed`, `<family>.exported`, `import.previewed|
  committed|failed`, `device_token.rotated`, `staff.device_user_set`, `device_punch.rejected`
  (count), `attendance_dispute.*`, `support_session.opened|closed|revoked|expired` (both logs),
  `support.read` (both logs, with subject ids), `audit.viewed` (once per actor per day).

### 7.2 Performance budgets (3,000 students, 200 staff, 6 years)

| Operation | Budget |
|---|---|
| Section timetable read (family) | ≤ 100 ms |
| Register write with the R304 check | +≤ 20 ms over Phase 2 |
| Unrecorded-periods job per school | ≤ 2 s |
| Event publish (announcement + campaign for 300 students) | ≤ 1 s request; the fan-out stays in the job |
| Financial statement over a year | ≤ 1.5 s |
| Class ranking of 5 sections at publish | ≤ 500 ms added to the publish |
| Past-results import commit, 60 rows × 12 subjects | ≤ 3 s |
| Punch batch of 200 | ≤ 500 ms |
| Audit screen page | ≤ 300 ms |
| Transport charges in the daily run | +≤ 10 % on the Phase 3 generation budget |
| Support view | ≤ 300 ms incl. the two audit rows |

---

## 8. Numbered rules (each is a test)

**Timetable**
- R301 Versions are date ranges; a new version (`effective_from` ≥ today, inside the year)
  closes the live one the day before; a future version can be voided, which restores its
  predecessor and re-checks clashes; the version live on a day is the one whose range holds it.
- R302 Clashes refused by the database and the service: a teacher in two sections in one period
  of overlapping ranges, a room twice, two slots in one section-period, a period beyond
  `periods_per_day`, a slot on a weekly-off day.
- R303 A slot's teacher must hold a live assignment for that subject and section on
  `effective_from`; an ended assignment does not delete the slot — the grid and the R129 push say
  "no assigned teacher".
- R304 In period mode, with a version live on the register's date, a subject teacher's write
  needs that version's slot or a substitution naming them for the weekday and period
  (`PERMISSION_DENIED not_timetabled_period`); without a live version R120 stands; class teacher,
  cover and `all` scope unchanged; daily mode unchanged.
- R305 `register-unrecorded` lists timetabled periods without a register for sections with a
  live version; others fall back to Phase 2.
- R306 A substitution is one date and period, not the slot's own teacher, on a teaching day; the
  substitute may mark that register without an assignment; a void restores the regular teacher;
  a cover and a substitution may both mark.
- R307 Leave approval shows `periodsNeedingCover` from the teacher's slots across the leave dates;
  `sectionsNeedingCover` is unchanged.
- R308 Families read their child's section through the family DTO (no staff ids, reasons or
  version ids); staff read any section; the grid is `timetable.manage`.
- R309 A week that spans two versions shows each day's own version.

**Events**
- R310 An event names sections of its year; publish creates the announcement to those sections
  and, with a charge, the campaign (due ≥ today, default the event date; `apply_concessions`
  false), both after commit; a charge needs the campaign keys.
- R311 A duty holder reaches only their event's participation and payments; another event is
  404; `/payments/*` without `payment.record` is 403.
- R312 Participation is per student over the §1.1 roster, editable while published, frozen at
  completion.
- R313 Cancel voids unallocated charges with the reason, writes a full adjustment for allocated
  ones (the money becomes the child's advance), needs the principal when any charge is allocated,
  and sends a cancellation announcement; no cash moves.
- R314 The event report's collections = Σ live allocations to the campaign's charges; expenses =
  Σ `recorded | approved` expenses tagged to the event; net is the difference; a late bill tagged
  after completion appears.
- R315 Families see published events of their child's sections only.
- R316 Status edges as §3.2; completed is frozen; content edits only while draft.
- R317 An event payment settles only that student's open event charge, cash only, remainder
  refused, own child refused, receipt and custody as Phase 3.

**Contracts, documents**
- R318 One live contract per staff member; permanent has no end; ending needs a reason; renew
  ends and opens in one transaction; end employment ends the contract.
- R319 The job warns at ≤ 30 and ≤ 7 days, once each, to every principal, in school time.
- R320 Expiry changes nothing by itself (rule 35); a contract past `ends_on` and not ended is
  flagged on the staff report.
- R321 A contract references the structure at its start and carries no pay; its scan is streamed
  only under `staff.contract.manage` or to its owner.
- R322 Verify/reject by `document.verify`, never the uploader; reject needs a reason; a decided
  document is final; a re-upload is a new `uploaded` row.
- R323 The checklist reads the newest row per required type; the incomplete-admissions report
  lists students missing, awaiting or rejected on any required type, filtered by admission date.
- R324 Verification never blocks admission or any status change.
- R325 Office staff hold `document.verify` by default from the groundwork (the test reads the
  shared defaults).

**Transport**
- R326 One live assignment per student per year; a change is close-old/open-new; ending needs a
  reason; a section change in the month yields exactly one transport charge.
- R327 The daily run charges the period's route amount under the Transport head for a student
  assigned on or before the cut-off day, once per student-period; an end mid-month is charged in
  full; a left enrolment is not charged; an amount change applies from the next period.
- R328 Transport charges obey concessions naming the head and the Phase 3 identities (R228's
  year gains a route); no family rate.
- R329 A retired vehicle or archived route takes no new assignment; archiving with live
  assignments is refused; a structure on a transport or event head is refused.
- R330 The driver reads the routes whose vehicle names them (names and stops only); families see
  their child's route, stop, pickup time and driver name.
- R331 Capacity over-assignment warns and is audited, never blocks.

**Reports, rankings and imports**
- R332 The financial statement on `received`: receipts = Σ non-voided payments by `received_on`
  excluding `carried_forward`, plus `refund_reversal`s, minus refunds; expenses = Σ `recorded |
  approved` expenses by `spent_on`, the cash-shortfall write-offs as their own line; staff = Σ
  `paid` payslip net by `paid_on` plus advances paid (from `salary_advances`), recoveries shown;
  on `verified` the verified/decided-date view; net = receipts − refunds − expenses − staff; both
  reconcile with the Phase 3 collections report over the scripted year.
- R333 The class ranking is computed when the last section of a class-term publishes, after a
  correction cascade and after an import, as a new version superseding the old; `results` rows
  are untouched; the merit list reads the live ranking; the card keeps the section position.
- R334 The student profile shows attendance %, the latest result, dues, documents and transport
  for a student in the caller's scope; 404 outside.
- R335 The discrepancy report lists the §5 slice 42 definition over ≤ 92 days.
- R336 Every report's CSV has exactly the rows and columns shown, ≤ 10,000, injection-safe, with
  a fixed file name, audited, costing 5 in its bucket.
- R337 The staff report lists attendance %, leave taken, contract status and contracts ending
  within 60 days.
- R338 Report routes are 404 outside scope and 403 without the key.
- R339 Preview parses within bounds, validates every row (unknown or non-roster admission number,
  roster student missing, duplicate, over max, bad `Ab`, amount ≤ 0, no live enrolment) and
  stores the rows on the import; nothing else is written; a preview expires in 24 h.
- R340 Commit is one transaction: exams created if missing on the term's last day, marks, the
  sheet born `published` with provenance `imported` (`decided_by` = importer, no submitter),
  results with exam weight 100 %, the ranking; no message; refused by `IMPORT_SHEET_EXISTS` or
  `IMPORT_MARKS_EXIST`.
- R341 A committed file's hash is refused a second time; commit is idempotent by key.
- R342 Opening balances are manual charges under the seeded head, due on the file's `dueOn`,
  never late-fee'd, visible to defaulters, statements and reminders, payable at the counter; an
  existing advance applies.
- R343 Imported results appear in rankings and profiles and are flagged "imported" on the card.

**Biometric, support, audit, rule 24**
- R344 A punch with a bad token is 401; the token is hashed and shown once; rotation invalidates
  the old one; the rotate verb is rule-24 inert.
- R345 The first punch of a teaching day for a mapped, active staff member with no mark marks
  present or late (source `device`, no actor); later punches, non-teaching days, existing marks,
  unmapped and inactive ids are stored with their outcome and never marked; a replay is
  `duplicate` by the unique.
- R346 A dispute needs a reason from the staff member's own login; the decider is not the staff
  member (trigger and service, no exception); approval amends through the Phase 2 path with the
  current status as `fromStatus`; a no-op is approved with audit.
- R347 Disputes appear in Approvals for `attendance.staff.manage` holders.
- R348 The punch route carries no session and no tenant from the client; the token resolves the
  school through `schoolIdFromDeviceToken`; per-school and per-IP throttles hold.
- R349 One open session per school, ≤ 3 per platform user, opened with reason, ticket and a fresh
  second factor; expires at the platform setting; the principal is told on open and close and may
  revoke; logout closes.
- R350 Every support read writes a `platform_audit_log` and an `audit_log` row with the session
  id and subject ids; a planted write is refused by the query guard and by the `READ ONLY`
  transaction; lint refuses the import.
- R351 Support views never select identity columns, never serve files or messages; a student
  lookup is by admission number; lists are ≤ 50.
- R352 An expired, revoked or closed session answers 403 on the next request; another admin's
  session is 404.
- R353 The two new constructors are importable only from their sites.
- R354 `audit.view` is grantable, principal by default, inert on a default password; the screen
  filters as §1.1, excludes the access family, never shows an identity, phone or email.
- R355 A default-password user is refused, with `DEFAULT_PASSWORD_BLOCKS_ACTION`, on: payment
  refund, void and reverse-refund; payment-account create, update and archive; payroll finalise
  and mark-paid (run and slip); salary-advance grant and approve; expense approve and payee change;
  cash-handover confirm and resolve-shortfall; charge void and waive; the dues-clearance override;
  opening-balance imports; device-token rotate; the audit screen. The list is data and the test
  snapshots the decorated routes.
- R356 The staff-status and assignment overrides read effective holdings; a default-password
  principal cannot suspend another principal.
- R357 The scripted Phase 5 term (timetable with a mid-term version change and a substitution, an
  event with a charge and one cancellation after payment, a contract renewal and an expiry, a
  route with a section change and an amount change, both imports, punches with every outcome, a
  support session) holds every identity above and every message count.

---

## 9. Definition of done for the phase

CLAUDE.md's Definition of Done, plus: R301–R357 each have a named test; the scripted term (R357)
runs end to end; direct-write tests prove each trigger and exclusion constraint;
`contract_expiring`, the event invitation and the support messages are proven to a keypad, a
WhatsApp and a smartphone recipient where families are involved; Maestro `teacher-timetable` and
`teacher-event-duty` pass on CI; every web screen has its four states at 1280 px and tablet
(`responsive.spec` gains every Phase 5 route); CLAUDE.md gains exception 7, the widened exception
4 and the key count; WORKLOG says what go-live needs; CI green.

## 10. What go-live will need from Phase 5

- The real-driver proof ("Left to do" item 1) — still the one owner-blocked precondition.
- Price tiers entered on the platform (Phase 3).
- A vendor agent for biometric devices, if a school wants them (item 39).
- The four deferred items (rule 32) specified and planned as "Phase 6" if ever wanted.
