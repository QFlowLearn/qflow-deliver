import type { QtiAssessmentItemPlayerHandle } from "@longsightgroup/qti3-player-preact";

type QtiInteractionRegion = ReturnType<
  QtiAssessmentItemPlayerHandle["getInteractionRegions"]
>[number];

export interface RendererAnswerMaskChoiceRegion {
  index: number;
  label: string;
  topPercent: number;
  heightPercent: number;
}

const CHOICE_REGION_INTERACTION_TYPES = new Set(["choice", "hotspot", "hottext"]);

export function mapInteractionRegionsToAnswerMaskChoiceRegions(
  canvasRect: DOMRectReadOnly,
  regions: readonly QtiInteractionRegion[],
): RendererAnswerMaskChoiceRegion[] {
  if (canvasRect.height <= 0) {
    return [];
  }

  return regions
    .filter(isHarborChoiceRegion)
    .filter((region) => region.bounds.width > 0 && region.bounds.height > 0)
    .map((region, index) => ({
      index,
      label:
        normalizeText(region.label ?? region.element?.textContent ?? "") || `Choice ${index + 1}`,
      topPercent: clamp(((region.bounds.top - canvasRect.top) / canvasRect.height) * 100, 0, 100),
      heightPercent: clamp((region.bounds.height / canvasRect.height) * 100, 6, 100),
    }));
}

function isHarborChoiceRegion(region: QtiInteractionRegion): boolean {
  if (region.kind === "choice" && CHOICE_REGION_INTERACTION_TYPES.has(region.interactionType)) {
    return true;
  }

  return region.interactionType === "inlineChoice" && region.kind === "control";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
