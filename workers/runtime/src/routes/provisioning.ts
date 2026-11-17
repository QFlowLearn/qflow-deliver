import type {
  AssignmentActorSnapshot,
  CsvRosterImportRequest,
  ProvisioningRunDetailResponse,
  ProvisioningRunMode,
  ProvisioningRunRecord,
  ProvisioningRunsResponse,
  ProvisioningRunStatus,
  ProvisioningSourceKind,
  ProvisioningSourceRecord,
  RosterCsvImportResponse,
  RosterProvisioningError,
  RosterProvisioningPreviewRow,
  RosterProvisioningSummary,
} from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import { applyOneRosterHierarchy, planOneRosterHierarchy } from "../provisioning/oneroster-apply";
import {
  canonicalizeOneRosterFiles,
  translateOneRosterCsvFiles,
  translateOneRosterCsvZip,
} from "../provisioning/oneroster-csv";
import {
  createProvisioningRun,
  persistProvisioningRunErrors,
  upsertProvisioningSource,
} from "../provisioning/provisioning-ledger";
import { buildCsv } from "../reports/csv";
import {
  readAssignmentActor,
  readJsonObject,
  readOptionalString,
  readRequiredString,
} from "./route-request-utils";

interface ProvisioningEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET?: string;
}

interface ProvisioningRunRow {
  id: string;
  source_id: string;
  tenant_id: string;
  source_kind: ProvisioningSourceKind;
  source_name: string;
  mode: ProvisioningRunMode;
  status: ProvisioningRunStatus;
  actor_role: AssignmentActorSnapshot["role"];
  actor_id: string;
  actor_display_name: string | null;
  input_sha256: string;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  learner_create_count: number;
  learner_update_count: number;
  section_create_count: number;
  section_update_count: number;
  membership_create_count: number;
  membership_reactivate_count: number;
  membership_deactivate_count: number;
  membership_unchanged_count: number;
  summary_json: string;
  started_at: string;
  completed_at: string;
}

interface ProvisioningRunErrorRow {
  row_number: number | null;
  field: string | null;
  code: string;
  message: string;
  raw_row_json: string | null;
}

interface ExternalIdMappingRow {
  entity_kind: "learner" | "section";
  source_external_id: string;
  harbor_entity_id: string;
}

interface ExistingLearnerRow {
  id: string;
  display_name: string;
  email: string | null;
}

interface ExistingSectionRow {
  id: string;
  title: string;
  source_id: string;
}

interface ExistingMembershipRow {
  section_id: string;
  learner_id: string;
  status: "active" | "inactive";
}

interface ParsedRosterRow {
  rowNumber: number;
  raw: Record<string, string>;
}

interface ValidRosterRow extends ParsedRosterRow {
  learnerExternalId: string;
  learnerDisplayName: string;
  learnerEmail: string | null;
  sectionExternalId: string;
  sectionTitle: string;
  membershipStatus: "active" | "inactive";
}

interface PlannedLearner {
  externalId: string;
  harborId: string;
  displayName: string;
  email: string | null;
  exists: boolean;
  shouldUpdate: boolean;
}

interface PlannedSection {
  externalId: string;
  harborId: string;
  title: string;
  exists: boolean;
  shouldUpdate: boolean;
}

interface PlannedMembership {
  sectionExternalId: string;
  learnerExternalId: string;
  sectionId: string;
  learnerId: string;
  status: "active" | "inactive";
  action: "create" | "reactivate" | "deactivate" | "unchanged";
}

interface RosterImportPlan {
  summary: RosterProvisioningSummary;
  previewRows: RosterProvisioningPreviewRow[];
  learners: PlannedLearner[];
  sections: PlannedSection[];
  memberships: PlannedMembership[];
}

type OneRosterImportRequest = {
  sourceName?: string | null;
  actor: AssignmentActorSnapshot;
} & (
  | {
      kind: "files";
      files: Record<string, string>;
    }
  | {
      kind: "zip";
      zipBytes: Uint8Array;
    }
);

const CSV_SOURCE_KIND: ProvisioningSourceKind = "csv";
const ONEROSTER_SOURCE_KIND: ProvisioningSourceKind = "oneroster";
const DEFAULT_CSV_SOURCE_NAME = "CSV roster upload";
const DEFAULT_ONEROSTER_SOURCE_NAME = "OneRoster CSV upload";
const PREVIEW_ROW_LIMIT = 25;

const LEARNER_ID_HEADERS = [
  "learner_id",
  "student_id",
  "user_id",
  "user_sourced_id",
  "student_sourced_id",
  "sourced_id",
  "sourcedid",
];
const DISPLAY_NAME_HEADERS = [
  "display_name",
  "name",
  "full_name",
  "formatted_name",
  "student_name",
];
const GIVEN_NAME_HEADERS = ["given_name", "givenname", "first_name", "firstname"];
const FAMILY_NAME_HEADERS = ["family_name", "familyname", "last_name", "lastname"];
const EMAIL_HEADERS = ["email", "email_address", "emailaddress", "username"];
const SECTION_ID_HEADERS = [
  "section_id",
  "class_id",
  "class_sourced_id",
  "section_sourced_id",
  "course_section_id",
];
const SECTION_NAME_HEADERS = [
  "section_name",
  "class_name",
  "class_title",
  "course_section_name",
  "title",
];
const STATUS_HEADERS = ["status", "membership_status", "enabled"];

