import type { Signal } from "@preact/signals";
import type { HarborRuntimeController } from "@/lib/harbor-runtime";
import type { HarborCatalogSupportEntry } from "@harbor/attempt-protocol";
import { isHarborAfaPnpSupportOffered } from "@harbor/attempt-protocol";
import {
  isKeywordTranslationMimeType,
  projectKeywordTranslationCatalogDelivery,
  resolveHarborCatalogSupportDelivery,
  type KeywordTranslationCatalogProjection,
  type QtiRendererHost,
  type RendererCatalogRequestEventDetail,
} from "@harbor/renderer-adapter";
import { computed, ref } from "@/lib/preact-reactivity";
import { useCatalogRequestDialog } from "./useCatalogRequestDialog";
import { loadCatalogReferencedText } from "./useCatalogReferencedContent";
import type {
  KeywordTranslationDialogProps,
  KeywordTranslationMedia,
} from "./KeywordTranslationDialog";
import type { AccommodationSupportEvidenceInput } from "./useSessionSupportEvidence";

type TranslationRemoteContent =
  | { readonly status: "none" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string }
  | { readonly status: "media"; readonly media: KeywordTranslationMedia }
  | { readonly status: "failed"; readonly message: string };

type KeywordTranslationState =
  | { readonly status: "closed" }
  | {
      readonly status: "open";
      readonly delivery: ResolvedKeywordTranslationDelivery;
      readonly remoteContent: TranslationRemoteContent;
    };

/** One immutable keyword-translation resolution used for both rendering and evidence. */
export interface ResolvedKeywordTranslationDelivery {
  readonly projection: KeywordTranslationCatalogProjection;
  readonly evidenceEntries: readonly HarborCatalogSupportEntry[];
}

type KeywordTranslationRuntime = Pick<HarborRuntimeController, "currentItemPayload" | "pnpPolicy">;

