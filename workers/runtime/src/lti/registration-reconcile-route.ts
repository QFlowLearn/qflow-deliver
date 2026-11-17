import { readJsonObject, readRequiredString } from "../routes/route-request-utils";

import type { InternalLtiContext } from "./context";
import { D1RegistrationProjectionStore } from "./registration-projection-store";
import { getHarborLtiCore } from "./tool";

/** Reconciles lti-tool registrations into Harbor's tenant-owned projection. */
export async function handleHarborLtiRegistrationReconcile(
  c: InternalLtiContext,
): Promise<Response> {
  const body = await readJsonObject(c.req.raw);
  const tenantId = readRequiredString(body.tenantId, "tenantId is required");
  const { storage } = await getHarborLtiCore(c.env, tenantId);
  const result = await new D1RegistrationProjectionStore(
    c.env.HARBOR_DB,
  ).reconcileFromProtocolStorage(tenantId, storage);
  return Response.json({
    tenantId,
    ...result,
  });
}
