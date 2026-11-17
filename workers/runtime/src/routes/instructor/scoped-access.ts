import type { Env } from "../../env";
import {
  assertAccommodationProfileBelongsToTenant,
  assertAssignmentBelongsToTenant,
  assertAttemptBelongsToTenant,
  assertAssessmentVersionBelongsToTenant,
  assertLearnerBelongsToTenant,
} from "../tenant-boundary";

export interface InstructorScopedAccess {
  readonly env: Env;
  readonly tenantId: string;
  readonly db: D1Database;
  readonly attemptCoordinator: DurableObjectNamespace;
  requireAssignment(assignmentId: string): Promise<void>;
  requireLearner(learnerId: string): Promise<void>;
  requireAttempt(attemptId: string): Promise<void>;
  requireAccommodationProfile(profileId: string): Promise<void>;
  requireAssessmentVersion(input: {
    readonly assessmentId: string;
    readonly assessmentVersionId: string;
  }): Promise<void>;
}

export function createInstructorScopedAccess(input: {
  readonly env: Env;
  readonly tenantId: string;
}): InstructorScopedAccess {
  const db = input.env.HARBOR_DB;
  const tenantId = input.tenantId;

  return {
    env: input.env,
    tenantId,
    db,
    attemptCoordinator: input.env.ATTEMPT_COORDINATOR,
    requireAssignment: (assignmentId) =>
      assertAssignmentBelongsToTenant({
        db,
        assignmentId,
        tenantId,
      }),
    requireLearner: (learnerId) =>
      assertLearnerBelongsToTenant({
        db,
        learnerId,
        tenantId,
      }),
    requireAttempt: (attemptId) =>
      assertAttemptBelongsToTenant({
        db,
        attemptId,
        tenantId,
      }),
    requireAccommodationProfile: (profileId) =>
      assertAccommodationProfileBelongsToTenant({
        db,
        profileId,
        tenantId,
      }),
    requireAssessmentVersion: ({ assessmentId, assessmentVersionId }) =>
      assertAssessmentVersionBelongsToTenant({
        db,
        assessmentId,
        assessmentVersionId,
        tenantId,
      }),
  };
}
