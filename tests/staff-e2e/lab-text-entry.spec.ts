import { expect, test } from "@playwright/test";
import { seedRecoveryExam, signInAndOpen } from "./lab-recovery-fixture";
test("autosaves and restores editable short-text responses", async ({ page, request }) => {
  const exam = await seedRecoveryExam(request);
  await signInAndOpen(page, exam);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("current-item-id")).toHaveText("item-2");
  await page.getByRole("textbox").fill("Short text without transfer");
  const snapshot = await page
    .locator("qti-assessment-item-player")
    .evaluate((el) =>
      "serialize" in el && typeof el.serialize === "function" ? el.serialize() : null,
    );

  expect(snapshot).toMatchObject({ responses: { TEXT: "Short text without transfer" } });
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.reload();
  await expect(page.getByRole("textbox")).toHaveValue("Short text without transfer");
  await page.getByRole("textbox").fill("Edited after restored short text");
  const resumed = await page
    .locator("qti-assessment-item-player")
    .evaluate((el) =>
      "serialize" in el && typeof el.serialize === "function" ? el.serialize() : null,
    );

  expect(resumed).toMatchObject({ responses: { TEXT: "Edited after restored short text" } });
});
