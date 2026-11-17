import JSZip from "jszip";
import { runDurableObjectAlarm, applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  AttemptEventEnvelope,
  AttemptAccommodationState,
  AttemptPolicyCommand,
  AttemptPolicyReadResponse,
  AttemptPolicyState,
  BootstrapEnvelope,
  BootstrapPayload,
  CommitAttemptEventReceipt,
  DeliveryPolicySnapshot,
  ExtendTimePolicyCommand,
  PostOperatorMessagePolicyCommand,
  ReopenAttemptPolicyCommand,
  RendererPnpAccommodation,
  RendererSessionControlAccommodation,
} from "@harbor/attempt-protocol";
import {
  ATTEMPT_POLICY_COMMAND_TYPES,
  createEmptyAttemptPolicyState,
} from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

const CURRENT_ITEM = {
  itemId: "item-1",
  itemHref: "tenants/tenant_demo/assessments/asmt_01/versions/vers_01/items/item-1.xml",
} as const;

const DELIVERY_POLICY: DeliveryPolicySnapshot = {
  launchMode: "access-code",
  navigationMode: "linear",
  maxAttempts: 1,
  timeLimitSeconds: 1800,
  gracePeriodSeconds: 300,
};

const POLICY_STATE: AttemptPolicyState = {
  overlayRevision: 3,
  timing: {
    additionalTimeSeconds: 900,
    effectiveTimeLimitSeconds: 2700,
    effectiveSoftCloseAt: "2026-03-27T02:45:00.000Z",
    effectiveAcceptUntil: "2026-03-27T02:50:00.000Z",
  },
  reopen: {
    status: "reopened",
    reopenedAt: "2026-03-27T02:10:00.000Z",
    reopenUntil: "2026-03-27T02:50:00.000Z",
  },
  operatorMessage: {
    messageId: "msg_01",
    level: "info",
    title: "Timing updated",
    body: "Extra time is active for this attempt.",
    postedAt: "2026-03-27T02:10:00.000Z",
    effectiveUntil: null,
  },
  accommodations: {
    rendererPnp: {
      layoutSingleColumn: true,
      glossaryOnScreen: false,
      textAppearance: {
        colorStyle: "qti3-player-color-blackwhite",
      },
    },
    sessionControl: {
      allow_review: false,
      allow_skipping: false,
      time_limits: {
        max_time: 2700,
        allow_late_submission: true,
      },
    },
  },
};

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
    "attempt_deadline_jobs",
    "attempt_policy_commands",
    "attempt_policy_overlays",
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
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "basic-assessment.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

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

async function getJson(path: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
    }),
  );
}

async function updatePublishedDeliveryPolicy(input: {
  assessmentVersionId: string;
  deliveryPolicy: DeliveryPolicySnapshot;
}): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  await HARBOR_DB.prepare(
    "UPDATE assessment_versions SET delivery_policy_snapshot = ? WHERE id = ?",
  )
    .bind(JSON.stringify(input.deliveryPolicy), input.assessmentVersionId)
    .run();
}

async function readLatestAttemptId(): Promise<string> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT id FROM attempt_entries ORDER BY created_at DESC LIMIT 1",
  ).first<{ id: string }>();

  expect(attempt?.id).toBeTruthy();
  return attempt!.id;
}

async function updateAttemptCreatedAt(attemptId: string, createdAt: string): Promise<void> {
  const { HARBOR_DB } = getTestEnv();
  await HARBOR_DB.prepare("UPDATE attempt_entries SET created_at = ? WHERE id = ?")
    .bind(createdAt, attemptId)
    .run();
}

async function readAttemptDeliveryPolicy(attemptId: string): Promise<DeliveryPolicySnapshot> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT delivery_policy_snapshot FROM attempt_entries WHERE id = ?",
  )
    .bind(attemptId)
    .first<{ delivery_policy_snapshot: string }>();

  expect(attempt).toBeTruthy();
  return JSON.parse(attempt!.delivery_policy_snapshot) as DeliveryPolicySnapshot;
}

async function readPolicyOverlayRow(attemptId: string): Promise<{
  overlay_revision: number;
  additional_time_seconds: number;
  reopen_status: string;
  reopen_until: string | null;
  operator_message_json: string | null;
  accommodations_json: string;
} | null> {
  const { HARBOR_DB } = getTestEnv();
  return HARBOR_DB.prepare(
    "SELECT overlay_revision, additional_time_seconds, reopen_status, reopen_until, operator_message_json, accommodations_json FROM attempt_policy_overlays WHERE attempt_id = ?",
  )
    .bind(attemptId)
    .first<{
      overlay_revision: number;
      additional_time_seconds: number;
      reopen_status: string;
      reopen_until: string | null;
      operator_message_json: string | null;
      accommodations_json: string;
    }>();
}

