import type { Context } from "hono";
import { readRequiredPathParam } from "../route-params";
import type { InstructorRouteEnv } from "./middleware";
import { createInstructorScopedAccess, type InstructorScopedAccess } from "./scoped-access";

export type InstructorContext = Context<InstructorRouteEnv>;

export function readInstructorTenantId(c: InstructorContext): string {
  return c.get("instructorTenantId");
}

export async function withInstructorScope<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess) => Promise<T>,
): Promise<T> {
  return run(
    createInstructorScopedAccess({
      env: c.env,
      tenantId: readInstructorTenantId(c),
    }),
  );
}

export async function withAssignment<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess, assignmentId: string) => Promise<T>,
): Promise<T> {
  return withInstructorScope(c, async (scope) => {
    const assignmentId = readRequiredPathParam(c, "assignmentId");
    await scope.requireAssignment(assignmentId);
    return run(scope, assignmentId);
  });
}

export async function withAssignmentLearner<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess, assignmentId: string, learnerId: string) => Promise<T>,
): Promise<T> {
  return withInstructorScope(c, async (scope) => {
    const assignmentId = readRequiredPathParam(c, "assignmentId");
    const learnerId = readRequiredPathParam(c, "learnerId");
    await scope.requireAssignment(assignmentId);
    await scope.requireLearner(learnerId);
    return run(scope, assignmentId, learnerId);
  });
}

export async function withAttempt<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess, attemptId: string) => Promise<T>,
): Promise<T> {
  return withInstructorScope(c, async (scope) => {
    const attemptId = readRequiredPathParam(c, "attemptId");
    await scope.requireAttempt(attemptId);
    return run(scope, attemptId);
  });
}

export async function withAttemptItem<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess, attemptId: string, itemId: string) => Promise<T>,
): Promise<T> {
  return withInstructorScope(c, async (scope) => {
    const attemptId = readRequiredPathParam(c, "attemptId");
    const itemId = readRequiredPathParam(c, "itemId");
    await scope.requireAttempt(attemptId);
    return run(scope, attemptId, itemId);
  });
}

export async function withLearner<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess, learnerId: string) => Promise<T>,
): Promise<T> {
  return withInstructorScope(c, async (scope) => {
    const learnerId = readRequiredPathParam(c, "learnerId");
    await scope.requireLearner(learnerId);
    return run(scope, learnerId);
  });
}

export async function withAccommodationProfile<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess, profileId: string) => Promise<T>,
): Promise<T> {
  return withInstructorScope(c, async (scope) => {
    const profileId = readRequiredPathParam(c, "profileId");
    await scope.requireAccommodationProfile(profileId);
    return run(scope, profileId);
  });
}

export async function withLearnerAccommodationProfile<T>(
  c: InstructorContext,
  run: (scope: InstructorScopedAccess, learnerId: string, profileId: string) => Promise<T>,
): Promise<T> {
  return withInstructorScope(c, async (scope) => {
    const learnerId = readRequiredPathParam(c, "learnerId");
    const profileId = readRequiredPathParam(c, "profileId");
    await scope.requireLearner(learnerId);
    await scope.requireAccommodationProfile(profileId);
    return run(scope, learnerId, profileId);
  });
}
