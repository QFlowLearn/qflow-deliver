import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";
import accessibilityManifestXml from "../../../tests/fixtures/qti/accessibility-catalog-assessment/imsmanifest.xml?raw";
import accessibilityItemXml from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/media-supports.xml?raw";
import accessibilityNoCatalogItemXml from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/no-catalog-supports.xml?raw";
import accessibilityCaptionVtt from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/captions/presentation-en.vtt?raw";
import accessibilityTranscriptHtml from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/transcripts/presentation-en.html?raw";
import accessibilityPresentationMp4 from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/media/presentation.mp4?raw";
import accessibilityDescribedMp4 from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/media/described.mp4?raw";
import accessibilitySignLanguageMp4 from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/media/sign-language.mp4?raw";
import accessibilityGlossaryHtml from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/glossary/missing.html?raw";
import accessibilityStylesheetCss from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/styles/accessibility.css?raw";
import accessibilityTranslationFr from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/translations/photosynthesis-fr.txt?raw";
import accessibilityTranslationDe from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/translations/photosynthesis-de.mp3?raw";
import accessibilityTranslationEs from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/translations/photosynthesis-es.mp4?raw";
import accessibilityTranslationJa from "../../../tests/fixtures/qti/accessibility-catalog-assessment/items/translations/photosynthesis-ja.pdf?raw";

const scoredFeedbackItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="Addition Warmup" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response><qti-value>B</qti-value></qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="A">3</qti-simple-choice>
      <qti-simple-choice identifier="B">4</qti-simple-choice>
    </qti-choice-interaction>
    <qti-feedback-inline outcome-identifier="FEEDBACK" identifier="CORRECT" show-hide="show">Correct</qti-feedback-inline>
    <qti-feedback-block outcome-identifier="FEEDBACK" identifier="SOLUTION" show-hide="show">The answer is 4.</qti-feedback-block>
  </qti-item-body>
  <qti-modal-feedback outcome-identifier="FEEDBACK" identifier="SOLUTION" show-hide="show">Solution details.</qti-modal-feedback>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

const adaptiveFeedbackItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="Adaptive Warmup" adaptive="true" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response><qti-value>B</qti-value></qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>0</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-outcome-declaration identifier="FEEDBACK" cardinality="single" base-type="identifier"/>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="A">3</qti-simple-choice>
      <qti-simple-choice identifier="B">4</qti-simple-choice>
    </qti-choice-interaction>
    <qti-feedback-block outcome-identifier="FEEDBACK" identifier="TRY_AGAIN" show-hide="show">Try again with the next hint.</qti-feedback-block>
  </qti-item-body>
  <qti-response-processing>
    <qti-response-condition>
      <qti-response-if>
        <qti-match>
          <qti-variable identifier="RESPONSE"/>
          <qti-correct identifier="RESPONSE"/>
        </qti-match>
        <qti-set-outcome-value identifier="SCORE">
          <qti-base-value base-type="float">1</qti-base-value>
        </qti-set-outcome-value>
        <qti-set-outcome-value identifier="completionStatus">
          <qti-base-value base-type="identifier">completed</qti-base-value>
        </qti-set-outcome-value>
      </qti-response-if>
      <qti-response-else>
        <qti-set-outcome-value identifier="FEEDBACK">
          <qti-base-value base-type="identifier">TRY_AGAIN</qti-base-value>
        </qti-set-outcome-value>
      </qti-response-else>
    </qti-response-condition>
  </qti-response-processing>
