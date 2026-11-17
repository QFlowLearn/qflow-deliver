import { describe, expect, it } from "vitest";
import { isDeliverySessionLocation, maybeBootstrapFromQuery } from "./bootstrap-client";

describe("workspace navigation", () => {
  it("does not launch or restore an attempt for management URLs", async () => {
    for (const path of [
      "/launch",
      "/assessments",
      "/roster",
      "/analytics",
      "/lms",
      "/results-ops",
    ]) {
      const url = new URL(
        `${path}?assessmentVersionId=version-1&mode=preview`,
        "https://delivery.example",
      );
      expect(isDeliverySessionLocation(url)).toBe(false);
      // A bootstrap here would require a network request and fail this test.
      expect(await maybeBootstrapFromQuery(url)).toBeNull();
    }
  });
  it("preserves learner entry and recovery locations", () => {
    for (const path of ["/", "/session", "/details", "/history"]) {
      expect(isDeliverySessionLocation(new URL(path, "https://delivery.example"))).toBe(true);
    }
  });
});
