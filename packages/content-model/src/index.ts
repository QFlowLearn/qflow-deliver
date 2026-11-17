export {
  parseAnswerFeedbackResponse,
  type AnswerFeedbackResponse,
  type AnswerFeedbackResponseResult,
} from "./answer-feedback";
import type { AssessmentInstructionBlock } from "./assessment-instructions";

export {
  parseFixedTestOrderDescriptor,
  type FixedTestOrderDescriptor,
  type FixedTestOrderDescriptorResult,
} from "./fixed-test-order";
import type { FixedTestOrderDescriptor } from "./fixed-test-order";

export const DELIVERY_MANIFEST_SCHEMA_VERSION = "2";

export {
  parseAssessmentInstructionBlocks,
  assessmentInstructionItemIds,
  assessmentInstructionsForItem,
  type AssessmentInstructionBlock,
  type AssessmentInstructionAnchor,
  type AssessmentInstructionsResult,
} from "./assessment-instructions";

// Keep versioned delivery artifacts under one immutable R2 prefix.
export const IMMUTABLE_VERSION_PREFIX_TEMPLATE =
  "tenants/{tenantId}/assessments/{assessmentId}/versions/{versionId}";

export type DeliveryArtifactType = "package" | "manifest" | "item" | "asset";
export type ImportValidationFindingCategory =
  | "accepted"
  | "accepted-with-warning"
  | "accepted-pending-adapter-evidence"
  | "blocked";
export type ImportValidationFindingScope =
  | "package"
  | "manifest"
  | "item"
  | "asset"
  | "standards"
  | "delivery-policy"
  | "source";
export type LaunchMode = "preview" | "access-code" | "institutional-sso" | "lti";
export type NavigationMode = "linear" | "free";
export type QtiNavigationMode = "linear" | "nonlinear";
export type QtiSubmissionMode = "individual" | "simultaneous";
export type QtiTimingScopeType =
  | "assessment-test"
  | "test-part"
  | "assessment-section"
  | "assessment-item-ref"
  | "item-session";
export type SafeExamBrowserPlatform = "windows" | "macos" | "ios" | "unknown";

export interface QtiTimeLimitsSnapshot {
  scopeType: QtiTimingScopeType;
  identifier: string;
  minTimeSeconds: number | null;
  maxTimeSeconds: number | null;
  allowLateSubmission: boolean;
  rawAttributes: Record<string, string | null>;
}

export interface QtiItemSessionControlSnapshot {
  maxAttempts: number | null;
  showFeedback: boolean | null;
  allowReview: boolean | null;
  showSolution: boolean | null;
  allowComment: boolean | null;
  allowSkipping: boolean | null;
  validateResponses: boolean | null;
  rawAttributes: Record<string, string | null>;
}

export interface QtiAssessmentTestTimingSnapshot {
  identifier: string;
  title: string | null;
  timeLimits: QtiTimeLimitsSnapshot | null;
}

export interface QtiTestPartTimingSnapshot {
  identifier: string;
  navigationMode: QtiNavigationMode;
  submissionMode: QtiSubmissionMode;
  timeLimits: QtiTimeLimitsSnapshot | null;
  sectionIds: string[];
}

export interface QtiAssessmentSectionTimingSnapshot {
  identifier: string;
  title: string | null;
  visible: boolean | null;
  testPartId: string;
  timeLimits: QtiTimeLimitsSnapshot | null;
  itemRefIds: string[];
}

export interface QtiAssessmentItemRefTimingSnapshot {
  identifier: string;
  href: string;
  itemId: string | null;
  testPartId: string;
  sectionId: string;
  timeLimits: QtiTimeLimitsSnapshot | null;
  itemSessionControl: QtiItemSessionControlSnapshot | null;
}

export interface QtiTimingMetadataSnapshot {
  assessmentTest: QtiAssessmentTestTimingSnapshot | null;
  testParts: QtiTestPartTimingSnapshot[];
  sections: QtiAssessmentSectionTimingSnapshot[];
  itemRefs: QtiAssessmentItemRefTimingSnapshot[];
}

export interface SafeExamBrowserKeySnapshot {
  keyHash: string;
  platform?: SafeExamBrowserPlatform | null;
  sebVersion?: string | null;
  label?: string | null;
}

export interface GeneratedSafeExamBrowserConfigSnapshot {
  enabled: boolean;
  allowQuit?: boolean | null;
}

/** Required proof combination; a configuration proof never substitutes for required build proof. */
export type SafeExamBrowserVerificationMode =
  | "config-key"
  | "browser-exam-key"
  | "config-key-and-browser-exam-key";

export interface SafeExamBrowserPolicySnapshot {
  verificationMode: SafeExamBrowserVerificationMode;
  configKeyHash?: string | null;
  browserExamKeys?: SafeExamBrowserKeySnapshot[];
  allowUserAgentFallback?: boolean;
  generatedConfig?: GeneratedSafeExamBrowserConfigSnapshot | null;
}

