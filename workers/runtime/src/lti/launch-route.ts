import {
  resolveLtiServiceCapabilities,
  type LTISession,
  type ResolvedLtiResourceLinkLaunchMessage,
} from "@longsightgroup/lti-tool";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import { issueBootstrapEnvelope } from "../launch/sign-bootstrap";
import {
  buildSessionCookieHeader,
  createHarborSession,
  ensureLearnerIdentity,
} from "../routes/auth/session";
import { buildEntryLaunchResolution, launchStudentAssignment } from "../routes/launch";
import { readOptionalString } from "../routes/route-request-utils";
import { appendAttemptTimelineEvent } from "../routes/operator-actions";
import { createLtiId } from "./ids";
import { ensureLaunchSectionMembership } from "./launch-section-membership";
import {
  HARBOR_LTI_ASSIGNMENT_ID,
  HARBOR_LTI_PLACEMENT_KEY,
  type LtiDeepLinkPlacementRow,
  type LtiEnv,
  type LtiResourceLinkRow,
} from "./types";

import { resolveLaunchTenantId } from "./launch-tenant";
import type { LtiRegistrationRow } from "./types";

/** Launches a Harbor assignment from an already verified LTI Resource Link session. */
export async function launchLtiResourceLink(input: {
  readonly env: LtiEnv;
  readonly ltiSession: LTISession;
  readonly registration: LtiRegistrationRow;
  readonly launchMessage: ResolvedLtiResourceLinkLaunchMessage;
}): Promise<Response> {
  const registration = input.registration;
  const subject = input.ltiSession.user.id;
  if (!subject) {
    throw new LaunchRequestError(400, "LTI Resource Link launch requires a user subject");
  }
  const resourceLinkId = input.launchMessage.resourceLink.id;
  const contextId = input.launchMessage.context?.id ?? null;

  let mappedLink = await input.env.HARBOR_DB.prepare(
    "SELECT assignment_id, section_id, context_id FROM lti_resource_links WHERE registration_id = ? AND resource_link_id = ?",
  )
    .bind(registration.id, resourceLinkId)
    .first<LtiResourceLinkRow>();
  mappedLink ??= await bindLtiResourceLinkFromDeepLinkPlacement({
    db: input.env.HARBOR_DB,
    registration,
    ltiSession: input.ltiSession,
    resourceLinkId,
    contextId,
  });
  if (!mappedLink) {
    throw new LaunchRequestError(
      403,
      "No QFlowLearn Delivery assignment is linked to this resource link",
    );
  }

  if (mappedLink.context_id && mappedLink.context_id !== contextId) {
    throw new LaunchRequestError(
      403,
      "LTI context did not match the linked QFlowLearn Delivery assignment",
    );
  }

  const tenantId = await resolveLaunchTenantId({
    db: input.env.HARBOR_DB,
    registration,
    assignmentId: mappedLink.assignment_id,
    sectionId: mappedLink.section_id,
  });

  const learner = await ensureLearnerIdentity({
    db: input.env.HARBOR_DB,
    tenantId,
    providerKind: "lti",
    issuer: registration.issuer,
    subject,
    displayName:
      (typeof input.ltiSession.user.name === "string" && input.ltiSession.user.name.trim()) ||
      "LTI Learner",
    email: readOptionalString(input.ltiSession.user.email),
  });
  const session = await createHarborSession({
    db: input.env.HARBOR_DB,
    learner,
    providerKind: "lti",
    issuer: registration.issuer,
    subject,
  });

  if (mappedLink.section_id) {
    await ensureLaunchSectionMembership({
      db: input.env.HARBOR_DB,
      learnerId: learner.id,
      sectionId: mappedLink.section_id,
    });
  }

  const attempt = await launchStudentAssignment({
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
    attemptCoordinator: input.env.ATTEMPT_COORDINATOR,
    assignmentId: mappedLink.assignment_id,
    source: "lti",
    learner: {
      learner,
      session,
    },
    eligibility: {
      kind: "external-platform-launch",
      source: "lti",
      registrationId: registration.id,
      sessionId: input.ltiSession.id,
    },
  });
  await upsertLtiAttemptLaunch({
    db: input.env.HARBOR_DB,
    attemptId: attempt.attemptId,
    registrationId: registration.id,
    ltiSession: input.ltiSession,
    harborSessionId: session.id,
    learnerId: learner.id,
    resourceLinkId,
    contextId,
  });
  const resolution = buildEntryLaunchResolution({
    attempt,
    source: "lti",
    assignmentId: mappedLink.assignment_id,
    learnerId: learner.id,
    sessionId: session.id,
  });
  await appendAttemptTimelineEvent({
    db: input.env.HARBOR_DB,
    attemptId: attempt.attemptId,
    eventType: "launch",
    summary: {
      launchMode: resolution.source,
      assessmentVersionId: resolution.assessmentVersionId,
      assignmentId: resolution.assignmentId,
      learnerId: resolution.learnerId,
      sessionId: resolution.sessionId,
      ltiSessionId: input.ltiSession.id,
      resourceLinkId,
    },
  });
  const envelope = await issueBootstrapEnvelope({
    attempt,
    secret: input.env.BOOTSTRAP_SIGNING_SECRET,
  });

  const headers = new Headers();
  headers.set(
    "set-cookie",
    await buildSessionCookieHeader(
      session.id,
      input.env.BOOTSTRAP_SIGNING_SECRET,
      session.expiresAt,
    ),
  );
  headers.set(
    "location",
    `/session?mode=${encodeURIComponent(
      resolution.source,
    )}&bootstrapToken=${encodeURIComponent(envelope.bootstrapToken)}`,
  );

  return new Response(null, {
    status: 302,
    headers,
  });
}

