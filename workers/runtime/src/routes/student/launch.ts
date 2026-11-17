import { Hono } from "hono";
import type { Env } from "../../env";
import {
  handleAccessCodeLaunchRequest,
  handlePreviewLaunchRequest,
  handleStudentLaunchRequest,
} from "../launch";

export function createLaunchRoutes(): Hono<{ Bindings: Env }> {
  const launch = new Hono<{ Bindings: Env }>();

  launch.post("/preview", handlePreviewLaunchRequest);
  launch.post("/access-code", handleAccessCodeLaunchRequest);
  launch.post("/student", handleStudentLaunchRequest);

  return launch;
}
