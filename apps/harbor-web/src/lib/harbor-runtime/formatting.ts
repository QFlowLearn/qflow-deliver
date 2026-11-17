export function formatScorePair(score: number | null, maxScore: number | null): string {
  if (score === null && maxScore === null) {
    return "score unavailable";
  }
  if (maxScore === null) {
    return String(score ?? "score unavailable");
  }
  return `${score ?? 0} / ${maxScore}`;
}

export function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "The QFlowLearn Delivery shell could not complete launch.";
}
