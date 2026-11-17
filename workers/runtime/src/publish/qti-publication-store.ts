import type { AssessmentRecord } from "@harbor/content-model";
import type {
  QtiPreparedPublicationCommit,
  QtiPublicationObjectStore,
  QtiPublicationRepository,
} from "./qti-package-publisher";
import type { QtiPublicationObject, QtiPublicationPlan } from "./qti-publication-plan";
import { PublishInputError } from "./publish-errors";

const MAX_BINDINGS_PER_STATEMENT = 100;
const MAX_STATEMENTS_PER_PUBLICATION = 1_000;

export class CloudflareQtiPublicationRepository implements QtiPublicationRepository {
  constructor(private readonly db: D1Database) {}

  async findAssessment(tenantId: string, assessmentSlug: string): Promise<AssessmentRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT id, tenant_id, slug, title, created_at FROM assessments WHERE tenant_id = ? AND slug = ?",
      )
      .bind(tenantId, assessmentSlug)
      .first<{
        id: string;
        tenant_id: string;
        slug: string;
        title: string;
        created_at: string;
      }>();
    return row
      ? {
          id: row.id,
          tenantId: row.tenant_id,
          slug: row.slug,
          title: row.title,
          createdAt: row.created_at,
        }
      : null;
  }

  async readNextVersionNumber(assessmentId: string): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version_number FROM assessment_versions WHERE assessment_id = ?",
      )
      .bind(assessmentId)
      .first<{ next_version_number: number }>();
    return row?.next_version_number ?? 1;
  }

  async prepareCommit(plan: QtiPublicationPlan): Promise<QtiPreparedPublicationCommit> {
    const statements = [
      ...buildAssessmentStatements(this.db, plan),
      ...buildVersionStatements(this.db, plan),
      ...buildArtifactStatements(this.db, plan),
      ...buildItemMetadataStatements(this.db, plan),
      ...buildStandardStatements(this.db, plan),
      ...buildFindingStatements(this.db, plan),
    ];
    if (statements.length > MAX_STATEMENTS_PER_PUBLICATION) {
      throw new PublishInputError(
        422,
        `QTI publication requires ${statements.length} D1 statements; the maximum is ${MAX_STATEMENTS_PER_PUBLICATION}`,
      );
    }
    return {
      execute: async () => {
        await this.db.batch(statements);
      },
    };
  }
}

export class CloudflareQtiPublicationObjectStore implements QtiPublicationObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(object: QtiPublicationObject): Promise<void> {
    await this.bucket.put(object.key, object.bytes, {
      httpMetadata: { contentType: object.contentType },
    });
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

function buildAssessmentStatements(
  db: D1Database,
  plan: QtiPublicationPlan,
): D1PreparedStatement[] {
  const target = plan.assessmentTarget;
  return target.kind === "new"
    ? buildInsertStatements(
        db,
        "assessments",
        ["id", "tenant_id", "slug", "title", "created_at"],
        [
          [
            target.assessment.id,
            target.assessment.tenantId,
            target.assessment.slug,
            target.assessment.title,
            target.assessment.createdAt,
          ],
        ],
      )
    : [];
}

function buildVersionStatements(db: D1Database, plan: QtiPublicationPlan): D1PreparedStatement[] {
  const version = plan.assessmentVersion;
  return buildInsertStatements(
    db,
    "assessment_versions",
    [
      "id",
      "assessment_id",
      "version_number",
      "source_package_sha256",
      "package_object_key",
      "manifest_object_key",
      "delivery_policy_snapshot",
      "qti_timing_metadata_json",
      "created_at",
    ],
    [
      [
        version.id,
        version.assessmentId,
        version.versionNumber,
        version.sourcePackageSha256,
        version.packageObjectKey,
        version.manifestObjectKey,
        JSON.stringify(version.deliveryPolicySnapshot),
        plan.qtiTimingMetadataJson,
        version.createdAt,
      ],
    ],
  );
}

function buildArtifactStatements(db: D1Database, plan: QtiPublicationPlan): D1PreparedStatement[] {
  return buildInsertStatements(
    db,
    "delivery_artifacts",
    [
      "id",
      "assessment_version_id",
      "artifact_type",
      "logical_id",
      "href",
      "object_key",
      "media_type",
      "size_bytes",
      "sha256",
      "created_at",
    ],
    plan.artifacts.map((record) => [
      record.id,
      record.assessmentVersionId,
      record.artifactType,
      record.logicalId,
      record.href,
      record.objectKey,
      record.mediaType,
      record.sizeBytes,
      record.sha256,
      record.createdAt,
    ]),
  );
}

function buildItemMetadataStatements(
  db: D1Database,
  plan: QtiPublicationPlan,
): D1PreparedStatement[] {
  return buildInsertStatements(
    db,
    "assessment_item_metadata",
    [
      "id",
      "assessment_version_id",
      "item_id",
      "item_identifier",
      "item_title",
      "item_type",
      "max_score",
      "metadata_json",
      "time_dependent",
      "qti_timing_metadata_json",
      "created_at",
    ],
    plan.itemMetadata.map((record) => [
      record.id,
      record.assessmentVersionId,
      record.itemId,
      record.itemIdentifier,
      record.itemTitle,
      record.itemType,
      record.maxScore,
      record.metadataJson,
      record.timeDependent,
      record.qtiTimingMetadataJson,
      record.createdAt,
    ]),
  );
}

function buildStandardStatements(db: D1Database, plan: QtiPublicationPlan): D1PreparedStatement[] {
  return buildInsertStatements(
    db,
    "assessment_item_standard_alignments",
    [
      "id",
      "assessment_version_id",
      "item_id",
      "standard_id",
      "standard_code",
      "standard_label",
      "standard_uri",
      "provider_id",
      "resource_label",
      "weight",
      "metadata_json",
      "created_at",
    ],
    plan.standards.map((record) => [
      record.id,
      record.assessmentVersionId,
      record.itemId,
      record.standardId,
      record.standardCode,
      record.standardLabel,
      record.standardUri,
      record.providerId,
      record.resourceLabel,
      record.weight,
      record.metadataJson,
      record.createdAt,
    ]),
  );
}

function buildFindingStatements(db: D1Database, plan: QtiPublicationPlan): D1PreparedStatement[] {
  return buildInsertStatements(
    db,
    "assessment_version_validation_findings",
    [
      "id",
      "assessment_version_id",
      "category",
      "scope",
      "code",
      "message",
      "target_id",
      "metadata_json",
      "created_at",
    ],
    plan.findings.map((record) => [
      record.id,
      record.assessmentVersionId,
      record.finding.category,
      record.finding.scope,
      record.finding.code,
      record.finding.message,
      record.finding.targetId,
      JSON.stringify(record.finding.metadata),
      record.createdAt,
    ]),
  );
}

function buildInsertStatements(
  db: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): D1PreparedStatement[] {
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BINDINGS_PER_STATEMENT / columns.length));
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const chunk = rows.slice(offset, offset + rowsPerStatement);
    const valuePlaceholders = `(${columns.map(() => "?").join(", ")})`;
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk
      .map(() => valuePlaceholders)
      .join(", ")}`;
    statements.push(db.prepare(sql).bind(...chunk.flat()));
  }
  return statements;
}
