import type { QtiAssessmentItemPlayerHandle } from "@longsightgroup/qti3-player-preact";

type RendererCatalogDeliveryResolution = NonNullable<
  ReturnType<QtiAssessmentItemPlayerHandle["getCatalogDeliveryResolution"]>
>;

type RendererCatalogDeliveryReference = RendererCatalogDeliveryResolution["references"][number];

/** One keyword-translation match selected by qti3 catalog resolution. */
export type KeywordTranslationCatalogMatch = RendererCatalogDeliveryReference["matches"][number];

/** One safe catalog file selected for keyword translation delivery. */
export type KeywordTranslationCatalogFile = KeywordTranslationCatalogMatch["files"][number];

/** Host-facing projection of one referenced keyword translation. */
export interface KeywordTranslationCatalogProjection {
  readonly referenceId: string;
  readonly catalogId: string;
  readonly requestedLanguage: string;
  readonly resolvedLanguage: string | null;
  readonly selectionReason: string | null;
  readonly fallback: boolean;
  readonly matches: readonly KeywordTranslationCatalogMatch[];
  readonly referencedFile: KeywordTranslationCatalogFile | null;
}

/** Projects one referenced keyword into sanitized content and an allowed file asset. */
export function projectKeywordTranslationCatalogDelivery(input: {
  delivery: RendererCatalogDeliveryReference;
  requestedLanguage: string;
}): KeywordTranslationCatalogProjection {
  const matches = input.delivery.matches.filter(
    (match) => match.support.toLowerCase() === "keyword-translation",
  );
  const primaryMatch = matches.at(0) ?? null;
  const referencedFile =
    matches
      .flatMap((match) => match.files)
      .find((file) => isKeywordTranslationMimeType(file.mimeType)) ?? null;
  const resolvedLanguage = primaryMatch?.language ?? null;
  const selectionReason = primaryMatch?.selectionReason ?? null;

  return {
    referenceId: input.delivery.referenceId,
    catalogId: input.delivery.catalogId,
    requestedLanguage: input.requestedLanguage,
    resolvedLanguage,
    selectionReason,
    fallback: selectionReason !== null && selectionReason !== "exact-language",
    matches,
    referencedFile,
  };
}

/** Returns whether a catalog file can be rendered by Harbor's translation dialog. */
export function isKeywordTranslationMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return (
    mimeType === "text/plain" ||
    mimeType === "text/html" ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/")
  );
}