export async function listProvisioningRuns(input: {
  env: ProvisioningEnv;
  tenantId: string;
}): Promise<Response> {
  return Response.json(
    await readProvisioningRuns({
      db: input.env.HARBOR_DB,
      tenantId: input.tenantId,
    }),
    { status: 200 },
  );
}

export async function getProvisioningRun(input: {
  env: ProvisioningEnv;
  runId: string;
  tenantId: string;
}): Promise<Response> {
  return Response.json(
    await readProvisioningRunDetail({
      db: input.env.HARBOR_DB,
      runId: input.runId,
      tenantId: input.tenantId,
    }),
    { status: 200 },
  );
}

export async function getProvisioningRunReportCsv(input: {
  env: ProvisioningEnv;
  runId: string;
  tenantId: string;
}): Promise<Response> {
  const detail = await readProvisioningRunDetail({
    db: input.env.HARBOR_DB,
    runId: input.runId,
    tenantId: input.tenantId,
  });
  return new Response(buildProvisioningRunReportCsv(detail), {
    status: 200,
    headers: {
      "content-type": "text/csv;charset=utf-8",
      "content-disposition": `attachment; filename="${input.runId}-provisioning-run.csv"`,
    },
  });
}

export async function previewCsvRosterImport(input: {
  env: ProvisioningEnv;
  tenantId: string;
  request: Request;
}): Promise<Response> {
  return Response.json(
    await handleCsvRosterImport({
      db: input.env.HARBOR_DB,
      mode: "dry-run",
      tenantId: input.tenantId,
      request: await readCsvRosterImportRequest(input.request),
    }),
    { status: 200 },
  );
}

export async function applyCsvRosterImport(input: {
  env: ProvisioningEnv;
  tenantId: string;
  request: Request;
}): Promise<Response> {
  return Response.json(
    await handleCsvRosterImport({
      db: input.env.HARBOR_DB,
      mode: "apply",
      tenantId: input.tenantId,
      request: await readCsvRosterImportRequest(input.request),
    }),
    { status: 201 },
  );
}

export async function previewOneRosterImport(input: {
  env: ProvisioningEnv;
  tenantId: string;
  request: Request;
}): Promise<Response> {
  return Response.json(
    await handleOneRosterCsvImport({
      db: input.env.HARBOR_DB,
      mode: "dry-run",
      tenantId: input.tenantId,
      request: await readOneRosterCsvImportRequest(input.request),
    }),
    { status: 200 },
  );
}

export async function applyOneRosterImport(input: {
  env: ProvisioningEnv;
  tenantId: string;
  request: Request;
}): Promise<Response> {
  return Response.json(
    await handleOneRosterCsvImport({
      db: input.env.HARBOR_DB,
      mode: "apply",
      tenantId: input.tenantId,
      request: await readOneRosterCsvImportRequest(input.request),
    }),
    { status: 201 },
  );
}

async function handleCsvRosterImport(input: {
  db: D1Database;
  mode: ProvisioningRunMode;
  tenantId: string;
  request: CsvRosterImportRequest;
}): Promise<RosterCsvImportResponse> {
  const sourceName = input.request.sourceName?.trim() || DEFAULT_CSV_SOURCE_NAME;
  const source = await upsertProvisioningSource({
    db: input.db,
    tenantId: input.tenantId,
    sourceKind: CSV_SOURCE_KIND,
    sourceName,
  });
  const parsed = parseRosterCsv(input.request.csvText);
  const validated = validateRosterRows(parsed);
  const plan = await buildRosterImportPlan({
    db: input.db,
    source,
    tenantId: input.tenantId,
    validRows: validated.validRows,
    invalidRowCount: validated.invalidRowCount,
    rowCount: parsed.rows.length,
  });
  const errors = validated.errors;
  const status = resolveRunStatus({
    mode: input.mode,
    summary: plan.summary,
    errors,
  });
  const inputSha256 = await sha256Hex(input.request.csvText);
  const run = await createProvisioningRun({
    db: input.db,
    source,
    mode: input.mode,
    status,
    actor: input.request.actor,
    inputSha256,
    summary: plan.summary,
  });

  await persistProvisioningRunErrors({
    db: input.db,
    runId: run.id,
    errors,
  });

  if (input.mode === "apply" && plan.summary.validRowCount > 0) {
    await applyRosterImportPlan({
      db: input.db,
      tenantId: input.tenantId,
      source,
      plan,
    });
  }

  return {
    source,
    run,
    summary: plan.summary,
    errors,
    previewRows: plan.previewRows,
  };
}

