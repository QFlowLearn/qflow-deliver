import { fetchCatalogReferencedText, isAbortError } from "./catalog-dialog-helpers";
import type { CatalogDialogContentRequest } from "./useCatalogRequestDialog";

export async function loadCatalogReferencedText(input: {
  lifecycle: {
    startContentRequest(): CatalogDialogContentRequest;
  };
  href: string;
  mimeType: string | undefined;
  onReady: (text: string) => void | Promise<void>;
  onFailed: (message: string) => void | Promise<void>;
}): Promise<void> {
  const request = input.lifecycle.startContentRequest();
  try {
    const text = await fetchCatalogReferencedText(input.href, input.mimeType, request.signal);
    if (!request.isCurrent()) return;
    await input.onReady(text);
  } catch (cause: unknown) {
    if (!request.isCurrent() || isAbortError(cause)) return;
    await input.onFailed("The referenced catalog content could not be loaded.");
  } finally {
    request.finish();
  }
}
