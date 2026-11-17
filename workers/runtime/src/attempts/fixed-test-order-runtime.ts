import path from "node:path";
import {
  parseQtiFixedTestOrdering,
  prepareQtiFixedTestOrder,
  type QtiFixedTestOrdering,
  type QtiFixedTestOrderInput,
  type QtiFixedTestOrderState,
} from "@longsightgroup/qti3-core";
import {
  parseFixedTestOrderDescriptor,
  type FixedTestOrderDescriptor,
} from "@harbor/content-model";
import type { CurrentItemRef } from "@harbor/attempt-protocol";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";

/** Durable attempt permutation; no entropy is consulted when this state is restored. */
export interface StoredFixedTestOrder {
  readonly descriptor: FixedTestOrderDescriptor;
  readonly order: QtiFixedTestOrderState;
}

/** Per-object immutable definition cache; persisted order remains the attempt authority. */
export class FixedTestOrderRuntime {
  private cached: { readonly objectKey: string; readonly definition: QtiFixedTestOrdering } | null =
    null;
  constructor(private readonly bucket: R2Bucket) {}

  /** Validate bindings and generate once or restore the shared versioned permutation. */
  async prepare(descriptorInput: unknown, refsInput: unknown, input: QtiFixedTestOrderInput) {
    const parsed = parseFixedTestOrderDescriptor(descriptorInput);
    if (!parsed.ok || !parsed.value)
      throw new AttemptDurableObjectRequestError(
        409,
        "Pinned fixed ordering descriptor is invalid",
      );
    const descriptor = parsed.value;
    const refs = parseItemRefs(refsInput);
    let definition =
      this.cached?.objectKey === descriptor.objectKey ? this.cached.definition : null;
    if (!definition) {
      const object = await this.bucket.get(descriptor.objectKey);
      if (!object)
        throw new AttemptDurableObjectRequestError(500, "Published fixed ordering is unavailable");
      const test = parseQtiFixedTestOrdering(await object.text());
      if (!test.ok)
        throw new AttemptDurableObjectRequestError(
          409,
          "Published fixed ordering cannot be executed",
        );
      definition = test.value;
      this.cached = { objectKey: descriptor.objectKey, definition };
    }
    const authored = definition.sections.flatMap((section) =>
      section.items.map((item) => item.identifier),
    );
    const byId = new Map(refs.map((ref) => [ref.itemId, ref]));
    if (
      authored.length !== refs.length ||
      byId.size !== refs.length ||
      Object.keys(descriptor.itemIdsByRef).length !== authored.length ||
      authored.some((ref) => !byId.has(descriptor.itemIdsByRef[ref] ?? ""))
    )
      throw new AttemptDurableObjectRequestError(
        409,
        "Pinned fixed ordering has invalid item bindings",
      );
    for (const section of definition.sections) {
      for (const ref of section.items) {
        const item = byId.get(descriptor.itemIdsByRef[ref.identifier] ?? "");
        if (
          !item ||
          item.itemHref !== path.posix.join(path.posix.dirname(descriptor.testHref), ref.href)
        )
          throw new AttemptDurableObjectRequestError(
            409,
            "Pinned fixed ordering does not match its item paths",
          );
      }
    }
    const prepared = prepareQtiFixedTestOrder(definition, input);
    if (!prepared.ok)
      throw new AttemptDurableObjectRequestError(
        409,
        "Saved or requested fixed ordering is invalid",
      );
    const itemRefs = prepared.value.sections.flatMap((section) =>
      section.itemRefs.map((ref) => {
        const item = byId.get(descriptor.itemIdsByRef[ref] ?? "");
        if (!item) throw new Error("Validated fixed ordering lost an item binding.");
        return { itemId: item.itemId, itemHref: item.itemHref };
      }),
    );
    return { descriptor, order: prepared.value, itemRefs };
  }

  /** Parse the saved container before validating its shared permutation against immutable XML. */
  async restore(value: unknown, refs: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !("descriptor" in value) ||
      !("order" in value)
    )
      throw new AttemptDurableObjectRequestError(409, "Saved fixed ordering is invalid");
    return this.prepare(value.descriptor, refs, { kind: "restore", state: value.order });
  }
}

function parseItemRefs(value: unknown): CurrentItemRef[] {
  if (!Array.isArray(value))
    throw new AttemptDurableObjectRequestError(
      409,
      "Saved fixed ordering item references are invalid",
    );
  const refs: CurrentItemRef[] = [];
  for (const entry of value) {
    const ref: unknown = entry;
    if (
      !ref ||
      typeof ref !== "object" ||
      Array.isArray(ref) ||
      Object.keys(ref).length !== 2 ||
      !("itemId" in ref) ||
      typeof ref.itemId !== "string" ||
      !ref.itemId ||
      !("itemHref" in ref) ||
      typeof ref.itemHref !== "string" ||
      !ref.itemHref
    )
      throw new AttemptDurableObjectRequestError(
        409,
        "Saved fixed ordering item reference is invalid",
      );
    refs.push({ itemId: ref.itemId, itemHref: ref.itemHref });
  }
  return refs;
}
