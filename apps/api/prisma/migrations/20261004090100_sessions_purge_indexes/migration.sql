-- The daily session purge (contracts/slice-9.md §1.5, §7.12): per school, sessions revoked or
-- past their absolute expiry before a cut-off. One index per predicate (the purge ORs them).
CREATE INDEX "sessions_school_id_revoked_at_idx" ON "sessions"("school_id", "revoked_at");

CREATE INDEX "sessions_school_id_expires_at_idx" ON "sessions"("school_id", "expires_at");
