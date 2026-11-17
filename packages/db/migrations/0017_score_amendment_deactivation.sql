ALTER TABLE "score_amendments"
  ADD COLUMN "deactivated_by_role" TEXT;

ALTER TABLE "score_amendments"
  ADD COLUMN "deactivated_by_id" TEXT;

ALTER TABLE "score_amendments"
  ADD COLUMN "deactivated_by_display_name" TEXT;

ALTER TABLE "score_amendments"
  ADD COLUMN "deactivated_reason" TEXT;

ALTER TABLE "score_amendments"
  ADD COLUMN "deactivated_at" TEXT;