async function bindLtiResourceLinkFromDeepLinkPlacement(input: {
  db: D1Database;
  registration: LtiRegistrationRow;
  ltiSession: LTISession;
  resourceLinkId: string;
  contextId: string | null;
}): Promise<LtiResourceLinkRow | null> {
  const placementKey = readOptionalString(
    input.ltiSession.customParameters[HARBOR_LTI_PLACEMENT_KEY],
  );
  if (!placementKey) {
    return null;
  }

  const placement = await input.db
    .prepare(
      "SELECT assignment_id, section_id, context_id FROM lti_deep_link_placements WHERE registration_id = ? AND placement_key = ?",
    )
    .bind(input.registration.id, placementKey)
    .first<LtiDeepLinkPlacementRow>();
  if (!placement) {
    throw new LaunchRequestError(403, "LTI deep link placement is not recognized");
  }

  const customAssignmentId = readOptionalString(
    input.ltiSession.customParameters[HARBOR_LTI_ASSIGNMENT_ID],
  );
  if (customAssignmentId && customAssignmentId !== placement.assignment_id) {
    throw new LaunchRequestError(403, "LTI deep link placement assignment mismatch");
  }

  await resolveLaunchTenantId({
    db: input.db,
    registration: input.registration,
    assignmentId: placement.assignment_id,
    sectionId: placement.section_id,
  });

  const now = new Date().toISOString();
  await input.db
    .prepare(
      "INSERT INTO lti_resource_links (id, registration_id, assignment_id, resource_link_id, context_id, section_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(registration_id, resource_link_id) DO NOTHING",
    )
    .bind(
      createLtiId("ltilink"),
      input.registration.id,
      placement.assignment_id,
      input.resourceLinkId,
      placement.context_id ?? input.contextId,
      placement.section_id,
      now,
      now,
    )
    .run();
  await input.db
    .prepare(
      "UPDATE lti_deep_link_placements SET linked_resource_link_id = ?, linked_at = ?, updated_at = ? WHERE registration_id = ? AND placement_key = ?",
    )
    .bind(input.resourceLinkId, now, now, input.registration.id, placementKey)
    .run();

  return input.db
    .prepare(
      "SELECT assignment_id, section_id, context_id FROM lti_resource_links WHERE registration_id = ? AND resource_link_id = ?",
    )
    .bind(input.registration.id, input.resourceLinkId)
    .first<LtiResourceLinkRow>();
}

async function upsertLtiAttemptLaunch(input: {
  db: D1Database;
  attemptId: string;
  registrationId: string;
  ltiSession: LTISession;
  harborSessionId: string;
  learnerId: string;
  resourceLinkId: string;
  contextId: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const capabilities = resolveLtiServiceCapabilities(input.ltiSession);
  await input.db
    .prepare(
      "INSERT INTO lti_attempt_launches (attempt_id, registration_id, lti_session_id, harbor_session_id, learner_id, resource_link_id, context_id, ags_lineitem_url, ags_lineitems_url, ags_scopes_json, nrps_membership_url, nrps_versions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET registration_id = excluded.registration_id, lti_session_id = excluded.lti_session_id, harbor_session_id = excluded.harbor_session_id, learner_id = excluded.learner_id, resource_link_id = excluded.resource_link_id, context_id = excluded.context_id, ags_lineitem_url = excluded.ags_lineitem_url, ags_lineitems_url = excluded.ags_lineitems_url, ags_scopes_json = excluded.ags_scopes_json, nrps_membership_url = excluded.nrps_membership_url, nrps_versions_json = excluded.nrps_versions_json, updated_at = excluded.updated_at",
    )
    .bind(
      input.attemptId,
      input.registrationId,
      input.ltiSession.id,
      input.harborSessionId,
      input.learnerId,
      input.resourceLinkId,
      input.contextId,
      capabilities.ags.lineitem ?? null,
      capabilities.ags.lineitems ?? null,
      JSON.stringify(capabilities.ags.scopes),
      capabilities.nrps.membershipUrl ?? null,
      JSON.stringify(capabilities.nrps.versions),
      now,
      now,
    )
    .run();
}
