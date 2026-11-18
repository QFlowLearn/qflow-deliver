import { computed, nextTick, onBeforeUnmount, ref, useSetup, watch } from "@/lib/preact-reactivity";
import { assessmentInstructionsForItem } from "@harbor/content-model";
import {
  type QtiRendererHost,
  type RendererAnswerMaskChoiceRegion,
  type RendererCatalogSupportResolution,
  type RendererTextToSpeechTraversal,
} from "@harbor/renderer-adapter";
import {
  isHarborAfaPnpSupportOffered,
  type HarborAfaPnpSupport,
  type HarborAfaPnpSupportActivation,
} from "@harbor/attempt-protocol";
import type { HarborRuntimeController } from "@/lib/harbor-runtime";
import { buildSessionRendererShellProps } from "./session-renderer-shell-props";
import { useSessionItemNavigator } from "./useSessionItemNavigator";
import { useSessionCatalogSupports } from "./useSessionCatalogSupports";
import { resolveSessionCatalogEntries } from "./session-catalog-entries";
import { useSessionSupportEvidence } from "./useSessionSupportEvidence";
import { useSessionTextToSpeech } from "./useSessionTextToSpeech";
import { useSessionTimerAnnouncements } from "./useSessionTimerAnnouncements";
import { readNavigatorLanguages, uniqueStringList } from "./session-page-helpers";
import { resolveSessionCatalogSupportResolution } from "./session-catalog-entries";

