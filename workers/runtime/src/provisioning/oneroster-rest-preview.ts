import type {
  OneRosterV1p2AcademicSession,
  OneRosterV1p2Class,
  OneRosterV1p2Course,
  OneRosterV1p2Enrollment,
  OneRosterV1p2Fetch,
  OneRosterV1p2Org,
  OneRosterV1p2Page,
  OneRosterV1p2RestError,
  OneRosterV1p2RosteringClient,
  OneRosterV1p2User,
} from "@longsightgroup/oneroster/v1p2";
import {
  checkOneRosterV1p2DiscoveryCapabilities,
  createOneRosterV1p2EqualsFilter,
  createOneRosterV1p2OAuth2ClientCredentialsProvider,
  createOneRosterV1p2RosteringClient,
  readOneRosterV1p2Discovery,
} from "@longsightgroup/oneroster/v1p2";
import type {
  AssignmentActorSnapshot,
  OneRosterV1p2PreviewDiagnostic,
  OneRosterV1p2PreviewEntityCount,
  OneRosterV1p2RosteringPreviewResponse,
  OneRosterV1p2RosteringEntityKind,
  RosterProvisioningSummary,
} from "@harbor/attempt-protocol";
import {
  loadOneRosterV1p2RestSource,
  ONEROSTER_V1P2_PREVIEW_LIMITS,
  ONEROSTER_V1P2_ROSTER_SCOPES,
  type OneRosterV1p2OAuthClientCredentials,
  type OneRosterV1p2RosteringPreviewConfiguration,
} from "./oneroster-rest-source";
import { createProvisioningRun, persistProvisioningRunErrors } from "./provisioning-ledger";

export {
  ONEROSTER_V1P2_PREVIEW_LIMITS,
  ONEROSTER_V1P2_ROSTER_SCOPES,
  type OneRosterV1p2OAuthClientCredentials,
  type OneRosterV1p2RosteringPreviewConfiguration,
} from "./oneroster-rest-source";

const REQUIRED_OPERATION_IDS = [
  "getAllOrgs",
  "getAllAcademicSessions",
  "getAllCourses",
  "getAllClasses",
  "getAllUsers",
  "getAllEnrollments",
] as const;

/** Safe counts and diagnostics produced without applying roster changes. */
export interface OneRosterV1p2RosteringPreviewResult {
  readonly counts: Record<OneRosterV1p2RosteringEntityKind, OneRosterV1p2PreviewEntityCount>;
  readonly diagnostics: OneRosterV1p2PreviewDiagnostic[];
}

/** Narrow configured-preview capability injected at application composition. */
export interface OneRosterPreviewService {
  preview(input: {
    readonly db: D1Database;
    readonly tenantId: string;
    readonly sourceId: string;
    readonly actor: AssignmentActorSnapshot;
    readonly statusFilter?: "active" | "inactive";
    readonly resolveCredentials: (bindingId: string) => OneRosterV1p2OAuthClientCredentials;
    readonly signal: AbortSignal;
  }): Promise<OneRosterV1p2RosteringPreviewResponse>;
}

/** Create the configured-preview service with one explicit external fetch seam. */
export function createOneRosterPreview(input: {
  readonly fetcher: OneRosterV1p2Fetch;
}): OneRosterPreviewService {
  return {
    preview: (command) =>
      previewConfiguredOneRosterV1p2RestSource({
        ...command,
        fetch: input.fetcher,
      }),
  };
}

