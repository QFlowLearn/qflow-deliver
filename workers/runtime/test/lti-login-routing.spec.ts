import { beforeEach, describe, expect, it } from "vitest";

import { countRows, get, postForm, resetDb, tableExists } from "./lti-test-environment";
import { createRegistration } from "./lti-test-fixtures";
import { extractAuthorizeParams, issueSignedIdToken, servePlatformJwks } from "./lti-test-platform";

beforeEach(async () => {
  await resetDb();
  servePlatformJwks();
});

describe("LTI login and routing", () => {
  it("rejects unknown callback state without creating learner, session, or attempt state", async () => {
    const registration = await createRegistration();

    const loginResponse = await get(
      `/api/lti/login?iss=${encodeURIComponent(registration.issuer)}&client_id=${encodeURIComponent(
        registration.clientId,
      )}&lti_deployment_id=${encodeURIComponent(
        registration.deploymentId,
      )}&login_hint=student-lti-state&target_link_uri=${encodeURIComponent(
        "https://harbor.local/api/lti/launch",
      )}&lti_message_hint=${encodeURIComponent(
        JSON.stringify({
          resourceLinkId: "resource-state",
          contextId: "context-state",
          displayName: "Taylor LTI",
          email: "taylor.lti@example.edu",
        }),
      )}`,
    );

    expect(loginResponse.status).toBe(302);
    const authorizeParams = extractAuthorizeParams(loginResponse.headers.get("location"));
    expect(authorizeParams.login_hint).toBe("student-lti-state");
    expect(authorizeParams.nonce).toBeTruthy();
    expect(await countRows("lti_nonces")).toBe(0);
    expect(await tableExists("lti_launch_states")).toBe(false);

    const idToken = await issueSignedIdToken({
      issuer: registration.issuer,
      audience: registration.clientId,
      subject: authorizeParams.login_hint,
      nonce: authorizeParams.nonce,
      deploymentId: registration.deploymentId,
      targetLinkUri: authorizeParams.redirect_uri,
      resourceLinkId: "resource-state",
      contextId: "context-state",
    });
    const invalidLaunch = await postForm("/api/lti/launch", {
      state: "bogus_state",
      id_token: idToken,
    });

    expect(invalidLaunch.status).toBe(401);
    expect(await countRows("harbor_learners")).toBe(0);
    expect(await countRows("harbor_sessions")).toBe(0);
    expect(await countRows("attempt_entries")).toBe(0);
  });

  it("rejects malformed launch form posts with Harbor's short parse error", async () => {
    const launchResponse = await postForm("/api/lti/launch", {
      state: "state_malformed",
      id_token: "not-a-jwt",
    });

    expect(launchResponse.status).toBe(400);
    await expect(launchResponse.json()).resolves.toEqual({
      error: "Invalid LTI launch form",
    });
  });

  it("accepts POST /login with the same login parsing semantics as GET", async () => {
    const registration = await createRegistration();

    const loginResponse = await postForm("/api/lti/login", {
      iss: registration.issuer,
      client_id: registration.clientId,
      lti_deployment_id: registration.deploymentId,
      login_hint: "student-post-login",
      target_link_uri: "/api/lti/launch",
    });

    expect(loginResponse.status).toBe(302);
    const authorizeParams = extractAuthorizeParams(loginResponse.headers.get("location"));
    expect(authorizeParams.login_hint).toBe("student-post-login");
    expect(authorizeParams.redirect_uri).toBe("https://harbor.local/api/lti/launch");
  });

  it("rejects login without lti_deployment_id when multiple registrations share issuer and client_id", async () => {
    const issuer = "https://platform.harbor.test";
    const clientId = "shared-client";
    await createRegistration({
      registrationId: "ltireg_deploy_a",
      issuer,
      clientId,
      deploymentId: "deployment-a",
    });
    await createRegistration({
      registrationId: "ltireg_deploy_b",
      issuer,
      clientId,
      deploymentId: "deployment-b",
    });

    const loginResponse = await get(
      `/api/lti/login?iss=${encodeURIComponent(issuer)}&client_id=${encodeURIComponent(
        clientId,
      )}&login_hint=student-ambiguous&target_link_uri=${encodeURIComponent(
        "https://harbor.local/api/lti/launch",
      )}`,
    );

    expect(loginResponse.status).toBe(409);
    expect(await loginResponse.json()).toEqual({
      error:
        "lti_deployment_id is required when multiple registrations share the same issuer and client_id",
    });
  });

  it("rejects invalid deployment claims before creating learner, session, or attempt state", async () => {
    const registration = await createRegistration({
      registrationId: "ltireg_invalid_deployment",
      deploymentId: "deployment-valid",
    });

    const loginResponse = await get(
      `/api/lti/login?iss=${encodeURIComponent(registration.issuer)}&client_id=${encodeURIComponent(
        registration.clientId,
      )}&lti_deployment_id=${encodeURIComponent(
        registration.deploymentId,
      )}&login_hint=student-lti-invalid&target_link_uri=${encodeURIComponent(
        "https://harbor.local/api/lti/launch",
      )}&lti_message_hint=${encodeURIComponent(
        JSON.stringify({
          resourceLinkId: "resource-invalid",
          contextId: "context-invalid",
          displayName: "Taylor LTI",
          email: "taylor.lti@example.edu",
        }),
      )}`,
    );

    expect(loginResponse.status).toBe(302);
    const authorizeParams = extractAuthorizeParams(loginResponse.headers.get("location"));
    const invalidToken = await issueSignedIdToken({
      issuer: registration.issuer,
      audience: registration.clientId,
      subject: authorizeParams.login_hint,
      nonce: authorizeParams.nonce,
      deploymentId: "deployment-wrong",
      targetLinkUri: authorizeParams.redirect_uri,
      resourceLinkId: "resource-invalid",
      contextId: "context-invalid",
    });

    const launchResponse = await postForm("/api/lti/launch", {
      state: authorizeParams.state,
      id_token: invalidToken,
    });

    expect(launchResponse.status).toBe(404);
    await expect(launchResponse.json()).resolves.toEqual({
      error: "LTI registration not found",
    });
    expect(await countRows("harbor_learners")).toBe(0);
    expect(await countRows("harbor_sessions")).toBe(0);
    expect(await countRows("attempt_entries")).toBe(0);
  });

  it("bounds unverified client routing hints before querying registrations", async () => {
    const registration = await createRegistration({
      registrationId: "ltireg_bounded_audience",
    });
    const idToken = await issueSignedIdToken({
      issuer: registration.issuer,
      audience: [
        registration.clientId,
        "client-2",
        "client-3",
        "client-4",
        "client-5",
        "client-6",
        "client-7",
        "client-8",
        "client-9",
      ],
      subject: "student-bounded-audience",
      nonce: "nonce-bounded-audience",
      deploymentId: registration.deploymentId,
      targetLinkUri: "https://harbor.local/api/lti/launch",
      resourceLinkId: "resource-bounded-audience",
    });

    const response = await postForm("/api/lti/launch", {
      state: "state-bounded-audience",
      id_token: idToken,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "LTI launch contains too many client hints",
    });
    expect(await countRows("lti_sessions")).toBe(0);
    expect(await countRows("lti_session_bindings")).toBe(0);
  });

  it("rejects routing hints that match more than one tenant registration", async () => {
    const issuer = "https://platform.harbor.test";
    const deploymentId = "deployment-ambiguous-audience";
    await createRegistration({
      registrationId: "ltireg_audience_a",
      tenantId: "tenant_audience_a",
      issuer,
      clientId: "audience-client-a",
      deploymentId,
    });
    await createRegistration({
      registrationId: "ltireg_audience_b",
      tenantId: "tenant_audience_b",
      issuer,
      clientId: "audience-client-b",
      deploymentId,
    });
    const idToken = await issueSignedIdToken({
      issuer,
      audience: ["audience-client-a", "audience-client-b"],
      subject: "student-ambiguous-audience",
      nonce: "nonce-ambiguous-audience",
      deploymentId,
      targetLinkUri: "https://harbor.local/api/lti/launch",
      resourceLinkId: "resource-ambiguous-audience",
    });

    const response = await postForm("/api/lti/launch", {
      state: "state-ambiguous-audience",
      id_token: idToken,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "LTI launch routing hints are ambiguous",
    });
    expect(await countRows("lti_sessions")).toBe(0);
    expect(await countRows("lti_session_bindings")).toBe(0);
  });
});
