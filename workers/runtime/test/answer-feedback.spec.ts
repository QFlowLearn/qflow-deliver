import JSZip from "jszip";
import feedbackItemXml from "../../../tests/fixtures/qti/answer-feedback/item-1.xml?raw";
import { exports as workerExports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import {
  assessmentTestManifestXml,
  assessmentTestXml,
  scoredItemTwoXml,
  getTestEnv,
  resetBindings,
  getJson,
  publishFixture,
  issueAccessCode,
  launchAccessCodeAttempt,
  submitAttempt,
  finalizeQueuedSubmit,
  buildSubmissionSummary,
} from "./history-fixture";
beforeEach(resetBindings);

async function feedbackPackage(policy: "true" | "false" | "unset"): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", assessmentTestManifestXml);
  const control = policy === "unset" ? "" : `<qti-item-session-control show-feedback="${policy}"/>`;
  zip.file(
    "assessment.xml",
    assessmentTestXml.replace(
      'identifier="itemref-1" href="items/item-1.xml"/>',
      `identifier="itemref-1" href="items/item-1.xml">${control}</qti-assessment-item-ref>`,
    ),
  );
  zip.file("items/item-1.xml", feedbackItemXml);
  zip.file("items/item-2.xml", scoredItemTwoXml);
  zip.file(
    "assets/correct.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text y="15">Correct image secret</text></svg>',
  );
  zip.file(
    "assets/incorrect.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text y="15">Incorrect image secret</text></svg>',
  );
  return zip.generateAsync({ type: "uint8array" });
}

it.each(["A", "B"])(
  "releases only matching authored explanations and media after authoritative submit (%s)",
  async (answer) => {
    const published = await publishFixture({
      tenantId: "tenant_feedback",
      assessmentSlug: "feedback",
      packageBytes: await feedbackPackage("true"),
    });
    const accessCode = await issueAccessCode(published.assessmentVersionId);
    const attempt = await launchAccessCodeAttempt({
      accessCode,
      actorId: "learner_feedback",
      actorDisplayName: "Feedback learner",
    });
    const endpoint = `/api/attempts/${attempt.attemptId}/feedback`;
    const manifestRow = await getTestEnv()
      .HARBOR_DB.prepare("SELECT manifest_object_key FROM attempt_entries WHERE id = ?")
      .bind(attempt.attemptId)
      .first<{ manifest_object_key: string }>();
    const manifestObject = await getTestEnv().CONTENT_BUCKET.get(manifestRow!.manifest_object_key);
    const manifest = await manifestObject!.json<{
      assets: Record<string, { id: string; href: string }>;
    }>();
    const assets = Object.values(manifest.assets);
    expect(assets).toHaveLength(2);
    expect(await (await getJson(endpoint)).json()).toEqual({ status: "withheld", items: [] });
    for (const asset of assets)
      expect(
        (await getJson(`/api/content/assets/${asset.id}?attemptId=${attempt.attemptId}`)).status,
      ).toBe(403);
    for (const path of [
      `/api/content/manifest?attemptId=${attempt.attemptId}`,
      `/api/content/items/item-1?attemptId=${attempt.attemptId}`,
      `/api/attempts/${attempt.attemptId}/history`,
    ]) {
      const payload = await (await getJson(path)).text();
      expect(payload).not.toContain("explanation secret");
      expect(payload).not.toContain("qti-correct-response");
      expect(payload).not.toContain("qti-set-outcome-value");
    }
    const submitted = await submitAttempt({
      attemptId: attempt.attemptId,
      currentItemRef: attempt.session.currentItemRef,
      clientSessionId: "client_learner_feedback",
      sequenceNumber: 1,
      submissionSummary: buildSubmissionSummary({ totalScore: 999, answeredItemCount: 2 }),
      submissionMaterialization: {
        itemOrder: ["item-1", "item-2"],
        testState: null,
        partStates: {},
        sectionStates: {},
        items: {
          "item-1": {
            itemId: "item-1",
            itemHref: "items/item-1.xml",
            itemTitle: "Feedback question",
            responseVariables: [{ identifier: "RESPONSE", value: answer }],
            outcomeVariables: [
              { identifier: "RESPONSE_FEEDBACK", value: answer === "A" ? "INCORRECT" : "CORRECT" },
              { identifier: "SCORE", value: 999 },
            ],
            validationMessages: [],
          },
          "item-2": {
            itemId: "item-2",
            itemHref: "items/item-2.xml",
            itemTitle: "President Two",
            responseVariables: [{ identifier: "RESPONSE", value: "B" }],
            outcomeVariables: [],
            validationMessages: [],
          },
        },
      },
      captureQueue: true,
    });
    expect(await (await getJson(endpoint)).json()).toEqual({ status: "pending", items: [] });
    await finalizeQueuedSubmit(submitted.queuedEnvelope!);
    const released = await getJson(endpoint),
      payload = await released.text();
    expect(released.headers.get("cache-control")).toBe("private, no-store");
    const selected = answer === "A" ? "Correct" : "Incorrect",
      hidden = answer === "A" ? "Incorrect" : "Correct";
    expect(payload).toContain(`${selected} explanation secret`);
    expect(payload).not.toContain(`${hidden} explanation secret`);
    expect(payload).not.toContain("qti-correct-response");
    expect(payload).not.toContain("outcomeVariables");
    expect(payload).not.toContain("RESPONSE_FEEDBACK");
    for (const asset of assets) {
      const response = await getJson(
        `/api/content/assets/${asset.id}?attemptId=${attempt.attemptId}`,
      );
      const matching =
        asset.href.endsWith(answer === "A" ? "correct.svg" : "incorrect.svg") &&
        !(answer === "A" && asset.href.endsWith("incorrect.svg"));
      expect(response.status).toBe(matching ? 200 : 403);
      if (matching) {
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(await response.text()).toContain(`${selected} image secret`);
      }
    }
  },
);

