import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { AssessmentRecord } from "@harbor/content-model";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";
import {
  publishQtiPackage,
  QtiPublicationStorageError,
  type QtiPreparedPublicationCommit,
  type QtiPublicationObjectStore,
  type QtiPublicationRepository,
} from "../src/publish/qti-package-publisher";
import type { QtiPublicationObject, QtiPublicationPlan } from "../src/publish/qti-publication-plan";

class RecordingRepository implements QtiPublicationRepository {
  readonly commits: QtiPublicationPlan[] = [];
  preparedPlan: QtiPublicationPlan | null = null;
  prepareError: unknown;
  commitError: unknown;

  async findAssessment(): Promise<AssessmentRecord | null> {
    return null;
  }

  async readNextVersionNumber(): Promise<number> {
    return 1;
  }

  async prepareCommit(plan: QtiPublicationPlan): Promise<QtiPreparedPublicationCommit> {
    if (this.prepareError) throw this.prepareError;
    this.preparedPlan = plan;
    return {
      execute: async () => {
        if (this.commitError) throw this.commitError;
        this.commits.push(plan);
      },
    };
  }
}

class RecordingObjectStore implements QtiPublicationObjectStore {
  readonly objects = new Map<string, QtiPublicationObject>();
  readonly putAttempts: string[] = [];
  readonly deleteAttempts: string[] = [];
  failPutKey: string | null = null;
  failPutCause: unknown = new Error("upload failed");
  failDelete = false;
  delayDeletes = false;
  activeDeletes = 0;
  maxActiveDeletes = 0;

  async put(object: QtiPublicationObject): Promise<void> {
    this.putAttempts.push(object.key);
    if (object.key === this.failPutKey) throw this.failPutCause;
    this.objects.set(object.key, object);
  }

  async delete(key: string): Promise<void> {
    this.deleteAttempts.push(key);
    this.activeDeletes += 1;
    this.maxActiveDeletes = Math.max(this.maxActiveDeletes, this.activeDeletes);
    try {
      if (this.delayDeletes) await Promise.resolve();
      if (this.failDelete) throw new Error("delete failed");
      this.objects.delete(key);
    } finally {
      this.activeDeletes -= 1;
    }
  }
}

