import type { RendererTextToSpeechTraversal } from "@harbor/renderer-adapter";

export type ItemNavigationState = "current" | "earlier" | "upcoming";
export type ItemNavigationUnavailableReason =
  | ""
  | "attempt-locked"
  | "delivery-busy"
  | "item-validation"
  | "linear-earlier"
  | "linear-upcoming"
  | "not-ready";

export interface ItemNavigationEntry {
  itemId: string;
  label: string;
  title: string;
  state: ItemNavigationState;
  canNavigate: boolean;
  unavailableReason: ItemNavigationUnavailableReason;
  ariaLabel: string;
  titleLabel: string;
}

export interface ItemNavigatorFeedback {
  itemId: string;
  title: string;
  body: string;
  tone: "locked" | "paused";
}

export interface TtsPlaybackSegment {
  ordinal: number;
  sourceIndex: number;
  kind: string;
  text: string;
  ssmlApplied: boolean;
}

export function isTextToSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window
  );
}

export function buildTextToSpeechSegments(
  traversal: RendererTextToSpeechTraversal | null,
): TtsPlaybackSegment[] {
  if (!traversal) {
    return [];
  }

  return traversal.segments
    .filter((segment) => !segment.suppressTts || segment.suppressTts.length === 0)
    .map((segment, index) => ({
      ordinal: index + 1,
      sourceIndex: segment.index,
      kind: segment.kind,
      text: (segment.ssml?.sub?.alias ?? segment.text).trim(),
      ssmlApplied: Boolean(segment.ssml?.sub?.alias),
    }))
    .filter((segment) => segment.text.length > 0);
}

export function buildFallbackTextToSpeechSegments(text: string): TtsPlaybackSegment[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  return [
    {
      ordinal: 1,
      sourceIndex: 0,
      kind: "fallback",
      text: trimmed,
      ssmlApplied: false,
    },
  ];
}

export function readNavigatorLanguages(): string[] {
  return typeof navigator !== "undefined"
    ? uniqueStringList([...navigator.languages, navigator.language])
    : [];
}

export function uniqueStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function buildItemStepAriaLabel(input: {
  label: string;
  title: string;
  state: ItemNavigationState;
  unavailableReason: ItemNavigationUnavailableReason;
}): string {
  return [
    `Question ${input.label}`,
    input.title,
    readItemNavigationStateLabel(input.state),
    readItemNavigationUnavailableLabel(input.unavailableReason),
  ]
    .filter((part) => part.length > 0)
    .join(", ");
}

export function buildItemStepTitleLabel(input: {
  label: string;
  title: string;
  state: ItemNavigationState;
  unavailableReason: ItemNavigationUnavailableReason;
}): string {
  const unavailableLabel = readItemNavigationUnavailableLabel(input.unavailableReason);
  return [
    `Question ${input.label}: ${input.title}`,
    readItemNavigationStateLabel(input.state),
    unavailableLabel,
  ]
    .filter((part) => part.length > 0)
    .join(". ");
}

export function buildItemNavigatorFeedback(entry: ItemNavigationEntry): ItemNavigatorFeedback {
  switch (entry.unavailableReason) {
    case "attempt-locked":
      return {
        itemId: entry.itemId,
        title: "Navigation locked",
        body: "This attempt is read-only, so question navigation is locked.",
        tone: "locked",
      };
    case "delivery-busy":
      return {
        itemId: entry.itemId,
        title: "Navigation paused",
        body: "QFlowLearn Delivery is saving the current response before another question can load.",
        tone: "paused",
      };
    case "item-validation":
      return {
        itemId: entry.itemId,
        title: "Answer required",
        body: "Answer this question before moving to another question.",
        tone: "locked",
      };
    case "linear-earlier":
      return {
        itemId: entry.itemId,
        title: "Review locked",
        body: "Linear delivery is active. Previous questions are locked for this attempt.",
        tone: "locked",
      };
    case "linear-upcoming":
      return {
        itemId: entry.itemId,
        title: "Question locked",
        body: "Linear delivery is active. Use Next to move to the next question in order.",
        tone: "locked",
      };
    case "not-ready":
      return {
        itemId: entry.itemId,
        title: "Navigation not ready",
        body: "Question navigation will be available after this attempt finishes loading.",
        tone: "paused",
      };
    default:
      return {
        itemId: entry.itemId,
        title: "Question unavailable",
        body: "This question is not available from the question navigator right now.",
        tone: "paused",
      };
  }
}

export function formatTimer(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatTimerDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  if (remainder > 0 || parts.length === 0) {
    parts.push(`${remainder} second${remainder === 1 ? "" : "s"}`);
  }

  return parts.join(", ");
}

export function readTimerMilestoneAnnouncement(
  seconds: number,
  previousSeconds: number,
  attemptStatus: string,
): { message: string; urgency: "polite" | "assertive" } | null {
  if (seconds <= 0 && previousSeconds > 0) {
    if (attemptStatus === "submitted") {
      return null;
    }
    return {
      message: "Time expired. QFlowLearn Delivery is submitting the assessment.",
      urgency: "assertive",
    };
  }

  if (seconds <= 60 && previousSeconds > 60) {
    return {
      message: "One minute remaining.",
      urgency: "polite",
    };
  }

  if (seconds <= 300 && previousSeconds > 300) {
    return {
      message: "Five minutes remaining.",
      urgency: "polite",
    };
  }

  return null;
}

function readItemNavigationStateLabel(state: ItemNavigationState): string {
  switch (state) {
    case "current":
      return "current question";
    case "earlier":
      return "previous question";
    case "upcoming":
      return "upcoming question";
  }
}

function readItemNavigationUnavailableLabel(reason: ItemNavigationUnavailableReason): string {
  switch (reason) {
    case "attempt-locked":
      return "navigation locked";
    case "delivery-busy":
      return "navigation paused while saving";
    case "item-validation":
      return "answer current question first";
    case "linear-earlier":
      return "locked by linear delivery";
    case "linear-upcoming":
      return "locked by linear delivery";
    case "not-ready":
      return "navigation not ready";
    default:
      return "";
  }
}
