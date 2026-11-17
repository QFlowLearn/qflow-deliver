import path from "node:path";

import {
  type AssetDescriptor,
  type AssessmentInstructionBlock,
  buildImmutableVersionPrefix,
  buildVersionManifestObjectKey,
  type DeliveryManifest,
  type DeliveryPolicySnapshot,
  DELIVERY_MANIFEST_SCHEMA_VERSION,
  type ItemDescriptor,
  type QtiItemSessionControlSnapshot,
  type QtiTimeLimitsSnapshot,
  type QtiTimingMetadataSnapshot,
  type TestSequenceDescriptor,
  type FixedTestOrderDescriptor,
} from "@harbor/content-model";

export interface ManifestAssetInput {
  id: string;
  href: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ManifestItemInput {
  id: string;
  identifier: string;
  title: string;
  href: string;
  deliveryObjectKey: string;
  assetIds: string[];
  feedbackAssetIds?: string[];
  maxScore: number | null;
  adaptive: boolean;
  timeDependent: boolean;
  timeLimits: QtiTimeLimitsSnapshot | null;
  itemSessionControl: QtiItemSessionControlSnapshot | null;
}

export interface BuildDeliveryManifestInput {
  assessmentInstructions: readonly AssessmentInstructionBlock[];
  testSequence?: TestSequenceDescriptor;
  fixedTestOrder?: FixedTestOrderDescriptor;
  tenantId: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  packageObjectKey: string;
  deliveryPolicySnapshot: DeliveryPolicySnapshot;
  qtiTiming: QtiTimingMetadataSnapshot | null;
  items: ManifestItemInput[];
  assets: ManifestAssetInput[];
}

export function buildDeliveryManifest(input: BuildDeliveryManifestInput): DeliveryManifest {
  const prefix = buildImmutableVersionPrefix({
    tenantId: input.tenantId,
    assessmentId: input.assessmentId,
    versionId: input.assessmentVersionId,
  });
  const manifestObjectKey = buildVersionManifestObjectKey({
    tenantId: input.tenantId,
    assessmentId: input.assessmentId,
    versionId: input.assessmentVersionId,
  });

  const items = Object.fromEntries(
    input.items.map((item) => {
      const descriptor: ItemDescriptor = {
        id: item.id,
        identifier: item.identifier,
        title: item.title,
        href: item.href,
        deliveryObjectKey: item.deliveryObjectKey,
        objectKey: toVersionObjectKey(prefix, item.href),
        assetIds: item.assetIds,
        ...(item.feedbackAssetIds?.length ? { feedbackAssetIds: item.feedbackAssetIds } : {}),
        maxScore: item.maxScore,
        adaptive: item.adaptive,
        timeDependent: item.timeDependent,
        timeLimits: item.timeLimits,
        itemSessionControl: item.itemSessionControl,
      };

      return [descriptor.id, descriptor];
    }),
  );

  const assets = Object.fromEntries(
    input.assets.map((asset) => {
      const descriptor: AssetDescriptor = {
        id: asset.id,
        href: asset.href,
        objectKey: toVersionObjectKey(prefix, asset.href),
        mediaType: asset.mediaType,
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256,
      };

      return [descriptor.id, descriptor];
    }),
  );

  return {
    assessmentInstructions: input.assessmentInstructions,
    schemaVersion: DELIVERY_MANIFEST_SCHEMA_VERSION,
    tenantId: input.tenantId,
    assessmentId: input.assessmentId,
    assessmentVersionId: input.assessmentVersionId,
    title: input.title,
    packageObjectKey: input.packageObjectKey,
    manifestObjectKey,
    itemOrder: input.items.map((item) => item.id),
    items,
    assets,
    deliveryPolicySnapshot: input.deliveryPolicySnapshot,
    qtiTiming: input.qtiTiming,
    ...(input.testSequence ? { testSequence: input.testSequence } : {}),
    ...(input.fixedTestOrder ? { fixedTestOrder: input.fixedTestOrder } : {}),
  };
}

export function toVersionObjectKey(prefix: string, href: string): string {
  return `${prefix}/${path.posix.normalize(href)}`;
}

export function toVersionDeliveryObjectKey(prefix: string, href: string): string {
  return `${prefix}/delivery/${path.posix.normalize(href)}`;
}
