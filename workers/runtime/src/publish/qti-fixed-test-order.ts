import path from "node:path";
import {
  parseQtiFixedTestOrdering,
  parseQtiPackageXmlTree,
  type QtiAssessmentTestPackageModel,
  type QtiPackageXmlNode,
} from "@longsightgroup/qti3-core";
import type { PreparedQtiItem } from "./qti-package-preparation";
import { testDeliveryOwner } from "./qti-test-delivery-profile";
import { PublishInputError } from "./publish-errors";

/** Original immutable ordering authority and validated package item bindings. */
export interface PreparedFixedTestOrder {
  readonly xml: string;
  readonly testHref: string;
  readonly itemIdsByRef: Readonly<Record<string, string>>;
}

/** Bind an explicit flat-section policy; do not invent ordering for ordinary static packages. */
export function prepareFixedTestOrder(
  source: QtiAssessmentTestPackageModel | undefined,
  items: readonly PreparedQtiItem[],
): PreparedFixedTestOrder | undefined {
  if (!source || testDeliveryOwner(source.xml) !== "harbor") return undefined;
  const root = parseQtiPackageXmlTree(source.xml).root;
  if (!root) throw new PublishInputError(422, "Ordered assessment XML is unavailable.");
  if (!hasOrderingPolicy(root)) return undefined;
  const parsed = parseQtiFixedTestOrdering(source.xml);
  if (!parsed.ok)
    throw new PublishInputError(422, "This package uses unsupported fixed question ordering.");
  const byHref = new Map(items.map((item) => [item.href, item.id]));
  const bindings: [string, string][] = [];
  const used = new Set<string>();
  for (const section of parsed.value.sections) {
    for (const ref of section.items) {
      const id = byHref.get(path.posix.join(path.posix.dirname(source.href), ref.href));
      if (!id || used.has(id))
        throw new PublishInputError(
          422,
          "Ordered test references an unavailable or repeated item.",
        );
      used.add(id);
      bindings.push([ref.identifier, id]);
    }
  }
  if (used.size !== items.length)
    throw new PublishInputError(
      422,
      "Fixed ordering must bind the complete published item inventory.",
    );
  return { xml: source.xml, testHref: source.href, itemIdsByRef: Object.fromEntries(bindings) };
}

function hasOrderingPolicy(node: QtiPackageXmlNode): boolean {
  return (
    node.localName === "qti-ordering" ||
    (node.localName === "qti-assessment-item-ref" && Object.hasOwn(node.attributes, "fixed")) ||
    node.children.some(hasOrderingPolicy)
  );
}
