import {
  formatLtiServiceError,
  resolveLtiNrpsRoster,
  type LTISession,
  type Member,
} from "@longsightgroup/lti-tool";

import { ensureLearnerIdentity } from "../routes/auth/session";
import { LaunchRequestError } from "../launch/create-preview-attempt";
import { createLtiId } from "./ids";
import { getTenantLtiToolForSession } from "./tenant-routing";
import type { HarborLtiToolEnv } from "./tool";

interface LtiAttemptLaunchLinkRow {
  registration_id: string;
  lti_session_id: string;
  resource_link_id: string;
  context_id: string | null;
}

interface LtiResourceLinkSectionRow {
  section_id: string | null;
}

interface LtiSectionTenantRow {
  tenant_id: string;
}

interface LtiNrpsSyncScheduleResourceLinkRow {
  id: string;
  registration_id: string;
  resource_link_id: string;
  section_id: string | null;
}

interface LtiNrpsDueSyncScheduleRow {
  id: string;
  resource_link_row_id: string;
  registration_id: string;
  resource_link_id: string;
  section_id: string;
  interval_minutes: number;
  reconciliation_policy: LtiNrpsReconciliationPolicy;
  attempt_id: string | null;
}

export type LtiNrpsReconciliationPolicy = "additive-only" | "mark-inactive";

export interface LtiNrpsSyncResult {
  runId: string;
  attemptId: string;
  registrationId: string;
  ltiSessionId: string;
  resourceLinkId: string;
  sectionId: string;
  status: "complete" | "failed";
  totalMembers: number;
  learnerMembershipsUpserted: number;
  learnerMembershipsDeactivated: number;
  skippedMembers: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string;
}

