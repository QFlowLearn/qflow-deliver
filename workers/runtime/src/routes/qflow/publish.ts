import type { QflowPublishRequest, QflowPublishResponse } from "@harbor/attempt-protocol";
import type { ImportValidationReport } from "@harbor/content-model";

import { LaunchRequestError } from "../../launch/create-preview-attempt";
import { importQtiPackage, type PublishResult } from "../../publish/import-qti-package";
import { readAssessmentVersionValidationReport } from "../../publish/qti-validation-read";
import { requireSignedQflowRequest } from "./signature";
import type { AppContext } from "../hono-utils";
import { requestUrl } from "../hono-utils";

const QFLOW_PUBLISH_FEATURE_KEY = "qflow_publish";

interface QflowPublishEnv {
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  QFLOW_HANDOFF_SECRET?: string;
  QFLOW_RUNNER_KEY?: string;
  QFLOW_PACKAGE_ORIGIN?: string;
}

interface QflowPublishRow {
  id: string;
  tenant_id: string;
  qflow_tenant_id: string;
  qflow_assessment_id: string;
  package_url: string;
  export_format: "qti3";
  export_warnings_json: string;
  request_sha256: string;
  package_sha256: string;
  package_size_bytes: number;
  package_content_type: string | null;
  assessment_id: string;
  assessment_version_id: string;
  status: "published";
}

interface AssessmentVersionRow {
  id: string;
  assessment_id: string;
  package_object_key: string;
  manifest_object_key: string;
  source_package_sha256: string;
}

interface FetchedPackage {
  bytes: Uint8Array;
  sha256: string;
  contentType: string | null;
  exportWarnings: unknown[];
}

interface PublishedVersionPayload {
  assessmentId: string;
  assessmentVersionId: string;
  packageObjectKey: string;
  manifestObjectKey: string;
  validation: ImportValidationReport;
}

interface QflowTenantSubscription {
  tenantId: string;
}

type PackageFetcher = typeof fetch;

