-- Collapse runs of the same leg already written into `voice_calls.handoffs`.
--
-- AMI emits a `Newexten` for every extension and priority a channel walks
-- through, so one move into `dograh-inbound` arrived as *four* events within a
-- few hundred milliseconds. `noteHandoff` (`src/lib/voice-calls.ts`) now records
-- only a move to a *different* leg, but the rows written before it did carry the
-- repeats, and every place that reads the array counts them: the call-detail
-- screen's "Hand-offs" stat printed 4 for a call that moved once, and the
-- Capstone screen filtered and labelled on the same inflated count.
--
-- The path is an ordered list of *legs*, so a run of the same leg is one leg.
-- `describePath` already collapsed them for display, but the count and the
-- "last hop" reads did not — collapsing the stored value fixes all of them at
-- once, rather than teaching each reader to dedupe.
--
-- Only *consecutive* repeats collapse: `Capstone → Dograh → Capstone` is two
-- separate visits and stays two. The `WHERE EXISTS` guard is what makes this
-- idempotent — after the first run no row still has a consecutive repeat, so the
-- statement the migration runner replays on every startup touches nothing.
UPDATE voice_calls
SET handoffs = (
  SELECT json_group_array(
           json_object(
             'to', json_extract(value, '$.to'),
             'at', json_extract(value, '$.at')
           )
         )
  FROM (
    SELECT value
    FROM (
      SELECT value,
             LAG(json_extract(value, '$.to')) OVER (ORDER BY key) AS previous
      FROM json_each(voice_calls.handoffs)
    )
    WHERE previous IS NULL
       OR previous IS NOT json_extract(value, '$.to')
  )
)
WHERE json_valid(handoffs)
  AND json_array_length(handoffs) > 1
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(value, '$.to') AS target,
             LAG(json_extract(value, '$.to')) OVER (ORDER BY key) AS previous
      FROM json_each(voice_calls.handoffs)
    )
    WHERE previous IS NOT NULL
      AND previous IS target
  );
