import {
  resolveHarborCatalogSupportEntries,
  type HarborCatalogAssetDescriptor,
  type HarborCatalogSupportEntry,
} from "@harbor/attempt-protocol";
import type { QtiAssessmentItemPlayerHandle } from "@longsightgroup/qti3-player-preact";
import type { QtiCatalogSupportResolutionOptions } from "@longsightgroup/qti3-core";

type CatalogResolutionHost = {
  getCatalogDeliveryResolution(
    options?: QtiCatalogSupportResolutionOptions,
  ): ReturnType<QtiAssessmentItemPlayerHandle["getCatalogDeliveryResolution"]>;
  getCatalogSupportResolution(
    options?: QtiCatalogSupportResolutionOptions,
  ): ReturnType<QtiAssessmentItemPlayerHandle["getCatalogSupportResolution"]>;
};

type RendererCatalogDeliveryReference = NonNullable<
  ReturnType<QtiAssessmentItemPlayerHandle["getCatalogDeliveryResolution"]>
>["references"][number];

export function readFetchedCatalogText(source: string, mimeType: string | undefined): string {
  if (mimeType === "text/plain") {
    return source.trim();
  }
  return (new DOMParser().parseFromString(source, "text/html").body.textContent ?? "").trim();
}

export function resolveHarborCatalogSupportDelivery<T>(input: {
  host: CatalogResolutionHost;
  support: string;
  requestedLanguage: string;
  referenceId: string;
  itemHref: string;
  assets: readonly HarborCatalogAssetDescriptor[];
  project: (delivery: RendererCatalogDeliveryReference, requestedLanguage: string) => T;
}): { projection: T; evidenceEntries: HarborCatalogSupportEntry[] } | null {
  const options: QtiCatalogSupportResolutionOptions = {
    supports: [input.support],
    languages: [input.requestedLanguage],
    includeDefaultFallback: true,
  };
  const deliveryReference = input.host
    .getCatalogDeliveryResolution(options)
    ?.references.find((reference) => reference.referenceId === input.referenceId);
  if (!deliveryReference) {
    return null;
  }

  const evidenceEntries = resolveHarborCatalogSupportEntries({
    resolution: input.host.getCatalogSupportResolution(options),
    itemHref: input.itemHref,
    assets: input.assets,
    supports: [input.support],
    requestedLanguage: input.requestedLanguage,
  }).filter((entry) => entry.referenceId === input.referenceId);

  return {
    projection: input.project(deliveryReference, input.requestedLanguage),
    evidenceEntries,
  };
}

export function resolveHarborCatalogSupportEvidenceEntries(input: {
  host: CatalogResolutionHost;
  support: string;
  referenceId: string;
  itemHref: string;
  assets: readonly HarborCatalogAssetDescriptor[];
  requestedLanguage?: string | null;
  languages?: readonly string[];
}): HarborCatalogSupportEntry[] {
  const options: QtiCatalogSupportResolutionOptions = {
    supports: [input.support],
    ...(input.requestedLanguage
      ? { languages: [input.requestedLanguage], includeDefaultFallback: true }
      : { languages: [...(input.languages ?? [])], includeDefaultFallback: true }),
  };
  return resolveHarborCatalogSupportEntries({
    resolution: input.host.getCatalogSupportResolution(options),
    itemHref: input.itemHref,
    assets: input.assets,
    supports: [input.support],
    requestedLanguage: input.requestedLanguage,
  }).filter((entry) => entry.referenceId === input.referenceId);
}
