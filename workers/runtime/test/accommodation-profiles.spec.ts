import JSZip from "jszip";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { BootstrapPayload, InstitutionalSessionResponse } from "@harbor/attempt-protocol";
import {
  HARBOR_QTI3_COLOR_THEMES,
  resolveAccommodationTimingEvidence,
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
    "attempt_accommodation_snapshots",
    "learner_accommodation_assignments",
    "accommodation_profiles",
    "attempt_timeline_events",
    "attempt_policy_commands",
    "attempt_policy_overlays",
    "institutional_auth_states",
    "harbor_sessions",
    "assignment_section_targets",
    "assignment_learner_targets",
    "section_memberships",
    "sections",
    "learner_identities",
    "harbor_learners",
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
        "x-harbor-package-name": "accommodation-profile.zip",
        "x-harbor-tenant-id": input.tenantId,
      },
      body: (await createFixturePackage()).buffer as ArrayBuffer,
    }),
  );

  expect(response.status).toBe(201);
  return response.json();
}

async function postJson(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function putJson(path: string, body: unknown): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "PUT",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
      redirect: "manual",
      headers,
    }),
  );
}

async function exchangeBootstrap(bootstrapToken: string): Promise<BootstrapPayload> {
  const response = await postJson("/api/bootstrap", { bootstrapToken });
  expect(response.status).toBe(200);
  return response.json<BootstrapPayload>();
}

async function performInstitutionalLogin(): Promise<{
  cookie: string;
  session: InstitutionalSessionResponse;
}> {
  const loginResponse = await get("/api/auth/institutional/login?redirectTo=/");
  expect(loginResponse.status).toBe(302);

  const authorizeLocation = loginResponse.headers.get("location");
  expect(authorizeLocation).toBeTruthy();
  const authorizeResponse = await get(authorizeLocation!);
  expect(authorizeResponse.status).toBe(302);

  const callbackLocation = authorizeResponse.headers.get("location");
  expect(callbackLocation).toBeTruthy();
  const callbackResponse = await get(callbackLocation!);
  expect(callbackResponse.status).toBe(302);

  const cookie = callbackResponse.headers.get("set-cookie");
  expect(cookie).toBeTruthy();

  const sessionResponse = await get("/api/auth/session", {
    cookie: cookie!,
  });
  expect(sessionResponse.status).toBe(200);

  return {
    cookie: cookie!,
    session: await sessionResponse.json<InstitutionalSessionResponse>(),
  };
}

async function createActiveAssignment(input: {
  assessmentId: string;
  assessmentVersionId: string;
  learnerId: string;
}): Promise<void> {
  const response = await postJson("/internal/assignments", {
    assignmentId: "assign_accommodation_profile",
    assessmentId: input.assessmentId,
    assessmentVersionId: input.assessmentVersionId,
    title: "Accommodation Profile Assignment",
    status: "active",
    actor: {
      role: "instructor",
      actorId: "inst_accommodations",
      displayName: "Accommodation Coordinator",
    },
    policySnapshot: {
      availableFrom: "2026-04-01T00:00:00.000Z",
      availableUntil: "2026-12-31T00:00:00.000Z",
      reportingTimezone: "America/New_York",
      maxAttempts: 2,
      timeLimitSeconds: 1800,
      gracePeriodSeconds: 60,
      navigationMode: "free",
      standaloneAllowed: true,
      iframeAllowed: false,
      allowedEmbedOrigins: [],
      secureBrowserRequired: false,
      secureBrowserProviderHint: null,
      proctoringProvider: null,
    },
    targets: [{ kind: "learner", learnerId: input.learnerId }],
  });
  expect(response.status).toBe(201);
}

beforeEach(async () => {
  await resetDb();
});

