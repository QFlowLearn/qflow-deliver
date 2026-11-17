import type { AttemptItemScoreSummary, AttemptSubmissionSummary } from "@harbor/attempt-protocol";
import {
  readQtiOutcomeSnapshots,
  readQtiResponseSnapshots,
  readQtiValidationMessageCount,
} from "@harbor/attempt-protocol";

export interface SerializedItemVariable {
  identifier: string;
  value: unknown;
}

export interface SerializedItemState {
  identifier?: string;
  responseVariables?: SerializedItemVariable[];
  outcomeVariables?: SerializedItemVariable[];
  validationMessages?: Array<{
    identifier?: string;
    message?: string;
  }>;
}

export function buildItemScoreSummary(input: {
  itemId: string;
  itemIdentifier: string;
  itemTitle: string;
  maxScore: number | null;
  state: unknown;
}): AttemptItemScoreSummary {
  const responseVariables = readQtiResponseSnapshots(input.state);
  const outcomeVariables = readQtiOutcomeSnapshots(input.state);
  const measuredMaxScore = readNumericOutcome(outcomeVariables, "MAXSCORE");
  const answered = hasAnsweredResponse(responseVariables);
  const maxScore = resolveItemMaxScore(measuredMaxScore, input.maxScore);

  return {
    itemId: input.itemId,
    itemIdentifier: input.itemIdentifier,
    itemTitle: input.itemTitle,
    answered,
    responseSummary: buildResponseSummary(responseVariables),
    score: resolveItemScore(readNumericOutcome(outcomeVariables, "SCORE"), maxScore, answered),
    maxScore,
  };
}

export function buildAttemptSubmissionSummary(input: {
  itemOrder: string[];
  itemDescriptors: Record<
    string,
    {
      identifier: string;
      title: string;
      maxScore: number | null;
    }
  >;
  itemStates: Record<string, unknown>;
}): AttemptSubmissionSummary {
  const items = input.itemOrder
    .map((itemId) => {
      const descriptor = input.itemDescriptors[itemId];
      const state = input.itemStates[itemId] ?? null;

      if (!descriptor) {
        return null;
      }

      return buildItemScoreSummary({
        itemId,
        itemIdentifier: descriptor.identifier,
        itemTitle: descriptor.title,
        maxScore: descriptor.maxScore,
        state,
      });
    })
    .filter((item): item is AttemptItemScoreSummary => item !== null);

  const answeredItemCount = items.filter((item) => item.answered).length;
  const scoredItems = items.filter((item) => item.score !== null);
  const maxScoreItems = items.filter((item) => item.maxScore !== null);

  return {
    itemCount: input.itemOrder.length,
    answeredItemCount,
    scoredItemCount: scoredItems.length,
    totalScore:
      scoredItems.length > 0 ? scoredItems.reduce((sum, item) => sum + (item.score ?? 0), 0) : null,
    maxScore:
      maxScoreItems.length > 0
        ? maxScoreItems.reduce((sum, item) => sum + (item.maxScore ?? 0), 0)
        : null,
    items,
  };
}

export function readValidationMessageCount(state: unknown): number {
  return readQtiValidationMessageCount(state);
}

function hasAnsweredResponse(responseVariables: SerializedItemState["responseVariables"]): boolean {
  if (!Array.isArray(responseVariables)) {
    return false;
  }

  return responseVariables.some(
    (variable) => isStudentResponseVariable(variable.identifier) && hasValue(variable.value),
  );
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasValue(entry));
  }

  if (value instanceof Map) {
    return value.size > 0;
  }

  if (typeof value === "object") {
    return Object.values(value).some((entry) => hasValue(entry));
  }

  return false;
}

function readNumericOutcome(
  outcomeVariables: SerializedItemState["outcomeVariables"],
  identifier: string,
): number | null {
  if (!Array.isArray(outcomeVariables)) {
    return null;
  }

  const variable = outcomeVariables.find((entry) => entry.identifier === identifier);

  return readNumericValue(variable?.value);
}

function readNumericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function buildResponseSummary(
  responseVariables: SerializedItemState["responseVariables"],
): string | null {
  if (!Array.isArray(responseVariables) || responseVariables.length === 0) {
    return null;
  }

  const visibleValues = responseVariables.flatMap((variable) => {
    if (!isStudentResponseVariable(variable.identifier)) {
      return [];
    }

    const formatted = formatResponseValue(variable.value);
    if (!formatted) {
      return [];
    }

    if (responseVariables.length > 1 && variable.identifier) {
      return [`${variable.identifier}: ${formatted}`];
    }

    return [formatted];
  });

  return visibleValues.length > 0 ? visibleValues.join(" · ") : null;
}

function formatResponseValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => formatResponseValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join(", ") : null;
  }

  if (value instanceof Map) {
    const entries = [...value.values()]
      .map((entry) => formatResponseValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join(", ") : null;
  }

  if (typeof value === "object") {
    const entries = Object.values(value)
      .map((entry) => formatResponseValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join(", ") : null;
  }

  return null;
}

function isStudentResponseVariable(identifier: string | undefined): boolean {
  return identifier !== "numAttempts" && identifier !== "duration";
}

function resolveItemMaxScore(
  measuredMaxScore: number | null,
  authoredMaxScore: number | null,
): number | null {
  if (measuredMaxScore !== null) {
    if (measuredMaxScore > 0) {
      return measuredMaxScore;
    }

    if (authoredMaxScore === null || authoredMaxScore <= 0) {
      return measuredMaxScore;
    }
  }

  return authoredMaxScore;
}

function resolveItemScore(
  measuredScore: number | null,
  resolvedMaxScore: number | null,
  answered: boolean,
): number | null {
  if (measuredScore !== null) {
    return measuredScore;
  }

  if (!answered && resolvedMaxScore !== null && resolvedMaxScore > 0) {
    return 0;
  }

  return null;
}