async function handleOneRosterCsvImport(input: {
  db: D1Database;
  mode: ProvisioningRunMode;
  tenantId: string;
  request: OneRosterImportRequest;
}): Promise<RosterCsvImportResponse> {
  const sourceName = input.request.sourceName?.trim() || DEFAULT_ONEROSTER_SOURCE_NAME;
  const source = await upsertProvisioningSource({
    db: input.db,
    tenantId: input.tenantId,
    sourceKind: ONEROSTER_SOURCE_KIND,
    sourceName,
  });
  const translated =
    input.request.kind === "zip"
      ? translateOneRosterCsvZip(input.request.zipBytes)
      : translateOneRosterCsvFiles(input.request.files);
  const validated = validateRosterRows({
    rows: translated.rows,
    errors: translated.errors,
  });
  const basePlan = await buildRosterImportPlan({
    db: input.db,
    source,
    tenantId: input.tenantId,
    validRows: validated.validRows,
    invalidRowCount: validated.invalidRowCount,
    rowCount: translated.rowCount,
  });
  const hierarchyPlan =
    translated.validatedPackage && validated.validRows.length > 0
      ? planOneRosterHierarchy({
          validatedPackage: translated.validatedPackage,
          sections: basePlan.sections,
        })
      : null;
  const plan: RosterImportPlan = {
    ...basePlan,
    summary: hierarchyPlan
      ? {
          ...basePlan.summary,
          ...hierarchyPlan.summary,
        }
      : basePlan.summary,
  };
  const errors = validated.errors;
  const status = resolveRunStatus({
    mode: input.mode,
    summary: plan.summary,
    errors,
  });
  const inputSha256 = await sha256Hex(
    input.request.kind === "zip"
      ? input.request.zipBytes
      : canonicalizeOneRosterFiles(input.request.files),
  );
  const run = await createProvisioningRun({
    db: input.db,
    source,
    mode: input.mode,
    status,
    actor: input.request.actor,
    inputSha256,
    summary: plan.summary,
  });

  await persistProvisioningRunErrors({
    db: input.db,
    runId: run.id,
    errors,
  });

  if (
    input.mode === "apply" &&
    plan.summary.validRowCount > 0 &&
    translated.validatedPackage &&
    hierarchyPlan
  ) {
    await applyRosterImportPlan({
      db: input.db,
      tenantId: input.tenantId,
      source,
      plan,
    });
    await applyOneRosterHierarchy({
      db: input.db,
      tenantId: input.tenantId,
      source,
      validatedPackage: translated.validatedPackage,
      hierarchyPlan,
    });
  }

  return {
    source,
    run,
    summary: plan.summary,
    errors,
    previewRows: plan.previewRows,
  };
}

function parseRosterCsv(csvText: string): {
  rows: ParsedRosterRow[];
  errors: RosterProvisioningError[];
} {
  const table = parseCsvTable(stripByteOrderMark(csvText));
  const firstNonBlankIndex = table.findIndex((row) => row.some((cell) => cell.trim().length > 0));
  if (firstNonBlankIndex < 0) {
    return {
      rows: [],
      errors: [
        {
          rowNumber: null,
          field: null,
          code: "empty_csv",
          message: "CSV import is empty.",
          rawRow: null,
        },
      ],
    };
  }

  const headers = table[firstNonBlankIndex].map((header) => header.trim());
  const rows: ParsedRosterRow[] = [];
  for (let index = firstNonBlankIndex + 1; index < table.length; index += 1) {
    const cells = table[index];
    if (cells.every((cell) => cell.trim().length === 0)) {
      continue;
    }

    const raw: Record<string, string> = {};
    headers.forEach((header, headerIndex) => {
      if (header) {
        raw[header] = cells[headerIndex]?.trim() ?? "";
      }
    });
    rows.push({
      rowNumber: index + 1,
      raw,
    });
  }

  return {
    rows,
    errors: [],
  };
}

