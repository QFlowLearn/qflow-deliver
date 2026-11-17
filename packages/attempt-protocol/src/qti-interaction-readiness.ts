import type { QtiInteractionRegistryStatus } from "@longsightgroup/qti3-core";

/** Harbor evidence attached to one parsed qti3 interaction. */
export type HarborQtiInteractionEvidence = "validated" | "not-validated";

/** One canonical interaction capability used across import and rendering boundaries. */
export interface HarborQtiInteractionCapability {
  readonly type: string;
  readonly qtiName: string;
  readonly qti3RegistryStatus: QtiInteractionRegistryStatus;
  readonly harborEvidence: HarborQtiInteractionEvidence;
}

/** QTI element names with Harbor runtime evidence beyond upstream player registration. */
export const HARBOR_VALIDATED_QTI_INTERACTION_NAMES = [
  "qti-choice-interaction",
  "qti-inline-choice-interaction",
  "qti-text-entry-interaction",
  "qti-extended-text-interaction",
  "qti-order-interaction",
  "qti-match-interaction",
  "qti-gap-match-interaction",
  "qti-media-interaction",
] as const;

const harborValidatedInteractionNames = new Set<string>(HARBOR_VALIDATED_QTI_INTERACTION_NAMES);

/** Project qti3 registry status and Harbor evidence into one interaction capability. */
export function projectHarborQtiInteractionCapability(input: {
  readonly qtiName: string;
  readonly qti3RegistryStatus: QtiInteractionRegistryStatus;
}): HarborQtiInteractionCapability {
  return {
    type: input.qtiName.startsWith("qti-") ? input.qtiName.slice("qti-".length) : input.qtiName,
    qtiName: input.qtiName,
    qti3RegistryStatus: input.qti3RegistryStatus,
    harborEvidence: harborValidatedInteractionNames.has(input.qtiName)
      ? "validated"
      : "not-validated",
  };
}
