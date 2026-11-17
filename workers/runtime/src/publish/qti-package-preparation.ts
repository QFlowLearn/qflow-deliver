import path from "node:path";
import {
  collectQtiResponseProcessingExpressions,
  detectPackageMediaType,
  discoverQtiPackageContentAssets,
  type QtiAssessmentItem,
  type QtiContentNode,
  type QtiDiagnostic,
  type QtiPackageEntry,
  type QtiPackageItem,
  type QtiStandardAlignment,
  type QtiStylesheet,
} from "@longsightgroup/qti3-core";
import {
  projectHarborQtiInteractionCapability,
  type HarborQtiInteractionCapability,
} from "@harbor/attempt-protocol";
import {
  packageAssetReferenceFailureMessage,
  resolvePackageAssetReference,
  type AssessmentInstructionBlock,
  type DeliveryPolicySnapshot,
  type QtiItemSessionControlSnapshot,
  type QtiTimingMetadataSnapshot,
  type QtiTimeLimitsSnapshot,
} from "@harbor/content-model";
import {
  assertInitialAdaptiveDeliverySupported,
  assertStaticSecureDeliverySupported,
  buildDeliverySafeItemXml,
  buildInitialAdaptiveDeliveryXml,
} from "../qti/secure-delivery";
import { inlineAssessmentStimuli } from "./inline-assessment-stimuli";
import { sha256Hex } from "./digest";
import {
  bindQtiDeliveryPolicyItems,
  findQtiItemRefTiming,
  projectQtiDeliveryPolicy,
} from "./qti-delivery-policy";
import { parseHarborQtiPackage } from "./qti-package-model";
import { PublishInputError } from "./publish-errors";
import { validatePackageStylesheet } from "./package-stylesheet-policy";
import { isXmlBoolean } from "./xml";
import { prepareTestSequence, type PreparedTestSequence } from "./qti-test-sequence";
import { prepareFixedTestOrder, type PreparedFixedTestOrder } from "./qti-fixed-test-order";
import { prepareAssessmentInstructions } from "./assessment-instructions";

/** Reporting alignment projected from qti3 curriculum-standards metadata. */
export interface PreparedQtiStandardAlignment {
  readonly standardId: string;
  readonly code: string | null;
  readonly label: string | null;
  readonly uri: string | null;
  readonly providerId: string | null;
  readonly resourceLabel: string | null;
  readonly resourcePartId?: string | null;
  readonly weight: number | null;
}

/** One prepared QTI item and its immutable source and delivery representations. */
export interface PreparedQtiItem {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly itemType: string | null;
  readonly maxScore: number | null;
  readonly adaptive: boolean;
  readonly timeDependent: boolean;
  readonly timeDependentRaw: string | null;
  readonly timeDependentValid: boolean;
  readonly durationExpressionTypes: readonly string[];
  readonly timeLimits: QtiTimeLimitsSnapshot | null;
  readonly itemSessionControl: QtiItemSessionControlSnapshot | null;
  readonly href: string;
  readonly bytes: Uint8Array;
  readonly deliveryBytes: Uint8Array;
  readonly sha256: string;
  readonly mediaType: string;
  readonly assetIds: readonly string[];
  readonly feedbackAssetIds: readonly string[];
  readonly standards: readonly PreparedQtiStandardAlignment[];
  readonly interactions: readonly HarborQtiInteractionCapability[];
}

