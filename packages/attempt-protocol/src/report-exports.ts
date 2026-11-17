import type { AssignmentActorSnapshot } from "./assignments";

export const REPORT_EXPORT_SCOPE_KINDS = [
  "assessment-administration",
  "learner",
  "section",
  "district",
] as const;

export type ReportExportScopeKind = (typeof REPORT_EXPORT_SCOPE_KINDS)[number];

export const REPORT_EXPORT_ARTIFACT_TYPES = [
  "roster-csv",
  "item-analysis-csv",
  "standards-mastery-csv",
  "learner-report-json",
  "learner-items-csv",
  "learner-attempts-csv",
  "learner-evidence-csv",
  "assignment-attempts-csv",
  "assignment-item-results-csv",
  "assignment-evidence-csv",
  "score-history-csv",
  "score-amendments-csv",
  "result-export-bundle",
  "data-dictionary-csv",
] as const;

export type ReportExportArtifactType = (typeof REPORT_EXPORT_ARTIFACT_TYPES)[number];

export type ReportDataDictionaryFieldType = "string" | "number" | "boolean" | "datetime" | "json";

export type ReportDataSensitivity = "none" | "pii" | "sensitive";

export interface ReportExportCatalogEntry {
  artifactType: ReportExportArtifactType;
  scopeKind: ReportExportScopeKind;
  label: string;
  description: string;
  filename: string;
  contentType: string;
  directDownload: boolean;
  bundled: boolean;
}

export interface ReportDataDictionaryRow {
  artifactName: string;
  columnName: string;
  displayLabel: string;
  fieldType: ReportDataDictionaryFieldType;
  nullable: boolean;
  definition: string;
  source: string;
  sensitivity: ReportDataSensitivity;
  example: string;
  introducedIn: string;
}

export interface ReportExportCatalogResponse {
  generatedAt: string;
  dataDictionaryVersion: string;
  entries: ReportExportCatalogEntry[];
  dataDictionary: ReportDataDictionaryRow[];
}

export interface ReportBundleManifestArtifact {
  name: string;
  contentType: string;
  rowCount: number | null;
  sizeBytes: number;
  sha256: string;
}

export interface ReportBundleManifest {
  exportId: string;
  exportType: "result-export-bundle" | "learner-report-bundle";
  scopeKind: "assessment-administration" | "learner";
  generatedAt: string;
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  learnerId?: string;
  requester?: AssignmentActorSnapshot | null;
  filters: Record<string, string | number | boolean | null>;
  artifacts: ReportBundleManifestArtifact[];
  dataDictionaryVersion: string;
  sourceLedgers: string[];
}
