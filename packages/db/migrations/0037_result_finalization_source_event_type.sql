ALTER TABLE "result_finalizations"
  ADD COLUMN "source_event_type" TEXT NOT NULL DEFAULT 'submit.requested'
  CHECK ("source_event_type" IN ('submit.requested', 'timing.auto-submit.requested'));