it("requires explicit feedback release configuration at publication", async () => {
  const response = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=feedback-missing-policy", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-tenant-id": "tenant_feedback_missing",
      },
      body: (await feedbackPackage("unset")).buffer as ArrayBuffer,
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.text()).toContain("explicit show-feedback");
});

it("never releases explanations or feedback files for a suppressed assessment, including after submit", async () => {
  const published = await publishFixture({
    tenantId: "tenant_feedback_never",
    assessmentSlug: "feedback-never",
    packageBytes: await feedbackPackage("false"),
  });
  const accessCode = await issueAccessCode(published.assessmentVersionId);
  const attempt = await launchAccessCodeAttempt({
    accessCode,
    actorId: "learner_never",
    actorDisplayName: "Learner",
  });
  const submitted = await submitAttempt({
    attemptId: attempt.attemptId,
    currentItemRef: attempt.session.currentItemRef,
    clientSessionId: "client_learner_never",
    sequenceNumber: 1,
    submissionSummary: buildSubmissionSummary({ totalScore: 1, answeredItemCount: 2 }),
    captureQueue: true,
  });
  await finalizeQueuedSubmit(submitted.queuedEnvelope!);
  const manifestRow = await getTestEnv()
    .HARBOR_DB.prepare("SELECT manifest_object_key FROM attempt_entries WHERE id = ?")
    .bind(attempt.attemptId)
    .first<{ manifest_object_key: string }>();
  const manifest = await (await getTestEnv().CONTENT_BUCKET.get(
    manifestRow!.manifest_object_key,
  ))!.json<{ assets: Record<string, { id: string }> }>();
  for (const asset of Object.values(manifest.assets))
    expect(
      (await getJson(`/api/content/assets/${asset.id}?attemptId=${attempt.attemptId}`)).status,
    ).toBe(403);
  expect(await (await getJson(`/api/attempts/${attempt.attemptId}/feedback`)).json()).toEqual({
    status: "withheld",
    items: [],
  });
});
