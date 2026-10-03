-- A2 (wave-D review, 2026-10-04; contracts/slice-9.md §1.5, §7.12, decision 25): a device row is a
-- push address, not history. The daily session purge deletes the device rows of the sessions it
-- purges, in the same transaction, so devices lose their DELETE and TRUNCATE refusals. Sessions
-- never had one. Every other trigger on devices stays (user_id and school_id are immutable).
DROP TRIGGER "devices_no_delete" ON "devices";
DROP TRIGGER "devices_no_truncate" ON "devices";
