import {
  parseQtiTestRubrics,
  type QtiAssessmentSectionPackageModel,
  type QtiAssessmentTestItemRef,
  type QtiAssessmentTestPackageModel,
} from "@longsightgroup/qti3-core";
import { createCandidateTestRubricDelivery } from "@longsightgroup/qti3-player";
import {
  resolvePackageAssetReference,
  type AssessmentInstructionBlock,
  type AssessmentInstructionAnchor,
} from "@harbor/content-model";
import { PublishInputError } from "./publish-errors";
import { prepareStandaloneInstructionAnchors } from "./standalone-instruction-anchors";

/** Candidate content and package-relative asset references prepared before publication. */
export interface PreparedAssessmentInstructions {
  readonly blocks: readonly AssessmentInstructionBlock[];
  readonly assetHrefs: readonly string[];
}

/** Preserve authored owners, bind their complete item hierarchy and remove private audiences. */
export function prepareAssessmentInstructions(
  source: QtiAssessmentTestPackageModel | undefined,
  items: readonly { readonly id: string; readonly href: string }[],
): PreparedAssessmentInstructions {
  if (!source) return { blocks: [], assetHrefs: [] };
  const assetBaseHref = source.href;
  const parsed = parseQtiTestRubrics(source.xml);
  if (!parsed.ok)
    throw new PublishInputError(422, "This package uses unsupported assessment instructions.");
  const itemIdByHref = new Map(items.map((item) => [item.href, item.id]));
  const owners = new Map<
    string,
    { readonly title: string | null; readonly itemIds: readonly string[] }
  >();
  addOwner("assessment-test", source.identifier, source.title ?? null, source.itemRefs);
  for (const part of source.testParts) {
    addOwner(
      "test-part",
      part.identifier,
      part.attributes.title ?? null,
      sectionRefs(part.sections),
    );
    visitSections(part.sections);
  }
  const assets = new Set<string>();
  const projected = createCandidateTestRubricDelivery(parsed.value, (reference) => {
    const resolved = resolvePackageAssetReference(assetBaseHref, reference);
    if (!resolved.ok)
      throw new PublishInputError(
        422,
        "Assessment instructions contain an invalid package asset reference.",
      );
    assets.add(resolved.href);
    return reference;
  });
  const standaloneScopes = new Set(
    projected
      .filter(
        (block) =>
          block.scopeType === "assessment-section" &&
          owners.get(`assessment-section:${block.scopeIdentifier}`)?.itemIds.length === 0,
      )
      .map((block) => block.scopeIdentifier),
  );
  const anchors = standaloneScopes.size
    ? prepareStandaloneInstructionAnchors(
        source,
        standaloneScopes,
        new Map(
          [...owners]
            .filter(([key]) => key.startsWith("assessment-section:"))
            .map(([key, owner]) => [key.slice("assessment-section:".length), owner.itemIds]),
        ),
      )
    : new Map<string, AssessmentInstructionAnchor>();
  const blocks = projected.map((block): AssessmentInstructionBlock => {
    const owner = owners.get(`${block.scopeType}:${block.scopeIdentifier}`);
    if (!owner)
      throw new PublishInputError(
        422,
        "Assessment instructions have no deliverable authored scope.",
      );
    const common = {
      ...block,
      title: owner.title,
      assetBaseHref,
    };
    if (owner.itemIds.length) return { ...common, itemIds: owner.itemIds };
    const anchor = anchors.get(block.scopeIdentifier);
    if (block.scopeType !== "assessment-section" || !anchor) {
      throw new PublishInputError(
        422,
        "Assessment instructions have no deliverable authored scope.",
      );
    }
    return { ...common, scopeType: "assessment-section", anchor };
  });
  return { blocks, assetHrefs: [...assets] };

  function addOwner(
    type: AssessmentInstructionBlock["scopeType"],
    identifier: string,
    title: string | null,
    refs: readonly QtiAssessmentTestItemRef[],
  ): void {
    const key = `${type}:${identifier}`;
    if (owners.has(key))
      throw new PublishInputError(422, "Assessment instruction scope identifiers must be unique.");
    const ids = refs.map((ref) => {
      // qti3 has already resolved item references against the test resource path.
      const id = itemIdByHref.get(ref.href);
      if (!id)
        throw new PublishInputError(
          422,
          "Assessment instruction scope references an unavailable item.",
        );
      return id;
    });
    owners.set(key, { title, itemIds: [...new Set(ids)] });
  }

  function visitSections(sections: readonly QtiAssessmentSectionPackageModel[]): void {
    for (const section of sections) {
      addOwner("assessment-section", section.identifier, section.title ?? null, [
        ...section.itemRefs,
        ...sectionRefs(section.sections),
      ]);
      visitSections(section.sections);
    }
  }
}

function sectionRefs(
  sections: readonly QtiAssessmentSectionPackageModel[],
): readonly QtiAssessmentTestItemRef[] {
  return sections.flatMap((section) => [...section.itemRefs, ...sectionRefs(section.sections)]);
}
