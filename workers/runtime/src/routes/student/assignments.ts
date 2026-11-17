import { Hono } from "hono";
import type { Env } from "../../env";
import { handleStudentAssignmentsRequest } from "../assignments";

export function createStudentAssignmentRoutes(): Hono<{ Bindings: Env }> {
  const assignments = new Hono<{ Bindings: Env }>();

  assignments.get("/student/assignments", handleStudentAssignmentsRequest);

  return assignments;
}
