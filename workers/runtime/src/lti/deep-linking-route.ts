import {
  createLtiResourceLinkContentItem,
  formatLtiServiceError,
  LtiContentItemConstructionError,
  type DeepLinkingContentItem,
  type LTISession,
} from "@longsightgroup/lti-tool";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  readJsonObject,
  readOptionalString,
  readRequiredString,
} from "../routes/route-request-utils";
import {
  readDeepLinkingLaunchMessage,
  readLtiDeepLinkingContentItems,
  readLtiLaunchForm,
  verifyAndStoreLtiSession,
} from "./session";
import { readDeepLinkPlacements } from "./deep-link-placements";
import { createLtiId } from "./ids";
import { assertDeepLinkPlacementBelongsToRegistrationTenant } from "./linkage-tenant";
import {
  HARBOR_LTI_ASSIGNMENT_ID,
  HARBOR_LTI_PLACEMENT_KEY,
  HARBOR_LTI_SECTION_ID,
  type LtiDeepLinkPlacementRequest,
  type LtiEnv,
} from "./types";

import type { PublicLtiContext } from "./context";
import { readRegistrationForBoundSession } from "./harbor-registration";
import { htmlResponse } from "./http";
import { getTenantLtiToolForSession } from "./tenant-routing";

export async function handleHarborLtiDeepLinkingLaunch(c: PublicLtiContext): Promise<Response> {
  return launchLtiDeepLinking({ request: c.req.raw, env: c.env });
}

export async function launchLtiDeepLinking(input: {
  readonly request: Request;
  readonly env: LtiEnv;
}): Promise<Response> {
  const { idToken, state } = await readLtiLaunchForm(input.request);
  const launch = await verifyAndStoreLtiSession(input.env, idToken, state);
  const ltiSession = launch.ltiSession;
  const launchMessage = readDeepLinkingLaunchMessage(ltiSession);
  if (!ltiSession.isInstructor && !ltiSession.isAdmin) {
    throw new LaunchRequestError(403, "LTI deep linking requires instructor access");
  }

  const settings = launchMessage.deepLinkingSettings;
  return Response.json(
    {
      ltiSessionId: ltiSession.id,
      acceptTypes: settings.acceptTypes,
      acceptPresentationDocumentTargets: settings.acceptPresentationDocumentTargets,
      acceptMediaTypes: settings.acceptMediaTypes ?? null,
      data: settings.data ?? null,
    },
    { status: 200 },
  );
}

export async function handleHarborLtiDeepLinkingResponse(c: PublicLtiContext): Promise<Response> {
  return completeLtiDeepLinkingResponse({ request: c.req.raw, env: c.env });
}

export async function completeLtiDeepLinkingResponse(input: {
  readonly request: Request;
  readonly env: LtiEnv;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const ltiSessionId = readRequiredString(body.ltiSessionId, "ltiSessionId is required");
  if (body.contentItems !== undefined) {
    throw new LaunchRequestError(400, "content_items must be used for LTI content items");
  }
  const submittedContentItems =
    body.content_items === undefined ? [] : readLtiDeepLinkingContentItems(body);
  const placements = readDeepLinkPlacements(body.placements);

  const ltiTool = await getTenantLtiToolForSession(input.env, ltiSessionId);
  const ltiSession = await ltiTool.getSession(ltiSessionId);
  if (!ltiSession) {
    throw new LaunchRequestError(404, "LTI session not found");
  }
  readDeepLinkingLaunchMessage(ltiSession);
  if (!ltiSession.isInstructor && !ltiSession.isAdmin) {
    throw new LaunchRequestError(403, "LTI deep linking requires instructor access");
  }

  const registration =
    placements.length > 0
      ? await readRegistrationForBoundSession(input.env.HARBOR_DB, ltiSessionId)
      : null;
  const requestOrigin = new URL(input.request.url).origin;
  const generatedContentItems = registration
    ? await createHarborDeepLinkPlacementItems({
        db: input.env.HARBOR_DB,
        requestOrigin,
        registrationId: registration.id,
        registrationTenantId: registration.tenant_id,
        ltiSession,
        placements,
      })
    : [];
  const contentItems = [...submittedContentItems, ...generatedContentItems];

  const response = await ltiTool
    .createAdvantage(ltiSession)
    .createDeepLinkingResponse(contentItems);
  if (!response.success) {
    throw new LaunchRequestError(502, formatLtiServiceError(response.error));
  }

  return htmlResponse(response.data);
}

async function createHarborDeepLinkPlacementItems(input: {
  db: D1Database;
  requestOrigin: string;
  registrationId: string;
  registrationTenantId: string;
  ltiSession: LTISession;
  placements: LtiDeepLinkPlacementRequest[];
}): Promise<DeepLinkingContentItem[]> {
  const contentItems: DeepLinkingContentItem[] = [];
  const contextId = readOptionalString(input.ltiSession.context.id);
  const launchUrl = new URL("/api/lti/launch", input.requestOrigin).toString();

  for (const placement of input.placements) {
    await assertDeepLinkPlacementBelongsToRegistrationTenant({
      db: input.db,
      registrationTenantId: input.registrationTenantId,
      assignmentId: placement.assignmentId,
      sectionId: placement.sectionId,
    });

    const assignment = await input.db
      .prepare("SELECT id, title FROM assignments WHERE id = ?")
      .bind(placement.assignmentId)
      .first<{ id: string; title: string }>();
    if (!assignment) {
      throw new LaunchRequestError(404, "Deep link assignment not found");
    }

    const now = new Date().toISOString();
    const placementKey = createLtiId("ltidl");
    const title = placement.title ?? assignment.title;
    const lineItemLabel = placement.lineItem?.label ?? title;
    await input.db
      .prepare(
        "INSERT INTO lti_deep_link_placements (id, registration_id, lti_session_id, placement_key, assignment_id, context_id, section_id, title, text, line_item_label, line_item_score_maximum, line_item_tag, linked_resource_link_id, linked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        createLtiId("ltidlrow"),
        input.registrationId,
        input.ltiSession.id,
        placementKey,
        placement.assignmentId,
        contextId,
        placement.sectionId,
        title,
        placement.text,
        placement.lineItem ? lineItemLabel : null,
        placement.lineItem?.scoreMaximum ?? null,
        placement.lineItem?.tag ?? null,
        null,
        null,
        now,
        now,
      )
      .run();

    let item: DeepLinkingContentItem;
    try {
      item = createLtiResourceLinkContentItem({
        title,
        ...(placement.text ? { text: placement.text } : {}),
        url: launchUrl,
        custom: {
          [HARBOR_LTI_PLACEMENT_KEY]: placementKey,
          [HARBOR_LTI_ASSIGNMENT_ID]: placement.assignmentId,
          ...(placement.sectionId ? { [HARBOR_LTI_SECTION_ID]: placement.sectionId } : {}),
        },
        ...(placement.lineItem
          ? {
              lineItem: {
                label: lineItemLabel,
                scoreMaximum: placement.lineItem.scoreMaximum,
                resourceId: placementKey,
                ...(placement.lineItem.tag ? { tag: placement.lineItem.tag } : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof LtiContentItemConstructionError) {
        throw new LaunchRequestError(400, "generated content item is invalid");
      }

      throw error;
    }

    contentItems.push(item);
  }

  return contentItems;
}
