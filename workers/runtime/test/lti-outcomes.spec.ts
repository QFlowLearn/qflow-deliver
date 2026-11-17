import { exports as workerExports } from "cloudflare:workers";
import {
  LTI_CLAIM_AGS_ENDPOINT,
  LTI_CLAIM_DEPLOYMENT_ID,
  LTI_CLAIM_TARGET_LINK_URI,
} from "@longsightgroup/lti-tool";
import { createMockLTIPayload, testSession } from "@longsightgroup/lti-tool/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncLtiNrpsMembersForAttempt } from "../src/lti/nrps-sync";
import { publishLtiOutcomeForAttemptResult } from "../src/lti/outcomes";
import {
  ADMIN_HEADERS,
  countRows,
  getTestEnv,
  resetLtiProtocolTables,
} from "./lti-test-environment";

async function seedLtiResult(input?: {
  totalScore?: number | null;
  maxScore?: number | null;
  agsLineitem?: string | null;
}): Promise<{
  attemptId: string;
  attemptResultId: string;
  resultFinalizationId: string;
}> {
  const { HARBOR_DB } = getTestEnv();
  const now = "2026-04-01T12:00:00.000Z";
  const attemptId = "attempt_lti_outcome";
  const attemptResultId = "ares_lti_outcome";
  const resultFinalizationId = "rfinal_lti_outcome";
  const ltiSessionId = "ltisess_outcome";
  const clientInternalId = "client_lti_outcome";
  const registrationId = "ltireg_lti_outcome";
  const learnerId = "learner_lti_outcome";
  const harborSessionId = "hsess_lti_outcome";
  const issuer = "https://platform.harbor.test";
  const clientId = "harbor-client";
  const deploymentId = "deployment-1";
  const futureExpiresAtMs = new Date("2030-04-02T12:00:00.000Z").getTime();
  const launchTarget = "https://harbor.local/api/lti/launch";
  const agsLineitem =
    input?.agsLineitem === undefined
      ? "https://platform.harbor.test/ags/lineitems/lineitem-1"
      : input.agsLineitem;
  const hasAgs = agsLineitem !== null;
  const agsScopes = [
    "https://purl.imsglobal.org/spec/lti-ags/scope/score",
    "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
    "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  ] as const;

  await HARBOR_DB.batch([
    HARBOR_DB.prepare(
      "INSERT INTO assessments (id, tenant_id, slug, title, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("asmt_lti_outcome", "tenant_local_demo", "lti-outcome", "LTI Outcome", now),
    HARBOR_DB.prepare(
      "INSERT INTO assessment_versions (id, assessment_id, version_number, source_package_sha256, package_object_key, manifest_object_key, delivery_policy_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "vers_lti_outcome",
      "asmt_lti_outcome",
      1,
      "sha",
      "packages/lti-outcome.zip",
      "manifests/lti-outcome.json",
      "{}",
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO assignments (id, assessment_id, assessment_version_id, title, status, policy_snapshot_json, created_by_role, created_by_id, created_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "assign_lti_outcome",
      "asmt_lti_outcome",
      "vers_lti_outcome",
      "LTI Outcome Assignment",
      "active",
      "{}",
      "system",
      "system",
      "System",
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_entries (id, assessment_version_id, launch_mode, actor_kind, actor_id, actor_display_name, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href, created_at, assignment_id, launch_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      attemptId,
      "vers_lti_outcome",
      "lti",
      "student-learner",
      learnerId,
      "Taylor LTI",
      "{}",
      "manifests/lti-outcome.json",
      "item-1",
      "items/item-1.xml",
      now,
      null,
      "{}",
    ),
    HARBOR_DB.prepare(
      "INSERT INTO result_finalizations (id, attempt_id, assessment_version_id, assignment_id, source_receipt_id, source_sequence_number, status, materialized_from, submitted_at, finalized_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      resultFinalizationId,
      attemptId,
      "vers_lti_outcome",
      null,
      "receipt_lti_outcome",
      1,
      "complete",
      "authoritative-qti-snapshot",
      now,
      now,
      null,
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_results (id, attempt_id, result_finalization_id, assessment_version_id, assignment_id, source_receipt_id, status, summary_source, total_score, max_score, passed, test_outcome_variables_json, submitted_at, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      attemptResultId,
      attemptId,
      resultFinalizationId,
      "vers_lti_outcome",
      null,
      "receipt_lti_outcome",
      "complete",
      "authoritative-qti-snapshot",
      input?.totalScore ?? 8,
      input?.maxScore ?? 10,
      null,
      "[]",
      now,
      now,
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO harbor_learners (id, tenant_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(learnerId, "tenant_local_demo", "Taylor LTI", "taylor@example.edu", now, now),
    HARBOR_DB.prepare(
      "INSERT INTO harbor_sessions (id, learner_id, provider_kind, issuer, subject, status, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      harborSessionId,
      learnerId,
      "lti",
      issuer,
      "student-lti",
      "active",
      now,
      futureExpiresAtMs,
      now,
      null,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO sections (id, tenant_id, source_kind, source_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("section_lti_outcome", "tenant_local_demo", "lti", "context-1", "Biology 101", now, now),
    HARBOR_DB.prepare(
      "INSERT INTO lti_registrations (id, tenant_id, issuer, client_id, deployment_id, authorization_endpoint, token_endpoint, jwks_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      registrationId,
      "tenant_local_demo",
      issuer,
      clientId,
      deploymentId,
      "https://platform.harbor.test/authorize",
      "https://platform.harbor.test/token",
      "https://platform.harbor.test/jwks",
      now,
      now,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO lti_clients (id, tenant_id, platform_name, iss, client_id, auth_url, token_url, jwks_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      clientInternalId,
      "tenant_local_demo",
      issuer,
      issuer,
      clientId,
      "https://platform.harbor.test/authorize",
      "https://platform.harbor.test/token",
      "https://platform.harbor.test/jwks",
    ),
    HARBOR_DB.prepare(
      "INSERT INTO lti_deployments (id, tenant_id, client_id, deployment_id, deployment_name, deployment_description) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("deployment_internal", "tenant_local_demo", clientInternalId, deploymentId, null, null),
    HARBOR_DB.prepare(
      "INSERT INTO lti_resource_links (id, registration_id, assignment_id, resource_link_id, context_id, section_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "ltilink_lti_outcome",
      registrationId,
      "assign_lti_outcome",
      "resource-1",
      "context-1",
      "section_lti_outcome",
      now,
      now,
    ),
  ]);

  const ltiSessionPayload = testSession({
    id: ltiSessionId,
    jwtPayload: createMockLTIPayload({
      iss: issuer,
      aud: clientId,
      sub: "student-lti",
      given_name: "Taylor",
      family_name: "LTI",
      name: "Taylor LTI",
      email: "taylor@example.edu",
      [LTI_CLAIM_DEPLOYMENT_ID]: deploymentId,
      [LTI_CLAIM_TARGET_LINK_URI]: launchTarget,
      ...(hasAgs
        ? {
            [LTI_CLAIM_AGS_ENDPOINT]: {
              lineitem: agsLineitem,
              lineitems: "https://platform.harbor.test/ags/lineitems",
              scope: [...agsScopes],
            },
          }
        : {}),
    }),
    user: {
      id: "student-lti",
      name: "Taylor LTI",
      email: "taylor@example.edu",
      roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    },
    context: {
      id: "context-1",
      label: "BIO 101",
      title: "Biology 101",
    },
    platform: {
      issuer,
      clientId,
      deploymentId,
      name: issuer,
    },
    launch: {
      target: launchTarget,
    },
    resourceLink: {
      id: "resource-1",
    },
    services: hasAgs
      ? {
          ags: {
            lineitem: agsLineitem,
            lineitems: "https://platform.harbor.test/ags/lineitems",
            scopes: [...agsScopes],
          },
          nrps: {
            membershipUrl: "https://platform.harbor.test/nrps/memberships",
            versions: ["2.0"],
          },
        }
      : undefined,
    isAssignmentAndGradesAvailable: hasAgs,
    isNameAndRolesAvailable: hasAgs,
    isStudent: true,
  });

  await HARBOR_DB.prepare(
    "INSERT INTO lti_sessions (id, tenant_id, payload, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(ltiSessionId, "tenant_local_demo", JSON.stringify(ltiSessionPayload), futureExpiresAtMs)
    .run();

  await HARBOR_DB.prepare(
    "INSERT INTO lti_session_bindings (lti_session_id, registration_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(ltiSessionId, registrationId, "tenant_local_demo", now, now)
    .run();

  await HARBOR_DB.prepare(
    "INSERT INTO lti_attempt_launches (attempt_id, registration_id, lti_session_id, harbor_session_id, learner_id, resource_link_id, context_id, ags_lineitem_url, ags_lineitems_url, ags_scopes_json, nrps_membership_url, nrps_versions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      attemptId,
      registrationId,
      ltiSessionId,
      harborSessionId,
      learnerId,
      "resource-1",
      "context-1",
      input?.agsLineitem === null ? null : agsLineitem,
      "https://platform.harbor.test/ags/lineitems",
      JSON.stringify([...agsScopes]),
      hasAgs ? "https://platform.harbor.test/nrps/memberships" : null,
      hasAgs ? JSON.stringify(["2.0"]) : "[]",
      now,
      now,
    )
    .run();

  return { attemptId, attemptResultId, resultFinalizationId };
}

beforeEach(async () => {
  await resetLtiProtocolTables();
});

describe("lti outcome delivery", () => {
  it("skips grade passback for a sequenced assessment before contacting the LMS", async () => {
    const ids = await seedLtiResult();
    const runtime = getTestEnv();
    await runtime.HARBOR_DB.prepare(
      "UPDATE attempt_results SET test_outcome_variables_json = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify([{ identifier: "HARBOR_SEQUENCE_TARGET", value: 100 }]),
        ids.attemptResultId,
      )
      .run();
    await publishLtiOutcomeForAttemptResult({ ...ids, db: runtime.HARBOR_DB, env: runtime });
    const row = await runtime.HARBOR_DB.prepare(
      "SELECT status, error_message FROM lti_outcome_deliveries WHERE attempt_result_id = ?",
    )
      .bind(ids.attemptResultId)
      .first();
    expect(row).toEqual({
      status: "skipped",
      error_message: "Grade passback is not supported for adaptive assessments.",
    });
  });
  it("submits finalized scores through lti-tool AGS and records delivery", async () => {
    const seeded = await seedLtiResult();
    const serviceCalls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        serviceCalls.push({ url, body: init?.body ?? null });
        if (url === "https://platform.harbor.test/token") {
          return Response.json({
            access_token: "mock-token",
            token_type: "Bearer",
            expires_in: 300,
          });
        }

        if (url === "https://platform.harbor.test/ags/lineitems/lineitem-1/scores") {
          return new Response(null, { status: 201 });
        }

        return new Response("not found", { status: 404 });
      }),
    );

    await publishLtiOutcomeForAttemptResult({
      db: getTestEnv().HARBOR_DB,
      env: getTestEnv(),
      ...seeded,
    });

    expect(serviceCalls.map((call) => call.url)).toEqual([
      "https://platform.harbor.test/token",
      "https://platform.harbor.test/ags/lineitems/lineitem-1/scores",
    ]);
    const scorePayload = JSON.parse(String(serviceCalls[1].body)) as {
      userId: string;
      scoreGiven: number;
      scoreMaximum: number;
      activityProgress: string;
      gradingProgress: string;
    };
    expect(scorePayload).toEqual(
      expect.objectContaining({
        userId: "student-lti",
        scoreGiven: 8,
        scoreMaximum: 10,
        activityProgress: "Completed",
        gradingProgress: "FullyGraded",
      }),
    );

    const delivery = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status, score_given, score_maximum, delivered_at, error_message FROM lti_outcome_deliveries WHERE result_finalization_id = ?",
      )
      .bind(seeded.resultFinalizationId)
      .first<{
        status: string;
        score_given: number | null;
        score_maximum: number | null;
        delivered_at: string | null;
        error_message: string | null;
      }>();

    expect(delivery?.status).toBe("complete");
    expect(delivery?.score_given).toBe(8);
    expect(delivery?.score_maximum).toBe(10);
    expect(delivery?.delivered_at).toBeTruthy();
    expect(delivery?.error_message).toBeNull();
  });

  it("records safe structured AGS score failures and retries idempotently", async () => {
    const seeded = await seedLtiResult();
    let scorePublishAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://platform.harbor.test/token") {
          return Response.json({
            access_token: "mock-token",
            token_type: "Bearer",
            expires_in: 300,
          });
        }

        if (url === "https://platform.harbor.test/ags/lineitems/lineitem-1/scores") {
          scorePublishAttempts += 1;
          if (scorePublishAttempts > 1) {
            return new Response(null, { status: 201 });
          }
          return Response.json(
            {
              error: "gradebook unavailable",
            },
            {
              status: 503,
              statusText: "Service Unavailable",
            },
          );
        }

        return new Response("not found", { status: 404 });
      }),
    );

    await publishLtiOutcomeForAttemptResult({
      db: getTestEnv().HARBOR_DB,
      env: getTestEnv(),
      ...seeded,
    });

    const delivery = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status, delivered_at, error_message FROM lti_outcome_deliveries WHERE result_finalization_id = ?",
      )
      .bind(seeded.resultFinalizationId)
      .first<{ status: string; delivered_at: string | null; error_message: string | null }>();

    expect(delivery?.status).toBe("failed");
    expect(delivery?.delivered_at).toBeNull();
    expect(delivery?.error_message).toContain("AGS score submission failed: 503");
    expect(delivery?.error_message).toContain("gradebook unavailable");

    await publishLtiOutcomeForAttemptResult({
      db: getTestEnv().HARBOR_DB,
      env: getTestEnv(),
      ...seeded,
    });

    const retriedDelivery = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status, delivered_at, error_message FROM lti_outcome_deliveries WHERE result_finalization_id = ?",
      )
      .bind(seeded.resultFinalizationId)
      .first<{ status: string; delivered_at: string | null; error_message: string | null }>();
    expect(scorePublishAttempts).toBe(2);
    expect(await countRows("lti_outcome_deliveries")).toBe(1);
    expect(retriedDelivery?.status).toBe("complete");
    expect(retriedDelivery?.delivered_at).toBeTruthy();
    expect(retriedDelivery?.error_message).toBeNull();
  });

  it("records skipped delivery when an LTI launch has no AGS lineitem", async () => {
    const seeded = await seedLtiResult({ agsLineitem: null });

    await publishLtiOutcomeForAttemptResult({
      db: getTestEnv().HARBOR_DB,
      env: getTestEnv(),
      ...seeded,
    });

    const delivery = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status, error_message FROM lti_outcome_deliveries WHERE result_finalization_id = ?",
      )
      .bind(seeded.resultFinalizationId)
      .first<{ status: string; error_message: string | null }>();

    expect(delivery?.status).toBe("skipped");
    expect(delivery?.error_message).toContain("AGS lineitem");
  });

  it("requires admin auth for internal LTI service proxy routes", async () => {
    await seedLtiResult();

    const response = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/lti/attempts/attempt_lti_outcome/ags/lineitems"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid QFlowLearn Delivery admin key",
    });
  });

  it("proxies AGS line items and NRPS members through lti-tool", async () => {
    await seedLtiResult();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://platform.harbor.test/token") {
          return Response.json({
            access_token: "mock-token",
            token_type: "Bearer",
            expires_in: 300,
          });
        }

        if (url === "https://platform.harbor.test/ags/lineitems") {
          return Response.json([
            {
              id: "https://platform.harbor.test/ags/lineitems/lineitem-1",
              label: "Harbor Quiz",
              scoreMaximum: 10,
              resourceLinkId: "resource-1",
            },
          ]);
        }

        if (url === "https://platform.harbor.test/nrps/memberships") {
          return Response.json({
            id: "https://platform.harbor.test/nrps/memberships",
            context: {
              id: "context-1",
            },
            members: [
              {
                status: "Active",
                name: "Taylor LTI",
                email: "taylor@example.edu",
                user_id: "student-lti",
                roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
              },
            ],
          });
        }

        return new Response("not found", { status: 404 });
      }),
    );

    const lineItemsResponse = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/lti/attempts/attempt_lti_outcome/ags/lineitems", {
        headers: ADMIN_HEADERS,
      }),
    );
    expect(lineItemsResponse.status).toBe(200);
    await expect(lineItemsResponse.json()).resolves.toEqual({
      lineItems: [
        expect.objectContaining({
          id: "https://platform.harbor.test/ags/lineitems/lineitem-1",
          label: "Harbor Quiz",
          scoreMaximum: 10,
        }),
      ],
    });

    const membersResponse = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/lti/attempts/attempt_lti_outcome/nrps/members", {
        headers: ADMIN_HEADERS,
      }),
    );
    expect(membersResponse.status).toBe(200);
    await expect(membersResponse.json()).resolves.toEqual({
      members: [
        expect.objectContaining({
          name: "Taylor LTI",
          email: "taylor@example.edu",
          userId: "student-lti",
        }),
      ],
    });
  });

  it("returns safe structured NRPS proxy failures", async () => {
    await seedLtiResult();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://platform.harbor.test/token") {
          return Response.json({
            access_token: "mock-token",
            token_type: "Bearer",
            expires_in: 300,
          });
        }

        if (url === "https://platform.harbor.test/nrps/memberships") {
          return Response.json(
            {
              error: "membership unavailable",
            },
            {
              status: 503,
              statusText: "Service Unavailable",
            },
          );
        }

        return new Response("not found", { status: 404 });
      }),
    );

    const response = await workerExports.default.fetch(
      new Request("https://harbor.local/internal/lti/attempts/attempt_lti_outcome/nrps/members", {
        headers: ADMIN_HEADERS,
      }),
    );

    expect(response.status).toBe(502);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toContain("NRPS get members failed: 503");
    expect(payload.error).toContain("membership unavailable");
  });

  it("persists safe structured NRPS sync failures and permits a later retry", async () => {
    const seeded = await seedLtiResult();
    let serviceUnavailable = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === "https://platform.harbor.test/token") {
          return Response.json({
            access_token: "mock-token",
            token_type: "Bearer",
            expires_in: 300,
          });
        }

        if (url === "https://platform.harbor.test/nrps/memberships") {
          if (!serviceUnavailable) {
            return Response.json({
              id: "https://platform.harbor.test/nrps/memberships",
              context: {
                id: "context-outcome",
                label: "BIO 101",
                title: "Biology 101",
              },
              members: [],
            });
          }
          return Response.json(
            {
              error: "membership unavailable",
            },
            {
              status: 503,
              statusText: "Service Unavailable",
            },
          );
        }

        return new Response("not found", { status: 404 });
      }),
    );

    await expect(
      syncLtiNrpsMembersForAttempt({
        env: getTestEnv() as unknown as Parameters<typeof syncLtiNrpsMembersForAttempt>[0]["env"],
        attemptId: seeded.attemptId,
      }),
    ).rejects.toThrow("NRPS get members failed: 503");

    const run = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT status, total_members, error_message FROM lti_nrps_sync_runs WHERE attempt_id = ?",
      )
      .bind(seeded.attemptId)
      .first<{ status: string; total_members: number; error_message: string | null }>();

    expect(run?.status).toBe("failed");
    expect(run?.total_members).toBe(0);
    expect(run?.error_message).toContain("NRPS get members failed: 503");
    expect(run?.error_message).toContain("membership unavailable");

    serviceUnavailable = false;
    await expect(
      syncLtiNrpsMembersForAttempt({
        env: getTestEnv() as unknown as Parameters<typeof syncLtiNrpsMembersForAttempt>[0]["env"],
        attemptId: seeded.attemptId,
      }),
    ).resolves.toMatchObject({ status: "complete", totalMembers: 0 });

    const runs = await getTestEnv()
      .HARBOR_DB.prepare("SELECT status FROM lti_nrps_sync_runs WHERE attempt_id = ?")
      .bind(seeded.attemptId)
      .all<{ status: string }>();
    expect(runs.results).toHaveLength(2);
    expect(runs.results).toEqual(
      expect.arrayContaining([{ status: "failed" }, { status: "complete" }]),
    );
  });
});
