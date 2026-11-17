import { applyD1Migrations } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  InstructorLearnersResponse,
  InstructorSectionsResponse,
  ProvisioningRunDetailResponse,
  ProvisioningRunsResponse,
  RosterCsvImportResponse,
} from "@harbor/attempt-protocol";

import {
  buildOneRosterFiles,
  buildOneRosterManifest,
  buildRawOneRosterZipForm,
  buildOneRosterZipForm,
  withoutOneRosterFile,
} from "./fixtures/oneroster/build-fixtures";

function getTestEnv(): {
  HARBOR_DB: D1Database;
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
} {
  return env as unknown as {
    HARBOR_DB: D1Database;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
}

async function resetDb(): Promise<void> {
  const { HARBOR_DB, TEST_MIGRATIONS } = getTestEnv();
  await applyD1Migrations(HARBOR_DB, TEST_MIGRATIONS);

  const knownTables = [
    "provisioning_gradebook_results",
    "provisioning_gradebook_score_scales",
    "provisioning_gradebook_line_items",
    "provisioning_gradebook_categories",
    "provisioning_course_resources",
    "provisioning_class_resources",
    "provisioning_resources",
    "provisioning_class_staff",
    "provisioning_staff_users",
    "provisioning_section_metadata",
    "provisioning_courses",
    "provisioning_academic_sessions",
    "provisioning_orgs",
    "external_id_mappings",
    "provisioning_run_errors",
    "provisioning_runs",
    "provisioning_sources",
    "section_memberships",
    "sections",
    "learner_identities",
    "harbor_learners",
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

async function postForm(path: string, body: FormData): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "POST",
      body,
    }),
  );
}

async function get(path: string): Promise<Response> {
  return workerExports.default.fetch(
    new Request(`https://harbor.local${path}`, {
      method: "GET",
    }),
  );
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

async function countRows(tableName: string): Promise<number> {
  const { HARBOR_DB } = getTestEnv();
  const row = await HARBOR_DB.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).first<{
    count: number;
  }>();

  return row?.count ?? 0;
}

async function readFirstRow<T>(query: string): Promise<T | null> {
  const { HARBOR_DB } = getTestEnv();
  return HARBOR_DB.prepare(query).first<T>();
}

function buildRequest(csvText: string) {
  return {
    sourceName: "District nightly roster",
    csvText,
    actor: {
      role: "instructor",
      actorId: "inst_roster",
      displayName: "Roster Manager",
    },
  };
}

