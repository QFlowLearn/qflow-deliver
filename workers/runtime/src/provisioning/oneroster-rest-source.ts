import type {
  OneRosterV1p2RestSourceRecord,
  ProvisioningSourceRecord,
} from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import { mapProvisioningSourceRow, type ProvisioningSourceRow } from "./provisioning-ledger";

/** Required read-only scopes for the Harbor OneRoster 1.2 Rostering preview. */
export const ONEROSTER_V1P2_ROSTER_SCOPES = [
  "https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly",
  "https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly",
] as const;

/** Server-owned ceilings for one manual OneRoster preview request. */
export const ONEROSTER_V1P2_PREVIEW_LIMITS = Object.freeze({
  pageSize: 500,
  maxPages: 100,
  maxItems: 50_000,
  maxElapsedMilliseconds: 120_000,
  retryMaxAttempts: 4,
  retryMaxElapsedMilliseconds: 30_000,
});

/** Distinct ledger kind for configured OneRoster 1.2 REST sources. */
export const ONEROSTER_REST_V1P2_SOURCE_KIND = "oneroster-rest-v1p2" as const;

/** Persisted non-secret connection and safety policy for a OneRoster REST source. */
export interface OneRosterV1p2RosteringPreviewConfiguration {
  readonly version: "1.2";
  readonly discoveryUrl: string;
  readonly rosteringBaseUrl: string;
  readonly oauth: {
    readonly tokenEndpoint: string;
    readonly clientAuthentication: "client_secret_basic" | "client_secret_post";
    readonly scopes: readonly string[];
  };
  readonly traversal: {
    readonly pageSize: number;
    readonly maxPages: number;
    readonly maxItems: number;
    readonly maxElapsedMilliseconds: number;
  };
  readonly retry: {
    readonly maxAttempts: number;
    readonly maxElapsedMilliseconds: number;
    readonly statusCodes: readonly number[];
    readonly retryConnectionErrors: boolean;
  };
}

/** OAuth client credentials resolved from a tenant-owned secret binding. */
export interface OneRosterV1p2OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Parsed configuration used to create one durable OneRoster 1.2 REST source. */
export interface OneRosterV1p2RestSourceConfiguration {
  readonly sourceName: string;
  readonly credentialBindingId: string;
  readonly configuration: OneRosterV1p2RosteringPreviewConfiguration;
}

/** Durable source plus the private configuration needed by the preview service. */
export interface LoadedOneRosterV1p2RestSource {
  readonly source: ProvisioningSourceRecord;
  readonly configuration: OneRosterV1p2RosteringPreviewConfiguration;
  readonly credentialBindingId: string;
  readonly configurationUpdatedAt: string;
}

interface OneRosterV1p2RestSourceRow extends ProvisioningSourceRow {
  readonly version: string;
  readonly discovery_url: string;
  readonly rostering_base_url: string;
  readonly token_endpoint: string;
  readonly credential_binding_id: string;
  readonly client_authentication: string;
  readonly scopes_json: string;
  readonly page_size: number;
  readonly max_pages: number;
  readonly max_items: number;
  readonly max_elapsed_milliseconds: number;
  readonly retry_max_attempts: number;
  readonly retry_max_elapsed_milliseconds: number;
  readonly retry_status_codes_json: string;
  readonly retry_connection_errors: number;
  readonly configuration_updated_at: string;
}

