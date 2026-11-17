import type { HarborCatalogAssetDescriptor } from "@harbor/attempt-protocol";
import {
  resolvePackageAssetReference,
  type PackageAssetReferenceFailure,
  type PackageAssetReferenceResolution,
} from "@harbor/content-model";
import type { QtiStylesheet } from "@longsightgroup/qti3-core";

export type RendererPackageAsset = HarborCatalogAssetDescriptor;

export type { PackageAssetReferenceFailure, PackageAssetReferenceResolution };

export { resolvePackageAssetReference };

/** Creates fail-closed qti3 asset and stylesheet resolvers for one delivered item. */
export function createPackageAssetResolvers(input: {
  readonly itemHref: string;
  readonly assets: readonly RendererPackageAsset[];
}) {
  const assetsByHref = new Map(input.assets.map((asset) => [asset.href, asset]));
  const resolveAssetRecord = (
    reference: string,
  ): { asset: RendererPackageAsset; fragment: string } | undefined => {
    const resolution = resolvePackageAssetReference(input.itemHref, reference);
    if (!resolution.ok) return undefined;
    const asset = assetsByHref.get(resolution.href);
    return asset ? { asset, fragment: resolution.fragment } : undefined;
  };

  return {
    resolveAsset(reference: string): string {
      const resolved = resolveAssetRecord(reference);
      return resolved ? `${resolved.asset.url}${resolved.fragment}` : "";
    },
    resolveStylesheet(stylesheet: QtiStylesheet) {
      if (stylesheet.type !== undefined && stylesheet.type.trim().toLowerCase() !== "text/css") {
        return undefined;
      }
      const resolved = resolveAssetRecord(stylesheet.href);
      if (!resolved || resolved.asset.mediaType !== "text/css") return undefined;
      return {
        href: resolved.asset.url,
        type: "text/css",
        media: stylesheet.media,
        title: stylesheet.title,
      };
    },
  };
}