export function useHarborSessionPageState(runtime: HarborRuntimeController) {
  const {
    attemptClient,
    attemptEditingLocked,
    bootstrappedSession,
    currentItemBlocksNavigation,
    currentItemId,
    currentItemPayload,
    currentItemPositionLabel,
    currentItemTitle,
    deliveryBusy,
    deliveryState,
    deliveryTiming,
    errorMessage,
    handleEndAttemptCompleted,
    handleItemReady,
    handleRendererInteractionObserved,
    handleScoreAttemptCompleted,
    handleSuspendAttemptCompleted,
    handleSnapshotAttemptCompleted,
    itemReady,
    latestSubmittedAttempt,
    latestSubmittedOutcomeMessage,
    navigateToItem,
    pendingReplayCount,
    pnpPolicy,
    rendererConfiguration,
    rendererHost,
    responseSaveStatus,
    replayStatus,
    runtimeManifest,
    shellAccommodationTools,
    submissionState,
  } = runtime;

  return useSetup(() => {
    const lineReaderActive = ref(false);
    const maskActive = ref(false);
    const notepadText = ref("");
    const lineReaderTop = ref(45);
    const lineReaderHeight = ref(3);
    const maskRevealTop = ref(42);
    const maskRevealHeight = ref(18);
    const captionsPanelOpen = ref(false);
    const transcriptsPanelOpen = ref(false);
    const mediaAlternativesPanelOpen = ref(false);
    const answerMaskChoiceRegions = ref<RendererAnswerMaskChoiceRegion[]>([]);
    const catalogSupportResolution = ref<RendererCatalogSupportResolution | null>(null);
    const textToSpeechTraversal = ref<RendererTextToSpeechTraversal | null>(null);
    const selectedAnswerMaskChoiceRegionIndex = ref<number | null>(null);
    const calculatorLeft = ref(0);
    const calculatorRight = ref(0);
    const calculatorOperator = ref<"+" | "-" | "*" | "/">("+");
    const rendererElement = ref<QtiRendererHost | null>(null);
    const rendererMountElement = ref<HTMLDivElement | null>(null);
    const mediaSupportPanelElement = ref<HTMLElement | null>(null);
    const boundRendererElements = new WeakSet<QtiRendererHost>();
    let lastRendererElement: QtiRendererHost | null = null;
    let lastRendererLoadSignature = "";
    let lastSupportActivationSignature = "";

    const textToSpeechActivation = computed(() => supportActivation("spoken"));
    const lineReaderActivation = computed(() => supportActivation("line-reader"));
    const answerMaskingActivation = computed(() => supportActivation("answer-masking"));
    const calculatorActivation = computed(() => supportActivation("calculator"));
    const notepadActivation = computed(() => supportActivation("note-taking-on-screen"));
    const captionActivation = computed(() => supportActivation("caption"));
    const transcriptActivation = computed(() => supportActivation("transcript"));
    const audioDescriptionActivation = computed(() => supportActivation("audio-description"));
    const signLanguageActivation = computed(() => supportActivation("sign-language"));
    const catalogSupportFilters = computed(() => pnpPolicy.value.catalogSupports);
    const catalogLanguages = computed(() =>
      uniqueStringList([...pnpPolicy.value.languages, ...readNavigatorLanguages()]),
    );

    const { recordAccommodationSupportEvidence, recordMediaAlternativePanelEvidence } =
      useSessionSupportEvidence({
        bootstrappedSession,
        attemptClient,
        currentItemPayload,
        runtimeManifest,
        catalogSupportResolution,
        rendererElement,
        catalogLanguages,
        supportActivation,
      });

    const catalogSupports = useSessionCatalogSupports({
      runtime,
      rendererElement,
      catalogSupportFilters,
      catalogSupportResolution,
      textToSpeechTraversal,
      catalogLanguages,
      supportActivation,
      recordEvidence: recordAccommodationSupportEvidence,
    });

    const {
      glossary,
      keywordTranslation,
      dismissGlossary,
      dismissTranslation,
      resetCatalogState,
      recordSupportAvailabilityEvidence,
    } = catalogSupports;

    const currentItemMediaAssets = computed(
      () =>
        currentItemPayload.value?.item.assets.filter(
          (asset) => asset.mediaType.startsWith("audio/") || asset.mediaType.startsWith("video/"),
        ) ?? [],
    );

    const currentItemCatalogSupportEntries = computed(() =>
      resolveSessionCatalogEntries({
        resolution: catalogSupportResolution.value,
        currentItemPayload: currentItemPayload.value,
        supports: catalogSupportFilters.value,
      }),
    );

    const currentItemHasMedia = computed(() =>
      Boolean(
        currentItemCatalogSupportEntries.value.length > 0 ||
        currentItemPayload.value?.item.assets.some(
          (asset) => asset.mediaType.startsWith("audio/") || asset.mediaType.startsWith("video/"),
        ) ||
        currentItemPayload.value?.item.xml.includes("<audio") ||
        currentItemPayload.value?.item.xml.includes("<video"),
      ),
    );

    const currentItemCaptionEntries = computed(() =>
      resolveSessionCatalogEntries({
        resolution: catalogSupportResolution.value,
        currentItemPayload: currentItemPayload.value,
        supports: ["caption"],
      }),
    );

    const currentItemTranscriptEntries = computed(() =>
      resolveSessionCatalogEntries({
        resolution: catalogSupportResolution.value,
        currentItemPayload: currentItemPayload.value,
        supports: ["transcript"],
      }),
    );

    const currentItemMediaAlternativeSupports = computed(() => [
      ...(isHarborAfaPnpSupportOffered(audioDescriptionActivation.value)
        ? (["audio-description"] as const)
        : []),
      ...(isHarborAfaPnpSupportOffered(signLanguageActivation.value)
        ? (["sign-language"] as const)
        : []),
    ]);

    const currentItemMediaAlternativeEntries = computed(() =>
      resolveSessionCatalogEntries({
        resolution: catalogSupportResolution.value,
        currentItemPayload: currentItemPayload.value,
        supports: currentItemMediaAlternativeSupports.value,
      }),
    );

    const showTextToSpeechTool = computed(() =>
      isHarborAfaPnpSupportOffered(textToSpeechActivation.value),
    );
    const showLineReaderTool = computed(() =>
      isHarborAfaPnpSupportOffered(lineReaderActivation.value),
    );
    const showAnswerMaskingTool = computed(() =>
      isHarborAfaPnpSupportOffered(answerMaskingActivation.value),
    );
    const showCalculatorTool = computed(
      () =>
        isHarborAfaPnpSupportOffered(calculatorActivation.value) &&
        Boolean(
          shellAccommodationTools.value.calculator &&
          shellAccommodationTools.value.calculator !== "none",
        ),
    );
    const showNotepadTool = computed(() => isHarborAfaPnpSupportOffered(notepadActivation.value));
    const showCaptionTool = computed(
      () => isHarborAfaPnpSupportOffered(captionActivation.value) && currentItemHasMedia.value,
    );
    const showTranscriptTool = computed(
      () => isHarborAfaPnpSupportOffered(transcriptActivation.value) && currentItemHasMedia.value,
    );
    const showMediaAlternativesTool = computed(
      () =>
        currentItemHasMedia.value &&
        (isHarborAfaPnpSupportOffered(audioDescriptionActivation.value) ||
          isHarborAfaPnpSupportOffered(signLanguageActivation.value)),
    );

    const shellToolsVisible = computed(() =>
      Boolean(
        showTextToSpeechTool.value ||
        showLineReaderTool.value ||
        showAnswerMaskingTool.value ||
        showCalculatorTool.value ||
        showNotepadTool.value ||
        showCaptionTool.value ||
        showTranscriptTool.value ||
        showMediaAlternativesTool.value,
      ),
    );

    const {
      currentSegmentText: ttsCurrentSegmentText,
      pause: pauseTextToSpeech,
      playbackState: ttsPlaybackState,
      playbackStatusLabel: ttsPlaybackStatusLabel,
      resume: resumeTextToSpeech,
      start: startTextToSpeech,
      stop: stopTextToSpeech,
    } = useSessionTextToSpeech({
      activation: textToSpeechActivation,
      traversal: textToSpeechTraversal,
      rendererHost,
      catalogLanguages,
      currentItemTitle,
      currentItemPositionLabel,
      recordEvidence: recordAccommodationSupportEvidence,
    });

    const lineReaderStyle = computed(() => ({
      top: `${lineReaderTop.value}%`,
      height: `${lineReaderHeight.value}rem`,
    }));

    const maskRevealStyle = computed(() => ({
      top: `${maskRevealTop.value}%`,
      height: `${maskRevealHeight.value}%`,
    }));

    const maskOverlayStyle = computed(() => ({
      "--mask-top": `${maskRevealTop.value}%`,
      "--mask-bottom": `${Math.min(maskRevealTop.value + maskRevealHeight.value, 100)}%`,
    }));

    const calculatorResult = computed(() => {
      switch (calculatorOperator.value) {
        case "+":
          return calculatorLeft.value + calculatorRight.value;
        case "-":
          return calculatorLeft.value - calculatorRight.value;
        case "*":
          return calculatorLeft.value * calculatorRight.value;
        case "/":
          return calculatorRight.value === 0
            ? "Undefined"
            : calculatorLeft.value / calculatorRight.value;
      }
    });

    const studentStateLabel = computed(() => {
      switch (deliveryState.value) {
        case "active":
          return "In progress";
        case "submitted":
          return "Submitted";
        case "accepting_late_within_grace":
          return "Grace period";
        case "expired_pending_recovery":
          return "Needs recovery";
        case "soft_closed":
          return "Closed";
        case "reopened":
          return "Reopened";
        default:
          return String(deliveryState.value).replaceAll("_", " ");
      }
    });

    const syncStatusLabel = computed(() => {
      if (replayStatus.value.toLowerCase().includes("no longer current")) return "Read-only";
      if (submissionState.value.status === "pending") return "Finish pending";
      if (submissionState.value.status === "review_required") return "Needs invigilator";
      if (pendingReplayCount.value > 0) return "Sync pending";
      if (deliveryBusy.value) return "Saving";
      if (deliveryState.value === "submitted") return "";
      return responseSaveStatus.value;
    });

    const syncStatusTone = computed(() => {
      if (replayStatus.value.toLowerCase().includes("no longer current")) return "locked";
      if (pendingReplayCount.value > 0) return "warning";
      if (deliveryState.value === "submitted") return "success";
      return "neutral";
    });

    const showSyncStatusPill = computed(() => syncStatusLabel.value.length > 0);
    const showStatePill = computed(
      () =>
        deliveryState.value !== "active" &&
        deliveryState.value !== "submitted" &&
        studentStateLabel.value.length > 0,
    );

    const sessionNotice = computed(() => {
      if (replayStatus.value.toLowerCase().includes("no longer current")) {
        return {
          tone: "locked" as const,
          title: "This tab is inactive",
          body: "Another workstation is active for this attempt. Ask an invigilator before continuing. Local pending work has been retained.",
        };
      }

      if (submissionState.value.status === "pending") {
        return {
          tone: "locked" as const,
          title: "Finish saved; confirmation pending",
          body: "Your final answers are locked on this workstation. Keep this tab open. Harbor will retry when the connection returns. Ask an invigilator if the outage continues.",
        };
      }
      if (submissionState.value.status === "review_required") {
        return {
          tone: "locked" as const,
          title: "Final work needs invigilator review",
          body: "Keep this workstation and its local data available. The server has not confirmed acceptance of this final answer set.",
        };
      }

      if (pendingReplayCount.value > 0 || (!currentItemPayload.value && errorMessage.value)) {
        return {
          tone: "warning" as const,
          title: "Connection interrupted",
          body: "Work is saved on this workstation. Stay on this question and ask an invigilator. Loading another question or reopening the assessment needs a connection. The exam timer continues.",
        };
      }

      if (submissionState.value.status === "confirmed" && deliveryState.value !== "submitted")
        return {
          tone: "success" as const,
          title: "Submitted",
          body: "The server confirmed your submission. Keep the receipt for your records.",
        };

      if (deliveryState.value === "submitted") {
        return {
          tone:
            latestSubmittedAttempt.value?.resultStatus === "failed" ||
            latestSubmittedAttempt.value?.finalization?.status === "failed"
              ? ("warning" as const)
              : ("success" as const),
          title:
            latestSubmittedAttempt.value?.resultStatus === "pending" ||
            latestSubmittedAttempt.value?.finalization?.status === "pending"
              ? "Awaiting review"
              : latestSubmittedAttempt.value?.resultStatus === "failed" ||
                  latestSubmittedAttempt.value?.finalization?.status === "failed"
                ? "Results delayed"
                : "Submitted",
          body: latestSubmittedOutcomeMessage.value,
        };
      }

      if (deliveryState.value === "accepting_late_within_grace") {
        return {
          tone: "warning" as const,
          title: "Time is up",
          body: "The timer has ended, but you can still submit during the grace window.",
        };
      }

      if (deliveryState.value === "expired_pending_recovery") {
        return {
          tone: "locked" as const,
          title: "Submission is paused",
          body: "This attempt needs recovery or instructor action before more changes can be accepted.",
        };
      }

      return null;
    });

    const showRetrySync = computed(
      () =>
        (pendingReplayCount.value > 0 ||
          (!currentItemPayload.value && Boolean(errorMessage.value))) &&
        !replayStatus.value.toLowerCase().includes("no longer current"),
    );

    const {
      timerAriaLabel,
      timerAssertiveAnnouncement,
      timerIsBounded,
      timerLabel,
      timerPoliteAnnouncement,
    } = useSessionTimerAnnouncements({
      attemptId: computed(() => bootstrappedSession.value?.payload.attemptId ?? ""),
      deliveryState: computed(() => deliveryState.value),
      remainingTimeSeconds: computed(() => deliveryTiming.value.remainingTimeSeconds),
    });

    const currentItemOrdinal = computed(() => {
      if (runtimeManifest.value?.testSequence)
        return Math.min(
          runtimeManifest.value.testSequence.answered + 1,
          runtimeManifest.value.testSequence.target,
        );
      if (!runtimeManifest.value || !currentItemId.value) return 0;

      const index = runtimeManifest.value.itemOrder.findIndex(
        (itemId) => itemId === currentItemId.value,
      );
      return index < 0 ? 0 : index + 1;
    });

    const progressPercent = computed(() => {
      const total =
        runtimeManifest.value?.testSequence?.target ?? runtimeManifest.value?.itemOrder.length ?? 0;
      if (total === 0 || currentItemOrdinal.value === 0) return "0%";
      return `${Math.min(100, (currentItemOrdinal.value / total) * 100)}%`;
    });

    const navigationMode = computed(
      () => bootstrappedSession.value?.payload.deliveryPolicy.navigationMode ?? "linear",
    );

    const {
      clearItemNavigatorFeedback,
      focusedItemStepId,
      handleItemStepActivation,
      handleItemStepKeydown,
      itemNavigationEntries,
      itemNavigatorFeedback,
      rovingItemStepId,
      setItemStepRef,
    } = useSessionItemNavigator({
      runtimeManifest,
      currentItemId,
      currentItemOrdinal,
      attemptEditingLocked,
      deliveryBusy,
      attemptClientReady: computed(() => Boolean(attemptClient.value)),
      currentItemBlocksNavigation,
      navigationMode,
      replayStatus,
      navigateToItem,
      stopTextToSpeech,
    });

    const currentItemPointLabel = computed(() => {
      if (!runtimeManifest.value || !currentItemId.value) return "";

      const maxScore = runtimeManifest.value.items[currentItemId.value]?.maxScore;
      if (maxScore === null || maxScore === undefined) return "";
      return `${maxScore} point${maxScore === 1 ? "" : "s"}`;
    });

    const currentItemTimeDependent = computed(() =>
      Boolean(
        currentItemPayload.value?.item.timeDependent ??
        (currentItemId.value
          ? runtimeManifest.value?.items[currentItemId.value]?.timeDependent
          : false),
      ),
    );

    watch(
      () => bootstrappedSession.value?.payload.attemptId ?? "",
      (attemptId) => {
        restoreShellToolState(attemptId);
      },
      { immediate: true },
    );

    watch([lineReaderTop, lineReaderHeight, maskRevealTop, maskRevealHeight], () => {
      persistShellToolState();
    });

    watch(
      () => currentItemId.value,
      (itemId) => {
        stopTextToSpeech("item-change");
        focusedItemStepId.value = itemId ?? "";
        clearItemNavigatorFeedback();
        selectedAnswerMaskChoiceRegionIndex.value = null;
        captionsPanelOpen.value = false;
        transcriptsPanelOpen.value = false;
        mediaAlternativesPanelOpen.value = false;
        dismissGlossary();
        dismissTranslation();
        resetCatalogState();
        lastSupportActivationSignature = "";
        void refreshAnswerMaskChoiceRegions();
      },
    );

    watch(
      [
        rendererElement,
        () => currentItemPayload.value?.item.xml ?? "",
        () => buildRendererSignature(rendererConfiguration.value),
      ],
      ([element, itemXml]) => {
        if (!isRendererHostHandle(element)) return;
        if (typeof itemXml !== "string") return;
        if (!itemXml || !rendererConfiguration.value) return;
        if (element !== lastRendererElement) {
          lastRendererElement = element;
          lastRendererLoadSignature = "";
        }
        const loadSignature = `${itemXml}\n${buildRendererSignature(rendererConfiguration.value)}`;
        if (loadSignature === lastRendererLoadSignature) return;
        lastRendererLoadSignature = loadSignature;
        catalogSupportResolution.value = null;
        textToSpeechTraversal.value = null;
        element.loadItemFromXml(itemXml, rendererConfiguration.value);
      },
      { immediate: true },
    );

    watch(
      [
        rendererElement,
        catalogSupportFilters,
        catalogLanguages,
        itemReady,
        () => currentItemId.value,
      ],
      () => {
        refreshRendererSupportMetadata();
      },
    );

    onBeforeUnmount(() => {
      stopTextToSpeech("unmount", { record: false });
      clearItemNavigatorFeedback();
      if (rendererElement.value && rendererHost.value === rendererElement.value) {
        rendererHost.value = null;
      }
      rendererMountElement.value?.replaceChildren();
      rendererMountElement.value = null;
      rendererElement.value = null;
    });

    function bindRendererMount(element: HTMLDivElement | null): void {
      rendererMountElement.value = element;
      if (!element) {
        if (rendererElement.value && rendererHost.value === rendererElement.value) {
          rendererHost.value = null;
        }
        rendererElement.value = null;
        return;
      }

      let host = element.querySelector<QtiRendererHost>("harbor-qti-renderer-host");
      if (!host) {
        host = document.createElement("harbor-qti-renderer-host") as QtiRendererHost;
        element.replaceChildren(host);
      }

      bindRendererElement(host);
    }

    function bindRendererElement(host: QtiRendererHost | null): void {
      rendererElement.value = host;
      rendererHost.value = host;
      if (!host || boundRendererElements.has(host)) return;

      boundRendererElements.add(host);
      host.addEventListener("item-ready", () => {
        handleItemReady();
        queueMicrotask(() => refreshRendererSupportMetadata());
        void refreshAnswerMaskChoiceRegions();
      });
      host.addEventListener("renderer-interaction-observed", () => {
        handleRendererInteractionObserved();
      });
      host.addEventListener("score-attempt-completed", (event) => {
        void handleScoreAttemptCompleted(readCustomEventDetail(event));
      });
      host.addEventListener("snapshot-attempt-completed", (event) => {
        void handleSnapshotAttemptCompleted(readCustomEventDetail(event));
      });
      host.addEventListener("suspend-attempt-completed", (event) => {
        void handleSuspendAttemptCompleted(readCustomEventDetail(event));
      });
      host.addEventListener("end-attempt-completed", (event) => {
        void handleEndAttemptCompleted(readCustomEventDetail(event));
      });
    }

    function refreshRendererSupportMetadata(): void {
      const host = rendererElement.value;
      if (!isRendererHostHandle(host) || !itemReady.value) {
        catalogSupportResolution.value = null;
        textToSpeechTraversal.value = null;
        reconcileSupportPanelVisibility();
        return;
      }

      try {
        const supports = catalogSupportFilters.value;
        catalogSupportResolution.value = resolveSessionCatalogSupportResolution({
          supports,
          host,
          languages: catalogLanguages.value,
        });
        textToSpeechTraversal.value = host.getTextToSpeechTraversal() ?? null;
      } catch (error) {
        if (isRendererNotMountedError(error)) {
          catalogSupportResolution.value = null;
          textToSpeechTraversal.value = null;
          queueMicrotask(() => refreshRendererSupportMetadata());
          return;
        }
        throw error;
      }
      reconcileSupportPanelVisibility();
      applyInitialSupportActivation();
      recordSupportAvailabilityEvidence();
    }

    function supportActivation(support: HarborAfaPnpSupport): HarborAfaPnpSupportActivation {
      return pnpPolicy.value.activations[support];
    }

    function applyInitialSupportActivation(): void {
      const signature = [
        currentItemId.value ?? "",
        captionActivation.value,
        currentItemCaptionEntries.value.length,
        transcriptActivation.value,
        currentItemTranscriptEntries.value.length,
        audioDescriptionActivation.value,
        signLanguageActivation.value,
        currentItemMediaAlternativeEntries.value.length,
      ].join(":");
      if (signature === lastSupportActivationSignature) {
        return;
      }
      lastSupportActivationSignature = signature;

      if (captionActivation.value === "active" && currentItemCaptionEntries.value.length > 0) {
        captionsPanelOpen.value = true;
        void recordAccommodationSupportEvidence({
          support: "caption",
          state: "opened",
          activation: captionActivation.value,
          entries: currentItemCaptionEntries.value,
          reason: "activate-at-initialization",
          dedupe: true,
        });
      }
      if (
        transcriptActivation.value === "active" &&
        currentItemTranscriptEntries.value.length > 0
      ) {
        transcriptsPanelOpen.value = true;
        void recordAccommodationSupportEvidence({
          support: "transcript",
          state: "opened",
          activation: transcriptActivation.value,
          entries: currentItemTranscriptEntries.value,
          reason: "activate-at-initialization",
          dedupe: true,
        });
      }
      if (
        (audioDescriptionActivation.value === "active" ||
          signLanguageActivation.value === "active") &&
        currentItemMediaAlternativeEntries.value.length > 0
      ) {
        mediaAlternativesPanelOpen.value = true;
        recordMediaAlternativePanelEvidence("opened", {
          reason: "activate-at-initialization",
          dedupe: true,
        });
      }
    }

    function reconcileSupportPanelVisibility(): void {
      if (
        !isHarborAfaPnpSupportOffered(captionActivation.value) ||
        currentItemCaptionEntries.value.length === 0
      ) {
        captionsPanelOpen.value = false;
      }
      if (
        !isHarborAfaPnpSupportOffered(transcriptActivation.value) ||
        currentItemTranscriptEntries.value.length === 0
      ) {
        transcriptsPanelOpen.value = false;
      }
      if (
        (!isHarborAfaPnpSupportOffered(audioDescriptionActivation.value) &&
          !isHarborAfaPnpSupportOffered(signLanguageActivation.value)) ||
        currentItemMediaAlternativeEntries.value.length === 0
      ) {
        mediaAlternativesPanelOpen.value = false;
      }
    }

    function toggleCaptionsPanel(): void {
      captionsPanelOpen.value = !captionsPanelOpen.value;
      void recordAccommodationSupportEvidence({
        support: "caption",
        state: captionsPanelOpen.value ? "opened" : "closed",
        activation: captionActivation.value,
        entries: currentItemCaptionEntries.value,
        reason: "candidate-toggle",
        control: "caption-panel",
        dedupe: false,
      });
    }

    function toggleTranscriptsPanel(): void {
      transcriptsPanelOpen.value = !transcriptsPanelOpen.value;
      void recordAccommodationSupportEvidence({
        support: "transcript",
        state: transcriptsPanelOpen.value ? "opened" : "closed",
        activation: transcriptActivation.value,
        entries: currentItemTranscriptEntries.value,
        reason: "candidate-toggle",
        control: "transcript-panel",
        dedupe: false,
      });
    }

    function toggleMediaAlternativesPanel(): void {
      mediaAlternativesPanelOpen.value = !mediaAlternativesPanelOpen.value;
      recordMediaAlternativePanelEvidence(mediaAlternativesPanelOpen.value ? "opened" : "closed", {
        reason: "candidate-toggle",
        control: "media-alternatives-panel",
        dedupe: false,
      });
    }

    function bindMediaSupportPanel(element: HTMLElement | null): void {
      mediaSupportPanelElement.value = element;
    }

    async function refreshAnswerMaskChoiceRegions(): Promise<void> {
      await nextTick();
      answerMaskChoiceRegions.value = isRendererHostHandle(rendererHost.value)
        ? rendererHost.value.getAnswerMaskChoiceRegions()
        : [];
    }

    function revealAnswerMaskChoiceRegion(region: RendererAnswerMaskChoiceRegion): void {
      selectedAnswerMaskChoiceRegionIndex.value = region.index;
      maskRevealTop.value = Math.max(region.topPercent - 1, 0);
      maskRevealHeight.value = Math.min(region.heightPercent + 2, 100);
    }

    function persistShellToolState(): void {
      const attemptId = bootstrappedSession.value?.payload.attemptId;
      if (!attemptId) return;

      try {
        window.localStorage.setItem(
          buildShellToolStorageKey(attemptId),
          JSON.stringify({
            lineReaderTop: lineReaderTop.value,
            lineReaderHeight: lineReaderHeight.value,
            maskRevealTop: maskRevealTop.value,
            maskRevealHeight: maskRevealHeight.value,
          }),
        );
      } catch {
        // Local persistence is a convenience; delivery must continue if storage is blocked.
      }
    }

    function restoreShellToolState(attemptId: string): void {
      if (!attemptId) return;

      try {
        const stored = window.localStorage.getItem(buildShellToolStorageKey(attemptId));
        if (!stored) return;
        const parsed = JSON.parse(stored) as Partial<Record<string, unknown>>;
        lineReaderTop.value = readStoredNumber(parsed.lineReaderTop, 45);
        lineReaderHeight.value = readStoredNumber(parsed.lineReaderHeight, 3);
        maskRevealTop.value = readStoredNumber(parsed.maskRevealTop, 42);
        maskRevealHeight.value = readStoredNumber(parsed.maskRevealHeight, 18);
      } catch {
        // Ignore corrupt or unavailable local persistence.
      }
    }

    return {
      currentItemOrdinal,
      currentItemPointLabel,
      currentItemTimeDependent,
      focusedItemStepId,
      handleItemStepActivation,
      handleItemStepKeydown,
      itemNavigationEntries,
      itemNavigatorFeedback,
      progressPercent,
      rendererShell: buildSessionRendererShellProps({
        assessmentInstructions: computed(() => {
          const manifest = runtimeManifest.value;
          return manifest
            ? assessmentInstructionsForItem(
                manifest.assessmentInstructions,
                currentItemId.value,
                manifest.itemOrder,
              )
            : [];
        }),
        bindMediaSupportPanel,
        bindRendererMount,
        catalogDialogs: { glossary, keywordTranslation },
        calculatorLeft,
        calculatorOperator,
        calculatorResult,
        calculatorRight,
        captionsPanelOpen,
        answerMaskChoiceRegions,
        currentItemCaptionEntries,
        currentItemMediaAlternativeEntries,
        currentItemMediaAssets,
        currentItemTranscriptEntries,
        lineReaderActive,
        lineReaderHeight,
        lineReaderStyle,
        lineReaderTop,
        maskActive,
        maskOverlayStyle,
        maskRevealHeight,
        maskRevealStyle,
        maskRevealTop,
        mediaAlternativesPanelOpen,
        notepadText,
        pauseTextToSpeech,
        resumeTextToSpeech,
        revealAnswerMaskChoiceRegion,
        selectedAnswerMaskChoiceRegionIndex,
        shellToolsVisible,
        showAnswerMaskingTool,
        showCalculatorTool,
        showCaptionTool,
        showLineReaderTool,
        showMediaAlternativesTool,
        showNotepadTool,
        showTextToSpeechTool,
        showTranscriptTool,
        startTextToSpeech,
        stopTextToSpeech,
        toggleCaptionsPanel,
        toggleMediaAlternativesPanel,
        toggleTranscriptsPanel,
        transcriptsPanelOpen,
        ttsCurrentSegmentText,
        ttsPlaybackState,
        ttsPlaybackStatusLabel,
      }),
      rovingItemStepId,
      sessionNotice,
      setItemStepRef,
      showRetrySync,
      showStatePill,
      showSyncStatusPill,
      studentStateLabel,
      stopTextToSpeech,
      syncStatusLabel,
      syncStatusTone,
      timerAriaLabel,
      timerAssertiveAnnouncement,
      timerIsBounded,
      timerLabel,
      timerPoliteAnnouncement,
    };
  });
}

