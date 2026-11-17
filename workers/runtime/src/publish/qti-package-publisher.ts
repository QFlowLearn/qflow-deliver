import type { AssessmentRecord } from "@harbor/content-model";
import { buildQtiImportValidationReport } from "./qti-import-validation";
import { prepareQtiPackage } from "./qti-package-preparation";
import {
  buildQtiPublicationPlan,
  type PublishResult,
  type QtiPublicationObject,
  type QtiPublicationPlan,
} from "./qti-publication-plan";

export interface QtiPublicationRepository {
  findAssessment(tenantId: string, assessmentSlug: string): Promise<AssessmentRecord | null>;
  readNextVersionNumber(assessmentId: string): Promise<number>;
  prepareCommit(plan: QtiPublicationPlan): Promise<QtiPreparedPublicationCommit>;
}

export interface QtiPreparedPublicationCommit {
  execute(): Promise<void>;
}

export interface QtiPublicationObjectStore {
  put(object: QtiPublicationObject): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface QtiPublisherDependencies {
  readonly repository: QtiPublicationRepository;
  readonly objectStore: QtiPublicationObjectStore;
  readonly now: () => Date;
  readonly generateId: (prefix: string) => string;
}

export interface PublishQtiPackageInput {
  readonly tenantId: string;
  readonly assessmentSlug: string;
  readonly packageName: string;
  readonly packageBytes: Uint8Array;
}

export type QtiPublicationStorageFailureStage = "upload" | "commit";

interface BoundedOperationFailure<T> {
  readonly input: T;
  readonly cause: unknown;
}

/** Internal tagged storage failure retaining both the primary and cleanup errors. */
export class QtiPublicationStorageError extends Error {
  readonly kind = "qti-publication-storage-failure";

  constructor(
    readonly stage: QtiPublicationStorageFailureStage,
    readonly originalError: unknown,
    readonly cleanupErrors: readonly unknown[],
  ) {
    super(
      cleanupErrors.length > 0
        ? `QTI publication ${stage} failed and cleanup was incomplete`
        : `QTI publication ${stage} failed`,
      { cause: originalError },
    );
    this.name = "QtiPublicationStorageError";
  }
}

/** Prepare completely, upload immutably, and expose the publication through one atomic commit. */
export async function publishQtiPackage(
  input: PublishQtiPackageInput,
  dependencies: QtiPublisherDependencies,
): Promise<PublishResult> {
  const preparedPackage = await prepareQtiPackage(input.packageBytes);
  const validation = buildQtiImportValidationReport(preparedPackage);
  const existingAssessment = await dependencies.repository.findAssessment(
    input.tenantId,
    input.assessmentSlug,
  );
  const createdAt = dependencies.now().toISOString();
  const assessment: AssessmentRecord = existingAssessment ?? {
    id: dependencies.generateId("asmt"),
    tenantId: input.tenantId,
    slug: input.assessmentSlug,
    title: preparedPackage.title,
    createdAt,
  };
  const assessmentTarget = existingAssessment
    ? { kind: "existing" as const, assessment }
    : { kind: "new" as const, assessment };
  const versionNumber = await dependencies.repository.readNextVersionNumber(assessment.id);
  const plan = await buildQtiPublicationPlan({
    ...input,
    assessmentTarget,
    assessmentVersionId: dependencies.generateId("vers"),
    versionNumber,
    preparedPackage,
    validation,
    createdAt,
    generateId: dependencies.generateId,
  });

  // Preparing validates D1's statement budget before any object becomes visible.
  const preparedCommit = await dependencies.repository.prepareCommit(plan);
  const uploadedKeys: string[] = [];
  try {
    await uploadObjects(plan.objects, dependencies.objectStore, uploadedKeys);
  } catch (error) {
    const cleanupErrors = await deleteEveryObject(uploadedKeys, dependencies.objectStore);
    throw new QtiPublicationStorageError("upload", error, cleanupErrors);
  }

  try {
    await preparedCommit.execute();
  } catch (error) {
    const cleanupErrors = await deleteEveryObject(uploadedKeys, dependencies.objectStore);
    throw new QtiPublicationStorageError("commit", error, cleanupErrors);
  }
  return plan.result;
}

async function uploadObjects(
  objects: readonly QtiPublicationObject[],
  objectStore: QtiPublicationObjectStore,
  uploadedKeys: string[],
): Promise<void> {
  const failures = await runWithBoundedConcurrency(
    objects,
    8,
    async (object) => {
      await objectStore.put(object);
      uploadedKeys.push(object.key);
    },
    true,
  );
  const firstFailure = failures[0];
  if (firstFailure) throw firstFailure.cause;
}

async function deleteEveryObject(
  keys: readonly string[],
  objectStore: QtiPublicationObjectStore,
): Promise<unknown[]> {
  const failures = await runWithBoundedConcurrency(
    keys,
    8,
    (key) => objectStore.delete(key),
    false,
  );
  return failures.map((failure) => failure.cause);
}

async function runWithBoundedConcurrency<T>(
  inputs: readonly T[],
  concurrency: number,
  operation: (input: T) => Promise<void>,
  stopAfterFirstFailure: boolean,
): Promise<BoundedOperationFailure<T>[]> {
  const iterator = inputs.values();
  const failures: BoundedOperationFailure<T>[] = [];
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const next = iterator.next();
      if (next.done) return;
      try {
        await operation(next.value);
      } catch (cause: unknown) {
        failures.push({ input: next.value, cause });
        if (stopAfterFirstFailure) stopped = true;
      }
    }
  };
  const workerCount = Math.min(concurrency, inputs.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return failures;
}

export type { PublishResult } from "./qti-publication-plan";
