import type { DeliveryManifest } from "@harbor/content-model";
import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../../attempts/attempt-durable-object";
import { LaunchRequestError } from "../../launch/create-preview-attempt";

/** Read the stable fixed attempt inventory from its authority and parse the runtime-hop DTO. */
export async function readFixedTestOrderView(
  coordinator: DurableObjectNamespace,
  attemptId: string,
  manifest: DeliveryManifest,
) {
  const response = await coordinator
    .get(coordinator.idFromName(attemptId))
    .fetch("https://harbor-attempt.local/fixed-test-order", {
      headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: attemptId },
    });
  const value: unknown = await response.json();
  if (
    !response.ok ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("itemOrder" in value) ||
    !Array.isArray(value.itemOrder) ||
    !("currentItemRef" in value)
  )
    throw new LaunchRequestError(409, "Assessment question order is unavailable");
  const itemOrder: string[] = [];
  for (const raw of value.itemOrder) {
    const id: unknown = raw;
    if (typeof id !== "string" || !manifest.items[id] || itemOrder.includes(id))
      throw new LaunchRequestError(409, "Assessment question inventory is invalid");
    itemOrder.push(id);
  }
  const ref = value.currentItemRef;
  if (
    itemOrder.length !== manifest.itemOrder.length ||
    !ref ||
    typeof ref !== "object" ||
    !("itemId" in ref) ||
    typeof ref.itemId !== "string" ||
    !("itemHref" in ref) ||
    typeof ref.itemHref !== "string" ||
    !itemOrder.includes(ref.itemId) ||
    manifest.items[ref.itemId]?.href !== ref.itemHref
  )
    throw new LaunchRequestError(409, "Current question does not match the attempt order");
  return { itemOrder, currentItemRef: { itemId: ref.itemId, itemHref: ref.itemHref } };
}
