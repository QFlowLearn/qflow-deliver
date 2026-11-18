import { reportUiError } from "@/lib/ui-errors";
import type { Signal } from "@preact/signals";
import type { HarborRuntimeController } from "@/lib/harbor-runtime";
import type {
  QtiRendererHost,
  RendererCatalogSupportResolution,
  RendererTextToSpeechTraversal,
} from "@harbor/renderer-adapter";
import {
  HARBOR_CATALOG_AVAILABILITY_EVIDENCE_SUPPORTS,
  HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
  isHarborAfaPnpSupportOffered,
  resolveHarborKeywordTranslationLanguage,
  type HarborAfaPnpSupport,
  type HarborAfaPnpSupportActivation,
} from "@harbor/attempt-protocol";
import { computed, ref, watch } from "@/lib/preact-reactivity";
import { buildTextToSpeechSegments } from "./session-page-helpers";
import { resolveSessionCatalogEntries } from "./session-catalog-entries";
import { useSessionGlossary } from "./useSessionGlossary";
import { useSessionKeywordTranslation } from "./useSessionKeywordTranslation";
import type { AccommodationSupportEvidenceInput } from "./useSessionSupportEvidence";

type CatalogRuntime = Pick<
  HarborRuntimeController,
  | "attemptClient"
  | "bootstrappedSession"
  | "currentItemPayload"
  | "highestCommittedSequence"
  | "nextSequenceNumber"
  | "persistAuthoritativeSessionState"
  | "pnpPolicy"
  | "policyState"
>;

export function useSessionCatalogSupports(input: {
  runtime: CatalogRuntime;
  rendererElement: Signal<QtiRendererHost | null>;
  catalogSupportFilters: Signal<readonly string[]>;
  catalogSupportResolution: { value: RendererCatalogSupportResolution | null };
  textToSpeechTraversal: { value: RendererTextToSpeechTraversal | null };
  catalogLanguages: Signal<readonly string[]>;
  supportActivation: (support: HarborAfaPnpSupport) => HarborAfaPnpSupportActivation;
  recordEvidence: (evidence: AccommodationSupportEvidenceInput) => Promise<void>;
}) {
  const { runtime } = input;

  const glossaryEntitled = computed(() =>
    input.catalogSupportFilters.value.includes(HARBOR_GLOSSARY_ON_SCREEN_SUPPORT),
  );

  const catalogLanguages = input.catalogLanguages;

  const selectedKeywordLanguage = ref<string | null>(resolveEffectiveKeywordLanguage());

  watch(
    [
      () => runtime.pnpPolicy.value.languages,
      () =>
        runtime.bootstrappedSession.value?.payload.session.deliveryPreferences
          ?.keywordTranslationLanguage ?? null,
      () => runtime.policyState.value.accommodations,
    ],
    () => {
      selectedKeywordLanguage.value = resolveEffectiveKeywordLanguage();
    },
  );

  function resolveEffectiveKeywordLanguage(): string | null {
    return resolveHarborKeywordTranslationLanguage({
      rendererPnp: runtime.policyState.value.accommodations.rendererPnp,
      pnpEntitlement: runtime.policyState.value.accommodations.pnpEntitlement,
      selectedLanguage:
        runtime.bootstrappedSession.value?.payload.session.deliveryPreferences
          ?.keywordTranslationLanguage,
    });
  }

  function resolveCatalogEntriesForLanguage(support: HarborAfaPnpSupport, language: string | null) {
    return resolveSessionCatalogEntries({
      resolution: input.catalogSupportResolution.value,
      host: input.rendererElement.value,
      currentItemPayload: runtime.currentItemPayload.value,
      supports: [support],
      languages: language ? [language] : catalogLanguages.value,
      requestedLanguage: language,
      includeDefaultFallback: true,
    });
  }

  function recordSupportAvailabilityEvidence(): void {
    for (const support of HARBOR_CATALOG_AVAILABILITY_EVIDENCE_SUPPORTS) {
      const activation = input.supportActivation(support);
      if (activation === "blocked") {
        input
          .recordEvidence({
            support,
            state: "suppressed",
            activation,
            entries: resolveCatalogEntriesForLanguage(
              support,
              support === "keyword-translation" ? selectedKeywordLanguage.value : null,
            ),
            reason: "pnp-prohibit-set",
            dedupe: true,
          })
          .catch(reportUiError);
        continue;
      }
      if (!isHarborAfaPnpSupportOffered(activation)) {
        continue;
      }

      if (support === "spoken") {
        const segments = buildTextToSpeechSegments(input.textToSpeechTraversal.value);
        input
          .recordEvidence({
            support,
            state: segments.length > 0 ? "offered" : "unavailable",
            activation,
            reason: segments.length > 0 ? "renderer-tts-traversal" : "no-tts-segments",
            dedupe: true,
            segmentCount: segments.length,
            language: input.textToSpeechTraversal.value?.language ?? null,
          })
          .catch(reportUiError);
        continue;
      }

      const entries = resolveCatalogEntriesForLanguage(
        support,
        support === "keyword-translation" ? selectedKeywordLanguage.value : null,
      );
      input
        .recordEvidence({
          support,
          state: entries.length > 0 ? "offered" : "unavailable",
          activation,
          entries,
          reason: entries.length > 0 ? "catalog-support-resolved" : "catalog-support-missing",
          dedupe: true,
        })
        .catch(reportUiError);
    }
  }

  async function selectKeywordLanguage(language: string): Promise<void> {
    const entitledLanguage = runtime.pnpPolicy.value.languages.find(
      (candidate) => candidate.toLowerCase() === language.toLowerCase(),
    );
    const client = runtime.attemptClient.value;
    if (!entitledLanguage || !client) return;

    selectedKeywordLanguage.value = entitledLanguage;
    const pendingCommit = client.queueAndSend({
      type: "keyword-translation.language.selected",
      payload: { requestedLanguage: entitledLanguage },
    });
    runtime.persistAuthoritativeSessionState(client.getState());

    try {
      await pendingCommit;
    } catch {
      // AttemptClient retains retryable events and reconciles terminal policy rejections.
    } finally {
      const clientState = client.getState();
      selectedKeywordLanguage.value = resolveHarborKeywordTranslationLanguage({
        rendererPnp: runtime.policyState.value.accommodations.rendererPnp,
        pnpEntitlement: runtime.policyState.value.accommodations.pnpEntitlement,
        selectedLanguage: clientState.deliveryPreferences.keywordTranslationLanguage,
      });
      runtime.highestCommittedSequence.value = clientState.highestCommittedSequence;
      runtime.nextSequenceNumber.value = clientState.nextSequenceNumber;
      runtime.persistAuthoritativeSessionState(clientState);
    }
  }

  const { glossary, dismissGlossary } = useSessionGlossary({
    glossaryEntitled,
    rendererElement: input.rendererElement,
    currentItemPayload: runtime.currentItemPayload,
    catalogLanguages,
    recordEvidence: input.recordEvidence,
  });

  const { dialog: keywordTranslation, dismissTranslation } = useSessionKeywordTranslation({
    runtime,
    rendererElement: input.rendererElement,
    catalogLanguages,
    selectedLanguage: selectedKeywordLanguage,
    selectLanguage: selectKeywordLanguage,
    recordEvidence: input.recordEvidence,
  });

  return {
    catalogLanguages,
    glossary,
    keywordTranslation,
    dismissGlossary,
    dismissTranslation,
    recordSupportAvailabilityEvidence,
    resetCatalogState: () => {
      input.catalogSupportResolution.value = null;
      input.textToSpeechTraversal.value = null;
    },
  };
}
