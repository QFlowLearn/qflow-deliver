import { Hono } from "hono";
import type { Env } from "../../env";
import { createStudentAssignmentRoutes } from "./assignments";
import { createStudentAttemptRoutes } from "./attempts";
import { createStudentDeliveryRoutes } from "./delivery";

export function createStudentRoutes(): Hono<{ Bindings: Env }> {
  const student = new Hono<{ Bindings: Env }>();

  student.route("/", createStudentDeliveryRoutes());
  student.route("/", createStudentAttemptRoutes());
  student.route("/", createStudentAssignmentRoutes());

  return student;
}
