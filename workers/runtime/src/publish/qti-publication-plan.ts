import {
  type AssessmentRecord,
  type AssessmentVersionRecord,
  buildImmutableVersionPrefix,
  buildVersionManifestObjectKey,
  buildVersionPackageObjectKey,
  type DeliveryArtifactRecord,
  type ImportValidationFinding,
  type ImportValidationReport,
} from "@harbor/content-model";
import {
  buildDeliveryManifest,
  toVersionDeliveryObjectKey,
  toVersionObjectKey,
} from "./build-delivery-manifest";
import type { PreparedQtiPackage } from "./qti-package-preparation";
import { sha256Hex } from "./digest";

export interface QtiPublicationObject {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface QtiItemMetadataRecord {
  readonly id: string;
  readonly assessmentVersionId: string;
  readonly itemId: string;
  readonly itemIdentifier: string;
  readonly itemTitle: string;
  readonly itemType: string | null;
  readonly maxScore: number | null;
  readonly metadataJson: string;
  readonly timeDependent: number;
  readonly qtiTimingMetadataJson: string;
  readonly createdAt: string;
}

export interface QtiStandardRecord {
  readonly id: string;
  readonly assessmentVersionId: string;
  readonly itemId: string;
  readonly standardId: string;
  readonly standardCode: string | null;
  readonly standardLabel: string | null;
  readonly standardUri: string | null;
  readonly providerId: string | null;
  readonly resourceLabel: string | null;
  readonly weight: number | null;
  readonly metadataJson: string;
  readonly createdAt: string;
}

export interface QtiFindingRecord {
  readonly id: string;
  readonly assessmentVersionId: string;
  readonly finding: ImportValidationFinding;
  readonly createdAt: string;
}

export interface QtiPublicationPlan {
  readonly assessmentTarget: QtiPublicationAssessmentTarget;
  readonly assessmentVersion: AssessmentVersionRecord;
  readonly qtiTimingMetadataJson: string;
  readonly objects: readonly QtiPublicationObject[];
  readonly artifacts: readonly DeliveryArtifactRecord[];
  readonly itemMetadata: readonly QtiItemMetadataRecord[];
  readonly standards: readonly QtiStandardRecord[];
  readonly findings: readonly QtiFindingRecord[];
  readonly result: PublishResult;
}

export type QtiPublicationAssessmentTarget =
  | { readonly kind: "existing"; readonly assessment: AssessmentRecord }
  | { readonly kind: "new"; readonly assessment: AssessmentRecord };

export interface PublishResult {
  readonly assessmentId: string;
  readonly assessmentVersionId: string;
  readonly packageObjectKey: string;
  readonly manifestObjectKey: string;
  readonly deliveryPolicySnapshot: PreparedQtiPackage["deliveryPolicySnapshot"];
  readonly validation: ImportValidationReport;
}

export interface QtiPublicationPlanInput {
  readonly packageName: string;
  readonly packageBytes: Uint8Array;
  readonly assessmentTarget: QtiPublicationAssessmentTarget;
  readonly assessmentVersionId: string;
  readonly versionNumber: number;
  readonly preparedPackage: PreparedQtiPackage;
  readonly validation: ImportValidationReport;
  readonly createdAt: string;
  readonly generateId: (prefix: string) => string;
}

/** Construct every immutable object and database record from one timestamp and ID source. */
export async function buildQtiPublicationPlan(
  input: QtiPublicationPlanInput,
): Promise<QtiPublicationPlan> {
  const assessment = input.assessmentTarget.assessment;
  const versionIdentity = {
    tenantId: assessment.tenantId,
    assessmentId: assessment.id,
    versionId: input.assessmentVersionId,
  };
  const prefix = buildImmutableVersionPrefix(versionIdentity);
  const packageObjectKey = buildVersionPackageObjectKey(versionIdentity, input.packageName);
  const manifestObjectKey = buildVersionManifestObjectKey(versionIdentity);
  const manifest = buildDeliveryManifest({
    assessmentInstructions: input.preparedPackage.assessmentInstructions,
    ...(input.preparedPackage.testSequence
      ? {
          testSequence: {
            objectKey: `${prefix}/execution/test.xml`,
            itemIdsByRef: input.preparedPackage.testSequence.itemIdsByRef,
            answerCount: input.preparedPackage.testSequence.answerCount,
          },
        }
      : {}),
    ...(input.preparedPackage.fixedTestOrder
      ? {
          fixedTestOrder: {
            objectKey: `${prefix}/execution/test.xml`,
            testHref: input.preparedPackage.fixedTestOrder.testHref,
            itemIdsByRef: input.preparedPackage.fixedTestOrder.itemIdsByRef,
          },
        }
      : {}),
    tenantId: assessment.tenantId,
    assessmentId: assessment.id,
    assessmentVersionId: input.assessmentVersionId,
    title: input.preparedPackage.title,
    packageObjectKey,
    deliveryPolicySnapshot: input.preparedPackage.deliveryPolicySnapshot,
    qtiTiming: input.preparedPackage.qtiTiming,
    items: input.preparedPackage.items.map((item) => ({
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      href: item.href,
      deliveryObjectKey: toVersionDeliveryObjectKey(prefix, item.href),
      assetIds: [...item.assetIds],
      feedbackAssetIds: [...item.feedbackAssetIds],
      maxScore: item.maxScore,
      adaptive: item.adaptive,
      timeDependent: item.timeDependent,
      timeLimits: item.timeLimits,
      itemSessionControl: item.itemSessionControl,
    })),
    assets: input.preparedPackage.assets.map((asset) => ({
      id: asset.id,
      href: asset.href,
      mediaType: asset.mediaType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    })),
  });
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestSha256 = await sha256Hex(manifestBytes);

  const execution = input.preparedPackage.testSequence ?? input.preparedPackage.fixedTestOrder;
  const objects: QtiPublicationObject[] = [
    ...(execution
      ? [
          {
            key: `${prefix}/execution/test.xml`,
            bytes: new TextEncoder().encode(execution.xml),
            contentType: "application/xml",
          },
        ]
      : []),
    { key: packageObjectKey, bytes: input.packageBytes, contentType: "application/zip" },
    { key: manifestObjectKey, bytes: manifestBytes, contentType: "application/json" },
    ...input.preparedPackage.items.flatMap((item) => [
      {
        key: toVersionObjectKey(prefix, item.href),
        bytes: item.bytes,
        contentType: item.mediaType,
      },
      {
        key: toVersionDeliveryObjectKey(prefix, item.href),
        bytes: item.deliveryBytes,
        contentType: item.mediaType,
      },
    ]),
    ...input.preparedPackage.assets.map((asset) => ({
      key: toVersionObjectKey(prefix, asset.href),
      bytes: asset.bytes,
      contentType: asset.mediaType,
    })),
  ];

  const assessmentVersion: AssessmentVersionRecord = {
    id: input.assessmentVersionId,
    assessmentId: assessment.id,
    versionNumber: input.versionNumber,
    sourcePackageSha256: input.preparedPackage.packageSha256,
    packageObjectKey,
    manifestObjectKey,
    deliveryPolicySnapshot: input.preparedPackage.deliveryPolicySnapshot,
    createdAt: input.createdAt,
  };
  const artifacts: DeliveryArtifactRecord[] = [
    artifact(
      input,
      "package",
      "package",
      input.packageName,
      packageObjectKey,
      "application/zip",
      input.packageBytes.byteLength,
      input.preparedPackage.packageSha256,
    ),
    artifact(
      input,
      "manifest",
      "delivery-manifest",
      "manifests/delivery.json",
      manifestObjectKey,
      "application/json",
      manifestBytes.byteLength,
      manifestSha256,
    ),
    ...input.preparedPackage.items.map((item) =>
      artifact(
        input,
        "item",
        item.id,
        item.href,
        toVersionObjectKey(prefix, item.href),
        item.mediaType,
        item.bytes.byteLength,
        item.sha256,
      ),
    ),
    ...input.preparedPackage.assets.map((asset) =>
      artifact(
        input,
        "asset",
        asset.id,
        asset.href,
        toVersionObjectKey(prefix, asset.href),
        asset.mediaType,
        asset.sizeBytes,
        asset.sha256,
      ),
    ),
  ];

  return {
    assessmentTarget: input.assessmentTarget,
    assessmentVersion,
    qtiTimingMetadataJson: JSON.stringify(input.preparedPackage.qtiTiming),
    objects,
    artifacts,
    itemMetadata: input.preparedPackage.items.map((item) => ({
      id: input.generateId("aimeta"),
      assessmentVersionId: input.assessmentVersionId,
      itemId: item.id,
      itemIdentifier: item.identifier,
      itemTitle: item.title,
      itemType: item.itemType,
      maxScore: item.maxScore,
      metadataJson: JSON.stringify({
        href: item.href,
        standardCount: item.standards.length,
        timeDependent: item.timeDependent,
        durationExpressionTypes: item.durationExpressionTypes,
      }),
      timeDependent: item.timeDependent ? 1 : 0,
      qtiTimingMetadataJson: JSON.stringify({
        timeDependent: item.timeDependent,
        timeDependentRaw: item.timeDependentRaw,
        timeLimits: item.timeLimits,
        itemSessionControl: item.itemSessionControl,
        durationExpressionTypes: item.durationExpressionTypes,
      }),
      createdAt: input.createdAt,
    })),
    standards: input.preparedPackage.items.flatMap((item) =>
      item.standards.map((standard) => ({
        id: input.generateId("aistd"),
        assessmentVersionId: input.assessmentVersionId,
        itemId: item.id,
        standardId: standard.standardId,
        standardCode: standard.code,
        standardLabel: standard.label,
        standardUri: standard.uri,
        providerId: standard.providerId,
        resourceLabel: standard.resourceLabel,
        weight: standard.weight,
        metadataJson: JSON.stringify({ source: "qti-csm" }),
        createdAt: input.createdAt,
      })),
    ),
    findings: input.validation.findings.map((finding) => ({
      id: input.generateId("avfind"),
      assessmentVersionId: input.assessmentVersionId,
      finding,
      createdAt: input.createdAt,
    })),
    result: {
      assessmentId: assessment.id,
      assessmentVersionId: input.assessmentVersionId,
      packageObjectKey,
      manifestObjectKey,
      deliveryPolicySnapshot: input.preparedPackage.deliveryPolicySnapshot,
      validation: input.validation,
    },
  };
}

function artifact(
  input: QtiPublicationPlanInput,
  artifactType: DeliveryArtifactRecord["artifactType"],
  logicalId: string,
  href: string,
  objectKey: string,
  mediaType: string,
  sizeBytes: number,
  sha256: string,
): DeliveryArtifactRecord {
  return {
    id: input.generateId("art"),
    assessmentVersionId: input.assessmentVersionId,
    artifactType,
    logicalId,
    href,
    objectKey,
    mediaType,
    sizeBytes,
    sha256,
    createdAt: input.createdAt,
  };
}
