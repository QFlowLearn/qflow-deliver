import { reportUiError } from "@/lib/ui-errors";
import { defineQtiRendererHost, resolveRendererColorTheme } from "@harbor/renderer-adapter";
import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import { SessionRendererShell } from "@/components/session/SessionRendererShell";
import { useHarborSessionPageState } from "@/components/session/useHarborSessionPageState";

export default function HarborSessionPage(props: { navigateTo: (page: HarborPage) => void }) {
  defineQtiRendererHost();

  const runtime = useHarborRuntime();
  const {
    errorMessage,
    attemptClient,
    attemptEditingLocked,
    bootstrappedSession,
    canNavigateBackward,
    canNavigateForward,
    currentItemId,
    currentItemPayload,
    currentItemPositionLabel,
    currentItemTitle,
    deliveryBusy,
    deliveryState,
    highestCommittedSequence,
    itemReady,
    latestSubmittedScoreLabel,
    navigateItem,
    nextSequenceNumber,
    pendingReplayCount,
    queueDraftResponse,
    rendererConfiguration,
    lastConfirmedSaveAt,
    responseSaveStatus,
    replayStatus,
    retryPendingWork,
    runtimeManifest,
    sessionTitle,
    submitAttempt,
    submitStatusLabel,
    submissionState,
  } = runtime;

  const state = useHarborSessionPageState(runtime);
  const showDebugPanel = shouldShowSessionDebugPanel();

  if (!bootstrappedSession.value) {
    return (
      <section class="empty-state">
        <h1>No session</h1>
        <button class="primary-action" type="button" onClick={() => props.navigateTo("launch")}>
          Launch
        </button>
      </section>
    );
  }

  return (
    <section
      class={`session-page ${
        rendererConfiguration.value
          ? resolveRendererColorTheme(rendererConfiguration.value)
          : "qti3-player-color-default"
      }`}
    >
      {errorMessage.value && (
        <section role="alert" class="assessment-empty assessment-empty--error">
          <p>{errorMessage.value}</p>
        </section>
      )}
      <div class="session-instrumentation" hidden aria-hidden="true">
        <span data-testid="attempt-id">{bootstrappedSession.value.payload.attemptId}</span>
        <span data-testid="assessment-version-id">
          {bootstrappedSession.value.payload.assessmentVersionId}
        </span>
        <span data-testid="current-item-id">{currentItemId.value ?? "pending"}</span>
        <span data-testid="delivery-state">{deliveryState.value}</span>
        <span data-testid="highest-committed-sequence">{highestCommittedSequence.value}</span>
        <span data-testid="next-sequence-number">{nextSequenceNumber.value}</span>
        <span data-testid="pending-event-count">{pendingReplayCount.value}</span>
        <span data-testid="submitted-score-label">{latestSubmittedScoreLabel.value}</span>
        <span data-testid="response-save-status">{responseSaveStatus.value}</span>
        <span data-testid="last-confirmed-save">{lastConfirmedSaveAt.value ?? ""}</span>
        <span data-testid="replay-status">{replayStatus.value}</span>
        <span data-testid="submit-status">{submitStatusLabel.value}</span>
        <span data-testid="submission-state">{submissionState.value.status}</span>
        <span data-testid="submission-receipt">
          {submissionState.value.status === "confirmed" ? submissionState.value.receiptId : ""}
        </span>
      </div>
      <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {state.timerPoliteAnnouncement.value}
      </div>
      <div class="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">
        {state.timerAssertiveAnnouncement.value}
      </div>

      <header class="assessment-topbar">
        <div class="assessment-topbar__main">
          <div class="assessment-brand">
            <strong class="qflow-wordmark">
              <span>QFlow</span>
              <span>Learn</span>
            </strong>
            <span>{sessionTitle.value}</span>
          </div>

          {(state.showStatePill.value ||
            state.timerIsBounded.value ||
            state.showSyncStatusPill.value) && (
            <div class="assessment-status-cluster">
              {state.showStatePill.value && (
                <span class="status-pill status-pill--state">{state.studentStateLabel.value}</span>
              )}
              {state.timerIsBounded.value && (
                <span
                  class="status-pill status-pill--timer"
                  data-bounded={state.timerIsBounded.value}
                  role="timer"
                  aria-live="off"
                  aria-label={state.timerAriaLabel.value}
                >
                  {state.timerLabel.value}
                </span>
              )}
              {state.showSyncStatusPill.value && (
                <span
                  class="status-pill status-pill--sync"
                  data-tone={state.syncStatusTone.value}
                  data-testid="student-sync-status"
                >
                  {state.syncStatusLabel.value}
                </span>
              )}
            </div>
          )}

          <div class="assessment-topbar__actions">
            <button
              class="text-action session-utility-action"
              type="button"
              data-testid="session-home-button"
              onClick={() => props.navigateTo("home")}
            >
              Home
            </button>
            <button
              class="text-action session-utility-action"
              type="button"
              data-testid="nav-link-details"
              onClick={() => props.navigateTo("details")}
            >
              Timing & rules
            </button>
            <button
              class="secondary-action finish-action"
              type="button"
              disabled={deliveryBusy.value || attemptEditingLocked.value || !attemptClient.value}
              data-testid="submit-attempt-button"
              onClick={() => void submitAttempt()}
            >
              Finish assessment
            </button>
          </div>
        </div>
        <div
          class="assessment-progress-bar"
          role="progressbar"
          aria-valuenow={state.currentItemOrdinal.value}
          aria-valuemin={0}
          aria-valuemax={
            runtimeManifest.value?.testSequence?.target ??
            runtimeManifest.value?.itemOrder.length ??
            0
          }
          aria-label={currentItemPositionLabel.value}
        >
          <span style={{ width: state.progressPercent.value }} />
        </div>
      </header>

      <main class="assessment-workspace">
        <section class="assessment-item-panel">
          <section class="item-context">
            <h1 data-testid="current-item-position">{currentItemPositionLabel.value}</h1>
            <div class="item-meta-row">
              {state.currentItemPointLabel.value && (
                <span>{state.currentItemPointLabel.value}</span>
              )}
              {state.currentItemTimeDependent.value && (
                <span data-testid="time-dependent-item-cue">Timed scoring</span>
              )}
            </div>
          </section>

          {state.sessionNotice.value && (
            <section
              class="session-notice"
              data-tone={state.sessionNotice.value.tone}
              role="status"
              aria-live="polite"
            >
              <div>
                <h2>{state.sessionNotice.value.title}</h2>
                <p>{state.sessionNotice.value.body}</p>
                {submissionState.value.status === "confirmed" && (
                  <p>Receipt: {submissionState.value.receiptId}</p>
                )}
              </div>
              <div class="notice-actions">
                {state.showRetrySync.value && (
                  <button
                    class="secondary-action"
                    type="button"
                    data-testid="retry-pending-button"
                    onClick={() => void retryPendingWork()}
                  >
                    Try Sync Again
                  </button>
                )}
                {deliveryState.value === "submitted" && (
                  <button
                    class="secondary-action"
                    type="button"
                    onClick={() => props.navigateTo("history")}
                  >
                    View results
                  </button>
                )}
              </div>
            </section>
          )}

          {!runtimeManifest.value?.testSequence && state.itemNavigationEntries.value.length > 0 && (
            <section class="item-progress-strip" aria-label="Assessment progress">
              <div
                class="item-step-row"
                role="toolbar"
                aria-label="Question navigator"
                aria-orientation="horizontal"
                aria-describedby={
                  state.itemNavigatorFeedback.value ? "item-navigation-feedback" : undefined
                }
              >
                {state.itemNavigationEntries.value.map((entry) => (
                  <button
                    key={entry.itemId}
                    ref={(element) => state.setItemStepRef(entry.itemId, element)}
                    class="item-step"
                    type="button"
                    title={entry.titleLabel}
                    data-state={entry.state}
                    data-locked={entry.unavailableReason ? "true" : undefined}
                    data-lock-reason={entry.unavailableReason || undefined}
                    data-feedback={
                      state.itemNavigatorFeedback.value?.itemId === entry.itemId
                        ? "true"
                        : undefined
                    }
                    tabIndex={entry.itemId === state.rovingItemStepId.value ? 0 : -1}
                    aria-label={entry.ariaLabel}
                    aria-current={entry.state === "current" ? "step" : undefined}
                    aria-disabled={entry.unavailableReason ? "true" : undefined}
                    data-testid="item-progress-step"
                    onFocus={() => {
                      state.focusedItemStepId.value = entry.itemId;
                    }}
                    onKeyDown={(event) => state.handleItemStepKeydown(event, entry)}
                    onClick={() => state.handleItemStepActivation(entry)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>

              {state.itemNavigatorFeedback.value && (
                <div
                  id="item-navigation-feedback"
                  class="item-navigation-feedback"
                  data-tone={state.itemNavigatorFeedback.value.tone}
                  role="status"
                  aria-live="polite"
                  data-testid="item-navigation-feedback"
                >
                  <strong>{state.itemNavigatorFeedback.value.title}</strong>
                  <span>{state.itemNavigatorFeedback.value.body}</span>
                </div>
              )}
            </section>
          )}

          <div
            inert={
              attemptEditingLocked.value ||
              !itemReady.value ||
              (Boolean(runtimeManifest.value?.testSequence) && deliveryBusy.value)
            }
            aria-busy={deliveryBusy.value || !itemReady.value}
          >
            <SessionRendererShell {...state.rendererShell} />
          </div>

          {currentItemPayload.value && (
            <>
              <footer class="assessment-nav-footer">
                {!runtimeManifest.value?.testSequence && (
                  <button
                    class="secondary-action previous-action"
                    type="button"
                    disabled={
                      deliveryBusy.value ||
                      attemptEditingLocked.value ||
                      !attemptClient.value ||
                      !canNavigateBackward.value
                    }
                    data-testid="previous-item-button"
                    onClick={() => {
                      state.stopTextToSpeech("previous-item");
                      navigateItem("previous").catch(reportUiError);
                    }}
                  >
                    Previous
                  </button>
                )}

                {!runtimeManifest.value?.testSequence && (
                  <button
                    class="secondary-action"
                    type="button"
                    disabled={
                      deliveryBusy.value || attemptEditingLocked.value || !attemptClient.value
                    }
                    data-testid="save-response-button"
                    onClick={() => void queueDraftResponse()}
                  >
                    Save answer
                  </button>
                )}

                <button
                  class="primary-action"
                  type="button"
                  disabled={
                    deliveryBusy.value ||
                    attemptEditingLocked.value ||
                    !attemptClient.value ||
                    !canNavigateForward.value ||
                    !itemReady.value ||
                    (Boolean(runtimeManifest.value?.testSequence) && pendingReplayCount.value > 0)
                  }
                  data-testid="next-item-button"
                  onClick={() => {
                    state.stopTextToSpeech("next-item");
                    navigateItem("next").catch(reportUiError);
                  }}
                >
                  {runtimeManifest.value?.testSequence ? "Submit answer" : "Next"}
                </button>
              </footer>
              {showDebugPanel && (
                <details class="session-debug-panel">
                  <summary>Debug</summary>
                  <dl>
                    <div>
                      <dt>Attempt</dt>
                      <dd>{bootstrappedSession.value.payload.attemptId}</dd>
                    </div>
                    <div>
                      <dt>Version</dt>
                      <dd>{bootstrappedSession.value.payload.assessmentVersionId}</dd>
                    </div>
                    <div>
                      <dt>Item</dt>
                      <dd>{currentItemId.value ?? "pending"}</dd>
                    </div>
                    <div class="session-debug-panel__wide">
                      <dt>Source title</dt>
                      <dd>{currentItemTitle.value}</dd>
                    </div>
                    <div>
                      <dt>Delivery</dt>
                      <dd>{deliveryState.value}</dd>
                    </div>
                    <div>
                      <dt>Committed</dt>
                      <dd>{highestCommittedSequence.value}</dd>
                    </div>
                    <div>
                      <dt>Next sequence</dt>
                      <dd>{nextSequenceNumber.value}</dd>
                    </div>
                    <div>
                      <dt>Pending</dt>
                      <dd>{pendingReplayCount.value}</dd>
                    </div>
                    <div>
                      <dt>Renderer</dt>
                      <dd>{itemReady.value ? "ready" : "mounting"}</dd>
                    </div>
                    <div class="session-debug-panel__wide">
                      <dt>Replay</dt>
                      <dd>{replayStatus.value}</dd>
                    </div>
                    <div class="session-debug-panel__wide">
                      <dt>Submit</dt>
                      <dd>{submitStatusLabel.value}</dd>
                    </div>
                  </dl>
                </details>
              )}
            </>
          )}
        </section>
      </main>
    </section>
  );
}

function shouldShowSessionDebugPanel(): boolean {
  const url = new URL(window.location.href);
  return (
    url.searchParams.get("debug") === "1" ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1"
  );
}
