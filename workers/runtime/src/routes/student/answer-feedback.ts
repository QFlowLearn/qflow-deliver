import {
  isQtiValue,
  parseQtiXml,
  visibleModalFeedback,
  type QtiContentNode,
  type QtiValue,
} from "@longsightgroup/qti3-core";
import {
  parseSafeContentProjection,
  type SafeProjectedContentNode,
} from "@longsightgroup/qti3-player";
import { resolvePackageAssetReference } from "@harbor/content-model";
import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../../attempts/attempt-durable-object";
import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../../security/safe-exam-browser";
import { requireAllowedDeliveryContext } from "../delivery-context";
import type { AppContext } from "../hono-utils";
import { readAttemptIdParam } from "../route-params";
import { buildAssetUrl, loadAttemptContentContext } from "./content";

interface FeedbackEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
}
export interface ReleasedAnswerFeedback {
  readonly itemId: string;
  readonly content: readonly SafeProjectedContentNode[];
}

export async function handleAnswerFeedbackRequest(c: AppContext): Promise<Response> {
  const context = await loadAttemptContentContext({
    db: c.env.HARBOR_DB,
    bucket: c.env.CONTENT_BUCKET,
    attemptId: readAttemptIdParam(c),
  });
  const deliveryContext = await requireAllowedDeliveryContext({
    request: c.req.raw,
    deliveryPolicy: context.deliveryPolicy,
    allowUnsafeSafeExamBrowserUserAgentFallback: isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
      c.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
    ),
  });
  const released = await readReleasedAnswerFeedback(c.env, context, deliveryContext);
  return Response.json(
    { items: released.items, status: released.status },
    { headers: { "cache-control": "private, no-store" } },
  );
}

/** Release requires the current attempt authority and pinned server-computed result outcomes. */
export async function readReleasedAnswerFeedback(
  env: FeedbackEnv,
  context: Awaited<ReturnType<typeof loadAttemptContentContext>>,
  deliveryContext?: Parameters<typeof buildAssetUrl>[0]["deliveryContext"],
  options: { readonly requestedAssetId?: string } = {},
): Promise<{
  readonly status: "withheld" | "pending" | "released";
  readonly items: readonly ReleasedAnswerFeedback[];
  readonly assetIds: ReadonlySet<string>;
}> {
  const none = (status: "withheld" | "pending") => ({
    status,
    items: [],
    assetIds: new Set<string>(),
  });
  const candidates = Object.values(context.manifest.items).filter(
    (item) =>
      item.itemSessionControl?.showFeedback === true &&
      (options.requestedAssetId === undefined ||
        readFeedbackAssetIds(item.feedbackAssetIds).includes(options.requestedAssetId)),
  );
  if (!candidates.length || context.manifest.testSequence) return none("withheld");
  const response = await env.ATTEMPT_COORDINATOR.get(
    env.ATTEMPT_COORDINATOR.idFromName(context.attemptId),
  ).fetch("https://harbor-attempt.local/session", {
    headers: { [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: context.attemptId },
  });
  const session: unknown = await response.json();
  if (!response.ok || !session || typeof session !== "object" || !("attemptStatus" in session))
    throw new LaunchRequestError(409, "Feedback release authority is unavailable");
  if (session.attemptStatus !== "submitted") return none("withheld");
  const result = await env.HARBOR_DB.prepare(
    "SELECT id FROM attempt_results WHERE attempt_id = ? AND assessment_version_id = ? AND summary_source = 'authoritative-qti-snapshot' AND status IN ('complete', 'rescored')",
  )
    .bind(context.attemptId, context.assessmentVersionId)
    .first<{ id: string }>();
  if (!result) return none("pending");
  const rows = await env.HARBOR_DB.prepare(
    "SELECT item_id, outcome_variables_json FROM attempt_result_items WHERE attempt_result_id = ?",
  )
    .bind(result.id)
    .all<{ item_id: string; outcome_variables_json: string }>();
  const outcomes = new Map<string, Record<string, QtiValue>>();
  for (const row of rows.results) {
    if (outcomes.has(row.item_id))
      throw new LaunchRequestError(409, "Feedback result contains duplicate questions");
    outcomes.set(row.item_id, parseOutcomes(row.outcome_variables_json));
  }
  const items: ReleasedAnswerFeedback[] = [],
    assetIds = new Set<string>();
  // Bound parsed XML memory and R2 subrequests by processing one pinned question at a time.
  for (const item of candidates) {
    const values = outcomes.get(item.id);
    if (!values) continue;
    const source = await env.CONTENT_BUCKET.get(item.objectKey);
    if (!source) throw new LaunchRequestError(409, "Pinned feedback source is unavailable");
    const parsed = parseQtiXml(await source.text());
    if (!parsed.ok || !parsed.document || parsed.document.item.identifier !== item.identifier)
      throw new LaunchRequestError(409, "Pinned feedback source is invalid");
    for (const feedback of visibleModalFeedback(parsed.document.item, values)) {
      const content = parseSafeContentProjection(feedback.content.map(projectNode), (reference) => {
        const resolved = resolvePackageAssetReference(item.href, reference);
        if (!resolved.ok)
          throw new LaunchRequestError(409, "Feedback contains an invalid asset reference");
        const asset = Object.values(context.manifest.assets).find(
          (entry) => entry.href === resolved.href,
        );
        if (
          !asset ||
          ![...item.assetIds, ...readFeedbackAssetIds(item.feedbackAssetIds)].includes(asset.id)
        )
          throw new LaunchRequestError(409, "Feedback asset is not bound to this question");
        assetIds.add(asset.id);
        return (
          buildAssetUrl({ attemptId: context.attemptId, assetId: asset.id, deliveryContext }) +
          resolved.fragment
        );
      });
      if (!content.ok) throw new LaunchRequestError(409, "Feedback contains invalid content");
      items.push({ itemId: item.id, content: content.value });
    }
  }
  return { status: "released", items, assetIds };
}

function projectNode(node: QtiContentNode): SafeProjectedContentNode {
  if (node.kind === "text") return { kind: "text", text: node.text };
  if (node.kind === "element")
    return {
      kind: "element",
      name: node.qtiName,
      attributes: node.attributes,
      children: node.children.map(projectNode),
    };
  throw new LaunchRequestError(409, "Feedback contains unsupported dynamic content.");
}
function parseOutcomes(json: string): Record<string, QtiValue> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (_cause: unknown) {
    throw new LaunchRequestError(409, "Feedback outcomes are invalid");
  }
  if (!Array.isArray(value)) throw new LaunchRequestError(409, "Feedback outcomes are invalid");
  const values: Record<string, QtiValue> = {};
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("identifier" in entry) ||
      typeof entry.identifier !== "string" ||
      !("value" in entry) ||
      !isQtiValue(entry.value) ||
      Object.hasOwn(values, entry.identifier)
    )
      throw new LaunchRequestError(409, "Feedback outcome is invalid");
    Object.defineProperty(values, entry.identifier, { value: entry.value, enumerable: true });
  }
  return values;
}
export function readFeedbackAssetIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new LaunchRequestError(409, "Pinned feedback assets are invalid");
  return value;
}
