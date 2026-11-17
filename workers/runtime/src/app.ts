import { Hono } from "hono";
import type { Env } from "./env";
import type { OneRosterPreviewService } from "./provisioning/oneroster-rest-preview";
import { internalApiMiddleware } from "./middleware/internal-api";
import { launchErrorHandler } from "./middleware/launch-errors";
import { PHASE_ONE_BOUNDARY } from "./phase-boundary";
import { createAuthRoutes } from "./routes/auth/index";
import { createPasswordAuthRoutes } from "./routes/auth/password";
import { createInternalRoutes } from "./routes/internal/index";
import { createInstructorRoutes } from "./routes/instructor/index";
import { createPublicLtiRoutes } from "./routes/lti/public";
import { createInternalLtiRoutes } from "./routes/lti/internal";
import { createQflowSsoRoutes } from "./routes/qflow/index";
import { createLaunchRoutes } from "./routes/student/launch";
import { createStudentRoutes } from "./routes/student/index";

export function createApp(input: {
  readonly oneRosterPreview: OneRosterPreviewService;
}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.onError(launchErrorHandler);
  app.use("*", internalApiMiddleware);

  app.route("/internal", createInternalRoutes());
  app.route("/internal/lti", createInternalLtiRoutes());
  app.route("/api/auth", createAuthRoutes());
  app.route("/api/auth/password", createPasswordAuthRoutes());
  app.route("/api/lti", createPublicLtiRoutes());
  app.route("/api/instructor", createInstructorRoutes(input));
  app.route("/api/launch", createLaunchRoutes());
  app.route("/api/qflow", createQflowSsoRoutes());
  app.route("/api", createStudentRoutes());

  app.notFound(async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (
      c.env.ASSETS &&
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      !pathname.startsWith("/api/") &&
      !pathname.startsWith("/internal/")
    ) {
      return c.env.ASSETS.fetch(c.req.raw);
    }

    return c.json(
      {
        error: "Route not found",
        phaseBoundary: PHASE_ONE_BOUNDARY,
      },
      404,
    );
  });

  return app;
}
