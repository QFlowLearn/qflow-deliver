import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type {
  AssignmentRecord,
  CreateAssignmentRequest,
  EntryLaunchResolution,
  HarborLearnerRecord,
  HarborSessionRecord,
  InstitutionalAuthStateRecord,
  LearnerIdentityRecord,
  SectionMembershipRecord,
  SectionRecord,
  StudentAssignmentListResponse,
  StudentLaunchActor,
  StudentLaunchRequest,
} from "@harbor/attempt-protocol";
import {
  ASSIGNMENT_TARGET_KINDS,
  HARBOR_SESSION_STATUSES,
  LEARNER_IDENTITY_PROVIDER_KINDS,
} from "@harbor/attempt-protocol";

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
    "lti_resource_links",
    "lti_launch_states",
    "lti_registrations",
    "institutional_auth_states",
    "harbor_sessions",
    "assignment_section_targets",
    "assignment_learner_targets",
    "section_memberships",
    "sections",
    "learner_identities",
    "harbor_learners",
    "assignments",
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

beforeEach(async () => {
  await resetDb();
});

describe("student entry contracts", () => {
  it("defines stable Harbor learner, session, and normalized entry-launch types", () => {
    expect(LEARNER_IDENTITY_PROVIDER_KINDS).toEqual(["institutional-sso", "lti", "password"]);
    expect(HARBOR_SESSION_STATUSES).toEqual(["active", "revoked", "expired"]);

    expectTypeOf<HarborLearnerRecord>().toMatchTypeOf<{
      id: string;
      tenantId: string;
      displayName: string;
      email: string | null;
    }>();

    expectTypeOf<LearnerIdentityRecord>().toMatchTypeOf<{
      learnerId: string;
      providerKind: "institutional-sso" | "lti" | "password";
      issuer: string;
      subject: string;
    }>();

    expectTypeOf<HarborSessionRecord>().toMatchTypeOf<{
      learnerId: string;
      providerKind: "institutional-sso" | "lti" | "password";
      status: "active" | "revoked" | "expired";
    }>();

    expectTypeOf<InstitutionalAuthStateRecord>().toMatchTypeOf<{
      state: string;
      nonce: string;
      providerKey: string;
      redirectTo: string;
    }>();

    expectTypeOf<StudentLaunchActor>().toMatchTypeOf<{
      kind: "student-learner";
      learnerId: string;
      sessionId: string | null;
      id: string | null;
      displayName: string | null;
    }>();

    expectTypeOf<StudentLaunchRequest>().toMatchTypeOf<{
      mode: "institutional-sso" | "lti";
      assignmentId: string;
      actor: {
        learnerId: string;
      };
    }>();

    expectTypeOf<EntryLaunchResolution>().toMatchTypeOf<{
      source: "preview" | "access-code" | "institutional-sso" | "lti";
      assignmentId: string | null;
      assessmentVersionId: string;
      learnerId: string | null;
      sessionId: string | null;
    }>();

    expectTypeOf<StudentAssignmentListResponse>().toMatchTypeOf<{
      learner: HarborLearnerRecord;
      session: HarborSessionRecord;
      assignments: Array<{
        assignmentId: string;
        attemptStatus: "not-started" | "in-progress" | "submitted" | "ineligible";
      }>;
    }>();
  });

  it("extends assignments with explicit learner or section targets for institutional entry", () => {
    expect(ASSIGNMENT_TARGET_KINDS).toEqual(["learner", "section"]);

    expectTypeOf<CreateAssignmentRequest>().toMatchTypeOf<{
      targets?: Array<
        { kind: "learner"; learnerId: string } | { kind: "section"; sectionId: string }
      >;
    }>();

    expectTypeOf<AssignmentRecord>().toMatchTypeOf<{
      targets: Array<
        { kind: "learner"; learnerId: string } | { kind: "section"; sectionId: string }
      >;
    }>();

    expectTypeOf<Pick<SectionRecord, "sourceKind" | "sourceId">>().toMatchTypeOf<{
      sourceKind: "manual" | "lti-context" | "csv" | "oneroster";
      sourceId: string;
    }>();

    expectTypeOf<SectionMembershipRecord>().toMatchTypeOf<{
      sectionId: string;
      learnerId: string;
      role: "learner";
      status: "active" | "inactive";
    }>();
  });
});

describe("student entry migration schema", () => {
  it("creates learner, target, session, and auth-state tables for institutional entry", async () => {
    const learners = await readSchema("harbor_learners");
    const identities = await readSchema("learner_identities");
    const sections = await readSchema("sections");
    const memberships = await readSchema("section_memberships");
    const learnerTargets = await readSchema("assignment_learner_targets");
    const sectionTargets = await readSchema("assignment_section_targets");
    const sessions = await readSchema("harbor_sessions");
    const authStates = await readSchema("institutional_auth_states");

    expect(learners).toContain('"tenant_id" TEXT NOT NULL');
    expect(identities).toContain('UNIQUE ("provider_kind", "issuer", "subject")');
    expect(sections).toContain('"source_kind" TEXT NOT NULL');
    expect(memberships).toContain('UNIQUE ("section_id", "learner_id")');
    expect(learnerTargets).toContain('"assignment_id" TEXT NOT NULL');
    expect(sectionTargets).toContain('"section_id" TEXT NOT NULL');
    expect(sessions).toContain('"provider_kind" TEXT NOT NULL');
    expect(authStates).toContain('UNIQUE ("state")');
  });
});
