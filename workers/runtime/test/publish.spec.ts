import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import {
  buildImmutableVersionPrefix,
  DEFAULT_DELIVERY_POLICY_SNAPSHOT,
  DELIVERY_MANIFEST_SCHEMA_VERSION,
  IMMUTABLE_VERSION_PREFIX_TEMPLATE,
  type DeliveryManifest,
} from "@harbor/content-model";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const assessmentTestManifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="pkg-scored-test">
  <metadata>
    <schema>QTI Package</schema>
    <schemaversion>3.0.0</schemaversion>
  </metadata>
  <organizations/>
  <resources>
    <resource identifier="test-1" type="imsqti_test_xmlv3p0" href="assessment.xml">
      <file href="assessment.xml"/>
      <dependency identifierref="item-resource-1"/>
      <dependency identifierref="item-resource-2"/>
    </resource>
    <resource identifier="item-resource-1" type="imsqti_item_xmlv3p0" href="items/item-1.xml">
      <file href="items/item-1.xml"/>
    </resource>
    <resource identifier="item-resource-2" type="imsqti_item_xmlv3p0" href="items/item-2.xml">
      <file href="items/item-2.xml"/>
    </resource>
  </resources>
</manifest>`;

const assessmentTestXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="test-1" title="Scored Test Package">
  <qti-test-part identifier="part-1" navigation-mode="nonlinear" submission-mode="individual">
    <qti-assessment-section identifier="section-1" title="Section 1" visible="true">
      <qti-assessment-item-ref identifier="itemref-1" href="items/item-1.xml"/>
      <qti-assessment-item-ref identifier="itemref-2" href="items/item-2.xml"/>
    </qti-assessment-section>
  </qti-test-part>
</qti-assessment-test>`;

const scoredItemOneXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="President One" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>A</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-prompt>Who was the first U.S. President?</qti-prompt>
      <qti-simple-choice identifier="A">George Washington</qti-simple-choice>
      <qti-simple-choice identifier="B">John Adams</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

const scoredItemTwoXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-2" title="President Two" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>B</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-prompt>Who was the second U.S. President?</qti-prompt>
      <qti-simple-choice identifier="A">George Washington</qti-simple-choice>
      <qti-simple-choice identifier="B">John Adams</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

const hottextItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="Hottext Item" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>hot-1</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-hottext-interaction response-identifier="RESPONSE" max-choices="1">
      <p>Select the prime number: <qti-hottext identifier="hot-1">7</qti-hottext> or <qti-hottext identifier="hot-2">8</qti-hottext>.</p>
    </qti-hottext-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

const standardsManifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1"
          xmlns:csm="http://www.imsglobal.org/xsd/imsccv1p3/imscsmd_v1p0"
          identifier="pkg-standards">
  <metadata>
    <schema>QTI Package</schema>
    <schemaversion>3.0.0</schemaversion>
  </metadata>
  <organizations>
    <organization identifier="org-1">
      <title>Standards Package</title>
      <item identifier="org-item-1" identifierref="item-resource-1"/>
    </organization>
  </organizations>
  <resources>
    <resource identifier="item-resource-1" type="imsqti_item_xmlv3p0" href="items/item-1.xml">
      <metadata>
        <csm:curriculumStandardsMetadataSet>
          <csm:curriculumStandardsMetadata providerId="CASE">
            <csm:setOfGUIDs>
              <csm:labelledGUID>
                <csm:GUID>370850e6-46fa-11e7-9dcf-6ce999a3c328</csm:GUID>
                <csm:label>MA.5.FR.1.1 Add and subtract fractions.</csm:label>
                <csm:caseItemURI>https://case.example.org/ims/case/v1p0/CFItems/370850e6-46fa-11e7-9dcf-6ce999a3c328</csm:caseItemURI>
              </csm:labelledGUID>
            </csm:setOfGUIDs>
          </csm:curriculumStandardsMetadata>
        </csm:curriculumStandardsMetadataSet>
      </metadata>
      <file href="items/item-1.xml"/>
    </resource>
  </resources>
