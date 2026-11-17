import type { AttemptItemQtiSnapshot, AttemptVariableSnapshot } from "@harbor/attempt-protocol";
import {
  HARBOR_PENDING_MANUAL_SCORING_STATUS,
  HARBOR_SCORING_STATUS_OUTCOME_IDENTIFIER,
  readQtiOutcomeSnapshots,
  readQtiResponseSnapshots,
} from "@harbor/attempt-protocol";
import {
  materializeQtiItemSubmission,
  parseQtiXml,
  type QtiAssessmentItem,
  type QtiAttemptStateV1,
  type QtiItemSubmissionScoringDisposition,
  type QtiValue,
} from "@longsightgroup/qti3-core";
import { formatQtiDiagnostics } from "../qti/qti-diagnostics";
import { SERVER_ITEM_RESPONSE_VARIABLES } from "../qti/server-item-response-variables";
import {
  formatQtiResponseValidationDiagnostics,
  validateParsedQtiResponses,
} from "./harbor-qti-response-validation";

const HARBOR_MANUAL_SCORING_INTERACTION_TYPES = new Set([
  "custom",
  "drawing",
  "extendedText",
  "portableCustom",
  "upload",
]);

export interface HarborQtiItemSubmissionMaterialization {
  readonly stateJson: QtiAttemptStateV1;
  readonly responseVariables: AttemptVariableSnapshot[];
  readonly outcomeVariables: AttemptVariableSnapshot[];
}

/**
 * Materialize submitted QTI responses through qti3-core, then apply Harbor result policy.
 * This is Harbor's unified submit/finalization path for static and adaptive QTI items.
 */
export function materializeHarborQtiItemSubmission(input: {
  itemId: string;
  itemXml: string;
  existing: AttemptItemQtiSnapshot | undefined;
  allowIncompleteResponses: boolean;
}): HarborQtiItemSubmissionMaterialization {
  const parsed = parseQtiXml(input.itemXml);
  if (!parsed.ok || !parsed.document) {
    throw new Error(
      `Authoritative QTI XML could not be parsed for item ${input.itemId}: ${formatQtiDiagnostics(
        parsed.diagnostics,
      )}`,
    );
  }

  const validation = validateParsedQtiResponses({
    itemId: input.itemId,
    item: parsed.document.item,
    itemSnapshot: input.existing,
    allowIncompleteResponses: input.allowIncompleteResponses,
  });
  if (!validation.ok) {
    throw new Error(
      `Submitted QTI responses failed authoritative validation: ${formatQtiResponseValidationDiagnostics(
        validation.diagnostics,
      )}`,
    );
  }

  const materialized = materializeQtiItemSubmission({
    itemXml: input.itemXml,
    existingState: input.existing?.stateJson,
    trustedResponses: input.existing?.responseVariables ?? [],
    allowIncompleteResponses: input.allowIncompleteResponses,
    allowedUndeclaredResponseIdentifiers: [...SERVER_ITEM_RESPONSE_VARIABLES],
  });
  if (!materialized.ok || !materialized.state) {
    throw new Error(
      `Submitted QTI responses failed authoritative materialization for item ${input.itemId}: ${formatQtiDiagnostics(
        materialized.diagnostics,
      )}`,
    );
  }

  const stateJson = materialized.state;
  const outcomeVariables = normalizeOutcomeVariables({
    item: parsed.document.item,
    stateJson,
    outcomeVariables: readQtiOutcomeSnapshots(stateJson),
    score: materialized.score,
    scoringDisposition: materialized.scoringDisposition,
  });
  if (shouldRequireNumericScore(parsed.document.item) && materialized.score === null) {
    throw new Error(
      `Authoritative QTI XML did not produce a numeric SCORE for item ${input.itemId}.`,
    );
  }

  return {
    stateJson,
    responseVariables: preserveHarborServerResponseVariables(
      readQtiResponseSnapshots(stateJson),
      input.existing?.responseVariables ?? [],
    ),
    outcomeVariables,
  };
}

function shouldRequireNumericScore(item: QtiAssessmentItem): boolean {
  return Boolean(item.responseProcessing);
}

function normalizeOutcomeVariables(input: {
  item: QtiAssessmentItem;
  stateJson: QtiAttemptStateV1;
  outcomeVariables: AttemptVariableSnapshot[];
  score: number | null;
  scoringDisposition: QtiItemSubmissionScoringDisposition;
}): AttemptVariableSnapshot[] {
  if (shouldMarkPendingManualScoring(input)) {
    const outcomes = upsertOutcomeAndState(input.outcomeVariables, input.stateJson, "SCORE", null);
    return upsertOutcomeAndState(
      outcomes,
      input.stateJson,
      HARBOR_SCORING_STATUS_OUTCOME_IDENTIFIER,
      HARBOR_PENDING_MANUAL_SCORING_STATUS,
    );
  }

  if (
    input.item.responseProcessing ||
    !input.item.outcomeDeclarations.some((declaration) => declaration.identifier === "SCORE") ||
    input.score !== null ||
    !isUnscoredReferenceItem(input.item)
  ) {
    return input.outcomeVariables;
  }

  return upsertOutcomeAndState(input.outcomeVariables, input.stateJson, "SCORE", 0);
}

function shouldMarkPendingManualScoring(input: {
  item: QtiAssessmentItem;
  scoringDisposition: QtiItemSubmissionScoringDisposition;
}): boolean {
  if (requiresHarborManualScoring(input.item)) {
    return true;
  }

  return (
    input.scoringDisposition === "manual-scoring-required" && !isUnscoredReferenceItem(input.item)
  );
}

function requiresHarborManualScoring(item: QtiAssessmentItem): boolean {
  return (
    !item.responseProcessing &&
    item.interactions.some((interaction) =>
      HARBOR_MANUAL_SCORING_INTERACTION_TYPES.has(interaction.type),
    )
  );
}

function isUnscoredReferenceItem(item: QtiAssessmentItem): boolean {
  if (item.interactions.length === 0) return true;
  return item.interactions.every(
    (interaction) => interaction.type === "endAttempt" || interaction.type === "media",
  );
}

function upsertOutcomeAndState(
  variables: AttemptVariableSnapshot[],
  stateJson: QtiAttemptStateV1,
  identifier: string,
  value: QtiValue,
): AttemptVariableSnapshot[] {
  stateJson.outcomes[identifier] = value;
  if (!variables.some((variable) => variable.identifier === identifier)) {
    return [...variables, { identifier, value }];
  }

  return variables.map((variable) =>
    variable.identifier === identifier ? { ...variable, value } : variable,
  );
}

function preserveHarborServerResponseVariables(
  variables: AttemptVariableSnapshot[],
  existingVariables: readonly AttemptVariableSnapshot[],
): AttemptVariableSnapshot[] {
  const next = [...variables];
  const existingIdentifiers = new Set(next.map((variable) => variable.identifier));

  for (const variable of existingVariables) {
    const identifier = variable.identifier.trim();
    if (!SERVER_ITEM_RESPONSE_VARIABLES.has(identifier) || existingIdentifiers.has(identifier)) {
      continue;
    }

    next.push({
      identifier,
      value: variable.value,
    });
    existingIdentifiers.add(identifier);
  }

  return next;
}
