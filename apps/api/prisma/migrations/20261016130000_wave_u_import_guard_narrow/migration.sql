-- Wave U fix round (fix-forward; 20261016120000 is applied and is never edited).
--
-- charges_import_guard fired on every late fee (`WHEN import_id IS NOT NULL OR
-- late_fee_for_charge_id IS NOT NULL`), so the late-fee sweep paid a function call and an extra
-- index probe per late fee for an arm that cannot be met: test/fees/generation-perf's sweep went
-- from 4.5-4.8 s to 5.1 s (budget 5 s).
--
-- Why the late-fee arm is unreachable. The late-fee sweep is the only writer of late fees, and its
-- candidate predicate (ChargeGenerationRepository.lateFeeCandidates) selects only charges with
-- `period IS NOT NULL AND kind IN ('generated', 'manual') AND head_frequency = 'monthly'`. An
-- imported opening balance is written with `period` NULL (ChargeRepository.createImported) under
-- the once-off "Opening balance" head, so the sweep never selects it and never late-fees it
-- (R342; test/imports/opening-balances.e2e-spec.ts runs the sweep over imported charges and
-- finds none). The constraint below makes the `period` half of that a database fact rather than a
-- code fact: an imported charge can never carry a period, so it can never meet the sweep's
-- predicate. It is a plain CHECK on the inserted row (no lookup), and every imported charge
-- written so far has a NULL period, so it validates.
--
-- The trigger now fires only for an imported charge. asms_charge_import_guard keeps its late-fee
-- ELSIF arm unchanged (no longer reached; replacing the function would change nothing it does).

ALTER TABLE "charges" ADD CONSTRAINT "charges_import_period_check"
  CHECK ("import_id" IS NULL OR "period" IS NULL);

DROP TRIGGER "charges_import_guard" ON "charges";
CREATE TRIGGER "charges_import_guard" BEFORE INSERT ON "charges"
  FOR EACH ROW WHEN (NEW.import_id IS NOT NULL)
  EXECUTE FUNCTION asms_charge_import_guard();
