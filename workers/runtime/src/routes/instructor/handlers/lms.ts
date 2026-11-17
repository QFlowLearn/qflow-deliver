import type { InstructorLmsWorkspaceResponse } from "@harbor/attempt-protocol";

import { syncLtiNrpsMembersForAttempt, upsertLtiNrpsSyncSchedule } from "../../../lti/nrps-sync";
import { createHarborLtiRegistrationPath } from "../../../lti/registration-link";
import { readHarborLtiPublicOrigin } from "../../../lti/tool";
import {
  readBoolean,
  readJsonObject,
  readOptionalPositiveInteger,
  readRequiredString,
} from "../../route-request-utils";
import { readRequiredPathParam } from "../../route-params";
import {
  assertLtiAttemptBelongsToTenant,
  assertLtiResourceLinkBelongsToTenant,
  buildInstructorLmsEvidenceCsv,
  mapLtiNrpsScheduleResult,
  readInstructorLmsIntegrations,
  readOptionalReconciliationPolicy,
  requireLtiToolEnv,
} from "../services/lms";
import type { InstructorContext } from "../context";
import { readInstructorTenantId } from "../context";
import { respondCsvAttachment } from "./reporting-responses";

export async function handleInstructorLmsEvidenceReportCsv(
  c: InstructorContext,
): Promise<Response> {
  const report = await readInstructorLmsIntegrations({
    db: c.env.HARBOR_DB,
    tenantId: readInstructorTenantId(c),
  });
  return respondCsvAttachment(
    buildInstructorLmsEvidenceCsv(report),
    "harbor-lms-evidence-report.csv",
  );
}

export async function handleInstructorLmsIntegrationList(c: InstructorContext): Promise<Response> {
  const integrations = await readInstructorLmsIntegrations({
    db: c.env.HARBOR_DB,
    tenantId: readInstructorTenantId(c),
  });
  const response: InstructorLmsWorkspaceResponse = {
    ...integrations,
    setup: { dynamicRegistrationUrl: await buildDynamicRegistrationUrl(c) },
  };
  return c.json(response, 200);
}

async function buildDynamicRegistrationUrl(c: InstructorContext): Promise<string> {
  const path = await createHarborLtiRegistrationPath(c.env, readInstructorTenantId(c));
  return new URL(path, readHarborLtiPublicOrigin(c.env)).toString();
}

export async function handleInstructorLmsNrpsSync(c: InstructorContext): Promise<Response> {
  const body = await readJsonObject(c.req.raw);
  const attemptId = readRequiredString(body.attemptId, "attemptId is required");
  await assertLtiAttemptBelongsToTenant({
    db: c.env.HARBOR_DB,
    attemptId,
    tenantId: readInstructorTenantId(c),
  });
  return c.json(
    {
      run: await syncLtiNrpsMembersForAttempt({
        env: requireLtiToolEnv(c.env),
        attemptId,
      }),
    },
    200,
  );
}

export async function handleInstructorLmsNrpsScheduleUpsert(
  c: InstructorContext,
): Promise<Response> {
  const resourceLinkRowId = readRequiredPathParam(c, "resourceLinkRowId");
  const body = await readJsonObject(c.req.raw);
  const enabled = readBoolean(body.enabled, "enabled is required");
  const intervalMinutes = readOptionalPositiveInteger(body.intervalMinutes);
  const reconciliationPolicy = readOptionalReconciliationPolicy(body.reconciliationPolicy);
  await assertLtiResourceLinkBelongsToTenant({
    db: c.env.HARBOR_DB,
    resourceLinkRowId,
    tenantId: readInstructorTenantId(c),
  });
  const schedule = await upsertLtiNrpsSyncSchedule({
    db: c.env.HARBOR_DB,
    resourceLinkRowId,
    enabled,
    intervalMinutes,
    reconciliationPolicy,
  });
  return c.json(
    {
      schedule: mapLtiNrpsScheduleResult(schedule),
    },
    200,
  );
}