describe("QTI package publisher", () => {
  it("performs no object writes when commit preparation rejects the plan", async () => {
    const repository = new RecordingRepository();
    const objectStore = new RecordingObjectStore();
    repository.prepareError = new Error("statement limit");

    await expect(publishFixture(repository, objectStore)).rejects.toThrow("statement limit");
    expect(objectStore.putAttempts).toEqual([]);
    expect(repository.commits).toEqual([]);
  });

  it("drains uploads and removes every successful object after a partial upload failure", async () => {
    const repository = new RecordingRepository();
    const objectStore = new RecordingObjectStore();
    objectStore.failPutKey =
      "tenants/tenant-1/assessments/asmt_1/versions/vers_2/manifests/delivery.json";

    const error = await captureFailure(publishFixture(repository, objectStore));
    expect(error).toBeInstanceOf(QtiPublicationStorageError);
    expect((error as QtiPublicationStorageError).stage).toBe("upload");
    expect(objectStore.objects.size).toBe(0);
    expect(new Set(objectStore.deleteAttempts)).toEqual(
      new Set(objectStore.putAttempts.filter((key) => key !== objectStore.failPutKey)),
    );
    expect(repository.commits).toEqual([]);
  });

  it("captures an undefined rejection and stops scheduling new uploads", async () => {
    const repository = new RecordingRepository();
    const objectStore = new RecordingObjectStore();
    objectStore.failPutKey =
      "tenants/tenant-1/assessments/asmt_1/versions/vers_2/package/fixture.zip";
    objectStore.failPutCause = undefined;

    const error = (await captureFailure(
      publishFixture(repository, objectStore, 12),
    )) as QtiPublicationStorageError;
    expect(error).toBeInstanceOf(QtiPublicationStorageError);
    expect(error.stage).toBe("upload");
    expect(error.originalError).toBeUndefined();
    expect(objectStore.putAttempts.length).toBeLessThanOrEqual(8);
    expect(repository.commits).toEqual([]);
  });

  it("removes all uploaded objects when the atomic commit fails", async () => {
    const repository = new RecordingRepository();
    const objectStore = new RecordingObjectStore();
    repository.commitError = new Error("D1 failed");

    const error = await captureFailure(publishFixture(repository, objectStore));
    expect(error).toBeInstanceOf(QtiPublicationStorageError);
    expect((error as QtiPublicationStorageError).stage).toBe("commit");
    expect(objectStore.objects.size).toBe(0);
    expect(new Set(objectStore.deleteAttempts)).toEqual(new Set(objectStore.putAttempts));
  });

  it("bounds compensating deletes while attempting every uploaded key", async () => {
    const repository = new RecordingRepository();
    const objectStore = new RecordingObjectStore();
    repository.commitError = new Error("D1 failed");
    objectStore.delayDeletes = true;

    await captureFailure(publishFixture(repository, objectStore, 12));
    expect(objectStore.deleteAttempts).toHaveLength(objectStore.putAttempts.length);
    expect(objectStore.maxActiveDeletes).toBeLessThanOrEqual(8);
    expect(objectStore.objects.size).toBe(0);
  });

  it("reports incomplete cleanup without hiding the upload failure", async () => {
    const repository = new RecordingRepository();
    const objectStore = new RecordingObjectStore();
    objectStore.failPutKey =
      "tenants/tenant-1/assessments/asmt_1/versions/vers_2/manifests/delivery.json";
    objectStore.failDelete = true;

    const error = (await captureFailure(
      publishFixture(repository, objectStore),
    )) as QtiPublicationStorageError;
    expect(error.stage).toBe("upload");
    expect(error.originalError).toBeInstanceOf(Error);
    expect(error.cleanupErrors.length).toBeGreaterThan(0);
    expect(objectStore.deleteAttempts.length).toBeGreaterThan(0);
  });

  it("uploads the exact immutable plan and commits once", async () => {
    const repository = new RecordingRepository();
    const objectStore = new RecordingObjectStore();

    const result = await publishFixture(repository, objectStore);
    const plan = repository.preparedPlan;
    expect(plan).not.toBeNull();
    expect(repository.commits).toHaveLength(1);
    expect([...objectStore.objects.keys()]).toEqual(plan?.objects.map((object) => object.key));
    expect(result).toEqual(plan?.result);
    const manifestObject = plan?.objects.find((object) => object.key === result.manifestObjectKey);
    expect(manifestObject?.bytes.byteLength).toBeGreaterThan(0);
    expect(manifestObject?.contentType).toBe("application/json");
  });
});

async function publishFixture(
  repository: QtiPublicationRepository,
  objectStore: QtiPublicationObjectStore,
  additionalAssetCount = 0,
) {
  let nextId = 0;
  return publishQtiPackage(
    {
      tenantId: "tenant-1",
      assessmentSlug: "fixture",
      packageName: "fixture.zip",
      packageBytes: await createFixturePackage(additionalAssetCount),
    },
    {
      repository,
      objectStore,
      now: () => new Date("2026-07-21T12:00:00.000Z"),
      generateId: (prefix) => `${prefix}_${++nextId}`,
    },
  );
}

async function createFixturePackage(additionalAssetCount = 0): Promise<Uint8Array> {
  const zip = new JSZip();
  const additionalImages = Array.from(
    { length: additionalAssetCount },
    (_, index) => `<img src="../assets/extra-${index}.svg" alt="Extra ${index}"/>`,
  ).join("");
  zip.file("imsmanifest.xml", manifestXml);
  zip.file(
    "items/item-1.xml",
    itemXml.replace("</qti-item-body>", `${additionalImages}</qti-item-body>`),
  );
  zip.file("assets/stimulus.svg", stimulusSvg);
  for (let index = 0; index < additionalAssetCount; index += 1) {
    zip.file(`assets/extra-${index}.svg`, stimulusSvg);
  }
  return zip.generateAsync({ type: "uint8array" });
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected publication to fail");
  } catch (error) {
    return error;
  }
}
