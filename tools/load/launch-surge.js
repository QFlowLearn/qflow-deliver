import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";

const baseUrl = requireEnv("BASE_URL");
const assessmentVersionId = requireEnv("ASSESSMENT_VERSION_ID");
const maxFailureRate = envNumber("MAX_FAILURE_RATE", 0.01);

export const options = {
  scenarios: {
    launch_surge: {
      executor: __ENV.EXECUTOR || "constant-arrival-rate",
      rate: envInteger("RATE", 20),
      timeUnit: "1s",
      duration: __ENV.DURATION || "30s",
      preAllocatedVUs: envInteger("PRE_ALLOCATED_VUS", 25),
      maxVUs: envInteger("MAX_VUS", 200),
      gracefulStop: "0s",
    },
  },
  thresholds: {
    "http_req_failed{step:launch}": [`rate<${maxFailureRate}`],
    "http_req_failed{step:bootstrap}": [`rate<${maxFailureRate}`],
    "http_req_failed{step:manifest}": [`rate<${maxFailureRate}`],
    "http_req_failed{step:item}": [`rate<${maxFailureRate}`],
    "http_req_duration{step:launch}": stepLatencyThresholds("LAUNCH", 1000, 1500),
    "http_req_duration{step:bootstrap}": stepLatencyThresholds("BOOTSTRAP", 1000, 1500),
    "http_req_duration{step:manifest}": stepLatencyThresholds("MANIFEST", 750, 1200),
    "http_req_duration{step:item}": stepLatencyThresholds("ITEM", 750, 1200),
    "checks{step:launch}": ["rate>0.99"],
    "checks{step:bootstrap}": ["rate>0.99"],
    "checks{step:manifest}": ["rate>0.99"],
    "checks{step:item}": ["rate>0.99"],
  },
};

export default function () {
  const actorId = `phase4-launch-${exec.scenario.iterationInTest}`;
  const launchResponse = postJson(
    "/api/launch/preview",
    {
      assessmentVersionId,
      actor: {
        id: actorId,
        displayName: "Phase 4 Launch Drill",
      },
    },
    "launch",
  );

  check(
    launchResponse,
    {
      "launch preview returns 201": (response) => response.status === 201,
      "launch preview returns bootstrap token": (response) =>
        Boolean(response.json("bootstrapToken")),
    },
    { step: "launch" },
  );

  const bootstrapToken = launchResponse.json("bootstrapToken");
  const bootstrapResponse = postJson(
    "/api/bootstrap",
    {
      bootstrapToken,
      clientSessionId: `phase4-launch-session-${actorId}`,
    },
    "bootstrap",
  );

  check(
    bootstrapResponse,
    {
      "bootstrap returns 200": (response) => response.status === 200,
      "bootstrap returns attempt id": (response) => Boolean(response.json("attemptId")),
      "bootstrap returns current item ref": (response) =>
        Boolean(response.json("session.currentItemRef.itemId")),
    },
    { step: "bootstrap" },
  );

  const attemptId = bootstrapResponse.json("attemptId");
  const currentItemId = bootstrapResponse.json("session.currentItemRef.itemId");

  const manifestResponse = http.get(
    urlWithAttemptId("/api/content/manifest", attemptId),
    requestParams("manifest"),
  );

  check(
    manifestResponse,
    {
      "manifest returns 200": (response) => response.status === 200,
      "manifest echoes attempt id": (response) => response.json("attemptId") === attemptId,
      "manifest includes current item": (response) =>
        response.json("currentItemId") === currentItemId,
    },
    { step: "manifest" },
  );

  const itemResponse = http.get(
    urlWithAttemptId(`/api/content/items/${encodeURIComponent(currentItemId)}`, attemptId),
    requestParams("item"),
  );

  check(
    itemResponse,
    {
      "item returns 200": (response) => response.status === 200,
      "item echoes current item": (response) => response.json("item.id") === currentItemId,
      "item response is JSON, not a package zip": (response) =>
        String(response.headers["Content-Type"] || "").includes("application/json"),
    },
    { step: "item" },
  );
}

function postJson(path, body, step) {
  const params = requestParams(step);
  params.headers["content-type"] = "application/json";
  return http.post(`${baseUrl}${path}`, JSON.stringify(body), params);
}

function requestParams(step) {
  return {
    headers: {
      "x-harbor-frame-mode": "standalone",
    },
    tags: {
      step,
    },
  };
}

function urlWithAttemptId(path, attemptId) {
  return `${baseUrl}${path}?attemptId=${encodeURIComponent(attemptId)}`;
}

function requireEnv(name) {
  const value = __ENV[name];
  if (value && value.trim()) {
    return value.trim().replace(/\/$/, "");
  }

  throw new Error(`Missing required environment variable ${name}.`);
}

function envInteger(name, fallback) {
  const value = __ENV[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envNumber(name, fallback) {
  const value = __ENV[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stepLatencyThresholds(prefix, defaultP95, defaultP99) {
  const p95 = envInteger(`${prefix}_P95_MS`, defaultP95);
  const p99 = envInteger(`${prefix}_P99_MS`, defaultP99);
  return [`p(95)<${p95}`, `p(99)<${p99}`];
}
