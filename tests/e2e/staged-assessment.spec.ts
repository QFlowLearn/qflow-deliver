import axe from "axe-core";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { stagedPackage } from "../fixtures/staged-package";

test("submits a staged assessment, changes difficulty and resumes past a stale cached session", async ({
  page,
  request,
}) => {
  const xml = readFileSync("tests/fixtures/qti/staged-assessment/test.xml", "utf8");
  const workerOrigin = process.env.HARBOR_TEST_WORKER_ORIGIN ?? "http://127.0.0.1:8787";
  const published = await request.post(
    `${workerOrigin}/internal/publish?assessmentSlug=staged-browser`,
    {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "staged.zip",
        "x-harbor-tenant-id": `staged_${Date.now()}`,
      },
      data: Buffer.from(await stagedPackage(xml)),
    },
  );
  expect(published.status(), await published.text()).toBe(201);
  const { assessmentVersionId } = await published.json();
  await page.goto(`/?mode=preview&assessmentVersionId=${assessmentVersionId}`);
  await expect(page.getByRole("button", { name: "Submit answer", exact: true })).toBeEnabled();
  const initialCachedSession = await page.evaluate(() =>
    sessionStorage.getItem("harbor.bootstrappedSession"),
  );
  expect(initialCachedSession).toBeTruthy();
  for (let index = 0; index < 15; index++) {
    const stage = Math.floor(index / 5);
    const level = stage === 1 ? 1 : 0;
    await expect(
      page.getByText(`Question stage${stage}_level${level}_${index % 5}: choose the letter A.`, {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("radio", { name: index < 5 ? "A. A" : "B. B", exact: true }).check();
    await page.getByRole("button", { name: "Submit answer", exact: true }).click();
    if (index === 4) {
      await expect(
        page.getByText("Question stage1_level1_0: choose the letter A.", { exact: true }),
      ).toBeVisible();
      // A recovered tab can hold an older bootstrap while the server has moved on.
      await page.evaluate((cachedSession) => {
        sessionStorage.setItem("harbor.bootstrappedSession", cachedSession!);
      }, initialCachedSession);
      await page.reload();
    }
  }
  await expect(page.getByRole("button", { name: "Submit answer", exact: true })).toBeDisabled();
});

for (const scenario of ["strong", "struggling", "mixed"] as const) {
  test(`QFlow 100-answer package: ${scenario} path, resume, and results`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180000);
    const workerOrigin = process.env.HARBOR_TEST_WORKER_ORIGIN ?? "http://127.0.0.1:8787";
    const published = await request.post(
      `${workerOrigin}/internal/publish?assessmentSlug=adaptive-handoff`,
      {
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "qflow-100.zip",
          "x-harbor-tenant-id": `handoff_${scenario}_${Date.now()}`,
        },
        data: Buffer.from(
          readFileSync("tests/fixtures/qti/staged-assessment/qflow-100.zip.b64", "utf8"),
          "base64",
        ),
      },
    );
    expect(published.status(), await published.text()).toBe(201);
    const { assessmentVersionId } = await published.json();
    await page.goto(`/?mode=preview&assessmentVersionId=${assessmentVersionId}`);
    const seen = new Set<string>();
    for (let index = 0; index < 100; index++) {
      const correct = scenario === "strong" || (scenario === "mixed" && index % 15 < 5);
      const radio = page.getByRole("radio", { name: correct ? /Nucleus/ : /Membrane/ });
      await expect(page.getByRole("button", { name: "Submit answer", exact: true })).toBeEnabled();
      await expect(radio).toBeVisible();
      if (index === 0 && scenario === "strong") {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(
          page.getByRole("button", { name: "Submit answer", exact: true }),
        ).toBeEnabled();
        await audit(page, ".assessment-workspace");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      const id = await page.getByTestId("current-item-id").innerText();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      await radio.check();
      await page.getByRole("button", { name: "Submit answer", exact: true }).click();
      if (index < 99) await expect(page.getByTestId("current-item-id")).not.toHaveText(id);
      if (index === 4) await page.reload();
    }
    expect(seen.size).toBe(100);
    await expect(page.getByRole("button", { name: "Submit answer", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "View results", exact: true }).click();
    const summary = page.getByRole("region", { name: "Adaptive assessment results" });
    await expect(summary).toBeVisible({ timeout: 30000 });
    await expect(summary.getByRole("heading")).toHaveText("Completed · 100 of 100 answered");
    await audit(page, '[aria-label="Adaptive assessment results"]');
    if (scenario === "strong") {
      await expect(summary.getByRole("row", { name: "Easy 5 5", exact: true })).toBeVisible();
      await expect(summary.getByRole("row", { name: "Moderate 5 5", exact: true })).toBeVisible();
      await expect(summary.getByRole("row", { name: "Hard 90 90", exact: true })).toBeVisible();
    }
    if (scenario === "struggling")
      await expect(summary.getByRole("row", { name: "Easy 100 0", exact: true })).toBeVisible();
  });
}

async function audit(page: import("@playwright/test").Page, selector: string) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async (selector) => {
    // axe.source is loaded into this isolated browser page above.
    const runner = (globalThis as unknown as { axe: typeof axe }).axe;
    const result = await runner.run(document.querySelector(selector)!, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
    return result.violations
      .filter((entry) => entry.impact === "serious" || entry.impact === "critical")
      .map((entry) => ({ id: entry.id, targets: entry.nodes.map((node) => node.target) }));
  }, selector);
  expect(violations).toEqual([]);
}
