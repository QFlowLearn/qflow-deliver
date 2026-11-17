import type { QtiDiagnostic } from "@longsightgroup/qti3-core";
import type { HarborQtiInteractionCapability } from "@harbor/attempt-protocol";
import {
  type ImportValidationFinding,
  type ImportValidationFindingCategory,
  type ImportValidationReport,
  type QtiTimeLimitsSnapshot,
} from "@harbor/content-model";
import { createEmptyQtiTimingMetadata } from "./qti-delivery-policy";
import type { PreparedQtiPackage } from "./qti-package-preparation";
import { isXmlBoolean } from "./xml";

const SUPPORTED_ASSET_MEDIA_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "text/vtt",
  "text/html",
  "text/css",
]);

/** Build Harbor's stable, ordered import-readiness report from a prepared package. */
export function buildQtiImportValidationReport(
  preparedPackage: PreparedQtiPackage,
): ImportValidationReport {
  const findings: ImportValidationFinding[] = [
    {
      category: "accepted",
      scope: "package",
      code: "qti.package.manifest-present",
      message: "Package includes imsmanifest.xml and was parsed successfully.",
      targetId: "imsmanifest.xml",
      metadata: { packageShape: preparedPackage.packageShape },
    },
    {
      category: "accepted",
      scope: "manifest",
      code:
        preparedPackage.packageShape === "assessment-test-resource"
          ? "qti.package.shape.assessment-test"
          : "qti.package.shape.item-resources",
      message:
        preparedPackage.packageShape === "assessment-test-resource"
          ? "Manifest references a QTI assessment test resource; QFlowLearn Delivery derived delivery item order from the assessment test."
          : "Manifest organization references QTI item resources directly.",
      targetId: null,
      metadata: {
        packageShape: preparedPackage.packageShape,
        itemCount: preparedPackage.items.length,
      },
    },
    {
      category: "accepted",
      scope: "delivery-policy",
      code: "qti.delivery.navigation-mode",
      message: `Delivery navigation mode resolved to ${preparedPackage.deliveryPolicySnapshot.navigationMode}.`,
      targetId: null,
      metadata: {
        navigationMode: preparedPackage.deliveryPolicySnapshot.navigationMode,
      },
    },
    {
      category: "accepted",
      scope: "item",
      code: "qti.items.imported",
      message: `${preparedPackage.items.length} QTI item${preparedPackage.items.length === 1 ? "" : "s"} imported into the immutable delivery manifest.`,
      targetId: null,
      metadata: { itemCount: preparedPackage.items.length },
    },
  ];

  findings.push(...preparedPackage.qtiDiagnostics.map(toQtiDiagnosticFinding));

  const standardCount = preparedPackage.items.reduce(
    (count, item) => count + item.standards.length,
    0,
  );
  findings.push(
    standardCount > 0
      ? {
          category: "accepted",
          scope: "standards",
          code: "qti.csm.standards-present",
          message: `${standardCount} QTI CSM standards alignment${standardCount === 1 ? "" : "s"} imported for reporting.`,
          targetId: null,
          metadata: {
            standardCount,
            alignedItemCount: preparedPackage.items.filter((item) => item.standards.length > 0)
              .length,
          },
        }
      : {
          category: "accepted-with-warning",
          scope: "standards",
          code: "qti.csm.standards-missing",
          message:
            "No QTI CSM standards metadata was found; standards mastery reports will show metadata unavailable for this version.",
          targetId: null,
          metadata: {},
        },
  );

  for (const item of preparedPackage.items) {
    findings.push({
      category: item.timeDependentValid ? "accepted" : "blocked",
      scope: "item",
      code: item.timeDependentValid
        ? "qti.item.time-dependent-parsed"
        : "qti.item.time-dependent-invalid",
      message: item.timeDependentValid
        ? `Item time-dependent is ${item.timeDependent ? "true" : "false"}.`
        : "Item is missing a valid XML boolean time-dependent attribute; QTI 3 requires this attribute.",
      targetId: item.id,
      metadata: {
        itemHref: item.href,
        rawValue: item.timeDependentRaw,
        timeDependent: item.timeDependent,
      },
    });

    if (item.timeDependent) {
      findings.push({
        category:
          item.durationExpressionTypes.length > 0
            ? "accepted-pending-adapter-evidence"
            : "accepted",
        scope: "item",
        code:
          item.durationExpressionTypes.length > 0
            ? "qti.item.time-dependent-duration-scoring"
            : "qti.item.time-dependent-supported",
        message:
          item.durationExpressionTypes.length > 0
            ? "Time-dependent item uses duration-aware scoring expressions; QFlowLearn Delivery will provide authoritative duration built-ins and requires renderer/scorer adapter evidence before production delivery."
            : "Time-dependent item will receive QFlowLearn Delivery authoritative duration built-ins during delivery and result export.",
        targetId: item.id,
        metadata: {
          itemHref: item.href,
          durationExpressionTypes: item.durationExpressionTypes,
        },
      });
    } else if (item.durationExpressionTypes.length > 0) {
      findings.push({
        category: "accepted-with-warning",
        scope: "item",
        code: "qti.item.duration-expression-without-time-dependent",
        message:
          "Item uses duration-aware expressions but declares time-dependent=false; QFlowLearn Delivery preserved the item and will surface this package semantics issue before delivery.",
        targetId: item.id,
        metadata: {
          itemHref: item.href,
          durationExpressionTypes: item.durationExpressionTypes,
        },
      });
    }

    findings.push(
      item.maxScore === null
        ? {
            category: "accepted-with-warning",
            scope: "item",
            code: "qti.item.max-score-missing",
            message:
              "Item does not declare MAXSCORE; scoring and item-analysis max-score reporting may be unavailable.",
            targetId: item.id,
            metadata: { itemHref: item.href, itemType: item.itemType },
          }
        : {
            category: "accepted",
            scope: "item",
            code: "qti.item.max-score-present",
            message: "Item declares MAXSCORE for item-level reporting.",
            targetId: item.id,
            metadata: { itemHref: item.href, maxScore: item.maxScore },
          },
    );

    if (item.interactions.length === 0) {
      findings.push({
        category: "accepted-with-warning",
        scope: "item",
        code: "qti.item.interaction-missing",
        message:
          "No QTI interaction element was detected in this item; QFlowLearn Delivery preserved the item as informational content for delivery review.",
        targetId: item.id,
        metadata: { itemHref: item.href, itemType: item.itemType },
      });
      continue;
    }

    for (const interaction of item.interactions) {
      const readiness = classifyInteraction(interaction);
      findings.push({
        ...readiness,
        scope: "item",
        targetId: item.id,
        metadata: {
          itemHref: item.href,
          interactionType: interaction.type,
          qti3PlayerSupported: interaction.qti3RegistryStatus === "supported",
          harborValidated: interaction.harborEvidence === "validated",
        },
      });
    }
  }

  if (preparedPackage.assets.length === 0) {
    findings.push({
      category: "accepted",
      scope: "asset",
      code: "qti.assets.none",
      message: "No external item assets were referenced by the package.",
      targetId: null,
      metadata: {},
    });
  }
  for (const asset of preparedPackage.assets) {
    const supported = SUPPORTED_ASSET_MEDIA_TYPES.has(asset.mediaType);
    findings.push({
      category: supported ? "accepted" : "accepted-with-warning",
      scope: "asset",
      code: supported ? "qti.asset.media-supported" : "qti.asset.media-unknown",
      message: supported
        ? `${asset.mediaType} asset is accepted for QFlowLearn Delivery QTI 3 delivery.`
        : `${asset.mediaType} asset was imported and preserved; delivery behavior should be reviewed because the media type is not in QFlowLearn Delivery's known browser-safe asset allowlist.`,
      targetId: asset.id,
      metadata: { href: asset.href, mediaType: asset.mediaType, sizeBytes: asset.sizeBytes },
    });
  }

  findings.push(...buildTimingValidationFindings(preparedPackage));
  return summarizeImportValidationFindings(findings);
}

