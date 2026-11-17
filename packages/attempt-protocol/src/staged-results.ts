import type { AttemptVariableSnapshot } from "./results";
export interface StagedAssessmentSummary {
  readonly target: number;
  readonly answered: number;
  readonly complete: boolean;
  readonly audience: string;
  readonly levels: readonly {
    readonly id: string;
    readonly label: string;
    readonly answered: number;
    readonly correct: number;
  }[];
  readonly route: readonly string[];
}

/** Project current scores onto immutable level labels and historical delivered order. */
export function summarizeStagedAssessment(
  outcomes: readonly AttemptVariableSnapshot[],
  items: readonly {
    readonly answered: boolean;
    readonly score: number | null;
    readonly outcomeVariables: readonly AttemptVariableSnapshot[];
  }[],
): StagedAssessmentSummary | null {
  const value = (id: string) => outcomes.find((entry) => entry.identifier === id)?.value;
  const target = value("QFLOW_ADAPTIVE_TARGET");
  if (target === undefined) return null;
  const audience = value("QFLOW_ADAPTIVE_AUDIENCE"),
    route = value("QFLOW_DIFFICULTY_ROUTE");
  if (
    typeof target !== "number" ||
    !Number.isInteger(target) ||
    target < 15 ||
    target > 100 ||
    typeof audience !== "string" ||
    !Array.isArray(route) ||
    !route.every((level): level is string => typeof level === "string")
  )
    throw new Error("Invalid staged result metadata.");
  const levels = [0, 1, 2].map((index) => {
    const id = value(`QFLOW_LEVEL_${index}_ID`),
      label = value(`QFLOW_LEVEL_${index}_LABEL`);
    if (typeof id !== "string" || typeof label !== "string")
      throw new Error("Invalid staged result level.");
    const delivered = items.filter(
      (item) =>
        item.outcomeVariables.find((entry) => entry.identifier === "QFLOW_DIFFICULTY_ID")?.value ===
        id,
    );
    return {
      id,
      label,
      answered: delivered.filter((item) => item.answered).length,
      correct: delivered.filter((item) => item.answered && item.score === 1).length,
    };
  });
  const answered = levels.reduce((sum, level) => sum + level.answered, 0);
  if (route.some((id) => !levels.some((level) => level.id === id)))
    throw new Error("Unknown staged result level.");
  return {
    target,
    answered,
    complete: answered === target,
    audience,
    levels,
    route: route.map((id) => {
      const level = levels.find((entry) => entry.id === id);
      if (!level) throw new Error("Unknown staged route level.");
      return level.label;
    }),
  };
}
