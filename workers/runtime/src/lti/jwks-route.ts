import type { PublicLtiContext } from "./context";
import { getHarborLtiPublicJwks } from "./tool";

export async function handleHarborLtiJwks(c: PublicLtiContext): Promise<Response> {
  try {
    return Response.json(await getHarborLtiPublicJwks(c.env));
  } catch (error) {
    console.error("LTI JWKS route error", {
      path: new URL(c.req.url).pathname,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
