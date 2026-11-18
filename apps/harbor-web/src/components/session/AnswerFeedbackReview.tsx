import { useEffect, useRef, useState } from "preact/hooks";
import type { AnswerFeedbackResponse } from "@harbor/content-model";
import { loadAnswerFeedback } from "@/lib/runtime-session";
import { renderSafeContentNode } from "./SafeContentNode";

/** The results screen asks the release authority for explanations separately from grades. */
export default function AnswerFeedbackReview(props: {
  readonly attemptId: string;
  readonly questions: readonly { readonly itemId: string; readonly itemTitle: string | null }[];
}) {
  const [feedback, setFeedback] = useState<AnswerFeedbackResponse | null>(null);
  const [loading, setLoading] = useState(false),
    [failed, setFailed] = useState(false);
  const generation = useRef(0),
    request = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current += 1;
    setFeedback(null);
    setFailed(false);
    setLoading(false);
    return () => {
      request.current?.abort();
      generation.current += 1;
    };
  }, [props.attemptId]);
  async function load() {
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const value = await loadAnswerFeedback(props.attemptId, { signal: controller.signal });
      if (current === generation.current) setFeedback(value);
    } catch {
      if (current === generation.current) setFailed(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  return (
    <section class="assessment-instructions" aria-label="Answer feedback">
      <button class="secondary-action" type="button" disabled={loading} onClick={() => void load()}>
        {loading
          ? "Loading feedback"
          : feedback
            ? "Refresh answer feedback"
            : "View answer feedback"}
      </button>
      {failed && <p role="alert">Answer feedback is unavailable. Try again.</p>}
      {feedback?.status === "pending" && (
        <p role="status">Answer feedback is processing. Refresh when the result is ready.</p>
      )}
      {feedback?.status === "withheld" && (
        <p role="status">Answer feedback is not released for this attempt.</p>
      )}
      {feedback?.status === "released" && !feedback.items.length && (
        <p role="status">No answer explanations are available for your responses.</p>
      )}
      {feedback?.items.map((item, index) => (
        <div key={`${item.itemId}-${index}`} data-answer-feedback-item={item.itemId}>
          <h3>
            {props.questions.find((question) => question.itemId === item.itemId)?.itemTitle ??
              item.itemId}
          </h3>
          {item.content.map(renderSafeContentNode)}
        </div>
      ))}
    </section>
  );
}
