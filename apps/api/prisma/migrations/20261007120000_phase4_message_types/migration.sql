-- Phase 4 groundwork (phase-4-academic.md §3.5, §4 migration (1)): the three Phase 4 message
-- types, appended to message_type in their own migration because a value added by ALTER TYPE ...
-- ADD VALUE cannot be used in the transaction that adds it. The next migration uses two of them in
-- the school_settings.sms_allowed_types default, its CHECK and its backfill.
ALTER TYPE "message_type" ADD VALUE 'result_published';
ALTER TYPE "message_type" ADD VALUE 'result_revised';
ALTER TYPE "message_type" ADD VALUE 'test_marked';
