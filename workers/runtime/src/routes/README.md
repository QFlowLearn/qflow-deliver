# Harbor runtime routes

HTTP routing uses [Hono](https://hono.dev/). The worker entry point is [`../app.ts`](../app.ts), which mounts domain sub-routers with **path prefixes** and **relative routes**.

## Adding a route

1. Pick the domain module (`auth/`, `student/`, `instructor/`, `lti/`, `qflow/`, `internal/`, etc.).
2. Register a **relative** path on that sub-router (e.g. `/assignments` when mounted at `/api/instructor`).
3. Implement business logic in a handler or service module; keep the route file thin.
4. Throw typed errors (`LaunchRequestError`, `PublishInputError`, etc.) — [`middleware/launch-errors.ts`](../middleware/launch-errors.ts) maps them via `app.onError`.

## Handler conventions

Route files should stay thin Hono wiring. Use [`AppContext`](hono-utils.ts) for handlers that do not need instructor tenant context:

```ts
export async function handleExampleRequest(c: AppContext): Promise<Response> {
  return doExample({ request: c.req.raw, env: c.env });
}
```

Instructor routes use [`InstructorContext`](instructor/context.ts) (`readInstructorTenantId`, `withInstructorScope`, `withAssignment`, `withAttempt`, …). Handlers live under [`instructor/handlers/`](instructor/handlers/); `register-*.ts` files are wiring only. Shared CSV/JSON export helpers: [`instructor/handlers/reporting-responses.ts`](instructor/handlers/reporting-responses.ts).

Substantive logic should take **narrow input** (`Request`, `LtiEnv`, path params, etc.) instead of depending on the full worker `Env` or Hono context shape. Public and internal LTI follow this pattern in [`../lti/`](../lti/): adapter handlers delegate to core functions (`launchLtiResourceLinkFromRequest`, `verifyAndStoreLtiSession`, `upsertLtiRegistration`, …). See [`../lti/context.ts`](../lti/context.ts) for `PublicLtiContext` / `InternalLtiContext` aliases.

Do **not** add new `handleX(request: Request, env: Env, …)` entry points unless a test harness needs that shape. Prefer `*Request(c: AppContext)` adapters and object-shaped cores for tests.

## Mount map (see `app.ts`)

| Mount prefix         | Module                 | Example full path                  |
| -------------------- | ---------------------- | ---------------------------------- |
| `/internal`          | `internal/operator.ts` | `/internal/publish`                |
| `/internal/lti`      | `lti/internal.ts`      | `/internal/lti/registrations`      |
| `/api/auth`          | `auth/`                | `/api/auth/session`                |
| `/api/auth/password` | `auth/password.ts`     | `/api/auth/password/login`         |
| `/api/lti`           | `lti/public.ts`        | `/api/lti/launch`                  |
| `/api/instructor`    | `instructor/`          | `/api/instructor/assignments`      |
| `/api/launch`        | `student/launch.ts`    | `/api/launch/preview`              |
| `/api/qflow`         | `qflow/index.ts` (SSO) | `/api/qflow/sso/launch`            |
| `/api`               | `student/`             | `/api/bootstrap`, `/api/content/…` |

Instructor sub-routes (`/provisioning/*`, `/results-ops/*`, reporting, LMS, etc.) are registered on the single `/api/instructor` app via `register-*` modules — one middleware stack, no duplicate mounts.

Internal operator, publish, and signed qflow routes share one flat `/internal` Hono app ([`internal/operator.ts`](internal/operator.ts)) — wiring only; adapters live in owning route modules.

## Shared request parsing

- [`route-request-utils.ts`](route-request-utils.ts) — JSON body helpers, assignment actor parsing.
- [`route-params.ts`](route-params.ts) — required Hono path and delivery query param readers (`PathParamContext` works for both `AppContext` and `InstructorContext`).
- [`tenant-boundary.ts`](tenant-boundary.ts) — tenant-scoped resource asserts (`assertAttemptBelongsToTenant`, `assertRequestedTenantMatches`, etc.).
- [`assignment-request-parsers.ts`](assignment-request-parsers.ts) — canonical assignment create/update/policy parsers (`parseStoredAssignmentPolicySnapshot`).
- [`../delivery/delivery-policy.ts`](../delivery/delivery-policy.ts) — canonical stored delivery policy parsing (`parseStoredDeliveryPolicy`).
- `instructor/services/json-parsers.ts` — accommodations and instructor-only shapes.
- `instructor/services/request-parsers.ts` — accommodation and score-amendment request parsers.

## Tenant boundaries

Instructor routes resolve the session tenant in `instructorAuthMiddleware` and store it as `instructorTenantId`. Routes that touch scoped resources call the appropriate assert from [`tenant-boundary.ts`](tenant-boundary.ts) using Hono path params — not pathname regex.

## Student delivery layout

Student delivery handlers live under [`student/`](student/): `bootstrap.ts`, `content.ts`, `assets.ts`, `history.ts`, mounted via [`student/delivery.ts`](student/delivery.ts). Attempt event, evidence, policy, and Safe Exam Browser routes live in [`student/attempts.ts`](student/attempts.ts) with core logic in sibling route modules (`attempt-events.ts`, `attempt-evidence.ts`, `attempt-policy.ts`, `safe-exam-browser-config.ts`).

Student assignments and launch: [`student/assignments.ts`](student/assignments.ts), [`student/launch.ts`](student/launch.ts) with cores in [`assignments.ts`](assignments.ts) and [`launch.ts`](launch.ts).

## Auth layout

Session handlers: [`auth/session.ts`](auth/session.ts) — `handle*Request(c: AppContext)` adapters.  
Password handlers: [`auth/password-handlers.ts`](auth/password-handlers.ts).  
Route wiring: [`auth/index.ts`](auth/index.ts), [`auth/password.ts`](auth/password.ts).

## QFlow layout

Signed internal qflow routes: [`qflow/`](qflow/) (`handoff`, `publish`, `capability`, `state`, `admin`, `signature`, `sso-token`, `launch-authority`) with `AppContext` adapters.  
SSO launch: `qflow/sso-launch.ts` on `/api/qflow` via [`qflow/index.ts`](qflow/index.ts).

## LTI layout

Public protocol handlers and support modules: [`../lti/`](../lti/) (`*-route.ts`, `session.ts`, `types.ts`, …).
Hono composition only: [`lti/public.ts`](lti/public.ts), [`lti/internal.ts`](lti/internal.ts).

## Middleware order

1. `app.onError(launchErrorHandler)` — typed domain errors only (no duck-typed `{status, message}` catch-all).
2. `internalApiMiddleware` — gates `/internal/*` except signed qflow POSTs.
3. `instructorAuthMiddleware` on `/api/instructor/*` only.
4. Per-route `adminKeyMiddleware` for internal LTI routes.

**Do not** use `use("*")` on a sub-app mounted at `/` — it runs for every request. Always mount at a prefix or scope middleware to a path pattern.

## Tests

Worker specs call `workerExports.default.fetch` from `cloudflare:workers`. Handler unit tests that cannot go through the worker (e.g. injected `fetch`) may call object-shaped cores (`qflowPublish`, `publishPackage`, …) or use `launchErrorToResponse` from [`middleware/launch-errors.ts`](../middleware/launch-errors.ts) when asserting typed error bodies.
