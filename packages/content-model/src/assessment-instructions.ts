import {
  parseSafeContentProjection,
  type SafeProjectedContentNode,
} from "@longsightgroup/qti3-player";
import { resolvePackageAssetReference } from "./package-asset-reference";

/** Candidate-only immutable content, bound to its authored scope and published items. */
interface AssessmentInstructionContent {
  readonly scopeType: "assessment-test" | "test-part" | "assessment-section";
  readonly scopeIdentifier: string;
  readonly title: string | null;
  readonly assetBaseHref: string;
  readonly content: readonly SafeProjectedContentNode[];
}

/** Scoped instructions own questions; standalone content owns a section boundary instead. */
export interface AssessmentInstructionAnchor {
  readonly position: "before" | "after";
  readonly itemIds: readonly string[];
}

/** Immutable candidate content with either scope membership or a standalone section anchor. */
export type AssessmentInstructionBlock = AssessmentInstructionContent &
  (
    | { readonly itemIds: readonly string[] }
    | {
        readonly scopeType: "assessment-section";
        readonly anchor: AssessmentInstructionAnchor;
      }
  );

/** Real question inventory referenced by either instruction variant. */
export function assessmentInstructionItemIds(block: AssessmentInstructionBlock): readonly string[] {
  return "itemIds" in block ? block.itemIds : block.anchor.itemIds;
}

/** Resolve a section boundary against the existing per-attempt order, without ordering questions. */
export function assessmentInstructionsForItem(
  blocks: readonly AssessmentInstructionBlock[],
  itemId: string | null,
  itemOrder: readonly string[],
): readonly AssessmentInstructionBlock[] {
  if (itemId === null) return [];
  return blocks.filter((block) => {
    if ("itemIds" in block) return block.itemIds.includes(itemId);
    const members = new Set(block.anchor.itemIds);
    const ordered = itemOrder.filter((id) => members.has(id));
    if (ordered.length !== members.size || new Set(ordered).size !== members.size) {
      throw new Error("Assessment instruction boundary is missing from the attempt order.");
    }
    return itemId === ordered[block.anchor.position === "before" ? 0 : ordered.length - 1];
  });
}

/** Result of parsing instruction metadata and sanitizing its serialized content. */
export type AssessmentInstructionsResult =
  | { readonly ok: true; readonly value: readonly AssessmentInstructionBlock[] }
  | { readonly ok: false; readonly code: "assessment.instructions.invalid" };

/** Parse instruction records at storage/HTTP boundaries through the shared content decoder. */
export function parseAssessmentInstructionBlocks(value: unknown): AssessmentInstructionsResult {
  const invalid = { ok: false, code: "assessment.instructions.invalid" } as const;
  if (!Array.isArray(value)) return invalid;
  const blocks: AssessmentInstructionBlock[] = [];
  for (const block of value) {
    if (
      !block ||
      typeof block !== "object" ||
      Array.isArray(block) ||
      !("scopeType" in block) ||
      (block.scopeType !== "assessment-test" &&
        block.scopeType !== "test-part" &&
        block.scopeType !== "assessment-section") ||
      !("scopeIdentifier" in block) ||
      typeof block.scopeIdentifier !== "string" ||
      !block.scopeIdentifier.trim() ||
      !("title" in block) ||
      (block.title !== null && typeof block.title !== "string") ||
      !("assetBaseHref" in block) ||
      typeof block.assetBaseHref !== "string" ||
      !("content" in block)
    )
      return invalid;
    const base = resolvePackageAssetReference("assessment.xml", block.assetBaseHref);
    if (!base.ok || base.fragment || base.href !== block.assetBaseHref) return invalid;
    const content = parseSafeContentProjection(block.content);
    if (!content.ok) return invalid;
    const common = {
      scopeType: block.scopeType,
      scopeIdentifier: block.scopeIdentifier,
      title: block.title,
      assetBaseHref: base.href,
      content: content.value,
    };
    if ("itemIds" in block && !("anchor" in block)) {
      const itemIds = readItemIds(block.itemIds);
      if (!itemIds) return invalid;
      blocks.push({ ...common, itemIds });
    } else if ("anchor" in block && !("itemIds" in block)) {
      const anchor = block.anchor;
      if (
        block.scopeType !== "assessment-section" ||
        !anchor ||
        typeof anchor !== "object" ||
        Array.isArray(anchor) ||
        Object.keys(anchor).length !== 2 ||
        !("position" in anchor) ||
        (anchor.position !== "before" && anchor.position !== "after") ||
        !("itemIds" in anchor)
      )
        return invalid;
      const itemIds = readItemIds(anchor.itemIds);
      if (!itemIds) return invalid;
      blocks.push({
        ...common,
        scopeType: "assessment-section",
        anchor: { position: anchor.position, itemIds },
      });
    } else return invalid;
  }
  return { ok: true, value: blocks };
}

function readItemIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !id.trim() || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