export interface LtiNrpsSyncScheduleResult {
  scheduleId: string;
  resourceLinkRowId: string;
  registrationId: string;
  resourceLinkId: string;
  sectionId: string;
  enabled: boolean;
  intervalMinutes: number;
  reconciliationPolicy: LtiNrpsReconciliationPolicy;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LtiNrpsScheduledSyncSummary {
  checkedAt: string;
  dueScheduleCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
}

export async function syncLtiNrpsMembersForAttempt(input: {
  env: HarborLtiToolEnv;
  attemptId: string;
  reconciliationPolicy?: LtiNrpsReconciliationPolicy;
}): Promise<LtiNrpsSyncResult> {
  const launch = await readLtiAttemptLaunch(input.env.HARBOR_DB, input.attemptId);
  if (!launch) {
    throw new LaunchRequestError(404, "LTI attempt launch not found");
  }
  const sectionId = await readSectionIdForLtiAttempt({
    db: input.env.HARBOR_DB,
    registrationId: launch.registration_id,
    resourceLinkId: launch.resource_link_id,
  });

  const startedAt = new Date().toISOString();
  const runId = createLtiId("ltinrpsrun");
  const reconciliationPolicy = input.reconciliationPolicy ?? "additive-only";
  await upsertNrpsSyncRun({
    db: input.env.HARBOR_DB,
    run: {
      runId,
      attemptId: input.attemptId,
      registrationId: launch.registration_id,
      ltiSessionId: launch.lti_session_id,
      resourceLinkId: launch.resource_link_id,
      sectionId,
      status: "failed",
      totalMembers: 0,
      learnerMembershipsUpserted: 0,
      learnerMembershipsDeactivated: 0,
      skippedMembers: 0,
      errorMessage: null,
      startedAt,
      completedAt: null,
    },
  });

  try {
    const ltiTool = await getTenantLtiToolForSession(input.env, launch.lti_session_id);
    const ltiSession = await ltiTool.getSession(launch.lti_session_id);
    if (!ltiSession) {
      throw new LaunchRequestError(404, "LTI session not found");
    }
    const membersResult = await ltiTool.createAdvantage(ltiSession).getMembers();
    if (!membersResult.success) {
      throw new Error(formatLtiServiceError(membersResult.error));
    }

    const members = membersResult.data;
    const counts = await upsertLearnerMembershipsFromNrps({
      db: input.env.HARBOR_DB,
      ltiSession,
      sectionId,
      members,
      reconciliationPolicy,
    });
    const completedAt = new Date().toISOString();
    const result: LtiNrpsSyncResult = {
      runId,
      attemptId: input.attemptId,
      registrationId: launch.registration_id,
      ltiSessionId: launch.lti_session_id,
      resourceLinkId: launch.resource_link_id,
      sectionId,
      status: "complete",
      totalMembers: members.length,
      learnerMembershipsUpserted: counts.learnerMembershipsUpserted,
      learnerMembershipsDeactivated: counts.learnerMembershipsDeactivated,
      skippedMembers: counts.skippedMembers,
      errorMessage: null,
      startedAt,
      completedAt,
    };
    await upsertNrpsSyncRun({
      db: input.env.HARBOR_DB,
      run: result,
    });
    return result;
  } catch (error) {
    const completedAt = new Date().toISOString();
    const result: LtiNrpsSyncResult = {
      runId,
      attemptId: input.attemptId,
      registrationId: launch.registration_id,
      ltiSessionId: launch.lti_session_id,
      resourceLinkId: launch.resource_link_id,
      sectionId,
      status: "failed",
      totalMembers: 0,
      learnerMembershipsUpserted: 0,
      learnerMembershipsDeactivated: 0,
      skippedMembers: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
      startedAt,
      completedAt,
    };
    await upsertNrpsSyncRun({
      db: input.env.HARBOR_DB,
      run: result,
    });
    throw error;
  }
}

export async function upsertLtiNrpsSyncSchedule(input: {
  db: D1Database;
  resourceLinkRowId: string;
  enabled: boolean;
  intervalMinutes?: number | null;
  reconciliationPolicy?: LtiNrpsReconciliationPolicy | null;
  now?: string;
}): Promise<LtiNrpsSyncScheduleResult> {
  const resourceLink = await input.db
    .prepare(
      "SELECT id, registration_id, resource_link_id, section_id FROM lti_resource_links WHERE id = ?",
    )
    .bind(input.resourceLinkRowId)
    .first<LtiNrpsSyncScheduleResourceLinkRow>();
  if (!resourceLink) {
    throw new LaunchRequestError(404, "LTI resource link not found");
  }

  const sectionId = readOptionalString(resourceLink.section_id);
  if (!sectionId) {
    throw new LaunchRequestError(
      400,
      "LTI NRPS schedule requires a resource link mapped to a QFlowLearn Delivery section",
    );
  }

  const now = input.now ?? new Date().toISOString();
  const intervalMinutes = normalizeScheduleInterval(input.intervalMinutes);
  const reconciliationPolicy = normalizeReconciliationPolicy(input.reconciliationPolicy);
  const scheduleId = createLtiId("ltinrpssched");
  await input.db
    .prepare(
      `INSERT INTO lti_nrps_sync_schedules
         (id, resource_link_row_id, registration_id, resource_link_id, section_id, enabled, interval_minutes, reconciliation_policy, next_run_at, last_run_at, last_run_id, last_error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(resource_link_row_id) DO UPDATE SET
         registration_id = excluded.registration_id,
         resource_link_id = excluded.resource_link_id,
         section_id = excluded.section_id,
         enabled = excluded.enabled,
         interval_minutes = excluded.interval_minutes,
         reconciliation_policy = excluded.reconciliation_policy,
         next_run_at = excluded.next_run_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      scheduleId,
      resourceLink.id,
      resourceLink.registration_id,
      resourceLink.resource_link_id,
      sectionId,
      input.enabled ? 1 : 0,
      intervalMinutes,
      reconciliationPolicy,
      input.enabled ? now : addMinutes(now, intervalMinutes),
      now,
      now,
    )
    .run();

  const schedule = await input.db
    .prepare(
      `SELECT
         id,
         resource_link_row_id,
         registration_id,
         resource_link_id,
         section_id,
         enabled,
         interval_minutes,
         reconciliation_policy,
         next_run_at,
         last_run_at,
         last_run_id,
         last_error_message,
         created_at,
         updated_at
       FROM lti_nrps_sync_schedules
       WHERE resource_link_row_id = ?`,
    )
    .bind(resourceLink.id)
    .first<{
      id: string;
      resource_link_row_id: string;
      registration_id: string;
      resource_link_id: string;
      section_id: string;
      enabled: number;
      interval_minutes: number;
      reconciliation_policy: LtiNrpsReconciliationPolicy;
      next_run_at: string;
      last_run_at: string | null;
      last_run_id: string | null;
      last_error_message: string | null;
      created_at: string;
      updated_at: string;
    }>();
  if (!schedule) {
    throw new LaunchRequestError(500, "LTI NRPS schedule was not persisted");
  }

  return {
    scheduleId: schedule.id,
    resourceLinkRowId: schedule.resource_link_row_id,
    registrationId: schedule.registration_id,
    resourceLinkId: schedule.resource_link_id,
    sectionId: schedule.section_id,
    enabled: schedule.enabled === 1,
    intervalMinutes: schedule.interval_minutes,
    reconciliationPolicy: normalizeReconciliationPolicy(schedule.reconciliation_policy),
    nextRunAt: schedule.next_run_at,
    lastRunAt: schedule.last_run_at,
    lastRunId: schedule.last_run_id,
    lastErrorMessage: schedule.last_error_message,
    createdAt: schedule.created_at,
    updatedAt: schedule.updated_at,
  };
}

export async function runDueLtiNrpsSyncSchedules(input: {
  env: HarborLtiToolEnv;
  now?: string;
  limit?: number;
}): Promise<LtiNrpsScheduledSyncSummary> {
  const now = input.now ?? new Date().toISOString();
  const due = await input.env.HARBOR_DB.prepare(
    `SELECT
       schedules.id,
       schedules.resource_link_row_id,
       schedules.registration_id,
       schedules.resource_link_id,
       schedules.section_id,
       schedules.interval_minutes,
       schedules.reconciliation_policy,
       latest_launch.attempt_id
     FROM lti_nrps_sync_schedules schedules
     LEFT JOIN (
       SELECT launches.*
       FROM lti_attempt_launches launches
       INNER JOIN (
         SELECT registration_id, resource_link_id, MAX(created_at) AS latest_created_at
         FROM lti_attempt_launches
         WHERE nrps_membership_url IS NOT NULL
         GROUP BY registration_id, resource_link_id
       ) latest
         ON latest.registration_id = launches.registration_id
        AND latest.resource_link_id = launches.resource_link_id
        AND latest.latest_created_at = launches.created_at
     ) latest_launch
       ON latest_launch.registration_id = schedules.registration_id
      AND latest_launch.resource_link_id = schedules.resource_link_id
     WHERE schedules.enabled = 1
       AND schedules.next_run_at <= ?
     ORDER BY schedules.next_run_at ASC, schedules.id ASC
     LIMIT ?`,
  )
    .bind(now, input.limit ?? 25)
    .all<LtiNrpsDueSyncScheduleRow>();

  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const schedule of due.results) {
    const attemptId = readOptionalString(schedule.attempt_id);
    if (!attemptId) {
      skippedCount += 1;
      await markScheduleFailure({
        db: input.env.HARBOR_DB,
        schedule,
        now,
        errorMessage: "No NRPS-capable launch is available for this resource link",
      });
      continue;
    }

    try {
      const run = await syncLtiNrpsMembersForAttempt({
        env: input.env,
        attemptId,
        reconciliationPolicy: normalizeReconciliationPolicy(schedule.reconciliation_policy),
      });
      completedCount += 1;
      await input.env.HARBOR_DB.prepare(
        `UPDATE lti_nrps_sync_schedules
         SET last_run_at = ?,
             last_run_id = ?,
             last_error_message = NULL,
             next_run_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
        .bind(
          run.completedAt,
          run.runId,
          addMinutes(run.completedAt, schedule.interval_minutes),
          run.completedAt,
          schedule.id,
        )
        .run();
    } catch (error) {
      failedCount += 1;
      await markScheduleFailure({
        db: input.env.HARBOR_DB,
        schedule,
        now,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    checkedAt: now,
    dueScheduleCount: due.results.length,
    completedCount,
    failedCount,
    skippedCount,
  };
}

async function readLtiAttemptLaunch(
  db: D1Database,
  attemptId: string,
): Promise<LtiAttemptLaunchLinkRow | null> {
  return db
    .prepare(
      "SELECT registration_id, lti_session_id, resource_link_id, context_id FROM lti_attempt_launches WHERE attempt_id = ?",
    )
    .bind(attemptId)
    .first<LtiAttemptLaunchLinkRow>();
}

async function readSectionIdForLtiAttempt(input: {
  db: D1Database;
  registrationId: string;
  resourceLinkId: string;
}): Promise<string> {
  const link = await input.db
    .prepare(
      "SELECT section_id FROM lti_resource_links WHERE registration_id = ? AND resource_link_id = ?",
    )
    .bind(input.registrationId, input.resourceLinkId)
    .first<LtiResourceLinkSectionRow>();
  const sectionId = readOptionalString(link?.section_id);
  if (!sectionId) {
    throw new LaunchRequestError(
      400,
      "LTI NRPS sync requires a resource link mapped to a QFlowLearn Delivery section",
    );
  }

  return sectionId;
}

async function upsertLearnerMembershipsFromNrps(input: {
  db: D1Database;
  ltiSession: LTISession;
  sectionId: string;
  members: Member[];
  reconciliationPolicy: LtiNrpsReconciliationPolicy;
}): Promise<{
  learnerMembershipsUpserted: number;
  learnerMembershipsDeactivated: number;
  skippedMembers: number;
}> {
  let learnerMembershipsUpserted = 0;
  const syncedLearnerIds: string[] = [];
  const tenantId = await readSectionTenantId(input.db, input.sectionId);
  const roster = resolveLtiNrpsRoster(input.members);
  const uniqueLearnerMembers = new Map(
    roster.learnerMembers.map((member) => [member.userId, member]),
  );

  for (const member of uniqueLearnerMembers.values()) {
    const learner = await ensureLearnerIdentity({
      db: input.db,
      tenantId,
      providerKind: "lti",
      issuer: input.ltiSession.platform.issuer,
      subject: member.userId,
      displayName: member.displayName,
      email: readOptionalString(member.email),
    });
    syncedLearnerIds.push(learner.id);
    await ensureSectionMembership({
      db: input.db,
      learnerId: learner.id,
      sectionId: input.sectionId,
      role: "learner",
      status: normalizeNrpsMembershipStatus(member.status),
    });
    learnerMembershipsUpserted += 1;
  }

  const learnerMembershipsDeactivated =
    input.reconciliationPolicy === "mark-inactive"
      ? await deactivateMissingLearnerMemberships({
          db: input.db,
          sectionId: input.sectionId,
          activeLearnerIds: syncedLearnerIds,
        })
      : 0;

  return {
    learnerMembershipsUpserted,
    learnerMembershipsDeactivated,
    skippedMembers: roster.members.length - uniqueLearnerMembers.size,
  };
}

async function readSectionTenantId(db: D1Database, sectionId: string): Promise<string> {
  const row = await db
    .prepare("SELECT tenant_id FROM sections WHERE id = ?")
    .bind(sectionId)
    .first<LtiSectionTenantRow>();
  const tenantId = readOptionalString(row?.tenant_id);
  if (!tenantId) {
    throw new LaunchRequestError(400, "LTI NRPS sync requires a valid section");
  }

  return tenantId;
}

async function ensureSectionMembership(input: {
  db: D1Database;
  learnerId: string;
  sectionId: string;
  role: string;
  status: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await input.db
    .prepare(
      "INSERT INTO section_memberships (id, section_id, learner_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(section_id, learner_id) DO UPDATE SET role = excluded.role, status = excluded.status, updated_at = excluded.updated_at",
    )
    .bind(
      createLtiId("membership"),
      input.sectionId,
      input.learnerId,
      input.role,
      input.status,
      now,
      now,
    )
    .run();
}

async function deactivateMissingLearnerMemberships(input: {
  db: D1Database;
  sectionId: string;
  activeLearnerIds: string[];
}): Promise<number> {
  const now = new Date().toISOString();
  const learnerFilter =
    input.activeLearnerIds.length > 0
      ? `AND learner_id NOT IN (${input.activeLearnerIds.map(() => "?").join(", ")})`
      : "";
  const result = await input.db
    .prepare(
      `UPDATE section_memberships
       SET status = ?, updated_at = ?
       WHERE section_id = ?
         AND role = ?
         AND status = ?
         ${learnerFilter}`,
    )
    .bind("inactive", now, input.sectionId, "learner", "active", ...input.activeLearnerIds)
    .run();

  return result.meta.changes ?? 0;
}

async function upsertNrpsSyncRun(input: {
  db: D1Database;
  run: Omit<LtiNrpsSyncResult, "completedAt" | "status"> & {
    status: "complete" | "failed";
    completedAt: string | null;
  };
}): Promise<void> {
  const now = new Date().toISOString();
  await input.db
    .prepare(
      "INSERT INTO lti_nrps_sync_runs (id, attempt_id, registration_id, lti_session_id, resource_link_id, section_id, status, total_members, learner_memberships_upserted, learner_memberships_deactivated, skipped_members, error_message, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, total_members = excluded.total_members, learner_memberships_upserted = excluded.learner_memberships_upserted, learner_memberships_deactivated = excluded.learner_memberships_deactivated, skipped_members = excluded.skipped_members, error_message = excluded.error_message, completed_at = excluded.completed_at, updated_at = excluded.updated_at",
    )
    .bind(
      input.run.runId,
      input.run.attemptId,
      input.run.registrationId,
      input.run.ltiSessionId,
      input.run.resourceLinkId,
      input.run.sectionId,
      input.run.status,
      input.run.totalMembers,
      input.run.learnerMembershipsUpserted,
      input.run.learnerMembershipsDeactivated,
      input.run.skippedMembers,
      input.run.errorMessage,
      input.run.startedAt,
      input.run.completedAt,
      now,
      now,
    )
    .run();
}

async function markScheduleFailure(input: {
  db: D1Database;
  schedule: LtiNrpsDueSyncScheduleRow;
  now: string;
  errorMessage: string;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE lti_nrps_sync_schedules
       SET last_error_message = ?,
           next_run_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.errorMessage,
      addMinutes(input.now, input.schedule.interval_minutes),
      input.now,
      input.schedule.id,
    )
    .run();
}

function normalizeScheduleInterval(value: number | null | undefined): number {
  if (value === undefined || value === null) {
    return 1440;
  }
  if (!Number.isInteger(value) || value < 15 || value > 10080) {
    throw new LaunchRequestError(400, "intervalMinutes must be an integer between 15 and 10080");
  }

  return value;
}

function normalizeReconciliationPolicy(
  value: string | null | undefined,
): LtiNrpsReconciliationPolicy {
  if (value === undefined || value === null || value === "") {
    return "additive-only";
  }
  if (value === "additive-only" || value === "mark-inactive") {
    return value;
  }

  throw new LaunchRequestError(400, "reconciliationPolicy must be additive-only or mark-inactive");
}

function addMinutes(isoTimestamp: string, minutes: number): string {
  return new Date(Date.parse(isoTimestamp) + minutes * 60_000).toISOString();
}

function normalizeNrpsMembershipStatus(status: string): string {
  return status.trim().toLowerCase() === "active" ? "active" : "inactive";
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
