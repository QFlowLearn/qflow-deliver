import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  ActivateAssessmentVersionRequest,
  AttemptEventEnvelope,
  AttemptPolicyReadResponse,
  AttemptTimelineEntry,
  AttemptTimelineResponse,
  BatchOperatorAttemptActionRequest,
  BootstrapEnvelope,
  BootstrapPayload,
  OperatorAttemptActionRequest,
  OperatorAttemptActionType,
} from "@harbor/attempt-protocol";
import {
  ATTEMPT_TIMELINE_EVENT_TYPES,
  OPERATOR_ATTEMPT_ACTION_TYPES,
} from "@harbor/attempt-protocol";
import manifestXml from "../../../tests/fixtures/qti/basic-assessment/imsmanifest.xml?raw";
import itemXml from "../../../tests/fixtures/qti/basic-assessment/items/item-1.xml?raw";
import stimulusSvg from "../../../tests/fixtures/qti/basic-assessment/assets/stimulus.svg?raw";

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

async function resetDb(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "assessment_version_activations",
    "attempt_timeline_events",
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

async function readSchema(tableName: string): Promise<string | null> {
  const { HARBOR_DB } = getTestEnv();
  const table = await HARBOR_DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(tableName)
    .first<{ sql: string | null }>();

  return table?.sql ?? null;
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

async function readLatestAttemptId(): Promise<string> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT id FROM attempt_entries ORDER BY created_at DESC LIMIT 1",
  ).first<{ id: string }>();

  expect(attempt?.id).toBeTruthy();
  return attempt!.id;
}

async function launchPreviewAttempt(input: {
  assessmentVersionId: string;
  actorId?: string;
}): Promise<{
  attemptId: string;
  envelope: BootstrapEnvelope;
}> {
  const response = await postJson("/api/launch/preview", {
    mode: "preview",
    assessmentVersionId: input.assessmentVersionId,
    actor: {
      kind: "preview-operator",
      id: input.actorId ?? "preview_operator_01",
      displayName: "Operator Preview",
    },
  });

  expect(response.status).toBe(201);
  const envelope = await response.json<BootstrapEnvelope>();
  return {
    attemptId: await readLatestAttemptId(),
    envelope,
  };
}

async function exchangeBootstrap(input: {
  bootstrapToken: string;
  clientSessionId?: string;
}): Promise<BootstrapPayload> {
  const response = await postJson("/api/bootstrap", {
    bootstrapToken: input.bootstrapToken,
    clientSessionId: input.clientSessionId,
  });

  expect(response.status).toBe(200);
  return response.json<BootstrapPayload>();
}

async function issuePinnedAccessCode(
  assessmentVersionId: string,
  code: string,
): Promise<{ accessCodeId: string; accessCode: string; assessmentVersionId: string }> {
  const response = await postJson("/internal/access-codes", {
    assessmentVersionId,
    code,
  });

  expect(response.status).toBe(201);
  return response.json();
}

async function issueAssessmentAccessCode(input: {
  assessmentId: string;
  code: string;
}): Promise<{ accessCodeId: string; accessCode: string; assessmentVersionId: string }> {
  const response = await postJson("/internal/access-codes", {
    assessmentId: input.assessmentId,
    code: input.code,
  });

  expect(response.status).toBe(201);
  return response.json();
}

async function readAttemptVersionId(attemptId: string): Promise<string> {
  const { HARBOR_DB } = getTestEnv();
  const attempt = await HARBOR_DB.prepare(
    "SELECT assessment_version_id FROM attempt_entries WHERE id = ?",
  )
    .bind(attemptId)
    .first<{ assessment_version_id: string }>();

  expect(attempt).toBeTruthy();
  return attempt!.assessment_version_id;
}

async function readAccessCodeVersionId(accessCodeId: string): Promise<string> {
  const { HARBOR_DB } = getTestEnv();
  const accessCode = await HARBOR_DB.prepare(
    "SELECT assessment_version_id FROM access_codes WHERE id = ?",
  )
    .bind(accessCodeId)
    .first<{ assessment_version_id: string }>();

  expect(accessCode).toBeTruthy();
  return accessCode!.assessment_version_id;
}

