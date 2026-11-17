import type { HarborAfaPnpSupport, HarborCatalogSupportEntry } from "@harbor/attempt-protocol";
import { resolveHarborCatalogSupportEntries } from "@harbor/attempt-protocol";
import type { QtiRendererHost, RendererCatalogSupportResolution } from "@harbor/renderer-adapter";
import type { RuntimeItemPayload } from "@/lib/runtime-session";

export type SessionCatalogResolutionHost = Pick<QtiRendererHost, "getCatalogSupportResolution">;

export interface ResolveSessionCatalogEntriesInput {
  readonly currentItemPayload: RuntimeItemPayload | null;
  readonly supports: readonly HarborAfaPnpSupport[] | readonly string[];
  readonly requestedLanguage?: string | null;
  readonly resolution?: RendererCatalogSupportResolution | null;
  readonly host?: SessionCatalogResolutionHost | null;
  readonly languages?: readonly string[];
  readonly includeDefaultFallback?: boolean;
}

/** Resolves catalog support entries through one shared host/cache resolution path. */
export function resolveSessionCatalogEntries(
  input: ResolveSessionCatalogEntriesInput,
): HarborCatalogSupportEntry[] {
  const supports = input.supports as HarborAfaPnpSupport[];
  const resolution = resolveSessionCatalogSupportResolution({
    supports,
    resolution: input.resolution,
    host: input.host,
    languages: input.languages,
    requestedLanguage: input.requestedLanguage,
    includeDefaultFallback: input.includeDefaultFallback,
  });

  return resolveHarborCatalogSupportEntries({
    resolution,
    itemHref: input.currentItemPayload?.item.href ?? "",
    assets: input.currentItemPayload?.item.assets ?? [],
    supports,
    requestedLanguage: input.requestedLanguage,
  });
}

export function resolveSessionCatalogSupportResolution(input: {
  readonly supports: readonly HarborAfaPnpSupport[] | readonly string[];
  readonly resolution?: RendererCatalogSupportResolution | null;
  readonly host?: SessionCatalogResolutionHost | null;
  readonly languages?: readonly string[];
  readonly requestedLanguage?: string | null;
  readonly includeDefaultFallback?: boolean;
}): RendererCatalogSupportResolution | null {
  const supports = input.supports as HarborAfaPnpSupport[];
  if (supports.length === 0) {
    return null;
  }

  const needsLanguageSpecificResolution =
    input.requestedLanguage != null || Boolean(input.languages?.length && supports.length === 1);

  if (input.host && needsLanguageSpecificResolution) {
    return (
      input.host.getCatalogSupportResolution({
        supports,
        languages: input.requestedLanguage ? [input.requestedLanguage] : [...input.languages!],
        includeDefaultFallback: input.includeDefaultFallback ?? true,
      }) ?? null
    );
  }

  if (input.resolution) {
    return input.resolution;
  }

  if (!input.host) {
    return null;
  }

  return (
    input.host.getCatalogSupportResolution({
      supports,
      ...(input.languages?.length
        ? {
            languages: [...input.languages],
            includeDefaultFallback: input.includeDefaultFallback ?? true,
          }
        : {}),
    }) ?? null
  );
}
