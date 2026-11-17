import type { CandidateResponseCheckpoint } from "./response-checkpoint";
import type { DeliveryPolicySnapshot, LaunchMode } from "@harbor/content-model";
import type { DeliveryContextEvaluation } from "./delivery-contexts";
import type { AttemptPolicyState } from "./policy-operations";
import type { AttemptDeliveryPreferences } from "./attempt-events";

export const BOOTSTRAP_EXCHANGE_PATH = "/api/bootstrap";
export const BOOTSTRAP_TOKEN_AUDIENCE = "harbor-shell";
export const BOOTSTRAP_TOKEN_ISSUER = "harbor-runtime";
export const BOOTSTRAP_TOKEN_TTL_SECONDS = 5 * 60;

interface BaseLaunchActor {
  id: string | null;
  displayName: string | null;
  learnerId?: string;
}

export interface PreviewLaunchActor extends BaseLaunchActor {
  kind: "preview-operator";
}

export interface AccessCodeLaunchActor extends BaseLaunchActor {
  kind: "access-code-candidate";
}

export interface StudentLaunchActor extends BaseLaunchActor {
  kind: "student-learner";
  learnerId: string;
  sessionId: string | null;
}

export type LaunchActor = PreviewLaunchActor | AccessCodeLaunchActor | StudentLaunchActor;

export interface PreviewLaunchRequest {
  mode: "preview";
  assessmentVersionId: string;
  actor: PreviewLaunchActor;
}

export interface AccessCodeLaunchRequest {
  mode: "access-code";
  assessmentVersionId?: string;
  accessCode: string;
  actor: AccessCodeLaunchActor;
}

export interface StudentLaunchRequest {
  mode: "institutional-sso" | "lti";
  assignmentId: string;
  actor: StudentLaunchActor;
}

export type LaunchRequest = PreviewLaunchRequest | AccessCodeLaunchRequest | StudentLaunchRequest;

export interface ManifestReference {
  manifestObjectKey: string;
}

export interface CurrentItemRef {
  itemId: string;
  itemHref: string;
}

export interface LaunchMetadata {
  mode: LaunchMode;
  actor: LaunchActor;
}

export interface BootstrapEnvelope {
  bootstrapToken: string;
  exchangeUrl: string;
  expiresAt: string;
  launch: LaunchMetadata;
}

export interface BootstrapClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  attemptId: string;
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
  /** Digest binds private SEB verification settings without exposing them. */
  deliveryPolicyFingerprint: string;
  manifest: ManifestReference;
  currentItemRef: CurrentItemRef;
  launch: LaunchMetadata;
}

export interface BootstrapSequenceState {
  lastAcceptedSequence: number | null;
  nextSequence: number | null;
}

export type AttemptStatus =
  | "active"
  | "soft_closed"
  | "accepting_late_within_grace"
  | "submitted"
  | "expired_pending_recovery"
  | "reopened";

export type AttemptTimingScopeType =
  | "assessment-test"
  | "test-part"
  | "assessment-section"
  | "assessment-item-ref"
  | "item-session";

export type AttemptTimingScopeStatus =
  | "initial"
  | "interacting"
  | "suspended"
  | "closed"
  | "review"
  | "solution";

export interface AttemptTimingScopeState {
  key: string;
  scopeType: AttemptTimingScopeType;
  identifier: string;
  itemId?: string | null;
  status: AttemptTimingScopeStatus;
  elapsedTimeSeconds: number;
  enteredAt: string | null;
  exitedAt: string | null;
  deadlineAt: string | null;
  minTimeSeconds: number | null;
  maxTimeSeconds: number | null;
  allowLateSubmission: boolean;
  unlimited: boolean;
}

export interface BootstrapTimingState {
  startedAt: string | null;
  expiresAt: string | null;
  softCloseAt?: string | null;
  acceptUntil?: string | null;
  remainingTimeSeconds: number | null;
  effectivePolicyVersion?: number;
  currentItemDurationSeconds?: number | null;
  scopes?: AttemptTimingScopeState[];
}

export interface BootstrapSessionState {
  responseCheckpoint?: CandidateResponseCheckpoint;
  currentItemRef: CurrentItemRef;
  sequence: BootstrapSequenceState | null;
  timing: BootstrapTimingState | null;
  attemptStatus?: AttemptStatus;
  deliveryPreferences?: AttemptDeliveryPreferences;
}

export interface BootstrapPayload {
  attemptId: string;
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
  deliveryContext?: DeliveryContextEvaluation;
  policy?: AttemptPolicyState;
  manifest: ManifestReference;
  launch: LaunchMetadata;
  session: BootstrapSessionState;
}

export type {
  DeliveryPolicySnapshot,
  LaunchMode,
  QtiItemSessionControlSnapshot,
  QtiTimeLimitsSnapshot,
  QtiTimingMetadataSnapshot,
} from "@harbor/content-model";
