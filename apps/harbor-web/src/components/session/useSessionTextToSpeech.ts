import { reportUiError } from "@/lib/ui-errors";
import type { Signal } from "@preact/signals";
import type { QtiRendererHost, RendererTextToSpeechTraversal } from "@harbor/renderer-adapter";
import type {
  HarborAfaPnpSupportActivation,
  HarborCatalogSupportEntry,
} from "@harbor/attempt-protocol";
import { computed, ref } from "@/lib/preact-reactivity";
import {
  buildFallbackTextToSpeechSegments,
  buildTextToSpeechSegments,
  isTextToSpeechSupported,
  type TtsPlaybackSegment,
} from "./session-page-helpers";

type TtsPlaybackState = "idle" | "playing" | "paused" | "unsupported";

export function useSessionTextToSpeech(input: {
  activation: Signal<HarborAfaPnpSupportActivation>;
  traversal: Signal<RendererTextToSpeechTraversal | null>;
  rendererHost: Signal<unknown>;
  catalogLanguages: Signal<string[]>;
  currentItemTitle: Signal<string>;
  currentItemPositionLabel: Signal<string>;
  recordEvidence: (input: {
    support: "spoken";
    state: "activated" | "paused" | "resumed" | "stopped" | "finished" | "unavailable";
    activation?: HarborAfaPnpSupportActivation;
    entries?: HarborCatalogSupportEntry[];
    reason?: string;
    control?: string;
    dedupe?: boolean;
    details?: Record<string, unknown>;
  }) => Promise<void>;
}) {
  const playbackState = ref<TtsPlaybackState>("idle");
  const currentSegmentOrdinal = ref(0);
  const segmentCount = ref(0);
  const currentSegmentText = ref("");
  let activeSegments: TtsPlaybackSegment[] = [];
  let activeSegmentPosition = 0;
  let playbackGeneration = 0;

  const playbackStatusLabel = computed(() => {
    if (playbackState.value === "unsupported") {
      return "Speech unavailable";
    }
    if (
      (playbackState.value === "playing" || playbackState.value === "paused") &&
      segmentCount.value > 0
    ) {
      const stateLabel = playbackState.value === "paused" ? "Paused" : "Reading";
      return `${stateLabel} ${currentSegmentOrdinal.value} of ${segmentCount.value}`;
    }
    return "";
  });

  function start(): void {
    if (!isTextToSpeechSupported()) {
      playbackState.value = "unsupported";
      input
        .recordEvidence({
          support: "spoken",
          state: "unavailable",
          activation: input.activation.value,
          reason: "speech-synthesis-unavailable",
          dedupe: true,
        })
        .catch(reportUiError);
      return;
    }

    window.speechSynthesis.cancel();
    const rendererText = isRendererHostHandle(input.rendererHost.value)
      ? input.rendererHost.value.getRenderedText().trim()
      : "";
    activeSegments = buildTextToSpeechSegments(input.traversal.value);
    if (activeSegments.length === 0) {
      activeSegments = buildFallbackTextToSpeechSegments(
        rendererText ||
          [input.currentItemTitle.value, input.currentItemPositionLabel.value]
            .filter(Boolean)
            .join(". ") ||
          "Current item",
      );
    }

    if (activeSegments.length === 0) {
      playbackState.value = "unsupported";
      input
        .recordEvidence({
          support: "spoken",
          state: "unavailable",
          activation: input.activation.value,
          reason: "no-readable-segments",
          dedupe: true,
        })
        .catch(reportUiError);
      return;
    }

    playbackGeneration += 1;
    activeSegmentPosition = 0;
    segmentCount.value = activeSegments.length;
    currentSegmentOrdinal.value = 1;
    currentSegmentText.value = activeSegments[0]?.text ?? "";
    playbackState.value = "playing";
    input
      .recordEvidence({
        support: "spoken",
        state: "activated",
        activation: input.activation.value,
        reason: "candidate-started",
        control: "start",
        dedupe: false,
        details: {
          segmentCount: activeSegments.length,
          ssmlSubstitutionsApplied: activeSegments.some((segment) => segment.ssmlApplied),
        },
      })
      .catch(reportUiError);
    speakSegment(playbackGeneration);
  }

  function pause(): void {
    if (playbackState.value !== "playing" || !isTextToSpeechSupported()) {
      return;
    }

    window.speechSynthesis.pause();
    playbackState.value = "paused";
    input
      .recordEvidence({
        support: "spoken",
        state: "paused",
        activation: input.activation.value,
        reason: "candidate-paused",
        control: "pause",
        dedupe: false,
        details: {
          segmentOrdinal: currentSegmentOrdinal.value,
          segmentCount: segmentCount.value,
        },
      })
      .catch(reportUiError);
  }

  function resume(): void {
    if (playbackState.value !== "paused" || !isTextToSpeechSupported()) {
      return;
    }

    window.speechSynthesis.resume();
    playbackState.value = "playing";
    input
      .recordEvidence({
        support: "spoken",
        state: "resumed",
        activation: input.activation.value,
        reason: "candidate-resumed",
        control: "resume",
        dedupe: false,
        details: {
          segmentOrdinal: currentSegmentOrdinal.value,
          segmentCount: segmentCount.value,
        },
      })
      .catch(reportUiError);
  }

  function stop(reason = "candidate-stopped", options: { record?: boolean } = {}): void {
    const wasActive =
      playbackState.value === "playing" ||
      playbackState.value === "paused" ||
      activeSegments.length > 0;
    if (!wasActive && playbackState.value !== "unsupported") {
      return;
    }

    playbackGeneration += 1;
    if (isTextToSpeechSupported()) {
      window.speechSynthesis.cancel();
    }
    resetPlayback();
    if (wasActive && options.record !== false) {
      input
        .recordEvidence({
          support: "spoken",
          state: "stopped",
          activation: input.activation.value,
          reason,
          control: "stop",
          dedupe: false,
        })
        .catch(reportUiError);
    }
  }

  function speakSegment(generation: number): void {
    if (generation !== playbackGeneration || !isTextToSpeechSupported()) {
      return;
    }

    const segment = activeSegments[activeSegmentPosition];
    if (!segment) {
      finish(generation);
      return;
    }

    currentSegmentOrdinal.value = activeSegmentPosition + 1;
    currentSegmentText.value = segment.text;
    const utterance = new SpeechSynthesisUtterance(segment.text);
    const language = input.traversal.value?.language ?? input.catalogLanguages.value[0];
    if (language) {
      utterance.lang = language;
    }
    utterance.onend = () => {
      if (generation !== playbackGeneration) {
        return;
      }
      activeSegmentPosition += 1;
      if (activeSegmentPosition >= activeSegments.length) {
        finish(generation);
        return;
      }
      speakSegment(generation);
    };
    utterance.onerror = () => {
      if (generation !== playbackGeneration) {
        return;
      }
      stop("speech-synthesis-error");
    };

    window.speechSynthesis.speak(utterance);
  }

  function finish(generation: number): void {
    if (generation !== playbackGeneration) {
      return;
    }

    resetPlayback();
    input
      .recordEvidence({
        support: "spoken",
        state: "finished",
        activation: input.activation.value,
        reason: "segment-playback-ended",
        dedupe: false,
      })
      .catch(reportUiError);
  }

  function resetPlayback(): void {
    activeSegments = [];
    activeSegmentPosition = 0;
    playbackState.value = "idle";
    currentSegmentOrdinal.value = 0;
    segmentCount.value = 0;
    currentSegmentText.value = "";
  }

  return {
    currentSegmentText,
    pause,
    playbackState,
    playbackStatusLabel,
    resume,
    start,
    stop,
  };
}

function isRendererHostHandle(value: unknown): value is QtiRendererHost {
  return Boolean(
    value &&
    typeof value === "object" &&
    "getRenderedText" in value &&
    typeof (value as QtiRendererHost).getRenderedText === "function",
  );
}
