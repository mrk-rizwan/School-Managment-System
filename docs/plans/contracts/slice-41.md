# Slice 41 contracts — transport

**Author:** Opus 5.5 (wave T), 2026-10-14. **Binds:** `apps/api/src/modules/transport/**`,
`repositories/transport.repository.ts`, `repositories/transport-reads.repository.ts`, the transport
step of `modules/fees/charge-generation.ts` (+ `ChargeGenerationRepository.generateTransport`), the
assignment-ending hooks in `StudentsService` (withdrawal, transfer, alumni) and `PromotionService.apply`;
the web **Transport** area (`/transport`), the student page's Transport card; the mobile family
transport view and the driver's route list. **Source:** `phase-5-extended.md` rule 37, §1.1 (rule 37
rows), §1.2 item 40 (own key), §1.3 A8, §2 boundaries, §3.2 "Transport", §5 slice 41, §7.1, R326–R331;
migrations `20261014120100_wave_t_transport_biometric` and `20261014120200_wave_t_amount_void`.
Everything not restated follows the Phase 1–4 conventions (envelope, string ids, `PageQueryDto` ≤ 50,
`NoQueryDto`, `@ApiErrors()`, `404` outside the school or scope, `Idempotency-Key` with replay `200` +
`Idempotency-Replayed`, no `DELETE`, no `PUT`).

## 1. Routes