</qti-assessment-item>`;

const stimulusManifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="pkg-stimulus">
  <metadata><schema>QTI Package</schema><schemaversion>3.0.0</schemaversion></metadata>
  <organizations>
    <organization identifier="org-1">
      <title>Stimulus Assessment</title>
      <item identifier="org-r001" identifierref="R001"/>
      <item identifier="org-l001" identifierref="L001"/>
    </organization>
  </organizations>
  <resources>
    <resource identifier="R001" type="imsqti_item_xmlv3p0" href="items/R001.xml">
      <file href="items/R001.xml"/>
      <dependency identifierref="R_STIM_001"/>
    </resource>
    <resource identifier="L001" type="imsqti_item_xmlv3p0" href="items/L001.xml">
      <file href="items/L001.xml"/>
      <dependency identifierref="L_STIM_001"/>
    </resource>
    <resource identifier="R_STIM_001" type="imsqti_stimulus_xmlv3p0" href="stimuli/R_STIM_001.xml">
      <file href="stimuli/R_STIM_001.xml"/>
    </resource>
    <resource identifier="L_STIM_001" type="imsqti_stimulus_xmlv3p0" href="stimuli/L_STIM_001.xml">
      <file href="stimuli/L_STIM_001.xml"/>
      <dependency identifierref="media-L-STIM-001-mp3"/>
    </resource>
    <resource identifier="media-L-STIM-001-mp3" type="webcontent" href="media/L_STIM_001.mp3">
      <file href="media/L_STIM_001.mp3"/>
    </resource>
  </resources>
</manifest>`;

const readingStimulusItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="R001" title="R001 Academic Reading" time-dependent="false">
  <qti-assessment-stimulus-ref identifier="R_STIM_001" href="../stimuli/R_STIM_001.xml" title="Urban Heat And Green Infrastructure"/>
  <qti-item-body>
    <div class="qti-shared-stimulus" data-stimulus-idref="R_STIM_001"></div>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-prompt>Which statement best expresses the main idea of the passage?</qti-prompt>
      <qti-simple-choice identifier="A">Cooling centers solve the problem.</qti-simple-choice>
      <qti-simple-choice identifier="B">Green infrastructure works best as part of a broader planning strategy.</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
</qti-assessment-item>`;

const listeningStimulusItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="L001" title="L001 Academic Listening" time-dependent="false">
  <qti-assessment-stimulus-ref identifier="L_STIM_001" href="../stimuli/L_STIM_001.xml" title="Lecture Script: Sleep And Memory"/>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-prompt>What is the lecture mainly about?</qti-prompt>
      <qti-simple-choice identifier="A">Study schedules</qti-simple-choice>
      <qti-simple-choice identifier="B">Sleep and memory</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
</qti-assessment-item>`;

const readingStimulusXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-stimulus xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="R_STIM_001" title="Urban Heat And Green Infrastructure">
  <qti-stimulus-body>
    <p>Cities often become warmer than nearby rural areas because buildings, roads, and other hard surfaces absorb solar energy.</p>
    <p>Green infrastructure can reduce urban heat, but it works best as part of a broader planning strategy.</p>
  </qti-stimulus-body>
