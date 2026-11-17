import type {
  AssignmentActorSnapshot,
  AssignmentPolicySnapshot,
  AssignmentRecord,
  AssignmentStatus,
  AssignmentTarget,
} from "./assignments";
import type { HarborLearnerRecord, LtiAssignmentLinkage, SectionRecord } from "./entry";
import type { AttemptStatus } from "./bootstrap";
import type { AttemptAccommodationSnapshotEvidence } from "./operator-actions";
import type { AttemptAccommodationState } from "./policy-operations";
import type { AttemptSyncHealthSignal } from "./attempt-events";
import type {
  AssignmentHistoryResponse,
  AttemptResultStatus,
  AttemptVariableSnapshot,
  ResultFinalizationStateSnapshot,
  ScoreRevisionSnapshot,
} from "./results";
import type { NavigationMode, SafeExamBrowserPolicySnapshot } from "@harbor/content-model";
import type { InstructorAccommodationEvidenceSummary } from "./instructor-evidence-summary";

export const INSTRUCTOR_ASSIGNMENT_ACTIONS = ["create", "edit", "activate", "close"] as const;

export type InstructorAssignmentAction = (typeof INSTRUCTOR_ASSIGNMENT_ACTIONS)[number];

export interface UpdateAssignmentRequest {
  title: string;
  status?: AssignmentStatus;
  actor: AssignmentActorSnapshot;
  policySnapshot: AssignmentPolicySnapshot;
  targets?: AssignmentTarget[];
  ltiLinkages?: LtiAssignmentLinkage[];
}

export interface AssignmentLearnerPolicyOverrides {
  additionalTimeSeconds?: number;
  maxAttempts?: number;
  timeLimitSeconds?: number | null;
  gracePeriodSeconds?: number | null;
  navigationMode?: NavigationMode;
  standaloneAllowed?: boolean;
  iframeAllowed?: boolean;
  allowedEmbedOrigins?: string[];
  secureBrowserRequired?: boolean;
  secureBrowserProviderHint?: string | null;
  safeExamBrowser?: SafeExamBrowserPolicySnapshot | null;
  proctoringProvider?: string | null;
}

