-- Phase 5 groundwork, fix forward (phase-5-extended.md §3.2): the audit screen's action-prefix
-- index, created by 20261009120100_phase5_groundwork from schema.prisma with its operator class,
-- is read back by Prisma 7.10 without it, so every later `prisma migrate diff` would drop and
-- recreate it. It becomes hand-written: partial, with a predicate every `action LIKE 'x.%'`
-- filter implies (action is NOT NULL anyway), which keeps it out of Prisma's diff like the other
-- hand-written partial indexes. Listed in test/guardrails/schema-checks.ts (WAVE_R_OBJECTS).
DROP INDEX "audit_log_school_id_action_created_at_idx";

CREATE INDEX "audit_log_school_id_action_created_at_idx"
  ON "audit_log" ("school_id", "action" varchar_pattern_ops, "created_at")
  WHERE "action" IS NOT NULL;
