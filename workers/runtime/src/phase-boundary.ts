export const PHASE_ONE_BOUNDARY = {
  included: ["publish", "launch", "bootstrap", "render", "attempt-events", "attempt-policy"],
  excluded: ["offline-journal", "submit"],
} as const;