/** Coordinates language-aware keyword translation requests and presentation. */
export function useSessionKeywordTranslation(input: {
  runtime: KeywordTranslationRuntime;
  rendererElement: Signal<QtiRendererHost | null>;
  catalogLanguages: Signal<readonly string[]>;
  selectedLanguage: Signal<string | null>;
  selectLanguage: (language: string) => Promise<void>;
  recordEvidence: (evidence: AccommodationSupportEvidenceInput) => Promise<void>;
}) {
  const entitled = computed(() =>
    isHarborAfaPnpSupportOffered(input.runtime.pnpPolicy.value.activations["keyword-translation"]),
  );
  const languages = computed(() => input.runtime.pnpPolicy.value.languages);

  const state = ref<KeywordTranslationState>({ status: "closed" });
  const lifecycle = useCatalogRequestDialog({
    rendererElement: input.rendererElement,
    acceptsRequest: (detail) =>
      entitled.value && detail.delivery.availableSupports.includes("keyword-translation"),
    openRequest: openTranslation,
  });

  function resolveDelivery(
    requestedLanguage: string,
    referenceId: string,
  ): ResolvedKeywordTranslationDelivery | null {
    const host = input.rendererElement.value;
    if (!host) return null;

    return resolveHarborCatalogSupportDelivery({
      host,
      support: "keyword-translation",
      requestedLanguage,
      referenceId,
      itemHref: input.runtime.currentItemPayload.value?.item.href ?? "",
      assets: input.runtime.currentItemPayload.value?.item.assets ?? [],
      project: (delivery, requestedLanguage) =>
        projectKeywordTranslationCatalogDelivery({ delivery, requestedLanguage }),
    });
  }

  async function openTranslation(detail: RendererCatalogRequestEventDetail): Promise<void> {
    await resolveReference(detail.reference.referenceId);
  }

  async function resolveReference(referenceId: string): Promise<void> {
    lifecycle.cancelContentRequest();
    const requestedLanguage = input.selectedLanguage.value ?? languages.value.at(0) ?? "";
    const delivery = requestedLanguage ? resolveDelivery(requestedLanguage, referenceId) : null;

    if (!delivery || !requestedLanguage) {
      await showUnavailable(referenceId, requestedLanguage);
      return;
    }

    const { projection } = delivery;
    const referencedFile = projection.referencedFile;
    const hasInlineContent = projection.matches.some((match) => match.html.length > 0);
    const unsupportedFile = projection.matches
      .flatMap((match) => match.files)
      .find((file) => !isKeywordTranslationMimeType(file.mimeType));

    if (projection.matches.length === 0 || (!hasInlineContent && !referencedFile)) {
      state.value = {
        status: "open",
        delivery,
        remoteContent: {
          status: "failed",
          message: unsupportedFile
            ? "This translation uses an unsupported media type."
            : "No translation is available for this keyword.",
        },
      };
      await recordTranslationEvidence("unavailable", delivery, {
        reason: unsupportedFile ? "unsupported-media-type" : "catalog-support-missing",
      });
      return;
    }

    const remoteContent = referencedFile
      ? referencedFile.mimeType?.startsWith("audio/") ||
        referencedFile.mimeType?.startsWith("video/")
        ? {
            status: "media" as const,
            media: {
              href: referencedFile.href,
              mimeType: referencedFile.mimeType,
            },
          }
        : ({ status: "loading" } as const)
      : ({ status: "none" } as const);
    state.value = { status: "open", delivery, remoteContent };
    await recordTranslationEvidence("opened", delivery, { reason: "candidate-request" });

    if (hasInlineContent || remoteContent.status === "media") {
      await recordTranslationEvidence("activated", delivery, {
        reason: remoteContent.status === "media" ? "translated-media-ready" : "translation-shown",
      });
    }
    if (!referencedFile || remoteContent.status === "media") return;
    await fetchReferencedText(delivery, referencedFile);
  }

  async function fetchReferencedText(
    delivery: ResolvedKeywordTranslationDelivery,
    referencedFile: NonNullable<KeywordTranslationCatalogProjection["referencedFile"]>,
  ): Promise<void> {
    await loadCatalogReferencedText({
      lifecycle,
      href: referencedFile.href,
      mimeType: referencedFile.mimeType,
      onReady: async (text) => {
        state.value = {
          status: "open",
          delivery,
          remoteContent: { status: "ready", text },
        };
        await recordTranslationEvidence("activated", delivery, {
          reason: "translation-shown",
        });
      },
      onFailed: async () => {
        state.value = {
          status: "open",
          delivery,
          remoteContent: {
            status: "failed",
            message: "The referenced translation could not be loaded.",
          },
        };
        await recordTranslationEvidence("unavailable", delivery, {
          reason: "catalog-asset-load-failed",
        });
      },
    });
  }

  async function showUnavailable(referenceId: string, requestedLanguage: string): Promise<void> {
    const projection: KeywordTranslationCatalogProjection = {
      referenceId,
      catalogId: "",
      requestedLanguage,
      resolvedLanguage: null,
      selectionReason: null,
      fallback: false,
      matches: [],
      referencedFile: null,
    };
    const delivery: ResolvedKeywordTranslationDelivery = { projection, evidenceEntries: [] };
    state.value = {
      status: "open",
      delivery,
      remoteContent: { status: "failed", message: "No translation is available for this keyword." },
    };
    await recordTranslationEvidence("unavailable", delivery, {
      reason: "catalog-support-missing",
    });
  }

  async function changeLanguage(language: string): Promise<void> {
    const current = state.value;
    if (current.status !== "open" || language === current.delivery.projection.requestedLanguage)
      return;
    if (current.remoteContent.status === "media") {
      await recordTranslationEvidence("stopped", current.delivery, {
        reason: "translation-language-changed",
      });
    }
    await input.selectLanguage(language);
    await resolveReference(current.delivery.projection.referenceId);
  }

  function dismissTranslation(): void {
    const current = state.value;
    if (current.status === "open") {
      void recordTranslationEvidence("closed", current.delivery, { reason: "candidate-close" });
      if (current.remoteContent.status === "media") {
        void recordTranslationEvidence("stopped", current.delivery, {
          reason: "translation-dialog-closed",
        });
      }
    }
    state.value = { status: "closed" };
    lifecycle.dismiss();
  }

  function recordMediaState(stateName: "played" | "paused" | "stopped" | "finished"): void {
    const current = state.value;
    if (current.status !== "open") return;
    void recordTranslationEvidence(stateName, current.delivery, {
      reason: `translated-media-${stateName}`,
    });
  }

  async function recordTranslationEvidence(
    stateName: AccommodationSupportEvidenceInput["state"],
    delivery: ResolvedKeywordTranslationDelivery,
    details: { reason: string },
  ): Promise<void> {
    const { projection, evidenceEntries } = delivery;
    await input.recordEvidence({
      support: "keyword-translation",
      state: stateName,
      entries: [...evidenceEntries],
      reason: details.reason,
      control: "keyword-translation-dialog",
      dedupe: stateName === "unavailable",
      requestedLanguage: projection.requestedLanguage || null,
      resolvedLanguage: projection.resolvedLanguage,
      selectionReason: projection.selectionReason,
    });
  }

  const dialog: KeywordTranslationDialogProps = {
    matches: computed(() =>
      state.value.status === "open" ? state.value.delivery.projection.matches : [],
    ),
    requestedLanguage: computed(() =>
      state.value.status === "open" ? state.value.delivery.projection.requestedLanguage : "",
    ),
    resolvedLanguage: computed(() =>
      state.value.status === "open" ? (state.value.delivery.projection.resolvedLanguage ?? "") : "",
    ),
    fallbackMessage: computed(() => buildFallbackMessage(state.value)),
    availableLanguages: languages,
    referencedContent: computed(() => {
      const content = state.value.status === "open" ? state.value.remoteContent : undefined;
      return content?.status === "ready" ? content.text : "";
    }),
    media: computed(() => {
      const content = state.value.status === "open" ? state.value.remoteContent : undefined;
      return content?.status === "media" ? content.media : null;
    }),
    loading: computed(
      () => state.value.status === "open" && state.value.remoteContent.status === "loading",
    ),
    error: computed(() => {
      const content = state.value.status === "open" ? state.value.remoteContent : undefined;
      return content?.status === "failed" ? content.message : "";
    }),
    dismiss: dismissTranslation,
    selectLanguage: (language) => void changeLanguage(language),
    recordMediaState,
  };

  return { dialog, dismissTranslation };
}

function buildFallbackMessage(state: KeywordTranslationState): string {
  if (state.status !== "open" || !state.delivery.projection.fallback) return "";
  const resolved = state.delivery.projection.resolvedLanguage ?? "the authored default";
  return `Requested ${state.delivery.projection.requestedLanguage}; showing ${resolved}.`;
}
