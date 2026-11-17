import JSZip from "jszip";
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { expect } from "vitest";
import type {
  AttemptSubmissionSummary,
  BootstrapEnvelope,
  BootstrapPayload,
  CommitAttemptEventReceipt,
  StudentLaunchActor,
} from "@harbor/attempt-protocol";
import runtimeWorker, { type Env as RuntimeEnv } from "../src/index";
import {
  buildSubmitFinalizationEnvelope,
  consumeSubmitFinalizationBatch,
  SUBMIT_FINALIZATION_QUEUE_NAME,
  type SubmitFinalizationEnvelope,
} from "../src/queues/submit-finalization";
import { createAttemptEntry } from "../src/launch/create-preview-attempt";
import { createQueueMock } from "./queue-mock";

export const assessmentTestManifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="pkg-history">
  <metadata>
    <schema>QTI Package</schema>
    <schemaversion>3.0.0</schemaversion>
  </metadata>
  <organizations/>
  <resources>
    <resource identifier="test-1" type="imsqti_test_xmlv3p0" href="assessment.xml">
      <file href="assessment.xml"/>
      <dependency identifierref="item-resource-1"/>
      <dependency identifierref="item-resource-2"/>
    </resource>
    <resource identifier="item-resource-1" type="imsqti_item_xmlv3p0" href="items/item-1.xml">
      <file href="items/item-1.xml"/>
    </resource>
    <resource identifier="item-resource-2" type="imsqti_item_xmlv3p0" href="items/item-2.xml">
      <file href="items/item-2.xml"/>
    </resource>
  </resources>
</manifest>`;

export const assessmentTestXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="test-1" title="Student History Package">
  <qti-test-part identifier="part-1" navigation-mode="nonlinear" submission-mode="individual">
    <qti-assessment-section identifier="section-1" title="Section 1" visible="true">
      <qti-assessment-item-ref identifier="itemref-1" href="items/item-1.xml"/>
      <qti-assessment-item-ref identifier="itemref-2" href="items/item-2.xml"/>
    </qti-assessment-section>
  </qti-test-part>
</qti-assessment-test>`;

const scoredItemOneXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-1" title="President One" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response><qti-value>A</qti-value></qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-prompt>Who was the first U.S. President?</qti-prompt>
      <qti-simple-choice identifier="A">George Washington</qti-simple-choice>
      <qti-simple-choice identifier="B">John Adams</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

export const scoredItemTwoXml = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item-2" title="President Two" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response><qti-value>B</qti-value></qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-prompt>Who was the second U.S. President?</qti-prompt>
      <qti-simple-choice identifier="A">George Washington</qti-simple-choice>
      <qti-simple-choice identifier="B">John Adams</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