function validateRosterRows(input: {
  rows: ParsedRosterRow[];
  errors: RosterProvisioningError[];
}): {
  validRows: ValidRosterRow[];
  invalidRowCount: number;
  errors: RosterProvisioningError[];
} {
  const firstRow = input.rows[0];
  if (!firstRow) {
    const errors =
      input.errors.length > 0
        ? input.errors
        : [
            {
              rowNumber: null,
              field: null,
              code: "no_data_rows",
              message: "CSV import must include at least one learner row.",
              rawRow: null,
            },
          ];
    const invalidRowNumbers = new Set(
      input.errors
        .map((error) => error.rowNumber)
        .filter((rowNumber): rowNumber is number => rowNumber !== null),
    );
    return {
      validRows: [],
      invalidRowCount: invalidRowNumbers.size || input.rows.length,
      errors,
    };
  }

  const normalizedHeaders = new Set(Object.keys(firstRow.raw).map(normalizeHeader));
  const missingHeaderErrors = [
    buildMissingHeaderError(normalizedHeaders, LEARNER_ID_HEADERS, "learner_id"),
    buildMissingHeaderError(normalizedHeaders, DISPLAY_NAME_HEADERS, "display_name", {
      alternativeGroups: [GIVEN_NAME_HEADERS, FAMILY_NAME_HEADERS],
    }),
    buildMissingHeaderError(normalizedHeaders, SECTION_ID_HEADERS, "section_id"),
  ].filter((error): error is RosterProvisioningError => Boolean(error));

  if (missingHeaderErrors.length > 0) {
    return {
      validRows: [],
      invalidRowCount: input.rows.length,
      errors: [...input.errors, ...missingHeaderErrors],
    };
  }

  const validRows: ValidRosterRow[] = [];
  const errors = [...input.errors];
  const invalidRowNumbers = new Set(
    input.errors
      .map((error) => error.rowNumber)
      .filter((rowNumber): rowNumber is number => rowNumber !== null),
  );

  for (const row of input.rows) {
    const learnerExternalId = readCsvValue(row.raw, LEARNER_ID_HEADERS);
    const explicitDisplayName = readCsvValue(row.raw, DISPLAY_NAME_HEADERS);
    const givenName = readCsvValue(row.raw, GIVEN_NAME_HEADERS);
    const familyName = readCsvValue(row.raw, FAMILY_NAME_HEADERS);
    const learnerDisplayName =
      explicitDisplayName || [givenName, familyName].filter(Boolean).join(" ").trim();
    const learnerEmail = readCsvValue(row.raw, EMAIL_HEADERS) || null;
    const sectionExternalId = readCsvValue(row.raw, SECTION_ID_HEADERS);
    const sectionTitle = readCsvValue(row.raw, SECTION_NAME_HEADERS) || sectionExternalId;
    const membershipStatus = normalizeMembershipStatus(readCsvValue(row.raw, STATUS_HEADERS));
    const rowErrors: RosterProvisioningError[] = [];

    if (!learnerExternalId) {
      rowErrors.push(
        createRowError(row, "learner_id", "missing_learner_id", "Learner ID is required."),
      );
    }
    if (!learnerDisplayName) {
      rowErrors.push(
        createRowError(
          row,
          "display_name",
          "missing_display_name",
          "Learner display name is required.",
        ),
      );
    }
    if (!sectionExternalId) {
      rowErrors.push(
        createRowError(row, "section_id", "missing_section_id", "Section ID is required."),
      );
    }
    if (!membershipStatus) {
      rowErrors.push(
        createRowError(
          row,
          "status",
          "invalid_status",
          "Membership status must be active or inactive.",
        ),
      );
    }

    if (rowErrors.length > 0) {
      invalidRowNumbers.add(row.rowNumber);
      errors.push(...rowErrors);
      continue;
    }

    validRows.push({
      ...row,
      learnerExternalId,
      learnerDisplayName,
      learnerEmail,
      sectionExternalId,
      sectionTitle,
      membershipStatus: membershipStatus as "active" | "inactive",
    });
  }

  return {
    validRows,
    invalidRowCount: invalidRowNumbers.size,
    errors,
  };
}

