import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";

export default function HarborDetailsPage(props: { navigateTo: (page: HarborPage) => void }) {
  const {
    bootstrappedSession,
    currentClientSessionId,
    deliveryBusy,
    deliveryTiming,
    itemReady,
    launchActorLabel,
    policyOverlayStatusLabel,
    policyRefreshStatus,
    refreshAttemptPolicy,
    remainingTimeLabel,
    rendererAccommodationStatusLabel,
  } = useHarborRuntime();

  if (!bootstrappedSession.value) {
    return (
      <section class="empty-state">
        <h1>No session yet</h1>
        <button class="primary-action" type="button" onClick={() => props.navigateTo("launch")}>
          Launch
        </button>
      </section>
    );
  }

  const session = bootstrappedSession.value;
  return (
    <section class="details-page">
      <section class="details-intro">
        <h1>Timing & rules</h1>
      </section>

      <section class="details-grid">
        <article class="detail-card detail-card--highlight span-two">
          <div class="card-header">
            <div>
              <h2>Current rules</h2>
              <p class="card-copy" data-testid="policy-overlay-status">
                {policyOverlayStatusLabel.value}
              </p>
            </div>
            <button
              class="primary-action"
              type="button"
              disabled={deliveryBusy.value}
              data-testid="refresh-policy-button"
              onClick={() => void refreshAttemptPolicy()}
            >
              Refresh
            </button>
          </div>
          <div class="detail-summary">
            <span class="summary-pill">
              {formatNavigationMode(session.payload.deliveryPolicy.navigationMode)}
            </span>
            <span class="summary-pill">
              {formatAttemptCount(session.payload.deliveryPolicy.maxAttempts)}
            </span>
            <span class="summary-pill">
              {formatTimeLimit(session.payload.deliveryPolicy.timeLimitSeconds)}
            </span>
          </div>
          <p class="card-copy" data-testid="renderer-accommodation-status">
            {rendererAccommodationStatusLabel.value}
          </p>
          <p class="detail-note-inline">{policyRefreshStatus.value}</p>
        </article>

        <article class="detail-card">
          <h2>Time</h2>
          <p class="detail-copy">
            <span data-testid="remaining-time-seconds">{remainingTimeLabel.value}</span> remaining
          </p>
          <div class="detail-note">
            <span class="detail-note-label">Soft close</span>
            <span data-testid="soft-close-at">{deliveryTiming.value.softCloseAt ?? "none"}</span>
          </div>
          <div class="detail-note">
            <span class="detail-note-label">Accept until</span>
            <span data-testid="accept-until">{deliveryTiming.value.acceptUntil ?? "none"}</span>
          </div>
        </article>

        <article class="detail-card">
          <h2>Session</h2>
          <p class="detail-copy">{launchActorLabel.value}</p>
          <p class="detail-note-inline">
            {itemReady.value ? "Question ready" : "Preparing question"}
          </p>
          <details class="technical-disclosure">
            <summary>Technical details</summary>
            <div class="detail-note">
              <span class="detail-note-label">Client session</span>
              <span data-testid="client-session-id" class="mono">
                {currentClientSessionId.value || "not bound"}
              </span>
            </div>
            <div class="detail-note">
              <span class="detail-note-label">Manifest key</span>
              <span class="mono">{session.payload.manifest.manifestObjectKey}</span>
            </div>
          </details>
        </article>
      </section>
    </section>
  );
}

function formatAttemptCount(value: number): string {
  return value === 1 ? "1 attempt" : `${value} attempts`;
}

function formatNavigationMode(value: "linear" | "free"): string {
  return value === "linear" ? "Linear navigation" : "Free navigation";
}

function formatTimeLimit(value: number | null): string {
  if (value === null) return "No time limit";
  if (value % 60 === 0) {
    const minutes = value / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${value} seconds`;
}
