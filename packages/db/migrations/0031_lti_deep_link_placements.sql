CREATE TABLE "lti_deep_link_placements" (
  "id" TEXT PRIMARY KEY,
  "registration_id" TEXT NOT NULL,
  "lti_session_id" TEXT NOT NULL,
  "placement_key" TEXT NOT NULL,
  "assignment_id" TEXT NOT NULL,
  "context_id" TEXT,
  "section_id" TEXT,
  "title" TEXT NOT NULL,
  "text" TEXT,
  "line_item_label" TEXT,
  "line_item_score_maximum" REAL,
  "line_item_tag" TEXT,
  "linked_resource_link_id" TEXT,
  "linked_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  FOREIGN KEY ("registration_id") REFERENCES "lti_registrations"("id") ON DELETE CASCADE,
  FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE,
  FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE SET NULL,
  UNIQUE ("registration_id", "placement_key")
);

CREATE INDEX "lti_deep_link_placements_assignment_idx"
  ON "lti_deep_link_placements" ("assignment_id", "created_at" DESC);

CREATE INDEX "lti_deep_link_placements_linked_resource_idx"
  ON "lti_deep_link_placements" ("registration_id", "linked_resource_link_id");