</manifest>`;

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

  await HARBOR_DB.exec(
    "DELETE FROM assessment_version_validation_findings; DELETE FROM assessment_item_standard_alignments; DELETE FROM assessment_item_metadata; DELETE FROM delivery_artifacts; DELETE FROM assessment_versions; DELETE FROM assessments;",
  );

  let cursor: string | undefined;
  do {
    const listed = await CONTENT_BUCKET.list({ cursor });
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function createFixturePackage(options?: {
  omitManifest?: boolean;
  omitItem?: boolean;
  omitAsset?: boolean;
  itemXml?: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();

  if (!options?.omitManifest) {
    zip.file("imsmanifest.xml", manifestXml);
  }
  if (!options?.omitItem) {
    zip.file("items/item-1.xml", options?.itemXml ?? itemXml);
  }
  if (!options?.omitAsset) {
    zip.file("assets/stimulus.svg", stimulusSvg);
  }

  return zip.generateAsync({ type: "uint8array" });
}

async function createStylesheetPackage(input: {
  href: string;
  declaredType?: string;
  assetPath?: string;
  stylesheet?: string;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file(
    "items/item-1.xml",
    itemXml.replace(
      "  <qti-item-body>",
      `  <qti-stylesheet href="${input.href}" type="${input.declaredType ?? "text/css"}"/>\n  <qti-item-body>`,
    ),
  );
  zip.file("assets/stimulus.svg", stimulusSvg);
  if (input.assetPath && input.stylesheet !== undefined) {
    zip.file(input.assetPath, input.stylesheet);
  }
  return zip.generateAsync({ type: "uint8array" });
}

async function createAssessmentTestPackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", assessmentTestManifestXml);
  zip.file("assessment.xml", assessmentTestXml);
  zip.file("items/item-1.xml", scoredItemOneXml);
  zip.file("items/item-2.xml", scoredItemTwoXml);
  return zip.generateAsync({ type: "uint8array" });
}

async function createDuplicateBasenameAssetPackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  const itemWithDuplicateBasenames = itemXml.replace(
    '<img src="../assets/stimulus.svg" alt="Decorative Harbor stimulus"/>',
    '<img src="../assets/icon.svg" alt="First icon"/><img src="../stimuli/icon.svg" alt="Second icon"/>',
  );
  const manifestWithDuplicateBasenames = manifestXml.replace(
    '<file href="assets/stimulus.svg"/>',
    '<file href="assets/icon.svg"/><file href="stimuli/icon.svg"/>',
  );
  zip.file("imsmanifest.xml", manifestWithDuplicateBasenames);
  zip.file("items/item-1.xml", itemWithDuplicateBasenames);
  zip.file("assets/icon.svg", stimulusSvg);
  zip.file("stimuli/icon.svg", stimulusSvg);
  return zip.generateAsync({ type: "uint8array" });
}

async function createTimedAssessmentTestPackage(options?: {
  invalid?: boolean;
  invalidSessionControl?: boolean;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  const invalid = options?.invalid === true;
  const timingManifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="pkg-timing">
  <metadata><schema>QTI Package</schema><schemaversion>3.0.0</schemaversion></metadata>
  <organizations/>
  <resources>
    <resource identifier="test-1" type="imsqti_test_xmlv3p0" href="assessment.xml">
      <file href="assessment.xml"/>
      <dependency identifierref="item-resource-1"/>
    </resource>
    <resource identifier="item-resource-1" type="imsqti_item_xmlv3p0" href="items/item-1.xml">
      <file href="items/item-1.xml"/>
    </resource>
  </resources>
</manifest>`;
  const timingAssessmentXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="timed-test" title="Timed Test">
  <qti-time-limits min-time="${invalid ? "-1" : "60"}" max-time="3600" allow-late-submission="${invalid ? "maybe" : "true"}"/>
  <qti-test-part identifier="part-1" navigation-mode="linear" submission-mode="simultaneous">
    <qti-time-limits max-time="1200"/>
    <qti-assessment-section identifier="section-1" title="Timed Section" visible="true">
      <qti-time-limits min-time="${invalid ? "90" : "30"}" max-time="60" allow-late-submission="false"/>
      <qti-assessment-item-ref identifier="itemref-1" href="items/item-1.xml">
        <qti-time-limits min-time="10" max-time="60" allow-late-submission="true"/>
        <qti-item-session-control max-attempts="2" allow-skipping="${options?.invalidSessionControl === true ? "maybe" : "false"}" show-feedback="false" validate-responses="true"/>
      </qti-assessment-item-ref>
    </qti-assessment-section>
  </qti-test-part>
</qti-assessment-test>`;
  const timedItemXml = scoredItemOneXml
    .replace('time-dependent="false"', 'time-dependent="true"')
    .replace(
      '<qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>',
      `<qti-response-processing>
    <qti-duration-lt>
      <qti-variable identifier="duration"/>
      <qti-base-value base-type="duration">PT60S</qti-base-value>
    </qti-duration-lt>
  </qti-response-processing>`,
    );

  zip.file("imsmanifest.xml", timingManifestXml);
  zip.file("assessment.xml", timingAssessmentXml);
  zip.file("items/item-1.xml", timedItemXml);
  return zip.generateAsync({ type: "uint8array" });
}

async function createStandardsPackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", standardsManifestXml);
  zip.file("items/item-1.xml", scoredItemOneXml);
  return zip.generateAsync({ type: "uint8array" });
}

async function publishFixture(input: {
  tenantId: string;
  assessmentSlug: string;
  packageBytes: Uint8Array;
  packageName?: string;
}): Promise<Response> {
  const request = new Request(
    `https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-tenant-id": input.tenantId,
        "x-harbor-package-name": input.packageName ?? "basic-assessment.zip",
      },
      body: input.packageBytes.buffer as ArrayBuffer,
    },
  );

  return workerExports.default.fetch(request);
}

beforeEach(async () => {
  await resetBindings();
});