| Route | Guard | Notes |
|---|---|---|
| `GET /vehicles` | `transport.manage` | page of `VehicleDto`; `registration` (2–20, contains), `status` (`active` default, `retired`, `all`); sort registration |
| `POST /vehicles` + key | `transport.manage` | `CreateVehicleDto { registration, capacity, driverStaffId? }` → `201 VehicleDto` (§2.1); endpoint `vehicles`, no path id |
| `PATCH /vehicles/:id` | `transport.manage` | `UpdateVehicleDto { registration?, capacity?, driverStaffId? (null clears) }` → `200` |
| `POST /vehicles/:id/retire` | `transport.manage` | `ReasonDto` → `200 VehicleDto`; an active route names it → `409 VEHICLE_IN_USE` |
| `GET /transport-routes` | `transport.manage` | page of `TransportRouteDto`; `name` (2–50, contains), `status` (`active` default, `archived`, `all`); sort name |
| `POST /transport-routes` + key | `transport.manage` | `CreateTransportRouteDto { name, vehicleId?, stops? }` → `201 TransportRouteDetailDto`; endpoint `transport_routes`, no path id |
| `GET /transport-routes/:id` | `transport.manage` | `TransportRouteDetailDto`: the route, its live stops, every amount (voided included) |
| `PATCH /transport-routes/:id` | `transport.manage` | `UpdateTransportRouteDto { name?, vehicleId? (null clears), stops?, reason? }` → `200` (§2.2) |
| `POST /transport-routes/:id/amounts` | `transport.manage` | `SetRouteAmountDto { amount, effectivePeriod }` → `201 TransportRouteAmountDto` (§2.3) |
| `POST /transport-route-amounts/:id/void` | `transport.manage` | `ReasonDto` → `200 TransportRouteAmountDto` (a period not yet started) |
| `POST /transport-routes/:id/archive` | `transport.manage` | `ReasonDto` → `200 TransportRouteDetailDto`; live riders → `409 TRANSPORT_ROUTE_HAS_ASSIGNMENTS` |
| `GET /transport-routes/:id/assignments` | `transport.manage` | page of `TransportAssignmentDto`; `includeEnded` (false), `studentName` (2–50); sort student name |
| `POST /transport-routes/:id/assignments` + key | `transport.manage` | `CreateTransportAssignmentDto { studentId, stopId?, startsOn }` → `201 TransportAssignmentCreatedDto` (§2.4); endpoint `transport_assignments`, path id the route |
| `POST /transport-assignments/:id/end` | `transport.manage` | `EndTransportAssignmentDto { endedOn, reason }` → `200 TransportAssignmentDto` (§2.5) |
| `GET /students/:id/transport` | `transport.manage \| student.view` | `StudentTransportDto { current, history }` (scoped: 404 outside the caller's rows) |
| `GET /me/children/:id/transport` | capacity guardian | `MyTransportDto` |
| `GET /me/student/transport` | capacity student | `MyTransportDto` |
| `GET /me/staff/transport-routes` | staff | `MyDriverRouteDto[]`: the active routes whose vehicle names the caller as driver |

Throttles (per user): writes `transport-writes` 30/min, 300/h; `/me/*` reads `me-reads`.

### DTOs

- `VehicleDto { id, registration, capacity, driverStaffId | null, driverName | null, status, routeNames[],
  retiredAt | null, retireReason | null, createdAt }`.
- `TransportStopDto { id, sortOrder, name, pickupTime | null }` (`HH:MM`, school time).
- `TransportRouteDto { id, name, status, vehicle: { id, registration, capacity, driverName | null } | null,
  riders, currentAmount | null, nextAmount: { amount, effectivePeriod } | null, stopCount, archivedAt | null,
  archiveReason | null }` — `riders` = live assignments; `currentAmount` = the amount in force this period.
- `TransportRouteDetailDto extends TransportRouteDto { stops: TransportStopDto[], amounts: TransportRouteAmountDto[] }`.
- `TransportRouteAmountDto { id, routeId, effectivePeriod, amount, createdByName, createdAt, voidedAt | null,
  voidReason | null, voidable }` (`voidable`: live and its period not yet started).
- `TransportAssignmentDto { id, studentId, studentName, admissionNo, className | null, sectionName | null,
  academicYearId, routeId, routeName, stopId | null, stopName | null, pickupTime | null, startsOn,
  endsOn | null, status (live | upcoming | ended), endReason | null, endedByName | null, createdAt }` —
  class and section are the student's active enrolment's, else the assignment's enrolment.
- `TransportAssignmentCreatedDto extends TransportAssignmentDto { capacityWarning: { capacity, riders } | null }`.
- `StudentTransportDto { current: TransportAssignmentDto | null, history: TransportAssignmentDto[] }`
  (`current`: the newest assignment not ended or ending today or later, never one that was never in force
  (`endsOn < startsOn`, as the family read); `history`: the rest, newest first, ≤ 20).
- `MyTransportDto { current: { routeName, stopName | null, pickupTime | null, driverName | null, startsOn,
  endsOn | null } | null }` — names and times only (R330).
- `MyDriverRouteDto { id, name, vehicleRegistration, stops: TransportStopDto[], students: { name, stopId | null }[] }`
  — names and stops only (R330), students whose assignment is live or ends today or later.

## 2. Behaviour

### 2.1 Vehicles (R329, R331)

Registration 1–20, trimmed, upper-cased for comparison (one **active** vehicle per registration, `409
VEHICLE_REGISTRATION_TAKEN`); capacity 1–120; the driver an existing staff member not `left` (else
`422 REFERENCE_NOT_FOUND` on `driverStaffId`). A retired vehicle is history: `PATCH` → `409 VEHICLE_RETIRED`.
Lowering capacity below the riders of its routes is allowed (R331 warns, never blocks). Audits
`vehicle.created`, `vehicle.updated { fields }`, `vehicle.retired`.

### 2.2 Routes and stops

Name 1–80, one active route per lower-cased name (`409 TRANSPORT_ROUTE_NAME_TAKEN`); the vehicle active
(`409 VEHICLE_RETIRED`). `stops` replaces the live stops **as a whole**: each item `{ id?, sortOrder 1–100,
name 1–80, pickupTime? HH:MM }`; an item with `id` edits that live stop of the route in place (`422` on
`stops` when it is not one), one without inserts; a live stop not listed is ended — that needs `reason`
(`422 VALIDATION_FAILED` on `reason`) and no live assignment on it (`409 TRANSPORT_STOP_IN_USE { stopId }`).
Sort orders distinct (`422` on `stops`, checked here; the database's deferred exclusion checks at
commit). ≤ 100 stops. Archived routes are frozen (`409 TRANSPORT_ROUTE_ARCHIVED`). Audits
`transport_route.created`, `transport_route.updated { fields, stopsAdded, stopsEdited, stopsEnded }`,
`transport_route.archived`.

### 2.3 Amounts (rule 37, R327)

Append-only rows from a period. `effectivePeriod` must be the **next period or later** (school time) —
except a route with no live amount in force now, which may take the current period (its first price).
Otherwise `422 TRANSPORT_AMOUNT_PERIOD_PAST` on `effectivePeriod`. One live amount per route and period
(`409 TRANSPORT_AMOUNT_PERIOD_TAKEN`: void it first). A void needs a reason and a period not yet started
(`409 TRANSPORT_AMOUNT_PERIOD_PAST`). The amount in force for a period is the non-voided row with the
greatest `effectivePeriod` not after it. Audits `transport_amount.set`, `transport_amount.voided`.

### 2.4 Start an assignment (A8, R326, R329, R331)

After the idempotency claim: the route active (`404` absent, `409 TRANSPORT_ROUTE_ARCHIVED`); the student
in the caller's scope (`404`) with an **active enrolment** (else `422 INVALID_VALUE` on `studentId`); the
student row locked; a live assignment in that year → `409 TRANSPORT_ASSIGNMENT_LIVE { studentId,
assignmentId }` (a change is end-then-start); `startsOn` not before the enrolment's start, not before the
first day of the current period, inside the year, and after the last day of any ended assignment of the
year (`422` on `startsOn`); `stopId` a live stop of the route (`422`). The row snapshots the enrolment.
Capacity: when the route's vehicle has fewer seats than its live riders after the insert, the create still
succeeds, answers `capacityWarning { capacity, riders }` and audits `transport.capacity_exceeded
{ routeId, vehicleId, capacity, riders }` (R331). Audit `transport_assignment.started`. A replay (`200`) answers
`capacityWarning` from the route's live riders and its vehicle **now**, and audits nothing.

### 2.5 End an assignment (R326, R327)

`endedOn` from the later of `startsOn − 1` (never in force) and **the last day of the previous month** (school
time) to the year's last day (`422` on `endedOn`); a reason. Already ended → `409 STALE_STATUS`. Audit
`transport_assignment.ended { via: 'end' }`. **An end mid-month is charged in full** (§2.6), and the current
month's charge, once generated, stands whatever the end date: an end on `startsOn − 1` is never charged only
when it comes before the run of the assignment's first month (a charge already raised is voided by the office
like any other).

