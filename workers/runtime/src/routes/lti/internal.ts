import { Hono } from "hono";

import type { Env } from "../../env";
import {
  handleHarborLtiCreateLineItem,
  handleHarborLtiLineItem,
  handleHarborLtiListLineItems,
  handleHarborLtiNrpsMembers,
  handleHarborLtiNrpsSync,
} from "../../lti/internal-services-route";
import { handleHarborLtiRegistrationUpsert } from "../../lti/registration-route";
import { handleHarborLtiRegistrationReconcile } from "../../lti/registration-reconcile-route";
import { adminKeyMiddleware } from "../../middleware/internal-api";

export function createInternalLtiRoutes(): Hono<{ Bindings: Env }> {
  const lti = new Hono<{ Bindings: Env }>();
  const withAdminKey = adminKeyMiddleware;

  lti.post("/registrations", withAdminKey, handleHarborLtiRegistrationUpsert);
  lti.post("/registrations/reconcile", withAdminKey, handleHarborLtiRegistrationReconcile);
  lti.get("/attempts/:attemptId/ags/lineitems", withAdminKey, handleHarborLtiListLineItems);
  lti.post("/attempts/:attemptId/ags/lineitems", withAdminKey, handleHarborLtiCreateLineItem);
  lti.get("/attempts/:attemptId/ags/lineitem", withAdminKey, handleHarborLtiLineItem);
  lti.get("/attempts/:attemptId/nrps/members", withAdminKey, handleHarborLtiNrpsMembers);
  lti.post("/attempts/:attemptId/nrps/sync", withAdminKey, handleHarborLtiNrpsSync);

  return lti;
}
