ALTER TABLE "attempt_accommodation_snapshots"
  ADD COLUMN "timing_json" TEXT NOT NULL DEFAULT '{"additionalTimeSeconds":0,"effectiveTimeLimitSeconds":null}';

UPDATE "attempt_accommodation_snapshots"
SET "timing_json" = (
  SELECT json_object(
    'additionalTimeSeconds',
    COALESCE(
      (
        SELECT "additional_time_seconds"
        FROM "attempt_policy_overlays"
        WHERE "attempt_policy_overlays"."attempt_id" = "attempt_entries"."id"
      ),
      0
    ),
    'effectiveTimeLimitSeconds',
    CASE
      WHEN json_extract("attempt_entries"."delivery_policy_snapshot", '$.timeLimitSeconds') IS NULL THEN NULL
      ELSE
        json_extract("attempt_entries"."delivery_policy_snapshot", '$.timeLimitSeconds') +
        COALESCE(
          (
            SELECT "additional_time_seconds"
            FROM "attempt_policy_overlays"
            WHERE "attempt_policy_overlays"."attempt_id" = "attempt_entries"."id"
          ),
          0
        )
    END
  )
  FROM "attempt_entries"
  WHERE "attempt_entries"."id" = "attempt_accommodation_snapshots"."attempt_id"
)
WHERE EXISTS (
  SELECT 1
  FROM "attempt_entries"
  WHERE "attempt_entries"."id" = "attempt_accommodation_snapshots"."attempt_id"
);
