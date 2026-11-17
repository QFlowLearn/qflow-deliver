import type { AttemptVariableSnapshot } from "@harbor/attempt-protocol";

export const HARBOR_RESULTS_SOURCE_ID = "https://harbor.local/runtime";
export const QTI_RESULTS_REPORT_CONTENT_TYPE = "application/xml; charset=utf-8";

export interface QtiResultsReportInput {
  attemptId: string;
  actorId: string | null;
  assessmentVersionId: string;
  finalizedAt: string;
  submittedAt: string;
  totalScore: number | null;
  maxScore: number | null;
  passed: boolean | null;
  testResponseVariables: AttemptVariableSnapshot[];
  testOutcomeVariables: AttemptVariableSnapshot[];
  items: Array<{
    itemId: string;
    itemIdentifier: string | null;
    score: number | null;
    maxScore: number | null;
    responseVariables: AttemptVariableSnapshot[];
    outcomeVariables: AttemptVariableSnapshot[];
    sessionStatus?:
      | "initial"
      | "pendingSubmission"
      | "pendingResponseProcessing"
      | "pendingExternalScoring"
      | "final";
  }>;
}

export function buildQtiResultsReport(input: QtiResultsReportInput): string {
  const sourcedId = sanitizeIdentifier(input.actorId ?? input.attemptId);
  const testOutcomeVariables = withDerivedOutcomeVariables(input.testOutcomeVariables, [
    ["SCORE", input.totalScore],
    ["MAXSCORE", input.maxScore],
    ["PASSED", input.passed],
  ]);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<assessmentResult xmlns="http://www.imsglobal.org/xsd/imsqti_result_v3p0">',
    `  <context sourcedId="${escapeXml(sourcedId)}">`,
    `    <sessionIdentifier sourceID="${escapeXml(HARBOR_RESULTS_SOURCE_ID)}" identifier="${escapeXml(input.attemptId)}" />`,
    "  </context>",
    `  <testResult identifier="${escapeXml(input.assessmentVersionId)}" datestamp="${escapeXml(input.finalizedAt)}">`,
    ...renderVariables("responseVariable", input.testResponseVariables, 4),
    ...renderOutcomeVariables(testOutcomeVariables, 4),
    "  </testResult>",
    ...input.items.flatMap((item) => renderItemResult(item, input.submittedAt)),
    "</assessmentResult>",
  ];

  return `${lines.join("\n")}\n`;
}

function renderItemResult(
  item: QtiResultsReportInput["items"][number],
  submittedAt: string,
): string[] {
  const outcomeVariables = withDerivedOutcomeVariables(item.outcomeVariables, [
    ["SCORE", item.score],
    ["MAXSCORE", item.maxScore],
  ]);

  return [
    `  <itemResult identifier="${escapeXml(item.itemIdentifier ?? item.itemId)}" datestamp="${escapeXml(submittedAt)}" sessionStatus="${item.sessionStatus ?? "final"}">`,
    ...renderVariables("responseVariable", item.responseVariables, 4),
    ...renderOutcomeVariables(outcomeVariables, 4),
    "  </itemResult>",
  ];
}

function renderOutcomeVariables(
  variables: AttemptVariableSnapshot[],
  indentSpaces: number,
): string[] {
  return renderVariables("outcomeVariable", variables, indentSpaces);
}

function renderVariables(
  elementName: "outcomeVariable" | "responseVariable",
  variables: AttemptVariableSnapshot[],
  indentSpaces: number,
): string[] {
  const indent = " ".repeat(indentSpaces);
  const lines: string[] = [];

  for (const variable of variables) {
    if (variable.value === null || variable.value === undefined) {
      continue;
    }

    const cardinality = inferCardinality(variable.value);
    const baseType = inferBaseType(variable.identifier, variable.value);
    const values = toValueList(variable.value);

    lines.push(
      `${indent}<${elementName} identifier="${escapeXml(variable.identifier)}" cardinality="${cardinality}" baseType="${baseType}">`,
    );
    for (const value of values) {
      lines.push(`${indent}  <value>${escapeXml(value)}</value>`);
    }
    lines.push(`${indent}</${elementName}>`);
  }

  return lines;
}

function withDerivedOutcomeVariables(
  variables: AttemptVariableSnapshot[],
  derived: Array<[string, unknown]>,
): AttemptVariableSnapshot[] {
  const next = [...variables];
  const seen = new Set(next.map((variable) => variable.identifier));

  for (const [identifier, value] of derived) {
    if (value === null || value === undefined || seen.has(identifier)) {
      continue;
    }

    next.push({
      identifier,
      value,
    });
    seen.add(identifier);
  }

  return next;
}

function inferCardinality(value: unknown): "single" | "multiple" {
  return Array.isArray(value) ? "multiple" : "single";
}

function inferBaseType(identifier: string, value: unknown): string {
  if (isDurationVariableIdentifier(identifier)) {
    return "duration";
  }

  if (identifier === "numAttempts") {
    return "integer";
  }

  if (Array.isArray(value) && value.length > 0) {
    return inferBaseType(identifier, value[0]);
  }

  if (typeof value === "number") {
    return "float";
  }

  if (typeof value === "string" && /^P(?:T(?:\d+(?:\.\d+)?S)?)$/.test(value)) {
    return "duration";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  return "string";
}

function isDurationVariableIdentifier(identifier: string): boolean {
  return identifier === "duration" || identifier.startsWith("duration.");
}

function toValueList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toValueList(entry));
  }

  if (typeof value === "boolean") {
    return [value ? "true" : "false"];
  }

  if (typeof value === "number") {
    return [String(value)];
  }

  if (typeof value === "string") {
    return [value];
  }

  return [JSON.stringify(value)];
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `id_${cleaned}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