function buildShellToolStorageKey(attemptId: string): string {
  return `harbor.shellTools.${attemptId}`;
}

function readStoredNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRendererHostHandle(value: unknown): value is QtiRendererHost {
  return Boolean(
    value &&
    typeof value === "object" &&
    "loadItemFromXml" in value &&
    typeof (value as QtiRendererHost).loadItemFromXml === "function" &&
    "updateBuiltIns" in value &&
    typeof (value as QtiRendererHost).updateBuiltIns === "function" &&
    "getAnswerMaskChoiceRegions" in value &&
    typeof (value as QtiRendererHost).getAnswerMaskChoiceRegions === "function" &&
    "getCatalogSupportResolution" in value &&
    typeof (value as QtiRendererHost).getCatalogSupportResolution === "function" &&
    "getCatalogDeliveryResolution" in value &&
    typeof (value as QtiRendererHost).getCatalogDeliveryResolution === "function" &&
    "getTextToSpeechTraversal" in value &&
    typeof (value as QtiRendererHost).getTextToSpeechTraversal === "function",
  );
}

function isRendererNotMountedError(error: unknown): boolean {
  return error instanceof Error && error.message === "QTI assessment item player is not mounted.";
}

function buildRendererSignature(value: unknown): string {
  if (!value) return "";
  try {
    if (typeof value === "object" && !Array.isArray(value)) {
      const { builtIns: _builtIns, ...stableConfiguration } = value as Record<string, unknown>;
      return JSON.stringify(stableConfiguration);
    }
    return JSON.stringify(value);
  } catch {
    return String(Date.now());
  }
}

function readCustomEventDetail(event: Event): unknown {
  return event instanceof CustomEvent ? event.detail : undefined;
}
