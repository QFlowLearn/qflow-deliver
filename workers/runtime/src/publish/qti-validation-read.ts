import {
  type ImportValidationFinding,
  type ImportValidationFindingCategory,
  type ImportValidationFindingScope,
  type ImportValidationReport,
} from "@harbor/content-model";
import { summarizeImportValidationFindings } from "./qti-import-validation";

const IMPORT_VALIDATION_CATEGORY_BY_STORED_VALUE: Readonly<
  Record<string, ImportValidationFindingCategory>
> = {
  accepted: "accepted",
  "accepted-with-warning": "accepted-with-warning",
  "accepted-pending-adapter-evidence": "accepted-pending-adapter-evidence",
  blocked: "blocked",
  warning: "accepted-with-warning",
  "unsupported-but-ignored": "accepted-pending-adapter-evidence",
  blocker: "blocked",
};

interface StoredImportValidationFindingRow {
  readonly category: unknown;
  readonly scope: unknown;
  readonly code: unknown;
  readonly message: unknown;
  readonly target_id: unknown;
  readonly metadata_json: unknown;
}

/** Persisted validation data contains a field this runtime cannot parse. */
export class InvalidStoredImportValidationFindingError extends Error {
  readonly kind:
    | "invalid-stored-import-validation-finding"
    | "invalid-stored-import-validation-category" = "invalid-stored-import-validation-finding";

  constructor(
    readonly field: keyof StoredImportValidationFindingRow,
    options?: ErrorOptions,
  ) {
    super(`Invalid persisted import validation finding field: ${field}`, options);
    this.name = "InvalidStoredImportValidationFindingError";
  }
}

/** Persisted validation data contains a category unknown to this runtime. */
export class InvalidStoredImportValidationCategoryError extends InvalidStoredImportValidationFindingError {
  override readonly kind = "invalid-stored-import-validation-category";

  constructor(readonly category: string) {
    super("category");
    this.message = `Unknown persisted import validation category: ${JSON.stringify(category)}`;
    this.name = "InvalidStoredImportValidationCategoryError";
  }
}

/** Read and parse the durable validation report for one assessment version. */
export async function readAssessmentVersionValidationReport(
  db: D1Database,
  assessmentVersionId: string,
): Promise<ImportValidationReport> {
  const rows = await db
    .prepare(
      "SELECT category, scope, code, message, target_id, metadata_json FROM assessment_version_validation_findings WHERE assessment_version_id = ? ORDER BY created_at, id",
    )
    .bind(assessmentVersionId)
    .all<StoredImportValidationFindingRow>();
  return summarizeImportValidationFindings(rows.results.map(parseStoredImportValidationFinding));
}

function parseStoredImportValidationFinding(
  row: StoredImportValidationFindingRow,
): ImportValidationFinding {
  return {
    category: normalizeImportValidationCategory(requireStoredString(row.category, "category")),
    scope: parseImportValidationScope(requireStoredString(row.scope, "scope")),
    code: requireStoredString(row.code, "code"),
    message: requireStoredString(row.message, "message"),
    targetId: parseStoredNullableString(row.target_id, "target_id"),
    metadata: parseMetadataJson(requireStoredString(row.metadata_json, "metadata_json")),
  };
}

function normalizeImportValidationCategory(category: string): ImportValidationFindingCategory {
  const normalized = IMPORT_VALIDATION_CATEGORY_BY_STORED_VALUE[category];
  if (normalized) return normalized;
  throw new InvalidStoredImportValidationCategoryError(category);
}

function parseImportValidationScope(scope: string): ImportValidationFindingScope {
  switch (scope) {
    case "package":
    case "manifest":
    case "item":
    case "asset":
    case "standards":
    case "delivery-policy":
    case "source":
      return scope;
    default:
      throw new InvalidStoredImportValidationFindingError("scope");
  }
}

function requireStoredString(
  value: unknown,
  field: keyof StoredImportValidationFindingRow,
): string {
  if (typeof value === "string") return value;
  throw new InvalidStoredImportValidationFindingError(field);
}

function parseStoredNullableString(
  value: unknown,
  field: keyof StoredImportValidationFindingRow,
): string | null {
  if (value === null || typeof value === "string") return value;
  throw new InvalidStoredImportValidationFindingError(field);
}

function parseMetadataJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed));
    }
    throw new InvalidStoredImportValidationFindingError("metadata_json");
  } catch (cause: unknown) {
    if (cause instanceof InvalidStoredImportValidationFindingError) throw cause;
    throw new InvalidStoredImportValidationFindingError("metadata_json", { cause });
  }
}
