import type { StaffActorRole } from "./staff";
import type { NavigationMode, SafeExamBrowserPolicySnapshot } from "@harbor/content-model";
import type { LtiAssignmentLinkage } from "./entry";

export const ASSIGNMENT_STATUSES = ["draft", "active", "closed"] as const;
export const ASSIGNMENT_TARGET_KINDS = ["learner", "section"] as const;
export const QFLOW_HANDOFF_KINDS = ["activate-version", "upsert-assignment"] as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export type AssignmentTargetKind = (typeof ASSIGNMENT_TARGET_KINDS)[number];
export type QflowHandoffKind = (typeof QFLOW_HANDOFF_KINDS)[number];

export interface AssignmentActorSnapshot {
  role: "instructor" | "operator" | "system" | "qflow" | StaffActorRole;
  actorId: string;
  displayName: string | null;
}

export interface AssignmentPolicySnapshot {
  availableFrom: string | null;
  availableUntil: string | null;
  reportingTimezone: string;
  maxAttempts: number;
  timeLimitSeconds: number | null;
  gracePeriodSeconds: number | null;
  navigationMode: NavigationMode;
  standaloneAllowed: boolean;
  iframeAllowed: boolean;
  allowedEmbedOrigins: string[];
  secureBrowserRequired: boolean;
  secureBrowserProviderHint: string | null;
  safeExamBrowser?: SafeExamBrowserPolicySnapshot | null;
  proctoringProvider: string | null;
}

export interface AssignmentLearnerTarget {
  kind: "learner";
  learnerId: string;
}

export interface AssignmentSectionTarget {
  kind: "section";
  sectionId: string;
}

export type AssignmentTarget = AssignmentLearnerTarget | AssignmentSectionTarget;

export interface AssignmentRecord {
  id: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  status: AssignmentStatus;
  policySnapshot: AssignmentPolicySnapshot;
  targets: AssignmentTarget[];
  ltiLinkages: LtiAssignmentLinkage[];
  createdBy: AssignmentActorSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssignmentRequest {
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  status?: AssignmentStatus;
  actor: AssignmentActorSnapshot;
  policySnapshot: AssignmentPolicySnapshot;
  targets?: AssignmentTarget[];
  ltiLinkages?: LtiAssignmentLinkage[];
}

export type AssignmentReadResponse = AssignmentRecord;

export interface HarborVersionLinkage {
  assessmentId: string;
  assessmentVersionId: string;
  manifestObjectKey: string;
}

export interface QflowPublishRequest {
  publishId: string;
  qflowTenantId: string;
  qflowAssessmentId: string;
  packageUrl: string;
  assessmentSlug?: string | null;
  packageName?: string | null;
  exportFormat?: "qti3" | null;
  exportWarnings?: unknown[] | null;
  actorId?: string | null;
  actorDisplayName?: string | null;
  issuedAt?: string | null;
}

export interface AssessmentImportValidationFinding {
  category: "accepted" | "accepted-with-warning" | "accepted-pending-adapter-evidence" | "blocked";
  scope: "package" | "manifest" | "item" | "asset" | "standards" | "delivery-policy" | "source";
  code: string;
  message: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export interface AssessmentImportValidationReport {
  summary: {
    readyForDelivery: boolean;
    acceptedCount: number;
    acceptedWithWarningCount: number;
    acceptedPendingAdapterEvidenceCount: number;
    blockedCount: number;
  };
  findings: AssessmentImportValidationFinding[];
}

export interface QflowPublishResponse {
  publishId: string;
  status: "published";
  source: {
    qflowTenantId: string;
    qflowAssessmentId: string;
    packageUrl: string;
    exportFormat: "qti3";
    exportWarnings: unknown[];
  };
  version: {
    assessmentId: string;
    assessmentVersionId: string;
    packageObjectKey: string;
    manifestObjectKey: string;
    sourcePackageSha256: string;
  };
  links: {
    previewUrl: string;
    adminUrl: string;
  };
  fetchedPackage: {
    sizeBytes: number;
    sha256: string;
    contentType: string | null;
  };
  validation?: AssessmentImportValidationReport;
}

export interface QflowActivateVersionIntent {
  handoffId: string;
  kind: "activate-version";
  assessmentId: string;
  assessmentVersionId: string;
  actorId: string;
  actorDisplayName?: string | null;
  reason: string;
  activatedAt: string;
}

export interface QflowAssignmentIntent {
  handoffId: string;
  kind: "upsert-assignment";
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  status?: AssignmentStatus;
  policySnapshot: AssignmentPolicySnapshot;
  targets?: AssignmentTarget[];
  ltiLinkages?: LtiAssignmentLinkage[];
  actorId: string;
  actorDisplayName?: string | null;
  issuedAt: string;
  accessCode?: string | null;
}

export type QflowHandoffRequest = QflowActivateVersionIntent | QflowAssignmentIntent;

export interface QflowHandoffRecord {
  id: string;
  kind: QflowHandoffKind;
  assessmentId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  requestSha256: string;
  createdAt: string;
}
