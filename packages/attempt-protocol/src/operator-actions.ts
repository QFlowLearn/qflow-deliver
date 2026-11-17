import type {
  AttemptAccommodationEvidenceSummary,
  AttemptAccommodationState,
  AttemptAccommodationTimingEvidence,
  AttemptPolicyActorIdentity,
  AttemptOperatorMessageLevel,
  HarborShellAccommodationState,
} from "./policy-operations";

export const INTERNAL_ATTEMPT_ACTIONS_PATH_TEMPLATE = "/internal/attempts/:attemptId/actions";
export const INTERNAL_ATTEMPT_ACTIONS_BATCH_PATH = "/internal/attempt-actions/batch";
export const INTERNAL_ATTEMPT_TIMELINE_PATH_TEMPLATE = "/internal/attempts/:attemptId/timeline";
export const INTERNAL_ASSESSMENT_VERSION_ACTIVATION_PATH_TEMPLATE =
  "/internal/assessments/:assessmentId/activate-version";

export const OPERATOR_ATTEMPT_ACTION_TYPES = [
  "transfer-workstation",
  "extend-time",
  "reopen-attempt",
  "post-operator-message",
] as const;

export type OperatorAttemptActionType = (typeof OPERATOR_ATTEMPT_ACTION_TYPES)[number];

interface OperatorAttemptActionBase<TType extends OperatorAttemptActionType> {
  actionId: string;
  type: TType;
  actor: AttemptPolicyActorIdentity;
  reason: string;
  effectiveAt: string;
}

export interface ExtendTimeOperatorAttemptAction extends OperatorAttemptActionBase<"extend-time"> {
  additionalTimeSeconds: number;
}

export interface ReopenOperatorAttemptAction extends OperatorAttemptActionBase<"reopen-attempt"> {
  reopenUntil: string | null;
}

export interface PostOperatorMessageBody {
  level: AttemptOperatorMessageLevel;
  title: string;
  body: string;
  effectiveUntil: string | null;
}

export interface PostMessageOperatorAttemptAction extends OperatorAttemptActionBase<"post-operator-message"> {
  message: PostOperatorMessageBody;
}

/** Transfer to the replacement workstation explicitly authorized by exam supervision. */
export interface TransferWorkstationOperatorAttemptAction extends OperatorAttemptActionBase<"transfer-workstation"> {
  clientSessionId: string;
}

export type OperatorAttemptActionRequest =
  | TransferWorkstationOperatorAttemptAction
  | ExtendTimeOperatorAttemptAction
  | ReopenOperatorAttemptAction
  | PostMessageOperatorAttemptAction;

export interface BatchOperatorAttemptActionRequest {
  attemptIds: string[];
  action: OperatorAttemptActionRequest;
}

export const ATTEMPT_TIMELINE_EVENT_TYPES = [
  "launch",
  "reconnect",
  "accepted-checkpoint",
  "submit",
  "override",
  "secure-browser",
] as const;

export type AttemptTimelineEventType = (typeof ATTEMPT_TIMELINE_EVENT_TYPES)[number];

export interface AttemptTimelineActorSnapshot {
  role: AttemptPolicyActorIdentity["role"];
  actorId: string;
  displayName: string | null;
}

export interface AttemptTimelineEntry {
  id: string;
  attemptId: string;
  eventType: AttemptTimelineEventType;
  sequenceNumber: number | null;
  summary: Record<string, unknown>;
  actor: AttemptTimelineActorSnapshot | null;
  reason: string | null;
  createdAt: string;
}

export interface AttemptTimelineResponse {
  recovery?: { lastConfirmedSaveAt: string | null; acceptedResponseSequence: number | null };
  attemptId: string;
  entries: AttemptTimelineEntry[];
  accommodationSnapshot: AttemptAccommodationSnapshotEvidence | null;
}

export interface AttemptAccommodationSnapshotEvidence {
  profileIds: string[];
  learnerProfileAssignmentIds: string[];
  assignmentOverrideId: string | null;
  accommodations: AttemptAccommodationState;
  shellTools: HarborShellAccommodationState;
  timing: AttemptAccommodationTimingEvidence;
  summary: AttemptAccommodationEvidenceSummary;
  createdAt: string;
}

export interface ActivateAssessmentVersionRequest {
  activationId: string;
  assessmentId: string;
  assessmentVersionId: string;
  actor: AttemptPolicyActorIdentity;
  reason: string;
  activatedAt: string;
}

export interface AssessmentVersionActivationRecord {
  activationId: string;
  assessmentId: string;
  assessmentVersionId: string;
  actor: AttemptPolicyActorIdentity;
  reason: string;
  activatedAt: string;
  createdAt: string;
}
