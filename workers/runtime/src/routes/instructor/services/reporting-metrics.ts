import {
  createEmptyInstructorAccommodationEvidenceSummary,
  type InstructorLearnerReportEvidenceSummary,
} from "@harbor/attempt-protocol";
import type { AttemptResultRow } from "./types";

export function isScoredResultStatus(
  status: AttemptResultRow["status"] | null,
): status is "complete" | "rescored" {
  return status === "complete" || status === "rescored";
}

export function averageReportingMetric(values: Array<number | null>): number | null {
  const numericValues = values.filter((value): value is number => value !== null);
  if (numericValues.length === 0) {
    return null;
  }

  return roundReportingMetric(average(numericValues));
}

export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculatePercentScore(
  totalScore: number | null,
  maxScore: number | null,
): number | null {
  if (totalScore === null || maxScore === null || maxScore <= 0) {
    return null;
  }

  return roundReportingMetric((totalScore / maxScore) * 100);
}

export function roundReportingMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

export function maxTimestamp(values: Array<string | null>): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null
  );
}

export function createEmptyEvidenceSummary(): InstructorLearnerReportEvidenceSummary {
  return {
    ...createEmptyInstructorAccommodationEvidenceSummary(),
    itemPresentationCount: 0,
    responseCount: 0,
    submitCount: 0,
    flaggedCount: 0,
    queuedLocallyCount: 0,
    replayedCount: 0,
    staleTabReconciledCount: 0,
    receiptConfirmedCount: 0,
    syncFailedCount: 0,
    latestKeywordTranslationRequestedLanguage: null,
    latestKeywordTranslationResolvedLanguage: null,
    firstEventAt: null,
    latestEventAt: null,
    latestSubmitAt: null,
  };
}
