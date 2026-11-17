import type { LaunchActor, LaunchMode } from "./bootstrap";

export const LEARNER_IDENTITY_PROVIDER_KINDS = ["institutional-sso", "lti", "password"] as const;
export const ASSIGNMENT_TARGET_SOURCE_KINDS = ["explicit", "section"] as const;
export const HARBOR_SESSION_STATUSES = ["active", "revoked", "expired"] as const;

export type LearnerIdentityProviderKind = (typeof LEARNER_IDENTITY_PROVIDER_KINDS)[number];
export type AssignmentTargetSourceKind = (typeof ASSIGNMENT_TARGET_SOURCE_KINDS)[number];
export type HarborSessionStatus = (typeof HARBOR_SESSION_STATUSES)[number];

export interface HarborLearnerRecord {
  id: string;
  tenantId: string;
  displayName: string;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearnerIdentityRecord {
  id: string;
  learnerId: string;
  providerKind: LearnerIdentityProviderKind;
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SectionRecord {
  id: string;
  tenantId: string;
  sourceKind: "manual" | "lti-context" | "csv" | "oneroster";
  sourceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SectionMembershipRecord {
  id: string;
  sectionId: string;
  learnerId: string;
  role: "learner";
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface HarborSessionRecord {
  id: string;
  learnerId: string;
  providerKind: LearnerIdentityProviderKind;
  issuer: string;
  subject: string;
  status: HarborSessionStatus;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface InstitutionalAuthStateRecord {
  id: string;
  state: string;
  nonce: string;
  providerKey: string;
  redirectTo: string;
  profileHint: string | null;
  requestedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface LtiPlatformRegistrationRecord {
  id: string;
  issuer: string;
  clientId: string;
  deploymentId: string;
  authorizationEndpoint: string;
  jwksUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface LtiLaunchStateRecord {
  id: string;
  registrationId: string;
  state: string;
  nonce: string;
  loginHint: string;
  ltiMessageHint: string | null;
  targetLinkUri: string;
  requestedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface LtiAssignmentLinkage {
  registrationId: string;
  resourceLinkId: string;
  contextId?: string | null;
  sectionId?: string | null;
}

export interface LtiResourceLinkRecord extends LtiAssignmentLinkage {
  id: string;
  assignmentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntryLaunchResolution {
  source: LaunchMode;
  assignmentId: string | null;
  assessmentVersionId: string;
  learnerId: string | null;
  sessionId: string | null;
  launchActor: LaunchActor;
}

export interface StudentAssignmentListItem {
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  availableFrom: string | null;
  availableUntil: string | null;
  attemptStatus: "not-started" | "in-progress" | "submitted" | "ineligible";
  resumeAttemptId: string | null;
  submittedAttemptId: string | null;
  attemptCount: number;
  remainingAttempts: number;
  canLaunch: boolean;
  targetSource: AssignmentTargetSourceKind;
  safeExamBrowser: {
    required: boolean;
    configured: boolean;
    generatedConfigAvailable: boolean;
  } | null;
}

export interface StudentAssignmentListResponse {
  learner: HarborLearnerRecord;
  session: HarborSessionRecord;
  assignments: StudentAssignmentListItem[];
}

export interface StudentSafeExamBrowserLaunchResponse {
  assignmentId: string;
  configDownloadUrl: string;
  configLaunchUrl: string;
  configFileName: string;
  startUrl: string;
  quitUrl: string;
  expiresAt: string;
}

export interface InstitutionalSessionResponse {
  learner: HarborLearnerRecord;
  session: HarborSessionRecord;
}
