import {
  parseSafeContentProjection,
  type SafeProjectedContentNode,
} from "@longsightgroup/qti3-player";

/** Released authored explanations remain distinct from learner-specific grading comments. */
export interface AnswerFeedbackResponse {
  readonly status: "withheld" | "pending" | "released";
  readonly items: readonly {
    readonly itemId: string;
    readonly content: readonly SafeProjectedContentNode[];
  }[];
}
export type AnswerFeedbackResponseResult =
  | { readonly ok: true; readonly value: AnswerFeedbackResponse }
  | { readonly ok: false; readonly code: "answer.feedback.invalid" };

/** Parse the release response and reapply the shared sanitizer at the HTTP boundary. */
export function parseAnswerFeedbackResponse(
  value: unknown,
  attemptId: string,
): AnswerFeedbackResponseResult {
  const invalid = { ok: false, code: "answer.feedback.invalid" } as const;
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    (value.status !== "withheld" && value.status !== "pending" && value.status !== "released") ||
    !("items" in value) ||
    !Array.isArray(value.items)
  )
    return invalid;
  if (value.status !== "released" && value.items.length) return invalid;
  const items: AnswerFeedbackResponse["items"][number][] = [];
  for (const item of value.items) {
    if (
      !item ||
      typeof item !== "object" ||
      !("itemId" in item) ||
      typeof item.itemId !== "string" ||
      !item.itemId.trim() ||
      !("content" in item)
    )
      return invalid;
    const content = parseSafeContentProjection(item.content);
    if (!content.ok || !filesBelongToAttempt(content.value, attemptId)) return invalid;
    items.push({ itemId: item.itemId, content: content.value });
  }
  return { ok: true, value: { status: value.status, items } };
}

/** The shared sanitizer allows external media; released files must use the attempt asset endpoint. */
function filesBelongToAttempt(
  nodes: readonly SafeProjectedContentNode[],
  attemptId: string,
): boolean {
  return nodes.every((node) => {
    if (node.kind === "text") return true;
    for (const [name, reference] of Object.entries(node.attributes)) {
      if (name !== "src" && name !== "poster" && name !== "data") continue;
      if (!reference.startsWith("/api/content/assets/")) return false;
      const url = new URL(reference, "https://harbor.local");
      if (
        !url.pathname.startsWith("/api/content/assets/") ||
        url.searchParams.getAll("attemptId").length !== 1 ||
        url.searchParams.get("attemptId") !== attemptId
      )
        return false;
    }
    return filesBelongToAttempt(node.children, attemptId);
  });
}
