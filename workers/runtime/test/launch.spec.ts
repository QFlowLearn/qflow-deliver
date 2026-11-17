import JSZip from "jszip";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { DEFAULT_DELIVERY_POLICY_SNAPSHOT, type DeliveryManifest } from "@harbor/content-model";
import {
  BOOTSTRAP_EXCHANGE_PATH,
  BOOTSTRAP_TOKEN_AUDIENCE,
  BOOTSTRAP_TOKEN_ISSUER,
  type AttemptEventEnvelope,
  type BootstrapClaims,
  type BootstrapEnvelope,
  type BootstrapPayload,
  type CommitAttemptEventReceipt,
  type LaunchRequest,
} from "@harbor/attempt-protocol";
import { issueBootstrapToken } from "../src/launch/sign-bootstrap";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const TEST_BOOTSTRAP_SECRET = "harbor-bootstrap-test-secret";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "attempt_entries",
    "access_codes",
    "delivery_artifacts",
    "assessment_versions",
    "assessments",
  ];

  const tables = await HARBOR_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${knownTables
      .map(() => "?")
      .join(", ")})`,
  )
    .bind(...knownTables)
    .all<{ name: string }>();

  const deleteStatements = knownTables
    .filter((tableName) => tables.results.some((table) => table.name === tableName))
    .map((tableName) => `DELETE FROM ${tableName}`);

  if (deleteStatements.length > 0) {
    await HARBOR_DB.exec(`${deleteStatements.join("; ")};`);
  }

  let cursor: string | undefined;
  do {
    const listed = await CONTENT_BUCKET.list({ cursor });
    await Promise.all(listed.objects.map((object) => CONTENT_BUCKET.delete(object.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function createFixturePackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifestXml);
  zip.file("items/item-1.xml", itemXml);
  zip.file("assets/stimulus.svg", stimulusSvg);
  return zip.generateAsync({ type: "uint8array" });
}

async function publishFixture(input: { tenantId: string; assessmentSlug: string }): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
  manifestObjectKey: string;
}> {
  const request = new Request(
    `https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    },
  );

  const response = await workerExports.default.fetch(request);
  expect(response.status).toBe(201);
  return response.json();
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function exchangeBootstrap(bootstrapToken: string): Promise<Response> {
  return postJson("/api/bootstrap", { bootstrapToken });
}

async function commitAttemptEvent(
  attemptId: string,
  event: AttemptEventEnvelope,
): Promise<Response> {
  return postJson(`/api/attempts/${attemptId}/events`, event);
}

async function readAttemptEntry(attemptId: string): Promise<{
  id: string;
  assessment_version_id: string;
  launch_mode: "preview" | "access-code";
  actor_kind: "preview-operator" | "access-code-candidate";
  actor_id: string | null;
  actor_display_name: string | null;
  delivery_policy_snapshot: string;
  manifest_object_key: string;
  current_item_id: string;
  current_item_href: string;
}> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT id, assessment_version_id, launch_mode, actor_kind, actor_id, actor_display_name, delivery_policy_snapshot, manifest_object_key, current_item_id, current_item_href FROM attempt_entries WHERE id = ?",
  )
    .bind(attemptId)
    .first<{
      id: string;
      assessment_version_id: string;
      launch_mode: "preview" | "access-code";
      actor_kind: "preview-operator" | "access-code-candidate";
      actor_id: string | null;
      actor_display_name: string | null;
      delivery_policy_snapshot: string;
      manifest_object_key: string;
      current_item_id: string;
      current_item_href: string;
    }>();

  expect(attempt).toBeTruthy();
  return attempt!;
}

async function appendReviewItemToManifest(manifestObjectKey: string): Promise<{
  itemId: string;
  itemHref: string;
}> {
  const { CONTENT_BUCKET } = getTestEnv();
  const manifestObject = await CONTENT_BUCKET.get(manifestObjectKey);
  expect(manifestObject).toBeTruthy();
  const manifest = await manifestObject!.json<DeliveryManifest>();
  const reviewObjectKey = manifestObjectKey.replace(
    "/manifests/delivery.json",
    "/items/item-review.xml",
  );
  const reviewItemRef = {
    itemId: "item-review",
    itemHref: "items/item-review.xml",
  };

  const nextManifest: DeliveryManifest = {
    ...manifest,
    itemOrder: [...manifest.itemOrder, reviewItemRef.itemId],
    items: {
      ...manifest.items,
      [reviewItemRef.itemId]: {
        id: reviewItemRef.itemId,
        identifier: "review-item",
        title: "Review Item",
        href: "items/item-review.xml",
        deliveryObjectKey: reviewObjectKey.replace("/items/", "/delivery/items/"),
        objectKey: reviewObjectKey,
        assetIds: [],
      },
    },
  };

  await CONTENT_BUCKET.put(manifestObjectKey, JSON.stringify(nextManifest), {
    httpMetadata: {
      contentType: "application/json",
    },
  });

  return reviewItemRef;
}

