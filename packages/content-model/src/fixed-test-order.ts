import { resolvePackageAssetReference } from "./package-asset-reference";

/** Server-only immutable ordering XML and its one-to-one published item bindings. */
export interface FixedTestOrderDescriptor {
  readonly objectKey: string;
  readonly testHref: string;
  readonly itemIdsByRef: Readonly<Record<string, string>>;
}

/** Parsed optional ordering metadata, or an explicit corrupt-publication failure. */
export type FixedTestOrderDescriptorResult =
  | { readonly ok: true; readonly value: FixedTestOrderDescriptor | undefined }
  | { readonly ok: false; readonly reason: string };

/** Parse persisted metadata without trusting JSON casts or accepting duplicate bindings. */
export function parseFixedTestOrderDescriptor(value: unknown): FixedTestOrderDescriptorResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("objectKey" in value) ||
    typeof value.objectKey !== "string" ||
    !value.objectKey ||
    !("testHref" in value) ||
    typeof value.testHref !== "string" ||
    !value.testHref ||
    value.testHref.includes("#") ||
    !resolvePackageAssetReference("imsmanifest.xml", value.testHref).ok ||
    !("itemIdsByRef" in value) ||
    !value.itemIdsByRef ||
    typeof value.itemIdsByRef !== "object" ||
    Array.isArray(value.itemIdsByRef)
  )
    return { ok: false, reason: "Published fixed ordering descriptor is invalid." };
  const entries: [string, string][] = [];
  for (const [ref, id] of Object.entries(value.itemIdsByRef)) {
    if (!ref || typeof id !== "string" || !id)
      return { ok: false, reason: "Published fixed ordering binding is invalid." };
    entries.push([ref, id]);
  }
  if (!entries.length || new Set(entries.map(([, id]) => id)).size !== entries.length)
    return { ok: false, reason: "Published fixed ordering inventory is invalid." };
  return {
    ok: true,
    value: {
      objectKey: value.objectKey,
      testHref: value.testHref,
      itemIdsByRef: Object.fromEntries(entries),
    },
  };
}