async function readPolicyCommandRows(attemptId: string): Promise<
  Array<{
    command_type: string;
    actor_role: string;
    actor_id: string;
    reason: string;
  }>
> {
  const { HARBOR_DB } = getTestEnv();
  const result = await HARBOR_DB.prepare(
    "SELECT command_type, actor_role, actor_id, reason FROM attempt_policy_commands WHERE attempt_id = ? ORDER BY created_at ASC",
  )
    .bind(attemptId)
    .all<{
      command_type: string;
      actor_role: string;
      actor_id: string;
      reason: string;
    }>();

  return result.results;
}

async function launchPreviewAttempt(input: {
  assessmentVersionId: string;
}): Promise<BootstrapEnvelope> {
  const launch = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: input.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: "preview_policy_operator",
      displayName: "Policy Preview",
    },
  });

  expect(launch.status).toBe(201);
  return launch.json<BootstrapEnvelope>();
}

async function preparePreviewAttempt(input: {
  seed: string;
  deliveryPolicy: DeliveryPolicySnapshot;
  createdAt?: string;
}): Promise<{
  attemptId: string;
  envelope: BootstrapEnvelope;
}> {
  const published = await publishFixture({
    tenantId: `tenant_${input.seed}`,
    assessmentSlug: input.seed,
  });

  await updatePublishedDeliveryPolicy({
    assessmentVersionId: published.assessmentVersionId,
    deliveryPolicy: input.deliveryPolicy,
  });

  const envelope = await launchPreviewAttempt({
    assessmentVersionId: published.assessmentVersionId,
  });
  const attemptId = await readLatestAttemptId();

  if (input.createdAt) {
    await updateAttemptCreatedAt(attemptId, input.createdAt);
  }

  return {
    attemptId,
    envelope,
  };
}

async function exchangeBootstrap(bootstrapToken: string): Promise<BootstrapPayload> {
  const response = await postJson("/api/bootstrap", {
    bootstrapToken,
  });

  expect(response.status).toBe(200);
  return response.json<BootstrapPayload>();
}

function buildPolicyActor() {
  return {
    role: "operator" as const,
    actorId: "operator_01",
    displayName: "Operations Lead",
  };
}

function buildAttemptEvent(input: {
  attemptId: string;
  sequenceNumber: number;
  type?: AttemptEventEnvelope["type"];
}): AttemptEventEnvelope {
  const type = input.type ?? "response.changed";

  if (type === "submit.requested") {
    return {
      attemptId: input.attemptId,
      eventId: `evt_${input.sequenceNumber}`,
      idempotencyKey: `idem_${input.sequenceNumber}`,
      sequenceNumber: input.sequenceNumber,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "client_session_policy_01",
      itemRef: CURRENT_ITEM,
      type,
      payload: {
        requestedAt: new Date().toISOString(),
      },
    };
  }

  return {
    attemptId: input.attemptId,
    eventId: `evt_${input.sequenceNumber}`,
    idempotencyKey: `idem_${input.sequenceNumber}`,
    sequenceNumber: input.sequenceNumber,
    clientTimestamp: new Date().toISOString(),
    clientSessionId: "client_session_policy_01",
    itemRef: CURRENT_ITEM,
    type: "response.changed",
    payload: {
      responseKey: `RESPONSE_${input.sequenceNumber}`,
      responseState: {
        value: input.sequenceNumber,
      },
    },
  };
}

async function commitAttemptEvent(
  attemptId: string,
  event: AttemptEventEnvelope,
): Promise<Response> {
  return postJson(`/api/attempts/${attemptId}/events`, event);
}

async function applyPolicyCommand(
  attemptId: string,
  command: AttemptPolicyCommand,
): Promise<Response> {
  return postJson(`/internal/attempts/${attemptId}/policy`, command);
}

async function readPolicy(attemptId: string): Promise<Response> {
  return getJson(`/api/attempts/${attemptId}/policy`);
}

beforeEach(async () => {
  await resetBindings();
});