async function buildRosterImportPlan(input: {
  db: D1Database;
  source: ProvisioningSourceRecord;
  tenantId: string;
  validRows: ValidRosterRow[];
  invalidRowCount: number;
  rowCount: number;
}): Promise<RosterImportPlan> {
  const learnersByExternalId = new Map<
    string,
    Omit<PlannedLearner, "harborId" | "exists" | "shouldUpdate">
  >();
  const sectionsByExternalId = new Map<
    string,
    Omit<PlannedSection, "harborId" | "exists" | "shouldUpdate">
  >();
  const membershipsByKey = new Map<
    string,
    Pick<PlannedMembership, "learnerExternalId" | "sectionExternalId" | "status">
  >();

  for (const row of input.validRows) {
    learnersByExternalId.set(row.learnerExternalId, {
      externalId: row.learnerExternalId,
      displayName: row.learnerDisplayName,
      email: row.learnerEmail,
    });
    sectionsByExternalId.set(row.sectionExternalId, {
      externalId: row.sectionExternalId,
      title: row.sectionTitle,
    });
    membershipsByKey.set(`${row.sectionExternalId}\u0000${row.learnerExternalId}`, {
      sectionExternalId: row.sectionExternalId,
      learnerExternalId: row.learnerExternalId,
      status: row.membershipStatus,
    });
  }

  const learnerExternalIds = [...learnersByExternalId.keys()];
  const sectionExternalIds = [...sectionsByExternalId.keys()];
  const mappings = await readExternalIdMappings(input.db, input.source.id, [
    ...learnerExternalIds,
    ...sectionExternalIds,
  ]);
  const learnerMappings = new Map(
    mappings
      .filter((row) => row.entity_kind === "learner")
      .map((row) => [row.source_external_id, row.harbor_entity_id]),
  );
  const sectionMappings = new Map(
    mappings
      .filter((row) => row.entity_kind === "section")
      .map((row) => [row.source_external_id, row.harbor_entity_id]),
  );
  const existingLearners = await readExistingLearners(input.db, input.tenantId, [
    ...learnerMappings.values(),
  ]);
  const existingSectionsByMappedId = await readExistingSectionsById(input.db, input.tenantId, [
    ...sectionMappings.values(),
  ]);
  const existingSectionsBySourceId = await readExistingSectionsBySourceId(
    input.db,
    input.tenantId,
    input.source.sourceKind,
    sectionExternalIds,
  );

  const plannedLearners = learnerExternalIds.map((externalId) => {
    const incoming = learnersByExternalId.get(externalId)!;
    const mappedId = learnerMappings.get(externalId);
    const existing = mappedId ? existingLearners.get(mappedId) : undefined;
    const harborId = mappedId ?? createId("learner");
    return {
      ...incoming,
      harborId,
      exists: Boolean(existing),
      shouldUpdate: Boolean(
        existing &&
        (existing.display_name !== incoming.displayName ||
          (existing.email ?? null) !== incoming.email),
      ),
    };
  });

  const plannedSections = sectionExternalIds.map((externalId) => {
    const incoming = sectionsByExternalId.get(externalId)!;
    const mappedId = sectionMappings.get(externalId);
    const existingByMapping = mappedId ? existingSectionsByMappedId.get(mappedId) : undefined;
    const existingBySource = existingSectionsBySourceId.get(externalId);
    const existing = existingByMapping ?? existingBySource;
    const harborId = mappedId ?? existingBySource?.id ?? createId("section");
    return {
      ...incoming,
      harborId,
      exists: Boolean(existing),
      shouldUpdate: Boolean(existing && existing.title !== incoming.title),
    };
  });

  const learnerIdByExternalId = new Map(
    plannedLearners.map((learner) => [learner.externalId, learner.harborId]),
  );
  const sectionIdByExternalId = new Map(
    plannedSections.map((section) => [section.externalId, section.harborId]),
  );
  const existingMemberships = await readExistingMemberships(input.db, [
    ...sectionIdByExternalId.values(),
  ]);

  const plannedMemberships = [...membershipsByKey.values()].map((membership) => {
    const learnerId = learnerIdByExternalId.get(membership.learnerExternalId)!;
    const sectionId = sectionIdByExternalId.get(membership.sectionExternalId)!;
    const existing = existingMemberships.get(`${sectionId}\u0000${learnerId}`);
    const action: PlannedMembership["action"] = !existing
      ? "create"
      : existing.status === membership.status
        ? "unchanged"
        : membership.status === "active"
          ? "reactivate"
          : "deactivate";

    return {
      ...membership,
      learnerId,
      sectionId,
      action,
    };
  });

  const summary: RosterProvisioningSummary = {
    rowCount: input.rowCount,
    validRowCount: input.validRows.length,
    invalidRowCount: input.invalidRowCount,
    learnerCreateCount: plannedLearners.filter((learner) => !learner.exists).length,
    learnerUpdateCount: plannedLearners.filter((learner) => learner.shouldUpdate).length,
    sectionCreateCount: plannedSections.filter((section) => !section.exists).length,
    sectionUpdateCount: plannedSections.filter((section) => section.shouldUpdate).length,
    membershipCreateCount: plannedMemberships.filter((membership) => membership.action === "create")
      .length,
    membershipReactivateCount: plannedMemberships.filter(
      (membership) => membership.action === "reactivate",
    ).length,
    membershipDeactivateCount: plannedMemberships.filter(
      (membership) => membership.action === "deactivate",
    ).length,
    membershipUnchangedCount: plannedMemberships.filter(
      (membership) => membership.action === "unchanged",
    ).length,
  };

  const learnerPlanByExternalId = new Map(
    plannedLearners.map((learner) => [learner.externalId, learner]),
  );
  const sectionPlanByExternalId = new Map(
    plannedSections.map((section) => [section.externalId, section]),
  );
  const membershipPlanByKey = new Map(
    plannedMemberships.map((membership) => [
      `${membership.sectionExternalId}\u0000${membership.learnerExternalId}`,
      membership,
    ]),
  );
  const previewRows = input.validRows.slice(0, PREVIEW_ROW_LIMIT).map((row) => {
    const learner = learnerPlanByExternalId.get(row.learnerExternalId)!;
    const section = sectionPlanByExternalId.get(row.sectionExternalId)!;
    const membership = membershipPlanByKey.get(
      `${row.sectionExternalId}\u0000${row.learnerExternalId}`,
    )!;
    return {
      rowNumber: row.rowNumber,
      learnerExternalId: row.learnerExternalId,
      learnerDisplayName: row.learnerDisplayName,
      learnerEmail: row.learnerEmail,
      sectionExternalId: row.sectionExternalId,
      sectionTitle: row.sectionTitle,
      membershipStatus: row.membershipStatus,
      actions: [
        learner.exists
          ? learner.shouldUpdate
            ? "update learner"
            : "match learner"
          : "create learner",
        section.exists
          ? section.shouldUpdate
            ? "update section"
            : "match section"
          : "create section",
        `${membership.action} membership`,
      ],
    };
  });

  return {
    summary,
    previewRows,
    learners: plannedLearners,
    sections: plannedSections,
    memberships: plannedMemberships,
  };
}

