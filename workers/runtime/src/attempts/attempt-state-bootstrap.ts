import { reconcileAttemptAlarm } from "./attempt-alarm-schedule";
import type { CandidateResponseCheckpoint } from "@harbor/attempt-protocol";
import type {
  AttemptDeliveryPreferences,
  AttemptPolicyState,
  AttemptStatus,
  AttemptSubmissionMaterializationInput,
  AttemptSubmissionSummary,
  AttemptTimingState,
  CommitAttemptEventReceipt,
  CurrentItemRef,
  DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import type { DeliveryManifest, QtiTimingMetadataSnapshot } from "@harbor/content-model";
import { FixedTestOrderRuntime, type StoredFixedTestOrder } from "./fixed-test-order-runtime";
import {
  parseFixedTestOrderDescriptor,
  buildImmutableVersionPrefix,
  parseTestSequenceDescriptor,
} from "@harbor/content-model";
import {
  buildInitialScopedTimingState,
  renderTimingState,
  type StoredScopedTimingState,
} from "./attempt-timing";
import { buildTimingState, loadAttemptPolicyState } from "./attempt-policy-service";
import { syncAttemptDeadlineJobs } from "./attempt-deadline-jobs";
import { insertTimingEvidenceEvent } from "./attempt-accepted-projections";
import { parseStoredDeliveryPolicy } from "../delivery/delivery-policy";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";
import { initializeTestSequence, type StoredTestSequence } from "./test-session-delivery";

export const STATE_KEY = "attempt-state";

export interface StoredAttemptState {
  responseCheckpoint?: CandidateResponseCheckpoint;
  testSequence?: StoredTestSequence;
  fixedTestOrder?: StoredFixedTestOrder;
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  highestCommittedSequence: number;
  attemptStatus: AttemptStatus;
  currentItemRef: CurrentItemRef;
  timing: AttemptTimingState;
  scopedTiming: StoredScopedTimingState;
  policy: AttemptPolicyState;
  currentClientSessionId: string | null;
  deliveryPreferences?: AttemptDeliveryPreferences;
  deliveryPolicy: DeliveryPolicySnapshot;
  allowedItemRefs: CurrentItemRef[];
  manifestItems: Record<
    string,
    {
      itemIdentifier: string | null;
      itemTitle: string | null;
      objectKey: string;
      adaptive: boolean;
      timeDependent: boolean;
    }
  >;
  submissionMaterialization: AttemptSubmissionMaterializationInput;
  submissionSummary: AttemptSubmissionSummary | null;
  submissionReceipt?: CommitAttemptEventReceipt | null;
}

interface AttemptEntrySeedRow {
  id: string;
  assessment_version_id: string;
  assignment_id: string | null;
  delivery_policy_snapshot: string;
  manifest_object_key: string;
  current_item_id: string;
  current_item_href: string;
  created_at: string;
}

interface ManifestState {
  testSequence?: DeliveryManifest["testSequence"];
  fixedTestOrder?: DeliveryManifest["fixedTestOrder"];
  itemOrder: string[];
  allowedItemRefs: CurrentItemRef[];
  manifestItems: Record<
    string,
    {
      itemIdentifier: string | null;
      itemTitle: string | null;
      objectKey: string;
      adaptive: boolean;
      timeDependent: boolean;
    }
  >;
  qtiTiming: QtiTimingMetadataSnapshot | null;
}

export async function ensureAttemptState(input: {
  storage: DurableObjectStorage;
  db: D1Database;
  bucket: R2Bucket;
  attemptId: string;
  fixedOrderRuntime: FixedTestOrderRuntime;
}): Promise<StoredAttemptState> {
  const storedState = await input.storage.get<StoredAttemptState>(STATE_KEY);

  if (storedState) {
    if (storedState.attemptId !== input.attemptId) {
      throw new AttemptDurableObjectRequestError(
        409,
        "Attempt Durable Object is already bound to a different attempt",
      );
    }

    if (storedState.fixedTestOrder !== undefined) {
      if (storedState.testSequence)
        throw new AttemptDurableObjectRequestError(
          409,
          "Attempt cannot combine fixed ordering and staged routing",
        );
      const restored = await input.fixedOrderRuntime.restore(
        storedState.fixedTestOrder,
        storedState.allowedItemRefs,
      );
      const itemOrder = restored.itemRefs.map((ref) => ref.itemId);
      if (
        itemOrder.length !== storedState.submissionMaterialization.itemOrder.length ||
        itemOrder.some(
          (id, index) => id !== storedState.submissionMaterialization.itemOrder[index],
        ) ||
        restored.itemRefs.some(
          (ref, index) =>
            ref.itemId !== storedState.allowedItemRefs[index]?.itemId ||
            ref.itemHref !== storedState.allowedItemRefs[index]?.itemHref,
        ) ||
        !restored.itemRefs.some(
          (ref) =>
            ref.itemId === storedState.currentItemRef.itemId &&
            ref.itemHref === storedState.currentItemRef.itemHref,
        )
      )
        throw new AttemptDurableObjectRequestError(
          409,
          "Saved attempt inventory does not match its fixed ordering",
        );
    }
    const normalizedState = storedState.deliveryPreferences
      ? storedState
      : {
          ...storedState,
          deliveryPreferences: { keywordTranslationLanguage: null },
        };
    await input.storage.transaction(async (txn) => {
      if (normalizedState !== storedState) await txn.put(STATE_KEY, normalizedState);
      await reconcileAttemptAlarm(txn);
    });
    return normalizedState;
  }

  const attempt = await input.db
    .prepare(
      "SELECT id, assessment_version_id, assignment_id, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href, created_at FROM attempt_entries WHERE id = ?",
    )
    .bind(input.attemptId)
    .first<AttemptEntrySeedRow>();

  if (!attempt) {
    throw new AttemptDurableObjectRequestError(
      404,
      "Attempt entry does not exist for the requested attempt",
    );
  }

  const deliveryPolicy = parseStoredDeliveryPolicy(attempt.delivery_policy_snapshot);
  let currentItemRef = {
    itemId: attempt.current_item_id,
    itemHref: attempt.current_item_href,
  };
  const manifestState = await loadManifestState(input.bucket, attempt.manifest_object_key);
  const fixedTestOrder = manifestState.fixedTestOrder
    ? await input.fixedOrderRuntime.prepare(
        manifestState.fixedTestOrder,
        manifestState.allowedItemRefs,
        { kind: "new", seed: attempt.id },
      )
    : undefined;
  if (fixedTestOrder) {
    manifestState.allowedItemRefs = fixedTestOrder.itemRefs;
    manifestState.itemOrder = fixedTestOrder.itemRefs.map((ref) => ref.itemId);
    const first = fixedTestOrder.itemRefs[0];
    if (!first) throw new Error("Validated fixed ordering has no initial item.");
    currentItemRef = first;
  }
  const policy = await loadAttemptPolicyState(
    input.db,
    attempt.id,
    attempt.created_at,
    deliveryPolicy,
  );
  const nextState: StoredAttemptState = {
    ...(manifestState.testSequence
      ? {
          testSequence: await initializeTestSequence(
            input.bucket,
            manifestState.testSequence,
            currentItemRef,
          ),
        }
      : {}),
    ...(fixedTestOrder
      ? { fixedTestOrder: { descriptor: fixedTestOrder.descriptor, order: fixedTestOrder.order } }
      : {}),
    attemptId: attempt.id,
    assessmentVersionId: attempt.assessment_version_id,
    assignmentId: attempt.assignment_id,
    highestCommittedSequence: 0,
    attemptStatus: policy.reopen.status === "reopened" ? "reopened" : "active",
    currentItemRef,
    timing: buildTimingState(attempt.created_at, deliveryPolicy, policy),
    scopedTiming: buildInitialScopedTimingState({
      startedAt: attempt.created_at,
      assessmentVersionId: attempt.assessment_version_id,
      currentItemRef,
      manifestState,
      deliveryPolicy,
      policy,
    }),
    policy,
    currentClientSessionId: null,
    deliveryPreferences: { keywordTranslationLanguage: null },
    deliveryPolicy,
    allowedItemRefs: manifestState.allowedItemRefs,
    manifestItems: manifestState.manifestItems,
    submissionMaterialization: {
      itemOrder: manifestState.testSequence ? [currentItemRef.itemId] : manifestState.itemOrder,
      testState: null,
      partStates: {},
      sectionStates: {},
      items: {},
    },
    submissionSummary: null,
    submissionReceipt: null,
  };

  await insertTimingEvidenceEvent({
    db: input.db,
    storedState: nextState,
    eventType: "timing.policy.created",
    sequenceNumber: null,
    itemRef: null,
    payload: {
      effectiveTimingPolicyVersion: nextState.scopedTiming.policyVersion,
      originalLimits: deliveryPolicy.qtiTiming ?? null,
      effectiveLimits: renderTimingState(
        nextState.timing,
        attempt.created_at,
        nextState.scopedTiming,
      ),
      source: "server",
    },
    createdAt: attempt.created_at,
  });
  await syncAttemptDeadlineJobs({
    db: input.db,
    state: nextState,
    now: attempt.created_at,
  });
  await input.storage.transaction(async (txn) => {
    await txn.put(STATE_KEY, nextState);
    await reconcileAttemptAlarm(txn);
  });
  return nextState;
}

async function loadManifestState(
  bucket: R2Bucket,
  manifestObjectKey: string,
): Promise<ManifestState> {
  const manifestObject = await bucket.get(manifestObjectKey);
  if (!manifestObject) {
    throw new AttemptDurableObjectRequestError(500, "Attempt delivery manifest object is missing");
  }

  let manifest: DeliveryManifest;
  try {
    manifest = await manifestObject.json<DeliveryManifest>();
  } catch {
    throw new AttemptDurableObjectRequestError(
      500,
      "Attempt delivery manifest object is invalid JSON",
    );
  }

  const ordering = parseFixedTestOrderDescriptor(manifest.fixedTestOrder);
  if (!ordering.ok) throw new AttemptDurableObjectRequestError(409, ordering.reason);
  if (
    ordering.value &&
    (manifest.testSequence ||
      ordering.value.objectKey !==
        `${buildImmutableVersionPrefix({ tenantId: manifest.tenantId, assessmentId: manifest.assessmentId, versionId: manifest.assessmentVersionId })}/execution/test.xml`)
  )
    throw new AttemptDurableObjectRequestError(
      409,
      "Published fixed ordering is outside the pinned execution context",
    );
  const itemOrder = manifest.itemOrder.filter((itemId) => Boolean(manifest.items[itemId]));
  const itemRefs = itemOrder
    .map((itemId) => {
      const item = manifest.items[itemId];
      if (!item) {
        return null;
      }

      return {
        itemId,
        itemHref: item.href,
      };
    })
    .filter((itemRef): itemRef is CurrentItemRef => itemRef !== null);

  const manifestItems = Object.fromEntries(
    itemOrder.map((itemId) => [
      itemId,
      {
        itemIdentifier: manifest.items[itemId]?.identifier ?? itemId,
        itemTitle: manifest.items[itemId]?.title ?? itemId,
        objectKey: manifest.items[itemId]?.objectKey ?? "",
        adaptive: manifest.items[itemId]?.adaptive === true,
        timeDependent: manifest.items[itemId]?.timeDependent === true,
      },
    ]),
  );

  if (itemRefs.length === 0) {
    throw new AttemptDurableObjectRequestError(
      500,
      "Attempt delivery manifest does not contain any playable items",
    );
  }

  return {
    itemOrder,
    testSequence: parseTestSequenceDescriptor(manifest.testSequence),
    fixedTestOrder: ordering.value,
    allowedItemRefs: itemRefs,
    manifestItems,
    qtiTiming: manifest.qtiTiming ?? null,
  };
}