export async function handleQflowPublishRequest(c: AppContext): Promise<Response> {
  return qflowPublish({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function qflowPublish(input: {
  request: Request;
  env: QflowPublishEnv;
  url: URL;
  packageFetcher?: PackageFetcher;
}): Promise<Response> {
  const { request, env, url, packageFetcher = fetch.bind(globalThis) } = input;
  const rawBody = await request.text();
  await requireSignedQflowRequest({ request, env, rawBody });
  const intent = parsePublishRequest(rawBody);
  const requestSha256 = await sha256Text(rawBody);
  const existingPublish = await readQflowPublish(env.HARBOR_DB, intent.publishId);

  if (existingPublish) {
    return await buildExistingPublishResponse({
      db: env.HARBOR_DB,
      requestUrl: url,
      intent,
      requestSha256,
      existing: existingPublish,
    });
  }

  const subscription = await resolveQflowTenantSubscription({
    db: env.HARBOR_DB,
    qflowTenantId: intent.qflowTenantId,
  });

  await requireTenantQflowPublishEntitlement({
    db: env.HARBOR_DB,
    tenantId: subscription.tenantId,
  });

  const fetchedPackage = await fetchQflowPackage({
    env,
    intent,
    fetcher: packageFetcher,
  });
  const packageName = sanitizePackageName(
    intent.packageName ?? packageNameFromUrl(intent.packageUrl),
  );
  const assessmentSlug =
    sanitizeOptionalSlug(intent.assessmentSlug) ??
    buildDefaultAssessmentSlug(intent.qflowAssessmentId);
  const result = await importQtiPackage({
    tenantId: subscription.tenantId,
    assessmentSlug,
    packageName,
    packageBytes: fetchedPackage.bytes,
    db: env.HARBOR_DB,
    bucket: env.CONTENT_BUCKET,
  });
  const exportWarnings = mergeExportWarnings(intent.exportWarnings, fetchedPackage.exportWarnings);

  await recordQflowPublish({
    db: env.HARBOR_DB,
    intent,
    tenantId: subscription.tenantId,
    assessmentSlug,
    packageName,
    fetchedPackage,
    result,
    requestSha256,
    payloadJson: rawBody,
    exportWarnings,
  });
  await upsertQflowMapping({
    db: env.HARBOR_DB,
    intent,
    tenantId: subscription.tenantId,
    result,
    publishId: intent.publishId,
  });

  return Response.json(
    buildPublishResponse({
      requestUrl: url,
      intent,
      result,
      packageSha256: fetchedPackage.sha256,
      packageSizeBytes: fetchedPackage.bytes.byteLength,
      packageContentType: fetchedPackage.contentType,
      exportWarnings,
    }),
    { status: 201 },
  );
}

async function resolveQflowTenantSubscription(input: {
  db: D1Database;
  qflowTenantId: string;
}): Promise<QflowTenantSubscription> {
  const now = new Date().toISOString();
  const row = await input.db
    .prepare(
      "SELECT tenant_id FROM qflow_tenant_links WHERE qflow_tenant_id = ? AND status = ? AND effective_at <= ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
    )
    .bind(input.qflowTenantId, "active", now, now)
    .first<{ tenant_id: string }>();

  if (!row) {
    throw new LaunchRequestError(
      403,
      "QFlow tenant is not linked to an active QFlowLearn Delivery subscription",
    );
  }

  return {
    tenantId: row.tenant_id,
  };
}

async function requireTenantQflowPublishEntitlement(input: {
  db: D1Database;
  tenantId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const entitlement = await input.db
    .prepare(
      "SELECT id FROM tenant_feature_entitlements WHERE tenant_id = ? AND feature_key = ? AND status = ? AND effective_at <= ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
    )
    .bind(input.tenantId, QFLOW_PUBLISH_FEATURE_KEY, "active", now, now)
    .first<{ id: string }>();

  if (!entitlement) {
    throw new LaunchRequestError(
      403,
      "QFlowLearn Delivery tenant is not entitled to QFlow publish",
    );
  }
}

async function fetchQflowPackage(input: {
  env: QflowPublishEnv;
  intent: QflowPublishRequest;
  fetcher: PackageFetcher;
}): Promise<FetchedPackage> {
  const runnerKey = readRunnerKey(input.env);
  const packageUrl = readPackageUrl(input.intent.packageUrl, input.env);
  const response = await input.fetcher(
    new Request(packageUrl, {
      method: "GET",
      headers: {
        accept: "application/zip",
        "x-runner-key": runnerKey,
      },
    }),
  );

  if (!response.ok) {
    throw new LaunchRequestError(502, `QFlow package fetch failed with status ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new LaunchRequestError(502, "QFlow package fetch returned an empty body");
  }

  return {
    bytes,
    sha256: await sha256Bytes(bytes),
    contentType: response.headers.get("content-type"),
    exportWarnings: readQflowExportWarningHeaders(response.headers),
  };
}

function readRunnerKey(env: QflowPublishEnv): string {
  const runnerKey = env.QFLOW_RUNNER_KEY?.trim();
  if (!runnerKey) {
    throw new LaunchRequestError(500, "QFLOW_RUNNER_KEY is not configured");
  }

  return runnerKey;
}

function readPackageUrl(rawPackageUrl: string, env: QflowPublishEnv): string {
  let packageUrl: URL;
  try {
    packageUrl = new URL(rawPackageUrl);
  } catch {
    throw new LaunchRequestError(400, "packageUrl must be an absolute URL");
  }

  if (packageUrl.protocol !== "https:" && packageUrl.protocol !== "http:") {
    throw new LaunchRequestError(400, "packageUrl must use http or https");
  }

  const allowedOrigin = env.QFLOW_PACKAGE_ORIGIN?.trim();
  if (allowedOrigin) {
    let expected: URL;
    try {
      expected = new URL(allowedOrigin);
    } catch {
      throw new LaunchRequestError(500, "QFLOW_PACKAGE_ORIGIN is not a valid URL");
    }

    if (packageUrl.origin !== expected.origin) {
      throw new LaunchRequestError(403, "packageUrl origin is not allowed for qflow publish");
    }
  }

  return packageUrl.toString();
}

async function buildExistingPublishResponse(input: {
  db: D1Database;
  requestUrl: URL;
  intent: QflowPublishRequest;
  requestSha256: string;
  existing: QflowPublishRow;
}): Promise<Response> {
  if (input.existing.request_sha256 !== input.requestSha256) {
    throw new LaunchRequestError(
      409,
      "QFlow publishId has already been used for a different signed request",
    );
  }

  const version = await readAssessmentVersion(input.db, input.existing.assessment_version_id);

  return Response.json(
    buildPublishResponse({
      requestUrl: input.requestUrl,
      intent: {
        ...input.intent,
        exportWarnings: parseJsonArray(input.existing.export_warnings_json),
      },
      result: {
        assessmentId: version.assessment_id,
        assessmentVersionId: version.id,
        packageObjectKey: version.package_object_key,
        manifestObjectKey: version.manifest_object_key,
        validation: await readAssessmentVersionValidationReport(input.db, version.id),
      },
      packageSha256: input.existing.package_sha256,
      packageSizeBytes: input.existing.package_size_bytes,
      packageContentType: input.existing.package_content_type,
      exportWarnings: parseJsonArray(input.existing.export_warnings_json),
    }),
    { status: 200 },
  );
}

function buildPublishResponse(input: {
  requestUrl: URL;
  intent: QflowPublishRequest;
  result: PublishedVersionPayload;
  packageSha256: string;
  packageSizeBytes: number;
  packageContentType: string | null;
  exportWarnings: unknown[];
}): QflowPublishResponse {
  return {
    publishId: input.intent.publishId,
    status: "published",
    source: {
      qflowTenantId: input.intent.qflowTenantId,
      qflowAssessmentId: input.intent.qflowAssessmentId,
      packageUrl: input.intent.packageUrl,
      exportFormat: "qti3",
      exportWarnings: input.exportWarnings,
    },
    version: {
      assessmentId: input.result.assessmentId,
      assessmentVersionId: input.result.assessmentVersionId,
      packageObjectKey: input.result.packageObjectKey,
      manifestObjectKey: input.result.manifestObjectKey,
      sourcePackageSha256: input.packageSha256,
    },
    links: {
      previewUrl: buildPreviewUrl(input.requestUrl, input.result.assessmentVersionId),
      adminUrl: buildAdminUrl(input.requestUrl, input.result.assessmentVersionId),
    },
    fetchedPackage: {
      sizeBytes: input.packageSizeBytes,
      sha256: input.packageSha256,
      contentType: input.packageContentType,
    },
    validation: input.result.validation,
  };
}

async function recordQflowPublish(input: {
  db: D1Database;
  intent: QflowPublishRequest;
  tenantId: string;
  assessmentSlug: string;
  packageName: string;
  fetchedPackage: FetchedPackage;
  result: PublishResult;
  requestSha256: string;
  payloadJson: string;
  exportWarnings: unknown[];
}): Promise<void> {
  const now = new Date().toISOString();

  try {
    await input.db
      .prepare(
        "INSERT INTO qflow_publish_requests (id, tenant_id, qflow_tenant_id, qflow_assessment_id, assessment_slug, package_url, package_name, export_format, export_warnings_json, request_sha256, package_sha256, package_size_bytes, package_content_type, assessment_id, assessment_version_id, status, payload_json, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.intent.publishId,
        input.tenantId,
        input.intent.qflowTenantId,
        input.intent.qflowAssessmentId,
        input.assessmentSlug,
        input.intent.packageUrl,
        input.packageName,
        "qti3",
        JSON.stringify(input.exportWarnings),
        input.requestSha256,
        input.fetchedPackage.sha256,
        input.fetchedPackage.bytes.byteLength,
        input.fetchedPackage.contentType,
        input.result.assessmentId,
        input.result.assessmentVersionId,
        "published",
        input.payloadJson,
        now,
        now,
        now,
      )
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await readQflowPublish(input.db, input.intent.publishId);
      if (existing?.request_sha256 === input.requestSha256) {
        return;
      }
      throw new LaunchRequestError(
        409,
        "QFlow publishId has already been used for a different signed request",
      );
    }

    throw error;
  }
}

async function upsertQflowMapping(input: {
  db: D1Database;
  intent: QflowPublishRequest;
  tenantId: string;
  result: PublishResult;
  publishId: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const mappingId = `qflowmap_${crypto.randomUUID().replaceAll("-", "")}`;

  await input.db
    .prepare(
      "INSERT INTO qflow_assessment_mappings (id, tenant_id, qflow_tenant_id, qflow_assessment_id, assessment_id, latest_assessment_version_id, latest_publish_request_id, package_url, export_format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, qflow_tenant_id, qflow_assessment_id) DO UPDATE SET assessment_id = excluded.assessment_id, latest_assessment_version_id = excluded.latest_assessment_version_id, latest_publish_request_id = excluded.latest_publish_request_id, package_url = excluded.package_url, export_format = excluded.export_format, updated_at = excluded.updated_at",
    )
    .bind(
      mappingId,
      input.tenantId,
      input.intent.qflowTenantId,
      input.intent.qflowAssessmentId,
      input.result.assessmentId,
      input.result.assessmentVersionId,
      input.publishId,
      input.intent.packageUrl,
      "qti3",
      now,
      now,
    )
    .run();
}

async function readQflowPublish(
  db: D1Database,
  publishId: string,
): Promise<QflowPublishRow | null> {
  return (
    (await db
      .prepare(
        "SELECT id, tenant_id, qflow_tenant_id, qflow_assessment_id, package_url, export_format, export_warnings_json, request_sha256, package_sha256, package_size_bytes, package_content_type, assessment_id, assessment_version_id, status FROM qflow_publish_requests WHERE id = ?",
      )
      .bind(publishId)
      .first<QflowPublishRow>()) ?? null
  );
}

async function readAssessmentVersion(
  db: D1Database,
  assessmentVersionId: string,
): Promise<AssessmentVersionRow> {
  const row = await db
    .prepare(
      "SELECT id, assessment_id, package_object_key, manifest_object_key, source_package_sha256 FROM assessment_versions WHERE id = ?",
    )
    .bind(assessmentVersionId)
    .first<AssessmentVersionRow>();

  if (!row) {
    throw new LaunchRequestError(404, "Published QFlowLearn Delivery assessment version not found");
  }

  return row;
}

function parsePublishRequest(rawBody: string): QflowPublishRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new LaunchRequestError(400, "Request body must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LaunchRequestError(400, "Request body must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;
  const exportFormat = readOptionalString(body.exportFormat) ?? "qti3";
  if (exportFormat !== "qti3") {
    throw new LaunchRequestError(400, "exportFormat must be qti3");
  }

  return {
    publishId: readRequiredString(body.publishId, "publishId is required"),
    qflowTenantId: readRequiredString(body.qflowTenantId, "qflowTenantId is required"),
    qflowAssessmentId: readRequiredString(body.qflowAssessmentId, "qflowAssessmentId is required"),
    packageUrl: readRequiredString(body.packageUrl, "packageUrl is required"),
    assessmentSlug: readOptionalString(body.assessmentSlug),
    packageName: readOptionalString(body.packageName),
    exportFormat,
    exportWarnings: readOptionalArray(body.exportWarnings),
    actorId: readOptionalString(body.actorId),
    actorDisplayName: readOptionalString(body.actorDisplayName),
    issuedAt: readOptionalString(body.issuedAt),
  };
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(400, message);
  }

  return value.trim();
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new LaunchRequestError(400, "Optional string value must be a string");
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionalArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new LaunchRequestError(400, "exportWarnings must be an array");
  }

  return value;
}

function readQflowExportWarningHeaders(headers: Headers): unknown[] {
  const count = headers.get("x-qflow-export-warning-count");
  const codes = headers.get("x-qflow-export-warning-codes");
  if (!count && !codes) {
    return [];
  }

  return [
    {
      source: "qflow-export-headers",
      count: count ? Number(count) : null,
      codes: codes
        ? codes
            .split(",")
            .map((code) => code.trim())
            .filter(Boolean)
        : [],
    },
  ];
}

function mergeExportWarnings(
  requestWarnings: unknown[] | null | undefined,
  headerWarnings: unknown[],
): unknown[] {
  return [...(requestWarnings ?? []), ...headerWarnings];
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildPreviewUrl(requestUrl: URL, assessmentVersionId: string): string {
  const previewUrl = new URL("/session", requestUrl.origin);
  previewUrl.searchParams.set("mode", "preview");
  previewUrl.searchParams.set("assessmentVersionId", assessmentVersionId);
  previewUrl.searchParams.set("previewActorId", "qflow_preview");
  previewUrl.searchParams.set("previewActorDisplayName", "QFlow Preview");
  return previewUrl.toString();
}

function buildAdminUrl(requestUrl: URL, assessmentVersionId: string): string {
  const adminUrl = new URL("/assessments", requestUrl.origin);
  adminUrl.searchParams.set("assessmentVersionId", assessmentVersionId);
  return adminUrl.toString();
}

function sanitizeOptionalSlug(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const slug = slugify(value);
  return slug || null;
}

function buildDefaultAssessmentSlug(qflowAssessmentId: string): string {
  return `qflow-${slugify(qflowAssessmentId) || "assessment"}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizePackageName(value: string | null): string {
  if (!value) {
    return "qflow-assessment.zip";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "qflow-assessment.zip";
  }

  return trimmed.split("/").at(-1) ?? "qflow-assessment.zip";
}

function packageNameFromUrl(value: string): string | null {
  try {
    const packageUrl = new URL(value);
    const name = packageUrl.pathname.split("/").filter(Boolean).at(-1);
    return name ? `${name}.zip` : null;
  } catch {
    return null;
  }
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed|constraint failed/i.test(error.message)
  );
}