async function applyRosterImportPlan(input: {
  db: D1Database;
  tenantId: string;
  source: ProvisioningSourceRecord;
  plan: RosterImportPlan;
}): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    ...input.plan.learners.flatMap((learner) => [
      input.db
        .prepare(
          "INSERT INTO harbor_learners (id, tenant_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, display_name = excluded.display_name, email = excluded.email, updated_at = excluded.updated_at",
        )
        .bind(learner.harborId, input.tenantId, learner.displayName, learner.email, now, now),
      input.db
        .prepare(
          "INSERT INTO external_id_mappings (id, tenant_id, source_id, source_kind, entity_kind, source_external_id, harbor_entity_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, entity_kind, source_external_id) DO UPDATE SET harbor_entity_id = excluded.harbor_entity_id, updated_at = excluded.updated_at",
        )
        .bind(
          createId("extmap"),
          input.tenantId,
          input.source.id,
          input.source.sourceKind,
          "learner",
          learner.externalId,
          learner.harborId,
          now,
          now,
        ),
    ]),
    ...input.plan.sections.flatMap((section) => [
      input.db
        .prepare(
          "INSERT INTO sections (id, tenant_id, source_kind, source_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, source_kind, source_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
        )
        .bind(
          section.harborId,
          input.tenantId,
          input.source.sourceKind,
          section.externalId,
          section.title,
          now,
          now,
        ),
      input.db
        .prepare(
          "INSERT INTO external_id_mappings (id, tenant_id, source_id, source_kind, entity_kind, source_external_id, harbor_entity_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, entity_kind, source_external_id) DO UPDATE SET harbor_entity_id = excluded.harbor_entity_id, updated_at = excluded.updated_at",
        )
        .bind(
          createId("extmap"),
          input.tenantId,
          input.source.id,
          input.source.sourceKind,
          "section",
          section.externalId,
          section.harborId,
          now,
          now,
        ),
    ]),
    ...input.plan.memberships.map((membership) =>
      input.db
        .prepare(
          "INSERT INTO section_memberships (id, section_id, learner_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(section_id, learner_id) DO UPDATE SET role = excluded.role, status = excluded.status, updated_at = excluded.updated_at",
        )
        .bind(
          createId("membership"),
          membership.sectionId,
          membership.learnerId,
          "learner",
          membership.status,
          now,
          now,
        ),
    ),
  ];

  if (statements.length > 0) {
    await input.db.batch(statements);
  }
}

async function readProvisioningRuns(input: {
  db: D1Database;
  tenantId: string;
}): Promise<ProvisioningRunsResponse> {
  const result = await input.db
    .prepare(
      "SELECT id, source_id, tenant_id, source_kind, source_name, mode, status, actor_role, actor_id, actor_display_name, input_sha256, row_count, valid_row_count, invalid_row_count, learner_create_count, learner_update_count, section_create_count, section_update_count, membership_create_count, membership_reactivate_count, membership_deactivate_count, membership_unchanged_count, summary_json, started_at, completed_at FROM provisioning_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 10",
    )
    .bind(input.tenantId)
    .all<ProvisioningRunRow>();

  return {
    runs: result.results.map(mapProvisioningRunRow),
  };
}

async function readProvisioningRunDetail(input: {
  db: D1Database;
  runId: string;
  tenantId: string;
}): Promise<ProvisioningRunDetailResponse> {
  const row = await input.db
    .prepare(
      "SELECT id, source_id, tenant_id, source_kind, source_name, mode, status, actor_role, actor_id, actor_display_name, input_sha256, row_count, valid_row_count, invalid_row_count, learner_create_count, learner_update_count, section_create_count, section_update_count, membership_create_count, membership_reactivate_count, membership_deactivate_count, membership_unchanged_count, summary_json, started_at, completed_at FROM provisioning_runs WHERE id = ? AND tenant_id = ?",
    )
    .bind(input.runId, input.tenantId)
    .first<ProvisioningRunRow>();

  if (!row) {
    throw new LaunchRequestError(404, "Provisioning run not found");
  }

  const errors = await input.db
    .prepare(
      "SELECT row_number, field, code, message, raw_row_json FROM provisioning_run_errors WHERE run_id = ? ORDER BY row_number ASC, id ASC",
    )
    .bind(input.runId)
    .all<ProvisioningRunErrorRow>();

  return {
    run: mapProvisioningRunRow(row),
    errors: errors.results.map(mapRunErrorRow),
  };
}

async function readExternalIdMappings(
  db: D1Database,
  sourceId: string,
  sourceExternalIds: string[],
): Promise<ExternalIdMappingRow[]> {
  if (sourceExternalIds.length === 0) {
    return [];
  }

  const uniqueIds = [...new Set(sourceExternalIds)];
  const rows = await db
    .prepare(
      `SELECT entity_kind, source_external_id, harbor_entity_id
       FROM external_id_mappings
       WHERE source_id = ?
         AND source_external_id IN (${uniqueIds.map(() => "?").join(", ")})`,
    )
    .bind(sourceId, ...uniqueIds)
    .all<ExternalIdMappingRow>();

  return rows.results;
}

