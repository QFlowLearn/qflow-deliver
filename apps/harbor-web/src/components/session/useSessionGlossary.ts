import type { Signal } from "@preact/signals";
import {
  HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
  type HarborCatalogSupportEntry,
} from "@harbor/attempt-protocol";
import {
  projectGlossaryCatalogDelivery,
  resolveHarborCatalogSupportEvidenceEntries,
  type GlossaryCatalogMatch,
  type QtiRendererHost,
  type RendererCatalogRequestEventDetail,
} from "@harbor/renderer-adapter";
import { computed, ref } from "@/lib/preact-reactivity";
import type { RuntimeItemPayload } from "@/lib/runtime-session";
import { useCatalogRequestDialog } from "./useCatalogRequestDialog";
import { loadCatalogReferencedText } from "./useCatalogReferencedContent";
import type {
  GlossaryDialogProps,
  GlossaryDialogState,
  GlossaryRemoteContent,
} from "./GlossaryDialog";
import type { AccommodationSupportEvidenceInput } from "./useSessionSupportEvidence";

type GlossaryState =
  | { readonly status: "closed" }
  | {
      readonly status: "open";
      readonly matches: readonly GlossaryCatalogMatch[];
      readonly referenceId: string;
      readonly remoteContent: GlossaryRemoteContent;
    };

export function useSessionGlossary(input: {
  glossaryEntitled: Signal<boolean>;
  rendererElement: Signal<QtiRendererHost | null>;
  currentItemPayload: Signal<RuntimeItemPayload | null>;
  catalogLanguages: Signal<readonly string[]>;
  recordEvidence: (evidence: AccommodationSupportEvidenceInput) => Promise<void>;
}) {
  const state = ref<GlossaryState>({ status: "closed" });
  const lifecycle = useCatalogRequestDialog({
    rendererElement: input.rendererElement,
    acceptsRequest: (detail) =>
      input.glossaryEntitled.value &&
      detail.delivery.availableSupports.includes(HARBOR_GLOSSARY_ON_SCREEN_SUPPORT),
    openRequest: openGlossary,
  });

  function resolveEvidenceEntries(referenceId: string): HarborCatalogSupportEntry[] {
    const host = input.rendererElement.value;
    if (!host) return [];
    return resolveHarborCatalogSupportEvidenceEntries({
      host,
      support: HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
      referenceId,
      itemHref: input.currentItemPayload.value?.item.href ?? "",
      assets: input.currentItemPayload.value?.item.assets ?? [],
      languages: input.catalogLanguages.value,
    });
  }

  async function openGlossary(detail: RendererCatalogRequestEventDetail): Promise<void> {
    const projection = projectGlossaryCatalogDelivery(detail.delivery);
    const evidenceEntries = resolveEvidenceEntries(detail.reference.referenceId);
    state.value = {
      status: "open",
      matches: projection.matches,
      referenceId: detail.reference.referenceId,
      remoteContent: projection.referencedFile ? { status: "loading" } : { status: "none" },
    };
    void input.recordEvidence({
      support: HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
      state: projection.matches.length > 0 ? "opened" : "unavailable",
      entries: evidenceEntries,
      reason: projection.matches.length > 0 ? "candidate-request" : "catalog-support-missing",
      control: "glossary-dialog",
      dedupe: projection.matches.length === 0,
    });
    if (!projection.referencedFile) return;

    const referencedFile = projection.referencedFile;
    await loadCatalogReferencedText({
      lifecycle,
      href: referencedFile.href,
      mimeType: referencedFile.mimeType,
      onReady: (text) => {
        state.value = {
          status: "open",
          matches: projection.matches,
          referenceId: detail.reference.referenceId,
          remoteContent: { status: "ready", text },
        };
      },
      onFailed: async () => {
        state.value = {
          status: "open",
          matches: projection.matches,
          referenceId: detail.reference.referenceId,
          remoteContent: {
            status: "failed",
            message: "The referenced glossary content could not be loaded.",
          },
        };
        await input.recordEvidence({
          support: HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
          state: "unavailable",
          entries: evidenceEntries,
          reason: "catalog-asset-load-failed",
          control: "glossary-dialog",
          dedupe: true,
        });
      },
    });
  }

  function dismissGlossary(): void {
    if (state.value.status === "open") {
      void input.recordEvidence({
        support: HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
        state: "closed",
        entries: resolveEvidenceEntries(state.value.referenceId),
        reason: "candidate-close",
        control: "glossary-dialog",
        dedupe: false,
      });
    }
    state.value = { status: "closed" };
    lifecycle.dismiss();
  }

  const glossary: GlossaryDialogProps = {
    state: computed<GlossaryDialogState>(() => {
      if (state.value.status === "closed") return state.value;
      return {
        status: "open",
        matches: state.value.matches,
        remoteContent: state.value.remoteContent,
      };
    }),
    dismiss: dismissGlossary,
  };

  return { glossary, dismissGlossary };
}