function buildOneRosterRequest(files: Record<string, string>) {
  return {
    kind: "files" as const,
    sourceName: "District OneRoster",
    files,
    actor: {
      role: "instructor" as const,
      actorId: "inst_roster",
      displayName: "Roster Manager",
    },
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("roster provisioning contracts", () => {
  it("defines CSV roster import responses and provisioning run logs", () => {
    expectTypeOf<RosterCsvImportResponse>().toMatchTypeOf<{
      summary: {
        validRowCount: number;
        learnerCreateCount: number;
        membershipCreateCount: number;
      };
      errors: Array<{
        rowNumber: number | null;
        message: string;
      }>;
    }>();
    expectTypeOf<ProvisioningRunsResponse>().toMatchTypeOf<{
      runs: Array<{
        sourceKind: "csv" | "oneroster" | "oneroster-rest-v1p2" | "lti-nrps" | "focus" | "manual";
        status: "previewed" | "applied" | "applied-with-errors" | "failed";
      }>;
    }>();
    expectTypeOf<ProvisioningRunDetailResponse>().toMatchTypeOf<{
      run: {
        inputSha256: string;
      };
      errors: Array<{
        field: string | null;
      }>;
    }>();
    expectTypeOf<InstructorSectionsResponse>().toMatchTypeOf<{
      sections: Array<{
        sourceKind: "manual" | "lti-context" | "csv" | "oneroster";
        activeLearnerCount: number;
      }>;
    }>();
    expectTypeOf<InstructorLearnersResponse>().toMatchTypeOf<{
      learners: Array<{
        displayName: string;
        activeSectionCount: number;
      }>;
    }>();
  });

  it("creates provisioning ledgers and external-id mappings", async () => {
    const sources = await readSchema("provisioning_sources");
    const runs = await readSchema("provisioning_runs");
    const errors = await readSchema("provisioning_run_errors");
    const mappings = await readSchema("external_id_mappings");
    const orgs = await readSchema("provisioning_orgs");
    const sessions = await readSchema("provisioning_academic_sessions");
    const courses = await readSchema("provisioning_courses");
    const sectionMetadata = await readSchema("provisioning_section_metadata");
    const staffUsers = await readSchema("provisioning_staff_users");
    const classStaff = await readSchema("provisioning_class_staff");
    const resources = await readSchema("provisioning_resources");
    const classResources = await readSchema("provisioning_class_resources");
    const courseResources = await readSchema("provisioning_course_resources");
    const gradebookCategories = await readSchema("provisioning_gradebook_categories");
    const gradebookLineItems = await readSchema("provisioning_gradebook_line_items");
    const gradebookScoreScales = await readSchema("provisioning_gradebook_score_scales");
    const gradebookResults = await readSchema("provisioning_gradebook_results");

    expect(sources).toContain('UNIQUE ("tenant_id", "source_kind", "source_key")');
    expect(runs).toContain('"input_sha256" TEXT NOT NULL');
    expect(errors).toContain('"row_number" INTEGER');
    expect(mappings).toContain('UNIQUE ("source_id", "entity_kind", "source_external_id")');
    expect(orgs).toContain('UNIQUE ("source_id", "sourced_id")');
    expect(sessions).toContain('"session_type" TEXT NOT NULL');
    expect(courses).toContain('"school_year_sourced_id" TEXT');
    expect(sectionMetadata).toContain('UNIQUE ("source_id", "class_sourced_id")');
    expect(staffUsers).toContain('UNIQUE ("source_id", "sourced_id")');
    expect(classStaff).toContain(
      'UNIQUE ("source_id", "class_sourced_id", "staff_sourced_id", "role")',
    );
    expect(resources).toContain('UNIQUE ("source_id", "sourced_id")');
    expect(classResources).toContain(
      'UNIQUE ("source_id", "class_sourced_id", "resource_sourced_id")',
    );
    expect(courseResources).toContain(
      'UNIQUE ("source_id", "course_sourced_id", "resource_sourced_id")',
    );
    expect(gradebookCategories).toContain('UNIQUE ("source_id", "sourced_id")');
    expect(gradebookLineItems).toContain('UNIQUE ("source_id", "sourced_id")');
    expect(gradebookScoreScales).toContain('UNIQUE ("source_id", "sourced_id")');
    expect(gradebookResults).toContain('UNIQUE ("source_id", "sourced_id")');
    expect(gradebookResults).toContain('"raw_row_json" TEXT NOT NULL');
  });

  it("dry-runs without roster mutations, applies valid rows, and persists row-level errors", async () => {
    const csvText = [
      "student_id,display_name,email,section_id,section_name,status",
      "stu-001,Ada Lovelace,ada@example.edu,sec-algebra,Algebra I,active",
      'stu-002,"Grace Hopper",grace@example.edu,sec-algebra,Algebra I,active',
      "stu-003,Katherine Johnson,katherine@example.edu,sec-algebra,Algebra I,inactive",
      ",Missing Student,missing@example.edu,sec-algebra,Algebra I,active",
    ].join("\n");

    const previewResponse = await postJson(
      "/api/instructor/provisioning/csv/preview",
      buildRequest(csvText),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<RosterCsvImportResponse>();
    expect(preview.run.status).toBe("previewed");
    expect(preview.summary).toMatchObject({
      rowCount: 4,
      validRowCount: 3,
      invalidRowCount: 1,
      learnerCreateCount: 3,
      sectionCreateCount: 1,
      membershipCreateCount: 3,
    });
    expect(preview.errors[0]).toMatchObject({
      rowNumber: 5,
      field: "learner_id",
      code: "missing_learner_id",
    });
    expect(await countRows("harbor_learners")).toBe(0);
    expect(await countRows("section_memberships")).toBe(0);

    const applyResponse = await postJson(
      "/api/instructor/provisioning/csv/apply",
      buildRequest(csvText),
    );
    expect(applyResponse.status).toBe(201);
    const applied = await applyResponse.json<RosterCsvImportResponse>();
    expect(applied.run.status).toBe("applied-with-errors");
    expect(await countRows("harbor_learners")).toBe(3);
    expect(await countRows("sections")).toBe(1);
    expect(await countRows("section_memberships")).toBe(3);
    expect(await countRows("external_id_mappings")).toBe(4);

    const sectionsResponse = await get("/api/instructor/sections");
    expect(sectionsResponse.status).toBe(200);
    const sections = await sectionsResponse.json<InstructorSectionsResponse>();
    expect(sections.sections).toHaveLength(1);
    expect(sections.sections[0]).toMatchObject({
      sourceKind: "csv",
      sourceId: "sec-algebra",
      title: "Algebra I",
      activeLearnerCount: 2,
    });

    const learnersResponse = await get("/api/instructor/learners?search=Grace");
    expect(learnersResponse.status).toBe(200);
    const learners = await learnersResponse.json<InstructorLearnersResponse>();
    expect(learners.learners).toHaveLength(1);
    expect(learners.learners[0]).toMatchObject({
      displayName: "Grace Hopper",
      activeSectionCount: 1,
    });

    const inactiveLearnerResponse = await get("/api/instructor/learners?search=Katherine");
    expect(inactiveLearnerResponse.status).toBe(200);
    const inactiveLearner = await inactiveLearnerResponse.json<InstructorLearnersResponse>();
    expect(inactiveLearner.learners).toHaveLength(1);
    expect(inactiveLearner.learners[0]).toMatchObject({
      displayName: "Katherine Johnson",
      activeSectionCount: 0,
    });

    const adaLearnerResponse = await get("/api/instructor/learners?search=Ada");
    expect(adaLearnerResponse.status).toBe(200);
    const adaLearner = await adaLearnerResponse.json<InstructorLearnersResponse>();
    expect(adaLearner.learners).toHaveLength(1);
    const hydratedLearnersResponse = await get(
      `/api/instructor/learners?search=NoMatch&ids=${adaLearner.learners[0].id},${inactiveLearner.learners[0].id}`,
    );
    expect(hydratedLearnersResponse.status).toBe(200);
    const hydratedLearners = await hydratedLearnersResponse.json<InstructorLearnersResponse>();
    expect(hydratedLearners.learners.map((learner) => learner.displayName)).toEqual([
      "Ada Lovelace",
      "Katherine Johnson",
    ]);

    const detailResponse = await get(`/api/instructor/provisioning/runs/${applied.run.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json<ProvisioningRunDetailResponse>();
    expect(detail.errors).toHaveLength(1);
    expect(detail.errors[0].message).toContain("Learner ID");

    const runsResponse = await get("/api/instructor/provisioning/runs");
    expect(runsResponse.status).toBe(200);
    const runs = await runsResponse.json<ProvisioningRunsResponse>();
    expect(runs.runs.map((run) => run.id)).toContain(applied.run.id);

    const secondPreviewResponse = await postJson(
      "/api/instructor/provisioning/csv/preview",
      buildRequest(csvText),
    );
    expect(secondPreviewResponse.status).toBe(200);
    const secondPreview = await secondPreviewResponse.json<RosterCsvImportResponse>();
    expect(secondPreview.summary).toMatchObject({
      learnerCreateCount: 0,
      learnerUpdateCount: 0,
      sectionCreateCount: 0,
      sectionUpdateCount: 0,
      membershipCreateCount: 0,
      membershipUnchangedCount: 3,
    });
  });

  it("imports a minimal OneRoster CSV file set and records hierarchy metadata", async () => {
    const files = buildOneRosterFiles();

    const previewResponse = await postJson(
      "/api/instructor/provisioning/oneroster/preview",
      buildOneRosterRequest(files),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<RosterCsvImportResponse>();
    expect(preview.run.sourceKind).toBe("oneroster");
    expect(preview.summary).toMatchObject({
      rowCount: 1,
      validRowCount: 1,
      learnerCreateCount: 1,
      sectionCreateCount: 1,
      membershipCreateCount: 1,
      orgUpsertCount: 2,
      academicSessionUpsertCount: 2,
      courseUpsertCount: 1,
      classMetadataUpsertCount: 1,
      staffUserUpsertCount: 1,
      classStaffUpsertCount: 1,
      resourceUpsertCount: 1,
      classResourceUpsertCount: 1,
      courseResourceUpsertCount: 1,
      gradebookCategoryUpsertCount: 1,
      gradebookLineItemUpsertCount: 1,
      gradebookScoreScaleUpsertCount: 1,
      gradebookResultUpsertCount: 1,
    });
    expect(await countRows("harbor_learners")).toBe(0);
    expect(await countRows("provisioning_orgs")).toBe(0);

    const applyResponse = await postJson(
      "/api/instructor/provisioning/oneroster/apply",
      buildOneRosterRequest(files),
    );
    expect(applyResponse.status).toBe(201);
    const applied = await applyResponse.json<RosterCsvImportResponse>();
    expect(applied.run.status).toBe("applied");
    expect(await countRows("harbor_learners")).toBe(1);
    expect(await countRows("sections")).toBe(1);
    expect(await countRows("section_memberships")).toBe(1);
    expect(await countRows("provisioning_orgs")).toBe(2);
    expect(await countRows("provisioning_academic_sessions")).toBe(2);
    expect(await countRows("provisioning_courses")).toBe(1);
    expect(await countRows("provisioning_section_metadata")).toBe(1);
    expect(await countRows("provisioning_staff_users")).toBe(1);
    expect(await countRows("provisioning_class_staff")).toBe(1);
    expect(await countRows("provisioning_resources")).toBe(1);
    expect(await countRows("provisioning_class_resources")).toBe(1);
    expect(await countRows("provisioning_course_resources")).toBe(1);
    expect(await countRows("provisioning_gradebook_categories")).toBe(1);
    expect(await countRows("provisioning_gradebook_line_items")).toBe(1);
    expect(await countRows("provisioning_gradebook_score_scales")).toBe(1);
    expect(await countRows("provisioning_gradebook_results")).toBe(1);
    const resultMetadata = await readFirstRow<{
      score_scale_sourced_id: string | null;
      raw_row_json: string;
    }>(
      "SELECT score_scale_sourced_id, raw_row_json FROM provisioning_gradebook_results WHERE sourced_id = 'result-ada-midterm'",
    );
    expect(resultMetadata).toMatchObject({
      score_scale_sourced_id: "scale-percent",
    });
    expect(resultMetadata?.raw_row_json).toContain("scoreScaleSourcedId");

    const sectionsResponse = await get("/api/instructor/sections");
    expect(sectionsResponse.status).toBe(200);
    const sections = await sectionsResponse.json<InstructorSectionsResponse>();
    expect(sections.sections[0]).toMatchObject({
      sourceKind: "oneroster",
      sourceId: "class-bio-1",
      title: "Biology I - Period 1",
      activeLearnerCount: 1,
      provisioningMetadata: {
        courseSourcedId: "course-bio-1",
        courseTitle: "Biology I",
        schoolSourcedId: "school-1",
        schoolName: "Example High School",
        termSourcedIds: ["term-fall-2026"],
        termTitles: ["Fall 2026"],
        staff: [
          {
            sourcedId: "teacher-1",
            displayName: "Marie Curie",
            email: "teacher@example.edu",
            role: "teacher",
          },
        ],
      },
    });

    const reportResponse = await get(
      `/api/instructor/provisioning/runs/${applied.run.id}/report.csv`,
    );
    expect(reportResponse.status).toBe(200);
    expect(reportResponse.headers.get("content-type")).toContain("text/csv");
    const reportCsv = await reportResponse.text();
    expect(reportCsv).toContain("source_kind");
    expect(reportCsv).toContain("oneroster");
    expect(reportCsv).toContain("orgUpsertCount");
    expect(reportCsv).toContain("gradebookLineItemUpsertCount");
    expect(reportCsv).toContain("gradebookResultUpsertCount");
  });

  it("accepts OneRoster ZIP uploads through the instructor provisioning API", async () => {
    const files = buildOneRosterFiles();
    const previewResponse = await postForm(
      "/api/instructor/provisioning/oneroster/preview",
      await buildOneRosterZipForm(files),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<RosterCsvImportResponse>();
    expect(preview.run.sourceKind).toBe("oneroster");
    expect(preview.summary).toMatchObject({
      validRowCount: 1,
      orgUpsertCount: 2,
      academicSessionUpsertCount: 2,
      courseUpsertCount: 1,
      classMetadataUpsertCount: 1,
      staffUserUpsertCount: 1,
      classStaffUpsertCount: 1,
      resourceUpsertCount: 1,
      gradebookLineItemUpsertCount: 1,
      gradebookResultUpsertCount: 1,
    });
    expect(await countRows("harbor_learners")).toBe(0);

    const applyResponse = await postForm(
      "/api/instructor/provisioning/oneroster/apply",
      await buildOneRosterZipForm(files),
    );
    expect(applyResponse.status).toBe(201);
    const applied = await applyResponse.json<RosterCsvImportResponse>();
    expect(applied.run.sourceName).toBe("District OneRoster ZIP");
    expect(await countRows("harbor_learners")).toBe(1);
    expect(await countRows("provisioning_section_metadata")).toBe(1);
    expect(await countRows("provisioning_staff_users")).toBe(1);
    expect(await countRows("provisioning_class_staff")).toBe(1);
    expect(await countRows("provisioning_resources")).toBe(1);
    expect(await countRows("provisioning_gradebook_line_items")).toBe(1);
    expect(await countRows("provisioning_gradebook_results")).toBe(1);
  });

  it("does not attach inactive OneRoster result score-scale links", async () => {
    const files = buildOneRosterFiles();
    const resultScoreScales = files["resultScoreScales.csv"].replace(
      "result-scale-midterm,,,Midterm Percent",
      "result-scale-midterm,tobedeleted,2026-06-30T00:00:00.000Z,Midterm Percent",
    );
    const applyResponse = await postJson(
      "/api/instructor/provisioning/oneroster/apply",
      buildOneRosterRequest({
        ...files,
        "manifest.csv": buildOneRosterManifest(files, { "resultScoreScales.csv": "delta" }),
        "resultScoreScales.csv": resultScoreScales,
      }),
    );

    expect(applyResponse.status).toBe(201);
    const applied = await applyResponse.json<RosterCsvImportResponse>();
    expect(applied.run.status).toBe("applied");
    const resultMetadata = await readFirstRow<{
      score_scale_sourced_id: string | null;
      raw_row_json: string;
    }>(
      "SELECT score_scale_sourced_id, raw_row_json FROM provisioning_gradebook_results WHERE sourced_id = 'result-ada-midterm'",
    );
    expect(resultMetadata).toMatchObject({
      score_scale_sourced_id: null,
    });
    expect(resultMetadata?.raw_row_json).toContain('"scoreScaleSourcedId":""');
  });

  it("fails OneRoster apply when manifest.csv is missing", async () => {
    const applyResponse = await postJson(
      "/api/instructor/provisioning/oneroster/apply",
      buildOneRosterRequest(withoutOneRosterFile(buildOneRosterFiles(), "manifest.csv")),
    );

    expect(applyResponse.status).toBe(201);
    const applied = await applyResponse.json<RosterCsvImportResponse>();
    expect(applied.run.status).toBe("failed");
    expect(applied.summary.validRowCount).toBe(0);
    expect(applied.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.package.missing_manifest",
          field: "manifest.csv",
        }),
      ]),
    );
    expect(await countRows("harbor_learners")).toBe(0);
    expect(await countRows("provisioning_run_errors")).toBeGreaterThan(0);
  });

  it("reports strict OneRoster header diagnostics for noncanonical CSV files", async () => {
    const files = buildOneRosterFiles();
    const previewResponse = await postJson(
      "/api/instructor/provisioning/oneroster/preview",
      buildOneRosterRequest({
        ...files,
        "users.csv": files["users.csv"].replace("agentSourcedIds", "agents"),
      }),
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<RosterCsvImportResponse>();
    expect(preview.summary.validRowCount).toBe(0);
    expect(
      preview.errors.some((error) => error.code === "oneroster.schema.header_order_mismatch"),
    ).toBe(true);
    expect(await countRows("harbor_learners")).toBe(0);
  });

  it("reports ZIP intake diagnostics from the OneRoster package", async () => {
    const nestedResponse = await postForm(
      "/api/instructor/provisioning/oneroster/preview",
      await buildRawOneRosterZipForm({
        "nested/manifest.csv": buildOneRosterFiles()["manifest.csv"],
      }),
    );
    expect(nestedResponse.status).toBe(200);
    const nestedPreview = await nestedResponse.json<RosterCsvImportResponse>();
    expect(nestedPreview.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.zip.entry_directory",
        }),
      ]),
    );

    const invalidForm = new FormData();
    invalidForm.set("sourceName", "Invalid OneRoster ZIP");
    invalidForm.set(
      "actor",
      JSON.stringify({
        role: "instructor",
        actorId: "inst_roster",
        displayName: "Roster Manager",
      }),
    );
    invalidForm.set("zip", new File([new Uint8Array([1, 2, 3])], "bad.zip"));
    const invalidResponse = await postForm(
      "/api/instructor/provisioning/oneroster/preview",
      invalidForm,
    );
    expect(invalidResponse.status).toBe(200);
    const invalidPreview = await invalidResponse.json<RosterCsvImportResponse>();
    expect(invalidPreview.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.zip.invalid_archive",
        }),
      ]),
    );
    expect(await countRows("harbor_learners")).toBe(0);
  });

  it("reports OneRoster semantic missing-reference diagnostics", async () => {
    const files = buildOneRosterFiles();
    const previewResponse = await postJson(
      "/api/instructor/provisioning/oneroster/preview",
      buildOneRosterRequest({
        ...files,
        "lineItems.csv": files["lineItems.csv"].replace("category-tests", "category-missing"),
      }),
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<RosterCsvImportResponse>();
    expect(preview.summary.validRowCount).toBe(0);
    expect(preview.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.reference.missing_target_record",
        }),
      ]),
    );
    expect(await countRows("harbor_learners")).toBe(0);
  });
});
