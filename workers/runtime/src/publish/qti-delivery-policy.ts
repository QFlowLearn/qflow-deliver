import path from "node:path";
import type {
  QtiAssessmentSectionPackageModel,
  QtiAssessmentTestItemRef,
  QtiAssessmentTestPackageModel,
  QtiItemSessionControl,
  QtiTestPartPackageModel,
  QtiTimeLimits,
} from "@longsightgroup/qti3-core";
import {
  DEFAULT_DELIVERY_POLICY_SNAPSHOT,
  type DeliveryPolicySnapshot,
  type QtiAssessmentItemRefTimingSnapshot,
  type QtiAssessmentSectionTimingSnapshot,
  type QtiItemSessionControlSnapshot,
  type QtiNavigationMode,
  type QtiSubmissionMode,
  type QtiTestPartTimingSnapshot,
  type QtiTimingMetadataSnapshot,
  type QtiTimingScopeType,
  type QtiTimeLimitsSnapshot,
} from "@harbor/content-model";
import { PublishInputError } from "./publish-errors";

/** Harbor delivery policy and timing projection derived from a qti3 assessment test. */
export interface QtiDeliveryPolicyProjection {
  readonly deliveryPolicySnapshot: DeliveryPolicySnapshot;
  readonly qtiTiming: QtiTimingMetadataSnapshot;
}

/** Project the typed qti3 assessment-test hierarchy into Harbor's persisted delivery policy. */
export function projectQtiDeliveryPolicy(
  assessmentTest: QtiAssessmentTestPackageModel | undefined,
): QtiDeliveryPolicyProjection {
  const qtiTiming = buildQtiTimingMetadata(assessmentTest);
  if (!assessmentTest) {
    return {
      deliveryPolicySnapshot: DEFAULT_DELIVERY_POLICY_SNAPSHOT,
      qtiTiming,
    };
  }

  const policy: DeliveryPolicySnapshot = {
    ...DEFAULT_DELIVERY_POLICY_SNAPSHOT,
    navigationMode: assessmentTest.testParts.some(
      (testPart) => requireNavigationMode(testPart) === "nonlinear",
    )
      ? "free"
      : "linear",
    submissionMode: assessmentTest.testParts.some(
      (testPart) => requireSubmissionMode(testPart) === "simultaneous",
    )
      ? "simultaneous"
      : "individual",
  };

  return {
    deliveryPolicySnapshot: policy,
    qtiTiming,
  };
}

/** Create Harbor's canonical empty QTI timing snapshot. */
export function createEmptyQtiTimingMetadata(): QtiTimingMetadataSnapshot {
  return { assessmentTest: null, testParts: [], sections: [], itemRefs: [] };
}

/** Resolve the assessment-item-ref timing entry associated with one prepared item. */
export function findQtiItemRefTiming(
  qtiTiming: QtiTimingMetadataSnapshot,
  itemId: string,
  href: string,
): QtiAssessmentItemRefTimingSnapshot | null {
  const normalizedHref = path.posix.normalize(href);
  return (
    qtiTiming.itemRefs.find(
      (itemRef) => itemRef.itemId === itemId || itemRef.href === normalizedHref,
    ) ?? null
  );
}

/** Finalize delivery policy after binding timing records to Harbor's canonical item identifiers. */
export function bindQtiDeliveryPolicyItems(
  projection: QtiDeliveryPolicyProjection,
  items: readonly { readonly id: string; readonly href: string }[],
): QtiDeliveryPolicyProjection {
  const itemIdByHref = new Map(items.map((item) => [path.posix.normalize(item.href), item.id]));
  const qtiTiming: QtiTimingMetadataSnapshot = {
    assessmentTest: projection.qtiTiming.assessmentTest,
    testParts: projection.qtiTiming.testParts.map((part) => ({
      ...part,
      sectionIds: [...part.sectionIds],
    })),
    sections: projection.qtiTiming.sections.map((section) => ({
      ...section,
      itemRefIds: [...section.itemRefIds],
    })),
    itemRefs: projection.qtiTiming.itemRefs.map((itemRef) => ({
      ...itemRef,
      itemId: itemRef.itemId ?? itemIdByHref.get(path.posix.normalize(itemRef.href)) ?? null,
    })),
  };
  return {
    deliveryPolicySnapshot: qtiTiming.assessmentTest
      ? { ...projection.deliveryPolicySnapshot, qtiTiming }
      : projection.deliveryPolicySnapshot,
    qtiTiming,
  };
}