describe("policy-overlay protocol contracts", () => {
  it("defines additive overlay state without mutating the pinned delivery policy snapshot", () => {
    const payload: BootstrapPayload = {
      attemptId: "attempt_policy_01",
      assessmentVersionId: "vers_policy_01",
      deliveryPolicy: DELIVERY_POLICY,
      policy: POLICY_STATE,
      manifest: {
        manifestObjectKey:
          "tenants/tenant_demo/assessments/asmt_01/versions/vers_policy_01/manifests/delivery.json",
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
        currentItemRef: CURRENT_ITEM,
        sequence: null,
        timing: null,
        attemptStatus: "active",
      },
    };

    expect(payload.policy!.overlayRevision).toBe(3);
    expect(payload.policy!.timing.additionalTimeSeconds).toBe(900);
    expect(payload.policy!.reopen.status).toBe("reopened");
    expect(payload.policy!.operatorMessage?.body).toContain("Extra time");
    expect(payload.policy!.accommodations.rendererPnp.layoutSingleColumn).toBe(true);
    expect("overlayRevision" in payload.deliveryPolicy).toBe(false);
    expect(createEmptyAttemptPolicyState()).toEqual({
      overlayRevision: 0,
      timing: {
        additionalTimeSeconds: 0,
        effectiveTimeLimitSeconds: null,
        effectiveSoftCloseAt: null,
        effectiveAcceptUntil: null,
      },
      reopen: {
        status: "closed",
        reopenedAt: null,
        reopenUntil: null,
      },
      operatorMessage: null,
      accommodations: {
        rendererPnp: {},
        sessionControl: {},
        shellTools: {},
      },
    });

    expectTypeOf<AttemptPolicyState["accommodations"]>().toEqualTypeOf<AttemptAccommodationState>();
    expectTypeOf<
      AttemptPolicyState["accommodations"]["rendererPnp"]
    >().toEqualTypeOf<RendererPnpAccommodation>();
    expectTypeOf<
      AttemptPolicyState["accommodations"]["sessionControl"]
    >().toEqualTypeOf<RendererSessionControlAccommodation>();
  });

  it("defines typed policy commands for extend-time, reopen-attempt, and operator messages", () => {
    const extendTime: ExtendTimePolicyCommand = {
      commandId: "cmd_extend_01",
      type: "extend-time",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Approved accommodation",
      issuedAt: "2026-03-27T02:10:00.000Z",
      effectiveAt: "2026-03-27T02:10:00.000Z",
      additionalTimeSeconds: 900,
    };

    const reopenAttempt: ReopenAttemptPolicyCommand = {
      commandId: "cmd_reopen_01",
      type: "reopen-attempt",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Network outage recovery",
      issuedAt: "2026-03-27T02:15:00.000Z",
      effectiveAt: "2026-03-27T02:15:00.000Z",
      reopenUntil: "2026-03-27T02:50:00.000Z",
    };

    const operatorMessage: PostOperatorMessagePolicyCommand = {
      commandId: "cmd_message_01",
      type: "post-operator-message",
      actor: {
        role: "operator",
        actorId: "operator_01",
        displayName: "Operations Lead",
      },
      reason: "Student notification",
      issuedAt: "2026-03-27T02:15:00.000Z",
      effectiveAt: "2026-03-27T02:15:00.000Z",
      message: {
        level: "info",
        title: "Stay in this attempt",
        body: "Your updated timing is now active.",
        effectiveUntil: null,
      },
    };

    const commands: AttemptPolicyCommand[] = [extendTime, reopenAttempt, operatorMessage];

    expect(ATTEMPT_POLICY_COMMAND_TYPES).toEqual([
      "transfer-workstation",
      "extend-time",
      "reopen-attempt",
      "post-operator-message",
      "set-accommodations",
    ]);
    expect(commands.map((command) => command.type)).toEqual([
      "extend-time",
      "reopen-attempt",
      "post-operator-message",
    ]);
    expect(commands.every((command) => Boolean(command.actor.actorId))).toBe(true);
  });

  it("keeps bootstrap, policy reads, and durable receipts aligned around one authoritative overlay state", () => {
    const payload: BootstrapPayload = {
      attemptId: "attempt_policy_01",
      assessmentVersionId: "vers_policy_01",
      deliveryPolicy: DELIVERY_POLICY,
      policy: POLICY_STATE,
      manifest: {
        manifestObjectKey:
          "tenants/tenant_demo/assessments/asmt_01/versions/vers_policy_01/manifests/delivery.json",
      },
      launch: {
        mode: "preview",
        actor: {
          kind: "preview-operator",
          id: "preview_01",
          displayName: "Preview Operator",
        },
      },
      session: {
        currentItemRef: CURRENT_ITEM,
        sequence: {
          lastAcceptedSequence: 4,
          nextSequence: 5,
        },
        timing: {
          startedAt: "2026-03-27T02:00:00.000Z",
          expiresAt: "2026-03-27T02:45:00.000Z",
          softCloseAt: "2026-03-27T02:45:00.000Z",
          acceptUntil: "2026-03-27T02:50:00.000Z",
          remainingTimeSeconds: 1800,
        },
        attemptStatus: "reopened",
      },
    };

    const receipt: CommitAttemptEventReceipt = {
      outcome: "accepted",
      receiptId: "rcpt_policy_01",
      attemptId: "attempt_policy_01",
      acceptedEventId: "evt_policy_05",
      acceptedSequenceNumber: 5,
      highestCommittedSequence: 5,
      attemptStatus: "reopened",
      currentItemRef: CURRENT_ITEM,
      timing: {
        startedAt: "2026-03-27T02:00:00.000Z",
        expiresAt: "2026-03-27T02:45:00.000Z",
        softCloseAt: "2026-03-27T02:45:00.000Z",
        acceptUntil: "2026-03-27T02:50:00.000Z",
        remainingTimeSeconds: 1795,
      },
      policy: POLICY_STATE,
      serverTimestamp: "2026-03-27T02:10:05.000Z",
    };

    const policyRead: AttemptPolicyReadResponse = {
      attemptId: "attempt_policy_01",
      attemptStatus: "reopened",
      timing: receipt.timing,
      policy: POLICY_STATE,
    };

    expect(payload.policy!).toEqual(receipt.policy!);
    expect(policyRead.policy).toEqual(receipt.policy!);
    expect(policyRead.policy.overlayRevision).toBe(payload.policy!.overlayRevision);
  });
});