describe("accommodation profiles", () => {
  it("defines the documented qti3 color themes as the Harbor allow-list", () => {
    expect(HARBOR_QTI3_COLOR_THEMES).toEqual([
      "qti3-player-color-default",
      "qti3-player-color-defaultreverse",
      "qti3-player-color-blackwhite",
      "qti3-player-color-whiteblack",
      "qti3-player-color-blackrose",
      "qti3-player-color-roseblack",
      "qti3-player-color-dgraymgray",
      "qti3-player-color-mgraydgray",
      "qti3-player-color-yellowblue",
      "qti3-player-color-blueyellow",
      "qti3-player-color-blackcyan",
      "qti3-player-color-cyanblack",
      "qti3-player-color-blackcream",
      "qti3-player-color-creamblack",
    ]);
  });

  it("creates profiles through instructor APIs, rejects invalid themes, and assigns profiles to learners", async () => {
    const login = await performInstitutionalLogin();
    const actor = {
      role: "instructor",
      actorId: "inst_accommodations",
      displayName: "Accommodation Coordinator",
    };

    const invalidResponse = await postJson("/api/instructor/accommodation-profiles", {
      profileId: "profile_invalid_theme",
      tenantId: "tenant_local_demo",
      name: "Invalid theme",
      actor,
      profile: {
        rendererPnp: {
          textAppearance: {
            colorStyle: "qti3-player-color-high-contrast",
          },
        },
      },
    });
    expect(invalidResponse.status).toBe(400);

    const createResponse = await postJson("/api/instructor/accommodation-profiles", {
      profileId: "profile_api_reader",
      tenantId: "tenant_local_demo",
      name: "Reader tools",
      description: "TTS, reader, and allowed color theme",
      status: "active",
      actor,
      profile: {
        rendererPnp: {
          textAppearance: {
            colorStyle: "qti3-player-color-yellowblue",
          },
          glossaryOnScreen: true,
        },
        shellTools: {
          textToSpeech: true,
          lineReader: true,
          calculator: "scientific",
          captions: true,
          transcripts: true,
        },
        pnpEntitlement: {
          activateAsOptionSet: ["transcript", "caption"],
          activateAtInitializationSet: ["audio-description"],
          prohibitSet: ["sign-language"],
          languages: ["en", "es"],
        },
      },
    });
    expect(createResponse.status).toBe(201);
    const profile = await createResponse.json<{
      id: string;
      tenantId: string;
      profile: {
        rendererPnp: { textAppearance: { colorStyle: string } };
        shellTools: { calculator: string; captions: boolean; transcripts: boolean };
        pnpEntitlement: {
          activateAsOptionSet: string[];
          activateAtInitializationSet: string[];
          prohibitSet: string[];
          languages: string[];
        };
      };
    }>();
    expect(profile).toMatchObject({
      id: "profile_api_reader",
      tenantId: "tenant_local_demo",
      profile: {
        rendererPnp: {
          textAppearance: {
            colorStyle: "qti3-player-color-yellowblue",
          },
        },
        shellTools: {
          calculator: "scientific",
          captions: true,
          transcripts: true,
        },
        pnpEntitlement: {
          activateAsOptionSet: ["transcript", "caption"],
          activateAtInitializationSet: ["audio-description"],
          prohibitSet: ["sign-language"],
          languages: ["en", "es"],
        },
      },
    });

    const assignResponse = await putJson(
      `/api/instructor/learners/${login.session.learner.id}/accommodation-profiles/profile_api_reader`,
      {
        status: "active",
        sourceKind: "instructor",
        effectiveAt: "2026-04-28T00:00:00.000Z",
      },
    );
    expect(assignResponse.status).toBe(200);
    const assignment = await assignResponse.json<{
      learnerId: string;
      profileId: string;
      profileName: string;
      status: string;
    }>();
    expect(assignment).toMatchObject({
      learnerId: login.session.learner.id,
      profileId: "profile_api_reader",
      profileName: "Reader tools",
      status: "active",
    });

    const listResponse = await get(
      `/api/instructor/learners/${login.session.learner.id}/accommodation-profiles`,
    );
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json<{
      assignments: Array<{ profileId: string; status: string }>;
    }>();
    expect(list.assignments).toEqual([
      expect.objectContaining({
        profileId: "profile_api_reader",
        status: "active",
      }),
    ]);
  });

  it("resolves learner accommodation profiles into launch policy and immutable snapshots", async () => {
    const { HARBOR_DB } = getTestEnv();
    const login = await performInstitutionalLogin();
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "accommodation-profile-launch",
    });
    await createActiveAssignment({
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      learnerId: login.session.learner.id,
    });

    const now = "2026-04-28T12:00:00.000Z";
    await HARBOR_DB.batch([
      HARBOR_DB.prepare(
        "INSERT INTO accommodation_profiles (id, tenant_id, name, description, status, profile_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "profile_high_contrast_reader",
        "tenant_local_demo",
        "High contrast reader",
        "High contrast, glossary, and reader tools",
        "active",
        JSON.stringify({
          rendererPnp: {
            textAppearance: {
              colorStyle: "qti3-player-color-blackwhite",
            },
            glossaryOnScreen: true,
            keywordTranslationLanguage: "es",
            extSbacGlossaryIllustration: true,
            layoutSingleColumn: true,
          },
          sessionControl: {
            allow_review: false,
            allow_skipping: false,
            validate_responses: true,
            time_limits: {
              max_time: 2400,
              allow_late_submission: true,
            },
          },
          shellTools: {
            textToSpeech: true,
            lineReader: true,
            answerMasking: true,
            calculator: "basic",
            notepad: true,
            captions: true,
            transcripts: true,
          },
          pnpEntitlement: {
            activateAsOptionSet: ["transcript", "caption", "audio-description", "sign-language"],
            languages: ["es", "en"],
          },
          additionalTestingTime: {
            mode: "time-multiplier",
            multiplier: 1.5,
            allocationPolicy: "proportional-split",
          },
        }),
        "system",
        "test",
        "Test",
        "system",
        "test",
        "Test",
        now,
        now,
      ),
      HARBOR_DB.prepare(
        "INSERT INTO learner_accommodation_assignments (id, tenant_id, learner_id, profile_id, status, source_kind, effective_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "learner_profile_assignment_01",
        "tenant_local_demo",
        login.session.learner.id,
        "profile_high_contrast_reader",
        "active",
        "manual",
        "2026-04-01T00:00:00.000Z",
        null,
        now,
        now,
      ),
    ]);

    const launchResponse = await postJson(
      "/api/launch/student",
      {
        assignmentId: "assign_accommodation_profile",
        source: "institutional-sso",
      },
      { cookie: login.cookie },
    );
    expect(launchResponse.status).toBe(201);
    const envelope = await launchResponse.json<{ bootstrapToken: string }>();
    const payload = await exchangeBootstrap(envelope.bootstrapToken);

    expect(payload.policy!.accommodations.rendererPnp).toMatchObject({
      textAppearance: {
        colorStyle: "qti3-player-color-blackwhite",
      },
      glossaryOnScreen: true,
      keywordTranslationLanguage: "es",
      extSbacGlossaryIllustration: true,
      layoutSingleColumn: true,
    });
    expect(payload.policy!.accommodations.sessionControl).toMatchObject({
      allow_review: false,
      allow_skipping: false,
      validate_responses: true,
      time_limits: {
        max_time: 2400,
        allow_late_submission: true,
      },
    });
    expect(payload.policy!.accommodations.pnpEntitlement).toMatchObject({
      activateAsOptionSet: ["transcript", "caption", "audio-description", "sign-language"],
      languages: ["es", "en"],
    });

    const snapshot = await HARBOR_DB.prepare(
      "SELECT profile_ids_json, learner_assignment_ids_json, accommodations_json, shell_tools_json, timing_json FROM attempt_accommodation_snapshots WHERE attempt_id = ?",
    )
      .bind(payload.attemptId)
      .first<{
        profile_ids_json: string;
        learner_assignment_ids_json: string;
        accommodations_json: string;
        shell_tools_json: string;
        timing_json: string;
      }>();

    expect(JSON.parse(snapshot?.profile_ids_json ?? "[]")).toEqual([
      "profile_high_contrast_reader",
    ]);
    expect(JSON.parse(snapshot?.learner_assignment_ids_json ?? "[]")).toEqual([
      "learner_profile_assignment_01",
    ]);
    expect(JSON.parse(snapshot?.accommodations_json ?? "{}").rendererPnp).toMatchObject({
      textAppearance: {
        colorStyle: "qti3-player-color-blackwhite",
      },
    });
    expect(JSON.parse(snapshot?.accommodations_json ?? "{}").pnpEntitlement).toMatchObject({
      activateAsOptionSet: ["transcript", "caption", "audio-description", "sign-language"],
      languages: ["es", "en"],
    });
    expect(JSON.parse(snapshot?.shell_tools_json ?? "{}")).toMatchObject({
      textToSpeech: true,
      lineReader: true,
      answerMasking: true,
      calculator: "basic",
      notepad: true,
      captions: true,
      transcripts: true,
    });
    expect(JSON.parse(snapshot?.timing_json ?? "{}")).toMatchObject({
      additionalTimeSeconds: 900,
      effectiveTimeLimitSeconds: 2700,
      unlimited: false,
      additionalTestingTime: {
        mode: "time-multiplier",
        multiplier: 1.5,
        allocationPolicy: "proportional-split",
      },
      allocationPolicy: "proportional-split",
    });

    const timelineResponse = await get(`/api/instructor/attempts/${payload.attemptId}/timeline`);
    expect(timelineResponse.status).toBe(200);
    const timeline = await timelineResponse.json<{
      accommodationSnapshot: {
        profileIds: string[];
        learnerProfileAssignmentIds: string[];
        shellTools: { textToSpeech?: boolean };
        timing: {
          additionalTimeSeconds: number;
          effectiveTimeLimitSeconds: number | null;
          unlimited: boolean;
        };
        summary: {
          pnp: string[];
          shellTools: string[];
          extraTimeSeconds: number;
          effectiveTimeLimitSeconds: number | null;
          colorTheme: string | null;
          masking: boolean;
          ttsReadAloud: boolean;
          captions: boolean;
          transcripts: boolean;
          calculator: string;
          notes: boolean;
        };
      } | null;
    }>();
    expect(timeline.accommodationSnapshot).toMatchObject({
      profileIds: ["profile_high_contrast_reader"],
      learnerProfileAssignmentIds: ["learner_profile_assignment_01"],
      shellTools: {
        textToSpeech: true,
      },
      timing: {
        additionalTimeSeconds: 900,
        effectiveTimeLimitSeconds: 2700,
        unlimited: false,
      },
      summary: {
        pnp: expect.arrayContaining([
          "color-theme",
          "glossary-on-screen",
          "keyword-translation:es",
          "glossary-illustration",
          "layout-single-column",
          "pnp-support:transcript",
          "pnp-support:caption",
          "pnp-support:audio-description",
          "pnp-support:sign-language",
          "pnp-language:es",
          "pnp-language:en",
          "review-disabled",
          "skipping-disabled",
          "response-validation",
          "renderer-max-time:2400",
          "late-submission-allowed",
          "additional-testing-time:time-multiplier",
          "time-multiplier:1.5",
          "time-allocation:proportional-split",
        ]),
        shellTools: expect.arrayContaining([
          "spoken",
          "line-reader",
          "answer-masking",
          "basic-calculator",
          "note-taking-on-screen",
          "captions",
          "transcripts",
        ]),
        extraTimeSeconds: 900,
        effectiveTimeLimitSeconds: 2700,
        colorTheme: "qti3-player-color-blackwhite",
        masking: true,
        ttsReadAloud: true,
        captions: true,
        transcripts: true,
        calculator: "basic",
        notes: true,
      },
    });
  });

  it("resolves PNP fixed-minutes and unlimited testing-time modes", () => {
    expect(
      resolveAccommodationTimingEvidence({
        baseTimeLimitSeconds: 1800,
        accommodations: {
          rendererPnp: {},
          sessionControl: {},
          additionalTestingTime: {
            mode: "fixed-minutes",
            fixedMinutes: 15,
            allocationPolicy: "even-split",
          },
        },
      }),
    ).toMatchObject({
      additionalTimeSeconds: 900,
      effectiveTimeLimitSeconds: 2700,
      unlimited: false,
      allocationPolicy: "even-split",
    });

    expect(
      resolveAccommodationTimingEvidence({
        baseTimeLimitSeconds: 1800,
        policyAdditionalTimeSeconds: 300,
        accommodations: {
          rendererPnp: {},
          sessionControl: {},
          additionalTestingTime: {
            mode: "unlimited",
            allocationPolicy: "whole-assessment",
          },
        },
      }),
    ).toMatchObject({
      additionalTimeSeconds: 300,
      effectiveTimeLimitSeconds: null,
      unlimited: true,
      allocationPolicy: "whole-assessment",
    });
  });
});
