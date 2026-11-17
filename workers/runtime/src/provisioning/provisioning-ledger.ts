import type {
  AssignmentActorSnapshot,
  ProvisioningRunMode,
  ProvisioningRunRecord,
  ProvisioningRunStatus,
  ProvisioningSourceKind,
  ProvisioningSourceRecord,
  RosterProvisioningError,
  RosterProvisioningSummary,
} from "@harbor/attempt-protocol";

/** Persistence row for a tenant-scoped provisioning source. */
export interface ProvisioningSourceRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly source_kind: ProvisioningSourceKind;
  readonly source_key: string;
  readonly source_name: string;
  readonly status: "active" | "inactive";
  readonly created_at: string;
  readonly updated_at: string;
}

/** Create or reactivate a name-keyed provisioning source. */
export async function upsertProvisioningSource(input: {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly sourceKind: ProvisioningSourceKind;
  readonly sourceName: string;
}): Promise<ProvisioningSourceRecord> {
  const now = new Date().toISOString();
  const sourceKey = normalizeSourceKey(input.sourceName, input.sourceKind);
  const existing = await input.db
    .prepare(
      "SELECT id, tenant_id, source_kind, source_key, source_name, status, created_at, updated_at FROM provisioning_sources WHERE tenant_id = ? AND source_kind = ? AND source_key = ?",
    )
    .bind(input.tenantId, input.sourceKind, sourceKey)
    .first<ProvisioningSourceRow>();

  if (existing) {
    await input.db
      .prepare(
        "UPDATE provisioning_sources SET source_name = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .bind(input.sourceName, "active", now, existing.id)
      .run();

    return mapProvisioningSourceRow({
      ...existing,
      source_name: input.sourceName,
      status: "active",
      updated_at: now,
    });
  }

  const sourceId = createLedgerId("psrc");
  await input.db
    .prepare(
      "INSERT INTO provisioning_sources (id, tenant_id, source_kind, source_key, source_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      sourceId,
      input.tenantId,
      input.sourceKind,
      sourceKey,
      input.sourceName,
      "active",
      now,
      now,
    )
    .run();

  return {
    id: sourceId,
    tenantId: input.tenantId,
    sourceKind: input.sourceKind,
    sourceKey,
    sourceName: input.sourceName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/** Persist a completed provisioning run summary. */
export async function createProvisioningRun(input: {
  readonly db: D1Database;
  readonly source: ProvisioningSourceRecord;
  readonly mode: ProvisioningRunMode;
  readonly status: ProvisioningRunStatus;
  readonly actor: AssignmentActorSnapshot;
  readonly inputSha256: string;
  readonly summary: RosterProvisioningSummary;
}): Promise<ProvisioningRunRecord> {
  const now = new Date().toISOString();
  const runId = createLedgerId("prun");
  await input.db
    .prepare(
      "INSERT INTO provisioning_runs (id, source_id, tenant_id, source_kind, source_name, mode, status, actor_role, actor_id, actor_display_name, input_sha256, row_count, valid_row_count, invalid_row_count, learner_create_count, learner_update_count, section_create_count, section_update_count, membership_create_count, membership_reactivate_count, membership_deactivate_count, membership_unchanged_count, summary_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      runId,
      input.source.id,
      input.source.tenantId,
      input.source.sourceKind,
      input.source.sourceName,
      input.mode,
      input.status,
      input.actor.role,
      input.actor.actorId,
      input.actor.displayName,
      input.inputSha256,
      input.summary.rowCount,
      input.summary.validRowCount,
      input.summary.invalidRowCount,
      input.summary.learnerCreateCount,
      input.summary.learnerUpdateCount,
      input.summary.sectionCreateCount,
      input.summary.sectionUpdateCount,
      input.summary.membershipCreateCount,
      input.summary.membershipReactivateCount,
      input.summary.membershipDeactivateCount,
      input.summary.membershipUnchangedCount,
      JSON.stringify(input.summary),
      now,
      now,
    )
    .run();

  return {
    id: runId,
    sourceId: input.source.id,
    tenantId: input.source.tenantId,
    sourceKind: input.source.sourceKind,
    sourceName: input.source.sourceName,
    mode: input.mode,
    status: input.status,
    actor: input.actor,
    inputSha256: input.inputSha256,
    summary: input.summary,
    startedAt: now,
    completedAt: now,
  };
}

/** Persist safe structured diagnostics for one provisioning run. */
export async function persistProvisioningRunErrors(input: {
  readonly db: D1Database;
  readonly runId: string;
  readonly errors: readonly RosterProvisioningError[];
}): Promise<void> {
  if (input.errors.length === 0) return;

  const now = new Date().toISOString();
  await input.db.batch(
    input.errors.map((error) =>
      input.db
        .prepare(
          "INSERT INTO provisioning_run_errors (id, run_id, row_number, field, code, message, raw_row_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          createLedgerId("perr"),
          input.runId,
          error.rowNumber,
          error.field,
          error.code,
          error.message,
          error.rawRow ? JSON.stringify(error.rawRow) : null,
          now,
        ),
    ),
  );
}

/** Project a source persistence row into the public ledger record. */
export function mapProvisioningSourceRow(row: ProvisioningSourceRow): ProvisioningSourceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    sourceName: row.source_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSourceKey(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `${fallback}-upload`;
}

function createLedgerId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
