-- Migration 012: keep the AvantFax/HylaFAX job id a send produced.
--
-- `send.php` answers with the spool job id, and up to now the send route threw it
-- away on the way out: the row could only ever say the fax was handed over, never
-- whether it arrived. GET /api/fax/[id] reconciles the row against the spool by
-- that id, so without this column a filing to the IRS could be recorded as done
-- while the transmission failed.
ALTER TABLE faxes ADD COLUMN job_id TEXT;
