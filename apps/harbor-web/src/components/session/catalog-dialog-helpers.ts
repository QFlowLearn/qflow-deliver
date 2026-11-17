import { readFetchedCatalogText } from "@harbor/renderer-adapter";

export async function fetchCatalogReferencedText(
  href: string,
  mimeType: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(href, {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Catalog file returned ${response.status}.`);
  }
  const source = await response.text();
  return readFetchedCatalogText(source, mimeType);
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}