describe("immutable publish contracts and schema", () => {
  it("creates one assessment_version parent key for immutable delivery artifacts", async () => {
    const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();

    expect(TEST_MIGRATIONS.length).toBeGreaterThan(0);
    await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

    const tables = await HARBOR_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string; sql: string }>();

    const tableNames = tables.results.map((table) => table.name);
    expect(tableNames).toContain("assessments");
    expect(tableNames).toContain("assessment_versions");
    expect(tableNames).toContain("delivery_artifacts");
    expect(tableNames).toContain("assessment_item_metadata");
    expect(tableNames).toContain("assessment_item_standard_alignments");
    expect(tableNames).toContain("assessment_version_validation_findings");

    const assessmentVersionTable = tables.results.find(
      (table) => table.name === "assessment_versions",
    );

    expect(assessmentVersionTable?.sql).toContain(
      'FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id")',
    );
    expect(assessmentVersionTable?.sql).toContain('UNIQUE ("assessment_id", "version_number")');
  });

  it("allows republishing the same assessment as append-only immutable versions", async () => {
    const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();

    expect(TEST_MIGRATIONS.length).toBeGreaterThan(0);
    await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

    await HARBOR_DB.prepare(
      "INSERT INTO assessments (id, tenant_id, slug, title, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "asmt_01",
        "tenant_demo",
        "basic-assessment",
        "Basic Assessment",
        "2026-03-25T00:00:00.000Z",
      )
      .run();

    for (const version of [
      { id: "vers_01", number: 1 },
      { id: "vers_02", number: 2 },
    ]) {
      await HARBOR_DB.prepare(
        "INSERT INTO assessment_versions (id, assessment_id, version_number, source_package_sha256, package_object_key, manifest_object_key, delivery_policy_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          version.id,
          "asmt_01",
          version.number,
          `sha-${version.number}`,
          `tenants/tenant_demo/assessments/asmt_01/versions/${version.id}/package/basic-assessment.zip`,
          `tenants/tenant_demo/assessments/asmt_01/versions/${version.id}/manifests/delivery.json`,
          JSON.stringify({ launchMode: "preview" }),
          "2026-03-25T00:00:00.000Z",
        )
        .run();
    }

    const versionCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM assessment_versions WHERE assessment_id = ?",
    )
      .bind("asmt_01")
      .first<{ count: number }>();

    expect(versionCount?.count).toBe(2);
  });

  it("defines stable manifest, item, and asset contracts with immutable object-key prefixes", () => {
    expect(DELIVERY_MANIFEST_SCHEMA_VERSION).toBe("2");
    expect(IMMUTABLE_VERSION_PREFIX_TEMPLATE).toBe(
      "tenants/{tenantId}/assessments/{assessmentId}/versions/{versionId}",
    );
    expect(DEFAULT_DELIVERY_POLICY_SNAPSHOT).toEqual({
      launchMode: "preview",
      navigationMode: "linear",
      maxAttempts: 1,
      timeLimitSeconds: null,
      standaloneAllowed: true,
      iframeAllowed: false,
      allowedEmbedOrigins: [],
      secureBrowserRequired: false,
      secureBrowserProviderHint: null,
      safeExamBrowser: null,
    });
    expect(
      buildImmutableVersionPrefix({
        tenantId: "tenant_demo",
        assessmentId: "asmt_01",
        versionId: "vers_01",
      }),
    ).toBe("tenants/tenant_demo/assessments/asmt_01/versions/vers_01");
  });

  it("publishes the fixture into D1 and R2 under one immutable version prefix", async () => {
    const packageBytes = await createFixturePackage();
    const response = await publishFixture({
      tenantId: "tenant_fixture",
      assessmentSlug: "basic-assessment",
      packageBytes,
    });

    expect(response.status).toBe(201);

    const payload = await response.json<{
      assessmentId: string;
      assessmentVersionId: string;
      packageObjectKey: string;
      manifestObjectKey: string;
      deliveryPolicySnapshot: typeof DEFAULT_DELIVERY_POLICY_SNAPSHOT;
      validation: {
        summary: {
          readyForDelivery: boolean;
          acceptedCount: number;
          acceptedWithWarningCount: number;
          acceptedPendingAdapterEvidenceCount: number;
          blockedCount: number;
        };
        findings: Array<{ category: string; code: string; targetId: string | null }>;
      };
    }>();

    const prefix = buildImmutableVersionPrefix({
      tenantId: "tenant_fixture",
      assessmentId: payload.assessmentId,
      versionId: payload.assessmentVersionId,
    });

    expect(payload.packageObjectKey).toBe(`${prefix}/package/basic-assessment.zip`);
    expect(payload.manifestObjectKey).toBe(`${prefix}/manifests/delivery.json`);
    expect(payload.deliveryPolicySnapshot).toEqual(DEFAULT_DELIVERY_POLICY_SNAPSHOT);
    expect(payload.validation.summary.readyForDelivery).toBe(true);
    expect(payload.validation.summary.blockedCount).toBe(0);
    expect(payload.validation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "accepted",
          code: "qti.package.manifest-present",
          targetId: "imsmanifest.xml",
        }),
        expect.objectContaining({
          category: "accepted",
          code: "qti.item.interaction-accepted",
          targetId: "item-1",
        }),
        expect.objectContaining({
          category: "accepted-with-warning",
          code: "qti.csm.standards-missing",
        }),
      ]),
    );

    const { CONTENT_BUCKET, HARBOR_DB } = getTestEnv();
    const bucketObjects = await CONTENT_BUCKET.list({ prefix });
    expect(bucketObjects.objects.map((object) => object.key).sort()).toEqual([
      `${prefix}/assets/stimulus.svg`,
      `${prefix}/delivery/items/item-1.xml`,
      `${prefix}/items/item-1.xml`,
      `${prefix}/manifests/delivery.json`,
      `${prefix}/package/basic-assessment.zip`,
    ]);

    const manifestObject = await CONTENT_BUCKET.get(payload.manifestObjectKey);
    const manifest = await manifestObject?.json<{
      itemOrder: string[];
      items: Record<
        string,
        {
          objectKey: string;
          deliveryObjectKey: string;
          assetIds: string[];
          maxScore: number | null;
        }
      >;
      assets: Record<string, { objectKey: string }>;
    }>();

    expect(manifest?.itemOrder).toEqual(["item-1"]);
    const stimulusAssetId = manifest?.items["item-1"]?.assetIds[0];
    expect(stimulusAssetId).toMatch(/^asset:stimulus\.svg:/);
    expect(manifest?.items["item-1"]).toMatchObject({
      objectKey: `${prefix}/items/item-1.xml`,
      deliveryObjectKey: `${prefix}/delivery/items/item-1.xml`,
      maxScore: null,
    });
    expect(stimulusAssetId ? manifest?.assets[stimulusAssetId] : undefined).toMatchObject({
      objectKey: `${prefix}/assets/stimulus.svg`,
    });

    const versionCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM assessment_versions",
    ).first<{ count: number }>();
    expect(versionCount?.count).toBe(1);

    const validationRows = await HARBOR_DB.prepare(
      "SELECT category, scope, code, target_id, metadata_json FROM assessment_version_validation_findings WHERE assessment_version_id = ? ORDER BY code",
    )
      .bind(payload.assessmentVersionId)
      .all<{
        category: string;
        scope: string;
        code: string;
        target_id: string | null;
        metadata_json: string;
      }>();

    expect(validationRows.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "accepted",
          scope: "manifest",
          code: "qti.package.shape.item-resources",
        }),
        expect.objectContaining({
          category: "accepted",
          scope: "asset",
          code: "qti.asset.media-supported",
          target_id: stimulusAssetId,
        }),
        expect.objectContaining({
          category: "accepted-with-warning",
          scope: "item",
          code: "qti.item.max-score-missing",
          target_id: "item-1",
        }),
      ]),
    );
  });

  it("publishes self-contained package-local CSS as an immutable delivery asset", async () => {
    const response = await publishFixture({
      tenantId: "tenant_stylesheet",
      assessmentSlug: "stylesheet-assessment",
      packageBytes: await createStylesheetPackage({
        href: "../assets/item.css",
        assetPath: "assets/item.css",
        stylesheet: ".qti3-prompt { color: rgb(19 78 74); }",
      }),
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{ manifestObjectKey: string }>();
    const manifestObject = await getTestEnv().CONTENT_BUCKET.get(payload.manifestObjectKey);
    const manifest = await manifestObject?.json<DeliveryManifest>();
    const stylesheetAsset = Object.values(manifest?.assets ?? {}).find(
      (asset) => asset.href === "assets/item.css",
    );
    expect(stylesheetAsset).toMatchObject({
      href: "assets/item.css",
      mediaType: "text/css",
    });
    expect(manifest?.items["item-1"]?.assetIds).toContain(stylesheetAsset?.id);
    if (!stylesheetAsset) throw new Error("Expected published stylesheet asset.");
    const deliveredStylesheet = await getTestEnv().CONTENT_BUCKET.get(stylesheetAsset.objectKey);
    await expect(deliveredStylesheet?.text()).resolves.toContain(
      ":where(qti-assessment-item-player) .qti3-prompt",
    );
  });

  it("assigns distinct manifest identities to assets with the same basename", async () => {
    const response = await publishFixture({
      tenantId: "tenant_asset_identity",
      assessmentSlug: "duplicate-basename-assets",
      packageBytes: await createDuplicateBasenameAssetPackage(),
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{ manifestObjectKey: string }>();
    const manifestObject = await getTestEnv().CONTENT_BUCKET.get(payload.manifestObjectKey);
    const manifest = await manifestObject?.json<DeliveryManifest>();
    const itemAssetIds = manifest?.items["item-1"]?.assetIds ?? [];
    expect(new Set(itemAssetIds).size).toBe(2);
    expect(itemAssetIds.every((assetId) => manifest?.assets[assetId] !== undefined)).toBe(true);
    expect(
      Object.values(manifest?.assets ?? {})
        .map((asset) => asset.href)
        .sort(),
    ).toEqual(["assets/icon.svg", "stimuli/icon.svg"]);
  });

  it.each([
    {
      label: "external URL",
      href: "https://example.test/item.css",
      error: "external",
    },
    {
      label: "query string",
      href: "../assets/item.css?v=1",
      error: "query",
    },
    {
      label: "path traversal",
      href: "../../outside.css",
      error: "path-traversal",
    },
    {
      label: "unsupported media type",
      href: "../assets/item.html",
      assetPath: "assets/item.html",
      stylesheet: ".prompt { color: black; }",
      error: "media type must be text/css",
    },
    {
      label: "unsupported declared media type",
      href: "../assets/item.css",
      declaredType: "text/less",
      assetPath: "assets/item.css",
      stylesheet: ".prompt { color: black; }",
      error: "media type must be text/css",
    },
    {
      label: "missing asset",
      href: "../assets/missing.css",
      error: "assets/missing.css",
    },
    {
      label: "escaped external CSS construct",
      href: "../assets/item.css",
      assetPath: "assets/item.css",
      stylesheet: '.prompt { background: u\\72l("https://example.test/image.png"); }',
      error: "Stylesheet url references are not allowed",
    },
  ])(
    "rejects a stylesheet with $label",
    async ({ label, href, declaredType, assetPath, stylesheet, error }) => {
      const response = await publishFixture({
        tenantId: `tenant_stylesheet_rejection_${label.replaceAll(" ", "_")}`,
        assessmentSlug: `stylesheet-rejection-${label.replaceAll(" ", "-")}`,
        packageBytes: await createStylesheetPackage({
          href,
          declaredType,
          assetPath,
          stylesheet,
        }),
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining(error),
      });
    },
  );

  it("blocks template-generated correct responses for secure delivery", async () => {
    const packageBytes = await createFixturePackage({
      itemXml: scoredItemOneXml.replace(
        "<qti-item-body>",
        `<qti-template-processing>
  <qti-set-correct-response identifier="RESPONSE">
    <qti-base-value base-type="identifier">A</qti-base-value>
  </qti-set-correct-response>
</qti-template-processing>
<qti-item-body>`,
      ),
    });
    const response = await publishFixture({
      tenantId: "tenant_template_block",
      assessmentSlug: "template-block",
      packageBytes,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("not supported for secure delivery"),
    });
  });

  it("accepts adaptive response processing through server-side turn materialization", async () => {
    const packageBytes = await createFixturePackage({
      itemXml: scoredItemOneXml.replace('adaptive="false"', 'adaptive="true"'),
    });
    const response = await publishFixture({
      tenantId: "tenant_adaptive_server_turn",
      assessmentSlug: "adaptive-server-turn",
      packageBytes,
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{ manifestObjectKey: string }>();
    const { CONTENT_BUCKET } = getTestEnv();
    const manifestObject = await CONTENT_BUCKET.get(payload.manifestObjectKey);
    const manifest = await manifestObject!.json<DeliveryManifest>();
    const item = manifest.items["item-1"];
    expect(item).toBeTruthy();

    const authoritativeXml = await (await CONTENT_BUCKET.get(item!.objectKey))!.text();
    const deliveryXml = await (await CONTENT_BUCKET.get(item!.deliveryObjectKey))!.text();
    expect(authoritativeXml).toMatch(/adaptive="true"/);
    expect(authoritativeXml).toMatch(/<qti-response-processing\b/);
    expect(deliveryXml).not.toMatch(/<qti-response-processing\b/);
    expect(deliveryXml).not.toMatch(/<qti-correct-response\b/);
  });

  it("classifies qti3 player-supported interactions with compliance states instead of unsupported language", async () => {
    const packageBytes = await createFixturePackage({
      itemXml: hottextItemXml,
    });
    const response = await publishFixture({
      tenantId: "tenant_hottext",
      assessmentSlug: "hottext-assessment",
      packageBytes,
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{
      validation: {
        summary: {
          acceptedPendingAdapterEvidenceCount: number;
          blockedCount: number;
        };
        findings: Array<{
          category: string;
          code: string;
          message: string;
          metadata: Record<string, unknown>;
        }>;
      };
    }>();

    expect(payload.validation.summary.blockedCount).toBe(0);
    expect(payload.validation.summary.acceptedPendingAdapterEvidenceCount).toBe(1);
    expect(payload.validation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "accepted-pending-adapter-evidence",
          code: "qti.item.interaction-qti3-player-supported",
          metadata: expect.objectContaining({
            interactionType: "hottext-interaction",
            qti3PlayerSupported: true,
            harborValidated: false,
          }),
        }),
      ]),
    );
  });

  it("republishes the same package as a new immutable version and returns durable launch metadata", async () => {
    const packageBytes = await createFixturePackage();
    const first = await publishFixture({
      tenantId: "tenant_republish",
      assessmentSlug: "basic-assessment",
      packageBytes,
    });
    const second = await publishFixture({
      tenantId: "tenant_republish",
      assessmentSlug: "basic-assessment",
      packageBytes,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstPayload = await first.json<{
      assessmentId: string;
      assessmentVersionId: string;
      manifestObjectKey: string;
    }>();
    const secondPayload = await second.json<{
      assessmentId: string;
      assessmentVersionId: string;
      manifestObjectKey: string;
      deliveryPolicySnapshot: typeof DEFAULT_DELIVERY_POLICY_SNAPSHOT;
    }>();

    expect(secondPayload.assessmentId).toBe(firstPayload.assessmentId);
    expect(secondPayload.assessmentVersionId).not.toBe(firstPayload.assessmentVersionId);
    expect(secondPayload.manifestObjectKey).not.toBe(firstPayload.manifestObjectKey);
    expect(secondPayload.deliveryPolicySnapshot).toEqual(DEFAULT_DELIVERY_POLICY_SNAPSHOT);

    const { HARBOR_DB } = getTestEnv();
    const versions = await HARBOR_DB.prepare(
      "SELECT id, version_number FROM assessment_versions WHERE assessment_id = ? ORDER BY version_number",
    )
      .bind(firstPayload.assessmentId)
      .all<{ id: string; version_number: number }>();

    expect(versions.results).toEqual([
      { id: firstPayload.assessmentVersionId, version_number: 1 },
      { id: secondPayload.assessmentVersionId, version_number: 2 },
    ]);
  });

  it("retains unsupported and invalid timing packages for inspection but refuses to launch them", async () => {
    for (const [index, options] of [
      {},
      { invalid: true },
      { invalidSessionControl: true },
    ].entries()) {
      const response = await publishFixture({
        tenantId: `blocked_launch_${index}`,
        assessmentSlug: "blocked-timing",
        packageBytes: await createTimedAssessmentTestPackage(options),
      });
      expect(response.status).toBe(201);
      const version = await response.json<{
        assessmentVersionId: string;
        manifestObjectKey: string;
      }>();
      const launch = await workerExports.default.fetch(
        new Request("https://harbor.local/api/launch/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "preview",
            assessmentVersionId: version.assessmentVersionId,
            actor: { kind: "preview-operator", id: "blocked-reader", displayName: "Reader" },
          }),
        }),
      );
      expect(launch.status, await launch.clone().text()).toBe(409);
      expect(await launch.text()).toContain("unresolved delivery blockers");
      const { HARBOR_DB, CONTENT_BUCKET } = getTestEnv();
      expect(await CONTENT_BUCKET.head(version.manifestObjectKey)).not.toBeNull();
      expect(
        await HARBOR_DB.prepare(
          "SELECT COUNT(*) AS count FROM attempt_entries WHERE assessment_version_id = ?",
        )
          .bind(version.assessmentVersionId)
          .first(),
      ).toMatchObject({ count: 0 });
    }
  });

  it("does not publish a fixed route that would discard authored test behavior", async () => {
    const unsupported = [
      assessmentTestXml.replace(
        "<qti-assessment-item-ref",
        '<qti-selection select="1"/><qti-assessment-item-ref',
      ),
      assessmentTestXml.replace(
        "<qti-assessment-item-ref",
        '<qti-rubric-block view="candidate" use="instructions"><qti-content-body><qti-printed-variable identifier="SCORE"/></qti-content-body></qti-rubric-block><qti-assessment-item-ref',
      ),
      assessmentTestXml.replace('visible="true"', 'visible="false"'),
      assessmentTestXml.replace(
        "<qti-test-part",
        '<qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/><qti-test-part',
      ),
    ];
    for (const [index, xml] of unsupported.entries()) {
      const zip = await JSZip.loadAsync(await createAssessmentTestPackage());
      zip.file("assessment.xml", xml);
      const response = await publishFixture({
        tenantId: `unsupported_test_${index}`,
        assessmentSlug: "unsupported",
        packageBytes: await zip.generateAsync({ type: "uint8array" }),
      });
      expect(response.status, await response.clone().text()).toBe(422);
    }
    const { HARBOR_DB, CONTENT_BUCKET } = getTestEnv();
    expect(
      await HARBOR_DB.prepare("SELECT COUNT(*) AS count FROM assessment_versions").first(),
    ).toMatchObject({ count: 0 });
    expect((await CONTENT_BUCKET.list()).objects).toHaveLength(0);
  });

  it("publishes QTI assessment-test packages that declare item order in assessment.xml", async () => {
    const packageBytes = await createAssessmentTestPackage();
    const response = await publishFixture({
      tenantId: "tenant_assessment_test",
      assessmentSlug: "scored-test-package",
      packageBytes,
      packageName: "scored-test-package.zip",
    });

    expect(response.status).toBe(201);

    const payload = await response.json<{
      assessmentId: string;
      assessmentVersionId: string;
      manifestObjectKey: string;
      deliveryPolicySnapshot: typeof DEFAULT_DELIVERY_POLICY_SNAPSHOT;
    }>();

    expect(payload.deliveryPolicySnapshot.navigationMode).toBe("free");

    const { CONTENT_BUCKET } = getTestEnv();
    const manifestObject = await CONTENT_BUCKET.get(payload.manifestObjectKey);
    const manifest = await manifestObject?.json<{
      title: string;
      itemOrder: string[];
      items: Record<string, { title: string; maxScore: number | null }>;
    }>();

    expect(manifest?.title).toBe("Scored Test Package");
    expect(manifest?.itemOrder).toEqual(["item-1", "item-2"]);
    expect(manifest?.items["item-1"]?.title).toBe("President One");
    expect(manifest?.items["item-2"]?.title).toBe("President Two");
    expect(manifest?.items["item-1"]?.maxScore).toBe(1);
    expect(manifest?.items["item-2"]?.maxScore).toBe(1);
  });

  it("parses QTI timing metadata, item-session-control, and time-dependent diagnostics", async () => {
    const packageBytes = await createTimedAssessmentTestPackage();
    const response = await publishFixture({
      tenantId: "tenant_timing_import",
      assessmentSlug: "timed-package",
      packageBytes,
      packageName: "timed-package.zip",
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{
      assessmentVersionId: string;
      manifestObjectKey: string;
      validation: {
        summary: {
          blockedCount: number;
          acceptedPendingAdapterEvidenceCount: number;
        };
        findings: Array<{ category: string; code: string; targetId: string | null }>;
      };
    }>();

    expect(payload.validation.summary.blockedCount).toBeGreaterThan(0);
    expect(payload.validation.summary.acceptedPendingAdapterEvidenceCount).toBeGreaterThan(0);
    expect(payload.validation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "accepted-pending-adapter-evidence",
          code: "qti.item.time-dependent-duration-scoring",
          targetId: "item-1",
        }),
        expect.objectContaining({
          category: "blocked",
          code: "qti.timing.item-session-control-parsed",
          targetId: null,
        }),
      ]),
    );

    const { CONTENT_BUCKET, HARBOR_DB } = getTestEnv();
    const version = await HARBOR_DB.prepare(
      "SELECT qti_timing_metadata_json FROM assessment_versions WHERE id = ?",
    )
      .bind(payload.assessmentVersionId)
      .first<{ qti_timing_metadata_json: string }>();
    const qtiTiming = JSON.parse(version?.qti_timing_metadata_json ?? "{}");

    expect(qtiTiming.assessmentTest.timeLimits).toMatchObject({
      minTimeSeconds: 60,
      maxTimeSeconds: 3600,
      allowLateSubmission: true,
    });
    expect(qtiTiming.testParts[0]).toMatchObject({
      identifier: "part-1",
      navigationMode: "linear",
      submissionMode: "simultaneous",
      timeLimits: {
        maxTimeSeconds: 1200,
        allowLateSubmission: false,
      },
    });
    expect(qtiTiming.sections[0].timeLimits).toMatchObject({
      minTimeSeconds: 30,
      maxTimeSeconds: 60,
      allowLateSubmission: false,
    });
    expect(qtiTiming.itemRefs[0]).toMatchObject({
      identifier: "itemref-1",
      itemId: "item-1",
      timeLimits: {
        minTimeSeconds: 10,
        maxTimeSeconds: 60,
        allowLateSubmission: true,
      },
      itemSessionControl: {
        maxAttempts: 2,
        allowSkipping: false,
        showFeedback: false,
        validateResponses: true,
      },
    });

    const itemMetadata = await HARBOR_DB.prepare(
      "SELECT time_dependent, qti_timing_metadata_json FROM assessment_item_metadata WHERE assessment_version_id = ? AND item_id = ?",
    )
      .bind(payload.assessmentVersionId, "item-1")
      .first<{ time_dependent: number; qti_timing_metadata_json: string }>();
    expect(itemMetadata?.time_dependent).toBe(1);
    expect(JSON.parse(itemMetadata?.qti_timing_metadata_json ?? "{}")).toMatchObject({
      timeDependent: true,
      durationExpressionTypes: ["qti-duration-lt"],
    });

    const manifestObject = await CONTENT_BUCKET.get(payload.manifestObjectKey);
    const manifest = await manifestObject?.json<{
      qtiTiming: unknown;
      items: Record<string, { timeDependent?: boolean }>;
    }>();
    expect(manifest?.items["item-1"]?.timeDependent).toBe(true);
    expect(manifest?.qtiTiming).toBeTruthy();
  });

  it("diagnoses invalid QTI timing semantics without silently accepting them", async () => {
    const packageBytes = await createTimedAssessmentTestPackage({ invalid: true });
    const response = await publishFixture({
      tenantId: "tenant_timing_invalid",
      assessmentSlug: "invalid-timed-package",
      packageBytes,
      packageName: "invalid-timed-package.zip",
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{
      validation: {
        summary: {
          readyForDelivery: boolean;
          blockedCount: number;
        };
        findings: Array<{
          category: string;
          code: string;
          metadata: Record<string, unknown>;
        }>;
      };
    }>();

    expect(payload.validation.summary.readyForDelivery).toBe(false);
    expect(payload.validation.summary.blockedCount).toBeGreaterThan(0);
    expect(payload.validation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "blocked",
          code: "qti.timing.time-limits-invalid",
          metadata: expect.objectContaining({
            invalidNumberAttributes: ["min-time"],
            invalidAllowLate: true,
          }),
        }),
        expect.objectContaining({
          category: "blocked",
          code: "qti.timing.time-limits-invalid",
          metadata: expect.objectContaining({
            minGreaterThanMax: true,
          }),
        }),
      ]),
    );
  });

  it("maps nonfatal qti3 package diagnostics into blocked Harbor readiness findings", async () => {
    const response = await publishFixture({
      tenantId: "tenant_session_control_invalid",
      assessmentSlug: "invalid-session-control-package",
      packageBytes: await createTimedAssessmentTestPackage({ invalidSessionControl: true }),
      packageName: "invalid-session-control-package.zip",
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{
      validation: {
        summary: { readyForDelivery: boolean; blockedCount: number };
        findings: Array<{
          category: string;
          code: string;
          metadata: Record<string, unknown>;
        }>;
      };
    }>();

    expect(payload.validation.summary.readyForDelivery).toBe(false);
    expect(payload.validation.summary.blockedCount).toBeGreaterThan(0);
    expect(payload.validation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "blocked",
          code: "qti.package.diagnostic",
          metadata: expect.objectContaining({
            diagnosticCode: "package.attribute.allow-skipping.boolean",
            severity: "error",
          }),
        }),
      ]),
    );
  });

  it("snapshots item standards from QTI package CSM metadata", async () => {
    const packageBytes = await createStandardsPackage();
    const response = await publishFixture({
      tenantId: "tenant_standards",
      assessmentSlug: "standards-package",
      packageBytes,
      packageName: "standards-package.zip",
    });

    expect(response.status).toBe(201);
    const payload = await response.json<{
      assessmentVersionId: string;
    }>();

    const { HARBOR_DB } = getTestEnv();
    const itemMetadata = await HARBOR_DB.prepare(
      "SELECT assessment_version_id, item_id, item_identifier, item_title, item_type, max_score, metadata_json FROM assessment_item_metadata WHERE assessment_version_id = ?",
    )
      .bind(payload.assessmentVersionId)
      .first<{
        assessment_version_id: string;
        item_id: string;
        item_identifier: string;
        item_title: string;
        item_type: string | null;
        max_score: number | null;
        metadata_json: string;
      }>();

    expect(itemMetadata).toMatchObject({
      assessment_version_id: payload.assessmentVersionId,
      item_id: "item-1",
      item_identifier: "item-1",
      item_title: "President One",
      item_type: "qti-choice-interaction",
      max_score: 1,
    });
    expect(JSON.parse(itemMetadata?.metadata_json ?? "{}")).toMatchObject({
      standardCount: 1,
    });

    const standards = await HARBOR_DB.prepare(
      "SELECT assessment_version_id, item_id, standard_id, standard_code, standard_label, standard_uri, provider_id, metadata_json FROM assessment_item_standard_alignments WHERE assessment_version_id = ?",
    )
      .bind(payload.assessmentVersionId)
      .all<{
        assessment_version_id: string;
        item_id: string;
        standard_id: string;
        standard_code: string | null;
        standard_label: string | null;
        standard_uri: string | null;
        provider_id: string | null;
        metadata_json: string;
      }>();

    expect(standards.results).toHaveLength(1);
    expect(standards.results[0]).toMatchObject({
      assessment_version_id: payload.assessmentVersionId,
      item_id: "item-1",
      standard_id: "370850e6-46fa-11e7-9dcf-6ce999a3c328",
      standard_code: "MA.5.FR.1.1",
      standard_label: "MA.5.FR.1.1 Add and subtract fractions.",
      standard_uri:
        "https://case.example.org/ims/case/v1p0/CFItems/370850e6-46fa-11e7-9dcf-6ce999a3c328",
      provider_id: "CASE",
    });
    expect(JSON.parse(standards.results[0]?.metadata_json ?? "{}")).toEqual({
      source: "qti-csm",
    });
  });

  it("rejects invalid packages with a clear 4xx and leaves no partial publish rows behind", async () => {
    const invalidPackage = await createFixturePackage({ omitItem: true });
    const response = await publishFixture({
      tenantId: "tenant_invalid",
      assessmentSlug: "broken-assessment",
      packageBytes: invalidPackage,
      packageName: "broken-assessment.zip",
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("items/item-1.xml"),
    });

    const { HARBOR_DB } = getTestEnv();
    const assessmentCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM assessments WHERE tenant_id = ?",
    )
      .bind("tenant_invalid")
      .first<{ count: number }>();
    const versionCount = await HARBOR_DB.prepare(
      "SELECT COUNT(*) AS count FROM assessment_versions",
    ).first<{ count: number }>();

    expect(assessmentCount?.count).toBe(0);
    expect(versionCount?.count).toBe(0);
  });
});