export function getTestEnv(): {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  BOOTSTRAP_SIGNING_SECRET: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
  ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    CONTENT_BUCKET: R2Bucket;
    BOOTSTRAP_SIGNING_SECRET: string;
    LTI_TOOL_PRIVATE_KEY_JWK: string;
    ATTEMPT_COORDINATOR: DurableObjectNamespace;
    ATTEMPT_RUNTIME_METRICS: AnalyticsEngineDataset;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

export async function resetBindings(): Promise<void> {
  const { HARBOR_DB, CONTENT_BUCKET, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "score_amendment_applications",
    "external_outcome_deliveries",
    "external_outcome_messages",
    "result_score_revisions",
    "score_amendment_deactivations",
    "score_amendments",
    "attempt_evidence_events",
    "attempt_deadline_jobs",
    "attempt_result_items",
    "attempt_results",
    "result_finalizations",
    "qflow_handoffs",
    "attempt_timeline_events",
    "attempt_policy_commands",
    "attempt_policy_overlays",
    "attempt_entries",
    "access_codes",
    "assignments",
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

async function createAssessmentTestPackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", assessmentTestManifestXml);
  zip.file("assessment.xml", assessmentTestXml);
  zip.file("items/item-1.xml", scoredItemOneXml);
  zip.file("items/item-2.xml", scoredItemTwoXml);
  return zip.generateAsync({ type: "uint8array" });
}

export async function postJson(path: string, body: unknown): Promise<Response> {
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

export async function getJson(path: string): Promise<Response> {
  return workerExports.default.fetch(new Request(`https://harbor.local${path}`));
}

function buildRuntimeEnv(input: {
  send: (message: SubmitFinalizationEnvelope) => Promise<void>;
}): RuntimeEnv {
  const base = getTestEnv();
  return {
    HARBOR_DB: base.HARBOR_DB,
    CONTENT_BUCKET: base.CONTENT_BUCKET,
    BOOTSTRAP_SIGNING_SECRET: base.BOOTSTRAP_SIGNING_SECRET,
    LTI_TOOL_PRIVATE_KEY_JWK: base.LTI_TOOL_PRIVATE_KEY_JWK,
    ATTEMPT_COORDINATOR: base.ATTEMPT_COORDINATOR,
    ATTEMPT_RUNTIME_METRICS: base.ATTEMPT_RUNTIME_METRICS,
    SUBMIT_FINALIZATION_QUEUE: createQueueMock<SubmitFinalizationEnvelope>({
      send: input.send,
      sendBatchError: "sendBatch is not used in history tests",
    }),
  };
}

async function fetchWithRuntimeEnv(
  runtimeEnv: RuntimeEnv,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  return (
    runtimeWorker.fetch as unknown as (
      request: Request,
      env: RuntimeEnv,
      ctx: ExecutionContext,
    ) => Promise<Response>
  )(request, runtimeEnv, ctx);
}

export async function publishFixture(input: {
  tenantId: string;
  assessmentSlug: string;
  packageBytes?: Uint8Array;
}): Promise<{
  assessmentId: string;
  assessmentVersionId: string;
}> {
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/internal/publish?assessmentSlug=${input.assessmentSlug}`, {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": "student-history-package.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (input.packageBytes ?? (await createAssessmentTestPackage())).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

export async function issueAccessCode(assessmentVersionId: string): Promise<string> {
  const response = await postJson("/internal/access-codes", {
    assessmentVersionId,
  });

  expect(response.status).toBe(201);
  const payload = await response.json<{ accessCode: string }>();
  return payload.accessCode;
}

export async function createAssignedAttempt(input: {
  assignmentId: string;
  assessmentVersionId: string;
  learnerId: string;
  displayName: string;
}) {
  const { HARBOR_DB, CONTENT_BUCKET } = getTestEnv();
  const actor: StudentLaunchActor = {
    kind: "student-learner",
    learnerId: input.learnerId,
    sessionId: null,
    id: input.learnerId,
    displayName: input.displayName,
  };

  return createAttemptEntry({
    db: HARBOR_DB,
    bucket: CONTENT_BUCKET,
    assessmentVersionId: input.assessmentVersionId,
    assignmentId: input.assignmentId,
    launch: {
      mode: "institutional-sso",
      actor,
    },
    launchSnapshot: {
      launchMode: "institutional-sso",
      assignmentId: input.assignmentId,
      learnerId: input.learnerId,
      sessionId: null,
      actor,
      launchedAt: new Date().toISOString(),
    },
  });
}

export async function seedAuthoritativeResult(input: {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string;
  totalScore: number;
  maxScore: number;
  submittedAt: string;
}) {
  const { HARBOR_DB } = getTestEnv();
  const finalizationId = `rfinal_${input.attemptId.replaceAll("-", "")}`;

  await HARBOR_DB.batch([
    HARBOR_DB.prepare(
      "INSERT INTO result_finalizations (id, attempt_id, assessment_version_id, assignment_id, source_receipt_id, source_sequence_number, status, materialized_from, submitted_at, finalized_at, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      finalizationId,
      input.attemptId,
      input.assessmentVersionId,
      input.assignmentId,
      `receipt_${input.attemptId}`,
      1,
      "complete",
      "compatibility-submission-summary",
      input.submittedAt,
      input.submittedAt,
      null,
      input.submittedAt,
      input.submittedAt,
    ),
    HARBOR_DB.prepare(
      "INSERT INTO attempt_results (id, attempt_id, result_finalization_id, assessment_version_id, assignment_id, source_receipt_id, status, summary_source, total_score, max_score, passed, test_outcome_variables_json, submitted_at, finalized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      `ares_${input.attemptId.replaceAll("-", "")}`,
      input.attemptId,
      finalizationId,
      input.assessmentVersionId,
      input.assignmentId,
      `receipt_${input.attemptId}`,
      "complete",
      "compatibility-submission-summary",
      input.totalScore,
      input.maxScore,
      null,
      "[]",
      input.submittedAt,
      input.submittedAt,
      input.submittedAt,
      input.submittedAt,
    ),
  ]);
}

export async function launchAccessCodeAttempt(input: {
  accessCode: string;
  actorId: string;
  actorDisplayName: string;
}): Promise<BootstrapPayload> {
  const launch = await postJson("/api/launch/access-code", {
    accessCode: input.accessCode,
    actor: {
      id: input.actorId,
      displayName: input.actorDisplayName,
    },
  });

  expect(launch.status).toBe(201);
  const envelope = await launch.json<BootstrapEnvelope>();
  const bootstrap = await postJson("/api/bootstrap", {
    bootstrapToken: envelope.bootstrapToken,
    clientSessionId: `client_${input.actorId}`,
  });

  expect(bootstrap.status).toBe(200);
  return bootstrap.json<BootstrapPayload>();
}

export async function submitAttempt(input: {
  attemptId: string;
  currentItemRef: BootstrapPayload["session"]["currentItemRef"];
  submissionSummary: AttemptSubmissionSummary;
  sequenceNumber: number;
  clientSessionId: string;
  submissionMaterialization?: Record<string, unknown>;
  captureQueue?: boolean;
}): Promise<{
  receipt: CommitAttemptEventReceipt;
  queuedEnvelope: SubmitFinalizationEnvelope | null;
}> {
  const queued: SubmitFinalizationEnvelope[] = [];
  const body = {
    attemptId: input.attemptId,
    eventId: `evt_submit_${input.sequenceNumber}`,
    idempotencyKey: `idem_submit_${input.sequenceNumber}`,
    sequenceNumber: input.sequenceNumber,
    clientTimestamp: "2026-03-27T12:00:00.000Z",
    clientSessionId: input.clientSessionId,
    itemRef: input.currentItemRef,
    type: "submit.requested",
    payload: {
      requestedAt: "2026-03-27T12:00:00.000Z",
      submissionSummary: input.submissionSummary,
      submissionMaterialization: input.submissionMaterialization,
    },
  };

  const response = input.captureQueue
    ? await (async () => {
        const ctx = createExecutionContext();
        const response = await fetchWithRuntimeEnv(
          buildRuntimeEnv({
            send: async (message) => {
              queued.push(message);
            },
          }),
          new Request(`https://harbor.local/api/attempts/${input.attemptId}/events`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
          ctx,
        );
        await waitOnExecutionContext(ctx);
        return response;
      })()
    : await postJson(`/api/attempts/${input.attemptId}/events`, body);

  expect(response.status).toBe(200);
  return {
    receipt: await response.json<CommitAttemptEventReceipt>(),
    queuedEnvelope: queued[0] ?? null,
  };
}

