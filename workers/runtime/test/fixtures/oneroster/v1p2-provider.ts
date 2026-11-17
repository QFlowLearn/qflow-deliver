import type {
  OneRosterV1p2Fetch,
  OneRosterV1p2ProviderOperationHandler,
  OneRosterV1p2RosteringProviderServiceSubset,
} from "@longsightgroup/oneroster/v1p2";
import {
  buildOneRosterV1p2ProviderDiscoveryDocument,
  createOneRosterV1p2ProviderPage,
  createOneRosterV1p2ProviderRouter,
} from "@longsightgroup/oneroster/v1p2";
import {
  ONEROSTER_V1P2_ROSTER_SCOPES,
  type OneRosterV1p2RosteringPreviewConfiguration,
} from "../../../src/provisioning/oneroster-rest-preview";

const ORIGIN = "https://oneroster-provider.test";
const ROSTERING_BASE_URL = `${ORIGIN}/ims/oneroster/rostering/v1p2`;
const TOKEN_ENDPOINT = `${ORIGIN}/oauth/token`;
const DISCOVERY_URL = `${ORIGIN}/discovery/rostering.json`;
const ACCESS_TOKEN = "fixture-access-token";

export const ONEROSTER_TEST_CREDENTIAL_BINDING_ID = "ONEROSTER_FIXTURE_CREDENTIALS";

export function buildOneRosterTestCredentialBinding(tenantId: string): string {
  return JSON.stringify({
    tenantId,
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
  });
}

const references = {
  district: reference("org", "district-1"),
  school: reference("org", "school-1"),
  year: reference("academicSession", "year-2026"),
  term: reference("academicSession", "term-2026"),
  course: reference("course", "course-1"),
  class: reference("class", "class-1"),
  student: reference("user", "student-1"),
  teacher: reference("user", "teacher-1"),
};

const fixtureCollections = {
  getAllOrgs: [
    entity({
      sourcedId: "district-1",
      name: "Fixture District",
      type: "district",
      identifier: "D1",
    }),
    entity({
      sourcedId: "school-1",
      status: "tobedeleted",
      name: "Fixture School",
      type: "school",
      identifier: "S1",
      parent: references.district,
    }),
  ],
  getAllAcademicSessions: [
    entity({
      sourcedId: "year-2026",
      title: "2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      type: "schoolYear",
      schoolYear: "2026",
    }),
    entity({
      sourcedId: "term-2026",
      title: "Fall 2026",
      startDate: "2026-08-01",
      endDate: "2026-12-20",
      type: "term",
      schoolYear: "2026",
      parent: references.year,
    }),
  ],
  getAllCourses: [
    entity({
      sourcedId: "course-1",
      title: "Biology",
      courseCode: "BIO-1",
      schoolYear: references.year,
      org: references.school,
      subjects: ["Science"],
      subjectCodes: ["SCI"],
    }),
  ],
  getAllClasses: [
    entity({
      sourcedId: "class-1",
      title: "Biology - Period 1",
      classType: "scheduled",
      course: references.course,
      school: references.school,
      terms: [references.term],
    }),
  ],
  getAllUsers: [
    entity({
      sourcedId: "student-1",
      enabledUser: "true",
      givenName: "Ada",
      familyName: "Lovelace",
      roles: [{ roleType: "primary", role: "student", org: references.school }],
      primaryOrg: references.school,
      email: "ada@example.test",
    }),
    entity({
      sourcedId: "teacher-1",
      enabledUser: "false",
      givenName: "Marie",
      familyName: "Curie",
      roles: [{ roleType: "primary", role: "teacher", org: references.school }],
      primaryOrg: references.school,
    }),
  ],
  getAllEnrollments: [
    entity({
      sourcedId: "enrollment-student",
      user: references.student,
      class: references.class,
      school: references.school,
      role: "student",
      primary: "false",
    }),
    entity({
      sourcedId: "enrollment-teacher",
      status: "tobedeleted",
      user: references.teacher,
      class: references.class,
      school: references.school,
      role: "teacher",
      primary: "true",
    }),
  ],
} as const;

type FixtureOperation = keyof typeof fixtureCollections;

export interface OneRosterV1p2ProviderScenario {
  readonly duplicateOrganizations?: boolean;
  readonly rateLimitOnce?: FixtureOperation;
  readonly malformedOperation?: FixtureOperation;
  readonly failOperation?: FixtureOperation;
  readonly hangOperation?: FixtureOperation;
}

export interface OneRosterV1p2ProviderCall {
  readonly method: string;
  readonly path: string;
  readonly hasAuthorization: boolean;
}

