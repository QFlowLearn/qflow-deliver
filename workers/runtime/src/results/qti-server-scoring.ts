import { materializeStagedReporting } from "./staged-assessment-results";
import type {
  AttemptContainerStateSnapshot,
  AttemptItemQtiSnapshot,
  AttemptSubmissionMaterializationInput,
  AttemptVariableSnapshot,
} from "@harbor/attempt-protocol";
import type { DeliveryManifest } from "@harbor/content-model";
import { materializeHarborQtiItemSubmission } from "./harbor-qti-submission-materialization";

export async function scoreSubmissionWithAuthoritativeQti(input: {
  bucket: R2Bucket;
  manifest: DeliveryManifest;
  materialization: AttemptSubmissionMaterializationInput;
  scoredAt: string;
}): Promise<AttemptSubmissionMaterializationInput> {
  return materializeSubmissionWithAuthoritativeQti({
    ...input,
    allowIncompleteResponses: true,
  });
}

export async function materializeSubmissionWithAuthoritativeQti(input: {
  bucket: R2Bucket;
  manifest: DeliveryManifest;
  materialization: AttemptSubmissionMaterializationInput;
  scoredAt: string;
  allowIncompleteResponses: boolean;
}): Promise<AttemptSubmissionMaterializationInput> {
  const itemOrder =
    input.manifest.testSequence || input.manifest.fixedTestOrder
      ? input.materialization.itemOrder
      : input.manifest.itemOrder;
  if (
    (input.manifest.fixedTestOrder && itemOrder.length !== input.manifest.itemOrder.length) ||
    new Set(itemOrder).size !== itemOrder.length ||
    itemOrder.some((id) => !input.manifest.items[id])
  )
    throw new Error("Result route references unavailable or repeated items.");
  const items: Record<string, AttemptItemQtiSnapshot> = {};

  for (const itemId of itemOrder) {
    const manifestItem = input.manifest.items[itemId];
    if (!manifestItem) continue;
    const saved = input.materialization.items[itemId];
    const existing =
      input.manifest.testSequence && !saved?.serverState?.testSubmission ? undefined : saved;
    const xmlObject = await input.bucket.get(manifestItem.objectKey);
    if (!xmlObject) {
      throw new Error(`Authoritative QTI XML is missing for item ${itemId}.`);
    }

    const itemXml = await xmlObject.text();
    const qtiItem = materializeHarborQtiItemSubmission({
      itemId,
      itemXml,
      existing,
      allowIncompleteResponses: input.manifest.testSequence ? true : input.allowIncompleteResponses,
    });

    items[itemId] = {
      itemId,
      itemIdentifier: existing?.itemIdentifier ?? manifestItem.identifier ?? itemId,
      itemTitle: existing?.itemTitle ?? manifestItem.title ?? itemId,
      capturedAt: existing?.capturedAt ?? input.scoredAt,
      responseVariables: qtiItem.responseVariables,
      outcomeVariables: qtiItem.outcomeVariables,
      validationMessages: existing?.validationMessages ?? [],
      stateJson: qtiItem.stateJson,
      ...(existing?.serverState !== undefined ? { serverState: existing.serverState } : {}),
    };
  }

  const trustedTestState = readTrustedContainerState(input.materialization.testState);
  const testState = input.manifest.testSequence
    ? await materializeStagedReporting({
        bucket: input.bucket,
        descriptor: input.manifest.testSequence,
        itemOrder,
        items,
        testState: trustedTestState,
      })
    : trustedTestState;
  return {
    itemOrder,
    testState,
    partStates: readTrustedContainerStateMap(input.materialization.partStates),
    sectionStates: readTrustedContainerStateMap(input.materialization.sectionStates),
    items,
  };
}

function readTrustedContainerState(
  state: AttemptContainerStateSnapshot | null,
): AttemptContainerStateSnapshot | null {
  if (!state) {
    return null;
  }

  const responseVariables = (state.responseVariables ?? []).filter((variable) =>
    isServerOwnedContainerResponseVariable(variable),
  );
  if (responseVariables.length === 0) {
    return null;
  }

  return {
    identifier: state.identifier,
    responseVariables,
    outcomeVariables: [],
  };
}

function readTrustedContainerStateMap(
  states: Record<string, AttemptContainerStateSnapshot>,
): Record<string, AttemptContainerStateSnapshot> {
  return Object.fromEntries(
    Object.entries(states).flatMap(([identifier, state]) => {
      const trustedState = readTrustedContainerState(state);
      return trustedState ? [[identifier, trustedState]] : [];
    }),
  );
}

function isServerOwnedContainerResponseVariable(variable: AttemptVariableSnapshot): boolean {
  return (
    variable.identifier === "duration" ||
    variable.identifier.startsWith("duration.test-part.") ||
    variable.identifier.startsWith("duration.assessment-section.")
  );
}