/** Preview one configured tenant source and record its dry-run ledger evidence. */
async function previewConfiguredOneRosterV1p2RestSource(input: {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly actor: AssignmentActorSnapshot;
  readonly statusFilter?: "active" | "inactive";
  readonly resolveCredentials: (bindingId: string) => OneRosterV1p2OAuthClientCredentials;
  readonly fetch: OneRosterV1p2Fetch;
  readonly signal: AbortSignal;
}): Promise<OneRosterV1p2RosteringPreviewResponse> {
  const configuredSource = await loadOneRosterV1p2RestSource({
    db: input.db,
    tenantId: input.tenantId,
    sourceId: input.sourceId,
  });
  const credentials = input.resolveCredentials(configuredSource.credentialBindingId);
  const preview = await runOneRosterV1p2RosteringPreview({
    configuration: configuredSource.configuration,
    credentials,
    ...(input.statusFilter === undefined ? {} : { statusFilter: input.statusFilter }),
    fetch: input.fetch,
    signal: input.signal,
  });
  const summary = summarizePreview(preview);
  const errorCount = preview.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const run = await createProvisioningRun({
    db: input.db,
    source: configuredSource.source,
    mode: "dry-run",
    status: errorCount === 0 ? "previewed" : "failed",
    actor: input.actor,
    inputSha256: await fingerprintConfiguredPreview({
      sourceId: configuredSource.source.id,
      configurationUpdatedAt: configuredSource.configurationUpdatedAt,
      statusFilter: input.statusFilter,
    }),
    summary,
  });
  await persistProvisioningRunErrors({
    db: input.db,
    runId: run.id,
    errors: preview.diagnostics.map((diagnostic) => ({
      rowNumber: null,
      field: diagnostic.entityKind ?? null,
      code: diagnostic.code,
      message: diagnostic.message,
      rawRow: null,
    })),
  });
  return {
    source: configuredSource.source,
    run,
    counts: preview.counts,
    diagnostics: preview.diagnostics,
  };
}

function summarizePreview(preview: OneRosterV1p2RosteringPreviewResult): RosterProvisioningSummary {
  const rowCount = Object.values(preview.counts).reduce(
    (total, count) => total + count.received,
    0,
  );
  const validRowCount = Object.values(preview.counts).reduce(
    (total, count) => total + count.unique,
    0,
  );
  return {
    rowCount,
    validRowCount,
    invalidRowCount: preview.diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .length,
    learnerCreateCount: 0,
    learnerUpdateCount: 0,
    sectionCreateCount: 0,
    sectionUpdateCount: 0,
    membershipCreateCount: 0,
    membershipReactivateCount: 0,
    membershipDeactivateCount: 0,
    membershipUnchangedCount: 0,
    oneRosterRestCounts: preview.counts,
  };
}

