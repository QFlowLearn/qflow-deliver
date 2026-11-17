import type { TestSequenceDescriptor } from "./index";

/** Parse the immutable manifest's optional execution descriptor at its storage boundary. */
export function parseTestSequenceDescriptor(value: unknown): TestSequenceDescriptor | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("objectKey" in value) ||
    typeof value.objectKey !== "string" ||
    !value.objectKey ||
    !("answerCount" in value) ||
    typeof value.answerCount !== "number" ||
    !Number.isInteger(value.answerCount) ||
    value.answerCount < 15 ||
    value.answerCount > 100 ||
    value.answerCount % 5 !== 0 ||
    !("itemIdsByRef" in value) ||
    !value.itemIdsByRef ||
    typeof value.itemIdsByRef !== "object" ||
    Array.isArray(value.itemIdsByRef)
  ) {
    throw new Error("Published test execution descriptor is invalid.");
  }
  const entries: [string, string][] = [];
  for (const [ref, id] of Object.entries(value.itemIdsByRef)) {
    if (!ref || typeof id !== "string" || !id)
      throw new Error("Published test item binding is invalid.");
    entries.push([ref, id]);
  }
  if (
    entries.length < value.answerCount ||
    entries.length > 285 ||
    new Set(entries.map(([, id]) => id)).size !== entries.length
  ) {
    throw new Error("Published test inventory is invalid.");
  }
  return {
    objectKey: value.objectKey,
    answerCount: value.answerCount,
    itemIdsByRef: Object.fromEntries(entries),
  };
}
