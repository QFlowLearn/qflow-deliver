import { importQtiPackage } from "../publish/import-qti-package";
import type { Env } from "../env";
import type { AppContext } from "./hono-utils";
import { requestUrl } from "./hono-utils";

export async function handlePublishPackageRequest(c: AppContext): Promise<Response> {
  return publishPackage({
    request: c.req.raw,
    env: c.env,
    url: requestUrl(c),
  });
}

export async function publishPackage(input: {
  request: Request;
  env: Env;
  url: URL;
}): Promise<Response> {
  const tenantId = input.request.headers.get("x-harbor-tenant-id");
  const assessmentSlug = input.url.searchParams.get("assessmentSlug");
  const packageName = sanitizePackageName(input.request.headers.get("x-harbor-package-name"));

  if (!tenantId || !assessmentSlug) {
    return Response.json(
      {
        error: "tenant id header and assessmentSlug query parameter are required",
      },
      { status: 400 },
    );
  }

  const packageBytes = new Uint8Array(await input.request.arrayBuffer());
  if (packageBytes.byteLength === 0) {
    return Response.json({ error: "package upload body must not be empty" }, { status: 400 });
  }

  const result = await importQtiPackage({
    tenantId,
    assessmentSlug,
    packageName,
    packageBytes,
    db: input.env.HARBOR_DB,
    bucket: input.env.CONTENT_BUCKET,
  });

  return Response.json(result, { status: 201 });
}

function sanitizePackageName(value: string | null): string {
  if (!value) {
    return "assessment.zip";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "assessment.zip";
  }

  return trimmed.split("/").at(-1) ?? "assessment.zip";
}
