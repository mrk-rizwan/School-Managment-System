-- Phase 5 wave S, fix forward (phase-5-extended.md R313): events_cancel_announcement_check, as
-- created by 20261010090000_wave_s_events_contracts, ended with
-- `cancel_announcement_id IS DISTINCT FROM announcement_id`, which is false when both are NULL, so
-- it refused every draft. The cancellation notice differs from the invitation only when it is set.
-- Hand-written; listed in test/guardrails/schema-checks.ts (WAVE_S_OBJECTS).
ALTER TABLE "events" DROP CONSTRAINT "events_cancel_announcement_check";

ALTER TABLE "events" ADD CONSTRAINT "events_cancel_announcement_check"
  CHECK (
    ("cancel_announcement_id" IS NOT NULL) = ("status" = 'cancelled' AND "announcement_id" IS NOT NULL)
    AND ("cancel_announcement_id" IS NULL OR "cancel_announcement_id" <> "announcement_id")
  );
