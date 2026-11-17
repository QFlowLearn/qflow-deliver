export function resolveEndpointUrl(value: string, requestOrigin: string): string {
  return new URL(value, requestOrigin).toString();
}

export function normalizeLtiLoginTargetLinkUri(
  targetLinkUri: string | null | undefined,
  requestOrigin: string,
): string | null {
  if (!targetLinkUri?.trim()) {
    return null;
  }

  try {
    new URL(targetLinkUri);
    return targetLinkUri;
  } catch {
    return new URL(targetLinkUri, requestOrigin).toString();
  }
}

export function normalizeLtiLoginUrl(url: URL): URL {
  const normalizedUrl = new URL(url);
  const targetLinkUri = normalizedUrl.searchParams.get("target_link_uri");
  if (targetLinkUri) {
    const normalized = normalizeLtiLoginTargetLinkUri(targetLinkUri, url.origin);
    if (normalized) {
      normalizedUrl.searchParams.set("target_link_uri", normalized);
    }
  }

  return normalizedUrl;
}
