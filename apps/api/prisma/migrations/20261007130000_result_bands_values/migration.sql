-- Security review LOW-2 (2026-10-07): the database holds the shape of each grade band, not only
-- the array's length (result_settings_bands_check, unchanged). Every band is an object whose grade
-- is 1-4 of [A-Za-z0-9+-] (it is printed on report cards and in messages) and whose minPercent is
-- a whole number from 0 to 100. A value that is not an array is result_settings_bands_check's
-- refusal alone. The order, the band at 0 and unique grades stay packages/shared
-- bandsProblem's. Every existing row holds the rule-26 defaults or a table bandsProblem accepted.
ALTER TABLE "result_settings" ADD CONSTRAINT "result_settings_band_values_check"
  CHECK (jsonb_typeof("bands") <> 'array' OR NOT jsonb_path_exists("bands", '$[*] ? (@.type() != "object" || !exists(@.grade) || !exists(@.minPercent) || @.grade.type() != "string" || @.minPercent.type() != "number" || !(@.grade like_regex "^[A-Za-z0-9+-]{1,4}$") || @.minPercent < 0 || @.minPercent > 100 || @.minPercent.floor() != @.minPercent)'));
