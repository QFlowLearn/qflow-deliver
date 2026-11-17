import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DELIVERY_POLICY_SNAPSHOT } from "@harbor/content-model";
import {
  CloudflareQtiPublicationObjectStore,
  CloudflareQtiPublicationRepository,
} from "../src/publish/qti-publication-store";
import type { QtiPublicationPlan } from "../src/publish/qti-publication-plan";

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

describe("Cloudflare QTI publication adapters", () => {
  beforeEach(async () => {
    const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
    await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);
    await HARBOR_DB.exec(
      "DROP TRIGGER IF EXISTS reject_qti_version; DELETE FROM assessment_version_validation_findings; DELETE FROM assessment_item_standard_alignments; DELETE FROM assessment_item_metadata; DELETE FROM delivery_artifacts; DELETE FROM assessment_versions; DELETE FROM assessments;",
    );
    const listed = await CONTENT_BUCKET.list();
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
  });

  it("rolls back earlier statements when a later D1 batch statement fails", async () => {
    const { HARBOR_DB } = getTestEnv();
    await HARBOR_DB.exec(
      "CREATE TRIGGER reject_qti_version BEFORE INSERT ON assessment_versions BEGIN SELECT RAISE(ABORT, 'reject version'); END;",
    );
    const repository = new CloudflareQtiPublicationRepository(HARBOR_DB);
    const preparedCommit = await repository.prepareCommit(createPlan());

    await expect(preparedCommit.execute()).rejects.toThrow();
    const assessment = await HARBOR_DB.prepare("SELECT id FROM assessments WHERE id = ?")
      .bind("asmt_atomic")
      .first();
    expect(assessment).toBeNull();
  });

  it("deletes an object through the real R2 adapter", async () => {
    const { CONTENT_BUCKET } = getTestEnv();
    const objectStore = new CloudflareQtiPublicationObjectStore(CONTENT_BUCKET);
    const key = "qti-publication-store/delete-me.xml";
    await objectStore.put({
      key,
      bytes: new TextEncoder().encode("<qti-assessment-item/>"),
      contentType: "application/xml",
    });
    expect(await CONTENT_BUCKET.head(key)).not.toBeNull();

    await objectStore.delete(key);
    expect(await CONTENT_BUCKET.head(key)).toBeNull();
  });
});

function createPlan(): QtiPublicationPlan {
  const createdAt = "2026-07-21T12:00:00.000Z";
  const validation = {
    summary: {
      readyForDelivery: true,
      acceptedCount: 0,
      acceptedWithWarningCount: 0,
      acceptedPendingAdapterEvidenceCount: 0,
      blockedCount: 0,
    },
    findings: [],
  };
  return {
    assessmentTarget: {
      kind: "new",
      assessment: {
        id: "asmt_atomic",
        tenantId: "tenant-1",
        slug: "atomic",
        title: "Atomic",
        createdAt,
      },
    },
    assessmentVersion: {
      id: "vers_atomic",
      assessmentId: "asmt_atomic",
      versionNumber: 1,
      sourcePackageSha256: "sha256",
      packageObjectKey: "package.zip",
      manifestObjectKey: "delivery.json",
      deliveryPolicySnapshot: DEFAULT_DELIVERY_POLICY_SNAPSHOT,
      createdAt,
    },
    qtiTimingMetadataJson: JSON.stringify({
      assessmentTest: null,
      testParts: [],
      sections: [],
      itemRefs: [],
    }),
    objects: [],
    artifacts: [],
    itemMetadata: [],
    standards: [],
    findings: [],
    result: {
      assessmentId: "asmt_atomic",
      assessmentVersionId: "vers_atomic",
      packageObjectKey: "package.zip",
      manifestObjectKey: "delivery.json",
      deliveryPolicySnapshot: DEFAULT_DELIVERY_POLICY_SNAPSHOT,
      validation,
    },
  };
}
