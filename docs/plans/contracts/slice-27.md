# Slice 27 contracts — the Approvals tab and page

**Author:** Opus 5.5 (wave L), 2026-10-07. **Binds:** `apps/api/src/modules/approvals/**`, the service exports of
`modules/{payments,expenses,leave}/*.module.ts`, the `selfApproved`, `decidedFrom` and `decidedTo` filters of `GET /expenses`
(`expenses.dto.ts`, `expenses.service.ts`, `repositories/expense.repository.ts`); web `app/(school)/approvals/**`,
`lib/api/school-approvals-contract.ts`, the nav entry, `weekAgo` moved to `fees/_lib/fees-ui.tsx`; mobile `src/approvals/**`,
`app/(tabs)/approvals/**`, the `approvals` tab in `auth/{tabs,shell,screen-registry}.ts` and the tab layout,
`ui/Attachment.tsx`'s `originalPath`, Maestro `principal-approvals.yaml` and its `ci-run.sh` block. **Source:**
`phase-3-financial.md` slice 27, R226, R227; the queues of contracts slice-20 (handovers), slice-21 (claims), slice-23
(expenses), slice-24 (leave). Conventions not restated follow slices 6, 13, 18 and 20.

## 1. Route

| Route | Guard | Notes |
|---|---|---|
| `GET /me/approvals` | `@RequireStaff()`, `me-reads` (120/min, 2,000/h) | `ApprovalsDto { claims?, handovers?, expenses?, leave? }`, each `{ count, items }` (≤ 10 items). A section is present only when the caller holds its key; **a staff member with none of the four gets `200 {}`, not `403`** (the route is `@RequireStaff`, like the other `/me/staff` reads; the R68 snapshot lists it). A guardian- or student-only session is `403` (no staff capacity, R78). Writes nothing: no audit row, no R57 entry |

| Section | Key | Read through (no new SQL) | Filter | Item |
|---|---|---|---|---|
| `claims` | `payment.verify` | `ClaimsService.list` | the queue's defaults: `pending`, with the slip (R243), oldest first | `ClaimDto` |
| `handovers` | `collection.handover.confirm` | `CashHandoversService.list` | `status=open` | `HandoverDto` |
| `expenses` | `expense.approve` | `ExpensesService.list` | `status=pending_approval`, `-spentOn` | `ExpenseDto` |
| `leave` | `staff.leave.approve` | `LeaveRequestsService.list` | `status=pending`, `-requestedAt` | `LeaveRequestDto` |

`count` is the list method's own `total` and `items` its first page of ten, so both equal what
`GET /payment-claims`, `GET /cash-handovers?status=open`, `GET /expenses?status=pending_approval` and
`GET /leave-requests?status=pending` report for the same caller (tested). Row scope and separation of duties are the
queue's: an own-family claim and one's own pending expense stay listed, exactly as in the queues, and the decision
route refuses them (`SELF_ACTION_FORBIDDEN`). The key is read from the session's effective capabilities
(`PermissionsService.holds`); the four sections are read one after another.

**Added to an existing route** (the one figure not otherwise available): `GET /expenses` gains `selfApproved?`
(boolean query) and `decidedFrom?` / `decidedTo?` (calendar dates, school time: `decided_at` at or after the school's
midnight starting `decidedFrom` and before the one ending `decidedTo`, like `voidedFrom` on `/charges`). A self-approved
expense is decided when it is recorded. The dashboard's "self-approved expenses this month" tile reads
`selfApproved=true&decidedFrom=<first of the month>&limit=1` and shows `total`: by the decision day, so an expense
recorded this month with an earlier `spentOn` counts, and with **no status filter**, so one voided since still counts
(fix round, 2026-10-07).

## 2. Web