### 2.6 Charges (rule 37, R327, R328)

In every monthly charge generation (the 1st's run, the daily catch-up, a requested run; never a campaign
run), after the classes, one transaction per year-period: `TransportReadsRepository.riders` returns, per
student, the assignment of the year **in force for the period and started on or before the cut-off day**
(`starts_on ≤ cutoff`, `ends_on` null or `≥` the period's first day, never-in-force rows excluded; the one
in force on the 1st first, else the earliest), with the route amount in force for the period (rows with a
positive amount only). `ChargeGenerationRepository.generateTransport` inserts one `generated` monthly
charge per student-period under the school's live Transport head on `charges_generated_key` (a voided one
is regenerated only by a `regenerateVoided` run), on the student's **enrolment live in the period** (the
one in force on the 1st, else the earliest to start in the period; a student with none — left before the
period — is not charged), with the concession naming the head in force (R328), settled at birth when fully
conceded, description `Transport <Month YYYY>`. Advances are applied as for any generated charge; the
`fee_charged` message counts it. The fee-structure run never charges a transport head (R329).

### 2.7 Promotion and leaving (A8)

`StudentsService`: a status change to `withdrawn` or `transferred` (the status route and promotion's
`not_continuing`) ends the student's live assignments on the effective date (on `startsOn − 1` when it starts
later), reason `Student withdrawn` / `Student transferred`. `promoteMany` (alumni) ends none itself:
`PromotionService.apply` ends the live assignments of the sheet's year for every student whose enrolment
closes there (promoted, detained and completed alike; a new year needs a new assignment) on the year's last
day, reason `Promotion applied`. Each end audits `transport_assignment.ended { via: 'status_change' |
'promotion' }`.

## 3. Web and mobile

Web `/transport` (nav: Transport, `transport.manage`): Vehicles tab, Routes tab (list → route page with
stops editor, amounts with void, riders with end, "Assign students" from a section list with stop and
start date), the student page's Transport tab (current route, stop, pickup, history). Mobile: the
family child screen's Transport card and the student's own; a staff driver's "My routes" list. Online only.

## 4. Deviations

1. *(Withdrawn in the fix round.)* `POST /vehicles` and `POST /transport-routes` now take an
   `Idempotency-Key` as plan slice 41 asks (endpoints `vehicles` and `transport_routes`, no path id, as
   `POST /expenses`; a replay is `200` + `Idempotency-Replayed` with the row as it is now). No migration:
   `idempotency_keys_endpoint_check` is a shape regex, not a list. The web sends a key per submit.
2. Stops carry an optional `id` in `PATCH /transport-routes/:id` (the plan's item has none): without it an
   edit could not be told from an end-and-add, and an ended stop with riders is refused.
3. `POST /transport-route-amounts/:id/void` is added (the wave T fix-forward created the void trio).
4. A route's **first** amount may start in the current period (the migration's stated rule); later amounts
   start next period or later.
5. `startsOn` is refused before the first day of the current period, so an assignment never re-prices a
   past month a requested run might regenerate.
6. `GET /students/:id/transport` is guarded `transport.manage | student.view` (the plan names no key).
7. `TransportRepository.driverRoutes` takes no `Scope` (tenancy control 7): the driver's standing comes
   from the vehicle row naming them, not from a capability scope (as events' duty scope, slice 38
   deviation 4). It returns names and stop ids only.
8. The student page shows transport as a **Transport tab** holding the card, not a card on Details, so
   the page's other screens make no extra request (and the existing mocked suites stay unchanged).
9. The driver's list on the phone is a Home card ("My routes", shown only when a vehicle names the
   caller) opening `/home/my-routes` (secure: it names children); a driver need not be a teacher.
