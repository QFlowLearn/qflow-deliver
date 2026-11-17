import { expect, it } from "vitest";
import { managementLoginReturn } from "./management-login-return";
it("preserves the assessment through institutional sign-in without forwarding unrelated launch parameters", () => {
  expect(
    managementLoginReturn(
      new URL(
        "https://delivery.example/login?returnTo=assessments&assessmentVersionId=v1&mode=preview&token=unused",
      ),
    ),
  ).toBe("/assessments?assessmentVersionId=v1");
});
it("does not allow arbitrary return destinations", () => {
  expect(
    managementLoginReturn(new URL("https://delivery.example/login?returnTo=https://example.org")),
  ).toBe("/");
});
