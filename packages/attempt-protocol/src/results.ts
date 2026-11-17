import type { AttemptSubmissionSummary } from "./attempt-events";
import type { AssignmentActorSnapshot } from "./assignments";

export const RESULT_FINALIZATION_STATUSES = ["pending", "complete", "failed"] as const;

export const ATTEMPT_RESULT_STATUSES = ["pending", "complete", "failed", "rescored"] as const;

export const ATTEMPT_RESULT_SOURCES = [
  "authoritative-qti-snapshot",
  "compatibility-submission-summary",
] as const;

export type ResultFinalizationStatus = (typeof RESULT_FINALIZATION_STATUSES)[number];
export type AttemptResultStatus = (typeof ATTEMPT_RESULT_STATUSES)[number];
export type AttemptResultSource = (typeof ATTEMPT_RESULT_SOURCES)[number];

export const HARBOR_SCORING_STATUS_OUTCOME_IDENTIFIER = "HARBOR_SCORING_STATUS";
export const HARBOR_MANUAL_FEEDBACK_OUTCOME_IDENTIFIER = "HARBOR_MANUAL_FEEDBACK";
export const HARBOR_PENDING_MANUAL_SCORING_STATUS = "pending-manual-scoring";
export const HARBOR_MANUAL_SCORING_COMPLETE_STATUS = "manual-scoring-complete";

export interface AttemptVariableSnapshot {
  identifier: string;
  value: unknown;
}

export function readHarborScoringStatus(
  outcomeVariables: AttemptVariableSnapshot[],
): string | null {
  const variable = outcomeVariables.find(
    (entry) => entry.identifier === HARBOR_SCORING_STATUS_OUTCOME_IDENTIFIER,
  );
  return typeof variable?.value === "string" ? variable.value : null;
}

export function hasPendingManualScoringOutcome(
  outcomeVariables: AttemptVariableSnapshot[],
): boolean {
  return readHarborScoringStatus(outcomeVariables) === HARBOR_PENDING_MANUAL_SCORING_STATUS;
}

export interface AttemptValidationMessageSnapshot {
  identifier: string | null;
  message: string;
}

export interface AttemptAdaptiveTurnSnapshot {
  lastAppliedResponseEventId: string;
  lastAppliedResponseSequenceNumber: number;
}

export interface AttemptItemServerStateSnapshot {
  testSubmission?: { readonly score: 0 | 1 };
  adaptiveTurn?: AttemptAdaptiveTurnSnapshot;
}

export interface AttemptContainerStateSnapshot {
  identifier: string;
  responseVariables: AttemptVariableSnapshot[];
  outcomeVariables: AttemptVariableSnapshot[];
  stateJson?: unknown;
}

export interface AttemptItemQtiSnapshot {
  itemId: string;
  itemIdentifier: string | null;
  itemTitle: string | null;
  capturedAt: string | null;
  responseVariables: AttemptVariableSnapshot[];
  outcomeVariables: AttemptVariableSnapshot[];
  validationMessages: AttemptValidationMessageSnapshot[];
  stateJson?: unknown;
  serverState?: AttemptItemServerStateSnapshot;
}

export interface AttemptSubmissionMaterializationInput {
  itemOrder: string[];
  testState: AttemptContainerStateSnapshot | null;
  partStates: Record<string, AttemptContainerStateSnapshot>;
  sectionStates: Record<string, AttemptContainerStateSnapshot>;
  items: Record<string, AttemptItemQtiSnapshot>;
}

export interface AttemptResultFinalizationRecord {
  id: string;
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  sourceReceiptId: string;
  sourceSequenceNumber: number;
  status: ResultFinalizationStatus;
  materializedFrom: AttemptResultSource;
  submittedAt: string;
  finalizedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResultFinalizationStateSnapshot {
  status: ResultFinalizationStatus;
  errorMessage: string | null;
  updatedAt: string;
}

export interface AuthoritativeAttemptResultItem {
  itemId: string;
  itemIdentifier: string | null;
  itemTitle: string | null;
  answered: boolean;
  responseSummary?: string | null;
  score: number | null;
  maxScore: number | null;
  baseScore?: number | null;
  baseMaxScore?: number | null;
  scoreAmended?: boolean;
  scoreAmendmentIds?: string[];
  responseVariables: AttemptVariableSnapshot[];
  outcomeVariables: AttemptVariableSnapshot[];
  sessionStatus?:
    | "initial"
    | "pendingSubmission"
    | "pendingResponseProcessing"
    | "pendingExternalScoring"
    | "final";
}

export interface ScoreRevisionApplicationSnapshot {
  amendmentId: string;
  itemId: string;
  responseSummary: string | null;
  responseEvidenceEventId: string | null;
  responseEvidenceSequenceNumber: number | null;
  responseEvidenceServerTimestamp: string | null;
  baseScore: number | null;
  baseMaxScore: number | null;
  previousScore: number | null;
  previousMaxScore: number | null;
  amendedScore: number | null;
  amendedMaxScore: number | null;
  appliedAt: string;
}

export interface ScoreRevisionSnapshot {
  revisionId: string;
  attemptResultId: string;
  attemptId: string;
  assignmentId: string | null;
  revisionNumber: number;
  amendmentIds: string[];
  previousTotalScore: number | null;
  previousMaxScore: number | null;
  amendedTotalScore: number | null;
  amendedMaxScore: number | null;
  reason: string;
  createdBy: AssignmentActorSnapshot;
  createdAt: string;
  applications: ScoreRevisionApplicationSnapshot[];
}

export interface AuthoritativeAttemptResultRecord {
  id: string;
  attemptId: string;
  resultFinalizationId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  sourceReceiptId: string;
  status: AttemptResultStatus;
  summarySource: AttemptResultSource;
  totalScore: number | null;
  maxScore: number | null;
  passed: boolean | null;
  submittedAt: string;
  finalizedAt: string;
  testResponseVariables: AttemptVariableSnapshot[];
  testOutcomeVariables: AttemptVariableSnapshot[];
  items: AuthoritativeAttemptResultItem[];
}

export interface AssignmentHistoryAttemptSummary {
  stagedAssessment?: import("./staged-results").StagedAssessmentSummary | null;
  attemptId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  createdAt: string;
  submittedAt: string;
  totalScore: number | null;
  maxScore: number | null;
  answeredItemCount: number;
  scoredItemCount: number;
  itemCount: number;
  resultStatus: AttemptResultStatus | null;
  finalization: ResultFinalizationStateSnapshot | null;
  latestScoreRevision: ScoreRevisionSnapshot | null;
  items: AttemptSubmissionSummary["items"];
}

export interface AssignmentHistoryResponse {
  attemptId: string;
  assignmentId: string | null;
  assessment: {
    id: string;
    title: string;
    assessmentVersionId: string;
    assignmentTitle: string | null;
  };
  actor: {
    kind: string;
    id: string | null;
    displayName: string | null;
    learnerId: string | null;
  };
  attempts: AssignmentHistoryAttemptSummary[];
}
