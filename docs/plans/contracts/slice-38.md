# Slice 38 contracts — events and PTM

**Author:** Opus 5.5 (wave S), 2026-10-10. **Binds:** `apps/api/src/modules/events/**`,
`repositories/event.repository.ts`, `PaymentsService.recordForEvent`, `CampaignsService.createForEvent`
/ `cancelForEvent`, `ChargesService.settleCancelledCampaign`, `AnnouncementsService.sendEventNotice`,
`ExpensesService.tagEvent`, the read filters `GET /payments?eventId=`, `GET /charges?campaignId=`,
`GET /expenses?eventId=`, the own-handover gate of `POST /me/staff/cash-handovers`, the
`eventNoticeText` / `eventCancellationText` templates; the web pages under `/events`; the phone's
Classes → **Events** and the family child screen's **Events**. **Source:** `phase-5-extended.md`
§0.32, §0.38, §1.1 (rule 34 rows), §1.2 item 37, §1.3 A4–A5, §2, §3.1, §3.2 "Events", §3.4,
§5 slice 38, §7.1 "Event money", R310–R317; migrations `20261010090000_wave_s_events_contracts`
and `20261010090100_wave_s_cancel_notice_check`. Everything not restated follows the Phase 1–4
conventions (envelope, string ids, `PageQueryDto` ≤ 50, `NoQueryDto`, `@ApiErrors()`, `404` outside
the caller's scope, `Idempotency-Key` on creates with replay `200` + `Idempotency-Replayed`,
`ReasonDto`, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /events` | staff | page of `EventDto`; filters `academicYearId`, `type`, `status`, `startsFrom`, `startsTo` (dates, school time), `mine` (§2.9); sort `-startsAt` (default), `startsAt`. Drafts only for `holiday.manage` holders (a non-holder asking `status=draft` gets an empty page) |
| `GET /events/:id` | staff | `EventDto`; a draft is `404` without `holiday.manage` |
| `POST /events` + key (`events`, path id the academic year) | `holiday.manage` (+ `charge.create` and `charge.campaign.send` when `charge` is set) | `CreateEventDto` → `201 EventDto` (§2.1) |
| `PATCH /events/:id` | `holiday.manage` (+ the campaign keys when `charge` is in the body) | `UpdateEventDto`; draft only (§2.2) |
| `POST /events/:id/duties` | `holiday.manage` | `AddEventDutyDto { staffId, duty, note? }` → `201 EventDutyDto` (§2.3) |
| `POST /event-duties/:id/end` | `holiday.manage` | `ReasonDto` → `200 EventDutyDto`; a repeat answers `200` unchanged |
| `POST /events/:id/publish` | `holiday.manage` (+ the campaign keys when charged) | no body → `200 EventDto` (§2.4) |
| `POST /events/:id/cancel` | `holiday.manage` (+ `charge.create` when a campaign exists; the principal when any charge has money on it) | `ReasonDto` → `200 EventDto` (§2.5) |
| `POST /events/:id/complete` | `holiday.manage` | no body → `200 EventDto`; freezes participation |
| `GET /events/:id/participation?sectionId=` | staff; scope §2.6 | `EventRosterDto` |
| `POST /events/:id/record-participation` | staff; scope §2.6 | `RecordEventParticipationDto { rows[1..500] { studentId, status } }` → `200 EventRosterDto` |
| `POST /events/:id/payments` + key (`event_payments`, path id the student) | staff; a live `collection` duty on this event, or `payment.record` | `CreateEventPaymentDto { studentId, amount, receivedOn, reference? }` → `201 PaymentDto` (§2.7) |
| `GET /events/:id/payments` | staff; a `collection` duty on this event (own rows) or `payment.record` (all) | page of `PaymentDto`, `-receivedOn` |
| `GET /events/:id/report` | `finance.report.view` \| `holiday.manage` | `EventReportDto` (§2.8) |
| `POST /expenses/:id/tag-event` | `expense.record` | `TagExpenseEventDto { eventId }` → `200 ExpenseDto` (§3.4) |
| `GET /me/children/:id/events`, `GET /me/student/events` | guardian / student | page of `MyEventDto`, `-startsAt` (§2.10) |
| `GET /payments?eventId=`, `GET /charges?campaignId=`, `GET /expenses?eventId=` (existing) | existing | read filters (§3.5) |

Writes share the per-user bucket `event-writes` (30/min, 300/h). Family reads use `me-reads`.

### DTOs

- `EventChargeInputDto { amount: 1..MAX_RUPEES, dueOn?: date }`.
- `CreateEventDto { academicYearId, type, title 1–120, startsAt, endsAt (date-time), venue 1–120, details? 1–1000 (line breaks kept), sectionIds[0..100], charge? }` — text is notice text (no identity number, no phone number).
- `UpdateEventDto` — every field optional except `academicYearId` (absent); `sectionIds` replaces the set; `charge: null` removes the charge.
- `EventDto { id, academicYearId, academicYearName, type, title, startsAt, endsAt, venue, details, status, charge { amount, dueOn } | null, sections[{ sectionId, sectionName, classId, className }], duties: EventDutyDto[], announcementId, cancelAnnouncementId, campaignId, campaignStatus, createdByName, createdAt, completedAt, cancelledAt, cancelReason, myDuties: DutyKind[] }` — `duties` holds every live and ended duty for a `holiday.manage` holder and only the caller's own otherwise (rule 34); `charge.dueOn` is the stored due date, or the event's date in school time when none was given.
- `EventDutyDto { id, eventId, staffId, staffName, duty, note, createdAt, endedAt, endReason }`.
- `EventRosterDto { eventId, status, rows: EventRosterRowDto[] }`; `EventRosterRowDto { studentId, enrolmentId, fullName, admissionNo, rollNo, sectionId, sectionName, className, participation: ParticipationStatus | null, recordedAt, charge { chargeId, amount, outstanding, status } | null }`.
- `EventReportDto { eventId, title, status, participants { roster, attended, absent, excused, unrecorded }, collections { chargeCount, charged, collected, outstanding }, expenses { count, total }, net }`.
- `MyEventDto { id, type, title, startsAt, endsAt, venue, details, status, charge { amount, outstanding, status } | null }` — no duties, no staff, no other child's money.

## 2. Behaviour

### 2.1 Create (R310, R316, A4)

After the idempotency claim, in one transaction: the year exists (`422 REFERENCE_NOT_FOUND` on
`academicYearId`) and is not `closed` (`409 ACADEMIC_YEAR_CLOSED`); `endsAt ≥ startsAt` (`422` on
`endsAt`); each section is live and of the year (`422 REFERENCE_NOT_FOUND` on `sectionIds[i]`;
duplicates `422`); a charge needs both campaign keys (`403`), a live head of category `event` (`422
REFERENCE_NOT_FOUND` on `charge`), and `dueOn` (when given) today or later and inside the year
(`422` on `charge.dueOn`). The database refuses a `startsAt` outside the year (`422` on `startsAt`).
Born `draft`. Audit `event.created`.

### 2.2 Edit a draft (R316)

The row is read under its lock; not draft → `409 EVENT_NOT_DRAFT`. The same checks as create on
the fields given; `sectionIds` replaces the set (delete + insert, the campaign-audience precedent).
Audit `event.updated { fields }`.

### 2.3 Duties (rule 34, R311)

Add: the event draft or published (`409 ILLEGAL_STATUS_TRANSITION` otherwise); the staff member
active (`422 REFERENCE_NOT_FOUND` on `staffId`); one live duty of a kind per member (`409
EVENT_DUTY_EXISTS { dutyId }`). End: `ReasonDto`; repeat `200` unchanged. Audit
`event_duty.added|ended`. A duty holder reaches only their own event (§2.6, §2.7); they never gain
`/payments/*`, dues or statements.

### 2.4 Publish (R310)

Locks the event `FOR UPDATE`; draft only (`409 EVENT_NOT_DRAFT`); the year not closed; at least
one section (`409 EVENT_NO_SECTIONS`). With a charge: both campaign keys; the due date (stored,
else the event date) today or later (`422` on `charge.dueOn`); the `event` head live. Then, in the
publish transaction:

1. The charge, if any: `CampaignsService.createForEvent` creates the campaign (name = title, the
   event head, `applyConcessions` false, audience = the event's sections, due date as above) and
   queues its run (`charge_campaign.created`, `charge_campaign.generate_requested`); a run already
   in progress for the year → `409 CHARGE_RUN_IN_PROGRESS` (retry). The run is enqueued after
   commit; the charge-run job writes the charges and the families' fee notices.
2. `AnnouncementsService.sendEventNotice` writes the invitation (category `event`, audience the
   sections, parents and students, `sending`); the send job delivers it after commit.
3. One `UPDATE` sets `status`, `announcement_id` and `campaign_id`. Audit `event.published`.

A student who joins a section after publish is neither invited nor charged (§1.1).

### 2.5 Cancel (R313)

Locks the event `FOR UPDATE`; `draft` or `published` (else `409 ILLEGAL_STATUS_TRANSITION`). With a
campaign: `charge.create`; a campaign still `generating` → `409 CHARGE_RUN_IN_PROGRESS`.
`ChargesService.settleCancelledCampaign` locks every child's family in R236's order, then, per
live charge of the campaign: no money on it (no allocation, no credit) → voided with the reason
(its open late fee with it); otherwise a credit for what is left uncredited (`amount −
credited`), which de-allocates the paid money into the payment as the child's advance (R186) —
**the principal only** (`403 PERMISSION_DENIED principal_required`, checked before anything is
written). The campaign is cancelled (`CampaignsService.cancelForEvent`). A published event sends a
cancellation notice (`cancel_announcement_id`); a draft sends none. No cash moves. Audit
`event.cancelled { voided, credited, campaignId }` besides the charges' own rows.

### 2.6 Participation (R312, A5)

Roster (§1.1) = enrolments live in the event's sections on the event date (school time) ∪ the
students holding a non-voided charge of the event's campaign (their charge's enrolment). Scope:
`holiday.manage` reads the whole roster; a live duty holder of the event reads and records the
whole roster; a class teacher or cover of one of the event's sections on the event date reads and
records the rows of their sections. Anyone else `404`. Record: published only (`409
EVENT_NOT_PUBLISHED`); each `studentId` in the caller's roster (`422 REFERENCE_NOT_FOUND` on
`rows[i].studentId`); upsert per `(event, student)` (unchanged rows are not rewritten); frozen at
completion. Audit `event_participation.recorded { rows, changed }`.

### 2.7 Event payment (R317, §1.1 "Collection duty")

After the claim, in one transaction: the event `FOR SHARE`; published (`409 EVENT_NOT_PUBLISHED`)
with a campaign (`409 EVENT_NO_CHARGE`); the caller holds a live `collection` duty on the event or
`payment.record` (else `404`). `PaymentsService.recordForEvent` then: never the actor's own child
(`409 SELF_ACTION_FORBIDDEN own_child`, no sole-principal exception); `receivedOn` today or
earlier; the child's live charge of the campaign (`422 REFERENCE_NOT_FOUND` on `studentId` when
none), locked; `amount ≤ outstanding` (`409 EVENT_PAYMENT_EXCEEDS_CHARGE { outstanding }`); a cash
`payments` row recorded by the caller (so in their custody), payer the child's fee-paying guardian
(primary contact, else any live guardian; none → payer name "Event collection"), one allocation to
that charge only (the child's advance is not spent), a receipt numbered from the year's counter,
`payment.recorded` and `receipt_issued` as Phase 3. Σ allocations + unallocated = amount (0
unallocated). Audit `event_payment.recorded { paymentId, studentId, amount }`. The collector hands
the cash over through `POST /me/staff/cash-handovers` (§3.3).

### 2.8 Report (R314)

Published or completed (`409 EVENT_NOT_PUBLISHED`). `collections.collected` = Σ live allocations to
the campaign's charges; `charged` = Σ amounts of its non-voided, non-adjustment charges;
`outstanding` = charged − collected − credits; `expenses.total` = Σ `recorded | approved`
expenses tagged to the event (a late bill tagged after completion appears); `net = collected −
expenses.total`. Live, not a snapshot. Participants count the roster and its statuses.

### 2.9 `mine`

`GET /events?mine=true`: events (published or completed, any year) on which the caller holds a live
duty, or one of whose sections the caller is class teacher or cover of today — the teacher's phone
list.

### 2.10 Family (R315)

Published and completed events whose sections include the section of one of the child's
enrolments live on the event's date. `charge` is the child's own live charge of the campaign.

## 3. Hooks into earlier slices

### 3.1 Payments — `PaymentsService.recordForEvent(actor, { academicYearId, studentId, campaignId, amount, receivedOn, reference })`

Runs in the caller's transaction (contract slice-21 §1.4's `recordForClaim` precedent).

### 3.2 Fees — `CampaignsService.createForEvent`, `cancelForEvent`; `ChargesService.settleCancelledCampaign`

Each runs in the caller's transaction. No idempotency claim of its own; the caller's audit row and
the charge and campaign rows are written as their routes write them.

### 3.3 Own handover

`POST /me/staff/cash-handovers` is `@RequireStaff()` (was `payment.record`): a caller without
`payment.record` may hand over only when they hold cash in custody (else `403 PERMISSION_DENIED`).
The collection-duty teacher's cash otherwise has no way to the office.

### 3.4 Expenses — tag

`POST /expenses/:id/tag-event { eventId }`: the expense under its lock; voided → `409 STALE_STATUS`;
already tagged to that event → `200` unchanged; to another → `409 EXPENSE_EVENT_TAGGED`; the
event exists (`422 REFERENCE_NOT_FOUND` on `eventId`) and is published or completed (`409
EVENT_NOT_PUBLISHED`). `ExpenseDto` gains `eventId`. Audit `expense.event_tagged { eventId }`.

### 3.5 Read filters

`GET /payments?eventId=` — payments with an allocation (live or reversed) to a charge of the
event's campaign; `GET /charges?campaignId=`; `GET /expenses?eventId=`.

## 4. Errors and constraint mappings

The wave S mappings (`WAVE_S_CONSTRAINTS`) stand; the services refuse first.

## 5. Audit (R57)

`event.created|updated|published|cancelled|completed`, `event_duty.added|ended`,
`event_participation.recorded`, `event_payment.recorded` (with `payment.recorded`),
`expense.event_tagged`; publish also writes `charge_campaign.created` and
`charge_campaign.generate_requested`; cancel writes `charge.voided` / `charge.adjusted` per charge
and `charge_campaign.cancelled`.

## 6. Web and phone

Web: nav **Events** for staff. `/events` (list with filters; New for `holiday.manage`),
`/events/new`, `/events/[id]` (detail with Publish, Cancel, Complete, Edit for a draft, duties,
participation, the event's payments for a collector, the report link), `/events/[id]/edit`,
`/events/[id]/report`. Loading, empty, error and content states; tablet widths. Phone: Classes →
**Events** (`GET /events?mine=true`; participation recording; event payments on a collection duty),
the family child screen's **Events**; online-only, no outbox lane. Maestro `teacher-event-duty.yaml`.

## 7. Deviations from the plan

1. **`CreateEventDto` carries `academicYearId`.** The plan's DTO has none; a draft may have no
   section yet, so the year is named. It is the idempotency path id, as campaigns use.
2. **`GET /events/:id`** is added (the detail page and the phone need one event).
3. **`mine=true`** on `GET /events` replaces a separate "my duties" route.
4. **Duty scope is enforced in the service**, not by a branded scope type: the events repository
   takes the event id the service has checked. Minting a new brand is a tenancy change the main
   thread owns (rule 32 asks for a branded scope); recorded for review.
5. **The event payment's payer** is the child's fee-paying guardian (else primary contact, else any
   live guardian); with no guardian, the walk-in name "Event collection". The plan's DTO names no
   payer.
6. **The event payment never spends the child's advance**; the cash goes to the event charge only.
7. **Cancel credits only what is left uncredited** (`amount − credited`) and treats a charge with a
   credit but no allocation as "with money" (it cannot be voided, `CHARGE_HAS_CREDITS`), so the
   principal gate covers it too. The credit's de-allocation re-applies the advance to the child's
   other open charges of the year, as every Phase 3 credit does; only what is left stays an advance.
8. **A campaign run already in progress for the year refuses publish** (`409
   CHARGE_RUN_IN_PROGRESS`), as `POST /charge-campaigns/:id/generate` does. A run that fails puts the
   campaign back to draft; the office regenerates it from the campaign screen.
9. **Own handover is opened to staff with custody** (§3.3).
10. **Completion has no date check**: an event may be marked completed before it starts (the
    office's judgement); participation then freezes.

Fix round (2026-10-14, from the wave S reviews):

11. **The event receipt's balance** (`receipt_issued`, "Balance for <year>") is the child's whole
    year, Σ outstanding over their open charges of the year read after the allocation, exactly as
    the counter's; it was the event charge's alone. Test: "the event receipt's balance is the
    child's whole year, arrears included".
12. **Cancel treats a late fee with money as "with money".** Every non-voided late fee of a live
    campaign charge is locked with it (`lockForCredit` over both, R236), counted in the principal
    gate and the own-child check, and credited in full through the same adjustment loop (its money
    joins the child's advance); an open late fee with no money is voided as before. `credited`
    counts only rows actually credited. The cancel is retried once on a racing payment (`onceMore`,
    as `adjust`). Late fees are swept only on generated or manual monthly charges today, so this is
    defensive; the test writes one directly. Test: "a paid late fee on an event charge is credited on
    cancel ... and needs the principal".
13. **Roster dues are need-to-know** (security L2). `EventRosterRowDto.charge` is `null` unless the
    caller holds a live `collection` duty on the event, is an events holder (`holiday.manage`), or
    holds `payment.record`; a registration, supervision or transport officer and a class teacher see
    the roster without the money. The web roster shows no charge column and the phone already hid a
    null charge. Test: "roster dues only for the collection duty, an events holder or payment.record".