async function readExistingLearners(
  db: D1Database,
  tenantId: string,
  learnerIds: string[],
): Promise<Map<string, ExistingLearnerRow>> {
  const uniqueIds = [...new Set(learnerIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT id, display_name, email
       FROM harbor_learners
       WHERE tenant_id = ?
         AND id IN (${uniqueIds.map(() => "?").join(", ")})`,
    )
    .bind(tenantId, ...uniqueIds)
    .all<ExistingLearnerRow>();

  return new Map(rows.results.map((row) => [row.id, row]));
}

async function readExistingSectionsById(
  db: D1Database,
  tenantId: string,
  sectionIds: string[],
): Promise<Map<string, ExistingSectionRow>> {
  const uniqueIds = [...new Set(sectionIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT id, title, source_id
       FROM sections
       WHERE tenant_id = ?
         AND id IN (${uniqueIds.map(() => "?").join(", ")})`,
    )
    .bind(tenantId, ...uniqueIds)
    .all<ExistingSectionRow>();

  return new Map(rows.results.map((row) => [row.id, row]));
}

async function readExistingSectionsBySourceId(
  db: D1Database,
  tenantId: string,
  sourceKind: ProvisioningSourceKind,
  sourceIds: string[],
): Promise<Map<string, ExistingSectionRow>> {
  const uniqueIds = [...new Set(sourceIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT id, title, source_id
       FROM sections
       WHERE tenant_id = ?
         AND source_kind = ?
         AND source_id IN (${uniqueIds.map(() => "?").join(", ")})`,
    )
    .bind(tenantId, sourceKind, ...uniqueIds)
    .all<ExistingSectionRow>();

  return new Map(rows.results.map((row) => [row.source_id, row]));
}

async function readExistingMemberships(
  db: D1Database,
  sectionIds: string[],
): Promise<Map<string, ExistingMembershipRow>> {
  const uniqueIds = [...new Set(sectionIds)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .prepare(
      `SELECT section_id, learner_id, status
       FROM section_memberships
       WHERE section_id IN (${uniqueIds.map(() => "?").join(", ")})`,
    )
    .bind(...uniqueIds)
    .all<ExistingMembershipRow>();

  return new Map(rows.results.map((row) => [`${row.section_id}\u0000${row.learner_id}`, row]));
}

function resolveRunStatus(input: {
  mode: ProvisioningRunMode;
  summary: RosterProvisioningSummary;
  errors: RosterProvisioningError[];
}): ProvisioningRunStatus {
  if (input.mode === "dry-run") {
    return "previewed";
  }

  if (input.summary.validRowCount === 0 && input.errors.length > 0) {
    return "failed";
  }

  return input.summary.invalidRowCount > 0 ? "applied-with-errors" : "applied";
}

function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell);
  rows.push(currentRow);
  return rows;
}

async function readCsvRosterImportRequest(request: Request): Promise<CsvRosterImportRequest> {
  const body = await readJsonObject(request);
  return {
    sourceName: body.sourceName === undefined ? null : readOptionalString(body.sourceName),
    csvText: readRequiredString(body.csvText, "csvText is required"),
    actor: readAssignmentActor(body.actor),
  };
}

async function readOneRosterCsvImportRequest(request: Request): Promise<OneRosterImportRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    return readOneRosterMultipartImportRequest(request);
  }

  const body = await readJsonObject(request);
  return {
    kind: "files",
    sourceName: body.sourceName === undefined ? null : readOptionalString(body.sourceName),
    files: readStringRecord(body.files, "files is required"),
    actor: readAssignmentActor(body.actor),
  };
}

async function readOneRosterMultipartImportRequest(
  request: Request,
): Promise<OneRosterImportRequest> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new LaunchRequestError(400, "Request body must be multipart form data");
  }

  const zipFile = form.get("zip");
  if (!(zipFile instanceof File)) {
    throw new LaunchRequestError(400, "zip file is required");
  }

  const actorValue = form.get("actor");
  if (typeof actorValue !== "string") {
    throw new LaunchRequestError(400, "actor is required");
  }

  let actorJson: unknown;
  try {
    actorJson = JSON.parse(actorValue);
  } catch {
    throw new LaunchRequestError(400, "actor must be valid JSON");
  }

  const sourceNameValue = form.get("sourceName");
  return {
    kind: "zip",
    sourceName: sourceNameValue === null ? null : readOptionalString(sourceNameValue),
    zipBytes: new Uint8Array(await zipFile.arrayBuffer()),
    actor: readAssignmentActor(actorJson),
  };
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaunchRequestError(400, message);
  }

  return value as Record<string, unknown>;
}

function readStringRecord(value: unknown, message: string): Record<string, string> {
  const record = readRecord(value, message);
  const files: Record<string, string> = {};
  for (const [key, fileText] of Object.entries(record)) {
    if (typeof fileText !== "string") {
      throw new LaunchRequestError(400, `files.${key} must be a string`);
    }
    files[key] = fileText;
  }

  return files;
}

function buildMissingHeaderError(
  normalizedHeaders: Set<string>,
  acceptedHeaders: string[],
  field: string,
  options?: { alternativeGroups?: string[][] },
): RosterProvisioningError | null {
  const hasAcceptedHeader = acceptedHeaders.some((header) =>
    normalizedHeaders.has(normalizeHeader(header)),
  );
  const hasAlternativeGroup = options?.alternativeGroups?.some((group) =>
    group.some((header) => normalizedHeaders.has(normalizeHeader(header))),
  );
  if (hasAcceptedHeader || hasAlternativeGroup) {
    return null;
  }

  return {
    rowNumber: null,
    field,
    code: "missing_header",
    message: `CSV must include a ${field} column.`,
    rawRow: null,
  };
}

function createRowError(
  row: ParsedRosterRow,
  field: string,
  code: string,
  message: string,
): RosterProvisioningError {
  return {
    rowNumber: row.rowNumber,
    field,
    code,
    message,
    rawRow: row.raw,
  };
}

function readCsvValue(raw: Record<string, string>, acceptedHeaders: string[]): string {
  const normalizedAcceptedHeaders = new Set(
    acceptedHeaders.map((header) => normalizeHeader(header)),
  );
  for (const [header, value] of Object.entries(raw)) {
    if (normalizedAcceptedHeaders.has(normalizeHeader(header))) {
      return value.trim();
    }
  }

  return "";
}

function normalizeMembershipStatus(value: string): "active" | "inactive" | null {
  if (!value) {
    return "active";
  }

  const normalized = value.trim().toLowerCase();
  if (["active", "enabled", "true", "1"].includes(normalized)) {
    return "active";
  }
  if (["inactive", "disabled", "false", "0", "tobedeleted", "deleted"].includes(normalized)) {
    return "inactive";
  }

  return null;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function buildProvisioningRunReportCsv(detail: ProvisioningRunDetailResponse): string {
  const metricRows = buildProvisioningSummaryMetricRows(detail.run);
  const errorRows = detail.errors.map((error) => [
    "error",
    detail.run.id,
    detail.run.sourceKind,
    detail.run.sourceName,
    detail.run.mode,
    detail.run.status,
    "",
    "",
    error.rowNumber ?? "",
    error.field ?? "",
    error.code,
    error.message,
    error.rawRow ? JSON.stringify(error.rawRow) : "",
  ]);

  return buildCsv([
    [
      "record_type",
      "run_id",
      "source_kind",
      "source_name",
      "mode",
      "status",
      "metric",
      "value",
      "row_number",
      "field",
      "code",
      "message",
      "raw_row_json",
    ],
    ...metricRows,
    ...errorRows,
  ]);
}

function buildProvisioningSummaryMetricRows(
  run: ProvisioningRunRecord,
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];
  for (const [metric, value] of Object.entries(run.summary)) {
    if (metric === "oneRosterRestCounts") continue;
    rows.push(buildProvisioningMetricRow(run, metric, value ?? ""));
  }

  const restCounts = run.summary.oneRosterRestCounts;
  if (!restCounts) return rows;
  const countFields = ["received", "unique", "active", "inactive"] as const;
  for (const [entityKind, counts] of Object.entries(restCounts)) {
    for (const field of countFields) {
      rows.push(buildProvisioningMetricRow(run, `${entityKind}.${field}`, counts[field]));
    }
  }
  return rows;
}

function buildProvisioningMetricRow(
  run: ProvisioningRunRecord,
  metric: string,
  value: string | number,
): Array<string | number> {
  return [
    "metric",
    run.id,
    run.sourceKind,
    run.sourceName,
    run.mode,
    run.status,
    metric,
    value,
    "",
    "",
    "",
    "",
    "",
  ];
}

function mapProvisioningRunRow(row: ProvisioningRunRow): ProvisioningRunRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    tenantId: row.tenant_id,
    sourceKind: row.source_kind,
    sourceName: row.source_name,
    mode: row.mode,
    status: row.status,
    actor: {
      role: row.actor_role,
      actorId: row.actor_id,
      displayName: row.actor_display_name,
    },
    inputSha256: row.input_sha256,
    summary: parseSummary(row),
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseSummary(row: ProvisioningRunRow): RosterProvisioningSummary {
  try {
    return JSON.parse(row.summary_json) as RosterProvisioningSummary;
  } catch {
    return {
      rowCount: row.row_count,
      validRowCount: row.valid_row_count,
      invalidRowCount: row.invalid_row_count,
      learnerCreateCount: row.learner_create_count,
      learnerUpdateCount: row.learner_update_count,
      sectionCreateCount: row.section_create_count,
      sectionUpdateCount: row.section_update_count,
      membershipCreateCount: row.membership_create_count,
      membershipReactivateCount: row.membership_reactivate_count,
      membershipDeactivateCount: row.membership_deactivate_count,
      membershipUnchangedCount: row.membership_unchanged_count,
    };
  }
}

function mapRunErrorRow(row: ProvisioningRunErrorRow): RosterProvisioningError {
  return {
    rowNumber: row.row_number,
    field: row.field,
    code: row.code,
    message: row.message,
    rawRow: parseRawRow(row.raw_row_json),
  };
}

function parseRawRow(value: string | null): Record<string, string> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : null;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digestBytes =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestBytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
