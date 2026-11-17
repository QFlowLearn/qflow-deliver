import {
  parseQtiFixedTestOrdering,
  type QtiAssessmentTestPackageModel,
} from "@longsightgroup/qti3-core";
import type { AssessmentInstructionAnchor } from "@harbor/content-model";
import { PublishInputError } from "./publish-errors";

/** Bind standalone content to adjacent authored section boundaries, never to an invented item. */
export function prepareStandaloneInstructionAnchors(
  source: QtiAssessmentTestPackageModel,
  neededScopes: ReadonlySet<string>,
  sectionItems: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, AssessmentInstructionAnchor> {
  const parsed = parseQtiFixedTestOrdering(source.xml);
  if (!parsed.ok) {
    throw new PublishInputError(
      422,
      "Standalone content requires supported fixed section ordering.",
    );
  }
  const anchors = new Map<string, AssessmentInstructionAnchor>();
  for (const identifier of neededScopes) {
    const index = parsed.value.sections.findIndex(
      (section) => section.sectionIdentifier === identifier,
    );
    const section = parsed.value.sections[index];
    if (!section || section.items.length) {
      throw new PublishInputError(422, "Standalone content has an invalid authored section scope.");
    }
    const following = parsed.value.sections
      .slice(index + 1)
      .find((entry) => entry.partIdentifier === section.partIdentifier && entry.items.length > 0);
    const preceding = parsed.value.sections
      .slice(0, index)
      .findLast(
        (entry) => entry.partIdentifier === section.partIdentifier && entry.items.length > 0,
      );
    const boundary = following ?? preceding;
    if (!boundary) {
      throw new PublishInputError(
        422,
        "Standalone content needs a question section in the same part.",
      );
    }
    const itemIds = sectionItems.get(boundary.sectionIdentifier);
    if (!itemIds || itemIds.length !== boundary.items.length) {
      throw new PublishInputError(
        422,
        "Standalone content references an unavailable question boundary.",
      );
    }
    anchors.set(identifier, { position: following ? "before" : "after", itemIds });
  }
  return anchors;
}