async function createAssignment(input: {
  assessmentId: string;
  assessmentVersionId: string;
  assignmentId: string;
  maxAttempts: number;
}): Promise<Response> {
  return postJson("/internal/assignments", {
    assignmentId: input.assignmentId,
    assessmentId: input.assessmentId,
    assessmentVersionId: input.assessmentVersionId,
    title: "Assignment Launch",
    actor: {
      role: "instructor",
      actorId: "inst_launch_01",
      displayName: "Launch Instructor",
    },
    policySnapshot: {
      availableFrom: "2026-03-27T00:00:00.000Z",
      availableUntil: "2027-03-29T00:00:00.000Z",
      reportingTimezone: "America/New_York",
      maxAttempts: input.maxAttempts,
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
  });
}

async function issueAssignmentAccessCode(input: { assignmentId: string; code: string }): Promise<{
  accessCodeId: string;
  accessCode: string;
  assessmentVersionId: string;
  assignmentId: string | null;
}> {
  const response = await postJson("/internal/access-codes", {
    assignmentId: input.assignmentId,
    code: input.code,
  });

  expect(response.status).toBe(201);
  return response.json();
}

async function readAttemptAssignmentSnapshot(attemptId: string): Promise<{
  assessment_version_id: string;
  assignment_id: string | null;
  assignment_policy_snapshot: string | null;
  delivery_policy_snapshot: string;
}> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT assessment_version_id, assignment_id, assignment_policy_snapshot, delivery_policy_snapshot FROM attempt_entries WHERE id = ?",
  )
    .bind(attemptId)
    .first<{
      assessment_version_id: string;
      assignment_id: string | null;
      assignment_policy_snapshot: string | null;
      delivery_policy_snapshot: string;
    }>();

  expect(attempt).toBeTruthy();
  return attempt!;
}

function buildClaimsFromAttempt(input: {
  attempt: Awaited<ReturnType<typeof readAttemptEntry>>;
  assessmentVersionId?: string;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
}): Omit<BootstrapClaims, "deliveryPolicyFingerprint"> {
  return {
    iss: BOOTSTRAP_TOKEN_ISSUER,
    aud: BOOTSTRAP_TOKEN_AUDIENCE,
    sub: `attempt:${input.attempt.id}`,
    jti: input.tokenId,
    iat: input.issuedAt,
    exp: input.expiresAt,
    attemptId: input.attempt.id,
    assessmentVersionId: input.assessmentVersionId ?? input.attempt.assessment_version_id,
    deliveryPolicy: JSON.parse(input.attempt.delivery_policy_snapshot),
    manifest: {
      manifestObjectKey: input.attempt.manifest_object_key,
    },
    currentItemRef: {
      itemId: input.attempt.current_item_id,
      itemHref: input.attempt.current_item_href,
    },
    launch: {
      mode: input.attempt.launch_mode,
      actor: {
        kind: input.attempt.actor_kind,
        id: input.attempt.actor_id,
        displayName: input.attempt.actor_display_name,
      },
    },
  };
}

beforeEach(async () => {
  await resetBindings();
});

