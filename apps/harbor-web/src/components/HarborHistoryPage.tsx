import AnswerFeedbackReview from "./session/AnswerFeedbackReview";
import StagedAssessmentSummary from "./session/StagedAssessmentSummary";
import { computed, useSetup } from "@/lib/preact-reactivity";
import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";

export default function HarborHistoryPage(props: { navigateTo: (page: HarborPage) => void }) {
  const {
    accessCodeForm,
    assessmentHistory,
    bootstrappedSession,
    entryMode,
    historyErrorMessage,
    historyLoading,
    latestSubmittedAttempt,
    launchAccessCode,
    refreshAssessmentHistory,
  } = useHarborRuntime();

  const state = useSetup(() => ({
    canRetake: computed(
      () =>
        entryMode.value === "access-code" &&
        accessCodeForm.accessCode.trim().length > 0 &&
        !historyLoading.value,
    ),
    hasHistoryContext: computed(() => assessmentHistory.value !== null),
    historyHeading: computed(() => (bootstrappedSession.value ? "Results" : "Attempt history")),
    latestResultLabel: computed(() =>
      latestSubmittedAttempt.value
        ? formatAttemptHeadline(latestSubmittedAttempt.value)
        : "Processing",
    ),
  }));

  if (!state.hasHistoryContext.value) {
    return (
      <section class="empty-state">
        <h1>{historyLoading.value ? "Loading history" : "No attempts yet"}</h1>
        {historyErrorMessage.value && <p role="alert">{historyErrorMessage.value}</p>}
        <button
          class="primary-action"
          type="button"
          onClick={() => props.navigateTo("assessments")}
        >
          Assessments
        </button>
      </section>
    );
  }

  return (
    <section class="history-page">
      <section class="history-intro">
        <div>
          <h1>{state.historyHeading.value}</h1>
        </div>
        <div class="intro-actions">
          <button
            class="secondary-action"
            type="button"
            disabled={historyLoading.value}
            onClick={() => void refreshAssessmentHistory()}
          >
            Refresh
          </button>
          {state.canRetake.value && (
            <button class="primary-action" type="button" onClick={() => void launchAccessCode()}>
              Retake
            </button>
          )}
        </div>
      </section>

      <section class="history-context">
        <div class="context-main">
          <h2>{assessmentHistory.value?.assessment.title ?? "Waiting for history"}</h2>
          <p class="context-copy">
            {assessmentHistory.value?.assessment.assignmentTitle ?? "Assessment history"}
          </p>
        </div>
        <p class="meta-line">
          {assessmentHistory.value?.actor.displayName ??
            assessmentHistory.value?.actor.id ??
            "Unknown"}
          <span class="meta-sep" />
          Latest result{" "}
          <strong data-testid="latest-submitted-score">{state.latestResultLabel.value}</strong>
          <span class="meta-sep" />
          {assessmentHistory.value?.attempts.length ?? 0} attempt
          {(assessmentHistory.value?.attempts.length ?? 0) === 1 ? "" : "s"}
        </p>
      </section>

      {historyErrorMessage.value ? (
        <section class="history-feedback error" role="alert">
          <strong>History unavailable</strong>
          <p>{historyErrorMessage.value}</p>
        </section>
      ) : null}

      {!assessmentHistory.value || assessmentHistory.value.attempts.length === 0 ? (
        <section class="history-feedback">
          <strong>No attempts yet</strong>
        </section>
      ) : (
        <section class="history-list" data-testid="history-attempt-list">
          {assessmentHistory.value.attempts.map((attempt) => (
            <article
              key={attempt.attemptId}
              class="history-card"
              data-current={attempt.attemptId === latestSubmittedAttempt.value?.attemptId}
            >
              <header class="history-card-header">
                <div>
                  {attempt.attemptId === latestSubmittedAttempt.value?.attemptId && (
                    <span class="attempt-pill">Latest</span>
                  )}
                  <h2>{formatAttemptHeadline(attempt)}</h2>
                  <p class="attempt-summary">{formatAttemptSummary(attempt)}</p>
                </div>
                <div class="history-meta">
                  <span class="attempt-date">{formatTimestamp(attempt.submittedAt)}</span>
                  <span class="attempt-pill attempt-pill--status">
                    {formatResultStatus(attempt)}
                  </span>
                </div>
              </header>

              <p class="meta-line">{formatAttemptMeta(attempt)}</p>
              {attempt.stagedAssessment && (
                <StagedAssessmentSummary summary={attempt.stagedAssessment} />
              )}

              {attempt.finalization?.errorMessage && (
                <p class="finalization-error" role="alert">
                  {attempt.finalization.errorMessage}
                </p>
              )}

              {attempt.latestScoreRevision && (
                <section class="score-revision-note" data-testid="history-score-revision-note">
                  <strong>Score amended</strong>
                  <p>
                    {formatScoreChange(attempt.latestScoreRevision)} ·{" "}
                    {attempt.latestScoreRevision.reason} ·{" "}
                    {formatScoreRevisionEvidence(attempt.latestScoreRevision)}
                  </p>
                </section>
              )}

              <details class="history-breakdown">
                <summary>Questions</summary>
                <div class="breakdown-table-wrap">
                  <table class="breakdown-table">
                    <thead>
                      <tr>
                        <th scope="col">Question</th>
                        <th scope="col">Response</th>
                        <th scope="col">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempt.items.map((item, itemIndex) => (
                        <tr key={`${attempt.attemptId}-${item.itemId}`}>
                          <th scope="row">
                            <div class="breakdown-question">
                              <strong>Question {itemIndex + 1}</strong>
                              {item.itemTitle && (
                                <span class="breakdown-title">{item.itemTitle}</span>
                              )}
                            </div>
                          </th>
                          <td>{formatItemResponse(item)}</td>
                          {isAttemptPending(attempt) ? (
                            <td>Score pending</td>
                          ) : isAttemptFailed(attempt) ? (
                            <td>Score unavailable</td>
                          ) : (
                            <td>
                              {formatItemScore(item)}
                              {item.manualFeedback && (
                                <span class="manual-feedback-note">{item.manualFeedback}</span>
                              )}
                              {item.scoreAmended && (
                                <span class="score-amended-note">
                                  Base {formatBaseItemScore(item)}
                                </span>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details class="technical-disclosure">
                  <summary>Details</summary>
                  <dl class="technical-grid">
                    <div>
                      <dt>Attempt ID</dt>
                      <dd class="mono">{attempt.attemptId}</dd>
                    </div>
                    <div>
                      <dt>Delivery ID</dt>
                      <dd class="mono">{attempt.assignmentId ?? "none"}</dd>
                    </div>
                    <div>
                      <dt>Version</dt>
                      <dd class="mono">{attempt.assessmentVersionId}</dd>
                    </div>
                  </dl>
                </details>
              </details>
              <AnswerFeedbackReview attemptId={attempt.attemptId} questions={attempt.items} />
            </article>
          ))}
        </section>
      )}
    </section>
  );
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatAttemptHeadline(input: AttemptLike): string {
  if (input.resultStatus === "pending" || input.finalization?.status === "pending") {
    return "Awaiting review";
  }
  if (input.resultStatus === "failed" || input.finalization?.status === "failed") {
    return "Score unavailable";
  }
  if (input.maxScore !== null && input.maxScore > 0 && input.totalScore !== null) {
    return `${input.totalScore} / ${input.maxScore}`;
  }
  if (input.totalScore !== null) return `${input.totalScore}`;
  return "Submitted";
}

function formatResultStatus(input: AttemptLike): string {
  if (input.resultStatus === "pending" || input.finalization?.status === "pending") {
    return "Awaiting review";
  }
  if (input.resultStatus === "failed" || input.finalization?.status === "failed") {
    return "Score unavailable";
  }
  if (input.resultStatus === "complete" || input.resultStatus === "rescored") {
    return input.resultStatus === "rescored" ? "Rescored" : "Scored";
  }
  return "Submitted";
}

function formatAttemptSummary(input: { itemCount: number }): string {
  return input.itemCount > 0
    ? `${input.itemCount} question${input.itemCount === 1 ? "" : "s"}`
    : "Submitted attempt";
}

function formatAttemptMeta(input: { submittedAt: string; answeredItemCount: number }): string {
  const parts = [`Submitted ${formatTimestamp(input.submittedAt)}`];
  if (input.answeredItemCount > 0) parts.push(`${input.answeredItemCount} answered`);
  return parts.join(" · ");
}

function formatItemResponse(item: { answered: boolean; responseSummary?: string | null }): string {
  if (item.responseSummary && item.responseSummary.trim().length > 0) {
    return `Response: ${item.responseSummary}`;
  }
  return item.answered ? "Response recorded" : "No response";
}

function formatItemScore(input: { score: number | null; maxScore: number | null }): string {
  if (input.maxScore !== null && input.maxScore > 0 && input.score !== null) {
    return `${input.score} / ${input.maxScore}`;
  }
  if (input.score !== null) return `${input.score}`;
  return "Not scored";
}

function formatScoreChange(input: {
  previousTotalScore: number | null;
  previousMaxScore: number | null;
  amendedTotalScore: number | null;
  amendedMaxScore: number | null;
}): string {
  return `${formatItemScore({
    score: input.previousTotalScore,
    maxScore: input.previousMaxScore,
  })} to ${formatItemScore({
    score: input.amendedTotalScore,
    maxScore: input.amendedMaxScore,
  })}`;
}

function formatScoreRevisionEvidence(input: {
  applications: Array<{
    responseEvidenceEventId: string | null;
    responseEvidenceSequenceNumber: number | null;
  }>;
}): string {
  const linkedApplications = input.applications.filter(
    (application) => application.responseEvidenceEventId,
  );
  if (linkedApplications.length === 0) return "Response evidence link unavailable";

  const sequence = linkedApplications[0]?.responseEvidenceSequenceNumber;
  return sequence === null || sequence === undefined
    ? `${linkedApplications.length} response evidence link${linkedApplications.length === 1 ? "" : "s"}`
    : `Response evidence sequence ${sequence}`;
}

function formatBaseItemScore(input: {
  baseScore?: number | null;
  baseMaxScore?: number | null;
}): string {
  return formatItemScore({
    score: input.baseScore ?? null,
    maxScore: input.baseMaxScore ?? null,
  });
}

function isAttemptPending(input: AttemptLike): boolean {
  return input.resultStatus === "pending" || input.finalization?.status === "pending";
}

function isAttemptFailed(input: AttemptLike): boolean {
  return input.resultStatus === "failed" || input.finalization?.status === "failed";
}

interface AttemptLike {
  totalScore: number | null;
  maxScore: number | null;
  resultStatus: string | null;
  finalization: { status: string } | null;
}
