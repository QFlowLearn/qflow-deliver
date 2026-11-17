import { persistAssignment, readAssignment } from "../../assignments";
import { assignmentStaffCapabilities } from "../../../staff/permissions";
import { readCsvQueryParam } from "../../route-request-utils";
import { requestUrl } from "../../hono-utils";
import {
  readInstructorAssignmentResults,
  readInstructorAssignmentRoster,
  updateAssignment,
  updateAssignmentStatus,
  upsertAssignmentLearnerOverride,
} from "../services/assignments";
import {
  readInstructorAssignmentList,
  readInstructorLearners,
  readInstructorPublishedAssessmentVersions,
  readInstructorSections,
} from "../services/catalog";
import { readAssignmentLearnerOverride } from "../services/policy-overrides";
import {
  readCreateAssignmentRequest,
  readUpdateAssignmentRequest,
} from "../../assignment-request-parsers";
import { readUpsertAssignmentLearnerOverrideRequest } from "../services/request-parsers";
import { allowUnsafeSebUserAgentFallback } from "../middleware";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import type { InstructorContext } from "../context";
import {
  readInstructorTenantId,
  withAssignment,
  withAssignmentLearner,
  withInstructorScope,
} from "../context";

export async function handleInstructorAssignmentList(c: InstructorContext): Promise<Response> {
  const result = await readInstructorAssignmentList({
    db: c.env.HARBOR_DB,
    tenantId: readInstructorTenantId(c),
  });
  const visible = c.get("staffVisibleAssignmentIds");
  return c.json(
    {
      assignments:
        visible === null
          ? result.assignments
          : result.assignments.filter((assignment) => visible.includes(assignment.assignmentId)),
    },
    200,
  );
}

/** Return only capabilities the authenticated staff grants authorize for this assignment. */
export async function handleInstructorAssignmentCapabilities(
  c: InstructorContext,
): Promise<Response> {
  return withAssignment(c, async (_scope, assignmentId) =>
    c.json(assignmentStaffCapabilities(c.get("staffGrants"), assignmentId), 200),
  );
}

export async function handleInstructorAssignmentCreate(c: InstructorContext): Promise<Response> {
  return withInstructorScope(c, async (scope) => {
    const createRequest = await readCreateAssignmentRequest(c.req.raw, {
      allowUnsafeUserAgentFallback: allowUnsafeSebUserAgentFallback(c.env),
    });
    await scope.requireAssessmentVersion({
      assessmentId: createRequest.assessmentId,
      assessmentVersionId: createRequest.assessmentVersionId,
    });
    const assignment = await persistAssignment({
      db: scope.db,
      request: createRequest,
      mode: "create",
      allowUnsafeSafeExamBrowserUserAgentFallback: allowUnsafeSebUserAgentFallback(c.env),
    });
    return c.json(assignment, 201);
  });
}

export async function handleInstructorAssessmentVersionList(
  c: InstructorContext,
): Promise<Response> {
  return c.json(
    await readInstructorPublishedAssessmentVersions({
      db: c.env.HARBOR_DB,
      tenantId: readInstructorTenantId(c),
    }),
    200,
  );
}

export async function handleInstructorSectionList(c: InstructorContext): Promise<Response> {
  return c.json(
    await readInstructorSections({
      db: c.env.HARBOR_DB,
      tenantId: readInstructorTenantId(c),
    }),
    200,
  );
}

export async function handleInstructorLearnerList(c: InstructorContext): Promise<Response> {
  const url = requestUrl(c);
  return c.json(
    await readInstructorLearners({
      db: c.env.HARBOR_DB,
      tenantId: readInstructorTenantId(c),
      search: url.searchParams.get("search"),
      learnerIds: readCsvQueryParam(url.searchParams.get("ids")),
    }),
    200,
  );
}

export async function handleInstructorAssignmentActivate(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await updateAssignmentStatus({
        db: scope.db,
        assignmentId,
        status: "active",
        allowUnsafeSafeExamBrowserUserAgentFallback: allowUnsafeSebUserAgentFallback(c.env),
      }),
      200,
    ),
  );
}

export async function handleInstructorAssignmentClose(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await updateAssignmentStatus({
        db: scope.db,
        assignmentId,
        status: "closed",
        allowUnsafeSafeExamBrowserUserAgentFallback: allowUnsafeSebUserAgentFallback(c.env),
      }),
      200,
    ),
  );
}

export async function handleInstructorAssignmentRoster(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await readInstructorAssignmentRoster({
        db: scope.db,
        attemptCoordinator: scope.attemptCoordinator,
        assignmentId,
      }),
      200,
    ),
  );
}

export async function handleInstructorAssignmentResults(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await readInstructorAssignmentResults({
        db: scope.db,
        attemptCoordinator: scope.attemptCoordinator,
        assignmentId,
      }),
      200,
    ),
  );
}

export async function handleInstructorAssignmentLearnerOverrideRead(
  c: InstructorContext,
): Promise<Response> {
  return withAssignmentLearner(c, async (scope, assignmentId, learnerId) => {
    const override = await readAssignmentLearnerOverride(scope.db, assignmentId, learnerId);
    if (!override) {
      throw new LaunchRequestError(404, "Assignment learner override not found");
    }

    return c.json(override, 200);
  });
}

export async function handleInstructorAssignmentLearnerOverrideUpsert(
  c: InstructorContext,
): Promise<Response> {
  return withAssignmentLearner(c, async (scope, assignmentId, learnerId) =>
    c.json(
      await upsertAssignmentLearnerOverride({
        db: scope.db,
        assignmentId,
        learnerId,
        request: await readUpsertAssignmentLearnerOverrideRequest(c.req.raw),
      }),
      200,
    ),
  );
}

export async function handleInstructorAssignmentRead(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(await readAssignment(scope.db, assignmentId), 200),
  );
}

export async function handleInstructorAssignmentUpdate(c: InstructorContext): Promise<Response> {
  return withAssignment(c, async (scope, assignmentId) =>
    c.json(
      await updateAssignment({
        db: scope.db,
        assignmentId,
        request: await readUpdateAssignmentRequest(c.req.raw, {
          allowUnsafeUserAgentFallback: allowUnsafeSebUserAgentFallback(c.env),
        }),
        allowUnsafeSafeExamBrowserUserAgentFallback: allowUnsafeSebUserAgentFallback(c.env),
      }),
      200,
    ),
  );
}
