import {
  buildScoreAmendmentEvidenceCsv,
  createScoreAmendment,
  deactivateScoreAmendment,
  previewScoreAmendment,
  readScoreAmendmentEvidenceExport,
  readScoreAmendments,
} from "../../../results/score-amendments";
import {
  REPORT_DATA_DICTIONARY_ROWS,
  REPORT_DATA_DICTIONARY_VERSION,
  REPORT_EXPORT_CATALOG,
  buildAssignmentReportingCsv,
  buildDataDictionaryCsv,
  buildLearnerReportCsv,
} from "../../../reports/instructor-report-exports";
import { requestUrl } from "../../hono-utils";
import { readRequiredPathParam } from "../../route-params";
import { buildAssignmentReportBundle, buildLearnerReportBundle } from "../services/report-bundles";
import { readInstructorAssignmentReporting } from "../services/reporting";
import { readInstructorLearnerReport } from "../services/reporting-learner";
import {
  readCreateScoreAmendmentRequest,
  readDeactivateScoreAmendmentRequest,
} from "../services/request-parsers";
import type { InstructorContext } from "../context";
import { withAssignment, withAssignmentLearner } from "../context";
import {
  respondCsvAttachment,
  respondCsvOrJson,
  respondJsonOrCsv,
  respondZipAttachment,
} from "./reporting-responses";

export async function handleInstructorReportExportCatalog(c: InstructorContext): Promise<Response> {
  return c.json(
    {
      generatedAt: new Date().toISOString(),
      dataDictionaryVersion: REPORT_DATA_DICTIONARY_VERSION,
      entries: REPORT_EXPORT_CATALOG,
      dataDictionary: REPORT_DATA_DICTIONARY_ROWS,
    },
    200,
  );
}

export async function handleInstructorReportDataDictionary(
  c: InstructorContext,
): Promise<Response> {
  const url = requestUrl(c);
  if (url.searchParams.get("format") === "csv") {
    return respondCsvAttachment(buildDataDictionaryCsv(), "data_dictionary.csv");
  }

  return c.json(
    {
      generatedAt: new Date().toISOString(),
      dataDictionaryVersion: REPORT_DATA_DICTIONARY_VERSION,
      rows: REPORT_DATA_DICTIONARY_ROWS,
    },
    200,
  );
}

export async function handleInstructorAssignmentReportDataDictionary(
  c: InstructorContext,
): Promise<Response> {
  return withAssignment(c, async (_scope, assignmentId) =>
    respondCsvAttachment(buildDataDictionaryCsv(), `${assignmentId}-data-dictionary.csv`),
  );
}

export async function handleInstructorAssignmentReportBundle(
  c: InstructorContext,
): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) => {
    const bundle = await buildAssignmentReportBundle({
      db: scope.db,
      bucket: c.env.CONTENT_BUCKET,
      attemptCoordinator: scope.attemptCoordinator,
      assignmentId,
    });
    return respondZipAttachment(bundle.bytes, `${assignmentId}-result-export-bundle.zip`);
  });
}

export async function handleInstructorLearnerReportBundle(c: InstructorContext): Promise<Response> {
  return withAssignmentLearner(c, async (scope, assignmentId, learnerId) => {
    const bundle = await buildLearnerReportBundle({
      db: scope.db,
      attemptCoordinator: scope.attemptCoordinator,
      assignmentId,
      learnerId,
    });
    return respondZipAttachment(
      bundle.bytes,
      `${assignmentId}-${learnerId}-learner-report-bundle.zip`,
    );
  });
}

export async function handleInstructorAssignmentReporting(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) => {
    const url = requestUrl(c);
    const report = await readInstructorAssignmentReporting({
      db: scope.db,
      attemptCoordinator: scope.attemptCoordinator,
      assignmentId,
    });
    return respondJsonOrCsv(
      c,
      url,
      report,
      (exportType) => buildAssignmentReportingCsv(report, exportType),
      {
        defaultType: "roster",
        filenameBase: assignmentId,
      },
    );
  });
}

export async function handleInstructorLearnerReport(c: InstructorContext): Promise<Response> {
  return withAssignmentLearner(c, async (scope, assignmentId, learnerId) => {
    const url = requestUrl(c);
    const report = await readInstructorLearnerReport({
      db: scope.db,
      attemptCoordinator: scope.attemptCoordinator,
      assignmentId,
      learnerId,
    });
    return respondJsonOrCsv(
      c,
      url,
      report,
      (exportType) => buildLearnerReportCsv(report, exportType),
      {
        defaultType: "items",
        filenameBase: `${assignmentId}-${learnerId}`,
      },
    );
  });
}

export async function handleInstructorScoreAmendmentExport(
  c: InstructorContext,
): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) => {
    const url = requestUrl(c);
    const evidence = await readScoreAmendmentEvidenceExport({
      db: scope.db,
      assignmentId,
    });
    return respondCsvOrJson(
      c,
      url,
      evidence,
      () => buildScoreAmendmentEvidenceCsv(evidence),
      `${assignmentId}-score-amendments.csv`,
      "text/csv; charset=utf-8",
    );
  });
}

export async function handleInstructorScoreAmendmentPreview(
  c: InstructorContext,
): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await previewScoreAmendment({
        db: scope.db,
        assignmentId,
        request: await readCreateScoreAmendmentRequest(c.req.raw),
      }),
      200,
    ),
  );
}

export async function handleInstructorScoreAmendmentDeactivate(
  c: InstructorContext,
): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) => {
    const amendmentId = readRequiredPathParam(c, "amendmentId");
    return c.json(
      await deactivateScoreAmendment({
        db: scope.db,
        env: scope.env,
        assignmentId,
        amendmentId,
        request: await readDeactivateScoreAmendmentRequest(c.req.raw),
      }),
      200,
    );
  });
}

export async function handleInstructorScoreAmendmentList(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await readScoreAmendments({
        db: scope.db,
        assignmentId,
      }),
      200,
    ),
  );
}

export async function handleInstructorScoreAmendmentCreate(
  c: InstructorContext,
): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await createScoreAmendment({
        db: scope.db,
        env: scope.env,
        assignmentId,
        request: await readCreateScoreAmendmentRequest(c.req.raw),
      }),
      201,
    ),
  );
}