describe("launch and bootstrap contracts", () => {
  it("uses the same bootstrap envelope shape for preview and access-code launches", () => {
    const previewRequest: LaunchRequest = {
      mode: "preview",
      assessmentVersionId: "vers_preview_01",
      actor: {
        kind: "preview-operator",
        id: "user_preview_01",
        displayName: "Instructor Preview",
      },
    };

    const accessCodeRequest: LaunchRequest = {
      mode: "access-code",
      accessCode: "MATH-1234",
      actor: {
        kind: "access-code-candidate",
        id: "candidate_01",
        displayName: "Student Candidate",
      },
    };

    const previewEnvelope: BootstrapEnvelope = {
      bootstrapToken: "bootstrap.preview.token",
      exchangeUrl: BOOTSTRAP_EXCHANGE_PATH,
      expiresAt: "2026-03-25T00:15:00.000Z",
      launch: {
        mode: previewRequest.mode,
        actor: previewRequest.actor,
      },
    };

    const accessCodeEnvelope: BootstrapEnvelope = {
      bootstrapToken: "bootstrap.access-code.token",
      exchangeUrl: BOOTSTRAP_EXCHANGE_PATH,
      expiresAt: "2026-03-25T00:15:00.000Z",
      launch: {
        mode: accessCodeRequest.mode,
        actor: accessCodeRequest.actor,
      },
    };

    expect(Object.keys(previewEnvelope).sort()).toEqual(Object.keys(accessCodeEnvelope).sort());
    expect(previewEnvelope.exchangeUrl).toBe("/api/bootstrap");
    expect(accessCodeEnvelope.exchangeUrl).toBe("/api/bootstrap");
    expect(previewEnvelope.launch.mode).toBe("preview");
    expect(accessCodeEnvelope.launch.mode).toBe("access-code");
    expect(previewEnvelope.launch.actor.kind).toBe("preview-operator");
    expect(accessCodeEnvelope.launch.actor.kind).toBe("access-code-candidate");
  });

  it("defines signed bootstrap claims for one pinned attempt entry", () => {
    const claims: BootstrapClaims = {
      deliveryPolicyFingerprint: "0".repeat(64),
      iss: "harbor-runtime",
      aud: "harbor-shell",
      sub: "attempt:attempt_01",
      jti: "btok_01",
      iat: 1_774_480_000,
      exp: 1_774_480_300,
      attemptId: "attempt_01",
      assessmentVersionId: "vers_01",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: null,
      },
      manifest: {
        manifestObjectKey:
          "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/manifests/delivery.json",
      },
      currentItemRef: {
        itemId: "item-1",
        itemHref: "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/items/item-1.xml",
      },
      launch: {
        mode: "preview",
        actor: {
          kind: "preview-operator",
          id: "user_preview_01",
          displayName: "Instructor Preview",
        },
      },
    };

    expect(claims.attemptId).toBe("attempt_01");
    expect(claims.assessmentVersionId).toBe("vers_01");
    expect(claims.deliveryPolicy.navigationMode).toBe("linear");
    expect(claims.currentItemRef.itemId).toBe("item-1");
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.jti).toBe("btok_01");
  });

  it("keeps stable top-level bootstrap keys while reserving space for later sequence and timing state", () => {
    const payload: BootstrapPayload = {
      attemptId: "attempt_01",
      assessmentVersionId: "vers_01",
      deliveryPolicy: {
        launchMode: "access-code",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 1800,
      },
      manifest: {
        manifestObjectKey:
          "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/manifests/delivery.json",
      },
      launch: {
        mode: "access-code",
        actor: {
          kind: "access-code-candidate",
          id: "candidate_01",
          displayName: "Student Candidate",
        },
      },
      session: {
        currentItemRef: {
          itemId: "item-1",
          itemHref: "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/items/item-1.xml",
        },
        sequence: null,
        timing: null,
      },
    };

    expect(Object.keys(payload).sort()).toEqual([
      "assessmentVersionId",
      "attemptId",
      "deliveryPolicy",
      "launch",
      "manifest",
      "session",
    ]);
    expect(Object.keys(payload.session).sort()).toEqual(["currentItemRef", "sequence", "timing"]);
    expectTypeOf(payload.session.sequence).toEqualTypeOf<BootstrapPayload["session"]["sequence"]>();
    expectTypeOf(payload.session.timing).toEqualTypeOf<BootstrapPayload["session"]["timing"]>();
  });
});

