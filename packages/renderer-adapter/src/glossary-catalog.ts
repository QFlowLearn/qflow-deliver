import { HARBOR_GLOSSARY_ON_SCREEN_SUPPORT } from "@harbor/attempt-protocol";
import type { QtiAssessmentItemPlayerProps } from "@longsightgroup/qti3-player-preact";

type RendererCatalogRequestDelivery = Parameters<
  NonNullable<QtiAssessmentItemPlayerProps["onCatalogRequest"]>
>[0]["delivery"];

export type GlossaryCatalogMatch = RendererCatalogRequestDelivery["matches"][number];

export type GlossaryCatalogReferencedFile = GlossaryCatalogMatch["files"][number];

export interface GlossaryCatalogDeliveryProjection {
  readonly matches: readonly GlossaryCatalogMatch[];
  readonly referencedFile: GlossaryCatalogReferencedFile | null;
}

/** Projects glossary-on-screen catalog delivery into inline HTML matches and one remote file. */
export function projectGlossaryCatalogDelivery(
  delivery: RendererCatalogRequestDelivery,
): GlossaryCatalogDeliveryProjection {
  const matches = delivery.matches.filter(
    (match) => match.support === HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
  );
  const referencedFile =
    matches
      .flatMap((match) => match.files)
      .filter(isGlossaryReferencedFileMimeType)
      .at(0) ?? null;

  return { matches, referencedFile };
}

function isGlossaryReferencedFileMimeType(file: GlossaryCatalogReferencedFile): boolean {
  return (
    file.mimeType === undefined || file.mimeType === "text/plain" || file.mimeType === "text/html"
  );
}