type InteractionReadinessLevel = "harbor-validated" | "qti3-supported" | "extension-required";

interface InteractionReadiness {
  readonly category: ImportValidationFindingCategory;
  readonly code: string;
  readonly message: string;
}

interface InteractionReadinessDecision {
  readonly category: ImportValidationFindingCategory;
  readonly code: string;
  readonly message: (interactionType: string) => string;
}

const INTERACTION_READINESS_DECISIONS: Record<
  InteractionReadinessLevel,
  InteractionReadinessDecision
> = {
  "harbor-validated": {
    category: "accepted",
    code: "qti.item.interaction-accepted",
    message: (interactionType) =>
      `${interactionType} is accepted for QFlowLearn Delivery QTI 3 delivery.`,
  },
  "qti3-supported": {
    category: "accepted-pending-adapter-evidence",
    code: "qti.item.interaction-qti3-player-supported",
    message: (interactionType) =>
      `${interactionType} is supported by the qti3 player and is in QFlowLearn Delivery's QTI 3 delivery compliance target; adapter/runtime evidence is pending.`,
  },
  "extension-required": {
    category: "accepted-with-warning",
    code: "qti.item.interaction-requires-renderer-extension",
    message: (interactionType) =>
      `${interactionType} was preserved in the immutable QTI package; delivery requires renderer extension or vendor confirmation because it is not registered by the qti3 player.`,
  },
};

