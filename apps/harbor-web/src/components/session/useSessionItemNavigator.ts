import type { Signal } from "@preact/signals";
import { computed, nextTick, ref } from "@/lib/preact-reactivity";
import type { RuntimeManifestSummary } from "@/lib/runtime-session";
import {
  buildItemNavigatorFeedback,
  buildItemStepAriaLabel,
  buildItemStepTitleLabel,
  type ItemNavigationEntry,
  type ItemNavigationState,
  type ItemNavigationUnavailableReason,
  type ItemNavigatorFeedback,
} from "./session-page-helpers";

export function useSessionItemNavigator(input: {
  runtimeManifest: Signal<RuntimeManifestSummary | null>;
  currentItemId: Signal<string | null>;
  currentItemOrdinal: Signal<number>;
  attemptEditingLocked: Signal<boolean>;
  deliveryBusy: Signal<boolean>;
  attemptClientReady: Signal<boolean>;
  currentItemBlocksNavigation: Signal<boolean>;
  navigationMode: Signal<"linear" | "free">;
  replayStatus: Signal<string>;
  navigateToItem: (itemId: string) => Promise<void>;
  stopTextToSpeech: (reason?: string) => void;
}) {
  const focusedItemStepId = ref("");
  const itemNavigatorFeedback = ref<ItemNavigatorFeedback | null>(null);
  const itemStepRefs = new Map<string, HTMLButtonElement>();
  let itemNavigatorFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  const itemNavigationEntries = computed<ItemNavigationEntry[]>(() => {
    if (!input.runtimeManifest.value) return [];

    return input.runtimeManifest.value.itemOrder.map((itemId, index) => {
      const isCurrent = itemId === input.currentItemId.value;
      const state: ItemNavigationState = isCurrent
        ? "current"
        : index + 1 < input.currentItemOrdinal.value
          ? "earlier"
          : "upcoming";
      const unavailableReason = readItemNavigationUnavailableReason({
        isCurrent,
        index,
      });
      const canNavigate = !isCurrent && unavailableReason === "";
      const title = input.runtimeManifest.value?.items[itemId]?.title ?? `Item ${index + 1}`;

      return {
        itemId,
        label: `${index + 1}`,
        title,
        state,
        canNavigate,
        unavailableReason,
        ariaLabel: buildItemStepAriaLabel({
          label: `${index + 1}`,
          title,
          state,
          unavailableReason,
        }),
        titleLabel: buildItemStepTitleLabel({
          label: `${index + 1}`,
          title,
          state,
          unavailableReason,
        }),
      };
    });
  });

  const rovingItemStepId = computed(() => {
    if (
      focusedItemStepId.value &&
      itemNavigationEntries.value.some((entry) => entry.itemId === focusedItemStepId.value)
    ) {
      return focusedItemStepId.value;
    }

    if (
      input.currentItemId.value &&
      itemNavigationEntries.value.some((entry) => entry.itemId === input.currentItemId.value)
    ) {
      return input.currentItemId.value;
    }

    return itemNavigationEntries.value[0]?.itemId ?? "";
  });

  function readItemNavigationUnavailableReason(inputState: {
    isCurrent: boolean;
    index: number;
  }): ItemNavigationUnavailableReason {
    if (inputState.isCurrent) return "";
    if (input.attemptEditingLocked.value) return "attempt-locked";
    if (input.deliveryBusy.value) return "delivery-busy";
    if (!input.attemptClientReady.value) return "not-ready";
    if (input.currentItemBlocksNavigation.value) return "item-validation";
    if (input.navigationMode.value === "linear") {
      return inputState.index + 1 < input.currentItemOrdinal.value
        ? "linear-earlier"
        : "linear-upcoming";
    }
    return "";
  }

  function handleItemStepActivation(entry: ItemNavigationEntry): void {
    focusedItemStepId.value = entry.itemId;

    if (entry.state === "current") {
      clearItemNavigatorFeedback();
      return;
    }

    if (entry.canNavigate) {
      clearItemNavigatorFeedback();
      input.stopTextToSpeech("item-navigation");
      void input.navigateToItem(entry.itemId);
      return;
    }

    showItemNavigatorFeedback(entry);
  }

  function handleItemStepKeydown(event: KeyboardEvent, entry: ItemNavigationEntry): void {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        void moveItemStepFocus(entry.itemId, 1);
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        void moveItemStepFocus(entry.itemId, -1);
        return;
      case "Home":
        event.preventDefault();
        void focusItemStep(itemNavigationEntries.value[0]?.itemId ?? entry.itemId);
        return;
      case "End":
        event.preventDefault();
        void focusItemStep(
          itemNavigationEntries.value[itemNavigationEntries.value.length - 1]?.itemId ??
            entry.itemId,
        );
        return;
      default:
    }
  }

  async function moveItemStepFocus(currentStepId: string, direction: -1 | 1): Promise<void> {
    const currentIndex = itemNavigationEntries.value.findIndex(
      (entry) => entry.itemId === currentStepId,
    );
    if (currentIndex < 0) return;

    const nextIndex = Math.min(
      Math.max(currentIndex + direction, 0),
      itemNavigationEntries.value.length - 1,
    );
    const nextStepId = itemNavigationEntries.value[nextIndex]?.itemId;
    if (!nextStepId || nextStepId === currentStepId) return;

    await focusItemStep(nextStepId);
  }

  async function focusItemStep(itemId: string): Promise<void> {
    focusedItemStepId.value = itemId;
    await nextTick();

    const step = itemStepRefs.get(itemId);
    step?.focus({ preventScroll: true });
    step?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function setItemStepRef(itemId: string, element: HTMLButtonElement | null): void {
    if (element) {
      itemStepRefs.set(itemId, element);
      return;
    }
    itemStepRefs.delete(itemId);
  }

  function showItemNavigatorFeedback(entry: ItemNavigationEntry): void {
    const feedback = buildItemNavigatorFeedback(entry);
    clearItemNavigatorFeedback();
    itemNavigatorFeedback.value = feedback;
    input.replayStatus.value = feedback.body;
    itemNavigatorFeedbackTimer = setTimeout(() => {
      itemNavigatorFeedback.value = null;
      itemNavigatorFeedbackTimer = null;
    }, 5200);
  }

  function clearItemNavigatorFeedback(): void {
    if (itemNavigatorFeedbackTimer !== null) {
      clearTimeout(itemNavigatorFeedbackTimer);
      itemNavigatorFeedbackTimer = null;
    }
    itemNavigatorFeedback.value = null;
  }

  return {
    clearItemNavigatorFeedback,
    focusedItemStepId,
    handleItemStepActivation,
    handleItemStepKeydown,
    itemNavigationEntries,
    itemNavigatorFeedback,
    rovingItemStepId,
    setItemStepRef,
  };
}
