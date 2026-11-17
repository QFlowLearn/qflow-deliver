import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  readOptionalString,
  readRequiredNumber,
  readRequiredString,
} from "../routes/route-request-utils";

import type { LtiDeepLinkPlacementRequest } from "./types";

export function readDeepLinkPlacements(value: unknown): LtiDeepLinkPlacementRequest[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new LaunchRequestError(400, "placements must be an array");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new LaunchRequestError(400, `placements[${index}] must be a JSON object`);
    }
    const placement = item as Record<string, unknown>;
    return {
      assignmentId: readRequiredString(
        placement.assignmentId,
        `placements[${index}].assignmentId is required`,
      ),
      sectionId: readOptionalString(placement.sectionId),
      title: readOptionalString(placement.title),
      text: readOptionalString(placement.text),
      lineItem: readOptionalDeepLinkLineItem(placement.lineItem, index),
    };
  });
}

function readOptionalDeepLinkLineItem(
  value: unknown,
  index: number,
): LtiDeepLinkPlacementRequest["lineItem"] {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, `placements[${index}].lineItem must be a JSON object`);
  }

  const lineItem = value as Record<string, unknown>;
  return {
    label: readOptionalString(lineItem.label),
    scoreMaximum: readRequiredNumber(
      lineItem.scoreMaximum,
      `placements[${index}].lineItem.scoreMaximum is required`,
    ),
    tag: readOptionalString(lineItem.tag),
  };
}