function classifyInteraction(interaction: HarborQtiInteractionCapability): InteractionReadiness {
  const level = interactionReadinessLevel(interaction);
  const decision = INTERACTION_READINESS_DECISIONS[level];
  return {
    category: decision.category,
    code: decision.code,
    message: decision.message(interaction.type),
  };
}

function interactionReadinessLevel(
  interaction: HarborQtiInteractionCapability,
): InteractionReadinessLevel {
  if (interaction.harborEvidence === "validated") return "harbor-validated";
  if (interaction.qti3RegistryStatus === "supported") return "qti3-supported";
  return "extension-required";
}

/** Calculate the stable report summary without changing finding order. */
export function summarizeImportValidationFindings(
  findings: readonly ImportValidationFinding[],
): ImportValidationReport {
  const acceptedCount = findings.filter((finding) => finding.category === "accepted").length;
  const acceptedWithWarningCount = findings.filter(
    (finding) => finding.category === "accepted-with-warning",
  ).length;
  const acceptedPendingAdapterEvidenceCount = findings.filter(
    (finding) => finding.category === "accepted-pending-adapter-evidence",
  ).length;
  const blockedCount = findings.filter((finding) => finding.category === "blocked").length;
  return {
    summary: {
      readyForDelivery: blockedCount === 0,
      acceptedCount,
      acceptedWithWarningCount,
      acceptedPendingAdapterEvidenceCount,
      blockedCount,
    },
    findings: [...findings],
  };
}

function toQtiDiagnosticFinding(diagnostic: QtiDiagnostic): ImportValidationFinding {
  const blocksReadiness = diagnostic.severity === "error" && diagnostic.code.startsWith("package.");
  return {
    category: blocksReadiness
      ? "blocked"
      : diagnostic.severity === "error" || diagnostic.severity === "warning"
        ? "accepted-with-warning"
        : "accepted",
    scope: "package",
    code: "qti.package.diagnostic",
    message: diagnostic.message,
    targetId: diagnostic.path ?? null,
    metadata: {
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
      path: diagnostic.path ?? null,
    },
  };
}

