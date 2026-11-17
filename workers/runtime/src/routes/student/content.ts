import {
  parseAssessmentInstructionBlocks,
  assessmentInstructionItemIds,
  parseFixedTestOrderDescriptor,
  resolvePackageAssetReference,
  type AssessmentInstructionBlock,
  type DeliveryManifest,
  type DeliveryPolicySnapshot,
} from "@harbor/content-model";
import { parseSafeContentProjection } from "@longsightgroup/qti3-player";

import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../../attempts/attempt-durable-object";
import { parseStoredDeliveryPolicy } from "../../delivery/delivery-policy";
import { projectCandidateDeliveryPolicy } from "../../delivery/candidate-delivery-policy";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../../security/safe-exam-browser";
import { assertDeliverySafeItemXml } from "../../qti/secure-delivery";
import {
  DELIVERY_CONTEXT_EMBED_ORIGIN_QUERY_PARAM,
  DELIVERY_CONTEXT_MODE_QUERY_PARAM,
  requireAllowedDeliveryContext,
} from "../delivery-context";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";
import { readAttemptIdQueryParam, readItemIdParam } from "../route-params";
import { readFixedTestOrderView } from "./fixed-test-order-view";
import { readTestSequenceView } from "./test-sequence-view";

interface ContentEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
}

interface AttemptContentContext {
  attemptId: string;
  assessmentVersionId: string;
  title: string;
  launchMode: "preview" | "access-code";
  deliveryPolicy: DeliveryPolicySnapshot;
  currentItemId: string;
  currentItemHref: string;
  manifest: DeliveryManifest & { assessmentInstructions: readonly AssessmentInstructionBlock[] };
}

export async function loadAttemptContentContext(input: {
  db: D1Database;
  bucket: R2Bucket;
  attemptId: string;
}): Promise<AttemptContentContext> {
  const attempt = await input.db
    .prepare(
      "SELECT attempts.id, attempts.assessment_version_id, attempts.launch_mode, attempts.delivery_policy_snapshot, attempts.current_item_id, attempts.current_item_href, attempts.manifest_object_key, assessments.title FROM attempt_entries attempts INNER JOIN assessment_versions versions ON versions.id = attempts.assessment_version_id INNER JOIN assessments ON assessments.id = versions.assessment_id WHERE attempts.id = ?",
    )
    .bind(input.attemptId)
    .first<{
      id: string;
      assessment_version_id: string;
      launch_mode: "preview" | "access-code";
      delivery_policy_snapshot: string;
      current_item_id: string;
      current_item_href: string;
      manifest_object_key: string;
      title: string;
    }>();

  if (!attempt) {
    throw new LaunchRequestError(404, "Attempt entry not found");
  }

  const manifestObject = await input.bucket.get(attempt.manifest_object_key);
  if (!manifestObject) {
    throw new LaunchRequestError(409, "Pinned attempt is missing its immutable delivery manifest");
  }

  const manifest = await manifestObject.json<DeliveryManifest>();
  const ordering = parseFixedTestOrderDescriptor(manifest.fixedTestOrder);
  if (!ordering.ok) throw new LaunchRequestError(409, ordering.reason);
  if (ordering.value && manifest.testSequence)
    throw new LaunchRequestError(409, "Pinned assessment combines incompatible ordering policies");
  const instructions = parseAssessmentInstructionBlocks(
    manifest.assessmentInstructions === undefined ? [] : manifest.assessmentInstructions,
  );
  if (
    !instructions.ok ||
    instructions.value.some(
      (block) =>
        assessmentInstructionItemIds(block).some((id) => !Object.hasOwn(manifest.items, id)) ||
        ("anchor" in block && manifest.testSequence !== undefined),
    )
  )
    throw new LaunchRequestError(409, "Pinned attempt has invalid assessment instructions");

  return {
    attemptId: attempt.id,
    assessmentVersionId: attempt.assessment_version_id,
    title: attempt.title,
    launchMode: attempt.launch_mode,
    deliveryPolicy: parseStoredDeliveryPolicy(attempt.delivery_policy_snapshot),
    currentItemId: attempt.current_item_id,
    currentItemHref: attempt.current_item_href,
    manifest: { ...manifest, assessmentInstructions: instructions.value },
  };
}

