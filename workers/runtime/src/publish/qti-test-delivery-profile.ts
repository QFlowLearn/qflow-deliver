import {
  parseQtiPackageXmlTree,
  parseQtiTestRubrics,
  type QtiPackageXmlNode,
} from "@longsightgroup/qti3-core";
import { PublishInputError } from "./publish-errors";

const QTI_NAMESPACE = "http://www.imsglobal.org/xsd/imsqtiasi_v3p0";
const SEQUENCING_ELEMENTS = new Set([
  "qti-outcome-declaration",
  "qti-outcome-processing",
  "qti-branch-rule",
  "qti-pre-condition",
]);
const STATIC_PROFILE: Readonly<
  Record<
    string,
    {
      readonly children: readonly string[];
      readonly attributes: readonly string[];
    }
  >
> = {
  "qti-assessment-test": {
    children: ["qti-time-limits", "qti-rubric-block", "qti-test-part"],
    attributes: ["identifier", "title", "tool-name", "tool-version"],
  },
  "qti-test-part": {
    children: ["qti-time-limits", "qti-rubric-block", "qti-assessment-section"],
    attributes: ["identifier", "title", "navigation-mode", "submission-mode"],
  },
  "qti-assessment-section": {
    children: [
      "qti-time-limits",
      "qti-rubric-block",
      "qti-assessment-section",
      "qti-assessment-item-ref",
      "qti-ordering",
    ],
    attributes: ["identifier", "title", "visible"],
  },
  "qti-assessment-item-ref": {
    children: ["qti-time-limits", "qti-item-session-control"],
    attributes: ["identifier", "href", "category", "fixed"],
  },
  "qti-ordering": { children: [], attributes: ["shuffle"] },
  "qti-time-limits": {
    children: [],
    attributes: ["min-time", "max-time", "allow-late-submission"],
  },
  "qti-item-session-control": {
    children: [],
    attributes: [
      "max-attempts",
      "show-feedback",
      "allow-review",
      "show-solution",
      "allow-comment",
      "allow-skipping",
      "validate-responses",
    ],
  },
};

/** Select the execution owner before validation; never retry a rejected test in another engine. */
export function testDeliveryOwner(xml: string): "harbor" | "qti3" {
  const parsed = parseQtiPackageXmlTree(xml);
  const root = parsed.root;
  if (parsed.errors.length || !root || root.localName !== "qti-assessment-test") {
    throw new PublishInputError(422, "Expected a well-formed QTI assessment test.");
  }
  if (requiresSequencing(root)) return "qti3";
  if (!parseQtiTestRubrics(xml).ok)
    throw new PublishInputError(422, "This package uses unsupported assessment instructions.");
  validateStaticNode(root);
  if (root.children.filter((child) => child.localName === "qti-test-part").length !== 1) {
    throw new PublishInputError(422, "Harbor delivery requires exactly one test part.");
  }
  return "harbor";
}

function requiresSequencing(node: QtiPackageXmlNode): boolean {
  return SEQUENCING_ELEMENTS.has(node.localName) || node.children.some(requiresSequencing);
}

function validateStaticNode(node: QtiPackageXmlNode): void {
  const profile = STATIC_PROFILE[node.localName];
  if (
    !profile ||
    node.uri !== QTI_NAMESPACE ||
    node.text.trim() ||
    Object.keys(node.attributes).some(
      (name) =>
        name !== "xmlns" &&
        !name.startsWith("xmlns:") &&
        name !== "xsi:schemaLocation" &&
        name !== "xml:lang" &&
        !profile.attributes.includes(name),
    ) ||
    node.children.some((child) => !profile.children.includes(child.localName))
  ) {
    throw new PublishInputError(422, `Unsupported Harbor test content: ${node.localName}.`);
  }
  if (
    node.localName === "qti-assessment-section" &&
    node.attributes.visible !== "true" &&
    node.attributes.visible !== "1"
  ) {
    throw new PublishInputError(422, "Harbor delivery requires visible assessment sections.");
  }
  // Rubric trees are validated by the shared static-content parser, not a second HTML profile.
  for (const child of node.children) {
    if (child.localName !== "qti-rubric-block") validateStaticNode(child);
  }
}
