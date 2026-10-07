-- Wave N review (contracts/slice-34.md §3.1): a title belongs to an `other` certificate only, and
-- an `other` certificate may not be titled as a leaving certificate, which only the `leaving` type
-- (dues-gated, R290) may be. The service refuses both first (422 INVALID_VALUE on title).
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_title_other_check"
  CHECK (("type" = 'other' OR "title" IS NULL) AND ("title" IS NULL OR "title" !~* 'leav'));
