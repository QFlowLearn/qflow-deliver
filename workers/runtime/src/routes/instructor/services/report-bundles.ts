import JSZip from "jszip";
import {
  type InstructorAssignmentReportingResponse,
  type InstructorLearnerReportResponse,
  type ReportBundleManifest,
} from "@harbor/attempt-protocol";
import {
  REPORT_DATA_DICTIONARY_VERSION,
  buildAssignmentAttemptsCsv,
  buildAssignmentEvidenceCsv,
  buildAssignmentItemResultsCsv,
  buildAssignmentReportingCsv,
  buildAssignmentScoreHistoryCsv,
  buildDataDictionaryCsv,
  buildLearnerReportCsv,
} from "../../../reports/instructor-report-exports";
import {
  buildScoreAmendmentEvidenceCsv,
  readScoreAmendmentEvidenceExport,
} from "../../../results/score-amendments";
import { readInstructorAssignmentReporting } from "./reporting";
import { readInstructorLearnerReport } from "./reporting-learner";

const LEARNER_REPORT_CONCURRENCY = 4;
const R2_ARTIFACT_CONCURRENCY = 8;

export async function buildAssignmentReportBundle(input: {
  db: D1Database;
  bucket: R2Bucket;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
}): Promise<{ bytes: Uint8Array }> {
  const report = await readInstructorAssignmentReporting({
    db: input.db,
    attemptCoordinator: input.attemptCoordinator,
    assignmentId: input.assignmentId,
  });
  const learnerReports = await readLearnerReportsForAssignment({
    db: input.db,
    attemptCoordinator: input.attemptCoordinator,
    assignmentId: input.assignmentId,
    report,
  });
  const scoreAmendmentEvidence = await readScoreAmendmentEvidenceExport({
    db: input.db,
    assignmentId: input.assignmentId,
  });
  const zip = new JSZip();
  const artifacts: ReportBundleManifest["artifacts"] = [];

  await addTextArtifact(zip, artifacts, {
    name: "roster.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentReportingCsv(report, "roster"),
  });
  await addTextArtifact(zip, artifacts, {
    name: "item_analysis.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentReportingCsv(report, "items"),
  });
  await addTextArtifact(zip, artifacts, {
    name: "standards_mastery.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentReportingCsv(report, "standards"),
  });
  await addTextArtifact(zip, artifacts, {
    name: "attempts.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentAttemptsCsv(learnerReports),
  });
  await addTextArtifact(zip, artifacts, {
    name: "item_results.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentItemResultsCsv(learnerReports),
  });
  await addTextArtifact(zip, artifacts, {
    name: "evidence.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentEvidenceCsv(learnerReports),
  });
  await addTextArtifact(zip, artifacts, {
    name: "score_history.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentScoreHistoryCsv(learnerReports),
  });
  await addTextArtifact(zip, artifacts, {
    name: "score_amendments.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildScoreAmendmentEvidenceCsv(scoreAmendmentEvidence),
  });
  await addTextArtifact(zip, artifacts, {
    name: "data_dictionary.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildDataDictionaryCsv(),
  });
  await addQtiResultArtifacts({
    db: input.db,
    bucket: input.bucket,
    zip,
    artifacts,
    assignmentId: input.assignmentId,
  });

  const manifest: ReportBundleManifest = {
    exportId: `rexport_${crypto.randomUUID().replaceAll("-", "")}`,
    exportType: "result-export-bundle",
    scopeKind: "assessment-administration",
    generatedAt: new Date().toISOString(),
    assignmentId: input.assignmentId,
    assessmentId: report.assignment.assessmentId,
    assessmentVersionId: report.assignment.assessmentVersionId,
    requester: null,
    filters: {},
    artifacts,
    dataDictionaryVersion: REPORT_DATA_DICTIONARY_VERSION,
    sourceLedgers: [
      "assignments",
      "attempt_entries",
      "result_finalizations",
      "attempt_results",
      "attempt_result_items",
      "assessment_item_metadata",
      "assessment_item_standard_alignments",
      "attempt_evidence_events",
      "attempt_accommodation_snapshots",
      "result_score_revisions",
      "score_amendments",
      "result_exports",
    ],
  };
  await addTextArtifact(zip, artifacts, {
    name: "manifest.json",
    contentType: "application/json;charset=utf-8",
    content: JSON.stringify(manifest, null, 2),
    rowCount: null,
  });

  return {
    bytes: await zip.generateAsync({ type: "uint8array" }),
  };
}

