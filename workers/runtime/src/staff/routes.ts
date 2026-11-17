import type { StaffPermission } from "./permissions";

type Resource = "tenant" | "assignment" | "attempt" | "assignment-list" | "scoring-queue";
/** An explicit permission binding for one registered management route. */
export interface StaffRoute {
  readonly method: string;
  readonly path: string;
  readonly permission: StaffPermission;
  readonly resource: Resource;
  readonly actor: boolean;
}
const route = (
  method: string,
  path: string,
  permission: StaffPermission,
  resource: Resource = "tenant",
  actor = false,
): StaffRoute => ({ method, path, permission, resource, actor });
/** Complete management allow-list. New routes are inaccessible until explicitly mapped here. */
export const STAFF_ROUTES: readonly StaffRoute[] = [
  route("GET", "/assignments", "exam.read", "assignment-list"),
  route("POST", "/assignments", "assessment.manage", "tenant", true),
  route("GET", "/assessment-versions", "assessment.manage"),
  route("GET", "/sections", "roster.manage"),
  route("GET", "/learners", "roster.manage"),
  route("GET", "/assignments/:assignmentId", "exam.read", "assignment"),
  route("GET", "/assignments/:assignmentId/capabilities", "exam.read", "assignment"),
  route("PUT", "/assignments/:assignmentId", "assessment.manage", "assignment", true),
  route("POST", "/assignments/:assignmentId/activate", "assessment.manage", "assignment"),
  route("POST", "/assignments/:assignmentId/close", "assessment.manage", "assignment"),
  route("GET", "/assignments/:assignmentId/roster", "exam.read", "assignment"),
  route("GET", "/assignments/:assignmentId/results", "results.read", "assignment"),
  route(
    "GET",
    "/assignments/:assignmentId/learners/:learnerId/override",
    "exam.read",
    "assignment",
  ),
  route(
    "PUT",
    "/assignments/:assignmentId/learners/:learnerId/override",
    "accommodation.manage",
    "assignment",
    true,
  ),
  route("POST", "/attempts/:attemptId/actions", "exam.operate", "attempt", true),
  route("GET", "/attempts/:attemptId/timeline", "exam.read", "attempt"),
  route("GET", "/attempts/:attemptId/evidence", "exam.read", "attempt"),
  route("GET", "/accommodation-profiles", "accommodation.manage"),
  route("POST", "/accommodation-profiles", "accommodation.manage", "tenant", true),
  route("PUT", "/accommodation-profiles/:profileId", "accommodation.manage", "tenant", true),
  route("GET", "/learners/:learnerId/accommodation-profiles", "accommodation.manage"),
  route(
    "PUT",
    "/learners/:learnerId/accommodation-profiles/:profileId",
    "accommodation.manage",
    "tenant",
    true,
  ),
  route("GET", "/manual-scoring", "results.score", "scoring-queue"),
  route("GET", "/manual-scoring/attempts/:attemptId", "results.score", "attempt"),
  route(
    "PUT",
    "/manual-scoring/attempts/:attemptId/items/:itemId",
    "results.score",
    "attempt",
    true,
  ),
  route("POST", "/manual-scoring/attempts/:attemptId/finalize", "results.score", "attempt", true),
  route("GET", "/results-ops", "results.remediate"),
  route("POST", "/results-ops/attempts/:attemptId/retry", "results.remediate", "attempt", true),
  route("GET", "/report-exports/catalog", "results.read"),
  route("GET", "/report-exports/data-dictionary", "results.read"),
  ...[
    "report-exports/data-dictionary",
    "report-exports/bundle",
    "reporting",
    "learners/:learnerId/report-exports/bundle",
    "learners/:learnerId/report",
    "score-amendments/export",
    "score-amendments",
  ].map((path) => route("GET", `/assignments/:assignmentId/${path}`, "results.read", "assignment")),
  route(
    "POST",
    "/assignments/:assignmentId/score-amendments/preview",
    "results.score",
    "assignment",
    true,
  ),
  route("POST", "/assignments/:assignmentId/score-amendments", "results.score", "assignment", true),
  route(
    "POST",
    "/assignments/:assignmentId/score-amendments/:amendmentId/deactivate",
    "results.score",
    "assignment",
    true,
  ),
  route("GET", "/lms", "integration.manage"),
  route("GET", "/lms/evidence-report.csv", "integration.manage"),
  route("POST", "/lms/nrps-sync", "integration.manage"),
  route("POST", "/lms/resource-links/:resourceLinkRowId/nrps-schedule", "integration.manage"),
  ...[
    "/provisioning/runs",
    "/provisioning/runs/:runId",
    "/provisioning/runs/:runId/report.csv",
  ].map((path) => route("GET", path, "roster.manage")),
  ...[
    "csv/preview",
    "csv/apply",
    "oneroster/preview",
    "oneroster/apply",
    "oneroster/rest/v1p2/preview",
  ].map((path) => route("POST", `/provisioning/${path}`, "roster.manage", "tenant", true)),
  route("POST", "/provisioning/oneroster/rest/v1p2/sources", "roster.manage"),
];
/** Match only explicit method/path pairs, retaining scoped resource parameters. */
export function matchStaffRoute(
  method: string,
  pathname: string,
): { readonly route: StaffRoute; readonly params: Readonly<Record<string, string>> } | null {
  const input = pathname.replace(/^\/api\/instructor/, "").split("/");
  for (const candidate of STAFF_ROUTES) {
    if (candidate.method !== method) continue;
    const parts = candidate.path.split("/");
    if (parts.length !== input.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (const [index, part] of parts.entries()) {
      const value = input[index];
      if (value === undefined || value === "") {
        if (part !== value) matched = false;
        continue;
      }
      if (part.startsWith(":")) {
        try {
          params[part.slice(1)] = decodeURIComponent(value);
        } catch {
          matched = false;
        }
      } else if (part !== value) matched = false;
    }
    if (matched) return { route: candidate, params };
  }
  return null;
}
