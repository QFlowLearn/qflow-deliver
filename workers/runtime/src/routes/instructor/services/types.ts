import type { ResultExportProducerEnv } from "../../../queues/result-export";
import type { AssignmentActorSnapshot, AssignmentStatus } from "@harbor/attempt-protocol";

export interface InstructorEnv extends ResultExportProducerEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET?: string;
  LTI_STATE_SECRET?: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_TENANT_ID?: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
}

export interface AssignmentListRow {
  assignment_id: string;
  assessment_id: string;
  assessment_version_id: string;
  title: string;
  status: AssignmentStatus;
  policy_snapshot_json: string;
  created_at: string;
  updated_at: string;
  learner_target_count: number;
  section_target_count: number;
}

export interface PublishedAssessmentVersionListRow {
  assessment_id: string;
  assessment_title: string;
  assessment_slug: string;
  assessment_version_id: string;
  version_number: number;
  created_at: string;
}

export interface SectionListRow {
  id: string;
  tenant_id: string;
  source_kind: "manual" | "lti-context" | "csv" | "oneroster";
  source_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  active_learner_count: number;
  provisioning_source_id: string | null;
  class_sourced_id: string | null;
  course_sourced_id: string | null;
  course_title: string | null;
  school_sourced_id: string | null;
  school_name: string | null;
  term_sourced_ids_json: string | null;
  term_titles_json: string | null;
  class_code: string | null;
  class_type: string | null;
  staff_json: string | null;
}

export interface TargetedLearnerRow {
  learner_id: string;
  tenant_id: string;
  display_name: string;
  email: string | null;
  target_source: "explicit" | "section";
}

export interface LearnerListRow {
  id: string;
  tenant_id: string;
  display_name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
  active_section_count: number;
}

export interface LmsRegistrationSummaryRow {
  id: string;
  issuer: string;
  client_id: string;
  deployment_id: string;
  authorization_endpoint: string;
  token_endpoint: string | null;
  jwks_url: string;
  created_at: string;
  updated_at: string;
  resource_link_count: number;
  deep_link_placement_count: number;
  launch_count: number;
  ags_launch_count: number;
  nrps_launch_count: number;
  last_launch_at: string | null;
}

export interface LmsResourceLinkSummaryRow {
  id: string;
  registration_id: string;
  assignment_id: string;
  assignment_title: string;
  resource_link_id: string;
  context_id: string | null;
  section_id: string | null;
  section_title: string | null;
  created_at: string;
  updated_at: string;
  latest_attempt_id: string | null;
  latest_launch_at: string | null;
  ags_available: number;
  nrps_available: number;
  schedule_id: string | null;
  schedule_enabled: number | null;
  schedule_interval_minutes: number | null;
  schedule_reconciliation_policy: "additive-only" | "mark-inactive" | null;
  schedule_next_run_at: string | null;
  schedule_last_run_at: string | null;
  schedule_last_run_id: string | null;
  schedule_last_error_message: string | null;
  schedule_created_at: string | null;
  schedule_updated_at: string | null;
}

