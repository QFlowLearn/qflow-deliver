import { parseStaffActorRole } from "@harbor/attempt-protocol";
import type { AssignmentActorSnapshot } from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new LaunchRequestError(400, "Request body must be valid JSON");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LaunchRequestError(400, "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

export function readAssignmentActor(value: unknown): AssignmentActorSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, "actor is required");
  }
  const record = value as Record<string, unknown>;
  const role = record.role;
  let parsedRole: AssignmentActorSnapshot["role"];
  if (role === "instructor" || role === "operator" || role === "system" || role === "qflow")
    parsedRole = role;
  else {
    const staffRole = parseStaffActorRole(role);
    if (!staffRole) throw new LaunchRequestError(400, "actor.role is invalid");
    parsedRole = staffRole;
  }
  if (typeof record.actorId !== "string" || !record.actorId.trim()) {
    throw new LaunchRequestError(400, "actor.actorId is required");
  }

  return {
    role: parsedRole,
    actorId: record.actorId.trim(),
    displayName: readOptionalString(record.displayName, "actor.displayName"),
  };
}

export function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LaunchRequestError(400, `${label} must be a finite number`);
  }
  return value;
}

export function readRequiredNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LaunchRequestError(400, message);
  }

  return value;
}

export function readOptionalString(value: unknown, label?: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new LaunchRequestError(
      400,
      label ? `${label} must be a string` : "Optional string values must be strings",
    );
  }
  return value.trim() ? value.trim() : null;
}

export function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LaunchRequestError(400, message);
  }

  return value.trim();
}

export function readRequiredStringField(
  body: Record<string, unknown>,
  key: string,
  message: string,
): string {
  return readRequiredString(body[key], message);
}

export function readCsvQueryParam(value: string | null): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readBoolean(value: unknown, message: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }

  throw new LaunchRequestError(400, message);
}

export function readOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LaunchRequestError(400, "Optional positive integer value is invalid");
  }

  return value;
}
