import {
  type InstructorLmsDeepLinkPlacementSummary,
  type InstructorLmsNrpsSyncRun,
  type InstructorLmsNrpsSyncSchedule,
  type InstructorLmsRegistrationSummary,
  type InstructorLmsResourceLinkSummary,
} from "@harbor/attempt-protocol";
import { LaunchRequestError } from "../../../launch/create-preview-attempt";
import { buildCsv } from "../../../reports/csv";
import type { LtiNrpsSyncScheduleResult } from "../../../lti/nrps-sync";
import type {
  InstructorEnv,
  LmsDeepLinkPlacementSummaryRow,
  LmsNrpsSyncRunRow,
  LmsRegistrationSummaryRow,
  LmsResourceLinkSummaryRow,
} from "./types";

interface InstructorLmsIntegrationsSnapshot {
  readonly generatedAt: string;
  readonly registrations: InstructorLmsRegistrationSummary[];
  readonly resourceLinks: InstructorLmsResourceLinkSummary[];
  readonly deepLinkPlacements: InstructorLmsDeepLinkPlacementSummary[];
  readonly nrpsSyncRuns: InstructorLmsNrpsSyncRun[];
}

export async function readInstructorLmsIntegrations(input: {
  db: D1Database;
  tenantId: string;
}): Promise<InstructorLmsIntegrationsSnapshot> {
  const [registrationRows, resourceLinkRows, placementRows, syncRunRows] = await Promise.all([
    input.db
      .prepare(
        `WITH tenant_resource_links AS (
             SELECT links.registration_id, links.resource_link_id
             FROM lti_resource_links links
             INNER JOIN sections
               ON sections.id = links.section_id
              AND sections.tenant_id = ?
           ),
           tenant_deep_link_placements AS (
             SELECT placements.registration_id
             FROM lti_deep_link_placements placements
             INNER JOIN sections
               ON sections.id = placements.section_id
              AND sections.tenant_id = ?
           )
           SELECT
             registrations.id,
             registrations.issuer,
             registrations.client_id,
             registrations.deployment_id,
             registrations.authorization_endpoint,
             registrations.token_endpoint,
             registrations.jwks_url,
             registrations.created_at,
             registrations.updated_at,
             COALESCE(resource_links.count, 0) AS resource_link_count,
             COALESCE(deep_link_placements.count, 0) AS deep_link_placement_count,
             COALESCE(launches.count, 0) AS launch_count,
             COALESCE(launches.ags_count, 0) AS ags_launch_count,
             COALESCE(launches.nrps_count, 0) AS nrps_launch_count,
             launches.last_launch_at
           FROM lti_registrations registrations
           LEFT JOIN (
             SELECT registration_id, COUNT(*) AS count
             FROM tenant_resource_links
             GROUP BY registration_id
           ) resource_links ON resource_links.registration_id = registrations.id
           LEFT JOIN (
             SELECT registration_id, COUNT(*) AS count
             FROM tenant_deep_link_placements
             GROUP BY registration_id
           ) deep_link_placements ON deep_link_placements.registration_id = registrations.id
           LEFT JOIN (
             SELECT
               launches.registration_id,
               COUNT(*) AS count,
               SUM(CASE WHEN launches.ags_lineitem_url IS NOT NULL OR launches.ags_lineitems_url IS NOT NULL THEN 1 ELSE 0 END) AS ags_count,
               SUM(CASE WHEN launches.nrps_membership_url IS NOT NULL THEN 1 ELSE 0 END) AS nrps_count,
               MAX(launches.created_at) AS last_launch_at
             FROM lti_attempt_launches launches
             INNER JOIN tenant_resource_links links
               ON links.registration_id = launches.registration_id
              AND links.resource_link_id = launches.resource_link_id
             GROUP BY launches.registration_id
           ) launches ON launches.registration_id = registrations.id
           WHERE registrations.tenant_id = ?
           ORDER BY registrations.updated_at DESC, registrations.id DESC`,
      )
      .bind(input.tenantId, input.tenantId, input.tenantId)
      .all<LmsRegistrationSummaryRow>(),
    input.db
      .prepare(
        `SELECT
             links.id,
             links.registration_id,
             links.assignment_id,
             assignments.title AS assignment_title,
             links.resource_link_id,
             links.context_id,
             links.section_id,
             sections.title AS section_title,
             links.created_at,
             links.updated_at,
             latest_launch.attempt_id AS latest_attempt_id,
             latest_launch.created_at AS latest_launch_at,
             CASE WHEN latest_launch.ags_lineitem_url IS NOT NULL OR latest_launch.ags_lineitems_url IS NOT NULL THEN 1 ELSE 0 END AS ags_available,
             CASE WHEN latest_launch.nrps_membership_url IS NOT NULL THEN 1 ELSE 0 END AS nrps_available,
             schedules.id AS schedule_id,
             schedules.enabled AS schedule_enabled,
             schedules.interval_minutes AS schedule_interval_minutes,
             schedules.reconciliation_policy AS schedule_reconciliation_policy,
             schedules.next_run_at AS schedule_next_run_at,
             schedules.last_run_at AS schedule_last_run_at,
             schedules.last_run_id AS schedule_last_run_id,
             schedules.last_error_message AS schedule_last_error_message,
             schedules.created_at AS schedule_created_at,
             schedules.updated_at AS schedule_updated_at
           FROM lti_resource_links links
           INNER JOIN assignments ON assignments.id = links.assignment_id
           INNER JOIN sections
             ON sections.id = links.section_id
            AND sections.tenant_id = ?
           LEFT JOIN lti_nrps_sync_schedules schedules
             ON schedules.resource_link_row_id = links.id
           LEFT JOIN (
             SELECT launches.*
             FROM lti_attempt_launches launches
             INNER JOIN (
               SELECT registration_id, resource_link_id, MAX(created_at) AS latest_created_at
               FROM lti_attempt_launches
               GROUP BY registration_id, resource_link_id
             ) latest
               ON latest.registration_id = launches.registration_id
              AND latest.resource_link_id = launches.resource_link_id
              AND latest.latest_created_at = launches.created_at
           ) latest_launch
             ON latest_launch.registration_id = links.registration_id
            AND latest_launch.resource_link_id = links.resource_link_id
           ORDER BY links.updated_at DESC, links.id DESC
           LIMIT 200`,
      )
      .bind(input.tenantId)
      .all<LmsResourceLinkSummaryRow>(),
    input.db
      .prepare(
        `SELECT
             placements.id,
             placements.registration_id,
             placements.lti_session_id,
             placements.placement_key,
             placements.assignment_id,
             assignments.title AS assignment_title,
             placements.context_id,
             placements.section_id,
             sections.title AS section_title,
             placements.title,
             placements.text,
             placements.line_item_label,
             placements.line_item_score_maximum,
             placements.line_item_tag,
             placements.linked_resource_link_id,
             placements.linked_at,
             placements.created_at,
             placements.updated_at
           FROM lti_deep_link_placements placements
           INNER JOIN assignments ON assignments.id = placements.assignment_id
           INNER JOIN sections
             ON sections.id = placements.section_id
            AND sections.tenant_id = ?
           ORDER BY placements.created_at DESC, placements.id DESC
           LIMIT 100`,
      )
      .bind(input.tenantId)
      .all<LmsDeepLinkPlacementSummaryRow>(),
    input.db
      .prepare(
        `SELECT
             runs.id,
             runs.attempt_id,
             runs.registration_id,
             runs.lti_session_id,
             runs.resource_link_id,
             runs.section_id,
             runs.status,
             runs.total_members,
             runs.learner_memberships_upserted,
             runs.learner_memberships_deactivated,
             runs.skipped_members,
             runs.error_message,
             runs.started_at,
             runs.completed_at
           FROM lti_nrps_sync_runs runs
           INNER JOIN sections
             ON sections.id = runs.section_id
            AND sections.tenant_id = ?
           ORDER BY runs.started_at DESC, runs.id DESC
           LIMIT 50`,
      )
      .bind(input.tenantId)
      .all<LmsNrpsSyncRunRow>(),
  ]);

  const syncRuns = syncRunRows.results.map(mapLmsNrpsSyncRun);
  const latestSyncByRegistration = new Map<string, InstructorLmsNrpsSyncRun>();
  const latestSyncByResource = new Map<string, InstructorLmsNrpsSyncRun>();
  for (const run of syncRuns) {
    if (!latestSyncByRegistration.has(run.registrationId)) {
      latestSyncByRegistration.set(run.registrationId, run);
    }
    const resourceSyncKey = `${run.registrationId}\u0000${run.resourceLinkId}`;
    if (!latestSyncByResource.has(resourceSyncKey)) {
      latestSyncByResource.set(resourceSyncKey, run);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    registrations: registrationRows.results.map((row) => ({
      id: row.id,
      issuer: row.issuer,
      clientId: row.client_id,
      deploymentId: row.deployment_id,
      authorizationEndpoint: row.authorization_endpoint,
      tokenEndpoint: row.token_endpoint,
      jwksUrl: row.jwks_url,
      resourceLinkCount: row.resource_link_count,
      deepLinkPlacementCount: row.deep_link_placement_count,
      launchCount: row.launch_count,
      agsLaunchCount: row.ags_launch_count,
      nrpsLaunchCount: row.nrps_launch_count,
      lastLaunchAt: row.last_launch_at,
      lastNrpsSync: latestSyncByRegistration.get(row.id) ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    resourceLinks: resourceLinkRows.results.map((row) =>
      mapLmsResourceLinkSummary(row, latestSyncByResource),
    ),
    deepLinkPlacements: placementRows.results.map(mapLmsDeepLinkPlacementSummary),
    nrpsSyncRuns: syncRuns,
  };
}

function mapLmsResourceLinkSummary(
  row: LmsResourceLinkSummaryRow,
  latestSyncByResource: Map<string, InstructorLmsNrpsSyncRun>,
): InstructorLmsResourceLinkSummary {
  return {
    id: row.id,
    registrationId: row.registration_id,
    assignmentId: row.assignment_id,
    assignmentTitle: row.assignment_title,
    resourceLinkId: row.resource_link_id,
    contextId: row.context_id,
    sectionId: row.section_id,
    sectionTitle: row.section_title,
    latestAttemptId: row.latest_attempt_id,
    latestLaunchAt: row.latest_launch_at,
    agsAvailable: row.ags_available === 1,
    nrpsAvailable: row.nrps_available === 1,
    latestNrpsSync:
      latestSyncByResource.get(`${row.registration_id}\u0000${row.resource_link_id}`) ?? null,
    nrpsSyncSchedule: mapOptionalLmsNrpsSyncSchedule(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOptionalLmsNrpsSyncSchedule(
  row: LmsResourceLinkSummaryRow,
): InstructorLmsNrpsSyncSchedule | null {
  if (!row.schedule_id) {
    return null;
  }

  return {
    id: row.schedule_id,
    resourceLinkId: row.id,
    enabled: row.schedule_enabled === 1,
    intervalMinutes: row.schedule_interval_minutes ?? 1440,
    reconciliationPolicy: row.schedule_reconciliation_policy ?? "additive-only",
    nextRunAt: row.schedule_next_run_at ?? row.updated_at,
    lastRunAt: row.schedule_last_run_at,
    lastRunId: row.schedule_last_run_id,
    lastErrorMessage: row.schedule_last_error_message,
    createdAt: row.schedule_created_at ?? row.created_at,
    updatedAt: row.schedule_updated_at ?? row.updated_at,
  };
}

function mapLmsDeepLinkPlacementSummary(
  row: LmsDeepLinkPlacementSummaryRow,
): InstructorLmsDeepLinkPlacementSummary {
  return {
    id: row.id,
    registrationId: row.registration_id,
    ltiSessionId: row.lti_session_id,
    placementKey: row.placement_key,
    assignmentId: row.assignment_id,
    assignmentTitle: row.assignment_title,
    contextId: row.context_id,
    sectionId: row.section_id,
    sectionTitle: row.section_title,
    title: row.title,
    text: row.text,
    lineItemLabel: row.line_item_label,
    lineItemScoreMaximum: row.line_item_score_maximum,
    lineItemTag: row.line_item_tag,
    linkedResourceLinkId: row.linked_resource_link_id,
    linkedAt: row.linked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLmsNrpsSyncRun(row: LmsNrpsSyncRunRow): InstructorLmsNrpsSyncRun {
  return {
    runId: row.id,
    attemptId: row.attempt_id,
    registrationId: row.registration_id,
    ltiSessionId: row.lti_session_id,
    resourceLinkId: row.resource_link_id,
    sectionId: row.section_id,
    status: row.status,
    totalMembers: row.total_members,
    learnerMembershipsUpserted: row.learner_memberships_upserted,
    learnerMembershipsDeactivated: row.learner_memberships_deactivated,
    skippedMembers: row.skipped_members,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function mapLtiNrpsScheduleResult(
  schedule: LtiNrpsSyncScheduleResult,
): InstructorLmsNrpsSyncSchedule {
  return {
    id: schedule.scheduleId,
    resourceLinkId: schedule.resourceLinkRowId,
    enabled: schedule.enabled,
    intervalMinutes: schedule.intervalMinutes,
    reconciliationPolicy: schedule.reconciliationPolicy,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastRunId: schedule.lastRunId,
    lastErrorMessage: schedule.lastErrorMessage,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

export async function assertLtiAttemptBelongsToTenant(input: {
  db: D1Database;
  attemptId: string;
  tenantId: string;
}): Promise<void> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS matched
       FROM lti_attempt_launches launches
       INNER JOIN lti_resource_links links
         ON links.registration_id = launches.registration_id
        AND links.resource_link_id = launches.resource_link_id
       INNER JOIN sections
         ON sections.id = links.section_id
        AND sections.tenant_id = ?
       WHERE launches.attempt_id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId, input.attemptId)
    .first<{ matched: number }>();
  if (!row) {
    throw new LaunchRequestError(404, "LTI attempt launch not found");
  }
}

export async function assertLtiResourceLinkBelongsToTenant(input: {
  db: D1Database;
  resourceLinkRowId: string;
  tenantId: string;
}): Promise<void> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS matched
       FROM lti_resource_links links
       INNER JOIN sections
         ON sections.id = links.section_id
        AND sections.tenant_id = ?
       WHERE links.id = ?
       LIMIT 1`,
    )
    .bind(input.tenantId, input.resourceLinkRowId)
    .first<{ matched: number }>();
  if (!row) {
    throw new LaunchRequestError(404, "LTI resource link not found");
  }
}

export function buildInstructorLmsEvidenceCsv(report: InstructorLmsIntegrationsSnapshot): string {
  const rows: Array<Array<string | number | boolean | null>> = [
    ["section", "record_id", "registration_id", "resource_link_id", "key", "value", "evidence_at"],
    ["summary", "generated_at", null, null, "generated_at", report.generatedAt, report.generatedAt],
    [
      "summary",
      "registrations",
      null,
      null,
      "total_registrations",
      report.registrations.length,
      report.generatedAt,
    ],
    [
      "summary",
      "resource_links",
      null,
      null,
      "total_resource_links",
      report.resourceLinks.length,
      report.generatedAt,
    ],
    [
      "summary",
      "deep_link_placements",
      null,
      null,
      "total_deep_link_placements",
      report.deepLinkPlacements.length,
      report.generatedAt,
    ],
    [
      "summary",
      "nrps_sync_runs",
      null,
      null,
      "total_nrps_sync_runs",
      report.nrpsSyncRuns.length,
      report.generatedAt,
    ],
  ];

  for (const registration of report.registrations) {
    rows.push(
      [
        "registration",
        registration.id,
        registration.id,
        null,
        "issuer",
        registration.issuer,
        registration.updatedAt,
      ],
      [
        "registration",
        registration.id,
        registration.id,
        null,
        "launch_count",
        registration.launchCount,
        registration.lastLaunchAt,
      ],
      [
        "registration",
        registration.id,
        registration.id,
        null,
        "ags_launch_count",
        registration.agsLaunchCount,
        registration.lastLaunchAt,
      ],
      [
        "registration",
        registration.id,
        registration.id,
        null,
        "nrps_launch_count",
        registration.nrpsLaunchCount,
        registration.lastLaunchAt,
      ],
    );
  }

  for (const link of report.resourceLinks) {
    rows.push(
      [
        "resource_link",
        link.id,
        link.registrationId,
        link.resourceLinkId,
        "assignment",
        link.assignmentTitle,
        link.updatedAt,
      ],
      [
        "resource_link",
        link.id,
        link.registrationId,
        link.resourceLinkId,
        "section",
        link.sectionTitle ?? link.sectionId,
        link.updatedAt,
      ],
      [
        "resource_link",
        link.id,
        link.registrationId,
        link.resourceLinkId,
        "ags_available",
        link.agsAvailable,
        link.latestLaunchAt,
      ],
      [
        "resource_link",
        link.id,
        link.registrationId,
        link.resourceLinkId,
        "nrps_available",
        link.nrpsAvailable,
        link.latestLaunchAt,
      ],
      [
        "resource_link",
        link.id,
        link.registrationId,
        link.resourceLinkId,
        "nrps_schedule_enabled",
        link.nrpsSyncSchedule?.enabled ?? false,
        link.nrpsSyncSchedule?.updatedAt ?? link.updatedAt,
      ],
      [
        "resource_link",
        link.id,
        link.registrationId,
        link.resourceLinkId,
        "nrps_schedule_reconciliation_policy",
        link.nrpsSyncSchedule?.reconciliationPolicy ?? "additive-only",
        link.nrpsSyncSchedule?.updatedAt ?? link.updatedAt,
      ],
      [
        "resource_link",
        link.id,
        link.registrationId,
        link.resourceLinkId,
        "nrps_schedule_next_run_at",
        link.nrpsSyncSchedule?.nextRunAt ?? null,
        link.nrpsSyncSchedule?.updatedAt ?? link.updatedAt,
      ],
    );
  }

  for (const placement of report.deepLinkPlacements) {
    rows.push(
      [
        "deep_link_placement",
        placement.id,
        placement.registrationId,
        placement.linkedResourceLinkId,
        "placement_key",
        placement.placementKey,
        placement.createdAt,
      ],
      [
        "deep_link_placement",
        placement.id,
        placement.registrationId,
        placement.linkedResourceLinkId,
        "assignment",
        placement.assignmentTitle,
        placement.createdAt,
      ],
      [
        "deep_link_placement",
        placement.id,
        placement.registrationId,
        placement.linkedResourceLinkId,
        "linked_at",
        placement.linkedAt,
        placement.linkedAt ?? placement.createdAt,
      ],
    );
  }

  for (const run of report.nrpsSyncRuns) {
    rows.push(
      [
        "nrps_sync_run",
        run.runId,
        run.registrationId,
        run.resourceLinkId,
        "status",
        run.status,
        run.completedAt ?? run.startedAt,
      ],
      [
        "nrps_sync_run",
        run.runId,
        run.registrationId,
        run.resourceLinkId,
        "learner_memberships_upserted",
        run.learnerMembershipsUpserted,
        run.completedAt ?? run.startedAt,
      ],
      [
        "nrps_sync_run",
        run.runId,
        run.registrationId,
        run.resourceLinkId,
        "learner_memberships_deactivated",
        run.learnerMembershipsDeactivated,
        run.completedAt ?? run.startedAt,
      ],
      [
        "nrps_sync_run",
        run.runId,
        run.registrationId,
        run.resourceLinkId,
        "skipped_members",
        run.skippedMembers,
        run.completedAt ?? run.startedAt,
      ],
    );
  }

  return buildCsv(rows);
}

export function requireLtiToolEnv(env: InstructorEnv): InstructorEnv & {
  BOOTSTRAP_SIGNING_SECRET: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
} {
  if (!env.BOOTSTRAP_SIGNING_SECRET) {
    throw new LaunchRequestError(503, "BOOTSTRAP_SIGNING_SECRET is required for LTI services");
  }
  if (!env.LTI_TOOL_PRIVATE_KEY_JWK) {
    throw new LaunchRequestError(503, "LTI_TOOL_PRIVATE_KEY_JWK is required for LTI services");
  }

  return env as InstructorEnv & {
    BOOTSTRAP_SIGNING_SECRET: string;
    LTI_TOOL_PRIVATE_KEY_JWK: string;
  };
}

export function readOptionalReconciliationPolicy(
  value: unknown,
): "additive-only" | "mark-inactive" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "additive-only" || value === "mark-inactive") {
    return value;
  }

  throw new LaunchRequestError(400, "reconciliationPolicy must be additive-only or mark-inactive");
}
