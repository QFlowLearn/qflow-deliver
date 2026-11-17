import type { AttemptEventEnvelope } from "@harbor/attempt-protocol";
import { advanceAdaptiveItemTurn, renderAdaptiveItemView } from "../qti/adaptive-item-turn";
import { enrichSubmissionMaterializationWithBuiltins } from "./attempt-materialization";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";
import type { StoredAttemptState } from "./attempt-state-bootstrap";

export interface AdaptiveItemViewResponse {
  itemId: string;
  candidateSafeXml: string;
  completionStatus: unknown;
  stateJson: unknown;
}

export async function renderCurrentAdaptiveItemView(input: {
  bucket: R2Bucket;
  storedState: StoredAttemptState;
  itemId: string;
}): Promise<AdaptiveItemViewResponse> {
  const manifestItem = readAdaptiveManifestItem(input.storedState, input.itemId);
  const materialized = await renderAdaptiveItemView({
    bucket: input.bucket,
    itemId: input.itemId,
    objectKey: manifestItem.objectKey,
    existing: enrichSubmissionMaterializationWithBuiltins(
      input.storedState,
      input.storedState.submissionMaterialization,
    ).items[input.itemId],
  });

  return {
    itemId: input.itemId,
    candidateSafeXml: materialized.candidateSafeXml,
    completionStatus: materialized.completionStatus,
    stateJson: materialized.state,
  };
}

export async function advanceAcceptedAdaptiveResponseTurn(input: {
  bucket: R2Bucket;
  storedState: StoredAttemptState;
  nextState: StoredAttemptState;
  event: AttemptEventEnvelope;
  serverTimestamp: string;
}): Promise<StoredAttemptState> {
  if (
    input.event.type !== "response.changed" ||
    ("intent" in input.event.payload && input.event.payload.intent === "checkpoint")
  )
    return input.nextState;

  const itemId = input.event.itemRef.itemId;
  const manifestItem = input.storedState.manifestItems[itemId];
  if (!manifestItem?.adaptive) return input.nextState;
  if (!manifestItem.objectKey) {
    throw new AttemptDurableObjectRequestError(
      409,
      "Adaptive item is missing its authoritative QTI payload",
    );
  }

  const submittedItem = input.nextState.submissionMaterialization.items[itemId];
  if (!submittedItem) return input.nextState;

  const priorItem = input.storedState.submissionMaterialization.items[itemId];
  const existing =
    priorItem?.stateJson === undefined
      ? submittedItem
      : {
          ...submittedItem,
          stateJson: priorItem.stateJson,
        };
  const materialized = await advanceAdaptiveItemTurn({
    bucket: input.bucket,
    itemId,
    objectKey: manifestItem.objectKey,
    existing,
  });

  return {
    ...input.nextState,
    submissionMaterialization: {
      ...input.nextState.submissionMaterialization,
      items: {
        ...input.nextState.submissionMaterialization.items,
        [itemId]: {
          itemId,
          itemIdentifier: submittedItem.itemIdentifier ?? manifestItem.itemIdentifier ?? itemId,
          itemTitle: submittedItem.itemTitle ?? manifestItem.itemTitle ?? itemId,
          capturedAt: submittedItem.capturedAt ?? input.serverTimestamp,
          responseVariables: materialized.responseVariables,
          outcomeVariables: materialized.outcomeVariables,
          validationMessages: submittedItem.validationMessages,
          stateJson: materialized.state,
          serverState: {
            adaptiveTurn: {
              lastAppliedResponseEventId: input.event.eventId,
              lastAppliedResponseSequenceNumber: input.event.sequenceNumber,
            },
          },
        },
      },
    },
  };
}

function readAdaptiveManifestItem(
  storedState: StoredAttemptState,
  itemId: string,
): {
  itemIdentifier: string | null;
  itemTitle: string | null;
  objectKey: string;
  adaptive: boolean;
} {
  const manifestItem = storedState.manifestItems[itemId];
  if (!manifestItem) {
    throw new AttemptDurableObjectRequestError(404, "Adaptive item is not part of this attempt");
  }
  if (!manifestItem.adaptive) {
    throw new AttemptDurableObjectRequestError(409, "Item is not configured for adaptive delivery");
  }
  if (!manifestItem.objectKey) {
    throw new AttemptDurableObjectRequestError(
      409,
      "Adaptive item is missing its authoritative QTI payload",
    );
  }
  return manifestItem;
}