export interface AssessmentRecord {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  createdAt: string;
}

export interface DeliveryPolicySnapshot {
  launchMode: LaunchMode;
  navigationMode: NavigationMode;
  submissionMode?: QtiSubmissionMode;
  maxAttempts: number;
  timeLimitSeconds: number | null;
  gracePeriodSeconds?: number | null;
  standaloneAllowed?: boolean;
  iframeAllowed?: boolean;
  allowedEmbedOrigins?: string[];
  secureBrowserRequired?: boolean;
  secureBrowserProviderHint?: string | null;
  safeExamBrowser?: SafeExamBrowserPolicySnapshot | null;
  qtiTiming?: QtiTimingMetadataSnapshot | null;
}

export interface AssessmentVersionRecord {
  id: string;
  assessmentId: string;
  versionNumber: number;
  sourcePackageSha256: string;
  packageObjectKey: string;
  manifestObjectKey: string;
  deliveryPolicySnapshot: DeliveryPolicySnapshot;
  createdAt: string;
}

export interface DeliveryArtifactRecord {
  id: string;
  assessmentVersionId: string;
  artifactType: DeliveryArtifactType;
  logicalId: string;
  href: string;
  objectKey: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
}

export interface ImportValidationFinding {
  category: ImportValidationFindingCategory;
  scope: ImportValidationFindingScope;
  code: string;
  message: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export interface ImportValidationSummary {
  readyForDelivery: boolean;
  acceptedCount: number;
  acceptedWithWarningCount: number;
  acceptedPendingAdapterEvidenceCount: number;
  blockedCount: number;
}

export interface ImportValidationReport {
  summary: ImportValidationSummary;
  findings: ImportValidationFinding[];
}

export interface AssetDescriptor {
  id: string;
  href: string;
  objectKey: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface ItemDescriptor {
  id: string;
  identifier: string;
  title: string;
  href: string;
  deliveryObjectKey: string;
  objectKey: string;
  assetIds: string[];
  /** Private feedback-only assets, never included in candidate item payloads. */
  feedbackAssetIds?: string[];
  maxScore?: number | null;
  adaptive?: boolean;
  timeDependent?: boolean;
  timeLimits?: QtiTimeLimitsSnapshot | null;
  itemSessionControl?: QtiItemSessionControlSnapshot | null;
}

export interface DeliveryManifest {
  schemaVersion: typeof DELIVERY_MANIFEST_SCHEMA_VERSION;
  tenantId: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  packageObjectKey: string;
  manifestObjectKey: string;
  itemOrder: string[];
  items: Record<string, ItemDescriptor>;
  assets: Record<string, AssetDescriptor>;
  deliveryPolicySnapshot: DeliveryPolicySnapshot;
  qtiTiming?: QtiTimingMetadataSnapshot | null;
  /** Present only when the published test owns answer-dependent sequencing. */
  testSequence?: TestSequenceDescriptor;
  /** Present only for explicit fixed-section question ordering. */
  fixedTestOrder?: FixedTestOrderDescriptor;
  /** Candidate-only content at its authored test, part or section scope. */
  assessmentInstructions?: readonly AssessmentInstructionBlock[];
}

/** Server-only immutable test contract and its package reference bindings. */
export interface TestSequenceDescriptor {
  objectKey: string;
  itemIdsByRef: Record<string, string>;
  answerCount: number;
}
export { parseTestSequenceDescriptor } from "./test-sequence";

export interface VersionPrefixParts {
  tenantId: string;
  assessmentId: string;
  versionId: string;
}

export const DEFAULT_DELIVERY_POLICY_SNAPSHOT: DeliveryPolicySnapshot = {
  launchMode: "preview",
  navigationMode: "linear",
  maxAttempts: 1,
  timeLimitSeconds: null,
  standaloneAllowed: true,
  iframeAllowed: false,
  allowedEmbedOrigins: [],
  secureBrowserRequired: false,
  secureBrowserProviderHint: null,
  safeExamBrowser: null,
};

export function buildImmutableVersionPrefix({
  tenantId,
  assessmentId,
  versionId,
}: VersionPrefixParts): string {
  return `tenants/${tenantId}/assessments/${assessmentId}/versions/${versionId}`;
}

export function buildVersionManifestObjectKey(parts: VersionPrefixParts): string {
  return `${buildImmutableVersionPrefix(parts)}/manifests/delivery.json`;
}

export function buildVersionPackageObjectKey(
  parts: VersionPrefixParts,
  packageName: string,
): string {
  return `${buildImmutableVersionPrefix(parts)}/package/${packageName}`;
}

export {
  packageAssetReferenceFailureMessage,
  resolvePackageAssetReference,
  type PackageAssetReferenceFailure,
  type PackageAssetReferenceResolution,
} from "./package-asset-reference";
