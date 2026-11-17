import type {
  AssignmentPolicySnapshot,
  CurrentItemRef,
  DeliveryPolicySnapshot,
  LaunchMetadata,
  ManifestReference,
  PreviewLaunchActor,
} from "@harbor/attempt-protocol";
import type { DeliveryManifest } from "@harbor/content-model";

import { parseStoredAssignmentPolicySnapshot } from "../routes/assignment-request-parsers";
import { parseStoredDeliveryPolicy } from "../delivery/delivery-policy";
import { readAssessmentVersionValidationReport } from "../publish/qti-validation-read";

export class LaunchRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AttemptContext {
  attemptId: string;
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
  manifest: ManifestReference;
  currentItemRef: CurrentItemRef;
  launch: LaunchMetadata;
}

interface PublishedVersionContext {
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
  manifest: ManifestReference;
  currentItemRef: CurrentItemRef;
}

interface CreateAttemptEntryInput {
  db: D1Database;
  bucket: R2Bucket;
  assessmentVersionId: string;
  launch: LaunchMetadata;
  accessCodeId?: string | null;
  assignmentId?: string | null;
  launchSnapshot?: Record<string, unknown> | null;
}

export async function createPreviewAttempt(input: {
  db: D1Database;
  bucket: R2Bucket;
  assessmentVersionId: string;
  actor: PreviewLaunchActor;
}): Promise<AttemptContext> {
  return createAttemptEntry({
    db: input.db,
    bucket: input.bucket,
    assessmentVersionId: input.assessmentVersionId,
    launch: {
      mode: "preview",
      actor: input.actor,
    },
  });
}

export async function createAttemptEntry(input: CreateAttemptEntryInput): Promise<AttemptContext> {
  const versionContext = await loadPublishedVersionContext({
    db: input.db,
    bucket: input.bucket,
    assessmentVersionId: input.assessmentVersionId,
  });
  const assignmentContext = input.assignmentId
    ? await loadAssignmentLaunchContext({
        db: input.db,
        assignmentId: input.assignmentId,
      })
    : null;
  if (
    assignmentContext &&
    assignmentContext.assessmentVersionId !== versionContext.assessmentVersionId
  ) {
    throw new LaunchRequestError(
      409,
      "Assignment launch must stay pinned to its immutable assessment version",
    );
  }
  const attemptId = createId("attempt");
  const createdAt = new Date().toISOString();
  const deliveryPolicy = assignmentContext
    ? applyAssignmentPolicy(
        versionContext.deliveryPolicy,
        assignmentContext.policySnapshot,
        input.launch.mode,
      )
    : {
        ...versionContext.deliveryPolicy,
        launchMode: input.launch.mode,
      };

  await input.db
    .prepare(
      "INSERT INTO attempt_entries (id, assessment_version_id, access_code_id, assignment_id, launch_mode, actor_kind, actor_id, actor_display_name, delivery_policy_snapshot, assignment_policy_snapshot, launch_snapshot_json, manifest_object_key, current_item_id, current_item_href, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      attemptId,
      versionContext.assessmentVersionId,
      input.accessCodeId ?? null,
      assignmentContext?.id ?? null,
      input.launch.mode,
      input.launch.actor.kind,
      input.launch.actor.id,
      input.launch.actor.displayName,
      JSON.stringify(deliveryPolicy),
      assignmentContext ? JSON.stringify(assignmentContext.policySnapshot) : null,
      JSON.stringify(
        input.launchSnapshot ?? {
          launchMode: input.launch.mode,
          actor: input.launch.actor,
          launchedAt: createdAt,
          assignmentId: assignmentContext?.id ?? null,
        },
      ),
      versionContext.manifest.manifestObjectKey,
      versionContext.currentItemRef.itemId,
      versionContext.currentItemRef.itemHref,
      createdAt,
    )
    .run();

  return {
    attemptId,
    assessmentVersionId: versionContext.assessmentVersionId,
    deliveryPolicy,
    manifest: versionContext.manifest,
    currentItemRef: versionContext.currentItemRef,
    launch: input.launch,
  };
}

export async function loadPublishedVersionContext(input: {
  db: D1Database;
  bucket: R2Bucket;
  assessmentVersionId: string;
}): Promise<PublishedVersionContext> {
  const version = await input.db
    .prepare(
      "SELECT id, manifest_object_key, delivery_policy_snapshot FROM assessment_versions WHERE id = ?",
    )
    .bind(input.assessmentVersionId)
    .first<{
      id: string;
      manifest_object_key: string;
      delivery_policy_snapshot: string;
    }>();

  if (!version) {
    throw new LaunchRequestError(404, "Published assessment version not found");
  }

  const validation = await readAssessmentVersionValidationReport(input.db, version.id);
  if (!validation.summary.readyForDelivery) {
    throw new LaunchRequestError(409, "Published assessment has unresolved delivery blockers");
  }

  const manifestObject = await input.bucket.get(version.manifest_object_key);
  if (!manifestObject) {
    throw new LaunchRequestError(
      409,
      "Published assessment version is missing its delivery manifest",
    );
  }

  const manifest = await manifestObject.json<DeliveryManifest>();
  const firstItemId = manifest.itemOrder[0];
  const firstItem = firstItemId ? manifest.items[firstItemId] : undefined;

  if (!firstItemId || !firstItem) {
    throw new LaunchRequestError(
      409,
      "Published assessment version does not contain a launchable first item",
    );
  }

  return {
    assessmentVersionId: version.id,
    deliveryPolicy: parseStoredDeliveryPolicy(version.delivery_policy_snapshot),
    manifest: {
      manifestObjectKey: version.manifest_object_key,
    },
    currentItemRef: {
      itemId: firstItemId,
      itemHref: firstItem.href,
    },
  };
}

async function loadAssignmentLaunchContext(input: {
  db: D1Database;
  assignmentId: string;
}): Promise<{
  id: string;
  assessmentVersionId: string;
  policySnapshot: AssignmentPolicySnapshot;
}> {
  const assignment = await input.db
    .prepare("SELECT id, assessment_version_id, policy_snapshot_json FROM assignments WHERE id = ?")
    .bind(input.assignmentId)
    .first<{
      id: string;
      assessment_version_id: string;
      policy_snapshot_json: string;
    }>();

  if (!assignment) {
    throw new LaunchRequestError(404, "Assignment not found");
  }

  return {
    id: assignment.id,
    assessmentVersionId: assignment.assessment_version_id,
    policySnapshot: parseStoredAssignmentPolicySnapshot(assignment.policy_snapshot_json),
  };
}

function applyAssignmentPolicy(
  deliveryPolicy: DeliveryPolicySnapshot,
  assignmentPolicy: AssignmentPolicySnapshot,
  launchMode: LaunchMetadata["mode"],
): DeliveryPolicySnapshot {
  return {
    ...deliveryPolicy,
    launchMode,
    navigationMode: assignmentPolicy.navigationMode,
    maxAttempts: assignmentPolicy.maxAttempts,
    timeLimitSeconds: assignmentPolicy.timeLimitSeconds,
    gracePeriodSeconds: assignmentPolicy.gracePeriodSeconds,
    standaloneAllowed: assignmentPolicy.standaloneAllowed,
    iframeAllowed: assignmentPolicy.iframeAllowed,
    allowedEmbedOrigins: assignmentPolicy.allowedEmbedOrigins,
    secureBrowserRequired: assignmentPolicy.secureBrowserRequired,
    secureBrowserProviderHint: assignmentPolicy.secureBrowserProviderHint,
    safeExamBrowser: assignmentPolicy.safeExamBrowser,
  };
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
