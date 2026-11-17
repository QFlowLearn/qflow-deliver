import type { AssignmentActorSnapshot, AssignmentStatus } from "./assignments";
import type { AttemptResultStatus } from "./results";

export const RESULT_EXPORT_STATUSES = ["pending", "complete", "failed"] as const;

export const RESULT_EXPORT_FORMATS = ["qti3-results-report"] as const;

export const RESULT_REMEDIATION_SCOPES = ["result-finalization", "result-export"] as const;

export const RESULT_REMEDIATION_STATUSES = ["pending", "complete", "failed"] as const;

export type ResultExportStatus = (typeof RESULT_EXPORT_STATUSES)[number];
export type ResultExportFormat = (typeof RESULT_EXPORT_FORMATS)[number];
export type ResultRemediationScope = (typeof RESULT_REMEDIATION_SCOPES)[number];
export type ResultRemediationStatus = (typeof RESULT_REMEDIATION_STATUSES)[number];

export interface ResultExportArtifactLink {
  path: string;
  contentType: string;
  sha256: string | null;
  sizeBytes: number | null;
}

export interface ResultExportStateSnapshot {
  exportId: string;
  format: ResultExportFormat;
  status: ResultExportStatus;
  retryOfExportId: string | null;
  artifact: ResultExportArtifactLink | null;
  exportedAt: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface AuthoritativeResultExportRecord extends ResultExportStateSnapshot {
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  createdAt: string;
}

export interface ResultRemediationRequestRecord {
  requestId: string;
  attemptId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  scope: ResultRemediationScope;
  status: ResultRemediationStatus;
  retryOfRequestId: string | null;
  resultFinalizationId: string | null;
  resultExportId: string | null;
  requestedBy: AssignmentActorSnapshot;
  reason: string;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResultRemediationStateSnapshot {
  pendingCount: number;
  failedCount: number;
  latestRequest: {
    requestId: string;
    scope: ResultRemediationScope;
    status: ResultRemediationStatus;
    retryOfRequestId: string | null;
    requestedAt: string;
    completedAt: string | null;
    errorMessage: string | null;
  } | null;
}

export interface ResultOpsSummarySnapshot {
  finalization: {
    pendingCount: number;
    failedCount: number;
  };
  exports: {
    pendingCount: number;
    failedCount: number;
    completeCount: number;
    retryPendingCount: number;
    retryFailedCount: number;
    retryCompleteCount: number;
    latestUpdatedAt: string | null;
  };
  remediation: {
    pendingCount: number;
    failedCount: number;
    completeCount: number;
    exportPendingCount: number;
    exportFailedCount: number;
    exportCompleteCount: number;
    latestRequest: ResultRemediationStateSnapshot["latestRequest"];
  };
}

export interface ResultOpsRowContextSnapshot {
  tenantId: string;
  assessmentId: string;
  assessmentSlug: string;
  assessmentTitle: string;
  assignmentTitle: string | null;
}

export interface ResultOpsFilterOptionsSnapshot {
  tenants: Array<{
    tenantId: string;
    rowCount: number;
    failedCount: number;
    pendingCount: number;
  }>;
  assignments: Array<{
    assignmentId: string;
    tenantId: string;
    title: string;
    rowCount: number;
    failedCount: number;
    pendingCount: number;
  }>;
}

export interface QflowAssignmentStateResponse {
  assignment: {
    assignmentId: string;
    assessmentId: string;
    assessmentVersionId: string;
    title: string;
    status: AssignmentStatus;
    updatedAt: string;
  };
  latestResult: {
    attemptId: string;
    sourceReceiptId: string;
    status: AttemptResultStatus;
    finalizedAt: string | null;
    totalScore: number | null;
    maxScore: number | null;
    passed: boolean | null;
  } | null;
  export: ResultExportStateSnapshot | null;
  remediation: ResultRemediationStateSnapshot;
}

export interface QflowResultStateResponse {
  attemptId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  result: {
    status: AttemptResultStatus;
    finalizedAt: string | null;
    totalScore: number | null;
    maxScore: number | null;
    passed: boolean | null;
  };
  export: ResultExportStateSnapshot | null;
  remediation: ResultRemediationStateSnapshot;
}
