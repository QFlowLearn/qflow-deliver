import type {
  BootstrapPayload,
  InstructorLmsNrpsSyncResponse,
  InstructorLmsWorkspaceResponse,
  InstitutionalSessionResponse,
  StudentAssignmentListResponse,
} from "@harbor/attempt-protocol";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runDueLtiNrpsSyncSchedules } from "../src/lti/nrps-sync";
import {
  countRows,
  exchangeBootstrap,
  get,
  getTestEnv,
  postForm,
  postJson,
  resetDb,
} from "./lti-test-environment";
import {
  createAssignment,
  createRegistration,
  createSection,
  postAssignment,
  publishFixture,
} from "./lti-test-fixtures";
import { performLtiLaunch, submitLtiLaunch } from "./lti-test-launch";
import { PLATFORM_PUBLIC_JWK, stubPlatformJwksFetch } from "./lti-test-platform";

beforeEach(async () => {
  await resetDb();
  stubPlatformJwksFetch();
});

describe("LTI Resource Link", () => {
  it("maps resource-link launches, reconciles duplicate and removed NRPS members, and reuses the eligible attempt", async () => {
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "phase6-lti-launch",
    });
    const registration = await createRegistration({
      registrationId: "ltireg_phase6_assignment",
    });
    const sectionId = "section_phase6_lti";
    await createSection(sectionId);
    await createAssignment({
      assignmentId: "assign_phase6_lti",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      resourceLinkId: "resource-phase6",
      contextId: "context-phase6",
      sectionId,
    });

    const firstLaunch = await performLtiLaunch({
      issuer: registration.issuer,
      clientId: registration.clientId,
      deploymentId: registration.deploymentId,
      subject: "student-lti-phase6",
      resourceLinkId: "resource-phase6",
      contextId: "context-phase6",
      ags: {
        lineitem: "https://platform.harbor.test/ags/lineitems/lineitem-1",
        lineitems: "https://platform.harbor.test/ags/lineitems",
        scopes: [
          "https://purl.imsglobal.org/spec/lti-ags/scope/score",
          "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
        ],
      },
      nrps: {
        membershipUrl: "https://platform.harbor.test/nrps/context/memberships",
        versions: ["2.0"],
      },
    });

    expect(firstLaunch.launchResponse.status).toBe(302);
    expect(await countRows("lti_sessions")).toBe(1);
    expect(await countRows("lti_attempt_launches")).toBe(1);
    const ltiAttempt = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT ags_lineitem_url, ags_lineitems_url, nrps_membership_url FROM lti_attempt_launches LIMIT 1",
      )
      .first<{
        ags_lineitem_url: string | null;
        ags_lineitems_url: string | null;
        nrps_membership_url: string | null;
      }>();
    expect(ltiAttempt).toEqual({
      ags_lineitem_url: "https://platform.harbor.test/ags/lineitems/lineitem-1",
      ags_lineitems_url: "https://platform.harbor.test/ags/lineitems",
      nrps_membership_url: "https://platform.harbor.test/nrps/context/memberships",
    });
    const sessionRead = await get("/api/auth/session", {
      cookie: firstLaunch.cookie,
    });
    expect(sessionRead.status).toBe(200);
    const sessionPayload = await sessionRead.json<InstitutionalSessionResponse>();
    expect(sessionPayload.session.providerKind).toBe("lti");
    expect(sessionPayload.learner.displayName).toBe("Taylor LTI");

    const assignmentList = await get("/api/student/assignments", {
      cookie: firstLaunch.cookie,
    });
    expect(assignmentList.status).toBe(200);
    const assignments = await assignmentList.json<StudentAssignmentListResponse>();
    expect(assignments.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignmentId: "assign_phase6_lti",
          targetSource: "section",
        }),
      ]),
    );

    const bootstrapExchange = await exchangeBootstrap(firstLaunch.bootstrapToken);
    expect(bootstrapExchange.status).toBe(200);
    const bootstrap = await bootstrapExchange.json<BootstrapPayload>();
    expect(bootstrap.launch.mode).toBe("lti");
    expect(bootstrap.launch.actor.kind).toBe("student-learner");
    expect(bootstrap.launch.actor.learnerId).toBe(sessionPayload.learner.id);

    const replayLaunch = await postForm("/api/lti/launch", {
      state: firstLaunch.state,
      id_token: firstLaunch.idToken,
    });
    expect(replayLaunch.status).toBe(409);
    expect(await countRows("harbor_learners")).toBe(1);
    expect(await countRows("attempt_entries")).toBe(1);
    expect(await countRows("lti_sessions")).toBe(1);
    expect(await countRows("lti_attempt_launches")).toBe(1);

    const taylorNrpsMember = {
      status: "Active",
      name: "Taylor NRPS",
      email: "taylor.nrps@example.edu",
      user_id: "student-lti-phase6",
      roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    };
    const jordanNrpsMember = {
      status: "Active",
      name: "Jordan NRPS",
      email: "jordan.nrps@example.edu",
      user_id: "student-lti-nrps-2",
      roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    };
    const instructorNrpsMember = {
      status: "Active",
      name: "Instructor NRPS",
      email: "instructor.nrps@example.edu",
      user_id: "instructor-lti-nrps",
      roles: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
    };
    let nrpsMembers = [taylorNrpsMember, jordanNrpsMember, instructorNrpsMember];
    const ltiServiceCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        ltiServiceCalls.push(requestUrl);
        if (requestUrl === "https://platform.harbor.test/jwks") {
          return Response.json({ keys: [PLATFORM_PUBLIC_JWK] });
        }

        if (requestUrl === "https://platform.harbor.test/token") {
          return Response.json({
            access_token: "nrps-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }

        if (requestUrl === "https://platform.harbor.test/nrps/context/memberships") {
          const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
          expect(headers.get("authorization")).toBe("Bearer nrps-token");
          return Response.json({
            id: "https://platform.harbor.test/nrps/context/memberships",
            context: {
              id: "context-phase6",
              label: "BIO 101",
              title: "Biology 101",
            },
            members: nrpsMembers,
          });
        }

        return new Response("not found", { status: 404 });
      }),
    );
    const nrpsSyncResponse = await postJson("/api/instructor/lms/nrps-sync", {
      attemptId: bootstrap.attemptId,
    });
    expect(nrpsSyncResponse.status).toBe(200);
    const nrpsSyncPayload = await nrpsSyncResponse.json<InstructorLmsNrpsSyncResponse>();
    expect(nrpsSyncPayload.run).toEqual({
      runId: expect.stringMatching(/^ltinrpsrun_/),
      attemptId: bootstrap.attemptId,
      registrationId: registration.registrationId,
      ltiSessionId: expect.any(String),
      resourceLinkId: "resource-phase6",
      sectionId,
      status: "complete",
      totalMembers: 3,
      learnerMembershipsUpserted: 2,
      learnerMembershipsDeactivated: 0,
      skippedMembers: 1,
      errorMessage: null,
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondNrpsSyncResponse = await postJson("/api/instructor/lms/nrps-sync", {
      attemptId: bootstrap.attemptId,
    });
    expect(secondNrpsSyncResponse.status).toBe(200);
    const secondNrpsSyncPayload =
      await secondNrpsSyncResponse.json<InstructorLmsNrpsSyncResponse>();
    expect(secondNrpsSyncPayload.run.runId).not.toBe(nrpsSyncPayload.run.runId);
    expect(ltiServiceCalls).toEqual([
      "https://platform.harbor.test/token",
      "https://platform.harbor.test/nrps/context/memberships",
      "https://platform.harbor.test/token",
      "https://platform.harbor.test/nrps/context/memberships",
    ]);
    expect(await countRows("harbor_learners")).toBe(2);
    expect(await countRows("section_memberships")).toBe(2);
    expect(await countRows("lti_nrps_sync_runs")).toBe(2);
    const lmsResponse = await get("/api/instructor/lms");
    expect(lmsResponse.status).toBe(200);
    const lmsPayload = await lmsResponse.json<InstructorLmsWorkspaceResponse>();
    expect(lmsPayload.registrations).toEqual([
      expect.objectContaining({
        id: registration.registrationId,
        resourceLinkCount: 1,
        deepLinkPlacementCount: 0,
        launchCount: 1,
        agsLaunchCount: 1,
        nrpsLaunchCount: 1,
        lastNrpsSync: expect.objectContaining({
          runId: secondNrpsSyncPayload.run.runId,
          status: "complete",
        }),
      }),
    ]);
    expect(lmsPayload.resourceLinks).toEqual([
      expect.objectContaining({
        assignmentId: "assign_phase6_lti",
        resourceLinkId: "resource-phase6",
        sectionId,
        agsAvailable: true,
        nrpsAvailable: true,
        latestAttemptId: bootstrap.attemptId,
        latestNrpsSync: expect.objectContaining({
          runId: secondNrpsSyncPayload.run.runId,
          learnerMembershipsUpserted: 2,
        }),
      }),
    ]);
    expect(lmsPayload.deepLinkPlacements).toEqual([]);
    expect(lmsPayload.nrpsSyncRuns).toHaveLength(2);
    expect(lmsPayload.nrpsSyncRuns[0]).toEqual(
      expect.objectContaining({
        runId: secondNrpsSyncPayload.run.runId,
        totalMembers: 3,
      }),
    );
    const evidenceReportResponse = await get("/api/instructor/lms/evidence-report.csv");
    expect(evidenceReportResponse.status).toBe(200);
    expect(evidenceReportResponse.headers.get("content-type")).toContain("text/csv");
    const evidenceReportCsv = await evidenceReportResponse.text();
    expect(evidenceReportCsv).toContain("summary,registrations");
    expect(evidenceReportCsv).toContain("resource_link");
    expect(evidenceReportCsv).toContain("nrps_sync_run");

    const resourceLinkId = lmsPayload.resourceLinks[0].id;
    const scheduleResponse = await postJson(
      `/api/instructor/lms/resource-links/${encodeURIComponent(resourceLinkId)}/nrps-schedule`,
      {
        enabled: true,
        intervalMinutes: 15,
        reconciliationPolicy: "mark-inactive",
      },
    );
    expect(scheduleResponse.status).toBe(200);
    await expect(scheduleResponse.json()).resolves.toEqual({
      schedule: expect.objectContaining({
        resourceLinkId,
        enabled: true,
        intervalMinutes: 15,
        reconciliationPolicy: "mark-inactive",
        lastRunAt: null,
        lastRunId: null,
      }),
    });

    const scheduledSummary = await runDueLtiNrpsSyncSchedules({
      env: env as unknown as Parameters<typeof runDueLtiNrpsSyncSchedules>[0]["env"],
      now: new Date(Date.now() + 1000).toISOString(),
    });
    expect(scheduledSummary).toEqual(
      expect.objectContaining({
        dueScheduleCount: 1,
        completedCount: 1,
        failedCount: 0,
        skippedCount: 0,
      }),
    );
    expect(await countRows("lti_nrps_sync_runs")).toBe(3);
    const scheduledLmsResponse = await get("/api/instructor/lms");
    expect(scheduledLmsResponse.status).toBe(200);
    const scheduledLmsPayload = await scheduledLmsResponse.json<InstructorLmsWorkspaceResponse>();
    expect(scheduledLmsPayload.resourceLinks[0].nrpsSyncSchedule).toEqual(
      expect.objectContaining({
        resourceLinkId,
        enabled: true,
        intervalMinutes: 15,
        reconciliationPolicy: "mark-inactive",
        lastRunId: expect.stringMatching(/^ltinrpsrun_/),
        lastErrorMessage: null,
      }),
    );
    const syncedLearner = await getTestEnv()
      .HARBOR_DB.prepare(
        "SELECT learners.display_name, learners.email FROM learner_identities identities INNER JOIN harbor_learners learners ON learners.id = identities.learner_id WHERE identities.provider_kind = ? AND identities.issuer = ? AND identities.subject = ?",
      )
      .bind("lti", registration.issuer, "student-lti-nrps-2")
      .first<{ display_name: string; email: string | null }>();
    expect(syncedLearner).toEqual({
      display_name: "Jordan NRPS",
      email: "jordan.nrps@example.edu",
    });

    nrpsMembers = [taylorNrpsMember, { ...taylorNrpsMember }, instructorNrpsMember];
    const reconciliationSummary = await runDueLtiNrpsSyncSchedules({
      env: env as unknown as Parameters<typeof runDueLtiNrpsSyncSchedules>[0]["env"],
      now: new Date(Date.now() + 16 * 60 * 1000).toISOString(),
    });
    expect(reconciliationSummary).toEqual(
      expect.objectContaining({
        dueScheduleCount: 1,
        completedCount: 1,
        failedCount: 0,
        skippedCount: 0,
      }),
    );
    const reconciledMemberships = await getTestEnv()
      .HARBOR_DB.prepare(
        `SELECT identities.subject, memberships.status
         FROM section_memberships memberships
         INNER JOIN learner_identities identities ON identities.learner_id = memberships.learner_id
         WHERE memberships.section_id = ? AND identities.provider_kind = ? AND identities.issuer = ?
         ORDER BY identities.subject ASC`,
      )
      .bind(sectionId, "lti", registration.issuer)
      .all<{ subject: string; status: string }>();
    expect(reconciledMemberships.results).toEqual([
      { subject: "student-lti-nrps-2", status: "inactive" },
      { subject: "student-lti-phase6", status: "active" },
    ]);
    const reconciledLmsResponse = await get("/api/instructor/lms");
    expect(reconciledLmsResponse.status).toBe(200);
    const reconciledLmsPayload = await reconciledLmsResponse.json<InstructorLmsWorkspaceResponse>();
    expect(reconciledLmsPayload.nrpsSyncRuns[0]).toEqual(
      expect.objectContaining({
        status: "complete",
        totalMembers: 3,
        learnerMembershipsUpserted: 1,
        learnerMembershipsDeactivated: 1,
        skippedMembers: 2,
      }),
    );

    const secondLaunch = await performLtiLaunch({
      issuer: registration.issuer,
      clientId: registration.clientId,
      deploymentId: registration.deploymentId,
      subject: "student-lti-phase6",
      resourceLinkId: "resource-phase6",
      contextId: "context-phase6",
    });
    const secondExchange = await exchangeBootstrap(secondLaunch.bootstrapToken);
    expect(secondExchange.status).toBe(200);
    const secondBootstrap = await secondExchange.json<BootstrapPayload>();

    expect(secondBootstrap.attemptId).toBe(bootstrap.attemptId);
    expect(await countRows("harbor_learners")).toBe(2);
    expect(await countRows("attempt_entries")).toBe(1);
    expect(await countRows("harbor_sessions")).toBe(2);
    expect(await countRows("lti_sessions")).toBe(2);
    expect(await countRows("lti_attempt_launches")).toBe(1);
  });

  it("launches learners under the linked assignment tenant", async () => {
    const tenantId = "tenant_other_lti";
    const published = await publishFixture({
      tenantId,
      assessmentSlug: "lti-tenant-other",
    });
    const registration = await createRegistration({
      registrationId: "ltireg_tenant_other",
      tenantId,
    });
    const sectionId = "section_tenant_other_lti";
    await createSection(sectionId, tenantId);
    await createAssignment({
      assignmentId: "assign_tenant_other_lti",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      resourceLinkId: "resource-tenant-other",
      contextId: "context-tenant-other",
      sectionId,
    });

    const launch = await performLtiLaunch({
      issuer: registration.issuer,
      clientId: registration.clientId,
      deploymentId: registration.deploymentId,
      subject: "student-tenant-other",
      resourceLinkId: "resource-tenant-other",
      contextId: "context-tenant-other",
    });
    expect(launch.launchResponse.status).toBe(302);

    const learner = await getTestEnv()
      .HARBOR_DB.prepare("SELECT tenant_id FROM harbor_learners ORDER BY created_at DESC LIMIT 1")
      .first<{ tenant_id: string }>();
    expect(learner?.tenant_id).toBe(tenantId);
  });

  it("rejects a stale resource link when the launch context no longer matches", async () => {
    const published = await publishFixture({
      tenantId: "tenant_local_demo",
      assessmentSlug: "lti-stale-resource-link",
    });
    const registration = await createRegistration({
      registrationId: "ltireg_stale_resource_link",
    });
    await createAssignment({
      assignmentId: "assign_stale_resource_link",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      resourceLinkId: "resource-stale-context",
      contextId: "context-original",
    });

    const launchResponse = await submitLtiLaunch({
      issuer: registration.issuer,
      clientId: registration.clientId,
      deploymentId: registration.deploymentId,
      subject: "student-stale-context",
      resourceLinkId: "resource-stale-context",
      contextId: "context-copied",
    });

    expect(launchResponse.status).toBe(403);
    await expect(launchResponse.json()).resolves.toEqual({
      error: "LTI context did not match the linked QFlowLearn Delivery assignment",
    });
    expect(await countRows("harbor_learners")).toBe(0);
    expect(await countRows("attempt_entries")).toBe(0);
    expect(await countRows("lti_attempt_launches")).toBe(0);
  });

  it("rejects assignment LTI linkage when registration tenant does not match the assessment tenant", async () => {
    const assignmentTenantId = "tenant_assign_lti";
    const registrationTenantId = "tenant_reg_mismatch_lti";
    const published = await publishFixture({
      tenantId: assignmentTenantId,
      assessmentSlug: "lti-reg-tenant-mismatch",
    });
    const registration = await createRegistration({
      registrationId: "ltireg_mismatch",
      tenantId: registrationTenantId,
    });
    const sectionId = "section_reg_mismatch_lti";
    await createSection(sectionId, assignmentTenantId);

    const response = await postAssignment({
      assignmentId: "assign_reg_mismatch_lti",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      resourceLinkId: "resource-reg-mismatch",
      contextId: "context-reg-mismatch",
      sectionId,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "LTI registration does not match the linked assignment tenant",
    });
    expect(await countRows("lti_resource_links")).toBe(0);
    expect(await countRows("assignments")).toBe(0);
  });

  it("rejects assignment LTI linkage when section tenant does not match the assessment tenant", async () => {
    const assignmentTenantId = "tenant_section_assign_lti";
    const sectionTenantId = "tenant_section_wrong_lti";
    const published = await publishFixture({
      tenantId: assignmentTenantId,
      assessmentSlug: "lti-section-tenant-mismatch",
    });
    const registration = await createRegistration({
      registrationId: "ltireg_section_mismatch",
      tenantId: assignmentTenantId,
    });
    await createSection("section_wrong_tenant_lti", sectionTenantId);

    const response = await postAssignment({
      assignmentId: "assign_section_mismatch_lti",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      registrationId: registration.registrationId,
      resourceLinkId: "resource-section-mismatch",
      contextId: "context-section-mismatch",
      sectionId: "section_wrong_tenant_lti",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "LTI linkage section does not belong to the assignment tenant",
    });
    expect(await countRows("lti_resource_links")).toBe(0);
    expect(await countRows("assignments")).toBe(0);
  });
});
