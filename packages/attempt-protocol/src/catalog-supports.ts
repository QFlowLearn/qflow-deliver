import type { QtiCatalogSupportResolution } from "@longsightgroup/qti3-core";
import { resolvePackageAssetReference } from "@harbor/content-model";

export interface HarborCatalogAssetDescriptor {
  href: string;
  url: string;
  mediaType: string;
}

export interface HarborCatalogSupportEntry {
  key: string;
  referenceId: string;
  support: string;
  catalogId: string;
  label: string;
  requestedLanguage: string | null;
  language: string | null;
  selectionReason: string;
  assetReference: string | null;
  href: string | null;
  url: string | null;
  mediaType: string | null;
  text: string | null;
}

export function resolveHarborCatalogSupportEntries(input: {
  resolution: QtiCatalogSupportResolution | null | undefined;
  itemHref: string;
  assets: readonly HarborCatalogAssetDescriptor[];
  supports: readonly string[];
  requestedLanguage?: string | null;
}): HarborCatalogSupportEntry[] {
  if (!input.resolution || input.supports.length === 0) {
    return [];
  }

  const requestedSupports = new Set(input.supports.map((support) => support.toLowerCase()));
  const entries: HarborCatalogSupportEntry[] = [];

  for (const reference of input.resolution.references) {
    for (const [matchIndex, support] of reference.matches.entries()) {
      if (!requestedSupports.has(support.support.toLowerCase())) {
        continue;
      }

      const label = formatCatalogSupportLabel(support.support);
      const base = {
        referenceId: reference.referenceId,
        support: support.support,
        catalogId: support.catalogId,
        label,
        requestedLanguage: input.requestedLanguage ?? null,
        language: support.language ?? null,
        selectionReason: support.selectionReason,
      };

      for (const [index, fileHref] of support.fileHrefs.entries()) {
        const resolved = resolveCatalogFileHref({
          itemHref: input.itemHref,
          assets: input.assets,
          href: fileHref.href,
        });

        entries.push({
          ...base,
          key: [
            reference.idref,
            support.catalogId,
            support.support,
            support.language ?? "",
            matchIndex,
            fileHref.href,
            index,
          ].join(":"),
          href: fileHref.href,
          assetReference:
            normalizeCatalogReference(input.itemHref, fileHref.href)?.assetHref ?? null,
          url: resolved?.url ?? null,
          mediaType: fileHref.mimeType ?? resolved?.mediaType ?? null,
          text: null,
        });
      }

      if (support.htmlContent?.text.trim()) {
        entries.push({
          ...base,
          key: [
            reference.idref,
            support.catalogId,
            support.support,
            support.language ?? "",
            matchIndex,
            "html",
          ].join(":"),
          href: null,
          assetReference: null,
          url: null,
          mediaType: "text/html",
          text: support.htmlContent.text.trim(),
        });
      }
    }
  }

  return entries;
}

function resolveCatalogFileHref(input: {
  itemHref: string;
  assets: readonly HarborCatalogAssetDescriptor[];
  href: string;
}): { url: string; mediaType: string } | null {
  const reference = normalizeCatalogReference(input.itemHref, input.href);
  if (!reference) {
    return null;
  }

  const asset = input.assets.find(
    (candidate) => normalizeManifestAssetHref(candidate.href) === reference.assetHref,
  );
  if (!asset) {
    return null;
  }

  return {
    url: `${asset.url}${reference.fragment}`,
    mediaType: asset.mediaType,
  };
}

function normalizeCatalogReference(
  itemHref: string,
  rawHref: string,
): { assetHref: string; fragment: string } | null {
  const resolution = resolvePackageAssetReference(itemHref, rawHref);
  if (!resolution.ok) return null;
  return { assetHref: resolution.href, fragment: resolution.fragment };
}

function normalizeManifestAssetHref(href: string): string {
  const trimmed = href.trim().replace(/^\/+/, "");
  const withoutFragment = trimmed.split("#", 1)[0] ?? "";
  return withoutFragment.split("?", 1)[0] ?? "";
}

function formatCatalogSupportLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
