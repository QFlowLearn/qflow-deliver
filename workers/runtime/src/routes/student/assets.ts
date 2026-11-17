import { parseSafeContentProjection } from "@longsightgroup/qti3-player";
import { resolvePackageAssetReference } from "@harbor/content-model";
import { readReleasedAnswerFeedback } from "./answer-feedback";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../../security/safe-exam-browser";
import { requireAllowedDeliveryContext } from "../delivery-context";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";
import { readAssetIdParam, readAttemptIdQueryParam } from "../route-params";
import { loadAttemptContentContext } from "./content";
import { readTestSequenceView } from "./test-sequence-view";

interface AssetEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
}

export async function handleAssetRequest(c: AppContext): Promise<Response> {
  return readDeliveryAsset({
    env: c.env,
    request: c.req.raw,
    url: requestUrl(c),
    assetId: readAssetIdParam(c),
  });
}

export async function readDeliveryAsset(input: {
  env: AssetEnv;
  request: Request;
  url: URL;
  assetId: string;
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
  const asset = context.manifest.assets[input.assetId];

  if (context.manifest.testSequence) {
    const progress = await readTestSequenceView(input.env.ATTEMPT_COORDINATOR, attemptId);
    const item = context.manifest.items[progress.currentItemRef.itemId];
    if (!item?.assetIds.includes(input.assetId))
      throw new LaunchRequestError(403, "Asset does not belong to the current question");
  }

  if (!asset) {
    throw new LaunchRequestError(404, "Asset not found for pinned attempt");
  }

  const candidateAssets = new Set(
    Object.values(context.manifest.items).flatMap((item) => item.assetIds),
  );
  for (const block of context.manifest.assessmentInstructions) {
    const parsed = parseSafeContentProjection(block.content, (reference) => {
      const resolved = resolvePackageAssetReference(block.assetBaseHref, reference);
      if (!resolved.ok)
        throw new LaunchRequestError(409, "Pinned instruction asset reference is invalid");
      const entry = Object.values(context.manifest.assets).find(
        (value) => value.href === resolved.href,
      );
      if (!entry) throw new LaunchRequestError(409, "Pinned instruction asset is unavailable");
      candidateAssets.add(entry.id);
      return reference;
    });
    if (!parsed.ok) throw new LaunchRequestError(409, "Pinned instruction content is invalid");
  }
  if (!candidateAssets.has(input.assetId)) {
    const released = await readReleasedAnswerFeedback(input.env, context, deliveryContext, {
      requestedAssetId: input.assetId,
    });
    if (!released.assetIds.has(input.assetId))
      throw new LaunchRequestError(403, "Asset is not available for this attempt");
  }

  const assetObject = await input.env.CONTENT_BUCKET.get(asset.objectKey);
  if (!assetObject) {
    throw new LaunchRequestError(409, "Pinned attempt is missing its immutable asset payload");
  }

  const headers = new Headers();
  headers.set("content-type", asset.mediaType);
  headers.set("cache-control", "private, no-store");
  if (asset.sha256) {
    headers.set("etag", `"${asset.sha256}"`);
  }

  return new Response(assetObject.body, {
    status: 200,
    headers,
  });
}
