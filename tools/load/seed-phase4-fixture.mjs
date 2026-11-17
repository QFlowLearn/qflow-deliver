#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(
    args["base-url"] ?? process.env.STAGING_URL ?? process.env.BASE_URL,
  );
  const seed = sanitizeSeed(args.seed ?? `phase4-${Date.now()}`);
  const packageName = args["package-name"] ?? "basic-assessment.zip";
  const tenantId = args["tenant-id"] ?? `tenant_${seed}`;
  const fixtureRoot = resolveFixtureRoot(args.fixture ?? "basic-assessment");

  if (!baseUrl) {
    throw new Error("A staging base URL is required. Pass --base-url or set STAGING_URL.");
  }

  const packageBytes = await createFixturePackage(fixtureRoot);
  const publishUrl = new URL("/internal/publish", baseUrl);
  publishUrl.searchParams.set("assessmentSlug", seed);

  const response = await fetch(publishUrl, {
    method: "POST",
    headers: {
      "content-type": "application/zip",
      "x-harbor-package-name": packageName,
      "x-harbor-tenant-id": tenantId,
    },
    body: packageBytes,
  });

  const responseText = await response.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      typeof payload?.error === "string" && payload.error.trim()
        ? payload.error
        : responseText || response.statusText;
    throw new Error(`Publish failed (${response.status}): ${detail}`);
  }

  if (typeof payload?.assessmentVersionId !== "string" || !payload.assessmentVersionId) {
    throw new Error("Publish response did not include assessmentVersionId.");
  }

  process.stdout.write(`${payload.assessmentVersionId}\n`);
}

async function createFixturePackage(fixtureRoot) {
  const zip = new JSZip();
  const entries = await collectFixtureFiles(fixtureRoot);

  for (const entry of entries) {
    zip.file(entry.relativePath, await readFile(entry.absolutePath));
  }

  return zip.generateAsync({ type: "nodebuffer" });
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

function normalizeBaseUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function resolveFixtureRoot(fixture) {
  const normalized = fixture.trim();
  if (!normalized) {
    throw new Error("Fixture name must not be empty.");
  }

  return path.join(repoRoot, "tests", "fixtures", "qti", normalized);
}

async function collectFixtureFiles(fixtureRoot) {
  const directories = [fixtureRoot];
  const entries = [];

  while (directories.length > 0) {
    const directory = directories.pop();
    const children = await readdir(directory, { withFileTypes: true });

    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        directories.push(absolutePath);
        continue;
      }

      entries.push({
        absolutePath,
        relativePath: path.relative(fixtureRoot, absolutePath).replaceAll("\\", "/"),
      });
    }
  }

  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (entries.length === 0) {
    throw new Error(`Fixture root ${fixtureRoot} did not contain any files.`);
  }

  return entries;
}

function sanitizeSeed(value) {
  const trimmed = value.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "phase4";
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
