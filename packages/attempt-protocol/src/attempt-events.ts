import type { CandidateResponseCheckpoint } from "./response-checkpoint";
import type {
  AttemptStatus,
  BootstrapSequenceState,
  BootstrapTimingState,
  CurrentItemRef,
} from "./bootstrap";
import type { AttemptPolicyState } from "./policy-operations";
import type { AttemptSubmissionMaterializationInput } from "./results";
import type { AccommodationSupportEvidencePayload } from "./accommodation-evidence";

export const ATTEMPT_EVENT_TYPES = [
  "item.presented",
  "accommodation.support",
  "response.changed",
  "item.submit-requested",
  "item.suspended",
  "item.completed",
  "navigation.requested",
  "keyword-translation.language.selected",
  "timing.deadline.warned",
  "timing.deadline.reached",
  "heartbeat",
  "submit.requested",
  "timing.auto-submit.requested",
] as const;

export const ATTEMPT_EVENT_COMMIT_PATH_TEMPLATE = "/api/attempts/:attemptId/events";
export const INTERNAL_ATTEMPT_EVIDENCE_PATH_TEMPLATE = "/internal/attempts/:attemptId/evidence";

export type AttemptEventType = (typeof ATTEMPT_EVENT_TYPES)[number];

export interface ResponseChangedPayload {
  clientEditRevision?: number;
  /** A durable draft checkpoint does not invoke adaptive response processing. */
  intent?: "checkpoint";
  responseKey: string;
  responseState: unknown;
}

export interface ItemPresentedPayload {
  presentedAt?: string | null;
  presentationSource?:
    | "bootstrap"
    | "resume"
    | "navigation"
    | "replay"
    | "manual-refresh"
    | "unknown";
}

export interface TimingDeadlineEvidencePayload {
  eventSource: "browser";
  scopeKey: string;
  scopeType: string;
  identifier: string;
  deadlineAt: string;
  effectiveTimingPolicyVersion: number | null;
  remainingTimeSeconds: number;
}

export interface AttemptItemScoreSummary {
  itemId: string;
  itemIdentifier: string;
  itemTitle: string;
  answered: boolean;
  responseSummary?: string | null;
  manualFeedback?: string | null;
  score: number | null;
  maxScore: number | null;
  baseScore?: number | null;
  baseMaxScore?: number | null;
  scoreAmended?: boolean;
  scoreAmendmentIds?: string[];
}

export interface AttemptSubmissionSummary {
  itemCount: number;
  answeredItemCount: number;
  scoredItemCount: number;
  totalScore: number | null;
  maxScore: number | null;
  submittedAt?: string | null;
  items: AttemptItemScoreSummary[];
}

export interface ItemSuspendedPayload {
  reason?: string | null;
}

export interface ItemCompletedPayload {
  completedAt?: string | null;
}

export interface NavigationRequestedPayload {
  targetItemRef: CurrentItemRef;
}

/** Records the learner's attempt-scoped keyword translation language preference. */
export interface KeywordTranslationLanguageSelectedPayload {
  requestedLanguage: string;
}

export interface HeartbeatPayload {
  observedAt?: string | null;
}

export interface SubmitRequestedPayload {
  requestedAt?: string | null;
  submissionSummary?: AttemptSubmissionSummary | null;
  submissionMaterialization?: AttemptSubmissionMaterializationInput | null;
}

export interface TimingAutoSubmitRequestedPayload {
  requestedAt?: string | null;
  reason: "max-time-reached" | "assignment-deadline-reached";
  scopeKey?: string | null;
  submissionSummary?: AttemptSubmissionSummary | null;
  submissionMaterialization?: AttemptSubmissionMaterializationInput | null;
}

export interface AttemptEventPayloadByType {
  "item.presented": ItemPresentedPayload;
  "accommodation.support": AccommodationSupportEvidencePayload;
  "response.changed": ResponseChangedPayload;
  "item.submit-requested": ResponseChangedPayload;
  "item.suspended": ItemSuspendedPayload;
  "item.completed": ItemCompletedPayload;
  "navigation.requested": NavigationRequestedPayload;
  "keyword-translation.language.selected": KeywordTranslationLanguageSelectedPayload;
  "timing.deadline.warned": TimingDeadlineEvidencePayload;
  "timing.deadline.reached": TimingDeadlineEvidencePayload;
  heartbeat: HeartbeatPayload;
  "submit.requested": SubmitRequestedPayload;
  "timing.auto-submit.requested": TimingAutoSubmitRequestedPayload;
}

export interface AttemptClientSyncTrace {
  queuedAt: string;
  sentAt: string;
  sendReason: "initial" | "replay";
  queueDepthAtSend: number;
  replayAttempt: number;
}

export type AttemptEventEnvelope<TType extends AttemptEventType = AttemptEventType> = {
  attemptId: string;
  eventId: string;
  idempotencyKey: string;
  sequenceNumber: number;
  clientTimestamp: string;
  clientSessionId: string;
  itemRef: CurrentItemRef;
  type: TType;
  payload: AttemptEventPayloadByType[TType];
  clientMonotonicElapsedTimeMs?: number;
  syncTrace?: AttemptClientSyncTrace;
};

