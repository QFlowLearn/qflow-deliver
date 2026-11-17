import type { Signal } from "@preact/signals";
import { computed, nextTick, ref, watch } from "@/lib/preact-reactivity";
import {
  formatTimer,
  formatTimerDuration,
  readTimerMilestoneAnnouncement,
} from "./session-page-helpers";

export function useSessionTimerAnnouncements(input: {
  attemptId: Signal<string>;
  deliveryState: Signal<string>;
  remainingTimeSeconds: Signal<number | null>;
}) {
  const timerLabel = computed(() => {
    const seconds = input.remainingTimeSeconds.value;
    return seconds === null ? "Untimed" : formatTimer(seconds);
  });

  const timerAriaLabel = computed(() => {
    const seconds = input.remainingTimeSeconds.value;
    return seconds === null
      ? "Attempt is not timed"
      : `Time remaining ${formatTimerDuration(seconds)}`;
  });

  const timerIsBounded = computed(() => input.remainingTimeSeconds.value !== null);
  const timerPoliteAnnouncement = ref("");
  const timerAssertiveAnnouncement = ref("");
  let timerAnnouncementSequence = 0;

  async function announceTimerMilestone(
    message: string,
    urgency: "polite" | "assertive",
  ): Promise<void> {
    const sequence = ++timerAnnouncementSequence;
    const target = urgency === "assertive" ? timerAssertiveAnnouncement : timerPoliteAnnouncement;
    target.value = "";
    await nextTick();
    if (sequence === timerAnnouncementSequence) {
      target.value = message;
    }
  }

  watch(
    () => input.attemptId.value,
    () => {
      timerAnnouncementSequence += 1;
      timerPoliteAnnouncement.value = "";
      timerAssertiveAnnouncement.value = "";
    },
    { immediate: true },
  );

  watch(
    [() => input.remainingTimeSeconds.value, () => input.deliveryState.value],
    ([seconds, attemptStatus], previous) => {
      const previousSeconds = Array.isArray(previous) ? previous[0] : null;
      if (
        typeof seconds !== "number" ||
        typeof previousSeconds !== "number" ||
        typeof attemptStatus !== "string"
      ) {
        return;
      }

      const announcement = readTimerMilestoneAnnouncement(seconds, previousSeconds, attemptStatus);
      if (!announcement) {
        return;
      }

      void announceTimerMilestone(announcement.message, announcement.urgency);
    },
  );

  return {
    timerAriaLabel,
    timerAssertiveAnnouncement,
    timerIsBounded,
    timerLabel,
    timerPoliteAnnouncement,
  };
}
