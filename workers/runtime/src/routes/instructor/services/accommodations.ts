import {
  type AssignmentActorSnapshot,
  type HarborAccommodationProfileDefinition,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import {
  createId,
  parseAccommodationProfileDefinition,
  requireLearnerRecord,
} from "./json-parsers";
import type { AccommodationProfileRow, LearnerAccommodationAssignmentRow } from "./types";

async function readAccommodationProfileRow(
  db: D1Database,
  profileId: string,
): Promise<AccommodationProfileRow | null> {
  return db
    .prepare(
      "SELECT id, tenant_id, name, description, status, profile_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at FROM accommodation_profiles WHERE id = ?",
    )
    .bind(profileId)
    .first<AccommodationProfileRow>();
}

async function requireAccommodationProfileRow(
  db: D1Database,
  profileId: string,
): Promise<AccommodationProfileRow> {
  const row = await readAccommodationProfileRow(db, profileId);
  if (!row) {
    throw new LaunchRequestError(404, "Accommodation profile not found");
  }

  return row;
}

async function readLearnerAccommodationAssignmentRow(
  db: D1Database,
  assignmentId: string,
): Promise<LearnerAccommodationAssignmentRow | null> {
  return db
    .prepare(
      `SELECT learner_accommodation_assignments.id,
              learner_accommodation_assignments.tenant_id,
              learner_accommodation_assignments.learner_id,
              learner_accommodation_assignments.profile_id,
              accommodation_profiles.name AS profile_name,
              learner_accommodation_assignments.status,
              learner_accommodation_assignments.source_kind,
              learner_accommodation_assignments.effective_at,
              learner_accommodation_assignments.expires_at,
              learner_accommodation_assignments.created_at,
              learner_accommodation_assignments.updated_at
         FROM learner_accommodation_assignments
         INNER JOIN accommodation_profiles
           ON accommodation_profiles.id = learner_accommodation_assignments.profile_id
          AND accommodation_profiles.tenant_id = learner_accommodation_assignments.tenant_id
        WHERE learner_accommodation_assignments.id = ?`,
    )
    .bind(assignmentId)
    .first<LearnerAccommodationAssignmentRow>();
}

function mapAccommodationProfileRow(row: AccommodationProfileRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    status: row.status,
    profile: parseAccommodationProfileDefinition(row.profile_json),
    createdBy:
      row.created_by_role && row.created_by_id
        ? {
            role: row.created_by_role,
            actorId: row.created_by_id,
            displayName: row.created_by_display_name,
          }
        : null,
    updatedBy:
      row.updated_by_role && row.updated_by_id
        ? {
            role: row.updated_by_role,
            actorId: row.updated_by_id,
            displayName: row.updated_by_display_name,
          }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLearnerAccommodationAssignmentRow(row: LearnerAccommodationAssignmentRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    learnerId: row.learner_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    status: row.status,
    sourceKind: row.source_kind,
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readAccommodationProfiles(input: {
  db: D1Database;
  tenantId: string | null;
}): Promise<{ profiles: AccommodationProfileRecord[] }> {
  const query = input.tenantId
    ? input.db
        .prepare(
          "SELECT id, tenant_id, name, description, status, profile_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at FROM accommodation_profiles WHERE tenant_id = ? ORDER BY updated_at DESC, id DESC",
        )
        .bind(input.tenantId)
    : input.db.prepare(
        "SELECT id, tenant_id, name, description, status, profile_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at FROM accommodation_profiles ORDER BY updated_at DESC, id DESC",
      );
  const rows = await query.all<AccommodationProfileRow>();
  return { profiles: rows.results.map(mapAccommodationProfileRow) };
}

export async function createAccommodationProfile(input: {
  db: D1Database;
  request: {
    profileId?: string;
    tenantId: string;
    name: string;
    description: string | null;
    status: "draft" | "active" | "inactive";
    profile: HarborAccommodationProfileDefinition;
    actor: AssignmentActorSnapshot;
  };
}): Promise<AccommodationProfileRecord> {
  const now = new Date().toISOString();
  const profileId = input.request.profileId ?? createId("accprof");
  const existing = await readAccommodationProfileRow(input.db, profileId);
  if (existing) {
    throw new LaunchRequestError(409, "Accommodation profile already exists");
  }

  await input.db
    .prepare(
      "INSERT INTO accommodation_profiles (id, tenant_id, name, description, status, profile_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      profileId,
      input.request.tenantId,
      input.request.name,
      input.request.description,
      input.request.status,
      JSON.stringify(input.request.profile),
      input.request.actor.role,
      input.request.actor.actorId,
      input.request.actor.displayName,
      input.request.actor.role,
      input.request.actor.actorId,
      input.request.actor.displayName,
      now,
      now,
    )
    .run();

  return mapAccommodationProfileRow(await requireAccommodationProfileRow(input.db, profileId));
}

export async function updateAccommodationProfile(input: {
  db: D1Database;
  profileId: string;
  request: {
    name?: string;
    description?: string | null;
    status?: "draft" | "active" | "inactive";
    profile?: HarborAccommodationProfileDefinition;
    actor: AssignmentActorSnapshot;
  };
}): Promise<AccommodationProfileRecord> {
  const existing = await requireAccommodationProfileRow(input.db, input.profileId);
  const now = new Date().toISOString();
  await input.db
    .prepare(
      "UPDATE accommodation_profiles SET name = ?, description = ?, status = ?, profile_json = ?, updated_by_role = ?, updated_by_id = ?, updated_by_display_name = ?, updated_at = ? WHERE id = ?",
    )
    .bind(
      input.request.name ?? existing.name,
      input.request.description !== undefined ? input.request.description : existing.description,
      input.request.status ?? existing.status,
      JSON.stringify(
        input.request.profile ?? parseAccommodationProfileDefinition(existing.profile_json),
      ),
      input.request.actor.role,
      input.request.actor.actorId,
      input.request.actor.displayName,
      now,
      input.profileId,
    )
    .run();

  return mapAccommodationProfileRow(
    await requireAccommodationProfileRow(input.db, input.profileId),
  );
}

export async function readLearnerAccommodationAssignments(input: {
  db: D1Database;
  learnerId: string;
}): Promise<{ assignments: LearnerAccommodationAssignmentRecord[] }> {
  await requireLearnerRecord(input.db, input.learnerId);
  const rows = await input.db
    .prepare(
      `SELECT learner_accommodation_assignments.id,
              learner_accommodation_assignments.tenant_id,
              learner_accommodation_assignments.learner_id,
              learner_accommodation_assignments.profile_id,
              accommodation_profiles.name AS profile_name,
              learner_accommodation_assignments.status,
              learner_accommodation_assignments.source_kind,
              learner_accommodation_assignments.effective_at,
              learner_accommodation_assignments.expires_at,
              learner_accommodation_assignments.created_at,
              learner_accommodation_assignments.updated_at
         FROM learner_accommodation_assignments
         INNER JOIN accommodation_profiles
           ON accommodation_profiles.id = learner_accommodation_assignments.profile_id
          AND accommodation_profiles.tenant_id = learner_accommodation_assignments.tenant_id
        WHERE learner_accommodation_assignments.learner_id = ?
        ORDER BY learner_accommodation_assignments.updated_at DESC, learner_accommodation_assignments.id DESC`,
    )
    .bind(input.learnerId)
    .all<LearnerAccommodationAssignmentRow>();

  return {
    assignments: rows.results.map(mapLearnerAccommodationAssignmentRow),
  };
}

export async function upsertLearnerAccommodationAssignment(input: {
  db: D1Database;
  learnerId: string;
  profileId: string;
  request: {
    status: "active" | "inactive";
    sourceKind: string;
    effectiveAt: string;
    expiresAt: string | null;
  };
}): Promise<LearnerAccommodationAssignmentRecord> {
  const learner = await requireLearnerRecord(input.db, input.learnerId);
  const profile = await requireAccommodationProfileRow(input.db, input.profileId);
  if (profile.tenant_id !== learner.tenant_id) {
    throw new LaunchRequestError(
      400,
      "Accommodation profile and learner must belong to the same tenant",
    );
  }

  const existing = await input.db
    .prepare(
      "SELECT id FROM learner_accommodation_assignments WHERE tenant_id = ? AND learner_id = ? AND profile_id = ?",
    )
    .bind(learner.tenant_id, input.learnerId, input.profileId)
    .first<{ id: string }>();
  const now = new Date().toISOString();
  const assignmentId = existing?.id ?? createId("accassign");

  await input.db
    .prepare(
      "INSERT INTO learner_accommodation_assignments (id, tenant_id, learner_id, profile_id, status, source_kind, effective_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, learner_id, profile_id) DO UPDATE SET status = excluded.status, source_kind = excluded.source_kind, effective_at = excluded.effective_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
    )
    .bind(
      assignmentId,
      learner.tenant_id,
      input.learnerId,
      input.profileId,
      input.request.status,
      input.request.sourceKind,
      input.request.effectiveAt,
      input.request.expiresAt,
      now,
      now,
    )
    .run();

  const row = await readLearnerAccommodationAssignmentRow(input.db, assignmentId);
  if (!row) {
    throw new LaunchRequestError(500, "Learner accommodation assignment was not saved");
  }

  return mapLearnerAccommodationAssignmentRow(row);
}

export type AccommodationProfileRecord = ReturnType<typeof mapAccommodationProfileRow>;

export type LearnerAccommodationAssignmentRecord = ReturnType<
  typeof mapLearnerAccommodationAssignmentRow
>;
