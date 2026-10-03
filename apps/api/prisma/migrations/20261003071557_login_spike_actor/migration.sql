-- Contract slice-2 §3.1 step 6: spray detection writes login_failure_spike to platform_audit_log
-- from the school login path, where no platform user acts. The seed and the spike are the only
-- actorless rows.
ALTER TABLE "platform_audit_log" DROP CONSTRAINT "platform_audit_log_actor_check";

ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_actor_check"
  CHECK ("actor_platform_user_id" IS NOT NULL OR "action" IN ('platform_user.seeded', 'login_failure_spike'));
