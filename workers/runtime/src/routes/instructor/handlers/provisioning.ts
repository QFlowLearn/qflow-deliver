import {
  applyCsvRosterImport,
  applyOneRosterImport,
  getProvisioningRun,
  getProvisioningRunReportCsv,
  listProvisioningRuns,
  previewCsvRosterImport,
  previewOneRosterImport,
} from "../../provisioning";
import { readRequiredPathParam } from "../../route-params";
import type { InstructorContext } from "../context";
import { readInstructorTenantId } from "../context";

export function handleInstructorProvisioningRunList(c: InstructorContext): Promise<Response> {
  return listProvisioningRuns({
    env: c.env,
    tenantId: readInstructorTenantId(c),
  });
}

export function handleInstructorProvisioningRunRead(c: InstructorContext): Promise<Response> {
  return getProvisioningRun({
    env: c.env,
    runId: readRequiredPathParam(c, "runId"),
    tenantId: readInstructorTenantId(c),
  });
}

export function handleInstructorProvisioningRunReportCsv(c: InstructorContext): Promise<Response> {
  return getProvisioningRunReportCsv({
    env: c.env,
    runId: readRequiredPathParam(c, "runId"),
    tenantId: readInstructorTenantId(c),
  });
}

export function handleInstructorProvisioningCsvPreview(c: InstructorContext): Promise<Response> {
  return previewCsvRosterImport({
    env: c.env,
    tenantId: readInstructorTenantId(c),
    request: c.req.raw,
  });
}

export function handleInstructorProvisioningCsvApply(c: InstructorContext): Promise<Response> {
  return applyCsvRosterImport({
    env: c.env,
    tenantId: readInstructorTenantId(c),
    request: c.req.raw,
  });
}

export function handleInstructorProvisioningOneRosterPreview(
  c: InstructorContext,
): Promise<Response> {
  return previewOneRosterImport({
    env: c.env,
    tenantId: readInstructorTenantId(c),
    request: c.req.raw,
  });
}

export function handleInstructorProvisioningOneRosterApply(
  c: InstructorContext,
): Promise<Response> {
  return applyOneRosterImport({
    env: c.env,
    tenantId: readInstructorTenantId(c),
    request: c.req.raw,
  });
}
