import { LaunchRequestError } from "../../launch/create-preview-attempt";
import type { OneRosterPreviewService } from "../../provisioning/oneroster-rest-preview";
import {
  createOneRosterV1p2RestSource,
  parseOneRosterV1p2RestSourceConfiguration,
  readOneRosterCredentialBinding,
} from "../../provisioning/oneroster-rest-source";
import { readAssignmentActor, readJsonObject, readRequiredString } from "../route-request-utils";
import type { InstructorContext } from "./context";
import { readInstructorTenantId } from "./context";

interface OneRosterRestRouteEnv {
  readonly HARBOR_DB: D1Database;
}

interface OneRosterV1p2RestPreviewCommand {
  readonly sourceId: string;
  readonly actor: ReturnType<typeof readAssignmentActor>;
  readonly statusFilter?: "active" | "inactive";
}

/** Configure a tenant-scoped OneRoster REST source from an instructor HTTP request. */
export async function createOneRosterV1p2RestSourceRoute(input: {
  readonly env: OneRosterRestRouteEnv;
  readonly tenantId: string;
  readonly request: Request;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const sourceConfiguration = parseOneRosterV1p2RestSourceConfiguration(body);
  readOneRosterCredentialBinding({
    bindings: input.env,
    bindingId: sourceConfiguration.credentialBindingId,
    tenantId: input.tenantId,
  });
  const source = await createOneRosterV1p2RestSource({
    db: input.env.HARBOR_DB,
    tenantId: input.tenantId,
    sourceConfiguration,
  });
  return Response.json(source, { status: 201 });
}

/** Run a configured read-only OneRoster preview from a small source-ID command. */
export async function previewOneRosterV1p2RestSourceRoute(input: {
  readonly env: OneRosterRestRouteEnv;
  readonly tenantId: string;
  readonly request: Request;
  readonly oneRosterPreview: OneRosterPreviewService;
}): Promise<Response> {
  const command = await parseOneRosterV1p2RestPreviewCommand(input.request);
  const result = await input.oneRosterPreview.preview({
    db: input.env.HARBOR_DB,
    tenantId: input.tenantId,
    sourceId: command.sourceId,
    actor: command.actor,
    ...(command.statusFilter === undefined ? {} : { statusFilter: command.statusFilter }),
    resolveCredentials: (bindingId) =>
      readOneRosterCredentialBinding({
        bindings: input.env,
        bindingId,
        tenantId: input.tenantId,
      }),
    signal: input.request.signal,
  });
  return Response.json(result, { status: 200 });
}

/** Hono adapter for configured OneRoster source creation. */
export function handleInstructorProvisioningOneRosterV1p2RestSourceCreate(
  context: InstructorContext,
): Promise<Response> {
  return createOneRosterV1p2RestSourceRoute({
    env: context.env,
    tenantId: readInstructorTenantId(context),
    request: context.req.raw,
  });
}

/** Hono adapter for manual OneRoster source previews. */
export function createInstructorProvisioningOneRosterV1p2RestPreviewHandler(
  oneRosterPreview: OneRosterPreviewService,
): (context: InstructorContext) => Promise<Response> {
  return (context) =>
    previewOneRosterV1p2RestSourceRoute({
      env: context.env,
      tenantId: readInstructorTenantId(context),
      request: context.req.raw,
      oneRosterPreview,
    });
}

async function parseOneRosterV1p2RestPreviewCommand(
  request: Request,
): Promise<OneRosterV1p2RestPreviewCommand> {
  const body = await readJsonObject(request);
  rejectUnexpectedKeys(body, ["sourceId", "actor", "statusFilter"]);
  const statusFilter = body.statusFilter;
  if (statusFilter !== undefined && statusFilter !== "active" && statusFilter !== "inactive") {
    throw new LaunchRequestError(400, "statusFilter must be active or inactive");
  }
  return {
    sourceId: readRequiredString(body.sourceId, "sourceId is required"),
    actor: readAssignmentActor(body.actor),
    ...(statusFilter === undefined ? {} : { statusFilter }),
  };
}

function rejectUnexpectedKeys(
  record: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new LaunchRequestError(400, "Request contains unsupported fields");
  }
}