function buildTimingValidationFindings(
  preparedPackage: PreparedQtiPackage,
): ImportValidationFinding[] {
  const qtiTiming = preparedPackage.qtiTiming ?? createEmptyQtiTimingMetadata();
  const findings: ImportValidationFinding[] = [];
  const timeLimits = [
    qtiTiming.assessmentTest?.timeLimits ?? null,
    ...qtiTiming.testParts.map((part) => part.timeLimits),
    ...qtiTiming.sections.map((section) => section.timeLimits),
    ...qtiTiming.itemRefs.map((itemRef) => itemRef.timeLimits),
  ].filter((entry): entry is QtiTimeLimitsSnapshot => entry !== null);

  findings.push(
    timeLimits.length === 0
      ? {
          category: "accepted",
          scope: "delivery-policy",
          code: "qti.timing.time-limits-none",
          message: "No qti-time-limits nodes were found in the package.",
          targetId: null,
          metadata: {},
        }
      : {
          category: "accepted",
          scope: "delivery-policy",
          code: "qti.timing.time-limits-parsed",
          message: `${timeLimits.length} qti-time-limits node${timeLimits.length === 1 ? "" : "s"} parsed and preserved in the immutable delivery manifest.`,
          targetId: null,
          metadata: { timeLimitCount: timeLimits.length },
        },
  );

  for (const limits of timeLimits) {
    const invalidNumberAttributes = ["min-time", "max-time"].filter((name) => {
      const raw = limits.rawAttributes[name];
      if (raw === null || raw === undefined) return false;
      const parsed = Number(raw);
      return !Number.isFinite(parsed) || parsed < 0;
    });
    const rawAllowLate = limits.rawAttributes["allow-late-submission"];
    const invalidAllowLate = rawAllowLate !== null && !isXmlBoolean(rawAllowLate);
    const minGreaterThanMax =
      limits.minTimeSeconds !== null &&
      limits.maxTimeSeconds !== null &&
      limits.minTimeSeconds > limits.maxTimeSeconds;
    const invalid = invalidNumberAttributes.length > 0 || invalidAllowLate || minGreaterThanMax;
    findings.push({
      category: invalid ? "blocked" : "accepted",
      scope: "delivery-policy",
      code: invalid ? "qti.timing.time-limits-invalid" : "qti.timing.time-limits-accepted",
      message: invalid
        ? "qti-time-limits contains invalid timing semantics; QFlowLearn Delivery preserved the node but will not silently deliver it as supported."
        : `${limits.scopeType} time limits parsed with allow-late-submission=${limits.allowLateSubmission}.`,
      targetId: limits.identifier,
      metadata: {
        scopeType: limits.scopeType,
        minTimeSeconds: limits.minTimeSeconds,
        maxTimeSeconds: limits.maxTimeSeconds,
        allowLateSubmission: limits.allowLateSubmission,
        invalidNumberAttributes,
        invalidAllowLate,
        minGreaterThanMax,
      },
    });
  }

  for (const part of qtiTiming.testParts) {
    findings.push({
      category: "accepted",
      scope: "delivery-policy",
      code: "qti.timing.test-part-modes",
      message: `Test part ${part.identifier} declares ${part.navigationMode} navigation and ${part.submissionMode} submission.`,
      targetId: part.identifier,
      metadata: { navigationMode: part.navigationMode, submissionMode: part.submissionMode },
    });
  }

  const controls = qtiTiming.itemRefs.filter((itemRef) => itemRef.itemSessionControl);
  const feedbackControls = controls.filter((ref) => {
    const control = ref.itemSessionControl;
    return (
      control &&
      typeof control.showFeedback === "boolean" &&
      Object.entries(control.rawAttributes).every(
        ([key, value]) => key === "show-feedback" || value === null,
      )
    );
  });
  if (feedbackControls.length)
    findings.push({
      category: "accepted",
      scope: "delivery-policy",
      code: "qti.feedback.release-enforced",
      message:
        "Harbor withholds authored answer feedback until authoritative whole-assessment submission; show-feedback=false suppresses it entirely.",
      targetId: null,
      metadata: { itemRefIds: feedbackControls.map((ref) => ref.identifier) },
    });
  const itemSessionControls = controls.filter((ref) => !feedbackControls.includes(ref));
  if (itemSessionControls.length > 0) {
    findings.push({
      category: "blocked",
      scope: "delivery-policy",
      code: "qti.timing.item-session-control-parsed",
      message: `${itemSessionControls.length} item-session-control node${itemSessionControls.length === 1 ? "" : "s"} preserved for inspection; Harbor does not enforce these controls and cannot deliver this version.`,
      targetId: null,
      metadata: { itemRefIds: itemSessionControls.map((itemRef) => itemRef.identifier) },
    });
  }
  return findings;
}