function buildQtiTimingMetadata(
  assessmentTest: QtiAssessmentTestPackageModel | undefined,
): QtiTimingMetadataSnapshot {
  if (!assessmentTest) return createEmptyQtiTimingMetadata();

  const testParts: QtiTestPartTimingSnapshot[] = [];
  const sections: QtiAssessmentSectionTimingSnapshot[] = [];
  const itemRefs: QtiAssessmentItemRefTimingSnapshot[] = [];

  for (const testPart of assessmentTest.testParts) {
    testParts.push({
      identifier: testPart.identifier,
      navigationMode: requireNavigationMode(testPart),
      submissionMode: requireSubmissionMode(testPart),
      timeLimits: toQtiTimeLimitsSnapshot(testPart.timeLimits, "test-part", testPart.identifier),
      sectionIds: testPart.sections.map((section) => section.identifier),
    });
    for (const section of testPart.sections) {
      appendQtiSectionTiming(section, testPart.identifier, sections, itemRefs);
    }
  }

  return {
    assessmentTest: {
      identifier: assessmentTest.identifier,
      title: assessmentTest.title ?? null,
      timeLimits: toQtiTimeLimitsSnapshot(
        assessmentTest.timeLimits,
        "assessment-test",
        assessmentTest.identifier,
      ),
    },
    testParts,
    sections,
    itemRefs,
  };
}

function appendQtiSectionTiming(
  section: QtiAssessmentSectionPackageModel,
  testPartId: string,
  sections: QtiAssessmentSectionTimingSnapshot[],
  itemRefs: QtiAssessmentItemRefTimingSnapshot[],
): void {
  sections.push({
    identifier: section.identifier,
    title: section.title ?? null,
    visible: section.visible ?? null,
    testPartId,
    timeLimits: toQtiTimeLimitsSnapshot(
      section.timeLimits,
      "assessment-section",
      section.identifier,
    ),
    itemRefIds: section.itemRefs.flatMap((itemRef) =>
      itemRef.identifier === undefined ? [] : [itemRef.identifier],
    ),
  });

  for (const itemRef of section.itemRefs) {
    itemRefs.push(toQtiItemRefTiming(itemRef, testPartId, section.identifier));
  }
  for (const childSection of section.sections) {
    appendQtiSectionTiming(childSection, testPartId, sections, itemRefs);
  }
}

function toQtiItemRefTiming(
  itemRef: QtiAssessmentTestItemRef,
  testPartId: string,
  sectionId: string,
): QtiAssessmentItemRefTimingSnapshot {
  const identifier = itemRef.identifier ?? `${sectionId}:${itemRef.href}`;
  return {
    identifier,
    href: path.posix.normalize(itemRef.href),
    itemId: null,
    testPartId,
    sectionId,
    timeLimits: toQtiTimeLimitsSnapshot(itemRef.timeLimits, "assessment-item-ref", identifier),
    itemSessionControl: toQtiItemSessionControlSnapshot(itemRef.itemSessionControl),
  };
}

function toQtiTimeLimitsSnapshot(
  timeLimits: QtiTimeLimits | undefined,
  scopeType: QtiTimingScopeType,
  identifier: string,
): QtiTimeLimitsSnapshot | null {
  if (!timeLimits) return null;
  return {
    scopeType,
    identifier,
    minTimeSeconds: timeLimits.minTimeSeconds ?? null,
    maxTimeSeconds: timeLimits.maxTimeSeconds ?? null,
    allowLateSubmission: timeLimits.allowLateSubmission ?? false,
    rawAttributes: {
      "min-time": timeLimits.attributes["min-time"] ?? null,
      "max-time": timeLimits.attributes["max-time"] ?? null,
      "allow-late-submission": timeLimits.attributes["allow-late-submission"] ?? null,
    },
  };
}

function toQtiItemSessionControlSnapshot(
  control: QtiItemSessionControl | undefined,
): QtiItemSessionControlSnapshot | null {
  if (!control) return null;
  return {
    maxAttempts: control.maxAttempts ?? null,
    showFeedback: control.showFeedback ?? null,
    allowReview: control.allowReview ?? null,
    showSolution: control.showSolution ?? null,
    allowComment: control.allowComment ?? null,
    allowSkipping: control.allowSkipping ?? null,
    validateResponses: control.validateResponses ?? null,
    rawAttributes: {
      "max-attempts": control.attributes["max-attempts"] ?? null,
      "show-feedback": control.attributes["show-feedback"] ?? null,
      "allow-review": control.attributes["allow-review"] ?? null,
      "show-solution": control.attributes["show-solution"] ?? null,
      "allow-comment": control.attributes["allow-comment"] ?? null,
      "allow-skipping": control.attributes["allow-skipping"] ?? null,
      "validate-responses": control.attributes["validate-responses"] ?? null,
    },
  };
}

function requireNavigationMode(testPart: QtiTestPartPackageModel): QtiNavigationMode {
  if (testPart.navigationMode) return testPart.navigationMode;
  throw new PublishInputError(
    422,
    `Unsupported package structure: test part ${testPart.identifier} has invalid navigation-mode`,
  );
}

function requireSubmissionMode(testPart: QtiTestPartPackageModel): QtiSubmissionMode {
  if (testPart.submissionMode) return testPart.submissionMode;
  throw new PublishInputError(
    422,
    `Unsupported package structure: test part ${testPart.identifier} has invalid submission-mode`,
  );
}
