import { summarizeStagedAssessment } from "@harbor/attempt-protocol";
import { parseQtiTest, type QtiExecutableTest } from "@longsightgroup/qti3-core";
import type {
  AttemptContainerStateSnapshot,
  AttemptItemQtiSnapshot,
  AttemptVariableSnapshot,
} from "@harbor/attempt-protocol";
import type { TestSequenceDescriptor } from "@harbor/content-model";

/** QFlow-owned descriptive outcomes. Branch expressions remain the only routing authority. */
export function readStagedTestReporting(test: QtiExecutableTest, answerCount: number) {
  const constants = new Map(
    test.outcomeDeclarations.map((entry) => [entry.identifier, entry.defaultValue]),
  );
  if (![...constants.keys()].some((id) => id.startsWith("QFLOW_"))) return null;
  const text = (id: string): string => {
    const value = constants.get(id);
    if (typeof value !== "string" || !value.trim() || value.length > 1000)
      throw new Error("Invalid adaptive reporting label.");
    return value;
  };
  if (constants.get("QFLOW_ADAPTIVE_TARGET") !== answerCount)
    throw new Error("Adaptive reporting target does not match the route.");
  const levels = [0, 1, 2].map((index) => ({
    id: text(`QFLOW_LEVEL_${index}_ID`),
    label: text(`QFLOW_LEVEL_${index}_LABEL`),
  }));
  if (new Set(levels.map((level) => level.id)).size !== 3)
    throw new Error("Adaptive reporting levels are not distinct.");
  const levelByRef = new Map<string, string>();
  for (const section of test.sections)
    for (const item of section.items) {
      const categories = item.categories.filter((category) => category.startsWith("QFLOW_LEVEL_"));
      if (categories.length !== 1 || !/^QFLOW_LEVEL_[012]$/.test(categories[0] ?? ""))
        throw new Error("Adaptive question has no declared difficulty.");
      const level = levels[Number(categories[0]?.slice(-1))];
      if (!level) throw new Error("Adaptive question level is unavailable.");
      levelByRef.set(item.identifier, level.id);
    }
  const audience = text("QFLOW_ADAPTIVE_AUDIENCE"),
    versionId = text("QFLOW_ADAPTIVE_CATEGORY_VERSION");
  // Descriptive values cannot be overwritten by test processing.
  if (test.outcomeProcessing.some((rule) => rule.identifier.startsWith("QFLOW_")))
    throw new Error("Adaptive reporting constants cannot be processed.");
  return { levels, audience, versionId, levelByRef };
}

/** Add server-owned reporting to the delivered items and preserve the actual route. */
export async function materializeStagedReporting(input: {
  bucket: R2Bucket;
  descriptor: TestSequenceDescriptor;
  itemOrder: readonly string[];
  items: Record<string, AttemptItemQtiSnapshot>;
  testState: AttemptContainerStateSnapshot | null;
}): Promise<AttemptContainerStateSnapshot> {
  const object = await input.bucket.get(input.descriptor.objectKey);
  if (!object) throw new Error("Published test is unavailable for results.");
  const parsed = parseQtiTest(await object.text());
  if (!parsed.ok) throw new Error("Published test cannot be read for results.");
  const reporting = readStagedTestReporting(parsed.value, input.descriptor.answerCount);
  const outcomes: AttemptVariableSnapshot[] = [
    { identifier: "HARBOR_SEQUENCE_TARGET", value: input.descriptor.answerCount },
  ];
  if (reporting) {
    outcomes.push(
      { identifier: "QFLOW_ADAPTIVE_TARGET", value: input.descriptor.answerCount },
      { identifier: "QFLOW_ADAPTIVE_AUDIENCE", value: reporting.audience },
      { identifier: "QFLOW_ADAPTIVE_CATEGORY_VERSION", value: reporting.versionId },
    );
    reporting.levels.forEach((level, index) =>
      outcomes.push(
        { identifier: `QFLOW_LEVEL_${index}_ID`, value: level.id },
        { identifier: `QFLOW_LEVEL_${index}_LABEL`, value: level.label },
      ),
    );
    const levelsByItem = new Map(
      Object.entries(input.descriptor.itemIdsByRef).map(([ref, id]) => [
        id,
        reporting.levelByRef.get(ref),
      ]),
    );
    const route: string[] = [];
    input.itemOrder.forEach((id, index) => {
      const item = input.items[id],
        level = levelsByItem.get(id);
      if (!item || !level) throw new Error("Delivered question has no frozen reporting level.");
      item.outcomeVariables.push({ identifier: "QFLOW_DIFFICULTY_ID", value: level });
      if (index % 5 === 0) route.push(level);
    });
    outcomes.push({ identifier: "QFLOW_DIFFICULTY_ROUTE", value: route });
  }
  return {
    identifier: parsed.value.identifier,
    responseVariables: input.testState?.responseVariables ?? [],
    outcomeVariables: outcomes,
  };
}

/** Read one finalized result for the existing instructor learner panel. */
export async function readStagedResultSummary(db: D1Database, resultId: string) {
  const result = await db
    .prepare("SELECT test_outcome_variables_json FROM attempt_results WHERE id = ?")
    .bind(resultId)
    .first<{ test_outcome_variables_json: string }>();
  if (!result) throw new Error("Attempt result is unavailable.");
  const outcomes = parseResultVariables(result.test_outcome_variables_json);
  if (!outcomes.some((entry) => entry.identifier === "QFLOW_ADAPTIVE_TARGET")) return null;
  const items = await db
    .prepare(
      "SELECT answered, score, outcome_variables_json FROM attempt_result_items WHERE attempt_result_id = ? ORDER BY item_position",
    )
    .bind(resultId)
    .all<{ answered: number; score: number | null; outcome_variables_json: string }>();
  return summarizeStagedAssessment(
    outcomes,
    items.results.map((item) => ({
      answered: item.answered === 1,
      score: item.score,
      outcomeVariables: parseResultVariables(item.outcome_variables_json),
    })),
  );
}

function parseResultVariables(json: string): AttemptVariableSnapshot[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("Invalid stored result variables.");
  return raw.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("identifier" in entry) ||
      typeof entry.identifier !== "string" ||
      !("value" in entry)
    )
      throw new Error("Invalid stored result variable.");
    return { identifier: entry.identifier, value: entry.value };
  });
}
