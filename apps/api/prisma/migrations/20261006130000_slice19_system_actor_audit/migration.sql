-- Slice 19 fix round (phase-3-financial.md A19, main-thread decision 2026-10-06): a job writes its
-- audit row as the system actor. audit_log_actor_check kept "exactly one actor"; it now also
-- admits a row with no actor at all only when its metadata names the job ('job' key), so a
-- forgotten actor on a request path is still refused. AuditLogRepository.recordSystem is the one
-- writer of such rows (test/charges/system-audit.e2e-spec.ts).
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_check";

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_check"
  CHECK (
    num_nonnulls("actor_user_id", "actor_platform_user_id") = 1
    OR (num_nonnulls("actor_user_id", "actor_platform_user_id") = 0 AND "metadata" ? 'job')
  );
