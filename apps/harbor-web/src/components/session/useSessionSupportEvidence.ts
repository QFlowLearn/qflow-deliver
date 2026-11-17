import type { Signal } from "@preact/signals";
import type {
  HarborAfaPnpSupport,
  HarborAfaPnpSupportActivation,
  HarborCatalogSupportEntry,
} from "@harbor/attempt-protocol";
import {
  buildAccommodationEvidenceIdempotencyKey,
  buildAccommodationSupportEvidencePayload,
  isHarborAfaPnpSupportOffered,
  shouldDedupeAccommodationSupportEvidence,
  type AccommodationSupportEvidenceState,
} from "@harbor/attempt-protocol";
import type { QtiRendererHost, RendererCatalogSupportResolution } from "@harbor/renderer-adapter";
import type { BootstrappedSession } from "@/lib/bootstrap-client";
import type { AttemptClient } from "@/lib/attempt-client";
import type { RuntimeItemPayload, RuntimeManifestSummary } from "@/lib/runtime-session";
import { resolveSessionCatalogEntries } from "./session-catalog-entries";

export type { AccommodationSupportEvidenceState };

export interface AccommodationSupportEvidenceInput {
  support: HarborAfaPnpSupport;
  state: AccommodationSupportEvidenceState;
  activation?: HarborAfaPnpSupportActivation;
  entries?: HarborCatalogSupportEntry[];
  reason?: string;
  control?: string;
  dedupe?: boolean;
  requestedLanguage?: string | null;
  resolvedLanguage?: string | null;
  selectionReason?: string | null;
  segmentCount?: number;
  language?: string | null;
}

export function useSessionSupportEvidence(input: {
  bootstrappedSession: Signal<BootstrappedSession | null>;
  attemptClient: Signal<AttemptClient | null>;
  currentItemPayload: Signal<RuntimeItemPayload | null>;
  runtimeManifest: Signal<RuntimeManifestSummary | null>;
  catalogSupportResolution: Signal<RendererCatalogSupportResolution | null>;
  rendererElement: Signal<QtiRendererHost | null>;
  catalogLanguages: Signal<readonly string[]>;
  supportActivation: (support: HarborAfaPnpSupport) => HarborAfaPnpSupportActivation;
}) {
  function recordMediaAlternativePanelEvidence(
    state: Extract<AccommodationSupportEvidenceState, "opened" | "closed">,
    options: {
      reason: string;
      control?: string;
      dedupe: boolean;
    },
  ): void {
    const supports: Array<{
      support: HarborAfaPnpSupport;
      activation: HarborAfaPnpSupportActivation;
    }> = [
      {
        support: "audio-description" as const,
        activation: input.supportActivation("audio-description"),
      },
      {
        support: "sign-language" as const,
        activation: input.supportActivation("sign-language"),
      },
    ].filter((entry) => isHarborAfaPnpSupportOffered(entry.activation));

    for (const support of supports) {
      void recordAccommodationSupportEvidence({
        support: support.support,
        state,
        activation: support.activation,
        entries: resolveCurrentCatalogEntriesForSupport(support.support),
        reason: options.reason,
        control: options.control,
        dedupe: options.dedupe,
      });
    }
  }

  async function recordAccommodationSupportEvidence(
    evidence: AccommodationSupportEvidenceInput,
  ): Promise<void> {
    const attemptId = input.bootstrappedSession.value?.payload.attemptId;
    const client = input.attemptClient.value;
    const itemRef = readCurrentItemRef();
    if (!attemptId || !client || !itemRef) {
      return;
    }

    const activation = evidence.activation ?? input.supportActivation(evidence.support);
    const entries = evidence.entries ?? resolveCurrentCatalogEntriesForSupport(evidence.support);
    const payload = buildAccommodationSupportEvidencePayload({
      support: evidence.support,
      state: evidence.state,
      activation,
      entries,
      reason: evidence.reason,
      control: evidence.control,
      requestedLanguage: evidence.requestedLanguage,
      resolvedLanguage: evidence.resolvedLanguage,
      selectionReason: evidence.selectionReason,
      segmentCount: evidence.segmentCount,
      language: evidence.language,
    });
    const shouldDedupe = shouldDedupeAccommodationSupportEvidence(evidence.state, evidence.dedupe);
    const idempotencyKey = shouldDedupe
      ? await buildAccommodationEvidenceIdempotencyKey({
          attemptId,
          itemId: itemRef.itemId,
          itemHref: itemRef.itemHref,
          support: evidence.support,
          state: evidence.state,
          requestedLanguage: payload.requestedLanguage,
          resolvedLanguage: payload.resolvedLanguage,
          selectionReason: payload.selectionReason,
        })
      : undefined;

    try {
      await client.queueAndSend({
        type: "accommodation.support",
        itemRef,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        payload,
      });
    } catch {
      // AttemptClient keeps the event in its durable journal for replay.
    }
  }

  function resolveCurrentCatalogEntriesForSupport(
    support: HarborAfaPnpSupport,
  ): HarborCatalogSupportEntry[] {
    return resolveSessionCatalogEntries({
      resolution: input.catalogSupportResolution.value,
      host: input.rendererElement.value,
      languages: input.catalogLanguages.value,
      currentItemPayload: input.currentItemPayload.value,
      supports: [support],
    });
  }

  function readCurrentItemRef(): { itemId: string; itemHref: string } | null {
    if (!input.currentItemPayload.value || !input.runtimeManifest.value) {
      return null;
    }

    const manifestItem = input.runtimeManifest.value.items[input.currentItemPayload.value.item.id];
    if (!manifestItem) {
      return null;
    }

    return {
      itemId: input.currentItemPayload.value.item.id,
      itemHref: manifestItem.itemHref,
    };
  }

  return {
    recordAccommodationSupportEvidence,
    recordMediaAlternativePanelEvidence,
  };
}
