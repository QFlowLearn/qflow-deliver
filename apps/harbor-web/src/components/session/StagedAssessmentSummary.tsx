import type { StagedAssessmentSummary as Summary } from "@harbor/attempt-protocol";

/** Counts describe the delivered form; difficulty is not a calibrated mastery estimate. */
export default function StagedAssessmentSummary({ summary }: { summary: Summary }) {
  return (
    <section aria-label="Adaptive assessment results" class="history-breakdown">
      <h3>
        {summary.complete ? "Completed" : "Incomplete"} · {summary.answered} of {summary.target}{" "}
        answered
      </h3>
      <p>{summary.audience}</p>
      <div class="breakdown-table-wrap">
        <table class="breakdown-table breakdown-table--compact">
          <thead>
            <tr>
              <th scope="col">Difficulty</th>
              <th scope="col">Answered</th>
              <th scope="col">Correct</th>
            </tr>
          </thead>
          <tbody>
            {summary.levels.map((level) => (
              <tr key={level.id}>
                <th scope="row">{level.label}</th>
                <td>{level.answered}</td>
                <td>{level.correct}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>Difficulty by group</summary>
        <ol>
          {summary.route.map((label, index) => (
            <li key={index}>{label}</li>
          ))}
        </ol>
      </details>
    </section>
  );
}
