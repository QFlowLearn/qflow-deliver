import { HARBOR_VALIDATED_QTI_INTERACTION_NAMES } from "@harbor/attempt-protocol";
import { interactionSupport } from "@longsightgroup/qti3-core";

/** Return Harbor-validated interactions missing full support from the configured renderer. */
export function findHarborRendererInteractionCapabilityGaps(): string[] {
  const fullySupportedNames = new Set(
    interactionSupport
      .filter((entry) => entry.render && entry.process)
      .map((entry) => entry.qtiName),
  );
  return HARBOR_VALIDATED_QTI_INTERACTION_NAMES.filter(
    (qtiName) => !fullySupportedNames.has(qtiName),
  );
}