/** Parse and refine an untrusted source-configuration object. */
export function parseOneRosterV1p2RestSourceConfiguration(
  body: Readonly<Record<string, unknown>>,
): OneRosterV1p2RestSourceConfiguration {
  rejectUnexpectedKeys(body, [
    "sourceName",
    "credentialBindingId",
    "version",
    "discoveryUrl",
    "rosteringBaseUrl",
    "oauth",
    "traversal",
    "retry",
  ]);
  if (body.version !== "1.2") {
    throw new LaunchRequestError(400, "version must explicitly be 1.2");
  }
  const oauth = readRecord(body.oauth, "oauth configuration is required");
  const traversal = readRecord(body.traversal, "traversal bounds are required");
  const retry = readRecord(body.retry, "retry policy is required");
  rejectUnexpectedKeys(oauth, ["tokenEndpoint", "clientAuthentication", "scopes"]);
  rejectUnexpectedKeys(traversal, ["pageSize", "maxPages", "maxItems", "maxElapsedMilliseconds"]);
  rejectUnexpectedKeys(retry, [
    "maxAttempts",
    "maxElapsedMilliseconds",
    "statusCodes",
    "retryConnectionErrors",
  ]);

  const scopes = readRequiredStringArray(oauth.scopes, "oauth.scopes is required");
  for (const requiredScope of ONEROSTER_V1P2_ROSTER_SCOPES) {
    if (!scopes.includes(requiredScope)) {
      throw new LaunchRequestError(400, `oauth.scopes must include ${requiredScope}`);
    }
  }
  if (scopes.some((scope) => !scope.endsWith(".readonly"))) {
    throw new LaunchRequestError(400, "oauth.scopes must contain read-only scopes only");
  }

  const statusCodes = readRequiredPositiveIntegerArray(
    retry.statusCodes,
    "retry.statusCodes is required",
  );
  const eligibleRetryStatuses = new Set([429, 502, 503, 504]);
  if (statusCodes.some((status) => !eligibleRetryStatuses.has(status))) {
    throw new LaunchRequestError(400, "retry.statusCodes contains an ineligible read status");
  }

  const clientAuthentication = readRequiredString(
    oauth.clientAuthentication,
    "oauth.clientAuthentication is required",
  );
  if (
    clientAuthentication !== "client_secret_basic" &&
    clientAuthentication !== "client_secret_post"
  ) {
    throw new LaunchRequestError(400, "oauth.clientAuthentication is invalid");
  }

  return {
    sourceName: readRequiredString(body.sourceName, "sourceName is required"),
    credentialBindingId: readOneRosterCredentialBindingId(body.credentialBindingId),
    configuration: {
      version: "1.2",
      discoveryUrl: readRequiredHttpUrl(body.discoveryUrl, "discoveryUrl is required"),
      rosteringBaseUrl: readRequiredHttpUrl(body.rosteringBaseUrl, "rosteringBaseUrl is required"),
      oauth: {
        tokenEndpoint: readRequiredHttpUrl(oauth.tokenEndpoint, "oauth.tokenEndpoint is required"),
        clientAuthentication,
        scopes,
      },
      traversal: {
        pageSize: readRequiredBoundedPositiveInteger(
          traversal.pageSize,
          "traversal.pageSize",
          ONEROSTER_V1P2_PREVIEW_LIMITS.pageSize,
        ),
        maxPages: readRequiredBoundedPositiveInteger(
          traversal.maxPages,
          "traversal.maxPages",
          ONEROSTER_V1P2_PREVIEW_LIMITS.maxPages,
        ),
        maxItems: readRequiredBoundedPositiveInteger(
          traversal.maxItems,
          "traversal.maxItems",
          ONEROSTER_V1P2_PREVIEW_LIMITS.maxItems,
        ),
        maxElapsedMilliseconds: readRequiredBoundedPositiveInteger(
          traversal.maxElapsedMilliseconds,
          "traversal.maxElapsedMilliseconds",
          ONEROSTER_V1P2_PREVIEW_LIMITS.maxElapsedMilliseconds,
        ),
      },
      retry: {
        maxAttempts: readRequiredBoundedPositiveInteger(
          retry.maxAttempts,
          "retry.maxAttempts",
          ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxAttempts,
        ),
        maxElapsedMilliseconds: readRequiredBoundedPositiveInteger(
          retry.maxElapsedMilliseconds,
          "retry.maxElapsedMilliseconds",
          ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxElapsedMilliseconds,
        ),
        statusCodes,
        retryConnectionErrors: readRequiredBoolean(
          retry.retryConnectionErrors,
          "retry.retryConnectionErrors is required",
        ),
      },
    },
  };
}