/** Deterministic in-memory OAuth, discovery, and provider-contract fixture. */
export function createOneRosterV1p2TestProvider(scenario: OneRosterV1p2ProviderScenario = {}): {
  fetch: OneRosterV1p2Fetch;
  calls: OneRosterV1p2ProviderCall[];
} {
  const calls: OneRosterV1p2ProviderCall[] = [];
  const attempts = new Map<FixtureOperation, number>();
  const services: OneRosterV1p2RosteringProviderServiceSubset = Object.fromEntries(
    (Object.keys(fixtureCollections) as FixtureOperation[]).map((operationId) => [
      operationId,
      createCollectionHandler(operationId, scenario),
    ]),
  );
  const router = createOneRosterV1p2ProviderRouter({
    services: { rostering: services },
    authorize: async (facts) =>
      facts.hasAuthorizationHeader
        ? {
            _tag: "ok",
            value: { subject: "fixture-client", scopes: [...facts.requiredScopes] },
          }
        : {
            _tag: "err",
            error: {
              _tag: "OneRosterV1p2ProviderAuthorizationFailure",
              status: 401,
              code: "unauthorized",
            },
          },
  });
  if (router._tag === "err") throw new Error("Fixture provider router configuration failed");

  const discovery = buildOneRosterV1p2ProviderDiscoveryDocument({
    service: "rostering",
    publicServerUrl: ORIGIN,
    tokenUrl: TOKEN_ENDPOINT,
    advertisedScopes: [...ONEROSTER_V1P2_ROSTER_SCOPES],
    services: { rostering: services },
    enabledOperationIds: Object.keys(fixtureCollections),
  });
  if (discovery._tag === "err") throw new Error("Fixture discovery generation failed");

  const fetch: OneRosterV1p2Fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push({
      method: request.method,
      path: url.pathname,
      hasAuthorization: request.headers.has("authorization"),
    });
    if (request.url === DISCOVERY_URL) return Response.json(discovery.value);
    if (request.url === TOKEN_ENDPOINT) return handleTokenRequest(request);

    const operationId = operationForPath(url.pathname);
    if (operationId) {
      attempts.set(operationId, (attempts.get(operationId) ?? 0) + 1);
      if (scenario.rateLimitOnce === operationId && attempts.get(operationId) === 1) {
        return Response.json(
          { imsx_StatusInfo: { imsx_codeMajor: "failure", imsx_severity: "error" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      }
      if (scenario.malformedOperation === operationId) {
        return new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (scenario.failOperation === operationId) {
        return Response.json(
          { imsx_StatusInfo: { imsx_codeMajor: "failure", imsx_severity: "error" } },
          { status: 503 },
        );
      }
      if (scenario.hangOperation === operationId) return waitForCancellation(request.signal);
    }
    if (request.headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
      return Response.json({}, { status: 401 });
    }
    return router.value.handle(request);
  };

  return { fetch, calls };
}

export function buildOneRosterV1p2PreviewConfiguration(
  overrides: Partial<OneRosterV1p2RosteringPreviewConfiguration> = {},
): OneRosterV1p2RosteringPreviewConfiguration {
  return {
    version: "1.2",
    discoveryUrl: DISCOVERY_URL,
    rosteringBaseUrl: ROSTERING_BASE_URL,
    oauth: {
      tokenEndpoint: TOKEN_ENDPOINT,
      clientAuthentication: "client_secret_basic",
      scopes: [...ONEROSTER_V1P2_ROSTER_SCOPES],
    },
    traversal: {
      pageSize: 1,
      maxPages: 10,
      maxItems: 100,
      maxElapsedMilliseconds: 5_000,
    },
    retry: {
      maxAttempts: 2,
      maxElapsedMilliseconds: 1_000,
      statusCodes: [429, 503],
      retryConnectionErrors: true,
    },
    ...overrides,
  };
}

function createCollectionHandler(
  operationId: FixtureOperation,
  scenario: OneRosterV1p2ProviderScenario,
): OneRosterV1p2ProviderOperationHandler {
  return async ({ context }) => {
    const query = context.query;
    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;
    let items: readonly unknown[] = fixtureCollections[operationId];
    if (scenario.duplicateOrganizations && operationId === "getAllOrgs") {
      items = [...items, items[0]];
    }
    const filter = query?.filter;
    if (filter && "field" in filter && filter.field === "status") {
      items = items.filter((item) => isRecord(item) && item.status === filter.value);
    }
    const page = createOneRosterV1p2ProviderPage({
      items: items.slice(offset, offset + limit),
      limit,
      offset,
      totalCount: items.length,
    });
    if (page._tag === "err") return { _tag: "err", error: page.error };
    return {
      _tag: "ok",
      value: {
        kind: "collection",
        page: page.value,
      },
    };
  };
}

async function handleTokenRequest(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization");
  const expectedAuthorization = `Basic ${btoa("fixture-client:fixture-secret")}`;
  const body = await request.formData();
  if (
    request.method !== "POST" ||
    authorization !== expectedAuthorization ||
    body.get("grant_type") !== "client_credentials" ||
    body.get("scope") !== ONEROSTER_V1P2_ROSTER_SCOPES.join(" ")
  ) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  return Response.json({
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 300,
  });
}

function operationForPath(path: string): FixtureOperation | undefined {
  const segment = path.split("/").at(-1);
  return {
    orgs: "getAllOrgs",
    academicSessions: "getAllAcademicSessions",
    courses: "getAllCourses",
    classes: "getAllClasses",
    users: "getAllUsers",
    enrollments: "getAllEnrollments",
  }[segment ?? ""] as FixtureOperation | undefined;
}

function waitForCancellation(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function entity<T extends Record<string, unknown>>(
  value: T,
): T & {
  status: string;
  dateLastModified: string;
} {
  return {
    status: "active",
    dateLastModified: "2026-07-15T12:00:00.000Z",
    ...value,
  };
}

function reference(
  type: string,
  sourcedId: string,
): {
  href: string;
  sourcedId: string;
  type: string;
} {
  return {
    href: `${ROSTERING_BASE_URL}/${type}s/${sourcedId}`,
    sourcedId,
    type,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