export async function finalizeQueuedSubmit(envelope: SubmitFinalizationEnvelope): Promise<void> {
  const testEnv = getTestEnv();
  await consumeSubmitFinalizationBatch(
    createMessageBatch(SUBMIT_FINALIZATION_QUEUE_NAME, [
      {
        id: `msg_${envelope.receiptId}`,
        timestamp: new Date(envelope.submittedAt),
        attempts: 1,
        body: envelope,
      },
    ]),
    {
      HARBOR_DB: testEnv.HARBOR_DB,
      CONTENT_BUCKET: testEnv.CONTENT_BUCKET,
      ATTEMPT_COORDINATOR: testEnv.ATTEMPT_COORDINATOR,
      ATTEMPT_RUNTIME_METRICS: testEnv.ATTEMPT_RUNTIME_METRICS,
    },
  );
}

export function buildSubmissionSummary(input: {
  totalScore: number;
  answeredItemCount: number;
}): AttemptSubmissionSummary {
  return {
    itemCount: 2,
    answeredItemCount: input.answeredItemCount,
    scoredItemCount: 2,
    totalScore: input.totalScore,
    maxScore: 2,
    items: [
      {
        itemId: "item-1",
        itemIdentifier: "item-1",
        itemTitle: "President One",
        answered: input.answeredItemCount > 0,
        score: input.totalScore > 0 ? 1 : 0,
        maxScore: 1,
      },
      {
        itemId: "item-2",
        itemIdentifier: "item-2",
        itemTitle: "President Two",
        answered: input.answeredItemCount > 1,
        score: input.totalScore > 1 ? 1 : 0,
        maxScore: 1,
      },
    ],
  };
}
