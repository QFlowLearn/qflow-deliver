import { readQtiResponseSnapshots } from "@harbor/attempt-protocol";

import { readValidationMessageCount } from "../attempt-scoring";

export function currentItemRequiresUnansweredResponse(xml: string, state: unknown): boolean {
  const requiredResponseIdentifiers = readRequiredResponseIdentifiers(xml);
  if (requiredResponseIdentifiers.length === 0) {
    return false;
  }

  const responses = new Map(
    readQtiResponseSnapshots(state).map((snapshot) => [snapshot.identifier, snapshot.value]),
  );

  return requiredResponseIdentifiers.some(
    (identifier) => !hasQtiResponseValue(responses.get(identifier)),
  );
}

function readRequiredResponseIdentifiers(xml: string): string[] {
  if (!xml.trim()) {
    return [];
  }

  try {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.querySelector("parsererror")) {
      return [];
    }

    const identifiers = new Set<string>();
    for (const element of document.getElementsByTagName("*")) {
      const responseIdentifier = element.getAttribute("response-identifier")?.trim();
      if (!responseIdentifier || !isRequiredQtiInteraction(element)) {
        continue;
      }

      identifiers.add(responseIdentifier);
    }

    return [...identifiers];
  } catch {
    return [];
  }
}

function isRequiredQtiInteraction(element: Element): boolean {
  if (element.getAttribute("required") === "true") {
    return true;
  }

  const minChoices = Number(element.getAttribute("min-choices") ?? "0");
  return Number.isFinite(minChoices) && minChoices > 0;
}

function hasQtiResponseValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasQtiResponseValue(entry));
  }

  if (typeof value === "object") {
    return Object.values(value).some((entry) => hasQtiResponseValue(entry));
  }

  return false;
}

export function isItemReadyForNavigation(xml: string, lifecycleState: unknown): boolean {
  return (
    xml.length > 0 &&
    !currentItemRequiresUnansweredResponse(xml, lifecycleState) &&
    readValidationMessageCount(lifecycleState) === 0
  );
}

export function shouldBlockNavigationForValidation(input: {
  captureTarget: string;
  itemState: unknown;
  allowSkipping: boolean;
}): boolean {
  if (readValidationMessageCount(input.itemState) === 0) {
    return false;
  }

  if (input.captureTarget === "harborNavigateSelected") {
    return true;
  }

  return !input.allowSkipping;
}

export function shouldBlockSubmitForValidation(input: {
  itemState: unknown;
  allowSkipping: boolean;
}): boolean {
  if (readValidationMessageCount(input.itemState) === 0) {
    return false;
  }

  return !input.allowSkipping;
}
