import { computed, onMounted, reactive, ref, useSetup, watch } from "@/lib/preact-reactivity";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import type { RuntimeManualScoringAttempt } from "@/lib/runtime-session";

type ManualItem = RuntimeManualScoringAttempt["items"][number];

export default function HarborManualScoringPage() {
  const {
    finalizeManualScoringAttempt,
    manualScoringAttempt,
    manualScoringError,
    manualScoringLoading,
    manualScoringQueue,
    manualScoringSaving,
    manualScoringStatus,
    openManualScoringAttempt,
    refreshManualScoringQueue,
    saveManualScore,
    selectedInstructorAssignmentId,
    selectedInstructorAssignmentTitle,
  } = useHarborRuntime();

  const state = useSetup(() => {
    const selectedAttemptId = ref("");
    const selectedItemId = ref("");
    const confirmFinalize = ref(false);
    const form = reactive({
      score: "",
      maxScore: "",
      studentFeedback: "",
      privateNote: "",
    });

    const selectedItem = computed(
      () =>
        manualScoringAttempt.value?.items.find((item) => item.itemId === selectedItemId.value) ??
        null,
    );

    const pendingItems = computed(
      () => manualScoringAttempt.value?.items.filter((item) => item.pendingManualScoring) ?? [],
    );

    const queueSummary = computed(() => {
      const ready = manualScoringQueue.value.filter(
        (row) => row.status === "ready-to-finalize",
      ).length;
      const drafts = manualScoringQueue.value.filter((row) => row.status === "in-progress").length;
      return {
        ready,
        drafts,
        open: manualScoringQueue.value.length,
      };
    });

    watch(
      () => manualScoringAttempt.value?.attemptId,
      () => {
        confirmFinalize.value = false;
        const firstPending = pendingItems.value[0];
        selectedItemId.value = firstPending?.itemId ?? "";
      },
    );

    watch(
      () => selectedItem.value?.itemId,
      () => {
        confirmFinalize.value = false;
        const item = selectedItem.value;
        form.score =
          item?.manualScore?.score === undefined || item.manualScore.score === null
            ? ""
            : String(item.manualScore.score);
        const maxScore = item?.manualScore?.maxScore ?? item?.authoredMaxScore;
        form.maxScore = maxScore === undefined || maxScore === null ? "" : String(maxScore);
        form.studentFeedback = item?.manualScore?.studentFeedback ?? "";
        form.privateNote = item?.manualScore?.privateNote ?? "";
      },
    );

    onMounted(() => {
      void refreshManualScoringQueue({
        assignmentId: selectedInstructorAssignmentId.value || undefined,
      });
    });

    async function openAttempt(attemptId: string): Promise<void> {
      selectedAttemptId.value = attemptId;
      await openManualScoringAttempt(attemptId);
    }

    async function saveSelectedItem(): Promise<void> {
      const item = selectedItem.value;
      const attempt = manualScoringAttempt.value;
      if (!item || !attempt) return;
      await saveManualScore({
        attemptId: attempt.attemptId,
        itemId: item.itemId,
        score: Number(form.score),
        maxScore: Number(form.maxScore),
        studentFeedback: form.studentFeedback,
        privateNote: form.privateNote,
      });
    }

    async function finalizeSelectedAttempt(): Promise<void> {
      const attempt = manualScoringAttempt.value;
      if (!attempt) return;
      if (!confirmFinalize.value) {
        confirmFinalize.value = true;
        return;
      }
      await finalizeManualScoringAttempt({ attemptId: attempt.attemptId });
      confirmFinalize.value = false;
    }

    return {
      confirmFinalize,
      finalizeSelectedAttempt,
      form,
      openAttempt,
      pendingItems,
      queueSummary,
      saveSelectedItem,
      selectedAttemptId,
      selectedItem,
      selectedItemId,
    };
  });

  return (
    <section class="manual-scoring-page" data-testid="manual-scoring-page">
      <header class="manual-scoring-hero">
        <div>
          <h1>Manual scoring</h1>
          <p class="meta-line">
            {selectedInstructorAssignmentTitle.value || "All selected instructor work"}
          </p>
        </div>
        <div class="detail-summary">
          <span class="summary-pill">
            <strong>{state.queueSummary.value.open}</strong> open
          </span>
          <span class="summary-pill">
            <strong>{state.queueSummary.value.drafts}</strong> in progress
          </span>
          <span class="summary-pill">
            <strong>{state.queueSummary.value.ready}</strong> ready
          </span>
        </div>
        <button
          class="secondary-action"
          type="button"
          disabled={manualScoringLoading.value}
          onClick={() =>
            void refreshManualScoringQueue({
              assignmentId: selectedInstructorAssignmentId.value || undefined,
            })
          }
        >
          Refresh
        </button>
      </header>

      {manualScoringError.value && (
        <p class="form-error" role="alert">
          {manualScoringError.value}
        </p>
      )}
      <p class="meta-line">{manualScoringStatus.value}</p>

      <section class="manual-scoring-layout">
        <section class="manual-scoring-queue" aria-label="Manual scoring queue">
          <div class="manual-scoring-panel-header">
            <h2>Queue</h2>
          </div>
          {manualScoringQueue.value.length === 0 ? (
            <p class="empty-state">No attempts need manual scoring.</p>
          ) : (
            <div class="table-scroll">
              <table class="manual-scoring-table">
                <thead>
                  <tr>
                    <th scope="col">Learner</th>
                    <th scope="col">Assessment</th>
                    <th scope="col">Progress</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {manualScoringQueue.value.map((row) => (
                    <tr
                      key={row.attemptId}
                      data-active={row.attemptId === state.selectedAttemptId.value}
                    >
                      <th scope="row">
                        <button
                          class="text-button"
                          type="button"
                          onClick={() => void state.openAttempt(row.attemptId)}
                        >
                          {row.learner?.displayName ?? row.attemptId}
                        </button>
                        <span class="table-subtext">{formatTimestamp(row.submittedAt)}</span>
                      </th>
                      <td>
                        {row.assignmentTitle ?? row.assessmentTitle}
                        <span class="table-subtext">{row.assessmentTitle}</span>
                      </td>
                      <td>
                        {row.scoredItemCount} / {row.pendingItemCount}
                      </td>
                      <td>{formatQueueStatus(row.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section class="manual-scoring-review" aria-label="Attempt review">
          {!manualScoringAttempt.value ? (
            <p class="empty-state">Select an attempt to review responses.</p>
          ) : (
            <>
              <header class="manual-review-header">
                <div>
                  <h2>{manualScoringAttempt.value.learner?.displayName ?? "Learner"}</h2>
                  <p class="meta-line">
                    {manualScoringAttempt.value.assessment.title} ·{" "}
                    {formatTimestamp(manualScoringAttempt.value.submittedAt)}
                  </p>
                </div>
                <button
                  class="primary-action"
                  type="button"
                  disabled={!manualScoringAttempt.value.canFinalize || manualScoringSaving.value}
                  onClick={() => void state.finalizeSelectedAttempt()}
                >
                  {state.confirmFinalize.value ? "Confirm release" : "Finalize attempt"}
                </button>
                {state.confirmFinalize.value && (
                  <button
                    class="secondary-action"
                    type="button"
                    disabled={manualScoringSaving.value}
                    onClick={() => {
                      state.confirmFinalize.value = false;
                    }}
                  >
                    Cancel
                  </button>
                )}
              </header>

              <div class="manual-review-grid">
                <nav class="manual-item-list" aria-label="Pending items">
                  {state.pendingItems.value.map((item, index) => (
                    <button
                      key={item.itemId}
                      type="button"
                      data-active={item.itemId === state.selectedItemId.value}
                      onClick={() => {
                        state.selectedItemId.value = item.itemId;
                      }}
                    >
                      <strong>Item {index + 1}</strong>
                      <span>{item.itemTitle ?? item.itemIdentifier ?? item.itemId}</span>
                      <small>
                        {item.manualScore
                          ? `${item.manualScore.score} / ${item.manualScore.maxScore}`
                          : "Needs score"}
                      </small>
                    </button>
                  ))}
                </nav>

                <ManualItemPreview item={state.selectedItem.value} />

                <form
                  class="manual-score-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void state.saveSelectedItem();
                  }}
                >
                  <fieldset disabled={!state.selectedItem.value || manualScoringSaving.value}>
                    <legend>Score</legend>
                    <label for="manual-score-input">Points earned</label>
                    <input
                      id="manual-score-input"
                      name="score"
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      value={state.form.score}
                      onInput={(event) => {
                        state.form.score = event.currentTarget.value;
                      }}
                    />

                    <label for="manual-max-score-input">Max points</label>
                    <input
                      id="manual-max-score-input"
                      name="maxScore"
                      type="number"
                      min="0.01"
                      max={state.selectedItem.value?.authoredMaxScore ?? undefined}
                      step="0.01"
                      required
                      value={state.form.maxScore}
                      onInput={(event) => {
                        state.form.maxScore = event.currentTarget.value;
                      }}
                    />
                    {state.selectedItem.value?.authoredMaxScore !== null &&
                      state.selectedItem.value?.authoredMaxScore !== undefined && (
                        <p class="field-hint">
                          Authored max {state.selectedItem.value.authoredMaxScore}
                        </p>
                      )}

                    <label for="manual-feedback-input">Student feedback</label>
                    <textarea
                      id="manual-feedback-input"
                      name="studentFeedback"
                      rows={4}
                      value={state.form.studentFeedback}
                      onInput={(event) => {
                        state.form.studentFeedback = event.currentTarget.value;
                      }}
                    />

                    <label for="manual-note-input">Private note</label>
                    <textarea
                      id="manual-note-input"
                      name="privateNote"
                      rows={3}
                      value={state.form.privateNote}
                      onInput={(event) => {
                        state.form.privateNote = event.currentTarget.value;
                      }}
                    />

                    <button class="primary-action" type="submit">
                      Save draft
                    </button>
                  </fieldset>
                </form>
              </div>
            </>
          )}
        </section>
      </section>
    </section>
  );
}

function ManualItemPreview(props: { item: ManualItem | null }) {
  if (!props.item) {
    return <p class="empty-state">Select an item to see the submitted response.</p>;
  }

  return (
    <article class="manual-item-preview">
      <header>
        <h3>{props.item.itemTitle ?? props.item.itemIdentifier ?? props.item.itemId}</h3>
        <p class="meta-line">Item ID {props.item.itemId}</p>
      </header>
      <section>
        <h4>Response</h4>
        <p class="response-summary">
          {props.item.responseSummary || "No response summary was captured."}
        </p>
      </section>
      <details class="technical-disclosure">
        <summary>Response variables</summary>
        <pre>{JSON.stringify(props.item.responseVariables, null, 2)}</pre>
      </details>
    </article>
  );
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatQueueStatus(status: string): string {
  if (status === "ready-to-finalize") return "Ready";
  if (status === "in-progress") return "In progress";
  return "Needs review";
}
