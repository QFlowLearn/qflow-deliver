import type { AttemptItemQtiSnapshot, AttemptVariableSnapshot } from "@harbor/attempt-protocol";
import {
  processQtiAdaptiveItemTurn,
  type QtiAttemptStateV1,
  type QtiValue,
} from "@longsightgroup/qti3-core";
import { formatQtiDiagnostics } from "./qti-diagnostics";
import { SERVER_ITEM_RESPONSE_VARIABLES } from "./server-item-response-variables";

type ResponseApplicationMode = "apply" | "render";

export interface AdaptiveItemTurnMaterialization {
  state: QtiAttemptStateV1;
  responseVariables: AttemptVariableSnapshot[];
  outcomeVariables: AttemptVariableSnapshot[];
  completionStatus: QtiValue;
  candidateSafeXml: string;
}

export async function advanceAdaptiveItemTurn(input: {
  bucket: R2Bucket;
  itemId: string;
  objectKey: string;
  existing: AttemptItemQtiSnapshot | undefined;
}): Promise<AdaptiveItemTurnMaterialization> {
  return runAdaptiveItemTurn({
    ...input,
    responseApplication: "apply",
  });
}

export async function renderAdaptiveItemView(input: {
  bucket: R2Bucket;
  itemId: string;
  objectKey: string;
  existing: AttemptItemQtiSnapshot | undefined;
}): Promise<AdaptiveItemTurnMaterialization> {
  return runAdaptiveItemTurn({
    ...input,
    responseApplication: "render",
  });
}

async function runAdaptiveItemTurn(input: {
  bucket: R2Bucket;
  itemId: string;
  objectKey: string;
  existing: AttemptItemQtiSnapshot | undefined;
  responseApplication: ResponseApplicationMode;
}): Promise<AdaptiveItemTurnMaterialization> {
  const itemObject = await input.bucket.get(input.objectKey);
  if (!itemObject) {
    throw new Error(`Adaptive item authoritative QTI payload is missing for item ${input.itemId}.`);
  }

  return runAdaptiveItemTurnXml({
    itemId: input.itemId,
    itemXml: await itemObject.text(),
    existing: input.existing,
    responseApplication: input.responseApplication,
  });
}

function runAdaptiveItemTurnXml(input: {
  itemId: string;
  itemXml: string;
  existing: AttemptItemQtiSnapshot | undefined;
  responseApplication: ResponseApplicationMode;
}): AdaptiveItemTurnMaterialization {
  const trustedResponses = trustedResponseInputs(input.existing, input.responseApplication);
  const result = processQtiAdaptiveItemTurn({
    itemXml: input.itemXml,
    priorState: input.existing?.stateJson,
    trustedResponses,
    allowedUndeclaredResponseIdentifiers: [...SERVER_ITEM_RESPONSE_VARIABLES],
  });

  if (!result.ok || !result.state || !result.candidateSafeXml) {
    throw new Error(
      `Authoritative adaptive QTI turn could not be materialized for item ${input.itemId}: ${formatQtiDiagnostics(
        result.diagnostics,
      )}`,
    );
  }

  const state = stripServerResponseVariables(result.state);

  return {
    state,
    responseVariables: Object.entries(state.responses).map(([identifier, value]) => ({
      identifier,
      value,
    })),
    outcomeVariables: Object.entries(result.outcomes).map(([identifier, value]) => ({
      identifier,
      value,
    })),
    completionStatus: result.completionStatus,
    candidateSafeXml: result.candidateSafeXml,
  };
}

function stripServerResponseVariables(state: QtiAttemptStateV1): QtiAttemptStateV1 {
  return {
    ...state,
    responses: Object.fromEntries(
      Object.entries(state.responses).filter(
        ([identifier]) => !SERVER_ITEM_RESPONSE_VARIABLES.has(identifier),
      ),
    ),
  };
}

function trustedResponseInputs(
  existing: AttemptItemQtiSnapshot | undefined,
  mode: ResponseApplicationMode,
): AttemptVariableSnapshot[] | undefined {
  const responseVariables = existing?.responseVariables ?? [];
  if (!shouldApplyResponses(mode, responseVariables)) {
    return undefined;
  }

  return responseVariables
    .map((variable) => ({
      identifier: variable.identifier.trim(),
      value: variable.value,
    }))
    .filter((variable) => variable.identifier.length > 0);
}

function shouldApplyResponses(
  mode: ResponseApplicationMode,
  responseVariables: readonly AttemptVariableSnapshot[],
): boolean {
  if (mode === "render") return false;
  return hasSubmittedResponse(responseVariables);
}

function hasSubmittedResponse(responseVariables: readonly AttemptVariableSnapshot[]): boolean {
  return responseVariables.some((variable) => {
    const identifier = variable.identifier.trim();
    return identifier.length > 0 && !SERVER_ITEM_RESPONSE_VARIABLES.has(identifier);
  });
}