/** Persist one configured source after its credential binding has been validated. */
export async function createOneRosterV1p2RestSource(input: {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly sourceConfiguration: OneRosterV1p2RestSourceConfiguration;
}): Promise<OneRosterV1p2RestSourceRecord> {
  const now = new Date().toISOString();
  const sourceId = createSourceId();
  const request = input.sourceConfiguration;
  const source: ProvisioningSourceRecord = {
    id: sourceId,
    tenantId: input.tenantId,
    sourceKind: ONEROSTER_REST_V1P2_SOURCE_KIND,
    sourceKey: sourceId,
    sourceName: request.sourceName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await input.db.batch([
    input.db
      .prepare(
        "INSERT INTO provisioning_sources (id, tenant_id, source_kind, source_key, source_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        source.id,
        source.tenantId,
        source.sourceKind,
        source.sourceKey,
        source.sourceName,
        source.status,
        source.createdAt,
        source.updatedAt,
      ),
    input.db
      .prepare(
        "INSERT INTO oneroster_rest_v1p2_sources (source_id, tenant_id, version, discovery_url, rostering_base_url, token_endpoint, credential_binding_id, client_authentication, scopes_json, page_size, max_pages, max_items, max_elapsed_milliseconds, retry_max_attempts, retry_max_elapsed_milliseconds, retry_status_codes_json, retry_connection_errors, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        source.id,
        source.tenantId,
        request.configuration.version,
        request.configuration.discoveryUrl,
        request.configuration.rosteringBaseUrl,
        request.configuration.oauth.tokenEndpoint,
        request.credentialBindingId,
        request.configuration.oauth.clientAuthentication,
        JSON.stringify(request.configuration.oauth.scopes),
        request.configuration.traversal.pageSize,
        request.configuration.traversal.maxPages,
        request.configuration.traversal.maxItems,
        request.configuration.traversal.maxElapsedMilliseconds,
        request.configuration.retry.maxAttempts,
        request.configuration.retry.maxElapsedMilliseconds,
        JSON.stringify(request.configuration.retry.statusCodes),
        request.configuration.retry.retryConnectionErrors ? 1 : 0,
        now,
        now,
      ),
  ]);

  return {
    source,
    version: request.configuration.version,
    discoveryUrl: request.configuration.discoveryUrl,
    rosteringBaseUrl: request.configuration.rosteringBaseUrl,
    tokenEndpoint: request.configuration.oauth.tokenEndpoint,
    credentialBindingId: request.credentialBindingId,
    clientAuthentication: request.configuration.oauth.clientAuthentication,
    scopes: [...request.configuration.oauth.scopes],
    traversal: { ...request.configuration.traversal },
    retry: {
      ...request.configuration.retry,
      statusCodes: [...request.configuration.retry.statusCodes],
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Load an active OneRoster REST source scoped to one tenant. */
export async function loadOneRosterV1p2RestSource(input: {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly sourceId: string;
}): Promise<LoadedOneRosterV1p2RestSource> {
  const row = await input.db
    .prepare(
      `SELECT
         sources.id,
         sources.tenant_id,
         sources.source_kind,
         sources.source_key,
         sources.source_name,
         sources.status,
         sources.created_at,
         sources.updated_at,
         configuration.version,
         configuration.discovery_url,
         configuration.rostering_base_url,
         configuration.token_endpoint,
         configuration.credential_binding_id,
         configuration.client_authentication,
         configuration.scopes_json,
         configuration.page_size,
         configuration.max_pages,
         configuration.max_items,
         configuration.max_elapsed_milliseconds,
         configuration.retry_max_attempts,
         configuration.retry_max_elapsed_milliseconds,
         configuration.retry_status_codes_json,
         configuration.retry_connection_errors,
         configuration.updated_at AS configuration_updated_at
       FROM provisioning_sources AS sources
       INNER JOIN oneroster_rest_v1p2_sources AS configuration
         ON configuration.source_id = sources.id
       WHERE sources.id = ?
         AND sources.tenant_id = ?
         AND sources.source_kind = ?
         AND sources.status = 'active'`,
    )
    .bind(input.sourceId, input.tenantId, ONEROSTER_REST_V1P2_SOURCE_KIND)
    .first<OneRosterV1p2RestSourceRow>();
  if (!row) throw new LaunchRequestError(404, "OneRoster REST source was not found");

  return parseStoredOneRosterV1p2RestSource(row);
}

/** Resolve tenant-owned OAuth credentials from a named Worker secret binding. */
export function readOneRosterCredentialBinding(input: {
  readonly bindings: unknown;
  readonly bindingId: string;
  readonly tenantId: string;
}): OneRosterV1p2OAuthClientCredentials {
  if (!/^ONEROSTER_[A-Z0-9_]+$/.test(input.bindingId)) {
    throw new LaunchRequestError(503, "Configured OneRoster credential binding is invalid");
  }
  // SAFETY: Worker bindings are runtime-keyed properties; the configured binding name is parsed first.
  const bindings = input.bindings as Readonly<Record<string, unknown>>;
  const raw = bindings[input.bindingId];
  if (typeof raw !== "string") {
    throw new LaunchRequestError(503, "Configured OneRoster credential binding is unavailable");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new LaunchRequestError(503, "Configured OneRoster credential binding is invalid");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new LaunchRequestError(503, "Configured OneRoster credential binding is invalid");
  }
  // SAFETY: decoded is a non-null plain object; every consumed property remains unknown below.
  const credential = decoded as Record<string, unknown>;
  if (
    credential.tenantId !== input.tenantId ||
    typeof credential.clientId !== "string" ||
    credential.clientId.trim() === "" ||
    typeof credential.clientSecret !== "string" ||
    credential.clientSecret === ""
  ) {
    throw new LaunchRequestError(503, "Configured OneRoster credential binding is invalid");
  }
  return {
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  };
}

function parseStoredOneRosterV1p2RestSource(
  row: OneRosterV1p2RestSourceRow,
): LoadedOneRosterV1p2RestSource {
  if (
    row.version !== "1.2" ||
    (row.client_authentication !== "client_secret_basic" &&
      row.client_authentication !== "client_secret_post") ||
    (row.retry_connection_errors !== 0 && row.retry_connection_errors !== 1)
  ) {
    throw invalidStoredSource();
  }
  const scopes = parseStoredStringArray(row.scopes_json);
  if (
    ONEROSTER_V1P2_ROSTER_SCOPES.some((requiredScope) => !scopes.includes(requiredScope)) ||
    scopes.some((scope) => !scope.endsWith(".readonly"))
  ) {
    throw invalidStoredSource();
  }
  const retryStatusCodes = parseStoredPositiveIntegerArray(row.retry_status_codes_json);
  if (retryStatusCodes.some((status) => ![429, 502, 503, 504].includes(status))) {
    throw invalidStoredSource();
  }
  if (!/^ONEROSTER_[A-Z0-9_]+$/.test(row.credential_binding_id)) {
    throw invalidStoredSource();
  }
  const configuration: OneRosterV1p2RosteringPreviewConfiguration = {
    version: "1.2",
    discoveryUrl: parseStoredHttpUrl(row.discovery_url),
    rosteringBaseUrl: parseStoredHttpUrl(row.rostering_base_url),
    oauth: {
      tokenEndpoint: parseStoredHttpUrl(row.token_endpoint),
      clientAuthentication: row.client_authentication,
      scopes,
    },
    traversal: {
      pageSize: parseStoredBound(row.page_size, ONEROSTER_V1P2_PREVIEW_LIMITS.pageSize),
      maxPages: parseStoredBound(row.max_pages, ONEROSTER_V1P2_PREVIEW_LIMITS.maxPages),
      maxItems: parseStoredBound(row.max_items, ONEROSTER_V1P2_PREVIEW_LIMITS.maxItems),
      maxElapsedMilliseconds: parseStoredBound(
        row.max_elapsed_milliseconds,
        ONEROSTER_V1P2_PREVIEW_LIMITS.maxElapsedMilliseconds,
      ),
    },
    retry: {
      maxAttempts: parseStoredBound(
        row.retry_max_attempts,
        ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxAttempts,
      ),
      maxElapsedMilliseconds: parseStoredBound(
        row.retry_max_elapsed_milliseconds,
        ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxElapsedMilliseconds,
      ),
      statusCodes: retryStatusCodes,
      retryConnectionErrors: row.retry_connection_errors === 1,
    },
  };
  return {
    source: mapProvisioningSourceRow(row),
    configuration,
    credentialBindingId: row.credential_binding_id,
    configurationUpdatedAt: row.configuration_updated_at,
  };
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, message);
  }
  // SAFETY: the value is a non-null, non-array object; fields remain unknown for concrete parsing.
  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LaunchRequestError(400, message);
  }
  return value.trim();
}

function readRequiredStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new LaunchRequestError(400, message);
  return value.map((entry) => readRequiredString(entry, message));
}

function readRequiredPositiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new LaunchRequestError(400, message);
  }
  return value;
}

function readRequiredPositiveIntegerArray(value: unknown, message: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new LaunchRequestError(400, message);
  return value.map((entry) => readRequiredPositiveInteger(entry, message));
}

function readRequiredBoundedPositiveInteger(
  value: unknown,
  label: string,
  ceiling: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
    throw new LaunchRequestError(
      400,
      `${label} must be a positive integer no greater than ${ceiling}`,
    );
  }
  return value;
}

function readRequiredBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw new LaunchRequestError(400, message);
  return value;
}

function readRequiredHttpUrl(value: unknown, message: string): string {
  const raw = readRequiredString(value, message);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LaunchRequestError(400, message);
  }
  if (url.protocol !== "https:") throw new LaunchRequestError(400, message);
  return url.toString().replace(/\/$/, "");
}

function readOneRosterCredentialBindingId(value: unknown): string {
  const bindingId = readRequiredString(value, "credentialBindingId is required");
  if (!/^ONEROSTER_[A-Z0-9_]+$/.test(bindingId)) {
    throw new LaunchRequestError(
      400,
      "credentialBindingId must name an ONEROSTER_ Worker secret binding",
    );
  }
  return bindingId;
}

function rejectUnexpectedKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new LaunchRequestError(400, "Request contains unsupported fields");
  }
}

function parseStoredHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw invalidStoredSource();
    return url.toString().replace(/\/$/, "");
  } catch (cause: unknown) {
    if (cause instanceof LaunchRequestError) throw cause;
    throw invalidStoredSource();
  }
}

function parseStoredBound(value: number, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw invalidStoredSource();
  return value;
}

function parseStoredStringArray(value: string): string[] {
  const decoded = parseStoredJson(value);
  if (!Array.isArray(decoded) || decoded.length === 0) throw invalidStoredSource();
  const parsed: string[] = [];
  for (const entry of decoded) {
    if (typeof entry !== "string" || entry === "") throw invalidStoredSource();
    parsed.push(entry);
  }
  return parsed;
}

function parseStoredPositiveIntegerArray(value: string): number[] {
  const decoded = parseStoredJson(value);
  if (!Array.isArray(decoded) || decoded.length === 0) throw invalidStoredSource();
  const parsed: number[] = [];
  for (const entry of decoded) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      throw invalidStoredSource();
    }
    parsed.push(entry);
  }
  return parsed;
}

function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw invalidStoredSource();
  }
}

function invalidStoredSource(): LaunchRequestError {
  return new LaunchRequestError(500, "Stored OneRoster source configuration is invalid");
}

function createSourceId(): string {
  return `psrc_${crypto.randomUUID().replaceAll("-", "")}`;
}
