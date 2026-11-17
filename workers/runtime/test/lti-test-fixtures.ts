import JSZip from "jszip";
import { exports as workerExports } from "cloudflare:workers";
import { expect } from "vitest";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

import { ADMIN_HEADERS, getTestEnv, postJson } from "./lti-test-environment";

export async function createFixturePackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  return zip.generateAsync({ type: "uint8array" });
}

export async function publishFixture(input: { tenantId: string; assessmentSlug: string }): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "lti-launch.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

export async function createRegistration(input?: {
  registrationId?: string;
  tenantId?: string;
  issuer?: string;
  clientId?: string;
  deploymentId?: string;
  authorizationEndpoint?: string;
  jwksUrl?: string;
  tokenEndpoint?: string;
}): Promise<{
  registrationId: string;
  issuer: string;
  clientId: string;
  deploymentId: string;
  authorizationEndpoint: string;
  jwksUrl: string;
  tokenEndpoint: string;
}> {
  const response = await postJson(
    "/internal/lti/registrations",
    {
      registrationId: input?.registrationId ?? "ltireg_phase6",
      tenantId: input?.tenantId ?? "tenant_local_demo",
      issuer: input?.issuer ?? "https://platform.harbor.test",
      clientId: input?.clientId ?? "harbor-client",
      deploymentId: input?.deploymentId ?? "deployment-1",
      authorizationEndpoint:
        input?.authorizationEndpoint ?? "https://platform.harbor.test/authorize",
      jwksUrl: input?.jwksUrl ?? "https://platform.harbor.test/jwks",
      tokenEndpoint: input?.tokenEndpoint ?? "https://platform.harbor.test/token",
    },
    ADMIN_HEADERS,
  );

  expect(response.status).toBe(201);
  return response.json();
}

export async function createAssignment(input: {
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  registrationId: string;
  resourceLinkId?: string;
  contextId?: string | null;
  sectionId?: string | null;
}): Promise<void> {
  const response = await postAssignment(input);
  expect(response.status).toBe(201);
}

export async function postAssignment(input: {
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  registrationId: string;
  resourceLinkId?: string;
  contextId?: string | null;
  sectionId?: string | null;
}): Promise<Response> {
  return postJson("/internal/assignments", {
    assignmentId: input.assignmentId,
    assessmentId: input.assessmentId,
    assessmentVersionId: input.assessmentVersionId,
    title: "LTI Biology Quiz",
    actor: {
      role: "instructor",
      actorId: "inst_lti",
      displayName: "LTI Instructor",
    },
    policySnapshot: {
      availableFrom: "2026-03-27T00:00:00.000Z",
      availableUntil: "2026-12-31T00:00:00.000Z",
      reportingTimezone: "America/New_York",
      maxAttempts: 2,
      timeLimitSeconds: 1800,
      gracePeriodSeconds: 30,
      navigationMode: "free",
      standaloneAllowed: true,
      iframeAllowed: false,
      allowedEmbedOrigins: [],
      secureBrowserRequired: false,
      secureBrowserProviderHint: null,
      proctoringProvider: null,
    },
    targets: input.sectionId ? [{ kind: "section", sectionId: input.sectionId }] : [],
    ltiLinkages: input.resourceLinkId
      ? [
          {
            registrationId: input.registrationId,
            resourceLinkId: input.resourceLinkId,
            contextId: input.contextId ?? null,
            sectionId: input.sectionId ?? null,
          },
        ]
      : [],
  });
}

export async function createSection(
  sectionId: string,
  tenantId = "tenant_local_demo",
): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  await HARBOR_DB.prepare(
    "INSERT INTO sections (id, tenant_id, source_kind, source_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      sectionId,
      tenantId,
      "lti-context",
      sectionId,
      "LTI Section",
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
}
