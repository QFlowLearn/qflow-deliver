ALTER TABLE "assessment_versions"
  ADD COLUMN "qti_timing_metadata_json" TEXT NOT NULL DEFAULT '{"assessmentTest":null,"testParts":[],"sections":[],"itemRefs":[]}';

ALTER TABLE "assessment_item_metadata"
  ADD COLUMN "time_dependent" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "assessment_item_metadata"
  ADD COLUMN "qti_timing_metadata_json" TEXT NOT NULL DEFAULT '{}';

ALTER TABLE "attempt_result_items"
  ADD COLUMN "response_variables_json" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "attempt_results"
  ADD COLUMN "test_response_variables_json" TEXT NOT NULL DEFAULT '[]';