describe("policy-overlay runtime behavior", () => {
  it("records audit rows, persists overlay state, and returns authoritative policy reads from the Attempt Durable Object", async () => {
    const createdAt = new Date(Date.now() - 5_000).toISOString();
    const { attemptId } = await preparePreviewAttempt({
      seed: "policy-runtime-audit",
      createdAt,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
    });

    const response = await applyPolicyCommand(attemptId, {
      commandId: "cmd_extend_audit",
      type: "extend-time",
      actor: buildPolicyActor(),
      reason: "Approved extra time",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      additionalTimeSeconds: 120,
    });

    expect(response.status).toBe(200);
    const applied = await response.json<AttemptPolicyReadResponse>();
    expect(applied.policy.overlayRevision).toBe(1);
    expect(applied.policy.timing.additionalTimeSeconds).toBe(120);
    expect(applied.attemptStatus).toBe("active");

    const overlayRow = await readPolicyOverlayRow(attemptId);
    expect(overlayRow).toMatchObject({
      overlay_revision: 1,
      additional_time_seconds: 120,
      reopen_status: "closed",
    });

    const commands = await readPolicyCommandRows(attemptId);
    expect(commands).toEqual([
      {
        command_type: "extend-time",
        actor_role: "operator",
        actor_id: "operator_01",
        reason: "Approved extra time",
      },
    ]);

    const policyReadResponse = await readPolicy(attemptId);
    expect(policyReadResponse.status).toBe(200);
    const policyRead = await policyReadResponse.json<AttemptPolicyReadResponse>();
    expect(policyRead.attemptId).toBe(applied.attemptId);
    expect(policyRead.attemptStatus).toBe(applied.attemptStatus);
    expect(policyRead.policy).toEqual(applied.policy);
    expect(policyRead.timing.effectivePolicyVersion).toBe(applied.timing.effectivePolicyVersion);
    expect(policyRead.timing.remainingTimeSeconds).toBeLessThanOrEqual(
      applied.timing.remainingTimeSeconds ?? 0,
    );
  });

  it("recalculates effective timing from pinned policy plus additive overlay state without rewriting the attempt entry snapshot", async () => {
    const createdAtDate = new Date(Date.now() - 10_000);
    const createdAt = createdAtDate.toISOString();
    const basePolicy: DeliveryPolicySnapshot = {
      launchMode: "preview",
      navigationMode: "linear",
      maxAttempts: 1,
      timeLimitSeconds: 60,
      gracePeriodSeconds: 30,
    };
    const { attemptId } = await preparePreviewAttempt({
      seed: "policy-runtime-timing",
      createdAt,
      deliveryPolicy: basePolicy,
    });

    await applyPolicyCommand(attemptId, {
      commandId: "cmd_extend_timing",
      type: "extend-time",
      actor: buildPolicyActor(),
      reason: "Accommodation extension",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      additionalTimeSeconds: 120,
    });

    const reopenUntil = new Date(createdAtDate.getTime() + 6 * 60_000).toISOString();
    const reopenResponse = await applyPolicyCommand(attemptId, {
      commandId: "cmd_reopen_timing",
      type: "reopen-attempt",
      actor: buildPolicyActor(),
      reason: "Temporary reconnect window",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      reopenUntil,
    });

    expect(reopenResponse.status).toBe(200);
    const reopened = await reopenResponse.json<AttemptPolicyReadResponse>();
    expect(reopened.policy.overlayRevision).toBe(2);
    expect(reopened.policy.timing.effectiveTimeLimitSeconds).toBe(180);
    expect(reopened.policy.timing.effectiveSoftCloseAt).toBe(reopenUntil);
    expect(reopened.policy.timing.effectiveAcceptUntil).toBe(reopenUntil);
    expect(reopened.timing.softCloseAt).toBe(reopenUntil);
    expect(reopened.timing.acceptUntil).toBe(reopenUntil);
    expect(reopened.attemptStatus).toBe("reopened");

    const persistedPolicy = await readAttemptDeliveryPolicy(attemptId);
    expect(persistedPolicy).toEqual(basePolicy);
  });

  it("keeps the Phase 2 event path intact while allowing explicit overlay commands to change expired or submitted attempts", async () => {
    const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const { attemptId, envelope } = await preparePreviewAttempt({
      seed: "policy-runtime-gates",
      createdAt,
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 60,
        gracePeriodSeconds: 30,
      },
    });

    await exchangeBootstrap(envelope.bootstrapToken);
    const namespace = (env as unknown as { ATTEMPT_COORDINATOR: DurableObjectNamespace })
      .ATTEMPT_COORDINATOR;
    await runDurableObjectAlarm(namespace.get(namespace.idFromName(attemptId)));

    const expiredCommit = await commitAttemptEvent(
      attemptId,
      buildAttemptEvent({
        attemptId,
        sequenceNumber: 1,
      }),
    );
    expect(expiredCommit.status).toBe(200);
    await expect(expiredCommit.json()).resolves.toMatchObject({
      outcome: "late_preserved",
      attemptStatus: "submitted",
    });

    const reopenUntil = new Date(Date.now() + 60_000).toISOString();
    const reopenResponse = await applyPolicyCommand(attemptId, {
      commandId: "cmd_reopen_gate",
      type: "reopen-attempt",
      actor: buildPolicyActor(),
      reason: "Reconnect recovery",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      reopenUntil,
    });
    expect(reopenResponse.status).toBe(200);

    const acceptedCommit = await commitAttemptEvent(
      attemptId,
      buildAttemptEvent({
        attemptId,
        sequenceNumber: 2,
      }),
    );
    expect(acceptedCommit.status).toBe(200);

    const submitResponse = await commitAttemptEvent(
      attemptId,
      buildAttemptEvent({
        attemptId,
        sequenceNumber: 3,
        type: "submit.requested",
      }),
    );
    expect(submitResponse.status).toBe(200);

    const blockedAfterSubmit = await commitAttemptEvent(
      attemptId,
      buildAttemptEvent({
        attemptId,
        sequenceNumber: 4,
      }),
    );
    expect(blockedAfterSubmit.status).toBe(200);
    await expect(blockedAfterSubmit.json()).resolves.toMatchObject({
      outcome: "late_preserved",
      attemptStatus: "submitted",
    });

    const messageResponse = await applyPolicyCommand(attemptId, {
      commandId: "cmd_message_gate",
      type: "post-operator-message",
      actor: buildPolicyActor(),
      reason: "Submitted follow-up",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      message: {
        level: "info",
        title: "Submission received",
        body: "Your attempt remains submitted while the message overlay updates.",
        effectiveUntil: null,
      },
    });
    expect(messageResponse.status).toBe(200);
    const messagePayload = await messageResponse.json<AttemptPolicyReadResponse>();
    expect(messagePayload.attemptStatus).toBe("submitted");
    expect(messagePayload.policy.operatorMessage?.title).toBe("Submission received");
  });

  it("rejects invalid policy command enum and timing-limit shapes at the boundary", async () => {
    const { attemptId } = await preparePreviewAttempt({
      seed: "policy-runtime-invalid-boundary",
      deliveryPolicy: DELIVERY_POLICY,
    });

    const invalidMessage = await postJson(`/internal/attempts/${attemptId}/policy`, {
      commandId: "cmd_invalid_message_level",
      type: "post-operator-message",
      actor: buildPolicyActor(),
      reason: "Invalid operator message",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      message: {
        level: "severe",
        title: "Invalid",
        body: "This should not be accepted.",
        effectiveUntil: null,
      },
    });
    expect(invalidMessage.status).toBe(400);
    await expect(invalidMessage.json()).resolves.toMatchObject({
      error: "message.level must be info, warning, or critical",
    });

    const invalidTimeLimits = await postJson(`/internal/attempts/${attemptId}/policy`, {
      commandId: "cmd_invalid_time_limits",
      type: "set-accommodations",
      actor: buildPolicyActor(),
      reason: "Invalid time limits",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      accommodations: {
        rendererPnp: {},
        sessionControl: {
          time_limits: {
            max_time: "forever",
          },
        },
      },
    });
    expect(invalidTimeLimits.status).toBe(400);
    await expect(invalidTimeLimits.json()).resolves.toMatchObject({
      error: "sessionControl.time_limits.max_time must be a number or null",
    });
  });

  it("keeps bootstrap payloads, policy reads, and accepted receipts aligned around the same effective overlay state", async () => {
    const { attemptId, envelope } = await preparePreviewAttempt({
      seed: "policy-runtime-bootstrap",
      deliveryPolicy: {
        launchMode: "preview",
        navigationMode: "linear",
        maxAttempts: 1,
        timeLimitSeconds: 120,
        gracePeriodSeconds: 45,
      },
    });

    await applyPolicyCommand(attemptId, {
      commandId: "cmd_extend_bootstrap",
      type: "extend-time",
      actor: buildPolicyActor(),
      reason: "Accommodation extension",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      additionalTimeSeconds: 90,
    });
    await applyPolicyCommand(attemptId, {
      commandId: "cmd_reopen_bootstrap",
      type: "reopen-attempt",
      actor: buildPolicyActor(),
      reason: "Delivery recovery",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      reopenUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await applyPolicyCommand(attemptId, {
      commandId: "cmd_message_bootstrap",
      type: "post-operator-message",
      actor: buildPolicyActor(),
      reason: "Notify candidate",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      message: {
        level: "warning",
        title: "Time updated",
        body: "Your attempt policy has changed.",
        effectiveUntil: null,
      },
    });
    await applyPolicyCommand(attemptId, {
      commandId: "cmd_accommodation_bootstrap",
      type: "set-accommodations",
      actor: buildPolicyActor(),
      reason: "Accessibility support",
      issuedAt: new Date().toISOString(),
      effectiveAt: new Date().toISOString(),
      accommodations: {
        rendererPnp: {
          layoutSingleColumn: true,
          glossaryOnScreen: false,
        },
        sessionControl: {
          allow_review: false,
          allow_skipping: false,
          time_limits: {
            max_time: 210,
            allow_late_submission: true,
          },
        },
      },
    });

    const bootstrapPayload = await exchangeBootstrap(envelope.bootstrapToken);
    const policyReadResponse = await readPolicy(attemptId);
    expect(policyReadResponse.status).toBe(200);
    const policyRead = await policyReadResponse.json<AttemptPolicyReadResponse>();

    const commitResponse = await commitAttemptEvent(
      attemptId,
      buildAttemptEvent({
        attemptId,
        sequenceNumber: 1,
      }),
    );
    expect(commitResponse.status).toBe(200);
    const receipt = await commitResponse.json<CommitAttemptEventReceipt>();

    expect(bootstrapPayload.policy!).toEqual(policyRead.policy);
    expect(receipt.policy!).toEqual(policyRead.policy);
    expect(bootstrapPayload.policy!.overlayRevision).toBe(4);
    expect(bootstrapPayload.policy!.operatorMessage?.title).toBe("Time updated");
    expect(bootstrapPayload.policy!.accommodations.rendererPnp.layoutSingleColumn).toBe(true);
    expect(receipt.policy!.accommodations.sessionControl.allow_review).toBe(false);
    expect(receipt.policy!.accommodations.sessionControl.time_limits?.max_time).toBe(210);
  });
});