</qti-assessment-stimulus>`;

const listeningStimulusXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-stimulus xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="L_STIM_001" title="Lecture Script: Sleep And Memory">
  <qti-stimulus-body>
    <object data="../media/L_STIM_001.mp3" type="audio/mpeg">Listening lecture audio</object>
    <p>Sleep can support memory and academic learning.</p>
  </qti-stimulus-body>
</qti-assessment-stimulus>`;

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "attempt_evidence_events",
    "attempt_deadline_jobs",
    "attempt_entries",
    "access_codes",
    "delivery_artifacts",
    "assessment_versions",
    "assessments",
  ];

  const tables = await HARBOR_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${knownTables
      .map(() => "?")
      .join(", ")})`,
  )
    .bind(...knownTables)
    .all<{ name: string }>();

  const deleteStatements = knownTables
    .filter((tableName) => tables.results.some((table) => table.name === tableName))
    .map((tableName) => `DELETE FROM ${tableName}`);

  if (deleteStatements.length > 0) {
    await HARBOR_DB.exec(`${deleteStatements.join("; ")};`);
  }

  let cursor: string | undefined;
  do {
    const listed = await CONTENT_BUCKET.list({ cursor });
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function createFixturePackage(input?: { itemXml?: string }): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", input?.itemXml ?? itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  if (input?.itemXml === scoredFeedbackItemXml) {
    zip.file(
      "imsmanifest.xml",
      manifestXml.replace(
        "<resources>",
        '<resources><resource identifier="feedback-test" type="imsqti_test_xmlv3p0" href="assessment.xml"><file href="assessment.xml"/><dependency identifierref="item-1-resource"/></resource>',
      ),
    );
    zip.file(
      "assessment.xml",
      '<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="feedback-test" title="Feedback"><qti-test-part identifier="part" navigation-mode="nonlinear" submission-mode="individual"><qti-assessment-section identifier="section" title="Section" visible="true"><qti-assessment-item-ref identifier="ref" href="items/item-1.xml"><qti-item-session-control show-feedback="false"/></qti-assessment-item-ref></qti-assessment-section></qti-test-part></qti-assessment-test>',
    );
  }

  return zip.generateAsync({ type: "uint8array" });
}

async function createAccessibilityCatalogFixturePackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", accessibilityManifestXml);
  zip.file("items/media-supports.xml", accessibilityItemXml);
  zip.file("items/no-catalog-supports.xml", accessibilityNoCatalogItemXml);
  zip.file("items/captions/presentation-en.vtt", accessibilityCaptionVtt);
  zip.file("items/transcripts/presentation-en.html", accessibilityTranscriptHtml);
  zip.file("items/media/presentation.mp4", accessibilityPresentationMp4);
  zip.file("items/media/described.mp4", accessibilityDescribedMp4);
  zip.file("items/media/sign-language.mp4", accessibilitySignLanguageMp4);
  zip.file("items/glossary/missing.html", accessibilityGlossaryHtml);
  zip.file("items/styles/accessibility.css", accessibilityStylesheetCss);
  zip.file("items/translations/photosynthesis-fr.txt", accessibilityTranslationFr);
  zip.file("items/translations/photosynthesis-de.mp3", accessibilityTranslationDe);
  zip.file("items/translations/photosynthesis-es.mp4", accessibilityTranslationEs);
  zip.file("items/translations/photosynthesis-ja.pdf", accessibilityTranslationJa);
  return zip.generateAsync({ type: "uint8array" });
}

async function createStimulusFixturePackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", stimulusManifestXml);
  zip.file("items/R001.xml", readingStimulusItemXml);
  zip.file("items/L001.xml", listeningStimulusItemXml);
  zip.file("stimuli/R_STIM_001.xml", readingStimulusXml);
  zip.file("stimuli/L_STIM_001.xml", listeningStimulusXml);
  zip.file("media/L_STIM_001.mp3", "fake audio bytes");
  return zip.generateAsync({ type: "uint8array" });
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function getRequest(path: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
    }),
  );
}

async function publishFixture(): Promise<{ assessmentVersionId: string }> {
  const response = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=phase1", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment.zip",
        "x-harbor-tenant-id": "tenant_phase1",
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function publishAccessibilityCatalogFixture(): Promise<{
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=accessibility-catalog", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "accessibility-catalog-assessment.zip",
        "x-harbor-tenant-id": "tenant_phase1",
      },
      body: (await createAccessibilityCatalogFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function publishStimulusFixture(): Promise<{
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request("https://harbor.local/internal/publish?assessmentSlug=stimulus-assessment", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "stimulus-assessment.zip",
        "x-harbor-tenant-id": "tenant_phase1",
      },
      body: (await createStimulusFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function createPreviewAttempt(input: {
  assessmentVersionId: string;
}): Promise<{ attemptId: string }> {
  const launchResponse = await postJson("/api/launch/preview", {
    assessmentVersionId: input.assessmentVersionId,
    actor: {
      id: "preview_operator",
      displayName: "Instructor Preview",
    },
  });

  expect(launchResponse.status, await launchResponse.clone().text()).toBe(201);

  const launchBody = (await launchResponse.json()) as {
    bootstrapToken: string;
  };

  const bootstrapResponse = await postJson("/api/bootstrap", {
    bootstrapToken: launchBody.bootstrapToken,
  });

  expect(bootstrapResponse.status).toBe(200);
  return bootstrapResponse.json();
}

beforeEach(async () => {
  await resetBindings();
});

describe("immutable content delivery routes", () => {
  it("returns a lightweight manifest summary for a pinned attempt", async () => {
    const published = await publishFixture();
    const bootstrap = await createPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
    });

    const response = await getRequest(`/api/content/manifest?attemptId=${bootstrap.attemptId}`);

    expect(response.status).toBe(200);

    const manifest = (await response.json()) as {
      attemptId: string;
      assessmentVersionId: string;
      title: string;
      currentItemId: string;
      itemOrder: string[];
      items: Record<
        string,
        {
          id: string;
          title: string;
          itemHref: string;
          assetIds: string[];
          maxScore: number | null;
        }
      >;
      packageObjectKey?: string;
    };

    expect(manifest.attemptId).toBe(bootstrap.attemptId);
    expect(manifest.assessmentVersionId).toBe(published.assessmentVersionId);
    expect(manifest.title).toBe("Basic Assessment");
    expect(manifest.currentItemId).toBe("item-1");
    expect(manifest.itemOrder).toEqual(["item-1"]);
    expect(manifest.items["item-1"]).toMatchObject({
      id: "item-1",
      title: "Addition Warmup",
      itemHref: "items/item-1.xml",
      maxScore: null,
    });
    expect(manifest.packageObjectKey).toBeUndefined();
  });

  it("returns authored item references with immutable resolver assets", async () => {
    const published = await publishFixture();
    const bootstrap = await createPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
    });

    const itemResponse = await getRequest(
      `/api/content/items/item-1?attemptId=${bootstrap.attemptId}`,
    );

    expect(itemResponse.status).toBe(200);

    const itemPayload = (await itemResponse.json()) as {
      attemptId: string;
      assessmentVersionId: string;
      item: {
        id: string;
        title: string;
        xml: string;
        assets: Array<{
          id: string;
          href: string;
          url: string;
          mediaType: string;
        }>;
      };
    };

    expect(itemPayload.attemptId).toBe(bootstrap.attemptId);
    expect(itemPayload.assessmentVersionId).toBe(published.assessmentVersionId);
    expect(itemPayload.item.id).toBe("item-1");
    expect(itemPayload.item.title).toBe("Addition Warmup");
    expect(itemPayload.item.xml).toContain("../assets/stimulus.svg");

    const stimulusAsset = itemPayload.item.assets.at(0);
    expect(stimulusAsset).toBeDefined();
    if (!stimulusAsset) throw new Error("Fixture stimulus asset was not published.");
    const assetResponse = await getRequest(stimulusAsset.url);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toContain("image/svg+xml");
    expect(assetResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(await assetResponse.text()).toContain("Harbor math prompt banner");
  });

  it("serves delivery-safe item XML while preserving authoritative QTI in R2", async () => {
    const packageBytes = await createFixturePackage({
      itemXml: scoredFeedbackItemXml,
    });
    const republish = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/publish?assessmentSlug=scored-redaction", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "scored-redaction.zip",
          "x-harbor-tenant-id": "tenant_phase1",
        },
        body: packageBytes.buffer as ArrayBuffer,
      }),
    );
    expect(republish.status).toBe(201);
    const republished = await republish.json<{
      assessmentVersionId: string;
      manifestObjectKey: string;
    }>();
    const redactedBootstrap = await createPreviewAttempt({
      assessmentVersionId: republished.assessmentVersionId,
    });

    const itemResponse = await getRequest(
      `/api/content/items/item-1?attemptId=${redactedBootstrap.attemptId}`,
    );
    expect(itemResponse.status).toBe(200);
    const itemPayload = await itemResponse.json<{ item: { xml: string } }>();
    expect(itemPayload.item.xml).not.toContain("qti-correct-response");
    expect(itemPayload.item.xml).not.toContain("qti-response-processing");
    expect(itemPayload.item.xml).not.toContain("qti-feedback-inline");
    expect(itemPayload.item.xml).not.toContain("qti-feedback-block");
    expect(itemPayload.item.xml).not.toContain("qti-modal-feedback");

    const { CONTENT_BUCKET } = getTestEnv();
    const manifest = await (
      await CONTENT_BUCKET.get(republished.manifestObjectKey)
    )?.json<{
      items: Record<string, { objectKey: string; deliveryObjectKey: string }>;
    }>();
    const authoritativeXml = await CONTENT_BUCKET.get(manifest!.items["item-1"]!.objectKey);
    const deliveryXml = await CONTENT_BUCKET.get(manifest!.items["item-1"]!.deliveryObjectKey);
    expect(await authoritativeXml?.text()).toContain("qti-correct-response");
    expect(await deliveryXml?.text()).not.toContain("qti-correct-response");
  });

  it("serves adaptive item XML through server-side turn materialization", async () => {
    const packageBytes = await createFixturePackage({
      itemXml: adaptiveFeedbackItemXml,
    });
    const republish = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/publish?assessmentSlug=adaptive-delivery", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "adaptive-delivery.zip",
          "x-harbor-tenant-id": "tenant_phase1",
        },
        body: packageBytes.buffer as ArrayBuffer,
      }),
    );
    expect(republish.status).toBe(201);
    const republished = await republish.json<{
      assessmentVersionId: string;
      manifestObjectKey: string;
    }>();
    const bootstrap = await createPreviewAttempt({
      assessmentVersionId: republished.assessmentVersionId,
    });

    const firstView = await getRequest(
      `/api/content/items/item-1?attemptId=${bootstrap.attemptId}`,
    );
    expect(firstView.status).toBe(200);
    const firstPayload = await firstView.json<{ item: { xml: string } }>();
    expect(firstPayload.item.xml).not.toContain("qti-correct-response");
    expect(firstPayload.item.xml).not.toContain("qti-response-processing");
    expect(firstPayload.item.xml).not.toContain("Try again with the next hint.");

    const draft = await postJson(`/api/attempts/${bootstrap.attemptId}/events`, {
      attemptId: bootstrap.attemptId,
      eventId: "adaptive-draft",
      idempotencyKey: "adaptive-draft",
      sequenceNumber: 1,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_adaptive",
      itemRef: { itemId: "item-1", itemHref: "items/item-1.xml" },
      type: "response.changed",
      payload: {
        intent: "checkpoint",
        responseKey: "item-1",
        responseState: {
          itemState: {
            schema: "qti3.attempt-state.v1",
            itemIdentifier: "item-1",
            status: "suspended",
            responses: { RESPONSE: "A" },
            outcomes: {},
            validationMessages: [],
          },
        },
      },
    });
    expect(draft.status).toBe(200);
    const unprocessed = await getRequest(
      `/api/content/items/item-1?attemptId=${bootstrap.attemptId}`,
    );
    expect((await unprocessed.json<{ item: { xml: string } }>()).item.xml).toBe(
      firstPayload.item.xml,
    );

    const responseChanged = await postJson(`/api/attempts/${bootstrap.attemptId}/events`, {
      attemptId: bootstrap.attemptId,
      eventId: "evt_adaptive_response_01",
      idempotencyKey: "idem_adaptive_response_01",
      sequenceNumber: 2,
      clientTimestamp: "2026-03-26T22:01:00.000Z",
      clientSessionId: "client_session_adaptive",
      itemRef: {
        itemId: "item-1",
        itemHref: "items/item-1.xml",
      },
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE",
        responseState: {
          capturedAt: "2026-03-26T22:01:00.000Z",
          itemState: {
            responseVariables: [
              {
                identifier: "RESPONSE",
                value: "A",
              },
            ],
            outcomeVariables: [
              {
                identifier: "SCORE",
                value: 999,
              },
            ],
          },
        },
      },
    });
    expect(responseChanged.status).toBe(200);

    const secondView = await getRequest(
      `/api/content/items/item-1?attemptId=${bootstrap.attemptId}`,
    );
    expect(secondView.status).toBe(200);
    const secondPayload = await secondView.json<{ item: { xml: string } }>();
    expect(secondPayload.item.xml).toContain("Try again with the next hint.");
    expect(secondPayload.item.xml).not.toContain("qti-correct-response");
    expect(secondPayload.item.xml).not.toContain("qti-response-processing");

    const refreshView = await getRequest(
      `/api/content/items/item-1?attemptId=${bootstrap.attemptId}`,
    );
    expect(refreshView.status).toBe(200);
    const refreshPayload = await refreshView.json<{ item: { xml: string } }>();
    expect(refreshPayload.item.xml).toBe(secondPayload.item.xml);
  });

  it("imports catalog-backed accessibility assets and exposes item hrefs", async () => {
    const published = await publishAccessibilityCatalogFixture();
    const bootstrap = await createPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
    });

    const itemResponse = await getRequest(
      `/api/content/items/media-supports?attemptId=${bootstrap.attemptId}`,
    );

    expect(itemResponse.status).toBe(200);
    const itemPayload = (await itemResponse.json()) as {
      item: {
        href: string;
        xml: string;
        assets: Array<{
          id: string;
          href: string;
          url: string;
          mediaType: string;
        }>;
      };
    };
    const assetsByHref = new Map(itemPayload.item.assets.map((asset) => [asset.href, asset]));

    expect(itemPayload.item.href).toBe("items/media-supports.xml");
    expect(itemPayload.item.xml).toContain('src="media/presentation.mp4"');
    expect(itemPayload.item.xml).toContain('src="captions/presentation-en.vtt"');
    expect(itemPayload.item.xml).toContain(
      '<qti-stylesheet href="styles/accessibility.css" type="text/css"',
    );
    expect(assetsByHref.get("items/transcripts/presentation-en.html")).toMatchObject({
      mediaType: "text/html",
      url: expect.stringContaining("asset:presentation-en.html"),
    });
    expect(assetsByHref.get("items/captions/presentation-en.vtt")).toMatchObject({
      mediaType: "text/vtt",
      url: expect.stringContaining("asset:presentation-en.vtt"),
    });
    expect(assetsByHref.get("items/media/described.mp4")).toMatchObject({
      mediaType: "video/mp4",
      url: expect.stringContaining("asset:described.mp4"),
    });
    expect(assetsByHref.get("items/media/sign-language.mp4")).toMatchObject({
      mediaType: "video/mp4",
      url: expect.stringContaining("asset:sign-language.mp4"),
    });
    expect(assetsByHref.get("items/styles/accessibility.css")).toMatchObject({
      mediaType: "text/css",
      url: expect.stringContaining("asset:accessibility.css"),
    });
    expect(assetsByHref.get("items/translations/photosynthesis-fr.txt")).toMatchObject({
      mediaType: "application/octet-stream",
      url: expect.stringContaining("asset:photosynthesis-fr.txt"),
    });
  });

  it("inlines QTI assessment stimulus refs into delivered item XML", async () => {
    const published = await publishStimulusFixture();
    const bootstrap = await createPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
    });

    const readingResponse = await getRequest(
      `/api/content/items/R001?attemptId=${bootstrap.attemptId}`,
    );
    expect(readingResponse.status).toBe(200);
    const readingPayload = await readingResponse.json<{ item: { xml: string } }>();
    expect(readingPayload.item.xml).toContain("Cities often become warmer");
    expect(readingPayload.item.xml).toContain("Green infrastructure can reduce urban heat");
    expect(readingPayload.item.xml).toContain("harbor-assessment-stimulus");
    expect(readingPayload.item.xml).toContain('data-stimulus-idref="R_STIM_001"');
    expect(readingPayload.item.xml).not.toContain("qti-assessment-stimulus-ref");

    const listeningResponse = await getRequest(
      `/api/content/items/L001?attemptId=${bootstrap.attemptId}`,
    );
    expect(listeningResponse.status).toBe(200);
    const listeningPayload = await listeningResponse.json<{
      item: {
        xml: string;
        assets: Array<{ href: string; mediaType: string }>;
      };
    }>();
    expect(listeningPayload.item.xml).toContain("../media/L_STIM_001.mp3");
    expect(listeningPayload.item.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          href: "media/L_STIM_001.mp3",
          mediaType: "audio/mpeg",
        }),
      ]),
    );
  });
});