/** One deduplicated package asset prepared for immutable publication. */
export interface PreparedQtiAsset {
  readonly id: string;
  readonly href: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** Fully prepared package with no remaining parsing or delivery-policy work. */
export interface PreparedQtiPackage {
  readonly assessmentInstructions: readonly AssessmentInstructionBlock[];
  readonly testSequence?: PreparedTestSequence;
  readonly fixedTestOrder?: PreparedFixedTestOrder;
  readonly title: string;
  readonly items: readonly PreparedQtiItem[];
  readonly assets: readonly PreparedQtiAsset[];
  readonly packageSha256: string;
  readonly deliveryPolicySnapshot: DeliveryPolicySnapshot;
  readonly qtiTiming: QtiTimingMetadataSnapshot;
  readonly packageShape: "manifest-item-resources" | "assessment-test-resource";
  readonly qtiDiagnostics: readonly QtiDiagnostic[];
}

/** Parse, secure, project, and hash an uploaded QTI package before any external writes occur. */
export async function prepareQtiPackage(packageBytes: Uint8Array): Promise<PreparedQtiPackage> {
  const packageModel = await parseHarborQtiPackage(packageBytes);
  const sourcePackage = packageModel.package;
  const entryBytesByPath = new Map(
    [...packageModel.entriesByPath].map(([href, entry]) => [href, entry.bytes]),
  );
  const assetsByHref = new Map<string, PreparedQtiAsset>();
  const items: PreparedQtiItem[] = [];
  const policyProjection = projectQtiDeliveryPolicy(sourcePackage.assessmentTest);

  for (const sourceItem of sourcePackage.items) {
    const itemDocument = requireParsedItem(sourceItem);
    const itemBytes = requirePackageEntryBytes(packageModel.entriesByPath, sourceItem.href);
    assertPackageLocalStylesheets(itemDocument.stylesheets, sourceItem.href);
    assertSecureDeliveryItem({
      itemIdentifier: itemDocument.identifier,
      itemXml: sourceItem.xml,
      adaptive: itemDocument.adaptive,
    });
    const deliverySourceXml = inlineAssessmentStimuli({
      entriesByPath: entryBytesByPath,
      itemHref: sourceItem.href,
      itemXml: sourceItem.xml,
    });
    const deliveryXml = itemDocument.adaptive
      ? buildInitialAdaptiveDeliveryXml(deliverySourceXml)
      : buildDeliverySafeItemXml(deliverySourceXml);
    const deliveryBytes = new TextEncoder().encode(deliveryXml);
    const assetDiscovery = discoverQtiPackageContentAssets(deliveryXml, sourceItem.href);
    const assetDiagnostic = assetDiscovery.diagnostics.find(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (assetDiagnostic) {
      throw new PublishInputError(422, `Unsupported package structure: ${assetDiagnostic.message}`);
    }

    const assetIds: string[] = [];
    for (const assetHref of assetDiscovery.hrefs) {
      const asset = await prepareAsset(assetHref);
      assetIds.push(asset.id);
    }

    const itemRefTiming = findQtiItemRefTiming(
      policyProjection.qtiTiming,
      itemDocument.identifier,
      sourceItem.href,
    );
    if (
      itemDocument.modalFeedback.length &&
      typeof itemRefTiming?.itemSessionControl?.showFeedback !== "boolean"
    )
      throw new PublishInputError(
        422,
        "Questions with answer feedback require an explicit show-feedback session control before delivery.",
      );
    if (
      itemRefTiming?.itemSessionControl?.showFeedback === true &&
      itemDocument.modalFeedback.some((feedback) => !isLiteralFeedbackContent(feedback.content))
    ) {
      throw new PublishInputError(
        422,
        "Dynamic or external-media answer feedback is unsupported for this delivery. Preserve the original package, explicitly suppress feedback, or use literal explanations with packaged files.",
      );
    }
    const feedbackAssetIds: string[] = [];
    if (itemDocument.modalFeedback.length) {
      const sourceAssets = discoverQtiPackageContentAssets(deliverySourceXml, sourceItem.href);
      const failure = sourceAssets.diagnostics.find((entry) => entry.severity === "error");
      if (failure)
        throw new PublishInputError(422, `Invalid feedback asset reference: ${failure.message}`);
      for (const href of sourceAssets.hrefs) {
        const asset = await prepareAsset(href);
        if (!assetIds.includes(asset.id)) feedbackAssetIds.push(asset.id);
      }
    }
    items.push({
      id: itemDocument.identifier,
      identifier: itemDocument.identifier,
      title: itemDocument.title ?? itemDocument.identifier,
      itemType: itemDocument.interactions[0]?.qtiName ?? null,
      maxScore: readParsedItemMaxScore(sourceItem),
      adaptive: itemDocument.adaptive,
      timeDependent: itemDocument.timeDependent ?? false,
      timeDependentRaw: itemDocument.attributes["time-dependent"] ?? null,
      timeDependentValid: isXmlBoolean(itemDocument.attributes["time-dependent"]),
      durationExpressionTypes: readDurationExpressionTypes(sourceItem),
      timeLimits: itemRefTiming?.timeLimits ?? null,
      itemSessionControl: itemRefTiming?.itemSessionControl ?? null,
      href: path.posix.normalize(sourceItem.href),
      bytes: itemBytes,
      deliveryBytes,
      sha256: await sha256Hex(itemBytes),
      mediaType: "application/xml",
      assetIds,
      feedbackAssetIds,
      standards: sourceItem.standards.flatMap(toPreparedStandardAlignment),
      interactions: itemDocument.interactions.map((interaction) =>
        projectHarborQtiInteractionCapability({
          qtiName: interaction.qtiName,
          qti3RegistryStatus: interaction.registryStatus,
        }),
      ),
    });
  }

  const deliveryPolicy = bindQtiDeliveryPolicyItems(policyProjection, items);
  const instructions = prepareAssessmentInstructions(sourcePackage.assessmentTest, items);
  for (const href of instructions.assetHrefs) await prepareAsset(href);
  const testSequence = prepareTestSequence(sourcePackage.assessmentTest, items);
  if (testSequence && items.some((item) => item.itemSessionControl?.showFeedback === true)) {
    throw new PublishInputError(
      422,
      "Answer feedback after submission is unsupported for adaptive test sequences. Explicitly suppress feedback or publish a fixed assessment.",
    );
  }
  return {
    assessmentInstructions: instructions.blocks,
    title: sourcePackage.title || "Untitled Assessment",
    items: testSequence ? items.map((item) => ({ ...item, maxScore: 1 })) : items,
    assets: [...assetsByHref.values()],
    packageSha256: await sha256Hex(packageBytes),
    deliveryPolicySnapshot: testSequence
      ? { ...deliveryPolicy.deliveryPolicySnapshot, qtiTiming: null }
      : deliveryPolicy.deliveryPolicySnapshot,
    qtiTiming: deliveryPolicy.qtiTiming,
    packageShape: sourcePackage.packageShape,
    qtiDiagnostics: sourcePackage.diagnostics,
    testSequence,
    fixedTestOrder: prepareFixedTestOrder(sourcePackage.assessmentTest, items),
  };

  async function prepareAsset(href: string): Promise<PreparedQtiAsset> {
    const existing = assetsByHref.get(href);
    if (existing) return existing;
    let bytes = requirePackageEntryBytes(packageModel.entriesByPath, href);
    const mediaType =
      sourcePackage.assets.find((asset) => asset.href === href)?.mediaType ??
      detectPackageMediaType(href) ??
      "application/octet-stream";
    if (mediaType === "text/css") bytes = prepareSafeStylesheet(bytes, href);
    const asset = {
      id: createAssetId(href),
      href,
      bytes,
      mediaType,
      sizeBytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    };
    assetsByHref.set(href, asset);
    return asset;
  }
}

function requireParsedItem(sourceItem: QtiPackageItem): QtiAssessmentItem {
  const item = sourceItem.document?.item;
  if (!item?.identifier || !item.title) {
    throw new PublishInputError(
      422,
      `Unsupported package structure: assessment item ${sourceItem.href} requires identifier and title`,
    );
  }
  return item;
}

function requirePackageEntryBytes(
  entriesByPath: ReadonlyMap<string, QtiPackageEntry>,
  href: string,
): Uint8Array {
  const entry = entriesByPath.get(href);
  if (entry) return entry.bytes;
  throw new PublishInputError(422, `Unsupported package structure: missing package entry ${href}`);
}

function readParsedItemMaxScore(sourceItem: QtiPackageItem): number | null {
  const value = sourceItem.document?.item.outcomeDeclarations.find(
    (declaration) => declaration.identifier === "MAXSCORE",
  )?.defaultValue;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function readDurationExpressionTypes(sourceItem: QtiPackageItem): string[] {
  const expressions = collectQtiResponseProcessingExpressions(
    sourceItem.document?.item.responseProcessing,
  );
  return [
    ...new Set(
      expressions.flatMap((expression) =>
        expression.type === "durationCompare" ? [`qti-duration-${expression.operator}`] : [],
      ),
    ),
  ];
}

function toPreparedStandardAlignment(
  standard: QtiStandardAlignment,
): PreparedQtiStandardAlignment[] {
  const standardId = standard.identifier ?? standard.targetUrl ?? standard.text;
  if (!standardId) return [];
  return [
    {
      standardId,
      code: inferStandardCode(standard.text ?? null),
      label: standard.text ?? null,
      uri: standard.targetUrl ?? null,
      providerId: standard.providerIdentifier ?? null,
      resourceLabel: standard.resourceLabel ?? null,
      resourcePartId: standard.resourcePartIdentifier ?? null,
      weight: standard.weight ?? null,
    },
  ];
}

function assertSecureDeliveryItem(input: {
  itemIdentifier: string;
  itemXml: string;
  adaptive: boolean;
}): void {
  try {
    if (input.adaptive) {
      assertInitialAdaptiveDeliverySupported(input);
      return;
    }
    assertStaticSecureDeliverySupported(input);
  } catch (error: unknown) {
    throw new PublishInputError(422, error instanceof Error ? error.message : String(error));
  }
}

function assertPackageLocalStylesheets(
  stylesheets: readonly QtiStylesheet[],
  itemHref: string,
): void {
  for (const stylesheet of stylesheets) {
    if (stylesheet.type !== undefined && stylesheet.type.trim().toLowerCase() !== "text/css") {
      throw new PublishInputError(
        422,
        `Unsupported stylesheet ${stylesheet.href}: media type must be text/css`,
      );
    }
    const resolvedHref = requirePackageLocalReferenceHref(itemHref, stylesheet.href);
    if (detectPackageMediaType(resolvedHref) !== "text/css") {
      throw new PublishInputError(
        422,
        `Unsupported stylesheet ${stylesheet.href}: media type must be text/css`,
      );
    }
  }
}

function requirePackageLocalReferenceHref(itemHref: string, reference: string): string {
  if (reference.includes("#")) {
    throw new PublishInputError(
      422,
      `Unsupported stylesheet reference ${reference}: query strings and fragments are not allowed`,
    );
  }
  const resolution = resolvePackageAssetReference(itemHref, reference);
  if (!resolution.ok) {
    throw new PublishInputError(
      422,
      `Unsupported stylesheet reference ${reference}: ${packageAssetReferenceFailureMessage(resolution.reason)}`,
    );
  }
  return resolution.href;
}

function prepareSafeStylesheet(stylesheetBytes: Uint8Array, href: string): Uint8Array {
  const validation = validatePackageStylesheet(new TextDecoder().decode(stylesheetBytes));
  if (validation.ok) return new TextEncoder().encode(validation.stylesheet);
  throw new PublishInputError(
    422,
    `Unsupported stylesheet ${href}: ${validation.rejection.message}`,
  );
}

function inferStandardCode(label: string | null): string | null {
  const firstToken = label?.trim().split(/\s+/, 1)[0];
  return firstToken && /[A-Za-z0-9]/.test(firstToken) ? firstToken : null;
}

function createAssetId(href: string): string {
  const encodedHref = [...new TextEncoder().encode(path.posix.normalize(href))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `asset:${path.posix.basename(href)}:${encodedHref}`;
}

/** Current results rendering supports literal content through the shared sanitizer. */
function isLiteralFeedbackContent(nodes: readonly QtiContentNode[]): boolean {
  return nodes.every(
    (node) =>
      node.kind === "text" ||
      (node.kind === "element" &&
        Object.entries(node.attributes).every(
          ([name, value]) =>
            !["src", "poster", "data"].includes(name) ||
            !/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(value),
        ) &&
        isLiteralFeedbackContent(node.children)),
  );
}