function buildOperatorAction(
  overrides: Partial<OperatorAttemptActionRequest> = {},
): OperatorAttemptActionRequest {
  return {
    actionId: "act_extend_01",
    type: "extend-time",
    actor: {
      role: "operator",
      actorId: "operator_01",
      displayName: "Operations Lead",
    },
    reason: "Approved extension",
    effectiveAt: new Date().toISOString(),
    additionalTimeSeconds: 120,
    ...overrides,
  } as OperatorAttemptActionRequest;
}

function buildAttemptEvent(input: {
  attemptId: string;
  sequenceNumber: number;
  itemRef: BootstrapPayload["session"]["currentItemRef"];
  type: AttemptEventEnvelope["type"];
}): AttemptEventEnvelope {
  if (input.type === "submit.requested") {
    return {
      attemptId: input.attemptId,
      eventId: `evt_${input.sequenceNumber}`,
      idempotencyKey: `idem_${input.sequenceNumber}`,
      sequenceNumber: input.sequenceNumber,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "timeline_session_01",
      itemRef: input.itemRef,
      type: "submit.requested",
      payload: {
        requestedAt: new Date().toISOString(),
      },
    };
  }

  if (input.type === "item.completed") {
    return {
      attemptId: input.attemptId,
      eventId: `evt_${input.sequenceNumber}`,
      idempotencyKey: `idem_${input.sequenceNumber}`,
      sequenceNumber: input.sequenceNumber,
      clientTimestamp: new Date().toISOString(),
      clientSessionId: "timeline_session_01",
      itemRef: input.itemRef,
      type: "item.completed",
      payload: {
        completedAt: new Date().toISOString(),
      },
    };
  }

  return {
    attemptId: input.attemptId,
    eventId: `evt_${input.sequenceNumber}`,
    idempotencyKey: `idem_${input.sequenceNumber}`,
    sequenceNumber: input.sequenceNumber,
    clientTimestamp: new Date().toISOString(),
    clientSessionId: "timeline_session_01",
    itemRef: input.itemRef,
    type: "response.changed",
    payload: {
      responseKey: `RESPONSE_${input.sequenceNumber}`,
      responseState: {
        value: input.sequenceNumber,
      },
    },
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("operator action contracts", () => {
  it("covers single-target and explicit batch-target operator actions with actor, reason, and audit metadata", () => {
    expect(OPERATOR_ATTEMPT_ACTION_TYPES).toEqual([
      "transfer-workstation",
      "extend-time",
      "reopen-attempt",
      "post-operator-message",
    ] satisfies OperatorAttemptActionType[]);

    expectTypeOf<OperatorAttemptActionRequest>().toMatchTypeOf<{
      actionId: string;
      type: "transfer-workstation" | "extend-time" | "reopen-attempt" | "post-operator-message";
      actor: {
        role:
          | "operator"
          | "instructor"
          | "system"
          | "tenant-administrator"
          | "assessment-manager"
          | "invigilator"
          | "scorer";
        actorId: string;
        displayName: string | null;
      };
      reason: string;
      effectiveAt: string;
    }>();

    expectTypeOf<BatchOperatorAttemptActionRequest>().toMatchTypeOf<{
      attemptIds: string[];
      action: OperatorAttemptActionRequest;
    }>();
  });

  it("defines summarized timeline entries and activation requests without targeting existing pinned attempts", () => {
    expect(ATTEMPT_TIMELINE_EVENT_TYPES).toEqual([
      "launch",
      "reconnect",
      "accepted-checkpoint",
      "submit",
      "override",
      "secure-browser",
    ]);

    expectTypeOf<AttemptTimelineEntry>().toMatchTypeOf<{
      id: string;
      attemptId: string;
      eventType:
        | "launch"
        | "reconnect"
        | "accepted-checkpoint"
        | "submit"
        | "override"
        | "secure-browser";
      createdAt: string;
      actor: {
        role: string;
        actorId: string;
        displayName: string | null;
      } | null;
      reason: string | null;
    }>();

    expectTypeOf<ActivateAssessmentVersionRequest>().toMatchTypeOf<{
      activationId: string;
      assessmentId: string;
      assessmentVersionId: string;
      actor: {
        role:
          | "operator"
          | "instructor"
          | "system"
          | "tenant-administrator"
          | "assessment-manager"
          | "invigilator"
          | "scorer";
        actorId: string;
        displayName: string | null;
      };
      reason: string;
      activatedAt: string;
    }>();
  });
});

describe("operator action migration schema", () => {
  it("creates assessment_version_activations for future launch resolution history", async () => {
    const schema = await readSchema("assessment_version_activations");

    expect(schema).toContain('"assessment_id" TEXT NOT NULL');
    expect(schema).toContain('"assessment_version_id" TEXT NOT NULL');
    expect(schema).toContain('"actor_role" TEXT NOT NULL');
    expect(schema).toContain('"reason" TEXT NOT NULL');
    expect(schema).toContain('"activated_at" TEXT NOT NULL');
  });

  it("creates attempt_timeline_events for ordered launch, reconnect, checkpoint, submit, and override audit rows", async () => {
    const schema = await readSchema("attempt_timeline_events");

    expect(schema).toContain('"attempt_id" TEXT NOT NULL');
    expect(schema).toContain('"event_type" TEXT NOT NULL');
    expect(schema).toContain('"sequence_number" INTEGER');
    expect(schema).toContain('"actor_role" TEXT');
    expect(schema).toContain('"summary_json" TEXT NOT NULL');
    expect(schema).toContain('"created_at" TEXT NOT NULL');
  });
});

describe("operator action runtime behavior", () => {
  it("exposes single-attempt and explicit batch operator routes plus ordered attempt timelines", async () => {
    const published = await publishFixture({
      tenantId: "tenant_operator_runtime",
      assessmentSlug: "operator-runtime",
    });
    const firstAttempt = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      actorId: "preview_operator_first",
    });
    const secondAttempt = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
      actorId: "preview_operator_second",
    });

    const singleAction = await postJson(
      `/internal/attempts/${firstAttempt.attemptId}/actions`,
      buildOperatorAction(),
    );
    expect(singleAction.status).toBe(200);
    expect(await singleAction.json<AttemptPolicyReadResponse>()).toMatchObject({
      attemptId: firstAttempt.attemptId,
      policy: {
        timing: {
          additionalTimeSeconds: 120,
        },
      },
    });

    const batchAction = await postJson("/internal/attempt-actions/batch", {
      attemptIds: [firstAttempt.attemptId, secondAttempt.attemptId],
      action: buildOperatorAction({
        actionId: "act_message_batch",
        type: "post-operator-message",
        reason: "Shared candidate notification",
        message: {
          level: "warning",
          title: "Remain in Harbor",
          body: "A shared operator message is now active.",
          effectiveUntil: null,
        },
      }),
    });
    expect(batchAction.status).toBe(200);

    const batchPayload = await batchAction.json<{
      results: AttemptPolicyReadResponse[];
    }>();
    expect(batchPayload.results).toHaveLength(2);
    expect(batchPayload.results.map((result) => result.attemptId)).toEqual([
      firstAttempt.attemptId,
      secondAttempt.attemptId,
    ]);

    const secondPolicy = await getJson(`/api/attempts/${secondAttempt.attemptId}/policy`);
    expect(secondPolicy.status).toBe(200);
    expect(await secondPolicy.json<AttemptPolicyReadResponse>()).toMatchObject({
      attemptId: secondAttempt.attemptId,
      policy: {
        operatorMessage: {
          title: "Remain in Harbor",
        },
      },
    });

    const timelineResponse = await getJson(`/internal/attempts/${firstAttempt.attemptId}/timeline`);
    expect(timelineResponse.status).toBe(200);

    const timeline = await timelineResponse.json<AttemptTimelineResponse>();
    expect(timeline.attemptId).toBe(firstAttempt.attemptId);
    expect(timeline.entries.map((entry) => entry.eventType)).toEqual([
      "launch",
      "override",
      "override",
    ]);
  });

  it("keeps the operator timeline summarized while detailed response evidence lives in the evidence ledger", async () => {
    const published = await publishFixture({
      tenantId: "tenant_operator_timeline",
      assessmentSlug: "operator-timeline",
    });
    const launched = await launchPreviewAttempt({
      assessmentVersionId: published.assessmentVersionId,
    });
    const bootstrap = await exchangeBootstrap({
      bootstrapToken: launched.envelope.bootstrapToken,
      clientSessionId: "timeline_session_01",
    });

    const completedResponse = await postJson(
      `/api/attempts/${launched.attemptId}/events`,
      buildAttemptEvent({
        attemptId: launched.attemptId,
        sequenceNumber: 1,
        itemRef: bootstrap.session.currentItemRef,
        type: "item.completed",
      }),
    );
    expect(completedResponse.status).toBe(200);

    const responseChanged = await postJson(
      `/api/attempts/${launched.attemptId}/events`,
      buildAttemptEvent({
        attemptId: launched.attemptId,
        sequenceNumber: 2,
        itemRef: bootstrap.session.currentItemRef,
        type: "response.changed",
      }),
    );
    expect(responseChanged.status).toBe(200);

    const submitResponse = await postJson(
      `/api/attempts/${launched.attemptId}/events`,
      buildAttemptEvent({
        attemptId: launched.attemptId,
        sequenceNumber: 3,
        itemRef: bootstrap.session.currentItemRef,
        type: "submit.requested",
      }),
    );
    expect(submitResponse.status).toBe(200);

    await expect
      .poll(async () => {
        const response = await getJson(`/internal/attempts/${launched.attemptId}/timeline`);
        expect(response.status).toBe(200);
        return (await response.json<AttemptTimelineResponse>()).entries.length;
      })
      .toBe(4);
    const timelineResponse = await getJson(`/internal/attempts/${launched.attemptId}/timeline`);
    expect(timelineResponse.status).toBe(200);

    const timeline = await timelineResponse.json<AttemptTimelineResponse>();
    expect(timeline.entries.map((entry) => entry.eventType)).toEqual([
      "launch",
      "reconnect",
      "accepted-checkpoint",
      "submit",
    ]);
    expect(
      timeline.entries.filter((entry) => entry.eventType === "accepted-checkpoint"),
    ).toHaveLength(1);
    expect(
      timeline.entries.some((entry) => entry.summary.sourceEventType === "response.changed"),
    ).toBe(false);
  });

  it("activates corrected versions for future access-code issuance without mutating existing attempts or pinned access codes", async () => {
    const firstPublish = await publishFixture({
      tenantId: "tenant_operator_activation",
      assessmentSlug: "operator-activation",
    });
    const secondPublish = await publishFixture({
      tenantId: "tenant_operator_activation",
      assessmentSlug: "operator-activation",
    });

    expect(secondPublish.assessmentId).toBe(firstPublish.assessmentId);
    expect(secondPublish.assessmentVersionId).not.toBe(firstPublish.assessmentVersionId);

    const launched = await launchPreviewAttempt({
      assessmentVersionId: firstPublish.assessmentVersionId,
    });
    const pinned = await issuePinnedAccessCode(firstPublish.assessmentVersionId, "PINNED-OLD");

    const activation = await postJson(
      `/internal/assessments/${firstPublish.assessmentId}/activate-version`,
      {
        activationId: "activate_v2",
        assessmentVersionId: secondPublish.assessmentVersionId,
        actor: {
          role: "operator",
          actorId: "operator_activation",
          displayName: "Activation Operator",
        },
        reason: "Corrected version for future launches",
        activatedAt: new Date().toISOString(),
      },
    );
    expect(activation.status).toBe(200);
    expect(await activation.json<ActivateAssessmentVersionRequest>()).toMatchObject({
      assessmentId: firstPublish.assessmentId,
      assessmentVersionId: secondPublish.assessmentVersionId,
    });

    const futureIssued = await issueAssessmentAccessCode({
      assessmentId: firstPublish.assessmentId,
      code: "ACTIVE-V2",
    });
    expect(futureIssued.assessmentVersionId).toBe(secondPublish.assessmentVersionId);

    expect(await readAttemptVersionId(launched.attemptId)).toBe(firstPublish.assessmentVersionId);
    expect(await readAccessCodeVersionId(pinned.accessCodeId)).toBe(
      firstPublish.assessmentVersionId,
    );
  });
});
