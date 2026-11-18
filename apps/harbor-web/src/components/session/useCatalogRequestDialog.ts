import { reportUiError } from "@/lib/ui-errors";
import type { Signal } from "@preact/signals";
import type { QtiRendererHost, RendererCatalogRequestEventDetail } from "@harbor/renderer-adapter";
import { onBeforeUnmount, watch } from "@/lib/preact-reactivity";

/** Abort-aware handle for the dialog's current referenced-content request. */
export interface CatalogDialogContentRequest {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  finish(): void;
}

/** Owns the renderer subscription, request cancellation, and focus lifetime for a catalog dialog. */
export function useCatalogRequestDialog(input: {
  rendererElement: Signal<QtiRendererHost | null>;
  acceptsRequest: (detail: RendererCatalogRequestEventDetail) => boolean;
  openRequest: (detail: RendererCatalogRequestEventDetail) => Promise<void>;
}) {
  let cancelCatalogSubscription: (() => void) | undefined;
  let contentRequest: AbortController | undefined;
  let returnFocusElement: HTMLElement | null = null;

  watch(
    () => input.rendererElement.value,
    (host) => {
      cancelCatalogSubscription?.();
      cancelCatalogSubscription = host?.subscribeCatalogRequests((detail) => {
        if (!input.acceptsRequest(detail)) return;
        cancelContentRequest();
        returnFocusElement = detail.returnFocusElement;
        input.openRequest(detail).catch(reportUiError);
      });
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    cancelCatalogSubscription?.();
    cancelContentRequest();
    returnFocusElement = null;
  });

  function startContentRequest(): CatalogDialogContentRequest {
    cancelContentRequest();
    const controller = new AbortController();
    contentRequest = controller;
    return {
      signal: controller.signal,
      isCurrent: () => contentRequest === controller,
      finish() {
        if (contentRequest === controller) contentRequest = undefined;
      },
    };
  }

  function cancelContentRequest(): void {
    contentRequest?.abort();
    contentRequest = undefined;
  }

  function dismiss(): void {
    cancelContentRequest();
    const element = returnFocusElement;
    returnFocusElement = null;
    requestAnimationFrame(() => {
      if (element?.isConnected) element.focus();
    });
  }

  return {
    startContentRequest,
    cancelContentRequest,
    dismiss,
  };
}