async function fingerprintConfiguredPreview(input: {
  readonly sourceId: string;
  readonly configurationUpdatedAt: string;
  readonly statusFilter?: "active" | "inactive";
}): Promise<string> {
  const value = JSON.stringify({
    sourceId: input.sourceId,
    configurationUpdatedAt: input.configurationUpdatedAt,
    statusFilter: input.statusFilter ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type RosterEntity =
  | OneRosterV1p2Org
  | OneRosterV1p2AcademicSession
  | OneRosterV1p2Course
  | OneRosterV1p2Class
  | OneRosterV1p2User
  | OneRosterV1p2Enrollment;

interface PreviewBudget {
  pagesRemaining: number;
  itemsRemaining: number;
}

interface ReferenceIndexes {
  readonly organizations: Set<string>;
  readonly academicSessions: Set<string>;
  readonly courses: Set<string>;
  readonly classes: Set<string>;
  readonly users: Set<string>;
}

type PageStream<TEntity> = AsyncIterable<
  | { readonly _tag: "ok"; readonly value: OneRosterV1p2Page<TEntity> }
  | { readonly _tag: "err"; readonly error: OneRosterV1p2RestError }
>;

type StreamOutcome = "continue" | "stop";

interface EntityStreamInput<TEntity extends RosterEntity> {
  readonly entityKind: OneRosterV1p2RosteringEntityKind;
  readonly operationId: string;
  readonly pages: PageStream<TEntity>;
  readonly seen: Set<string>;
  readonly accept: (entity: TEntity) => void;
  readonly budget: PreviewBudget;
  readonly counts: Record<OneRosterV1p2RosteringEntityKind, OneRosterV1p2PreviewEntityCount>;
  readonly diagnostics: OneRosterV1p2PreviewDiagnostic[];
}

/** Fetch and safely summarize the read-only OneRoster 1.2 Rostering profile. */
export async function runOneRosterV1p2RosteringPreview(input: {
  readonly configuration: OneRosterV1p2RosteringPreviewConfiguration;
  readonly credentials: OneRosterV1p2OAuthClientCredentials;
  readonly statusFilter?: "active" | "inactive";
  readonly fetch: OneRosterV1p2Fetch;
  readonly signal: AbortSignal;
}): Promise<OneRosterV1p2RosteringPreviewResult> {
  const counts = emptyCounts();
  const diagnostics: OneRosterV1p2PreviewDiagnostic[] = [];
  const budget = createPreviewBudget(input.configuration);
  if (budget._tag === "err") {
    diagnostics.push(configurationDiagnostic(budget.code));
    return { counts, diagnostics };
  }
  const bounded = createBoundedSignal(
    input.signal,
    input.configuration.traversal.maxElapsedMilliseconds,
  );

  try {
    const discovery = await readOneRosterV1p2Discovery({
      discoveryUrl: input.configuration.discoveryUrl,
      service: "rostering",
      fetch: input.fetch,
      signal: bounded.signal,
    });
    if (discovery._tag === "err") {
      diagnostics.push({
        severity: "error",
        code: `oneroster.rest.discovery.${discovery.error.code}`,
        message: "OneRoster 1.2 Rostering discovery failed.",
        status: discovery.error.status,
      });
      return { counts, diagnostics };
    }

    const configuredUrl = normalizeUrl(input.configuration.rosteringBaseUrl);
    const discoveredUrls = discovery.value.serverBaseUrls.map(normalizeUrl);
    if (!discoveredUrls.includes(configuredUrl)) {
      diagnostics.push(configurationDiagnostic("discovery_server_mismatch"));
      return { counts, diagnostics };
    }
    if (
      normalizeUrl(discovery.value.tokenEndpoint) !==
      normalizeUrl(input.configuration.oauth.tokenEndpoint)
    ) {
      diagnostics.push(configurationDiagnostic("discovery_token_endpoint_mismatch"));
      return { counts, diagnostics };
    }

    const gaps = checkOneRosterV1p2DiscoveryCapabilities(
      discovery.value,
      [...REQUIRED_OPERATION_IDS],
      [...ONEROSTER_V1P2_ROSTER_SCOPES],
    );
    if (gaps.missingOperationIds.length > 0 || gaps.missingScopes.length > 0) {
      diagnostics.push(configurationDiagnostic("discovery_capability_gap"));
      return { counts, diagnostics };
    }

    const tokenProvider = createOneRosterV1p2OAuth2ClientCredentialsProvider({
      tokenEndpoint: input.configuration.oauth.tokenEndpoint,
      clientId: input.credentials.clientId,
      clientSecret: input.credentials.clientSecret,
      clientAuthentication: input.configuration.oauth.clientAuthentication,
      scopes: input.configuration.oauth.scopes,
      fetch: input.fetch,
    });
    if (tokenProvider._tag === "err") {
      diagnostics.push(configurationDiagnostic("oauth_configuration_invalid"));
      return { counts, diagnostics };
    }

    const client = createOneRosterV1p2RosteringClient({
      serviceBaseUrls: { rostering: input.configuration.rosteringBaseUrl },
      accessTokenProvider: tokenProvider.value,
      fetch: input.fetch,
      retryPolicy: input.configuration.retry,
    });
    if (client._tag === "err") {
      diagnostics.push(configurationDiagnostic(client.error.code));
      return { counts, diagnostics };
    }

    const filter = input.statusFilter
      ? createOneRosterV1p2EqualsFilter(
          "status",
          input.statusFilter === "inactive" ? "tobedeleted" : "active",
        )
      : undefined;
    if (filter?._tag === "err") {
      diagnostics.push(configurationDiagnostic("invalid_status_filter"));
      return { counts, diagnostics };
    }

    const references: ReferenceIndexes = {
      organizations: new Set(),
      academicSessions: new Set(),
      courses: new Set(),
      classes: new Set(),
      users: new Set(),
    };
    const options = () => ({
      maxPages: budget.value.pagesRemaining,
      maxItems: budget.value.itemsRemaining,
      query: {
        limit: Math.min(input.configuration.traversal.pageSize, budget.value.itemsRemaining),
        ...(filter?._tag === "ok" ? { filter: filter.value } : {}),
      },
      signal: bounded.signal,
    });
    let missingReferences = 0;
    const shouldCheckReferences = input.statusFilter === undefined;

    const organizations = await streamEntityKind({
      entityKind: "organizations",
      operationId: "getAllOrgs",
      pages: client.value.iterateAllOrgs(options()),
      seen: references.organizations,
      accept: () => undefined,
      budget: budget.value,
      counts,
      diagnostics,
    });
    if (shouldStop(organizations, bounded.signal))
      return finishStoppedPreview(counts, diagnostics, bounded);

    const sessions = await streamEntityKind({
      entityKind: "academicSessions",
      operationId: "getAllAcademicSessions",
      pages: client.value.iterateAllAcademicSessions(options()),
      seen: references.academicSessions,
      accept: () => undefined,
      budget: budget.value,
      counts,
      diagnostics,
    });
    if (shouldStop(sessions, bounded.signal))
      return finishStoppedPreview(counts, diagnostics, bounded);

    const courses = await streamEntityKind({
      entityKind: "courses",
      operationId: "getAllCourses",
      pages: client.value.iterateAllCourses(options()),
      seen: references.courses,
      accept: (course) => {
        if (!shouldCheckReferences) return;
        if (course.org && !references.organizations.has(course.org.sourcedId))
          missingReferences += 1;
        if (course.schoolYear && !references.academicSessions.has(course.schoolYear.sourcedId))
          missingReferences += 1;
      },
      budget: budget.value,
      counts,
      diagnostics,
    });
    if (shouldStop(courses, bounded.signal))
      return finishStoppedPreview(counts, diagnostics, bounded);

    const classes = await streamEntityKind({
      entityKind: "classes",
      operationId: "getAllClasses",
      pages: client.value.iterateAllClasses(options()),
      seen: references.classes,
      accept: (oneRosterClass) => {
        if (!shouldCheckReferences) return;
        if (!references.courses.has(oneRosterClass.course.sourcedId)) missingReferences += 1;
        if (!references.organizations.has(oneRosterClass.school.sourcedId)) missingReferences += 1;
        missingReferences += oneRosterClass.terms.filter(
          (term) => !references.academicSessions.has(term.sourcedId),
        ).length;
      },
      budget: budget.value,
      counts,
      diagnostics,
    });
    if (shouldStop(classes, bounded.signal))
      return finishStoppedPreview(counts, diagnostics, bounded);

    const users = await streamEntityKind({
      entityKind: "users",
      operationId: "getAllUsers",
      pages: client.value.iterateAllUsers(options()),
      seen: references.users,
      accept: () => undefined,
      budget: budget.value,
      counts,
      diagnostics,
    });
    if (shouldStop(users, bounded.signal))
      return finishStoppedPreview(counts, diagnostics, bounded);

    const enrollmentIds = new Set<string>();
    const enrollments = await streamEntityKind({
      entityKind: "enrollments",
      operationId: "getAllEnrollments",
      pages: client.value.iterateAllEnrollments(options()),
      seen: enrollmentIds,
      accept: (enrollment) => {
        if (!shouldCheckReferences) return;
        if (!references.users.has(enrollment.user.sourcedId)) missingReferences += 1;
        if (!references.classes.has(enrollment.class.sourcedId)) missingReferences += 1;
        if (!references.organizations.has(enrollment.school.sourcedId)) missingReferences += 1;
      },
      budget: budget.value,
      counts,
      diagnostics,
    });
    if (shouldStop(enrollments, bounded.signal))
      return finishStoppedPreview(counts, diagnostics, bounded);

    appendMissingReferenceDiagnostic(missingReferences, diagnostics);
    return bounded.signal.aborted
      ? withElapsedDiagnostic(counts, diagnostics, bounded)
      : { counts, diagnostics };
  } finally {
    bounded.dispose();
  }
}

async function streamEntityKind<TEntity extends RosterEntity>(
  input: EntityStreamInput<TEntity>,
): Promise<StreamOutcome> {
  if (input.budget.pagesRemaining <= 0) {
    input.diagnostics.push(limitDiagnostic(input.entityKind, input.operationId, "maxPages"));
    return "stop";
  }
  if (input.budget.itemsRemaining <= 0) {
    input.diagnostics.push(limitDiagnostic(input.entityKind, input.operationId, "maxItems"));
    return "stop";
  }
  let duplicateDelivered = false;
  for await (const result of input.pages) {
    if (result._tag === "err") {
      input.diagnostics.push(mapRestError(result.error, input.entityKind));
      return shouldStopAfterRestError(result.error) ? "stop" : "continue";
    }
    if (input.budget.pagesRemaining <= 0) {
      input.diagnostics.push(limitDiagnostic(input.entityKind, input.operationId, "maxPages"));
      return "stop";
    }
    if (result.value.items.length > input.budget.itemsRemaining) {
      input.diagnostics.push(limitDiagnostic(input.entityKind, input.operationId, "maxItems"));
      return "stop";
    }

    input.budget.pagesRemaining -= 1;
    input.budget.itemsRemaining -= result.value.items.length;
    const count = input.counts[input.entityKind];
    count.received += result.value.items.length;
    for (const entity of result.value.items) {
      if (input.seen.has(entity.sourcedId)) {
        duplicateDelivered = true;
        continue;
      }
      input.seen.add(entity.sourcedId);
      count.unique += 1;
      if (isActive(entity)) count.active += 1;
      else count.inactive += 1;
      input.accept(entity);
    }
  }

  if (duplicateDelivered) {
    input.diagnostics.push({
      severity: "warning",
      code: "oneroster.rest.duplicate_delivery",
      message: "Duplicate sourcedId values were delivered and counted once.",
      entityKind: input.entityKind,
      operationId: input.operationId,
    });
  }
  return "continue";
}

function createPreviewBudget(
  configuration: OneRosterV1p2RosteringPreviewConfiguration,
):
  | { readonly _tag: "ok"; readonly value: PreviewBudget }
  | { readonly _tag: "err"; readonly code: string } {
  const traversal = configuration.traversal;
  const retry = configuration.retry;
  const checks = [
    ["page_size_exceeds_server_limit", traversal.pageSize, ONEROSTER_V1P2_PREVIEW_LIMITS.pageSize],
    ["max_pages_exceeds_server_limit", traversal.maxPages, ONEROSTER_V1P2_PREVIEW_LIMITS.maxPages],
    ["max_items_exceeds_server_limit", traversal.maxItems, ONEROSTER_V1P2_PREVIEW_LIMITS.maxItems],
    [
      "elapsed_time_exceeds_server_limit",
      traversal.maxElapsedMilliseconds,
      ONEROSTER_V1P2_PREVIEW_LIMITS.maxElapsedMilliseconds,
    ],
    [
      "retry_attempts_exceed_server_limit",
      retry.maxAttempts,
      ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxAttempts,
    ],
    [
      "retry_elapsed_time_exceeds_server_limit",
      retry.maxElapsedMilliseconds,
      ONEROSTER_V1P2_PREVIEW_LIMITS.retryMaxElapsedMilliseconds,
    ],
  ] as const;
  for (const [code, value, ceiling] of checks) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      return { _tag: "err", code };
    }
  }
  return {
    _tag: "ok",
    value: {
      pagesRemaining: traversal.maxPages,
      itemsRemaining: traversal.maxItems,
    },
  };
}

function limitDiagnostic(
  entityKind: OneRosterV1p2RosteringEntityKind,
  operationId: string,
  limitKind: "maxPages" | "maxItems",
): OneRosterV1p2PreviewDiagnostic {
  return {
    severity: "error",
    code: `oneroster.rest.traversal.${limitKind === "maxPages" ? "max_pages" : "max_items"}`,
    message: `The configured global ${limitKind === "maxPages" ? "page" : "item"} traversal bound was reached.`,
    entityKind,
    operationId,
    limitKind,
  };
}

function shouldStopAfterRestError(error: OneRosterV1p2RestError): boolean {
  return (
    error._tag === "OneRosterV1p2CancellationError" ||
    error._tag === "OneRosterV1p2CollectionLimitError"
  );
}

function shouldStop(outcome: StreamOutcome, signal: AbortSignal): boolean {
  return outcome === "stop" || signal.aborted;
}

function finishStoppedPreview(
  counts: Record<OneRosterV1p2RosteringEntityKind, OneRosterV1p2PreviewEntityCount>,
  diagnostics: OneRosterV1p2PreviewDiagnostic[],
  bounded: { readonly signal: AbortSignal; readonly elapsed: () => boolean },
): OneRosterV1p2RosteringPreviewResult {
  return bounded.signal.aborted
    ? withElapsedDiagnostic(counts, diagnostics, bounded)
    : { counts, diagnostics };
}

function isActive(entity: RosterEntity): boolean {
  return (
    entity.status === "active" && (!("enabledUser" in entity) || entity.enabledUser === "true")
  );
}

function appendMissingReferenceDiagnostic(
  missingReferences: number,
  diagnostics: OneRosterV1p2PreviewDiagnostic[],
): void {
  if (missingReferences > 0) {
    diagnostics.push({
      severity: "warning",
      code: "oneroster.rest.reference.missing",
      message: `${missingReferences} projected reference(s) did not resolve within the preview.`,
    });
  }
}

function mapRestError(
  error: OneRosterV1p2RestError,
  entityKind: OneRosterV1p2RosteringEntityKind,
): OneRosterV1p2PreviewDiagnostic {
  const diagnostic: OneRosterV1p2PreviewDiagnostic = {
    severity: "error",
    code: `oneroster.rest.${error.code}`,
    message: "OneRoster 1.2 read failed with a safe structured diagnostic.",
    entityKind,
    operationId: error.operationId,
  };
  if (error._tag === "OneRosterV1p2HttpError") diagnostic.status = error.status;
  if (error._tag === "OneRosterV1p2CollectionLimitError") diagnostic.limitKind = error.limitKind;
  return diagnostic;
}

function configurationDiagnostic(code: string): OneRosterV1p2PreviewDiagnostic {
  return {
    severity: "error",
    code: `oneroster.rest.configuration.${code}`,
    message: "Explicit OneRoster 1.2 configuration is invalid or incomplete.",
  };
}

function emptyCounts(): Record<OneRosterV1p2RosteringEntityKind, OneRosterV1p2PreviewEntityCount> {
  const empty = (): OneRosterV1p2PreviewEntityCount => ({
    received: 0,
    unique: 0,
    active: 0,
    inactive: 0,
  });
  return {
    organizations: empty(),
    academicSessions: empty(),
    courses: empty(),
    classes: empty(),
    users: empty(),
    enrollments: empty(),
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function createBoundedSignal(
  parent: AbortSignal,
  elapsedMilliseconds: number,
): {
  signal: AbortSignal;
  elapsed: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let elapsed = false;
  const onParentAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onParentAbort, { once: true });
  if (parent.aborted) onParentAbort();
  const timeout = setTimeout(() => {
    elapsed = true;
    controller.abort();
  }, elapsedMilliseconds);
  return {
    signal: controller.signal,
    elapsed: () => elapsed,
    dispose: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function withElapsedDiagnostic(
  counts: Record<OneRosterV1p2RosteringEntityKind, OneRosterV1p2PreviewEntityCount>,
  diagnostics: OneRosterV1p2PreviewDiagnostic[],
  bounded: { elapsed: () => boolean },
): OneRosterV1p2RosteringPreviewResult {
  const code = bounded.elapsed() ? "elapsed_time" : "cancelled";
  if (!diagnostics.some((diagnostic) => diagnostic.code.endsWith(code))) {
    diagnostics.push({
      severity: "error",
      code: `oneroster.rest.traversal.${code}`,
      message: bounded.elapsed()
        ? "The configured elapsed-time traversal bound was reached."
        : "The OneRoster preview was cancelled.",
      ...(bounded.elapsed() ? { limitKind: "elapsedTime" as const } : {}),
    });
  }
  return { counts, diagnostics };
}
