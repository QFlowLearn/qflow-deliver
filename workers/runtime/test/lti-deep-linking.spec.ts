import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import { countRows, get, getTestEnv, postForm, postJson, resetDb } from "./lti-test-environment";
import {
  createAssignment,
  createRegistration,
  createSection,
  publishFixture,
} from "./lti-test-fixtures";
import { performLtiLaunch, submitLtiLaunch } from "./lti-test-launch";
import {
  extractAuthorizeParams,
  extractDeepLinkingJwt,
  issueSignedDeepLinkingIdToken,
  stubPlatformJwksFetch,
} from "./lti-test-platform";

beforeEach(async () => {
  await resetDb();
  stubPlatformJwksFetch();
});

describe("LTI Deep Linking", () => {
  it("stores deep-linking launches and returns signed content item responses", async () => {
    const registration = await createRegistration();
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "lti-deep-linking",
    });
    const sectionId = "section_deep_linking";
    await createSection(sectionId);
    await createAssignment({
      assignmentId: "assign_deep_linking",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      contextId: "context-deep-linking",
      sectionId,
    });

    const loginResponse = await get(
      `/api/lti/login?iss=${encodeURIComponent(registration.issuer)}&client_id=${encodeURIComponent(
        registration.clientId,
      )}&lti_deployment_id=${encodeURIComponent(
        registration.deploymentId,
      )}&login_hint=${encodeURIComponent(
        "instructor-deep-linking",
      )}&target_link_uri=${encodeURIComponent("https://harbor.local/api/lti/deep-linking")}`,
    );

    expect(loginResponse.status).toBe(302);
    const authorizeParams = extractAuthorizeParams(loginResponse.headers.get("location"));
    const idToken = await issueSignedDeepLinkingIdToken({
      issuer: registration.issuer,
      audience: registration.clientId,
      subject: "instructor-deep-linking",
      nonce: authorizeParams.nonce,
      deploymentId: registration.deploymentId,
      targetLinkUri: "https://harbor.local/api/lti/deep-linking",
      returnUrl: "https://platform.harbor.test/deep-linking/return",
      roles: ["https://platform.harbor.test/custom/roles/Instructor"],
    });

    const launchResponse = await postForm("/api/lti/deep-linking", {
      state: authorizeParams.state,
      id_token: idToken,
    });
    expect(launchResponse.status).toBe(200);
    const launch = await launchResponse.json<{
      ltiSessionId: string;
      acceptTypes: string[];
      data: string | null;
    }>();
    expect(launch.acceptTypes).toEqual(["ltiResourceLink"]);
    expect(launch.data).toBe("opaque-platform-data");

    const suppliedContentResponse = await postJson("/api/lti/deep-linking/response", {
      ltiSessionId: launch.ltiSessionId,
      content_items: [
        {
          type: "link",
          title: "Instructor Reference",
          url: "https://harbor.local/instructor/reference",
        },
      ],
    });
    expect(suppliedContentResponse.status).toBe(200);
    const suppliedContentPayload = decodeJwt(
      extractDeepLinkingJwt(await suppliedContentResponse.text()),
    ) as Record<string, unknown>;
    expect(
      suppliedContentPayload["https://purl.imsglobal.org/spec/lti-dl/claim/content_items"],
    ).toEqual([
      expect.objectContaining({
        type: "link",
        title: "Instructor Reference",
        url: "https://harbor.local/instructor/reference",
      }),
    ]);

    const camelCaseContentResponse = await postJson("/api/lti/deep-linking/response", {
      ltiSessionId: launch.ltiSessionId,
      contentItems: [],
    });
    expect(camelCaseContentResponse.status).toBe(400);
    await expect(camelCaseContentResponse.json()).resolves.toEqual({
      error: "content_items must be used for LTI content items",
    });

    const response = await postJson("/api/lti/deep-linking/response", {
      ltiSessionId: launch.ltiSessionId,
      placements: [
        {
          assignmentId: "assign_deep_linking",
          sectionId,
          title: "Harbor Quiz",
          text: "Biology unit quiz",
          lineItem: {
            scoreMaximum: 10,
            label: "Harbor Quiz",
            tag: "harbor",
          },
        },
      ],
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="deepLinkingForm"');
    expect(html).toContain("https://platform.harbor.test/deep-linking/return");
    expect(html).toContain('name="JWT"');

    const deepLinkingJwt = extractDeepLinkingJwt(html);
    const deepLinkingPayload = decodeJwt(deepLinkingJwt) as Record<string, unknown>;
    const contentItems = deepLinkingPayload[
      "https://purl.imsglobal.org/spec/lti-dl/claim/content_items"
    ] as Array<{
      type: string;
      title: string;
      url: string;
      custom: Record<string, string>;
      lineItem: { scoreMaximum: number; label: string; resourceId: string };
    }>;
    expect(contentItems).toHaveLength(1);
    expect(contentItems[0]).toEqual(
      expect.objectContaining({
        type: "ltiResourceLink",
        title: "Harbor Quiz",
        url: "https://harbor.local/api/lti/launch",
        lineItem: expect.objectContaining({
          label: "Harbor Quiz",
          scoreMaximum: 10,
        }),
      }),
    );
    const placementKey = contentItems[0].custom.harbor_deep_link_placement_key;
    expect(placementKey).toBeTruthy();
    expect(contentItems[0].custom).toEqual(
      expect.objectContaining({
        harbor_assignment_id: "assign_deep_linking",
        harbor_section_id: sectionId,
      }),
    );
    expect(await countRows("lti_deep_link_placements")).toBe(1);
    expect(await countRows("lti_resource_links")).toBe(0);

    const launchFromCanvasPlacement = await performLtiLaunch({
      issuer: registration.issuer,
      clientId: registration.clientId,
      deploymentId: registration.deploymentId,
      subject: "student-deep-linking",
      resourceLinkId: "canvas-resource-link-1",
      contextId: "context-deep-linking",
      custom: {
        harbor_deep_link_placement_key: placementKey,
        harbor_assignment_id: "assign_deep_linking",
        harbor_section_id: sectionId,
      },
    });
    expect(launchFromCanvasPlacement.launchResponse.status).toBe(302);
    const linkedResource = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT assignment_id, resource_link_id, section_id FROM lti_resource_links WHERE registration_id = ?",
      )
      .bind(registration.registrationId)
      .first<{
        assignment_id: string;
        resource_link_id: string;
        section_id: string | null;
      }>();
    expect(linkedResource).toEqual({
      assignment_id: "assign_deep_linking",
      resource_link_id: "canvas-resource-link-1",
      section_id: sectionId,
    });
  });

  it("rejects deep-link placement when assignment tenant does not match the registration tenant", async () => {
    const registrationTenantId = "tenant_dl_reg";
    const assignmentTenantId = "tenant_dl_assign";
    const registration = await createRegistration({
      registrationId: "ltireg_dl_mismatch",
      tenantId: registrationTenantId,
    });
    const published = await publishFixture({
      tenantId: assignmentTenantId,
      assessmentSlug: "lti-deep-link-tenant-mismatch",
    });
    const sectionId = "section_dl_mismatch";
    await createSection(sectionId, assignmentTenantId);
    await createAssignment({
      assignmentId: "assign_dl_mismatch",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      sectionId,
    });

    const loginResponse = await get(
      `/api/lti/login?iss=${encodeURIComponent(registration.issuer)}&client_id=${encodeURIComponent(
        registration.clientId,
      )}&lti_deployment_id=${encodeURIComponent(
        registration.deploymentId,
      )}&login_hint=${encodeURIComponent(
        "instructor-dl-mismatch",
      )}&target_link_uri=${encodeURIComponent("https://harbor.local/api/lti/deep-linking")}`,
    );
    expect(loginResponse.status).toBe(302);
    const authorizeParams = extractAuthorizeParams(loginResponse.headers.get("location"));
    const idToken = await issueSignedDeepLinkingIdToken({
      issuer: registration.issuer,
      audience: registration.clientId,
      subject: "instructor-dl-mismatch",
      nonce: authorizeParams.nonce,
      deploymentId: registration.deploymentId,
      targetLinkUri: "https://harbor.local/api/lti/deep-linking",
      returnUrl: "https://platform.harbor.test/deep-linking/return",
    });
    const launchResponse = await postForm("/api/lti/deep-linking", {
      state: authorizeParams.state,
      id_token: idToken,
    });
    expect(launchResponse.status).toBe(200);
    const launch = await launchResponse.json<{ ltiSessionId: string }>();

    const response = await postJson("/api/lti/deep-linking/response", {
      ltiSessionId: launch.ltiSessionId,
      placements: [
        {
          assignmentId: "assign_dl_mismatch",
          sectionId,
          title: "Cross Tenant Quiz",
        },
      ],
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Deep link assignment does not belong to the registration tenant",
    });
    expect(await countRows("lti_deep_link_placements")).toBe(0);
  });

  it("rejects launch auto-bind from a cross-tenant deep-link placement without creating resource links", async () => {
    const registrationTenantId = "tenant_dl_launch_reg";
    const assignmentTenantId = "tenant_dl_launch_assign";
    const registration = await createRegistration({
      registrationId: "ltireg_dl_launch_guard",
      tenantId: registrationTenantId,
    });
    const published = await publishFixture({
      tenantId: assignmentTenantId,
      assessmentSlug: "lti-deep-link-launch-guard",
    });
    const sectionId = "section_dl_launch_guard";
    await createSection(sectionId, assignmentTenantId);
    await createAssignment({
      assignmentId: "assign_dl_launch_guard",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      sectionId,
    });

    const placementKey = "ltidl_cross_tenant_bad";
    const now = new Date().toISOString();
    await getTestEnv()
      .HARBOR_DB.prepare(
        "INSERT INTO lti_deep_link_placements (id, registration_id, lti_session_id, placement_key, assignment_id, context_id, section_id, title, text, line_item_label, line_item_score_maximum, line_item_tag, linked_resource_link_id, linked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "ltidlrow_cross_tenant_bad",
        registration.registrationId,
        "ltisess_cross_tenant_bad",
        placementKey,
        "assign_dl_launch_guard",
        "context-dl-launch-guard",
        sectionId,
        "Cross Tenant Quiz",
        null,
        null,
        null,
        null,
        null,
        null,
        now,
        now,
      )
      .run();

    const launchResponse = await submitLtiLaunch({
      issuer: registration.issuer,
      clientId: registration.clientId,
      deploymentId: registration.deploymentId,
      subject: "student-dl-launch-guard",
      resourceLinkId: "canvas-resource-cross-tenant",
      contextId: "context-dl-launch-guard",
      custom: {
        harbor_deep_link_placement_key: placementKey,
        harbor_assignment_id: "assign_dl_launch_guard",
        harbor_section_id: sectionId,
      },
    });

    expect(launchResponse.status).toBe(403);
    await expect(launchResponse.json()).resolves.toEqual({
      error: "LTI registration does not match the linked assignment tenant",
    });
    expect(await countRows("lti_resource_links")).toBe(0);
  });
});
