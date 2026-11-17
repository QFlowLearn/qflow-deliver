import { isDeliverySessionLocation, maybeBootstrapFromQuery } from "./bootstrap-client";
import { formatError } from "./harbor-runtime/formatting";
import { buildHarborRuntimeFacade, createHarborRuntimeWiring } from "./harbor-runtime/wiring";
import { onBeforeUnmount, onMounted } from "./preact-reactivity";

function createHarborRuntimeController() {
  const wiring = createHarborRuntimeWiring();

  onMounted(async () => {
    window.addEventListener("online", wiring.deliveryLifecycle.handleBrowserOnline);
    document.addEventListener("visibilitychange", wiring.deliveryLifecycle.handleVisibilityChange);
    window.addEventListener("pagehide", wiring.deliveryLifecycle.handlePageHide);
    document.addEventListener("freeze", wiring.deliveryLifecycle.handlePageFreeze);
    wiring.deliveryLifecycle.startTimingClock();
    wiring.deliverySession.loading.value = true;
    wiring.deliverySession.currentClientSessionId.value =
      wiring.deliveryLifecycle.recoveryCache.readOrCreateClientSessionId();

    try {
      const location = new URL(window.location.href);
      const session = isDeliverySessionLocation(location)
        ? (wiring.deliveryLifecycle.recoveryCache.readCachedBootstrappedSession() ??
          (await maybeBootstrapFromQuery(
            location,
            wiring.deliverySession.currentClientSessionId.value,
          )))
        : null;
      await Promise.all([
        wiring.studentLaunch.refreshInstitutionalSession(),
        wiring.instructorWorkspace.refreshInstructorAssignments(),
      ]);
      if (session) {
        await wiring.deliverySession.applyBootstrappedSession(session);
      }
    } catch (error) {
      wiring.deliveryLifecycle.maybeProjectDeliveryContextError(error);
      wiring.deliverySession.errorMessage.value = formatError(error);
    } finally {
      wiring.deliverySession.loading.value = false;
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener("online", wiring.deliveryLifecycle.handleBrowserOnline);
    document.removeEventListener(
      "visibilitychange",
      wiring.deliveryLifecycle.handleVisibilityChange,
    );
    window.removeEventListener("pagehide", wiring.deliveryLifecycle.handlePageHide);
    document.removeEventListener("freeze", wiring.deliveryLifecycle.handlePageFreeze);
    wiring.deliveryLifecycle.recoveryCache.markRecoverySessionClosed();
    wiring.deliveryLifecycle.stopRecoveryHeartbeat();
    wiring.deliveryLifecycle.stopTimingClock();
    wiring.rendererLifecycle.clearRendererPreflushTimer();
    wiring.deliveryLifecycle.clearHistoryRefreshTimer?.();
  });

  return buildHarborRuntimeFacade(wiring);
}

export type HarborRuntimeController = ReturnType<typeof createHarborRuntimeController>;

let harborRuntime: HarborRuntimeController | null = null;

export function provideHarborRuntime(): HarborRuntimeController {
  if (!harborRuntime) {
    harborRuntime = createHarborRuntimeController();
  }

  return harborRuntime;
}

export function useHarborRuntime(): HarborRuntimeController {
  if (!harborRuntime) {
    throw new Error("QFlowLearn Delivery runtime controller is not available.");
  }

  return harborRuntime;
}
