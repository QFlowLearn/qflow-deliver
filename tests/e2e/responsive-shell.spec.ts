import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Parameters<typeof test>[0]["page"]): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true);
}

test("mobile home keeps primary navigation and entry actions visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByTestId("password-login-button")).toBeVisible();
  await expect(page.getByTestId("nav-link-assessments")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByTestId("password-login-button").click();
  await page.getByTestId("institutional-login-button").click();
  await expect(page.getByTestId("signed-in-learner")).toHaveText("Morgan Lee");
  await expect(page.getByTestId("nav-link-home")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("tablet assessments workspace stays usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await page.getByTestId("password-login-button").click();
  await page.getByTestId("institutional-login-button").click();
  await page.getByTestId("nav-link-assessments").click();

  await expect(page).toHaveURL(/\/assessments$/);
  await expect(page.getByTestId("assessment-new-button")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByTestId("assessment-new-button").click();
  await expect(page.getByTestId("assessment-package-select")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
