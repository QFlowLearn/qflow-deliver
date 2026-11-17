import { readFileSync } from "node:fs";
import path from "node:path";

import JSZip from "jszip";
import { expect, test } from "@playwright/test";

const workerOrigin = "http://127.0.0.1:8787";
const pageOrigin = "http://127.0.0.1:4173";
const fixtureRoot = path.resolve(process.cwd(), "tests/fixtures/qti/basic-assessment");
const PLATFORM_PRIVATE_JWK = {
  kty: "EC",
  x: "mi9xmm1TKc3uXIScOiQJmGp0iOrty6TiAkWu0XBJQ80",
  y: "oYmJp1NRUafGLAB23ZtZaFIHl2rGop2ZXc6rwP_fN9s",
  crv: "P-256",
  d: "8sGcrYlcpc7XTMeOduRhR5zhavBUttH2bVtU1yZt-wE",
  alg: "ES256",
  use: "sig",
  kid: "platform-test-1",
} as const;
const PLATFORM_PUBLIC_JWK = {
  kty: "EC",
  x: PLATFORM_PRIVATE_JWK.x,
  y: PLATFORM_PRIVATE_JWK.y,
  crv: "P-256",
  alg: "ES256",
  use: "sig",
  kid: "platform-test-1",
} as const;

async function createFixturePackage(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", readFileSync(path.join(fixtureRoot, "imsmanifest.xml"), "utf8"));
  zip.file("items/item-1.xml", readFileSync(path.join(fixtureRoot, "items/item-1.xml"), "utf8"));
  zip.file(
    "assets/stimulus.svg",
    readFileSync(path.join(fixtureRoot, "assets/stimulus.svg"), "utf8"),
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

function platformJwksDataUrl(): string {
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({ keys: [PLATFORM_PUBLIC_JWK] }),
  )}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function issueSignedLtiIdToken(input: {
  issuer: string;
  audience: string;
  subject: string;
  nonce: string;
  deploymentId: string;
  targetLinkUri: string;
  resourceLinkId: string;
  contextId: string;
  displayName: string;
  email: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({
    alg: "ES256",
    kid: PLATFORM_PRIVATE_JWK.kid,
    typ: "JWT",
  });
  const payload = base64UrlJson({
    iss: input.issuer,
    aud: input.audience,
    sub: input.subject,
    iat: now,
    exp: now + 300,
    nonce: input.nonce,
    given_name: "Taylor",
    family_name: "LTI",
    name: input.displayName,
    email: input.email,
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": input.deploymentId,
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": input.targetLinkUri,
    "https://purl.imsglobal.org/spec/lti/claim/roles": [
      "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
    ],
    "https://purl.imsglobal.org/spec/lti/claim/resource_link": {
      id: input.resourceLinkId,
    },
    "https://purl.imsglobal.org/spec/lti/claim/context": {
      id: input.contextId,
    },
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    PLATFORM_PRIVATE_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  ).toString("base64url");

  return `${signingInput}.${signature}`;
}

function readRequiredHeader(headers: Record<string, string>, name: string): string {
  const value = headers[name.toLowerCase()];
  expect(value).toBeTruthy();
  return value;
}

function parseSetCookie(value: string): { name: string; value: string } {
  const [cookie] = value.split(";", 1);
  const [name, ...parts] = (cookie ?? "").split("=");
  expect(name).toBeTruthy();
  return {
    name: name ?? "",
    value: parts.join("="),
  };
}

async function publishFixture(
  request: Parameters<typeof test>[0]["request"],
  seed: string,
): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
}> {
  const response = await request.post(`${workerOrigin}/internal/publish?assessmentSlug=${seed}`, {
    headers: {
      "content-type": "application/zip",
      "x-harbor-package-name": "phase6-lti-entry.zip",
      "x-harbor-tenant-id": "tenant_local_demo",
    },
    data: await createFixturePackage(),
  });

  expect(response.status()).toBe(201);
  return response.json();
}

test("emulated LTI resource-link launch lands in Harbor with the linked assessment and learner session", async ({
  page,
  request,
}, testInfo) => {
  const published = await publishFixture(
    request,
    `phase6-lti-entry-${testInfo.parallelIndex}-${Date.now()}`,
  );
  const registrationId = `ltireg_phase6_e2e_${testInfo.parallelIndex}_${Date.now()}`;
  const resourceLinkId = `resource_phase6_e2e_${testInfo.parallelIndex}_${Date.now()}`;
  const clientId = `harbor-client-${testInfo.parallelIndex}-${Date.now()}`;
  const deploymentId = `deployment-phase6-e2e-${testInfo.parallelIndex}-${Date.now()}`;
  const issuer = "https://platform.harbor.test";

  const registrationResponse = await request.post(`${workerOrigin}/internal/lti/registrations`, {
    headers: {
      "x-harbor-admin-key": "harbor-admin-local-secret",
    },
    data: {
      registrationId,
      tenantId: "tenant_local_demo",
      issuer,
      clientId,
      deploymentId,
      authorizationEndpoint: "https://platform.harbor.test/authorize",
      jwksUrl: platformJwksDataUrl(),
      tokenEndpoint: "https://platform.harbor.test/token",
    },
  });
  expect(registrationResponse.status()).toBe(201);
  const registration = await registrationResponse.json();

  const createAssignment = await request.post(`${workerOrigin}/internal/assignments`, {
    data: {
      assignmentId: `assign_phase6_lti_e2e_${testInfo.parallelIndex}_${Date.now()}`,
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "LTI Entry Biology Quiz",
      actor: {
        role: "instructor",
        actorId: "inst_phase6_lti",
        displayName: "Phase 6 LTI Instructor",
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
      ltiLinkages: [
        {
          registrationId: registration.registrationId,
          resourceLinkId,
          contextId: "context-phase6-e2e",
        },
      ],
    },
  });
  expect(createAssignment.status()).toBe(201);

  const loginUrl = new URL("/api/lti/login", workerOrigin);
  loginUrl.searchParams.set("iss", issuer);
  loginUrl.searchParams.set("client_id", clientId);
  loginUrl.searchParams.set("lti_deployment_id", deploymentId);
  loginUrl.searchParams.set("login_hint", "student-phase6-lti");
  loginUrl.searchParams.set("target_link_uri", "/api/lti/launch");
  loginUrl.searchParams.set(
    "lti_message_hint",
    JSON.stringify({
      resourceLinkId,
      contextId: "context-phase6-e2e",
      displayName: "Taylor LTI",
      email: "taylor.lti@example.edu",
    }),
  );
  const loginResponse = await request.get(loginUrl.toString(), {
    maxRedirects: 0,
  });
  expect(loginResponse.status()).toBe(302);
  const authorizeUrl = new URL(readRequiredHeader(loginResponse.headers(), "location"));
  const idToken = await issueSignedLtiIdToken({
    issuer,
    audience: clientId,
    subject: authorizeUrl.searchParams.get("login_hint") ?? "student-phase6-lti",
    nonce: authorizeUrl.searchParams.get("nonce") ?? "",
    deploymentId,
    targetLinkUri: authorizeUrl.searchParams.get("redirect_uri") ?? "",
    resourceLinkId,
    contextId: "context-phase6-e2e",
    displayName: "Taylor LTI",
    email: "taylor.lti@example.edu",
  });
  const launchResponse = await request.post(`${workerOrigin}/api/lti/launch`, {
    form: {
      state: authorizeUrl.searchParams.get("state") ?? "",
      id_token: idToken,
    },
    maxRedirects: 0,
  });
  expect(launchResponse.status()).toBe(302);
  const location = readRequiredHeader(launchResponse.headers(), "location");
  const sessionCookie = parseSetCookie(readRequiredHeader(launchResponse.headers(), "set-cookie"));
  await page.context().addCookies([
    {
      name: sessionCookie.name,
      value: sessionCookie.value,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);

  await page.goto(new URL(location, pageOrigin).toString());

  await expect(page).toHaveURL(/\/session/);
  await expect(page.getByTestId("harbor-shell")).toHaveAttribute("data-launch-mode", "lti");
  await expect(page.getByTestId("attempt-id")).toHaveCount(1);
  await expect(page.getByTestId("delivery-state")).toHaveText("active");

  const sessionPayload = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    return {
      status: response.status,
      body: await response.json(),
    };
  });
  expect(sessionPayload.status).toBe(200);
  expect(sessionPayload.body.session.providerKind).toBe("lti");
  expect(sessionPayload.body.learner.displayName).toBe("Taylor LTI");

  await page.getByTestId("session-home-button").click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  await expect(page.getByTestId("signed-in-learner")).toHaveText("Taylor LTI");
});
