-- Late-fee sweep margin (fix-forward; 20261006100100 is applied and is never edited).
--
-- charges_own_child fired BEFORE INSERT OR UPDATE on every row, so every inserted charge paid a
-- plpgsql call although asms_charge_own_child acts on an insert only when NEW.kind = 'adjustment'
-- (any other kind leaves v_actor NULL and returns NEW): 12-14 ms per 2,000 late fees in
-- test/fees/generation-perf's sweep, and the same on every generation insert.
--
-- The trigger is split by event. The INSERT trigger fires only for an adjustment, exactly the
-- rows the function's INSERT arm checks; the UPDATE trigger is unchanged (its arms read OLD and the
-- void and waive transitions). asms_charge_own_child is not replaced: both triggers run the same
-- function, so the refusal (charges_own_child, the sole-principal exception, job writes with a
-- NULL actor) is unchanged; the error mapper reads the constraint name the function raises, not the
-- trigger name.

DROP TRIGGER "charges_own_child" ON "charges";

CREATE TRIGGER "charges_own_child" BEFORE UPDATE ON "charges"
  FOR EACH ROW EXECUTE FUNCTION asms_charge_own_child();

CREATE TRIGGER "charges_own_child_insert" BEFORE INSERT ON "charges"
  FOR EACH ROW WHEN (NEW.kind = 'adjustment')
  EXECUTE FUNCTION asms_charge_own_child();
