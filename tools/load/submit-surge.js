import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";

const baseUrl = requireEnv("BASE_URL");
const assessmentVersionId = requireEnv("ASSESSMENT_VERSION_ID");
const maxFailureRate = envNumber("MAX_FAILURE_RATE", 0.01);

export const options = {
  scenarios: {
    submit_surge: {
      executor: "constant-arrival-rate",
      rate: envInteger("RATE", 20),
      timeUnit: "1s",
      duration: __ENV.DURATION || "30s",
      preAllocatedVUs: envInteger("PRE_ALLOCATED_VUS", 25),
      maxVUs: envInteger("MAX_VUS", 200),
      gracefulStop: "0s",
    },
  },
  thresholds: {
    "http_req_failed{step:submit}": [`rate<${maxFailureRate}`],
    "http_req_duration{step:submit}": stepLatencyThresholds("SUBMIT", 1000, 1500),
    "checks{step:submit}": ["rate>0.99"],
  },
};

export function setup() {
  const poolSize = envInteger(
    "ATTEMPT_POOL_SIZE",
    Math.max(
      10,
      Math.ceil(envInteger("RATE", 20) * parseDurationSeconds(__ENV.DURATION || "30s") * 1.2),
    ),
  );
  const attempts = [];

  for (let index = 0; index < poolSize; index += 1) {
    const actorId = `phase4-submit-setup-${index}`;
    const launchResponse = postJson(
      "/api/launch/preview",
      {
        assessmentVersionId,
        actor: {
          id: actorId,
          displayName: "Phase 4 Submit Drill",
        },
      },
      "setup-launch",
    );

    if (launchResponse.status !== 201) {
      failWithBody("Launch setup request failed", launchResponse);
    }

    const bootstrapToken = launchResponse.json("bootstrapToken");
    const bootstrapResponse = postJson(
      "/api/bootstrap",
      {
        bootstrapToken,
        clientSessionId: `phase4-submit-session-${index}`,
      },
      "setup-bootstrap",
    );

    if (bootstrapResponse.status !== 200) {
      failWithBody("Bootstrap setup request failed", bootstrapResponse);
    }

    attempts.push({
      attemptId: bootstrapResponse.json("attemptId"),
      clientSessionId: `phase4-submit-session-${index}`,
      currentItemRef: bootstrapResponse.json("session.currentItemRef"),
      nextSequenceNumber: Number(bootstrapResponse.json("session.sequence.nextSequence")) || 1,
    });
  }

  return {
    attempts,
  };
}

export default function (data) {
  const attempt = data.attempts[exec.scenario.iterationInTest];
  if (!attempt) {
    throw new Error(
      `No pre-bootstrapped attempt available for iteration ${exec.scenario.iterationInTest}. Increase ATTEMPT_POOL_SIZE.`,
    );
  }

  const requestedAt = new Date().toISOString();
  const submitResponse = postJson(
    `/api/attempts/${encodeURIComponent(attempt.attemptId)}/events`,
    {
      attemptId: attempt.attemptId,
      eventId: `evt-submit-${exec.scenario.iterationInTest}`,
      idempotencyKey: `idem-submit-${exec.scenario.iterationInTest}`,
      sequenceNumber: attempt.nextSequenceNumber,
      clientTimestamp: requestedAt,
      clientSessionId: attempt.clientSessionId,
      itemRef: attempt.currentItemRef,
      type: "submit.requested",
      payload: {
        requestedAt,
      },
    },
    "submit",
  );

  check(
    submitResponse,
    {
      "submit returns 200": (response) => response.status === 200,
      "submit is durably accepted": (response) => response.json("outcome") === "accepted",
      "submit transitions attempt state to submitted": (response) =>
        response.json("attemptStatus") === "submitted",
      "submit returns receipt frontier": (response) =>
        Number(response.json("highestCommittedSequence")) >= attempt.nextSequenceNumber,
    },
    { step: "submit" },
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

function failWithBody(message, response) {
  throw new Error(
    `${message}: ${response.status} ${response.body ? String(response.body) : response.status_text}`,
  );
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

function parseDurationSeconds(value) {
  const match = /^(\d+)(s|m|h)$/.exec(String(value).trim());
  if (!match) {
    return 30;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") {
    return amount * 3600;
  }
  if (unit === "m") {
    return amount * 60;
  }
  return amount;
}
