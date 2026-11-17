import { renderAttemptClientTiming } from "./attempt-client-timing";
import type {
  AttemptEventEnvelope,
  CurrentItemRef,
  AttemptDeliveryPreferences,
} from "@harbor/attempt-protocol";
import {
  isHarborAfaPnpSupportOffered,
  resolveHarborKeywordTranslationLanguage,
  resolveHarborKeywordTranslationLanguages,
  resolveHarborPnpPolicy,
} from "@harbor/attempt-protocol";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";
import { resolveAttemptStatus } from "./attempt-status";
import type { StoredAttemptState } from "./attempt-state-bootstrap";

const CURRENT_ITEM_EVIDENCE_EVENT_TYPES = [
  "item.presented",
  "accommodation.support",
  "timing.deadline.warned",
  "timing.deadline.reached",
] as const satisfies readonly AttemptEventEnvelope["type"][];

export function requiresCurrentItemEvidenceGuard(event: AttemptEventEnvelope): boolean {
  return CURRENT_ITEM_EVIDENCE_EVENT_TYPES.includes(
    event.type as (typeof CURRENT_ITEM_EVIDENCE_EVENT_TYPES)[number],
  );
}

export function buildAttemptStateErrorPayload(
  error: string,
  storedState: StoredAttemptState,
  attemptStatus = resolveAttemptStatus(storedState),
  timing = renderAttemptClientTiming(storedState, undefined),
): Record<string, unknown> {
  return {
    error,
    attemptStatus,
    currentItemRef: storedState.currentItemRef,
    timing,
    policy: storedState.policy,
    deliveryPreferences: resolveAttemptDeliveryPreferences(storedState),
    highestCommittedSequence: storedState.highestCommittedSequence,
    expectedNextSequence: storedState.highestCommittedSequence + 1,
  };
}

export function validateKeywordTranslationLanguageSelection(
  storedState: StoredAttemptState,
  event: AttemptEventEnvelope<"keyword-translation.language.selected">,
): void {
  resolveEntitledKeywordTranslationLanguage(storedState, event.payload.requestedLanguage);
}

export function resolveEntitledKeywordTranslationLanguage(
  storedState: StoredAttemptState,
  requestedLanguage: string,
): string {
  const policy = resolveHarborPnpPolicy(storedState.policy.accommodations);
  const languages = resolveHarborKeywordTranslationLanguages(storedState.policy.accommodations);
  const selected = languages.find(
    (language) => language.toLowerCase() === requestedLanguage.toLowerCase(),
  );
  if (!isHarborAfaPnpSupportOffered(policy.activations["keyword-translation"]) || !selected) {
    throw new AttemptDurableObjectRequestError(
      409,
      "Keyword translation language is not currently entitled for this attempt",
      buildAttemptStateErrorPayload(
        "Keyword translation language is not currently entitled for this attempt",
        storedState,
      ),
    );
  }
  return selected;
}

export function resolveAttemptDeliveryPreferences(
  storedState: StoredAttemptState,
): AttemptDeliveryPreferences {
  return {
    keywordTranslationLanguage: resolveHarborKeywordTranslationLanguage({
      rendererPnp: storedState.policy.accommodations.rendererPnp,
      pnpEntitlement: storedState.policy.accommodations.pnpEntitlement,
      selectedLanguage: storedState.deliveryPreferences?.keywordTranslationLanguage,
    }),
  };
}

export function currentItemRefsMatch(left: CurrentItemRef, right: CurrentItemRef): boolean {
  return left.itemId === right.itemId && left.itemHref === right.itemHref;
}