`/approvals` (nav entry **Approvals**, first in the sidebar, shown to holders of any of the four keys): one read of
`GET /me/approvals`, a card per present section with its count, up to ten compact rows and **Open queue** to the full
page (`/fees/claims`, `/fees/handovers`, `/expenses`, `/leave`), where the decision is taken; "Showing the first 10 of
N" past ten; `{}` shows "Nothing for you to approve". **Tiles** (principal role only, each when the user may read its
source): fee proofs waiting, open custody (open handovers), pending expenses, pending leave (the four section counts);
today's collections (`/finance-reports/collections`, today to today, `total` on the default verified basis); outstanding
(`/finance-reports/outstanding` for the active year); charges voided in the last 7 days (today and the six before it, `/charges?status=voided&
voidedFrom=`, as the charges page); self-approved expenses this month (above). Each tile links to its page. Playwright:
`e2e/approvals.spec.ts` (mocked).

## 3. Mobile

Tab **Approvals**, second in `TAB_ORDER` (after Home), for a staff capacity holding any of the four keys. A principal's
bar becomes Home, Approvals, Today, Announce, More (Inbox, Calendar, Account). Route `/approvals`, **secure** (slips name
children and show a family's bank slip). **Online only (R226):** offline the screen reads nothing and says so; no
decision is an outbox lane (the seven actions were already in `ONLINE_ONLY_ACTIONS`); nothing is cached on the phone.
Each row opens its sheet:

- **Deposit slip:** the details, the slip on a tap (`Attachment`, thumbnail then `…/image`), the duplicate warning;
  **Verify Rs N** sends `{}` (the claimed amount and date). `PAYMENT_NOTHING_DUE` offers **Keep as the child's
  advance** (resends with `advanceForStudentId` = the claim's child). **Not accepted…** asks a reason (no phone numbers).
  A lower amount or another paid date is verified on the web.
- **Cash handover:** the counted amount, pre-filled with the expected; refused locally (and by the server) for the
  collector or opener; the reply names a shortfall or surplus.
- **Expense:** approve or reject with `expectedUpdatedAt` = the row's `updatedAt`; disabled for one's own; the receipt
  on a tap.
- **Leave:** approve, optionally with a cover for one of `sectionsNeedingCover` chosen from active staff (never the
  person on leave) when the user holds `class.manage`; reject with a reason.

Sheets (`ui/ModalSheet.tsx`, every sheet in the app) are drawn inside the screen's own view tree over the whole
screen (the Screen is their host), never in a React Native `<Modal>`: a Modal is its own Android window, outside the
Activity's FLAG_SECURE, so the slip and the receipt could otherwise be captured. The hardware back button closes the top
sheet; TalkBack focus moves to the sheet's title on open. The cover picker reads one page of 50 active staff; past 50 it
says "Showing the first 50 staff; choose the cover on the web if not listed" (fix round, 2026-10-07).

A `409` (decided elsewhere, edited since, own family) or `404` closes the sheet, shows the server's sentence and reads
the list again. Jest: `src/approvals/approvals.spec.tsx`; `auth/tabs.spec.ts` and `ui/secure-screens.spec.tsx` updated.
Maestro (CI only): `principal-approvals.yaml` — `ci-run.sh` seeds a slip (the guardian over `curl`) and an open handover
(the teacher, granted `payment.record` by the principal); the principal verifies the claim and confirms the handover
from the tab, with a `takeScreenshot` of the open slip (FLAG_SECURE evidence: the frame must be black;
`ci-run.sh` prints its size); `ci-run.sh` checks both over `curl`.

## 4. Tests

`apps/api/test/approvals/approvals.e2e-spec.ts`: R227 (principal sees four sections with counts and first pages equal to
the queues'; a clerk granted `payment.verify` only sees claims; office default and teacher get `{}`; a guardian `403`),
own-family claim and own expense listed but refused, ten items of eleven, two schools never see each other's rows, the
`selfApproved` filter, the `decidedFrom` / `decidedTo` filter (a backdated `spentOn` recorded this month and a voided self-approved one counted), no audit row. `test/core/route-guards.ts` and the R68 no-capability snapshot list the route.