export type AttemptEvidenceKind =
  | "item-presentation"
  | "accommodation-support"
  | "response"
  | "navigation"
  | "item-lifecycle"
  | "heartbeat"
  | "submit"
  | "timing";

/** Outcome for server-projected evidence that never traversed the client commit frontier. */
export const SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME = "observed" as const;

export type AttemptEvidenceOutcome =
  | AttemptEventCommitResponse["outcome"]
  | typeof SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME
  | "rejected";

export type AttemptSyncHealthSignal =
  | "queued_locally"
  | "replayed"
  | "stale_tab_reconciled"
  | "receipt_confirmed"
  | "sync_failed";

export interface AttemptEvidenceEvent {
  id: string;
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  eventId: string | null;
  eventType: string;
  evidenceKind: AttemptEvidenceKind;
  sequenceNumber: number | null;
  idempotencyKey: string | null;
  clientSessionId: string | null;
  itemRef: CurrentItemRef | null;
  responseKey: string | null;
  clientTimestamp: string | null;
  serverTimestamp: string;
  outcome: AttemptEvidenceOutcome;
  receiptId: string | null;
  eventSource: string;
  syncSignals: AttemptSyncHealthSignal[];
  flags: Record<string, unknown>;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AttemptEvidenceResponse {
  attemptId: string;
  events: AttemptEvidenceEvent[];
}

export type AttemptTimingState = BootstrapTimingState;

export interface AttemptTimingDecision {
  classification: "on-time" | "late-accepted" | "late-rejected" | "late-preserved";
  scopeKey: string | null;
  scopeType: string | null;
  identifier: string | null;
  deadlineAt: string | null;
  serverTimestamp: string;
  allowLateSubmission: boolean | null;
}

export interface AuthoritativeAttemptSessionState {
  responseCheckpoint?: CandidateResponseCheckpoint;
  currentItemRef: CurrentItemRef;
  sequence: BootstrapSequenceState;
  timing: AttemptTimingState;
  attemptStatus: AttemptStatus;
  deliveryPreferences?: AttemptDeliveryPreferences;
}

/** Learner-selected delivery preferences persisted with the authoritative attempt. */
export interface AttemptDeliveryPreferences {
  keywordTranslationLanguage: string | null;
}

/** Applies optimistic client-side delivery preference updates before commit receipts arrive. */
export function applyOptimisticDeliveryPreferences(
  preferences: AttemptDeliveryPreferences,
  event: Pick<AttemptEventEnvelope, "type" | "payload">,
): AttemptDeliveryPreferences {
  if (event.type !== "keyword-translation.language.selected") {
    return preferences;
  }
  if (
    !("requestedLanguage" in event.payload) ||
    typeof event.payload.requestedLanguage !== "string"
  ) {
    return preferences;
  }

  return {
    keywordTranslationLanguage: event.payload.requestedLanguage,
  };
}

export interface CommitAttemptEventReceipt {
  outcome: "accepted";
  receiptId: string;
  attemptId: string;
  acceptedEventId: string;
  acceptedSequenceNumber: number;
  highestCommittedSequence: number;
  attemptStatus: AttemptStatus;
  currentItemRef: CurrentItemRef;
  timing: AttemptTimingState;
  policy?: AttemptPolicyState;
  deliveryPreferences?: AttemptDeliveryPreferences;
  timingDecision?: AttemptTimingDecision;
  serverTimestamp: string;
}

interface AttemptReconciliationBase {
  attemptId: string;
  highestCommittedSequence: number;
  expectedNextSequence: number;
  attemptStatus: AttemptStatus;
  currentItemRef: CurrentItemRef;
  timing: AttemptTimingState;
  policy?: AttemptPolicyState;
  deliveryPreferences?: AttemptDeliveryPreferences;
  requestedSequenceNumber: number;
}

export interface AttemptReconciliationDuplicate extends AttemptReconciliationBase {
  outcome: "duplicate";
  storedReceipt: CommitAttemptEventReceipt;
}

export interface AttemptReconciliationStaleSequence extends AttemptReconciliationBase {
  outcome: "stale_sequence";
}

export interface AttemptReconciliationGap extends AttemptReconciliationBase {
  outcome: "gap";
  replayFromSequenceNumber: number;
}

export interface AttemptReconciliationStaleSession extends AttemptReconciliationBase {
  outcome: "stale_session";
  currentClientSessionId: string | null;
  requestedClientSessionId: string;
}

export interface AttemptLatePreserved extends AttemptReconciliationBase {
  outcome: "late_preserved";
  timingDecision?: AttemptTimingDecision;
  serverTimestamp: string;
}

export type AttemptEventCommitResponse =
  | CommitAttemptEventReceipt
  | AttemptReconciliationDuplicate
  | AttemptReconciliationStaleSequence
  | AttemptReconciliationGap
  | AttemptReconciliationStaleSession
  | AttemptLatePreserved;