describe("launch routes", () => {
  it("provisions one access code against a published version for test and browser entry flows", async () => {
    const published = await publishFixture({
      tenantId: "tenant_launch",
      assessmentSlug: "basic-assessment",
    });

    const response = await postJson("/internal/access-codes", {
      assessmentVersionId: published.assessmentVersionId,
      code: "ALG-9000",
      expiresAt: "2030-03-26T00:30:00.000Z",
    });

    expect(response.status).toBe(201);

    const payload = await response.json<{
      accessCodeId: string;
      accessCode: string;
      assessmentVersionId: string;
      expiresAt: string | null;
    }>();

    expect(payload.accessCode).toBe("ALG-9000");
    expect(payload.assessmentVersionId).toBe(published.assessmentVersionId);
    expect(payload.expiresAt).toBe("2030-03-26T00:30:00.000Z");

    const { HARBOR_DB } = getTestEnv();
    const stored = await HARBOR_DB.prepare(
      "SELECT id, assessment_version_id, code_sha256, code_last4, expires_at FROM access_codes WHERE id = ?",
    )
      .bind(payload.accessCodeId)
      .first<{
        id: string;
        assessment_version_id: string;
        code_sha256: string;
        code_last4: string;
        expires_at: string | null;
      }>();

    expect(stored?.assessment_version_id).toBe(published.assessmentVersionId);
    expect(stored?.code_last4).toBe("9000");
    expect(stored?.code_sha256).not.toBe("ALG-9000");
    expect(stored?.expires_at).toBe("2030-03-26T00:30:00.000Z");
  });

  it("creates a preview attempt pinned to one published version and copied delivery policy", async () => {
    const published = await publishFixture({
      tenantId: "tenant_preview",
      assessmentSlug: "basic-assessment",
    });

    const response = await postJson("/api/launch/preview", {
      mode: "preview",
      assessmentVersionId: published.assessmentVersionId,
      actor: {
        kind: "preview-operator",
        id: "preview_user_01",
        displayName: "Instructor Preview",
      },
    });

    expect(response.status).toBe(201);
    const envelope = await response.json<BootstrapEnvelope>();
    expect(envelope.launch.mode).toBe("preview");
    expect(envelope.exchangeUrl).toBe("/api/bootstrap");
    expect(envelope.bootstrapToken.length).toBeGreaterThan(0);

    const { HARBOR_DB } = getTestEnv();
    const attempts = await HARBOR_DB.prepare(
      "SELECT id, assessment_version_id, launch_mode, delivery_policy_snapshot, current_item_id, current_item_href, manifest_object_key FROM attempt_entries",
    ).all<{
      id: string;
      assessment_version_id: string;
      launch_mode: string;
      delivery_policy_snapshot: string;
      current_item_id: string;
      current_item_href: string;
      manifest_object_key: string;
    }>();

    expect(attempts.results).toHaveLength(1);
    expect(attempts.results[0]?.assessment_version_id).toBe(published.assessmentVersionId);
    expect(attempts.results[0]?.launch_mode).toBe("preview");
    expect(JSON.parse(attempts.results[0]?.delivery_policy_snapshot ?? "")).toEqual(
      DEFAULT_DELIVERY_POLICY_SNAPSHOT,
    );
    expect(attempts.results[0]?.current_item_id).toBe("item-1");
    expect(attempts.results[0]?.manifest_object_key).toBe(published.manifestObjectKey);
  });

  it("creates access-code attempts only for valid version-matching codes and leaves no orphaned attempts on failures", async () => {
    const firstPublish = await publishFixture({
      tenantId: "tenant_access",
      assessmentSlug: "basic-assessment",
    });
    const secondPublish = await publishFixture({
      tenantId: "tenant_access",
      assessmentSlug: "basic-assessment",
    });

    const issued = await postJson("/internal/access-codes", {
      assessmentVersionId: firstPublish.assessmentVersionId,
      code: "SCI-2048",
      expiresAt: "2030-03-26T02:00:00.000Z",
    });
    expect(issued.status).toBe(201);

    const validLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "SCI-2048",
      assessmentVersionId: firstPublish.assessmentVersionId,
      actor: {
        kind: "access-code-candidate",
        id: "candidate_01",
        displayName: "Student Candidate",
      },
    });

    expect(validLaunch.status).toBe(201);
    const validEnvelope = await validLaunch.json<BootstrapEnvelope>();
    expect(validEnvelope.launch.mode).toBe("access-code");

    const invalidLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "NOPE-9999",
      actor: {
        kind: "access-code-candidate",
        id: "candidate_invalid",
        displayName: "Invalid Candidate",
      },
    });
    expect(invalidLaunch.status).toBe(404);

    await postJson("/internal/access-codes", {
      assessmentVersionId: firstPublish.assessmentVersionId,
      code: "SCI-EXPIRED",
      expiresAt: "2026-03-24T23:59:59.000Z",
    });

    const expiredLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "SCI-EXPIRED",
      actor: {
        kind: "access-code-candidate",
        id: "candidate_expired",
        displayName: "Expired Candidate",
      },
    });
    expect(expiredLaunch.status).toBe(403);

    const mismatchedLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "SCI-2048",
      assessmentVersionId: secondPublish.assessmentVersionId,
      actor: {
        kind: "access-code-candidate",
        id: "candidate_mismatch",
        displayName: "Mismatched Candidate",
      },
    });
    expect(mismatchedLaunch.status).toBe(403);

    const { HARBOR_DB } = getTestEnv();
    const attempts = await HARBOR_DB.prepare(
      "SELECT id, assessment_version_id, launch_mode FROM attempt_entries ORDER BY created_at ASC",
    ).all<{
      id: string;
      assessment_version_id: string;
      launch_mode: string;
    }>();

    expect(attempts.results).toHaveLength(1);
    expect(attempts.results[0]?.assessment_version_id).toBe(firstPublish.assessmentVersionId);
    expect(attempts.results[0]?.launch_mode).toBe("access-code");
  });

  it("rejects duplicate custom access codes with a client error instead of a worker crash", async () => {
    const published = await publishFixture({
      tenantId: "tenant_access_duplicate",
      assessmentSlug: "basic-assessment",
    });

    const firstResponse = await postJson("/internal/access-codes", {
      assessmentVersionId: published.assessmentVersionId,
      code: "REUSE-2026",
    });
    expect(firstResponse.status).toBe(201);

    const duplicateResponse = await postJson("/internal/access-codes", {
      assessmentVersionId: published.assessmentVersionId,
      code: "REUSE-2026",
    });

    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toEqual({
      error: "Access code already exists",
    });
  });

  it("issues assignment-scoped access codes and pins launched attempts to the assignment snapshot", async () => {
    const published = await publishFixture({
      tenantId: "tenant_assignment_launch",
      assessmentSlug: "basic-assessment",
    });
    const assignmentResponse = await createAssignment({
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_launch_01",
      maxAttempts: 2,
    });
    expect(assignmentResponse.status).toBe(201);

    const issued = await issueAssignmentAccessCode({
      assignmentId: "assign_launch_01",
      code: "ASSIGN-2048",
    });

    expect(issued).toMatchObject({
      accessCode: "ASSIGN-2048",
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_launch_01",
    });

    const launch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "ASSIGN-2048",
      actor: {
        kind: "access-code-candidate",
        id: "student_assignment_01",
        displayName: "Assignment Student",
      },
    });
    expect(launch.status).toBe(201);
    const envelope = await launch.json<BootstrapEnvelope>();
    const bootstrap = await postJson("/api/bootstrap", {
      bootstrapToken: envelope.bootstrapToken,
      clientSessionId: "assignment_launch_session",
    });
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<BootstrapPayload>();

    const attempt = await readAttemptAssignmentSnapshot(payload.attemptId);
    expect(attempt).toMatchObject({
      assessment_version_id: published.assessmentVersionId,
      assignment_id: "assign_launch_01",
    });
    expect(JSON.parse(attempt.assignment_policy_snapshot ?? "{}")).toMatchObject({
      maxAttempts: 2,
      navigationMode: "free",
      secureBrowserRequired: false,
    });
    expect(JSON.parse(attempt.delivery_policy_snapshot)).toMatchObject({
      launchMode: "access-code",
      navigationMode: "free",
      maxAttempts: 2,
    });
  });

  it("keeps assignment-linked launches pinned to the assignment version and enforces remaining attempts across retakes", async () => {
    const firstPublish = await publishFixture({
      tenantId: "tenant_assignment_retake",
      assessmentSlug: "retake-assessment",
    });
    const secondPublish = await publishFixture({
      tenantId: "tenant_assignment_retake",
      assessmentSlug: "retake-assessment",
    });
    const assignmentResponse = await createAssignment({
      assessmentId: firstPublish.assessmentId,
      assessmentVersionId: firstPublish.assessmentVersionId,
      assignmentId: "assign_retake_01",
      maxAttempts: 2,
    });
    expect(assignmentResponse.status).toBe(201);

    await issueAssignmentAccessCode({
      assignmentId: "assign_retake_01",
      code: "ASSIGN-RETAKE",
    });

    const firstLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "ASSIGN-RETAKE",
      actor: {
        kind: "access-code-candidate",
        id: "student_retake_01",
        displayName: "Retake Student",
      },
    });
    expect(firstLaunch.status).toBe(201);
    const firstEnvelope = await firstLaunch.json<BootstrapEnvelope>();
    const firstBootstrapResponse = await postJson("/api/bootstrap", {
      bootstrapToken: firstEnvelope.bootstrapToken,
      clientSessionId: "assignment_retake_session",
    });
    expect(firstBootstrapResponse.status).toBe(200);
    const firstBootstrap = await firstBootstrapResponse.json<BootstrapPayload>();

    const firstSubmit = await commitAttemptEvent(firstBootstrap.attemptId, {
      attemptId: firstBootstrap.attemptId,
      eventId: "evt_submit_assignment_01",
      idempotencyKey: "idem_submit_assignment_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-27T12:00:00.000Z",
      clientSessionId: "assignment_retake_session",
      itemRef: firstBootstrap.session.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: "2026-03-27T12:00:00.000Z",
      },
    });
    expect(firstSubmit.status).toBe(200);

    const activateResponse = await postJson(
      `/internal/assessments/${firstPublish.assessmentId}/activate-version`,
      {
        activationId: "act_assignment_retake",
        assessmentId: firstPublish.assessmentId,
        assessmentVersionId: secondPublish.assessmentVersionId,
        actor: {
          role: "instructor",
          actorId: "inst_launch_01",
          displayName: "Launch Instructor",
        },
        reason: "activate newer version",
        activatedAt: "2026-03-27T13:00:00.000Z",
      },
    );
    expect(activateResponse.status).toBe(200);

    const secondLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "ASSIGN-RETAKE",
      actor: {
        kind: "access-code-candidate",
        id: "student_retake_01",
        displayName: "Retake Student",
      },
    });
    expect(secondLaunch.status).toBe(201);
    const secondEnvelope = await secondLaunch.json<BootstrapEnvelope>();
    const secondBootstrapResponse = await postJson("/api/bootstrap", {
      bootstrapToken: secondEnvelope.bootstrapToken,
      clientSessionId: "assignment_retake_session",
    });
    expect(secondBootstrapResponse.status).toBe(200);
    const secondBootstrap = await secondBootstrapResponse.json<BootstrapPayload>();
    expect(secondBootstrap.attemptId).not.toBe(firstBootstrap.attemptId);

    const pinnedAttempt = await readAttemptAssignmentSnapshot(secondBootstrap.attemptId);
    expect(pinnedAttempt.assessment_version_id).toBe(firstPublish.assessmentVersionId);
    expect(pinnedAttempt.assignment_id).toBe("assign_retake_01");

    const secondSubmit = await commitAttemptEvent(secondBootstrap.attemptId, {
      attemptId: secondBootstrap.attemptId,
      eventId: "evt_submit_assignment_02",
      idempotencyKey: "idem_submit_assignment_02",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-27T14:00:00.000Z",
      clientSessionId: "assignment_retake_session",
      itemRef: secondBootstrap.session.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt: "2026-03-27T14:00:00.000Z",
      },
    });
    expect(secondSubmit.status).toBe(200);

    const thirdLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "ASSIGN-RETAKE",
      actor: {
        kind: "access-code-candidate",
        id: "student_retake_01",
        displayName: "Retake Student",
      },
    });
    expect(thirdLaunch.status).toBe(403);
    await expect(thirdLaunch.json()).resolves.toEqual({
      error: "No remaining attempts are available for this assignment",
    });
  });
});

