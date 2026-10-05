-- Wave H review fixes (phase-3-financial.md §3.1, R232; review 2026-10-06). Hand-written only;
-- schema.prisma is unchanged. Both objects are listed in test/guardrails/schema-checks.ts
-- (SLICE_18_OBJECTS).

-- The finance seed function resolves its tables in the public schema only, whatever search_path
-- the caller runs with (the migration that created it has been applied, so it is replaced here).
ALTER FUNCTION asms_seed_school_finance(bigint) SET search_path = public;

-- R232's merge resolution, defined once: every guardian record in the merge family of
-- p_guardian_id, the record itself included. A step follows merged_into_id in either direction
-- (to the survivor, and to records folded into one already found), at most five steps from the
-- start. actorIsGuardianOf (StudentGuardianRepository.userIsLiveGuardianOf) reads it; slice 19's
-- own-child trigger reuses it.
CREATE FUNCTION asms_guardian_merge_family(p_school_id bigint, p_guardian_id bigint)
RETURNS SETOF bigint
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH RECURSIVE family(id, depth) AS (
    SELECT g.id, 0 FROM guardians g WHERE g.school_id = p_school_id AND g.id = p_guardian_id
    UNION
    SELECT next.id, f.depth + 1
    FROM family f
    JOIN guardians cur ON cur.school_id = p_school_id AND cur.id = f.id
    JOIN guardians next ON next.school_id = p_school_id
      AND (next.id = cur.merged_into_id OR next.merged_into_id = cur.id)
    WHERE f.depth < 5
  )
  SELECT DISTINCT id FROM family;
$$;
