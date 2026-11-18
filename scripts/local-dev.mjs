#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const workerOrigin = "http://127.0.0.1:8787";
const webOrigin = "http://127.0.0.1:4173";
const readinessTimeoutMs = 120_000;
const localFixtureName = "presidents-sampler-demo";
const localDemoZipPath = process.env.QFLOW_DEMO_PACKAGE;
const localDemoTitle = "Presidents Sampler";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const runtimeRoot = resolve(repoRoot, "workers/runtime");
const webRoot = resolve(repoRoot, "apps/harbor-web");
const seedScriptPath = resolve(repoRoot, "tools/load/seed-phase4-fixture.mjs");
const cfBinPath = resolve(repoRoot, "node_modules/cf/bin/cf");
const workerViteBinPath = resolve(runtimeRoot, "node_modules/vite/bin/vite.js");
const viteBinPath = resolve(webRoot, "node_modules/vite/bin/vite.js");

let shuttingDown = false;
const managedChildren = [];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = normalizeMode(args.mode);
  const demoSource = normalizeDemoSource(args["demo-source"]);
  const shouldOpen = args.open === "true";
  const children = managedChildren;

  installSignalHandlers(children);

  const workerAlreadyRunning = await isReachable(workerOrigin);
  const webAlreadyRunning = await isReachable(webOrigin);

  if (workerAlreadyRunning !== webAlreadyRunning) {
    throw new Error(
      "Only one Harbor local service is running. Stop the existing process or start both with `pnpm dev:services`.",
    );
  }

  console.log(
    workerAlreadyRunning
      ? "Applying local D1 migrations to the running Harbor services..."
      : "Applying local D1 migrations...",
  );
  await runCommand(
    process.execPath,
    [
      cfBinPath,
      "d1",
      "migrations",
      "apply",
      "00000000-0000-4000-8000-000000000001",
      "--local",
      "--dir",
      "../../packages/db/migrations",
      "--persist-to",
      ".wrangler/state",
    ],
    { cwd: runtimeRoot },
  );

  if (!workerAlreadyRunning) {
    console.log("Starting Harbor worker and web app...");
    children.push(
      startProcess(
        "worker",
        process.execPath,
        [workerViteBinPath, "--host", "127.0.0.1", "--port", "8787"],
        runtimeRoot,
      ),
      startProcess(
        "web",
        process.execPath,
        [viteBinPath, "--host", "127.0.0.1", "--port", "4173"],
        webRoot,
      ),
    );

    await waitForServices(children);
  } else {
    console.log("Reusing running Harbor local services.");
  }

  console.log("");
  console.log(`Worker: ${workerOrigin}`);
  console.log(`Web:    ${webOrigin}`);

  if (mode === "services") {
    console.log("Local services are ready.");
    if (children.length > 0) {
      console.log("Press Ctrl+C to stop them.");
      await waitForChildExit(children);
    }
    return;
  }

  const seed = sanitizeSeed(args.seed ?? `local-${Date.now()}`);
  const demoCandidateId = args["candidate-id"] ?? "demo_student";
  const demoCandidateName = args["candidate-name"] ?? "Demo Student";
  const previewActorId = args["preview-actor-id"] ?? "preview_demo";
  const previewActorDisplayName = args["preview-actor-display-name"] ?? "Instructor Preview";
  const preparedAssessment = await prepareDemoAssessment(seed, demoSource);
  const assessmentVersionId = preparedAssessment.assessmentVersionId;
  const accessCode = await issueAccessCode({
    assessmentVersionId,
    code: args.code ?? buildAccessCode(),
  });
  const previewUrl =
    `${webOrigin}/?mode=preview&assessmentVersionId=` + encodeURIComponent(assessmentVersionId);
  const accessCodeUrl =
    `${webOrigin}/?mode=access-code&accessCode=${encodeURIComponent(accessCode)}` +
    `&candidateId=${encodeURIComponent(demoCandidateId)}` +
    `&candidateName=${encodeURIComponent(demoCandidateName)}`;
  const demoUrl = buildDemoUrl({
    accessCode,
    assessmentVersionId,
    candidateId: demoCandidateId,
    candidateName: demoCandidateName,
    previewActorId,
    previewActorDisplayName,
    title: preparedAssessment.title,
  });

  console.log(`Demo package: ${preparedAssessment.label}`);
  console.log(`Published version: ${assessmentVersionId}`);
  console.log(`Access code: ${accessCode}`);
  console.log(`Demo Home: ${demoUrl}`);
  console.log(`Student URL: ${accessCodeUrl}`);
  console.log(`Preview URL: ${previewUrl}`);

  if (shouldOpen) {
    const targetUrl =
      mode === "preview" ? previewUrl : mode === "access-code" ? accessCodeUrl : demoUrl;
    await tryOpenUrl(targetUrl);
  }

  if (children.length > 0) {
    console.log("Press Ctrl+C to stop the local services.");
    await waitForChildExit(children);
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function normalizeMode(value) {
  if (!value || value === "demo") {
    return "demo";
  }

  if (value === "preview" || value === "services" || value === "access-code") {
    return value;
  }

  throw new Error(`Unsupported mode "${value}". Use demo, preview, access-code, or services.`);
}

function normalizeDemoSource(value) {
  if (!value || value === "fixture") {
    return "fixture";
  }

  if (value === "zip") {
    return "zip";
  }

  throw new Error('Unsupported demo source. Use "fixture" or "zip".');
}

function startProcess(name, command, args, cwd = repoRoot) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown || code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
      return;
    }

    const detail = signal !== null ? `signal ${signal}` : `exit code ${String(code ?? 0)}`;
    console.error(`${name} process exited unexpectedly with ${detail}.`);
  });

  return { name, child };
}