export interface LmsDeepLinkPlacementSummaryRow {
  id: string;
  registration_id: string;
  lti_session_id: string;
  placement_key: string;
  assignment_id: string;
  assignment_title: string;
  context_id: string | null;
  section_id: string | null;
  section_title: string | null;
  title: string;
  text: string | null;
  line_item_label: string | null;
  line_item_score_maximum: number | null;
  line_item_tag: string | null;
  linked_resource_link_id: string | null;
  linked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LmsNrpsSyncRunRow {
  id: string;
  attempt_id: string;
  registration_id: string;
  lti_session_id: string;
  resource_link_id: string;
  section_id: string;
  status: "complete" | "failed";
  total_members: number;
  learner_memberships_upserted: number;
  learner_memberships_deactivated: number;
  skipped_members: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AttemptRow {
  attempt_id: string;
  learner_id: string;
  assessment_version_id: string;
  created_at: string;
}

export interface AttemptResultRow {
  is_sequenced: number;
  attempt_result_id: string;
  attempt_id: string;
  status: "pending" | "complete" | "failed" | "rescored";
  total_score: number | null;
  max_score: number | null;
  submitted_at: string;
  finalized_at: string;
}

export interface ReportingItemResultRow {
  attempt_result_id: string;
  attempt_id: string;
  result_total_score: number | null;
  result_max_score: number | null;
  item_id: string;
  item_identifier: string | null;
  item_title: string | null;
  item_position: number | null;
  answered: number;
  response_summary_text: string | null;
  score: number | null;
  max_score: number | null;
  score_amended: number;
}

export interface ReportingStandardRow {
  standard_id: string;
  standard_code: string | null;
  standard_label: string | null;
  item_count: number;
  scored_attempt_count: number;
  average_percent: number | null;
  weak_item_count: number;
  weakest_item_average_percent: number | null;
}

export interface ReportingItemEvidenceRow {
  attempt_id: string;
  item_id: string;
  evidence_kind: string;
  event_type: string;
  sequence_number: number | null;
  client_timestamp: string | null;
  server_timestamp: string;
}

export interface LearnerReportItemResultRow {
  item_id: string;
  item_identifier: string | null;
  item_title: string | null;
  item_position: number | null;
  answered: number;
  response_summary_text: string | null;
  score: number | null;
  max_score: number | null;
  base_score: number | null;
  base_max_score: number | null;
  score_amended: number;
  score_amendment_ids_json: string;
  standard_id: string | null;
  standard_code: string | null;
  standard_label: string | null;
}

export interface LearnerReportStandardRow {
  standard_id: string;
  standard_code: string | null;
  standard_label: string | null;
  item_count: number;
  scored_item_count: number;
  average_percent: number | null;
}

export interface AttemptAccommodationSnapshotRow {
  attempt_id: string;
  profile_ids_json: string;
  learner_assignment_ids_json: string;
  assignment_override_id: string | null;
  accommodations_json: string;
  shell_tools_json: string;
  timing_json: string;
  created_at: string;
}

export interface AttemptEvidenceSummaryRow {
  attempt_id: string;
  item_presentation_count: number;
  response_count: number;
  submit_count: number;
  flagged_count: number;
  queued_locally_count: number;
  replayed_count: number;
  stale_tab_reconciled_count: number;
  receipt_confirmed_count: number;
  sync_failed_count: number;
  first_event_at: string | null;
  latest_event_at: string | null;
  latest_submit_at: string | null;
}

export interface AttemptAccommodationEvidenceCountRow {
  attempt_id: string;
  support: string;
  state: string;
  count: number;
}

export interface AttemptEvidenceEventRow {
  id: string;
  attempt_id: string;
  event_type: string;
  evidence_kind: string;
  outcome: string;
  sequence_number: number | null;
  item_id: string | null;
  response_key: string | null;
  client_timestamp: string | null;
  server_timestamp: string;
  receipt_id: string | null;
  event_source: string;
  flags_json: string;
  payload_json: string;
}

export interface ResultFinalizationRow {
  attempt_id: string;
  status: "pending" | "complete" | "failed";
  error_message: string | null;
  updated_at: string;
  submitted_at: string;
}

export interface OverrideRow {
  id: string;
  assignment_id: string;
  learner_id: string;
  policy_overrides_json: string;
  accommodations_json: string;
  created_by_role: AssignmentActorSnapshot["role"];
  created_by_id: string;
  created_by_display_name: string | null;
  updated_by_role: AssignmentActorSnapshot["role"];
  updated_by_id: string;
  updated_by_display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccommodationProfileRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "inactive";
  profile_json: string;
  created_by_role: AssignmentActorSnapshot["role"] | null;
  created_by_id: string | null;
  created_by_display_name: string | null;
  updated_by_role: AssignmentActorSnapshot["role"] | null;
  updated_by_id: string | null;
  updated_by_display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface LearnerAccommodationAssignmentRow {
  id: string;
  tenant_id: string;
  learner_id: string;
  profile_id: string;
  profile_name: string;
  status: "active" | "inactive";
  source_kind: string;
  effective_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}
