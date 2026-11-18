/** Requires the metric's textual dimension instead of coercing opaque binary blobs. */
export function readMetricText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a textual metric dimension");
  return value;
}
