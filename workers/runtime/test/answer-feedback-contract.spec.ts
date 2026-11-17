import { describe, expect, it } from "vitest";
import { parseAnswerFeedbackResponse } from "@harbor/content-model";

describe("released answer feedback HTTP boundary", () => {
  it("requires the explicit release state and empty unreleased content", () => {
    expect(parseAnswerFeedbackResponse({ status: "withheld", items: [] }, "attempt")).toEqual({
      ok: true,
      value: { status: "withheld", items: [] },
    });
    for (const value of [
      null,
      { status: "unknown", items: [] },
      { status: "pending", items: [{ itemId: "item", content: [] }] },
      { status: "released", items: [{ itemId: "", content: [] }] },
    ])
      expect(parseAnswerFeedbackResponse(value, "attempt").ok).toBe(false);
  });
  it("sanitizes authored markup and rejects files outside the authorized attempt", () => {
    const response = (src: string) => ({
      status: "released",
      items: [
        {
          itemId: "question",
          content: [
            {
              kind: "element",
              name: "img",
              attributes: { src, alt: "Diagram", onerror: "alert(1)" },
              children: [],
            },
          ],
        },
      ],
    });
    const parsed = parseAnswerFeedbackResponse(
      response("/api/content/assets/file?attemptId=attempt"),
      "attempt",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Expected sanitized feedback.");
    expect(JSON.stringify(parsed.value)).not.toContain("onerror");
    for (const src of [
      "https://external.example/secret.svg",
      "/api/content/assets/file?attemptId=other",
      "/api/private/question.xml?attemptId=attempt",
    ])
      expect(parseAnswerFeedbackResponse(response(src), "attempt").ok).toBe(false);
  });
});
