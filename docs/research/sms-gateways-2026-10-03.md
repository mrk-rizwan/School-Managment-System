# SMS gateway options for Pakistan — research, 2026-10-03

Research by `research-scout` for Phase 2 slice 9 (`docs/plans/phase-2-daily-operations.md`).
Prices are as published on 2026-10-03 and may be stale; anything marked "not published" was not
found on a public page. Nothing here was verified by a real send.

## Findings that change the design

1. **A branded sender name does not show on every network.** Jazz and Zong display a registered
   alphanumeric mask; **Telenor and Ufone deliver registered-organisation traffic from a
   shortcode**, so the From field cannot be relied on for recognition. Consequence: **every SMS
   template names the school in the body** ("ABC School: Ali was absent today…").
   Sources: Telerivet PTA compliance guide (2026-01-31), Twilio Pakistan guidelines ("sender ID
   preservation: no"), Infobip Pakistan LOA guidelines.
2. **Mask registration is a PTA + per-operator process needing a Pakistani legal entity** (company
   letterhead, signatory CNIC, NTN/SECP), Rs 4,000–5,000 one-time (Sendpk also Rs 5,000/year),
   15–30 working days, and a mask unused for three months is blocked. Consequence: **one
   platform-owned mask registered as transactional**, not one per school. Transactional traffic is
   exempt from the 9am–9pm promotional window and DNCR opt-outs; the mask must be registered as
   transactional and marketing must never go through it.
3. **No Pakistani aggregator documents a push delivery-report webhook.** All are pull (status query
   by message id) or undocumented. Only Infobip documents a signed webhook. Consequence: the
   `SmsDriver` interface supports both `fetchDeliveryStatus(providerRef)` (polled by a worker job
   on a backoff: 2, 10, 30, 120 min, give up at 24 h) and `parseDeliveryReport(req)` (signed
   push). With pull there is no inbound SMS webhook to protect for the primary provider.
4. **International providers are priced out**: Twilio publishes $0.4734 per segment for Pakistan
   (roughly thirty times local), cannot preserve a sender ID, and still needs local registration.
   Infobip and Sinch: contact sales. A backup only for an emergency where cost is irrelevant.

## Vendors

| Vendor | API | Delivery reports | Sender ID | Price (PKR/SMS) | Minimum | Notes / red flags |
|---|---|---|---|---|---|---|
| **Sendpk** (sendpk.com) | HTTPS GET/POST `api/sms.php`, API key as a parameter; plain-text `OK ID:n` response | **Pull** `api/delivery.php?id=` (schema not published) | shared "SMS Alert" instantly, or own mask Rs 5,000 + Rs 5,000/yr | Branded 3.80–3.90; semi-branded 4.10 | Rs 10,000 branded (2,564 SMS, 1-year validity); Rs 1,000 semi-branded | Only option with API, price and DLR all public. `template_id` requirement ambiguous — ask. Send the key in a POST body, never the query string. Also sells "non-official WhatsApp". |
| **SMS4Connect** (sms4connect.com) | exists; no public docs (community PHP wrapper shows id/password/mask/test_mode) | pull by transaction id (from the wrapper) | "registered mask on all networks" (claim; see finding 1) | not published | — | Education-sector focus; `test_mode` flag; password auth. Needs a sales call before any code. |
| **Branded SMS Pakistan / H3 Techs** | `secure.h3techs.com/sms/api/send.php` | not documented | mask Rs 5,000, 30 working days | not published | free trial | Docs advise falling back to **http** if https fails — red flag. |
| **Eocean** (eocean.net) | SMS/WhatsApp/Voice/RCS; doc hub exists, SMS spec did not render | "real-time delivery reports" (marketing) | registered IDs / shortcodes | not published; sales only | unknown | Enterprise (HBL, Careem, AKUH). Right answer at ten-plus schools, not now. |
| **Veevo Tech** | `api.veevotech.com/v3/sendsms`, JSON; billed on submit | not confirmed (doc JS-rendered) | yes | not published | prepaid | Unknown DLR; treat as unverified. |
| **ITel Services** | portal/API/SMPP by tier; no public doc | not stated | "apply PTA charges" | 2.35–3.19 by operator | Rs 3,000, **1-month validity** | UK entity with Lahore branch; credit expiry bad for low volume. |
| Operator portals (Jazz CMT, Zong, Telenor CCSMS) | HTTPS/SMPP, sales only | Telenor snippet suggests no handset DLR via API (unconfirmed, page 403) | yes | Telenor ~3.1 pay-as-you-go (snippet) | Rs 3,000 (Telenor) | Each is one operator aggregating the others; no advantage, worse docs. |
| **Infobip** | REST + Node SDK | **signed HMAC webhook** over raw body, retries documented | needs PK entity docs + a dedicated shortcode; promo and transactional senders differ | not published | free trial | Only verifiable signed-DLR option; cost unknown; same registration burden. Backup. |
| Twilio | REST | yes | not preserved for Pakistan | $0.4734/segment | — | Ruled out on price and sender ID. |

## Recommendation

**Primary: Sendpk**, branded tier, Rs 10,000 starter, one platform-owned transactional mask.
**Backup: SMS4Connect** once they send their documentation (same pull-DLR shape, education
focus). **Tertiary: Infobip** if everything local fails and cost does not matter.

What would change this: SMS4Connect or Eocean documenting a signed callback at ≤ Rs 3.8; Sendpk
confirming every body needs an operator-approved template; a real test showing Sendpk masks not
landing on Telenor/Ufone at all.

## Questions to ask each vendor before paying

1. HTTPS only? Can the API key go in the POST body or an `Authorization` header, not the query string?
2. Exact success response per message; is the returned ID stable and queryable later?
3. Delivery reports: callback URL? If yes: payload, statuses, retry policy, signature or shared secret. If no: the status-query endpoint, its response schema, retention, rate limit.
4. Which statuses exist (submitted / delivered to handset / failed / expired / DND-blocked), and are handset receipts available on all four networks?
5. On Telenor and Ufone, does the registered mask appear, or a shortcode? Which?
6. Are content templates pre-approved (operator "fixed SMS")? Turnaround? Variables allowed?
7. Mask registration: documents, fee, renewal, turnaround, the three-month inactivity rule; can it be registered as **transactional**?
8. Billed on submit or on delivery? Are failures refunded?
9. Does unused credit expire, and when?
10. Sandbox or `test_mode`?
11. Direct operator routes or via another aggregator (grey route)? In writing.
12. How are segments counted and charged for a 200-character English message?
13. Sending rate limit; how is a burst of 2,000 absence alerts at 09:30 handled — queued or rejected?
14. Multiple masks on one account (platform now, per-school later)? Per-mask fee?
15. Is DNCR applied to transactional traffic, and is the reject reason returned?

## Not confirmed

Sendpk's `delivery.php` schema and whether `template_id` is mandatory; any official SMS4Connect,
Veevo, Eocean or H3 Techs API document; Telenor CCSMS prices and its DLR statement; whether any
Pakistani aggregator signs callbacks (none found); Jazz CMT and Zong specs; whether PTA currently
processes new mask registrations without delay.