async function waitForServices(children) {
  const deadline = Date.now() + readinessTimeoutMs;

  while (Date.now() < deadline) {
    const [workerReady, webReady] = await Promise.all([
      isReachable(workerOrigin),
      isReachable(webOrigin),
    ]);

    if (workerReady && webReady) {
      return;
    }

    const exitedChild = children.find(({ child }) => child.exitCode !== null);
    if (exitedChild) {
      throw new Error(`${exitedChild.name} failed before Harbor became ready.`);
    }

    await sleep(500);
  }

  throw new Error("Timed out waiting for Harbor local services to become ready.");
}

async function isReachable(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok || response.status >= 400;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with ${
            signal ? `signal ${signal}` : `exit code ${String(code ?? 0)}`
          }.`,
        ),
      );
    });
  });
}

async function runCommandCapture(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }

      const detail = stderr.trim() || stdout.trim();
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with ${
            signal ? `signal ${signal}` : `exit code ${String(code ?? 0)}`
          }${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

async function seedFixture(seed) {
  const assessmentVersionId = await runCommandCapture(process.execPath, [
    seedScriptPath,
    "--base-url",
    workerOrigin,
    "--seed",
    seed,
    "--fixture",
    localFixtureName,
  ]);

  if (!assessmentVersionId) {
    throw new Error("Local fixture publish did not return an assessmentVersionId.");
  }

  return assessmentVersionId;
}

async function prepareDemoAssessment(seed, demoSource) {
  if (demoSource === "zip") {
    if (!localDemoZipPath || !existsSync(localDemoZipPath)) {
      throw new Error(
        "Set QFLOW_DEMO_PACKAGE to an existing QTI ZIP when using --demo-source zip.",
      );
    }
    const packageBytes = await readFile(localDemoZipPath);
    const assessmentVersionId = await publishPackage({
      assessmentSlug: `presidents-sampler-${seed}`,
      packageBytes,
      packageName: basename(localDemoZipPath),
      tenantId: "tenant_local_demo",
    });

    return {
      assessmentVersionId,
      label: `${localDemoTitle} ZIP`,
      title: localDemoTitle,
    };
  }

  return {
    assessmentVersionId: await seedFixture(seed),
    label: `${localFixtureName} fixture`,
    title: localDemoTitle,
  };
}

async function publishPackage(input) {
  const response = await fetch(
    `${workerOrigin}/internal/publish?assessmentSlug=${encodeURIComponent(input.assessmentSlug)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-harbor-package-name": input.packageName,
        "x-harbor-tenant-id": input.tenantId,
      },
      body: input.packageBytes,
      signal: AbortSignal.timeout(30_000),
    },
  );

  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    const detail =
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error
        : text || response.statusText;
    throw new Error(`Package publish failed (${response.status}): ${detail}`);
  }

  if (typeof payload?.assessmentVersionId !== "string" || !payload.assessmentVersionId) {
    throw new Error("Package publish response did not include assessmentVersionId.");
  }

  return payload.assessmentVersionId;
}

async function issueAccessCode(input) {
  const response = await fetch(`${workerOrigin}/internal/access-codes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      assessmentVersionId: input.assessmentVersionId,
      code: input.code,
    }),
    signal: AbortSignal.timeout(5_000),
  });

  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    const detail =
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error
        : text || response.statusText;
    throw new Error(`Access code issue failed (${response.status}): ${detail}`);
  }

  if (typeof payload?.accessCode !== "string" || !payload.accessCode) {
    throw new Error("Access code issue response did not include accessCode.");
  }

  return payload.accessCode;
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeSeed(value) {
  const trimmed = value.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

function buildAccessCode() {
  return `LOCAL-${Date.now().toString(36).toUpperCase()}`;
}

function buildDemoUrl(input) {
  const url = new URL(webOrigin);
  url.searchParams.set("demoTitle", input.title);
  url.searchParams.set(
    "demoSummary",
    "Launch a longer Presidents Sampler student demo or preview the same package as an instructor.",
  );
  url.searchParams.set("demoAccessCode", input.accessCode);
  url.searchParams.set("demoAssessmentVersionId", input.assessmentVersionId);
  url.searchParams.set("demoCandidateId", input.candidateId);
  url.searchParams.set("demoCandidateName", input.candidateName);
  url.searchParams.set("demoPreviewActorId", input.previewActorId);
  url.searchParams.set("demoPreviewActorDisplayName", input.previewActorDisplayName);
  return url.toString();
}

function installSignalHandlers(children) {
  const shutdown = async () => {
    await terminateChildren(children);
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      shutdown().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exit(1);
      });
    });
  }
}

async function terminateChildren(children) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }

  await sleep(250);

  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGKILL");
    }
  }
}

async function waitForChildExit(children) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    const onExit = async (name, code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      await terminateChildren(children);

      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(
          `${name} exited with ${signal ? `signal ${signal}` : `exit code ${String(code ?? 0)}`}.`,
        ),
      );
    };

    for (const { name, child } of children) {
      child.once("exit", (code, signal) => {
        onExit(name, code, signal).catch(rejectPromise);
      });
      child.once("error", async (error) => {
        if (settled) {
          return;
        }

        settled = true;
        await terminateChildren(children);
        rejectPromise(error);
      });
    }
  });
}

async function tryOpenUrl(url) {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    await runCommand(command[0], command[1]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not open browser automatically: ${message}`);
  }
}

main().catch((error) => {
  terminateChildren(managedChildren)
    .catch(() => {})
    .finally(() => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    });
});
