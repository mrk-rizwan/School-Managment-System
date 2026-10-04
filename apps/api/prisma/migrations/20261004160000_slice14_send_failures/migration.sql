-- Slice 14 fix round (contracts/slice-14.md §5.6, decision 25): a send that keeps failing stops.
-- The `announcement-send` job counts its failed attempts on the row; after the fifth the row goes
-- back to `draft` with `send_failed_at` set (nothing was written: each attempt rolled back), and
-- the principal sees it and may send again, which clears both. No new status: the clients'
-- status unions stay as they are.

-- AlterTable
ALTER TABLE "announcements" ADD COLUMN     "send_failed_at" TIMESTAMPTZ(3),
ADD COLUMN     "send_failures" SMALLINT NOT NULL DEFAULT 0;

-- =============================================================================================
-- Hand-written below this line. Every object here is listed in test/guardrails/schema-checks.ts
-- (SLICE_14_OBJECTS).
-- =============================================================================================

ALTER TABLE "announcements" ADD CONSTRAINT "announcements_send_failures_check"
  CHECK ("send_failures" >= 0);

-- Only a draft carries the failure flag: a send or a schedule clears it.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_send_failed_check"
  CHECK ("send_failed_at" IS NULL OR "status" = 'draft');

-- R146 as before, plus the failure columns: from `sending` the send's own columns move (status to
-- sent, sent_at, recipient_count) and so do the failure count and flag; `sending` -> `draft` only
-- when the job gives up (send_failed_at set). `sent` and `cancelled` stay final (updated_at aside).
CREATE OR REPLACE FUNCTION asms_announcement_final_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_send_columns text[] := ARRAY['status', 'sent_at', 'recipient_count', 'updated_at', 'send_failures', 'send_failed_at'];
BEGIN
  IF (OLD.status = 'sending'
      AND (NOT (NEW.status IN ('sending', 'sent') OR (NEW.status = 'draft' AND NEW.send_failed_at IS NOT NULL))
           OR (to_jsonb(NEW) - v_send_columns) IS DISTINCT FROM (to_jsonb(OLD) - v_send_columns)))
     OR (OLD.status IN ('sent', 'cancelled')
         AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')) THEN
    RAISE EXCEPTION 'a sending, sent or cancelled announcement is frozen'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'announcements_final_frozen',
            DETAIL = 'constraint: announcements_final_frozen',
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;