describe("bootstrap exchange", () => {
  it("returns signed preview and access-code tokens that exchange for their pinned attempt contexts", async () => {
    const published = await publishFixture({
      tenantId: "tenant_bootstrap",
      assessmentSlug: "basic-assessment",
    });

    const previewLaunch = await postJson("/api/launch/preview", {
      mode: "preview",
      assessmentVersionId: published.assessmentVersionId,
      actor: {
        kind: "preview-operator",
        id: "preview_user_01",
        displayName: "Instructor Preview",
      },
    });
    expect(previewLaunch.status).toBe(201);
    const previewEnvelope = await previewLaunch.json<BootstrapEnvelope>();

    const issued = await postJson("/internal/access-codes", {
      assessmentVersionId: published.assessmentVersionId,
      code: "BOOT-2026",
    });
    expect(issued.status).toBe(201);

    const accessCodeLaunch = await postJson("/api/launch/access-code", {
      mode: "access-code",
      accessCode: "BOOT-2026",
      actor: {
        kind: "access-code-candidate",
        id: "candidate_01",
        displayName: "Student Candidate",
      },
    });
    expect(accessCodeLaunch.status).toBe(201);
    const accessCodeEnvelope = await accessCodeLaunch.json<BootstrapEnvelope>();

    const previewBootstrap = await exchangeBootstrap(previewEnvelope.bootstrapToken);
    const accessCodeBootstrap = await exchangeBootstrap(accessCodeEnvelope.bootstrapToken);

    expect(previewBootstrap.status).toBe(200);
    expect(accessCodeBootstrap.status).toBe(200);

    const previewPayload = await previewBootstrap.json<BootstrapPayload>();
    const accessCodePayload = await accessCodeBootstrap.json<BootstrapPayload>();

    expect(previewPayload.launch.mode).toBe("preview");
    expect(accessCodePayload.launch.mode).toBe("access-code");
    expect(previewPayload.assessmentVersionId).toBe(published.assessmentVersionId);
    expect(accessCodePayload.assessmentVersionId).toBe(published.assessmentVersionId);
    expect(previewPayload.attemptId).not.toBe(accessCodePayload.attemptId);
  });

  it("returns the typed pinned bootstrap payload the harbor shell needs", async () => {
    const published = await publishFixture({
      tenantId: "tenant_bootstrap_payload",
      assessmentSlug: "basic-assessment",
    });

    const launch = await postJson("/api/launch/preview", {
      mode: "preview",
      assessmentVersionId: published.assessmentVersionId,
      actor: {
        kind: "preview-operator",
        id: "preview_payload_01",
        displayName: "Preview Payload",
      },
    });
    expect(launch.status).toBe(201);
    const envelope = await launch.json<BootstrapEnvelope>();

    const bootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(bootstrap.status).toBe(200);

    const payload = await bootstrap.json<BootstrapPayload>();
    expect(payload.attemptId).toMatch(/^attempt_/);
    expect(payload.assessmentVersionId).toBe(published.assessmentVersionId);
    expect(payload.deliveryPolicy).toEqual(DEFAULT_DELIVERY_POLICY_SNAPSHOT);
    expect(payload.manifest).toEqual({
      manifestObjectKey: published.manifestObjectKey,
    });
    expect(payload.session.currentItemRef).toEqual({
      itemId: "item-1",
      itemHref: "items/item-1.xml",
    });
    expect(payload.session.sequence).toEqual({
      lastAcceptedSequence: null,
      nextSequence: 1,
    });
    expect(payload.session.timing).toMatchObject({
      startedAt: expect.any(String),
      expiresAt: null,
      softCloseAt: null,
      acceptUntil: null,
      remainingTimeSeconds: null,
    });
  });

  it("returns authoritative live sequence and current-item state for already-active attempts", async () => {
    const published = await publishFixture({
      tenantId: "tenant_bootstrap_live_state",
      assessmentSlug: "basic-assessment",
    });
    const targetItemRef = await appendReviewItemToManifest(published.manifestObjectKey);

    const launch = await postJson("/api/launch/preview", {
      mode: "preview",
      assessmentVersionId: published.assessmentVersionId,
      actor: {
        kind: "preview-operator",
        id: "preview_live_state_01",
        displayName: "Preview Live State",
      },
    });
    expect(launch.status).toBe(201);
    const envelope = await launch.json<BootstrapEnvelope>();

    const initialBootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(initialBootstrap.status).toBe(200);
    const initialPayload = await initialBootstrap.json<BootstrapPayload>();

    const responseEvent = await commitAttemptEvent(initialPayload.attemptId, {
      attemptId: initialPayload.attemptId,
      eventId: "evt_bootstrap_response_01",
      idempotencyKey: "idem_bootstrap_response_01",
      sequenceNumber: 1,
      clientTimestamp: "2026-03-26T22:15:00.000Z",
      clientSessionId: "client_session_bootstrap_01",
      itemRef: initialPayload.session.currentItemRef,
      type: "response.changed",
      payload: {
        responseKey: "RESPONSE_BOOTSTRAP",
        responseState: {
          candidateResponse: "A",
        },
      },
    });
    expect(responseEvent.status).toBe(200);

    const navigationEvent = await commitAttemptEvent(initialPayload.attemptId, {
      attemptId: initialPayload.attemptId,
      eventId: "evt_bootstrap_navigation_01",
      idempotencyKey: "idem_bootstrap_navigation_01",
      sequenceNumber: 2,
      clientTimestamp: "2026-03-26T22:15:02.000Z",
      clientSessionId: "client_session_bootstrap_01",
      itemRef: initialPayload.session.currentItemRef,
      type: "navigation.requested",
      payload: {
        targetItemRef,
      },
    });
    expect(navigationEvent.status).toBe(200);
    const navigationReceipt = await navigationEvent.json<CommitAttemptEventReceipt>();
    expect(navigationReceipt.highestCommittedSequence).toBe(2);

    const liveBootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    expect(liveBootstrap.status).toBe(200);

    const livePayload = await liveBootstrap.json<BootstrapPayload>();
    expect(livePayload.attemptId).toBe(initialPayload.attemptId);
    expect(livePayload.session.currentItemRef).toEqual(targetItemRef);
    expect(livePayload.session.sequence).toEqual({
      lastAcceptedSequence: 2,
      nextSequence: 3,
    });
    expect(livePayload.session.timing).toMatchObject({
      startedAt: expect.any(String),
      expiresAt: null,
      softCloseAt: null,
      acceptUntil: null,
      remainingTimeSeconds: null,
    });
  });

  it("rejects expired, tampered, or version-mismatched bootstrap tokens without leaking signer details", async () => {
    const firstPublish = await publishFixture({
      tenantId: "tenant_bootstrap_reject",
      assessmentSlug: "basic-assessment",
    });
    const secondPublish = await publishFixture({
      tenantId: "tenant_bootstrap_reject",
      assessmentSlug: "basic-assessment",
    });

    const previewLaunch = await postJson("/api/launch/preview", {
      mode: "preview",
      assessmentVersionId: firstPublish.assessmentVersionId,
      actor: {
        kind: "preview-operator",
        id: "preview_reject_01",
        displayName: "Preview Reject",
      },
    });
    expect(previewLaunch.status).toBe(201);
    const envelope = await previewLaunch.json<BootstrapEnvelope>();

    const validBootstrap = await exchangeBootstrap(envelope.bootstrapToken);
    const validPayload = await validBootstrap.json<BootstrapPayload>();
    const attempt = await readAttemptEntry(validPayload.attemptId);

    const tamperedToken = `${envelope.bootstrapToken}x`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredToken = await issueBootstrapToken({
      secret: TEST_BOOTSTRAP_SECRET,
      claims: buildClaimsFromAttempt({
        attempt,
        issuedAt: nowSeconds - 120,
        expiresAt: nowSeconds - 60,
        tokenId: "btok_expired",
      }),
    });
    const mismatchedToken = await issueBootstrapToken({
      secret: TEST_BOOTSTRAP_SECRET,
      claims: buildClaimsFromAttempt({
        attempt,
        assessmentVersionId: secondPublish.assessmentVersionId,
        issuedAt: nowSeconds,
        expiresAt: nowSeconds + 300,
        tokenId: "btok_mismatch",
      }),
    });

    const tamperedResponse = await exchangeBootstrap(tamperedToken);
    const expiredResponse = await exchangeBootstrap(expiredToken);
    const mismatchedResponse = await exchangeBootstrap(mismatchedToken);

    expect(tamperedResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
    expect(mismatchedResponse.status).toBe(403);

    for (const response of [tamperedResponse, expiredResponse, mismatchedResponse]) {
      const payload = await response.json<{ error: string }>();
      expect(payload.error.toLowerCase()).not.toContain("secret");
      expect(payload.error.toLowerCase()).not.toContain("hmac");
      expect(payload.error.toLowerCase()).not.toContain(TEST_BOOTSTRAP_SECRET.toLowerCase());
    }
  });
});