export function buildAssetUrl(input: {
  attemptId: string;
  assetId: string;
  deliveryContext?: {
    mode: "standalone" | "iframe";
    embedOrigin: string | null;
    secureBrowserPresent: boolean;
    secureBrowserProviderHint: string | null;
  };
}): string {
  const searchParams = new URLSearchParams({
    attemptId: input.attemptId,
  });

  if (input.deliveryContext) {
    searchParams.set(DELIVERY_CONTEXT_MODE_QUERY_PARAM, input.deliveryContext.mode);
    if (input.deliveryContext.embedOrigin) {
      searchParams.set(
        DELIVERY_CONTEXT_EMBED_ORIGIN_QUERY_PARAM,
        input.deliveryContext.embedOrigin,
      );
    }
  }

  return `/api/content/assets/${input.assetId}?${searchParams.toString()}`;
}

export async function handleManifestRequest(c: AppContext): Promise<Response> {
  return readDeliveryManifest({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function readDeliveryManifest(input: {
  request: Request;
  env: ContentEnv;
  url: URL;
}): Promise<Response> {
  const attemptId = readAttemptIdQueryParam(input.url);
  const context = await loadAttemptContentContext({
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
    attemptId,
  });
  const deliveryContext = await requireAllowedDeliveryContext({
    request: input.request,
    deliveryPolicy: context.deliveryPolicy,
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });

  const progress = context.manifest.testSequence
    ? await readTestSequenceView(input.env.ATTEMPT_COORDINATOR, attemptId)
    : undefined;
  const fixedOrder = context.manifest.fixedTestOrder
    ? await readFixedTestOrderView(input.env.ATTEMPT_COORDINATOR, attemptId, context.manifest)
    : undefined;
  let flatCurrentItemId = context.currentItemId;
  if (!progress && !fixedOrder) {
    const stub = input.env.ATTEMPT_COORDINATOR.get(
      input.env.ATTEMPT_COORDINATOR.idFromName(attemptId),
    );
    const response = await stub.fetch("https://harbor-attempt.local/session", {
      headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: attemptId },
    });
    if (!response.ok)
      throw new LaunchRequestError(response.status, "Unable to read current assessment position");
    const session: unknown = await response.json();
    if (
      !session ||
      typeof session !== "object" ||
      !("currentItemRef" in session) ||
      !session.currentItemRef ||
      typeof session.currentItemRef !== "object" ||
      !("itemId" in session.currentItemRef) ||
      typeof session.currentItemRef.itemId !== "string" ||
      !Object.hasOwn(context.manifest.items, session.currentItemRef.itemId)
    )
      throw new LaunchRequestError(502, "Invalid current assessment position");
    flatCurrentItemId = session.currentItemRef.itemId;
  }
  const itemOrder = progress
    ? [progress.currentItemRef.itemId]
    : fixedOrder
      ? fixedOrder.itemOrder
      : context.manifest.itemOrder;
  const assessmentInstructions = context.manifest.assessmentInstructions.map((block) => {
    const content = parseSafeContentProjection(block.content, (reference) => {
      const resolved = resolvePackageAssetReference(block.assetBaseHref, reference);
      if (!resolved.ok)
        throw new LaunchRequestError(409, "Pinned instructions have an invalid asset reference");
      const asset = Object.values(context.manifest.assets).find(
        (entry) => entry.href === resolved.href,
      );
      if (!asset)
        throw new LaunchRequestError(409, "Pinned instructions reference an unavailable asset");
      return buildAssetUrl({ attemptId, assetId: asset.id, deliveryContext }) + resolved.fragment;
    });
    if (!content.ok)
      throw new LaunchRequestError(409, "Pinned instructions contain invalid content");
    return { ...block, content: content.value };
  });

  return Response.json(
    {
      attemptId: context.attemptId,
      assessmentVersionId: context.assessmentVersionId,
      title: context.title,
      launchMode: context.launchMode,
      assessmentInstructions,
      deliveryPolicy: projectCandidateDeliveryPolicy(context.deliveryPolicy),
      currentItemId:
        progress?.currentItemRef.itemId ?? fixedOrder?.currentItemRef.itemId ?? flatCurrentItemId,
      itemOrder,
      ...(progress
        ? { testSequence: { answered: progress.answered, target: progress.target } }
        : {}),
      items: Object.fromEntries(
        itemOrder
          .map((itemId) => context.manifest.items[itemId])
          .filter((item): item is DeliveryManifest["items"][string] => item !== undefined)
          .map((item) => [
            item.id,
            {
              id: item.id,
              identifier: item.identifier,
              title: item.title,
              itemHref: item.href,
              assetIds: item.assetIds,
              maxScore: item.maxScore,
              timeDependent: item.timeDependent === true,
              timeLimits: item.timeLimits ?? null,
              itemSessionControl: item.itemSessionControl ?? null,
            },
          ]),
      ),
      qtiTiming: progress ? null : (context.manifest.qtiTiming ?? null),
    },
    { status: 200 },
  );
}

export async function handleItemRequest(c: AppContext): Promise<Response> {
  return readDeliveryItem({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
    itemId: readItemIdParam(c),
  });
}

export async function readDeliveryItem(input: {
  request: Request;
  env: ContentEnv;
  url: URL;
  itemId: string;
}): Promise<Response> {
  const attemptId = readAttemptIdQueryParam(input.url);
  const context = await loadAttemptContentContext({
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
    attemptId,
  });
  const deliveryContext = await requireAllowedDeliveryContext({
    request: input.request,
    deliveryPolicy: context.deliveryPolicy,
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      input.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });
  const item = context.manifest.items[input.itemId];

  if (context.manifest.testSequence) {
    const progress = await readTestSequenceView(input.env.ATTEMPT_COORDINATOR, attemptId);
    if (progress.currentItemRef.itemId !== input.itemId)
      throw new LaunchRequestError(403, "Only the current question is available");
  }

  if (!item) {
    throw new LaunchRequestError(404, "Item not found for pinned attempt");
  }

  if (!item.adaptive && !item.deliveryObjectKey) {
    throw new LaunchRequestError(409, "Pinned attempt item is missing its secure delivery payload");
  }

  const assets = item.assetIds.map((assetId) => {
    const asset = context.manifest.assets[assetId];
    if (!asset) {
      throw new LaunchRequestError(500, `Item ${item.id} references missing asset ${assetId}`);
    }

    return {
      id: asset.id,
      href: asset.href,
      url: buildAssetUrl({
        attemptId,
        assetId: asset.id,
        deliveryContext,
      }),
      mediaType: asset.mediaType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    };
  });

  const xml = item.adaptive
    ? await materializeAdaptiveItemXml({
        attemptId,
        itemId: input.itemId,
        coordinator: input.env.ATTEMPT_COORDINATOR,
      })
    : await readStaticDeliveryItemXml({
        bucket: input.env.CONTENT_BUCKET,
        objectKey: item.deliveryObjectKey,
      });

  return Response.json(
    {
      attemptId: context.attemptId,
      assessmentVersionId: context.assessmentVersionId,
      item: {
        id: item.id,
        identifier: item.identifier,
        title: item.title,
        href: item.href,
        timeDependent: item.timeDependent === true,
        timeLimits: item.timeLimits ?? null,
        itemSessionControl: item.itemSessionControl ?? null,
        xml,
        assets,
      },
    },
    { status: 200 },
  );
}

async function readStaticDeliveryItemXml(input: {
  bucket: R2Bucket;
  objectKey: string;
}): Promise<string> {
  const itemObject = await input.bucket.get(input.objectKey);
  if (!itemObject) {
    throw new LaunchRequestError(409, "Pinned attempt is missing its immutable item payload");
  }

  const xml = await itemObject.text();
  try {
    assertDeliverySafeItemXml(xml);
  } catch (error) {
    throw new LaunchRequestError(500, error instanceof Error ? error.message : String(error));
  }
  return xml;
}

async function materializeAdaptiveItemXml(input: {
  attemptId: string;
  itemId: string;
  coordinator: DurableObjectNamespace;
}): Promise<string> {
  const stub = input.coordinator.get(input.coordinator.idFromName(input.attemptId));
  const response = await stub.fetch(
    `https://harbor-attempt.local/adaptive-item-view?itemId=${encodeURIComponent(input.itemId)}`,
    {
      headers: {
        [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: input.attemptId,
      },
    },
  );
  const payload = await response
    .clone()
    .json<{ candidateSafeXml?: unknown; error?: string }>()
    .catch(() => null);
  if (!response.ok) {
    throw new LaunchRequestError(
      response.status,
      payload?.error ?? "Adaptive item view could not be materialized",
    );
  }
  if (typeof payload?.candidateSafeXml !== "string" || payload.candidateSafeXml.length === 0) {
    throw new LaunchRequestError(500, "Adaptive item view did not include candidate-safe XML");
  }
  return payload.candidateSafeXml;
}