export async function buildLearnerReportBundle(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
  learnerId: string;
}): Promise<{ bytes: Uint8Array }> {
  const report = await readInstructorLearnerReport({
    db: input.db,
    attemptCoordinator: input.attemptCoordinator,
    assignmentId: input.assignmentId,
    learnerId: input.learnerId,
  });
  const zip = new JSZip();
  const artifacts: ReportBundleManifest["artifacts"] = [];

  await addTextArtifact(zip, artifacts, {
    name: "learner_report.json",
    contentType: "application/json;charset=utf-8",
    content: JSON.stringify(report, null, 2),
    rowCount: null,
  });
  await addTextArtifact(zip, artifacts, {
    name: "learner_items.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildLearnerReportCsv(report, "items"),
  });
  await addTextArtifact(zip, artifacts, {
    name: "learner_attempts.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildLearnerReportCsv(report, "attempts"),
  });
  await addTextArtifact(zip, artifacts, {
    name: "learner_evidence.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildLearnerReportCsv(report, "evidence"),
  });
  await addTextArtifact(zip, artifacts, {
    name: "score_history.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildAssignmentScoreHistoryCsv([report]),
  });
  await addTextArtifact(zip, artifacts, {
    name: "data_dictionary.csv",
    contentType: "text/csv;charset=utf-8",
    content: buildDataDictionaryCsv(),
  });

  const manifest: ReportBundleManifest = {
    exportId: `rexport_${crypto.randomUUID().replaceAll("-", "")}`,
    exportType: "learner-report-bundle",
    scopeKind: "learner",
    generatedAt: new Date().toISOString(),
    assignmentId: input.assignmentId,
    assessmentId: report.assignment.assessmentId,
    assessmentVersionId: report.assignment.assessmentVersionId,
    learnerId: input.learnerId,
    requester: null,
    filters: {},
    artifacts,
    dataDictionaryVersion: REPORT_DATA_DICTIONARY_VERSION,
    sourceLedgers: [
      "assignments",
      "attempt_entries",
      "result_finalizations",
      "attempt_results",
      "attempt_result_items",
      "assessment_item_standard_alignments",
      "attempt_evidence_events",
      "attempt_accommodation_snapshots",
      "result_score_revisions",
    ],
  };
  await addTextArtifact(zip, artifacts, {
    name: "manifest.json",
    contentType: "application/json;charset=utf-8",
    content: JSON.stringify(manifest, null, 2),
    rowCount: null,
  });

  return {
    bytes: await zip.generateAsync({ type: "uint8array" }),
  };
}

async function readLearnerReportsForAssignment(input: {
  db: D1Database;
  attemptCoordinator: DurableObjectNamespace;
  assignmentId: string;
  report: InstructorAssignmentReportingResponse;
}): Promise<InstructorLearnerReportResponse[]> {
  return mapWithConcurrency(input.report.rosterSummary, LEARNER_REPORT_CONCURRENCY, (row) =>
    readInstructorLearnerReport({
      db: input.db,
      attemptCoordinator: input.attemptCoordinator,
      assignmentId: input.assignmentId,
      learnerId: row.learner.id,
    }),
  );
}

async function addTextArtifact(
  zip: JSZip,
  artifacts: ReportBundleManifest["artifacts"],
  input: {
    name: string;
    contentType: string;
    content: string;
    rowCount?: number | null;
  },
): Promise<void> {
  const bytes = new TextEncoder().encode(input.content);
  zip.file(input.name, bytes);
  artifacts.push({
    name: input.name,
    contentType: input.contentType,
    rowCount: input.rowCount ?? countCsvDataRows(input.name, input.content),
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });
}

async function addBinaryArtifact(
  zip: JSZip,
  artifacts: ReportBundleManifest["artifacts"],
  input: {
    name: string;
    contentType: string;
    bytes: Uint8Array;
  },
): Promise<void> {
  zip.file(input.name, input.bytes);
  artifacts.push({
    name: input.name,
    contentType: input.contentType,
    rowCount: null,
    sizeBytes: input.bytes.byteLength,
    sha256: await sha256Hex(input.bytes),
  });
}

async function addQtiResultArtifacts(input: {
  db: D1Database;
  bucket: R2Bucket;
  zip: JSZip;
  artifacts: ReportBundleManifest["artifacts"];
  assignmentId: string;
}): Promise<void> {
  const rows = await input.db
    .prepare(
      `SELECT id,
            artifact_path,
            artifact_content_type
       FROM result_exports
      WHERE assignment_id = ?
        AND status = 'complete'
        AND artifact_path IS NOT NULL
      ORDER BY exported_at ASC, id ASC`,
    )
    .bind(input.assignmentId)
    .all<{
      id: string;
      artifact_path: string;
      artifact_content_type: string | null;
    }>();

  const artifacts = await mapWithConcurrency(rows.results, R2_ARTIFACT_CONCURRENCY, async (row) => {
    const object = await input.bucket.get(row.artifact_path);
    if (!object) {
      return null;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    return {
      name: `qti_results/${row.id}.xml`,
      contentType: row.artifact_content_type ?? "application/xml",
      bytes,
    };
  });

  for (const artifact of artifacts) {
    if (!artifact) {
      continue;
    }
    await addBinaryArtifact(input.zip, input.artifacts, artifact);
  }
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: ReadonlyArray<TInput>,
  concurrency: number,
  mapInput: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (inputs.length === 0) {
    return [];
  }

  const results: TOutput[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, inputs.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapInput(inputs[index]);
      }
    }),
  );

  return results;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function countCsvDataRows(name: string, content: string): number | null {
  if (!name.endsWith(".csv")) {
    return null;
  }
  const trimmed = content.trim();
  if (!trimmed) {
    return 0;
  }
  return Math.max(0, trimmed.split(/\r?\n/).length - 1);
}