export interface AssignmentLearnerOverrideRecord {
  id: string;
  assignmentId: string;
  learnerId: string;
  policyOverrides: AssignmentLearnerPolicyOverrides;
  accommodations: AttemptAccommodationState;
  createdBy: AssignmentActorSnapshot;
  updatedBy: AssignmentActorSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAssignmentLearnerOverrideRequest {
  actor: AssignmentActorSnapshot;
  policyOverrides: AssignmentLearnerPolicyOverrides;
  accommodations?: AttemptAccommodationState;
}

export interface InstructorAssignmentListItem {
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  status: AssignmentStatus;
  availableFrom: string | null;
  availableUntil: string | null;
  learnerTargetCount: number;
  sectionTargetCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InstructorAssignmentListResponse {
  assignments: InstructorAssignmentListItem[];
}

export interface InstructorPublishedAssessmentVersionListItem {
  assessmentId: string;
  assessmentTitle: string;
  assessmentSlug: string;
  assessmentVersionId: string;
  versionNumber: number;
  createdAt: string;
}

export interface InstructorPublishedAssessmentVersionListResponse {
  versions: InstructorPublishedAssessmentVersionListItem[];
}

export interface InstructorSectionListItem extends SectionRecord {
  activeLearnerCount: number;
  provisioningMetadata?: {
    sourceId: string;
    classSourcedId: string;
    courseSourcedId: string | null;
    courseTitle: string | null;
    schoolSourcedId: string | null;
    schoolName: string | null;
    termSourcedIds: string[];
    termTitles: string[];
    classCode: string | null;
    classType: string | null;
    staff: Array<{
      sourcedId: string;
      displayName: string;
      email: string | null;
      role: string;
    }>;
  } | null;
}

export interface InstructorSectionsResponse {
  sections: InstructorSectionListItem[];
}

export interface InstructorLearnerListItem extends HarborLearnerRecord {
  activeSectionCount: number;
}

export interface InstructorLearnersResponse {
  learners: InstructorLearnerListItem[];
}

export interface InstructorRosterAttemptProjection {
  attemptId: string;
  status: AttemptStatus | "not-started";
  launchedAt: string | null;
  submittedAt: string | null;
}

export interface InstructorAssignmentRosterRow {
  learner: HarborLearnerRecord;
  targetSource: "explicit" | "section";
  attemptCount: number;
  remainingAttempts: number;
  latestAttempt: InstructorRosterAttemptProjection;
  latestResultStatus: AttemptResultStatus | null;
  latestScore: {
    totalScore: number | null;
    maxScore: number | null;
  } | null;
  latestFinalization: ResultFinalizationStateSnapshot | null;
  latestScoreRevision: ScoreRevisionSnapshot | null;
  activeOverride: AssignmentLearnerOverrideRecord | null;
}

export interface InstructorAssignmentRosterResponse {
  assignment: AssignmentRecord;
  rows: InstructorAssignmentRosterRow[];
}

export interface InstructorAssignmentResultsSummary {
  targetedLearnerCount: number;
  notStartedCount: number;
  inProgressCount: number;
  pendingCount: number;
  completeCount: number;
  failedCount: number;
  rescoredCount: number;
}

export interface InstructorAssignmentResultsResponse {
  assignment: AssignmentRecord;
  summary: InstructorAssignmentResultsSummary;
  rows: Array<{
    learner: HarborLearnerRecord;
    latestAttemptId: string | null;
    latestResultStatus: AttemptResultStatus | null;
    latestScore: {
      totalScore: number | null;
      maxScore: number | null;
    } | null;
    latestFinalization: ResultFinalizationStateSnapshot | null;
    latestScoreRevision: ScoreRevisionSnapshot | null;
  }>;
}

export interface InstructorAssignmentReportingSummary {
  targetedLearnerCount: number;
  submittedAttemptCount: number;
  scoredAttemptCount: number;
  pendingCount: number;
  failedCount: number;
  rescoredCount: number;
  amendedResultCount: number;
  averageScore: number | null;
  averageMaxScore: number | null;
  averagePercent: number | null;
  minPercent: number | null;
  maxPercent: number | null;
  latestSubmittedAt: string | null;
  latestFinalizedAt: string | null;
}

export interface InstructorAssignmentReportingRosterRow {
  learner: HarborLearnerRecord;
  targetSource: "explicit" | "section";
  latestAttemptId: string | null;
  resultStatus: AttemptResultStatus | null;
  totalScore: number | null;
  maxScore: number | null;
  percentScore: number | null;
  submittedAt: string | null;
  finalizedAt: string | null;
  scoreAmended: boolean;
}

export interface InstructorAssignmentReportingItemRow {
  itemId: string;
  itemIdentifier: string | null;
  itemTitle: string | null;
  itemPosition: number | null;
  answeredCount: number;
  skippedCount: number;
  scoredCount: number;
  fullCreditCount: number;
  amendedCount: number;
  averageScore: number | null;
  maxScore: number | null;
  averagePercent: number | null;
  pValue: number | null;
  discriminationIndex: number | null;
  responseDistribution: InstructorAssignmentItemResponseDistributionRow[];
  averageTimeOnItemSeconds: number | null;
  timeOnItemSampleCount: number;
  changedAnswerCount: number;
  averageResponseChangeCount: number | null;
}

export type InstructorAssignmentDistractorSignal =
  | "full-credit"
  | "attractive-distractor"
  | "mixed"
  | "low-frequency"
  | "unscored";

export interface InstructorAssignmentItemResponseDistributionRow {
  responseSummary: string;
  responseCount: number;
  responsePercent: number;
  averageScore: number | null;
  averagePercent: number | null;
  fullCreditCount: number;
  distractorSignal: InstructorAssignmentDistractorSignal;
}

export type InstructorAssignmentStandardWeaknessSignal =
  | "insufficient-data"
  | "weak"
  | "watch"
  | "ok";

export interface InstructorAssignmentStandardsMasteryRow {
  standardId: string;
  label: string;
  itemCount: number;
  scoredAttemptCount: number;
  averagePercent: number | null;
  weakItemCount: number;
  weakestItemAveragePercent: number | null;
  weaknessSignal: InstructorAssignmentStandardWeaknessSignal;
}

export interface InstructorAssignmentStandardsMastery {
  metadataAvailable: boolean;
  rows: InstructorAssignmentStandardsMasteryRow[];
}

export interface InstructorAssignmentReportingResponse {
  assignment: AssignmentRecord;
  summary: InstructorAssignmentReportingSummary;
  rosterSummary: InstructorAssignmentReportingRosterRow[];
  itemAnalysis: InstructorAssignmentReportingItemRow[];
  standardsMastery: InstructorAssignmentStandardsMastery;
}

export type InstructorLearnerReportEvidenceSummary = InstructorAccommodationEvidenceSummary & {
  itemPresentationCount: number;
  responseCount: number;
  submitCount: number;
  flaggedCount: number;
  queuedLocallyCount: number;
  replayedCount: number;
  staleTabReconciledCount: number;
  receiptConfirmedCount: number;
  syncFailedCount: number;
  latestKeywordTranslationRequestedLanguage: string | null;
  latestKeywordTranslationResolvedLanguage: string | null;
  firstEventAt: string | null;
  latestEventAt: string | null;
  latestSubmitAt: string | null;
};

export interface InstructorLearnerReportEvidenceEvent {
  id: string;
  attemptId: string;
  eventType: string;
  evidenceKind: string;
  outcome: string;
  sequenceNumber: number | null;
  itemId: string | null;
  responseKey: string | null;
  clientTimestamp: string | null;
  serverTimestamp: string;
  receiptId: string | null;
  eventSource: string;
  syncSignals: AttemptSyncHealthSignal[];
  support: string | null;
  supportState: string | null;
  requestedLanguage: string | null;
  resolvedLanguage: string | null;
  selectionReason: string | null;
  catalogIds: string[];
  assetReferences: string[];
  mediaTypes: string[];
  control: string | null;
  reason: string | null;
}

export interface InstructorLearnerReportAttemptRow {
  attemptId: string;
  status: AttemptStatus;
  launchedAt: string;
  submittedAt: string | null;
  finalizedAt: string | null;
  resultStatus: AttemptResultStatus | null;
  totalScore: number | null;
  maxScore: number | null;
  percentScore: number | null;
  finalization: ResultFinalizationStateSnapshot | null;
  latestScoreRevision: ScoreRevisionSnapshot | null;
  accommodationSnapshot: AttemptAccommodationSnapshotEvidence | null;
  evidenceSummary: InstructorLearnerReportEvidenceSummary;
}

export interface InstructorLearnerReportResult {
  attemptResultId: string;
  attemptId: string;
  status: AttemptResultStatus;
  totalScore: number | null;
  maxScore: number | null;
  percentScore: number | null;
  submittedAt: string;
  finalizedAt: string;
}

export interface InstructorLearnerReportItemStandard {
  standardId: string;
  label: string;
  code: string | null;
}

export interface InstructorLearnerReportItemRow {
  itemId: string;
  itemIdentifier: string | null;
  itemTitle: string | null;
  itemPosition: number | null;
  answered: boolean;
  responseSummary: string | null;
  score: number | null;
  maxScore: number | null;
  baseScore: number | null;
  baseMaxScore: number | null;
  percentScore: number | null;
  scoreAmended: boolean;
  scoreAmendmentIds: string[];
  standards: InstructorLearnerReportItemStandard[];
}

export type ManualScoringEntryStatus = "draft" | "released";

export interface ManualScoringEntrySnapshot {
  id: string;
  attemptResultItemId: string;
  itemId: string;
  status: ManualScoringEntryStatus;
  score: number;
  maxScore: number;
  studentFeedback: string | null;
  privateNote: string | null;
  scoredBy: AssignmentActorSnapshot;
  scoredAt: string;
  releasedAt: string | null;
  updatedAt: string;
}

export interface ManualScoringQueueRow {
  attemptId: string;
  attemptResultId: string;
  assignmentId: string | null;
  assignmentTitle: string | null;
  assessmentVersionId: string;
  assessmentTitle: string;
  learner: HarborLearnerRecord | null;
  submittedAt: string;
  pendingItemCount: number;
  scoredItemCount: number;
  latestReviewer: AssignmentActorSnapshot | null;
  latestUpdatedAt: string | null;
  status: "needs-review" | "in-progress" | "ready-to-finalize";
}

export interface ManualScoringQueueResponse {
  generatedAt: string;
  rows: ManualScoringQueueRow[];
}

export interface ManualScoringAttemptItem {
  attemptResultItemId: string;
  itemId: string;
  itemIdentifier: string | null;
  itemTitle: string | null;
  itemPosition: number | null;
  answered: boolean;
  responseSummary: string | null;
  responseVariables: AttemptVariableSnapshot[];
  outcomeVariables: AttemptVariableSnapshot[];
  authoredMaxScore: number | null;
  pendingManualScoring: boolean;
  manualScore: ManualScoringEntrySnapshot | null;
}

export interface ManualScoringAttemptResponse {
  attemptId: string;
  attemptResultId: string;
  assignment: {
    id: string;
    title: string;
    status: AssignmentStatus;
  } | null;
  assessment: {
    assessmentVersionId: string;
    title: string;
  };
  learner: HarborLearnerRecord | null;
  resultStatus: AttemptResultStatus;
  submittedAt: string;
  finalizedAt: string;
  items: ManualScoringAttemptItem[];
  canFinalize: boolean;
  generatedAt: string;
}

export interface SaveManualScoreRequest {
  actor: AssignmentActorSnapshot;
  score: number;
  maxScore: number;
  studentFeedback?: string | null;
  privateNote?: string | null;
}

export interface SaveManualScoreResponse {
  entry: ManualScoringEntrySnapshot;
}

export interface FinalizeManualScoringRequest {
  actor: AssignmentActorSnapshot;
}

export interface FinalizeManualScoringResponse {
  attemptResultId: string;
  attemptId: string;
  status: AttemptResultStatus;
  totalScore: number | null;
  maxScore: number | null;
  finalizedAt: string;
}

export interface InstructorLearnerReportStandardRow {
  standardId: string;
  label: string;
  itemCount: number;
  scoredItemCount: number;
  averagePercent: number | null;
}

export interface InstructorLearnerReportStandardsMastery {
  metadataAvailable: boolean;
  rows: InstructorLearnerReportStandardRow[];
}

export interface InstructorLearnerReportResponse {
  stagedAssessment?: import("./staged-results").StagedAssessmentSummary | null;
  assignment: AssignmentRecord;
  learner: HarborLearnerRecord;
  targetSource: "explicit" | "section";
  activeOverride: AssignmentLearnerOverrideRecord | null;
  attemptCount: number;
  latestAttempt: InstructorRosterAttemptProjection;
  latestResult: InstructorLearnerReportResult | null;
  attempts: InstructorLearnerReportAttemptRow[];
  itemResults: InstructorLearnerReportItemRow[];
  standardsMastery: InstructorLearnerReportStandardsMastery;
  scoreHistory: ScoreRevisionSnapshot[];
  accommodationSnapshot: AttemptAccommodationSnapshotEvidence | null;
  evidence: {
    summary: InstructorLearnerReportEvidenceSummary;
    events: InstructorLearnerReportEvidenceEvent[];
  };
  generatedAt: string;
}

export interface InstructorLearnerHistoryResponse extends AssignmentHistoryResponse {}

export const SCORE_AMENDMENT_ACTIONS = [
  "exclude-from-score",
  "set-correct-response",
  "award-full-credit",
] as const;

export const SCORE_AMENDMENT_STATUSES = ["active", "superseded", "inactive"] as const;

export type ScoreAmendmentAction = (typeof SCORE_AMENDMENT_ACTIONS)[number];
export type ScoreAmendmentStatus = (typeof SCORE_AMENDMENT_STATUSES)[number];

export interface ScoreAmendmentRecord {
  id: string;
  assignmentId: string;
  assessmentVersionId: string;
  itemId: string;
  action: ScoreAmendmentAction;
  responseMatchText: string | null;
  reason: string;
  status: ScoreAmendmentStatus;
  createdBy: AssignmentActorSnapshot;
  supersededById: string | null;
  supersededAt: string | null;
  deactivatedBy: AssignmentActorSnapshot | null;
  deactivatedReason: string | null;
  deactivatedAt: string | null;
  appliedAttemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreAmendmentsResponse {
  amendments: ScoreAmendmentRecord[];
}

export interface CreateScoreAmendmentRequest {
  actor: AssignmentActorSnapshot;
  itemId: string;
  action: ScoreAmendmentAction;
  responseMatchText?: string | null;
  reason: string;
}

export interface CreateScoreAmendmentResponse {
  amendment: ScoreAmendmentRecord;
  appliedAttemptCount: number;
  revisionCount: number;
}

export interface DeactivateScoreAmendmentRequest {
  actor: AssignmentActorSnapshot;
  reason: string;
}

export interface DeactivateScoreAmendmentResponse {
  amendment: ScoreAmendmentRecord;
  revertedAttemptCount: number;
  revisionCount: number;
}

export interface ScoreAmendmentPreviewApplication {
  itemId: string;
  responseSummary: string | null;
  responseEvidenceEventId: string | null;
  responseEvidenceSequenceNumber: number | null;
  responseEvidenceServerTimestamp: string | null;
  baseScore: number | null;
  baseMaxScore: number | null;
  currentScore: number | null;
  currentMaxScore: number | null;
  amendedScore: number | null;
  amendedMaxScore: number | null;
}

export interface ScoreAmendmentPreviewAttempt {
  attemptResultId: string;
  attemptId: string;
  currentTotalScore: number | null;
  currentMaxScore: number | null;
  amendedTotalScore: number | null;
  amendedMaxScore: number | null;
  applications: ScoreAmendmentPreviewApplication[];
}

export interface ScoreAmendmentPreviewResponse {
  assignmentId: string;
  generatedAt: string;
  itemId: string;
  action: ScoreAmendmentAction;
  responseMatchText: string | null;
  reason: string;
  totalScoredAttemptCount: number;
  affectedAttemptCount: number;
  affectedApplicationCount: number;
  supersededAmendmentIds: string[];
  attempts: ScoreAmendmentPreviewAttempt[];
}

export interface ScoreAmendmentEvidenceExportResponse {
  assignmentId: string;
  generatedAt: string;
  amendments: ScoreAmendmentRecord[];
  revisions: ScoreRevisionSnapshot[];
}

export type ProvisioningSourceKind =
  | "csv"
  | "oneroster"
  | "oneroster-rest-v1p2"
  | "lti-nrps"
  | "focus"
  | "manual";

export type ProvisioningRunMode = "dry-run" | "apply";

export type ProvisioningRunStatus = "previewed" | "applied" | "applied-with-errors" | "failed";

export interface CsvRosterImportRequest {
  sourceName?: string | null;
  csvText: string;
  actor: AssignmentActorSnapshot;
}

export interface OneRosterCsvFilesImportRequest {
  sourceName?: string | null;
  files: Record<string, string>;
  actor: AssignmentActorSnapshot;
}

export type OneRosterV1p2RosteringEntityKind =
  | "organizations"
  | "academicSessions"
  | "courses"
  | "classes"
  | "users"
  | "enrollments";

export interface OneRosterV1p2PreviewEntityCount {
  received: number;
  unique: number;
  active: number;
  inactive: number;
}

export interface OneRosterV1p2PreviewDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  entityKind?: OneRosterV1p2RosteringEntityKind;
  operationId?: string;
  status?: number;
  limitKind?: "maxPages" | "maxItems" | "elapsedTime" | "repeatedUrl";
}

export interface OneRosterV1p2RosteringPreviewResponse {
  source: ProvisioningSourceRecord;
  run: ProvisioningRunRecord;
  counts: Record<OneRosterV1p2RosteringEntityKind, OneRosterV1p2PreviewEntityCount>;
  diagnostics: OneRosterV1p2PreviewDiagnostic[];
}

export interface OneRosterV1p2RestSourceRecord {
  source: ProvisioningSourceRecord;
  version: "1.2";
  discoveryUrl: string;
  rosteringBaseUrl: string;
  tokenEndpoint: string;
  credentialBindingId: string;
  clientAuthentication: "client_secret_basic" | "client_secret_post";
  scopes: string[];
  traversal: {
    pageSize: number;
    maxPages: number;
    maxItems: number;
    maxElapsedMilliseconds: number;
  };
  retry: {
    maxAttempts: number;
    maxElapsedMilliseconds: number;
    statusCodes: number[];
    retryConnectionErrors: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

/** @deprecated Use {@link OneRosterCsvFilesImportRequest}. */
export type OneRosterCsvImportRequest = OneRosterCsvFilesImportRequest;

export interface ProvisioningSourceRecord {
  id: string;
  tenantId: string;
  sourceKind: ProvisioningSourceKind;
  sourceKey: string;
  sourceName: string;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface RosterProvisioningSummary {
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  learnerCreateCount: number;
  learnerUpdateCount: number;
  sectionCreateCount: number;
  sectionUpdateCount: number;
  membershipCreateCount: number;
  membershipReactivateCount: number;
  membershipDeactivateCount: number;
  membershipUnchangedCount: number;
  orgUpsertCount?: number;
  academicSessionUpsertCount?: number;
  courseUpsertCount?: number;
  classMetadataUpsertCount?: number;
  staffUserUpsertCount?: number;
  classStaffUpsertCount?: number;
  resourceUpsertCount?: number;
  classResourceUpsertCount?: number;
  courseResourceUpsertCount?: number;
  gradebookCategoryUpsertCount?: number;
  gradebookLineItemUpsertCount?: number;
  gradebookScoreScaleUpsertCount?: number;
  gradebookResultUpsertCount?: number;
  oneRosterRestCounts?: Record<OneRosterV1p2RosteringEntityKind, OneRosterV1p2PreviewEntityCount>;
}

export interface RosterProvisioningError {
  rowNumber: number | null;
  field: string | null;
  code: string;
  message: string;
  rawRow: Record<string, string> | null;
}

export interface RosterProvisioningPreviewRow {
  rowNumber: number;
  learnerExternalId: string;
  learnerDisplayName: string;
  learnerEmail: string | null;
  sectionExternalId: string;
  sectionTitle: string;
  membershipStatus: "active" | "inactive";
  actions: string[];
}

export interface ProvisioningRunRecord {
  id: string;
  sourceId: string;
  tenantId: string;
  sourceKind: ProvisioningSourceKind;
  sourceName: string;
  mode: ProvisioningRunMode;
  status: ProvisioningRunStatus;
  actor: AssignmentActorSnapshot;
  inputSha256: string;
  summary: RosterProvisioningSummary;
  startedAt: string;
  completedAt: string;
}

export interface RosterCsvImportResponse {
  source: ProvisioningSourceRecord;
  run: ProvisioningRunRecord;
  summary: RosterProvisioningSummary;
  errors: RosterProvisioningError[];
  previewRows: RosterProvisioningPreviewRow[];
}

export interface ProvisioningRunsResponse {
  runs: ProvisioningRunRecord[];
}

export interface ProvisioningRunDetailResponse {
  run: ProvisioningRunRecord;
  errors: RosterProvisioningError[];
}

export interface InstructorLmsRegistrationSummary {
  id: string;
  issuer: string;
  clientId: string;
  deploymentId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string | null;
  jwksUrl: string;
  resourceLinkCount: number;
  deepLinkPlacementCount: number;
  launchCount: number;
  agsLaunchCount: number;
  nrpsLaunchCount: number;
  lastLaunchAt: string | null;
  lastNrpsSync: InstructorLmsNrpsSyncRun | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstructorLmsResourceLinkSummary {
  id: string;
  registrationId: string;
  assignmentId: string;
  assignmentTitle: string;
  resourceLinkId: string;
  contextId: string | null;
  sectionId: string | null;
  sectionTitle: string | null;
  latestAttemptId: string | null;
  latestLaunchAt: string | null;
  agsAvailable: boolean;
  nrpsAvailable: boolean;
  latestNrpsSync: InstructorLmsNrpsSyncRun | null;
  nrpsSyncSchedule: InstructorLmsNrpsSyncSchedule | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstructorLmsDeepLinkPlacementSummary {
  id: string;
  registrationId: string;
  ltiSessionId: string;
  placementKey: string;
  assignmentId: string;
  assignmentTitle: string;
  contextId: string | null;
  sectionId: string | null;
  sectionTitle: string | null;
  title: string;
  text: string | null;
  lineItemLabel: string | null;
  lineItemScoreMaximum: number | null;
  lineItemTag: string | null;
  linkedResourceLinkId: string | null;
  linkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstructorLmsNrpsSyncRun {
  runId: string;
  attemptId: string;
  registrationId: string;
  ltiSessionId: string;
  resourceLinkId: string;
  sectionId: string;
  status: "complete" | "failed";
  totalMembers: number;
  learnerMembershipsUpserted: number;
  learnerMembershipsDeactivated: number;
  skippedMembers: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface InstructorLmsNrpsSyncSchedule {
  id: string;
  resourceLinkId: string;
  enabled: boolean;
  intervalMinutes: number;
  reconciliationPolicy: "additive-only" | "mark-inactive";
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstructorLmsWorkspaceResponse {
  generatedAt: string;
  registrations: InstructorLmsRegistrationSummary[];
  resourceLinks: InstructorLmsResourceLinkSummary[];
  deepLinkPlacements: InstructorLmsDeepLinkPlacementSummary[];
  nrpsSyncRuns: InstructorLmsNrpsSyncRun[];
  setup: {
    dynamicRegistrationUrl: string;
  };
}

export interface InstructorLmsNrpsSyncRequest {
  attemptId: string;
}

export interface InstructorLmsNrpsSyncResponse {
  run: InstructorLmsNrpsSyncRun;
}

export interface InstructorLmsNrpsScheduleRequest {
  enabled: boolean;
  intervalMinutes?: number;
  reconciliationPolicy?: "additive-only" | "mark-inactive";
}

export interface InstructorLmsNrpsScheduleResponse {
  schedule: InstructorLmsNrpsSyncSchedule;
}
