import { requestUrl } from "../../hono-utils";
import {
  createAccommodationProfile,
  readAccommodationProfiles,
  readLearnerAccommodationAssignments,
  updateAccommodationProfile,
  upsertLearnerAccommodationAssignment,
} from "../services/accommodations";
import {
  readAccommodationProfileCreateRequest,
  readAccommodationProfileUpdateRequest,
  readLearnerAccommodationAssignmentRequest,
} from "../services/request-parsers";
import { assertRequestedTenantMatches } from "../../tenant-boundary";
import type { InstructorContext } from "../context";
import {
  readInstructorTenantId,
  withAccommodationProfile,
  withLearner,
  withLearnerAccommodationProfile,
} from "../context";

export async function handleInstructorAccommodationProfileList(
  c: InstructorContext,
): Promise<Response> {
  const url = requestUrl(c);
  assertRequestedTenantMatches(url.searchParams.get("tenantId"), readInstructorTenantId(c));
  return c.json(
    await readAccommodationProfiles({
      db: c.env.HARBOR_DB,
      tenantId: readInstructorTenantId(c),
    }),
    200,
  );
}

export async function handleInstructorAccommodationProfileCreate(
  c: InstructorContext,
): Promise<Response> {
  const createRequest = await readAccommodationProfileCreateRequest(c.req.raw);
  assertRequestedTenantMatches(createRequest.tenantId, readInstructorTenantId(c));
  return c.json(
    await createAccommodationProfile({
      db: c.env.HARBOR_DB,
      request: createRequest,
    }),
    201,
  );
}

export async function handleInstructorAccommodationProfileUpdate(
  c: InstructorContext,
): Promise<Response> {
  return withAccommodationProfile(c, async (scope, profileId) =>
    c.json(
      await updateAccommodationProfile({
        db: scope.db,
        profileId,
        request: await readAccommodationProfileUpdateRequest(c.req.raw),
      }),
      200,
    ),
  );
}

export async function handleInstructorLearnerAccommodationProfileList(
  c: InstructorContext,
): Promise<Response> {
  return withLearner(c, async (scope, learnerId) =>
    c.json(
      await readLearnerAccommodationAssignments({
        db: scope.db,
        learnerId,
      }),
      200,
    ),
  );
}

export async function handleInstructorLearnerAccommodationProfileUpsert(
  c: InstructorContext,
): Promise<Response> {
  return withLearnerAccommodationProfile(c, async (scope, learnerId, profileId) =>
    c.json(
      await upsertLearnerAccommodationAssignment({
        db: scope.db,
        learnerId,
        profileId,
        request: await readLearnerAccommodationAssignmentRequest(c.req.raw),
      }),
      200,
    ),
  );
}
