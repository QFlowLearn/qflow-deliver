import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";

const workerOrigin = "http://127.0.0.1:8787";
const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/basic-assessment-multi");

async function createFixturePackage(options?: {
  assessmentTest?: boolean;
  requiredFirstItem?: boolean;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "imsmanifest.xml",
    options?.assessmentTest
      ? `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="basic-assessment-test-package" xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1">
  <metadata>
    <schema>QTI Package</schema>
    <schemaversion>3.0.0</schemaversion>
  </metadata>
  <organizations/>
  <resources>
    <resource identifier="test-resource" type="imsqti_test_xmlv3p0" href="assessment.xml">
      <file href="assessment.xml"/>
      <dependency identifierref="item-1-resource"/>
      <dependency identifierref="item-2-resource"/>
    </resource>
    <resource identifier="item-1-resource" type="imsqti_item_xmlv3p0" href="items/item-1.xml">
      <file href="items/item-1.xml"/>
      <file href="assets/stimulus.svg"/>
    </resource>
    <resource identifier="item-2-resource" type="imsqti_item_xmlv3p0" href="items/item-2.xml">
      <file href="items/item-2.xml"/>
      <file href="assets/stimulus.svg"/>
    </resource>
  </resources>
</manifest>`
      : readFileSync(path.join(fixtureRoot, "imsmanifest.xml"), "utf8"),
  );
  if (options?.assessmentTest) {
    zip.file(
      "assessment.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="test-1" title="Basic Assessment Multi">
  <qti-test-part identifier="part-1" navigation-mode="nonlinear" submission-mode="individual">
    <qti-assessment-section identifier="section-1" title="Section 1" visible="true">
      <qti-assessment-item-ref identifier="itemref-1" href="items/item-1.xml"/>
      <qti-assessment-item-ref identifier="itemref-2" href="items/item-2.xml"/>
    </qti-assessment-section>
  </qti-test-part>
</qti-assessment-test>`,
    );
  }
  const itemOneXml = readFileSync(path.join(fixtureRoot, "items/item-1.xml"), "utf8");
  zip.file(
    "items/item-1.xml",
    options?.requiredFirstItem
      ? `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="item-1"
  title="Addition Warmup"
  adaptive="false"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>B</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value>
      <qti-value>1</qti-value>
    </qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-prompt>What is 2 + 2?</qti-prompt>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1" min-choices="1">
      <qti-simple-choice identifier="A">3</qti-simple-choice>
      <qti-simple-choice identifier="B">4</qti-simple-choice>
      <qti-simple-choice identifier="C">5</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`
      : itemOneXml,
  );
  zip.file("items/item-2.xml", readFileSync(path.join(fixtureRoot, "items/item-2.xml"), "utf8"));
  zip.file(
    "assets/stimulus.svg",
    readFileSync(path.join(fixtureRoot, "assets/stimulus.svg"), "utf8"),
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

test("Harbor advances to the next pinned item in the shell for a multi-question package", async ({
  page,
  request,
}, testInfo) => {
  const seed = `phase1-navigation-${testInfo.parallelIndex}-${Date.now()}`;
  const publishResponse = await request.post(
    `${workerOrigin}/internal/publish?assessmentSlug=${seed}`,
    {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment-multi.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: await createFixturePackage(),
    },
  );
  expect(publishResponse.status()).toBe(201);

  const published = (await publishResponse.json()) as {
    assessmentVersionId: string;
  };

  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
  await expect(page.getByText("What is 2 + 2?")).toBeVisible();
  await expect(page.getByTestId("previous-item-button")).toBeDisabled();
  await expect(page.getByTestId("next-item-button")).toBeEnabled();

  await page.getByTestId("next-item-button").click();

  await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
  await expect(page.getByTestId("current-item-id")).toHaveText("item-2");
  await expect(page.getByText("What is 5 - 2?")).toBeVisible();
  await expect(page.getByTestId("next-item-button")).toBeDisabled();
});

test("question navigator locks jumps while the current required item is unanswered", async ({
  page,
  request,
}, testInfo) => {
  const seed = `phase1-navigation-required-${testInfo.parallelIndex}-${Date.now()}`;
  const publishResponse = await request.post(
    `${workerOrigin}/internal/publish?assessmentSlug=${seed}`,
    {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment-required.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: await createFixturePackage({
        assessmentTest: true,
        requiredFirstItem: true,
      }),
    },
  );
  expect(publishResponse.status()).toBe(201);

  const published = (await publishResponse.json()) as {
    assessmentVersionId: string;
  };

  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
  await expect(page.getByText("What is 2 + 2?")).toBeVisible();

  const steps = page.getByTestId("item-progress-step");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(1)).toHaveAttribute("aria-disabled", "true");
  await expect(steps.nth(1)).toHaveAttribute("data-lock-reason", "item-validation");
  await expect(steps.nth(1)).toHaveAttribute("title", /answer current question first/);

  await steps.nth(1).click({ force: true });
  await expect(page.getByTestId("item-navigation-feedback")).toContainText(
    "Answer this question before moving to another question.",
  );
  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");

  await page.getByRole("radio", { name: "B. 4" }).click();
  await expect(steps.nth(1)).not.toHaveAttribute("aria-disabled", "true");
  await expect(steps.nth(1)).not.toHaveAttribute("data-lock-reason");

  await steps.nth(1).click();
  await expect(page.getByTestId("current-item-position")).toHaveText("Question 2 of 2");
});

test("question navigator uses roving focus and explains linear access locks", async ({
  page,
  request,
}, testInfo) => {
  const seed = `phase1-navigation-a11y-${testInfo.parallelIndex}-${Date.now()}`;
  const publishResponse = await request.post(
    `${workerOrigin}/internal/publish?assessmentSlug=${seed}`,
    {
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment-multi.zip",
        "x-harbor-tenant-id": `tenant_${seed}`,
      },
      data: await createFixturePackage(),
    },
  );
  expect(publishResponse.status()).toBe(201);

  const published = (await publishResponse.json()) as {
    assessmentVersionId: string;
  };

  await page.goto(`/?mode=preview&assessmentVersionId=${published.assessmentVersionId}`);

  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
  await expect(page.getByRole("toolbar", { name: "Question navigator" })).toBeVisible();

  const steps = page.getByTestId("item-progress-step");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toHaveAttribute("tabindex", "0");
  await expect(steps.nth(1)).toHaveAttribute("tabindex", "-1");
  await expect(steps.nth(1)).toHaveAttribute("aria-disabled", "true");

  await steps.nth(1).click({ force: true });
  await expect(page.getByTestId("item-navigation-feedback")).toContainText(
    "Linear delivery is active. Use Next to move to the next question in order.",
  );
  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");

  await steps.nth(0).focus();
  await expect(steps.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(steps.nth(1)).toBeFocused();
  await expect(steps.nth(0)).toHaveAttribute("tabindex", "-1");
  await expect(steps.nth(1)).toHaveAttribute("tabindex", "0");

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("item-navigation-feedback")).toContainText("Question locked");
  await expect(page.getByTestId("current-item-position")).toHaveText("Question 1 of 2");
});
