import type {
  AttemptEventEnvelope,
  AttemptPolicyState,
  AttemptTimingDecision,
  AttemptTimingScopeState,
  AttemptTimingState,
  CurrentItemRef,
  DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import type {
  QtiAssessmentItemRefTimingSnapshot,
  QtiTimeLimitsSnapshot,
  QtiTimingMetadataSnapshot,
} from "@harbor/content-model";

export interface StoredTimingScope {
  key: string;
  scopeType: AttemptTimingScopeState["scopeType"];
  identifier: string;
  itemId: string | null;
  testPartId?: string | null;
  sectionId?: string | null;
  status: AttemptTimingScopeState["status"];
  enteredAt: string | null;
  exitedAt: string | null;
  activeSince: string | null;
  elapsedMilliseconds: number;
  minTimeSeconds: number | null;
  maxTimeSeconds: number | null;
  allowLateSubmission: boolean;
  deadlineAt: string | null;
  unlimited: boolean;
  numAttempts?: number;
}

export interface StoredScopedTimingState {
  policyVersion: number;
  scopes: StoredTimingScope[];
}

export interface ManifestTimingState {
  itemOrder: string[];
  allowedItemRefs: CurrentItemRef[];
  qtiTiming: QtiTimingMetadataSnapshot | null;
}

export function buildInitialScopedTimingState(input: {
  startedAt: string;
  assessmentVersionId: string;
  currentItemRef: CurrentItemRef;
  manifestState: ManifestTimingState;
  deliveryPolicy: DeliveryPolicySnapshot;
  policy: AttemptPolicyState;
}): StoredScopedTimingState {
  const qtiTiming =
    input.manifestState.qtiTiming && input.manifestState.qtiTiming.itemRefs.length > 0
      ? input.manifestState.qtiTiming
      : createDefaultQtiTiming({
          assessmentVersionId: input.assessmentVersionId,
          itemOrder: input.manifestState.itemOrder,
          allowedItemRefs: input.manifestState.allowedItemRefs,
        });
  const currentLocation = resolveItemTimingLocation(qtiTiming, input.currentItemRef.itemId);
  const scopes: StoredTimingScope[] = [];
  const assessmentLimits = applyPolicyTimingToLimits(
    input.deliveryPolicy.qtiTiming?.assessmentTest?.timeLimits ??
      qtiTiming.assessmentTest?.timeLimits ??
      (input.deliveryPolicy.timeLimitSeconds === null
        ? null
        : {
            scopeType: "assessment-test" as const,
            identifier: qtiTiming.assessmentTest?.identifier ?? input.assessmentVersionId,
            minTimeSeconds: null,
            maxTimeSeconds: input.deliveryPolicy.timeLimitSeconds,
            allowLateSubmission: true,
            rawAttributes: {
              "min-time": null,
              "max-time": String(input.deliveryPolicy.timeLimitSeconds),
              "allow-late-submission": "true",
            },
          }),
    input.policy,
  );

  scopes.push(
    createStoredScope({
      scopeType: "assessment-test",
      identifier: qtiTiming.assessmentTest?.identifier ?? input.assessmentVersionId,
      itemId: null,
      testPartId: null,
      sectionId: null,
      limits: assessmentLimits,
      startedAt: input.startedAt,
      status: "interacting",
      active: true,
    }),
  );

  for (const part of qtiTiming.testParts) {
    const active = part.identifier === currentLocation.testPartId;
    scopes.push(
      createStoredScope({
        scopeType: "test-part",
        identifier: part.identifier,
        itemId: null,
        testPartId: part.identifier,
        sectionId: null,
        limits: part.timeLimits,
        startedAt: input.startedAt,
        status: active ? "interacting" : "initial",
        active,
      }),
    );
  }

  for (const section of qtiTiming.sections) {
    const active = section.identifier === currentLocation.sectionId;
    scopes.push(
      createStoredScope({
        scopeType: "assessment-section",
        identifier: section.identifier,
        itemId: null,
        testPartId: section.testPartId,
        sectionId: section.identifier,
        limits: section.timeLimits,
        startedAt: input.startedAt,
        status: active ? "interacting" : "initial",
        active,
      }),
    );
  }

  for (const itemRef of qtiTiming.itemRefs) {
    const itemId = itemRef.itemId ?? itemRef.identifier;
    const active = itemId === input.currentItemRef.itemId;
    scopes.push(
      createStoredScope({
        scopeType: "assessment-item-ref",
        identifier: itemRef.identifier,
        itemId,
        testPartId: itemRef.testPartId,
        sectionId: itemRef.sectionId,
        limits: itemRef.timeLimits,
        startedAt: input.startedAt,
        status: active ? "interacting" : "initial",
        active,
        numAttempts: active ? 1 : 0,
      }),
    );
    scopes.push(
      createStoredScope({
        scopeType: "item-session",
        identifier: itemId,
        itemId,
        testPartId: itemRef.testPartId,
        sectionId: itemRef.sectionId,
        limits: itemRef.timeLimits,
        startedAt: input.startedAt,
        status: active ? "interacting" : "initial",
        active,
        numAttempts: active ? 1 : 0,
      }),
    );
  }

  return {
    policyVersion: input.policy.overlayRevision,
    scopes,
  };
}

export function applyScopedTimingEvent(
  scopedTiming: StoredScopedTimingState,
  currentItemRef: CurrentItemRef,
  event: AttemptEventEnvelope,
  serverTimestamp: string,
): StoredScopedTimingState {
  const scopes = accrueActiveScopes(scopedTiming.scopes, serverTimestamp);

  if (event.type === "navigation.requested") {
    const navigationEvent = event as AttemptEventEnvelope<"navigation.requested">;
    return {
      ...scopedTiming,
      scopes: transitionItemScopes({
        scopes,
        fromItemId: currentItemRef.itemId,
        toItemId: navigationEvent.payload.targetItemRef.itemId,
        at: serverTimestamp,
      }),
    };
  }

  if (event.type === "item.suspended") {
    return {
      ...scopedTiming,
      scopes: setItemScopeStatus(scopes, currentItemRef.itemId, "suspended", serverTimestamp),
    };
  }

  if (event.type === "item.completed") {
    return {
      ...scopedTiming,
      scopes: setItemScopeStatus(scopes, currentItemRef.itemId, "closed", serverTimestamp),
    };
  }

  if (event.type === "submit.requested" || event.type === "timing.auto-submit.requested") {
    return {
      ...scopedTiming,
      scopes: scopes.map((scope) =>
        scope.status === "interacting"
          ? {
              ...scope,
              status: "closed",
              activeSince: null,
              exitedAt: serverTimestamp,
            }
          : scope,
      ),
    };
  }

  return {
    ...scopedTiming,
    scopes,
  };
}

export function buildTimingDecision(
  storedState: { scopedTiming: StoredScopedTimingState },
  event: AttemptEventEnvelope,
  serverTimestamp: string,
): AttemptTimingDecision | null {
  if (event.type !== "submit.requested" && event.type !== "timing.auto-submit.requested") {
    return null;
  }

  const scopeKey =
    event.type === "timing.auto-submit.requested" && "scopeKey" in event.payload
      ? event.payload.scopeKey
      : null;
  const selectedScope = scopeKey
    ? storedState.scopedTiming.scopes.find(
        (scope) =>
          scope.key === scopeKey &&
          scope.deadlineAt &&
          !scope.unlimited &&
          Date.parse(serverTimestamp) > Date.parse(scope.deadlineAt),
      )
    : null;
  const deadlineScope =
    selectedScope ?? findExceededDeadlineScope(storedState.scopedTiming, serverTimestamp);
  if (!deadlineScope) {
    return {
      classification: "on-time",
      scopeKey: null,
      scopeType: null,
      identifier: null,
      deadlineAt: null,
      serverTimestamp,
      allowLateSubmission: null,
    };
  }

  if (event.type === "timing.auto-submit.requested") {
    return {
      classification: "on-time",
      scopeKey: deadlineScope.key,
      scopeType: deadlineScope.scopeType,
      identifier: deadlineScope.identifier,
      deadlineAt: deadlineScope.deadlineAt,
      serverTimestamp,
      allowLateSubmission: deadlineScope.allowLateSubmission,
    };
  }

  return {
    classification: "late-accepted",
    scopeKey: deadlineScope.key,
    scopeType: deadlineScope.scopeType,
    identifier: deadlineScope.identifier,
    deadlineAt: deadlineScope.deadlineAt,
    serverTimestamp,
    allowLateSubmission: deadlineScope.allowLateSubmission,
  };
}

export function findExceededDeadlineScope(
  scopedTiming: StoredScopedTimingState,
  now: string,
): StoredTimingScope | null {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return null;
  }

  return (
    scopedTiming.scopes.find((scope) => {
      if (!scope.deadlineAt || scope.unlimited) {
        return false;
      }
      const deadlineMs = Date.parse(scope.deadlineAt);
      return !Number.isNaN(deadlineMs) && nowMs > deadlineMs;
    }) ?? null
  );
}

export function findExceededAutoSubmitDeadlineScope(
  scopedTiming: StoredScopedTimingState,
  now: string,
): StoredTimingScope | null {
  return findExceededDeadlineScope(
    {
      ...scopedTiming,
      scopes: scopedTiming.scopes.filter(
        (scope) =>
          !scope.allowLateSubmission && scope.status !== "closed" && scope.status !== "initial",
      ),
    },
    now,
  );
}

export function accrueActiveScopes(scopes: StoredTimingScope[], at: string): StoredTimingScope[] {
  return scopes.map((scope) => {
    if (!scope.activeSince) {
      return scope;
    }

    return {
      ...scope,
      elapsedMilliseconds: readScopeElapsedMilliseconds(scope, at),
      activeSince: at,
    };
  });
}

export function renderTimingState(
  timing: AttemptTimingState,
  now = new Date().toISOString(),
  scopedTiming?: StoredScopedTimingState,
): AttemptTimingState {
  const scopes = scopedTiming ? renderTimingScopes(scopedTiming, now) : timing.scopes;
  const currentItemDurationSeconds =
    scopes?.find((scope) => scope.scopeType === "item-session" && scope.status === "interacting")
      ?.elapsedTimeSeconds ??
    scopes?.find(
      (scope) => scope.scopeType === "assessment-item-ref" && scope.status === "interacting",
    )?.elapsedTimeSeconds ??
    timing.currentItemDurationSeconds ??
    null;

  if (!timing.expiresAt) {
    return {
      startedAt: timing.startedAt,
      expiresAt: null,
      softCloseAt: null,
      acceptUntil: null,
      remainingTimeSeconds: null,
      effectivePolicyVersion: scopedTiming?.policyVersion ?? timing.effectivePolicyVersion,
      currentItemDurationSeconds,
      scopes,
    };
  }

  const remainingTimeSeconds = Math.max(
    0,
    Math.ceil((Date.parse(timing.softCloseAt ?? timing.expiresAt) - Date.parse(now)) / 1000),
  );

  return {
    startedAt: timing.startedAt,
    expiresAt: timing.expiresAt,
    softCloseAt: timing.softCloseAt ?? timing.expiresAt,
    acceptUntil: timing.acceptUntil ?? timing.expiresAt,
    remainingTimeSeconds,
    effectivePolicyVersion: scopedTiming?.policyVersion ?? timing.effectivePolicyVersion,
    currentItemDurationSeconds,
    scopes,
  };
}

export function readScopeElapsedMilliseconds(scope: StoredTimingScope, now: string): number {
  if (!scope.activeSince) {
    return scope.elapsedMilliseconds;
  }

  const activeSinceMs = Date.parse(scope.activeSince);
  const nowMs = Date.parse(now);
  if (Number.isNaN(activeSinceMs) || Number.isNaN(nowMs) || nowMs <= activeSinceMs) {
    return scope.elapsedMilliseconds;
  }

  return scope.elapsedMilliseconds + nowMs - activeSinceMs;
}

export function truncateSeconds(milliseconds: number): number {
  return Math.trunc(Math.max(0, milliseconds) / 100) / 10;
}

export function findMinimumTimeBlockingScope(
  scopedTiming: StoredScopedTimingState,
  currentItemId: string,
  now: string,
): StoredTimingScope | null {
  const blockingScopes = scopedTiming.scopes.filter((scope) => {
    if (scope.scopeType !== "assessment-item-ref" && scope.scopeType !== "assessment-section") {
      return false;
    }

    if (scope.minTimeSeconds === null) {
      return false;
    }

    const appliesToCurrentItem =
      scope.scopeType === "assessment-item-ref"
        ? scope.itemId === currentItemId
        : scopedTiming.scopes.some(
            (candidate) =>
              candidate.scopeType === "assessment-item-ref" &&
              candidate.itemId === currentItemId &&
              candidate.sectionId === scope.identifier,
          );
    return (
      appliesToCurrentItem && readScopeElapsedMilliseconds(scope, now) < scope.minTimeSeconds * 1000
    );
  });

  return blockingScopes[0] ?? null;
}

/** Find an unelapsed assessment/part minimum before final submission.
 * A hard deadline takes precedence so minimum time cannot prevent durable completion.
 */
export function findMinimumSubmissionBlockingScope(
  scopedTiming: StoredScopedTimingState,
  now: string,
): StoredTimingScope | null {
  if (findExceededAutoSubmitDeadlineScope(scopedTiming, now)) return null;
  return (
    scopedTiming.scopes.find(
      (scope) =>
        (scope.scopeType === "assessment-test" || scope.scopeType === "test-part") &&
        (scope.status === "interacting" || scope.status === "suspended") &&
        scope.minTimeSeconds !== null &&
        readScopeElapsedMilliseconds(scope, now) < scope.minTimeSeconds * 1000,
    ) ?? null
  );
}

export function readItemTimingScope(
  scopedTiming: StoredScopedTimingState,
  itemId: string,
): StoredTimingScope | null {
  return (
    scopedTiming.scopes.find(
      (scope) => scope.scopeType === "item-session" && scope.itemId === itemId,
    ) ??
    scopedTiming.scopes.find(
      (scope) => scope.scopeType === "assessment-item-ref" && scope.itemId === itemId,
    ) ??
    null
  );
}

export function synchronizeScopedTimingPolicy(
  scopedTiming: StoredScopedTimingState,
  policy: AttemptPolicyState,
): StoredScopedTimingState {
  return {
    policyVersion: policy.overlayRevision,
    scopes: scopedTiming.scopes.map((scope) => {
      if (
        scope.scopeType !== "assessment-test" ||
        policy.timing.effectiveSoftCloseAt === scope.deadlineAt
      ) {
        return scope;
      }

      return {
        ...scope,
        deadlineAt: policy.timing.effectiveSoftCloseAt,
        maxTimeSeconds: policy.timing.effectiveTimeLimitSeconds,
        unlimited: policy.timing.effectiveSoftCloseAt === null,
      };
    }),
  };
}

export function isPolicyTimingUnlimited(policy: AttemptPolicyState): boolean {
  return policy.accommodations.additionalTestingTime?.mode === "unlimited";
}

function renderTimingScopes(
  scopedTiming: StoredScopedTimingState,
  now: string,
): AttemptTimingScopeState[] {
  return scopedTiming.scopes.map((scope) => {
    const elapsedMilliseconds = readScopeElapsedMilliseconds(scope, now);
    return {
      key: scope.key,
      scopeType: scope.scopeType,
      identifier: scope.identifier,
      itemId: scope.itemId,
      status: scope.status,
      elapsedTimeSeconds: truncateSeconds(elapsedMilliseconds),
      enteredAt: scope.enteredAt,
      exitedAt: scope.exitedAt,
      deadlineAt: scope.deadlineAt,
      minTimeSeconds: scope.minTimeSeconds,
      maxTimeSeconds: scope.maxTimeSeconds,
      allowLateSubmission: scope.allowLateSubmission,
      unlimited: scope.unlimited,
    };
  });
}

function transitionItemScopes(input: {
  scopes: StoredTimingScope[];
  fromItemId: string;
  toItemId: string;
  at: string;
}): StoredTimingScope[] {
  const targetSection = findScopeByItem(input.scopes, "assessment-section", input.toItemId);
  const targetPart = findScopeByItem(input.scopes, "test-part", input.toItemId);

  return input.scopes.map((scope) => {
    if (
      (scope.scopeType === "assessment-item-ref" || scope.scopeType === "item-session") &&
      scope.itemId === input.fromItemId &&
      scope.status === "interacting"
    ) {
      return {
        ...scope,
        status: "suspended",
        activeSince: null,
        exitedAt: input.at,
      };
    }

    if (
      (scope.scopeType === "assessment-item-ref" || scope.scopeType === "item-session") &&
      scope.itemId === input.toItemId
    ) {
      const firstEntry = scope.enteredAt === null;
      return {
        ...scope,
        status: "interacting",
        enteredAt: scope.enteredAt ?? input.at,
        exitedAt: null,
        activeSince: input.at,
        deadlineAt:
          firstEntry && scope.maxTimeSeconds !== null
            ? new Date(Date.parse(input.at) + scope.maxTimeSeconds * 1000).toISOString()
            : scope.deadlineAt,
        numAttempts: firstEntry ? Math.max(1, scope.numAttempts ?? 0) : scope.numAttempts,
      };
    }

    if (scope.scopeType === "assessment-section") {
      const shouldBeActive = targetSection?.identifier === scope.identifier;
      return transitionContainerScope(scope, shouldBeActive, input.at);
    }

    if (scope.scopeType === "test-part") {
      const shouldBeActive = targetPart?.identifier === scope.identifier;
      return transitionContainerScope(scope, shouldBeActive, input.at);
    }

    return scope;
  });
}

function transitionContainerScope(
  scope: StoredTimingScope,
  shouldBeActive: boolean,
  at: string,
): StoredTimingScope {
  if (shouldBeActive && scope.status !== "interacting") {
    const firstEntry = scope.enteredAt === null;
    return {
      ...scope,
      status: "interacting",
      enteredAt: scope.enteredAt ?? at,
      exitedAt: null,
      activeSince: at,
      deadlineAt:
        firstEntry && scope.maxTimeSeconds !== null
          ? new Date(Date.parse(at) + scope.maxTimeSeconds * 1000).toISOString()
          : scope.deadlineAt,
    };
  }

  if (!shouldBeActive && scope.status === "interacting") {
    return {
      ...scope,
      status: "suspended",
      activeSince: null,
      exitedAt: at,
    };
  }

  return scope;
}

function setItemScopeStatus(
  scopes: StoredTimingScope[],
  itemId: string,
  status: StoredTimingScope["status"],
  at: string,
): StoredTimingScope[] {
  return scopes.map((scope) => {
    if (
      (scope.scopeType !== "assessment-item-ref" && scope.scopeType !== "item-session") ||
      scope.itemId !== itemId
    ) {
      return scope;
    }

    return {
      ...scope,
      status,
      activeSince: status === "interacting" ? at : null,
      exitedAt: status === "interacting" ? null : at,
    };
  });
}

function findScopeByItem(
  scopes: StoredTimingScope[],
  scopeType: StoredTimingScope["scopeType"],
  itemId: string,
): StoredTimingScope | null {
  const itemScope = scopes.find(
    (scope) => scope.scopeType === "assessment-item-ref" && scope.itemId === itemId,
  );
  if (!itemScope) {
    return null;
  }

  if (scopeType === "assessment-section") {
    return (
      scopes.find(
        (scope) =>
          scope.scopeType === "assessment-section" && scope.identifier === itemScope.sectionId,
      ) ?? null
    );
  }

  if (scopeType === "test-part") {
    return (
      scopes.find(
        (scope) => scope.scopeType === "test-part" && scope.identifier === itemScope.testPartId,
      ) ?? null
    );
  }

  return null;
}

function createDefaultQtiTiming(input: {
  assessmentVersionId: string;
  itemOrder: string[];
  allowedItemRefs: CurrentItemRef[];
}): QtiTimingMetadataSnapshot {
  const itemRefs = input.itemOrder.map<QtiAssessmentItemRefTimingSnapshot>((itemId) => ({
    identifier: itemId,
    href: input.allowedItemRefs.find((itemRef) => itemRef.itemId === itemId)?.itemHref ?? itemId,
    itemId,
    testPartId: "default-test-part",
    sectionId: "default-section",
    timeLimits: null,
    itemSessionControl: null,
  }));

  return {
    assessmentTest: {
      identifier: input.assessmentVersionId,
      title: null,
      timeLimits: null,
    },
    testParts: [
      {
        identifier: "default-test-part",
        navigationMode: "linear",
        submissionMode: "individual",
        timeLimits: null,
        sectionIds: ["default-section"],
      },
    ],
    sections: [
      {
        identifier: "default-section",
        title: null,
        visible: true,
        testPartId: "default-test-part",
        timeLimits: null,
        itemRefIds: itemRefs.map((itemRef) => itemRef.identifier),
      },
    ],
    itemRefs,
  };
}

function createStoredScope(input: {
  scopeType: StoredTimingScope["scopeType"];
  identifier: string;
  itemId: string | null;
  testPartId?: string | null;
  sectionId?: string | null;
  limits: QtiTimeLimitsSnapshot | null;
  startedAt: string;
  status: StoredTimingScope["status"];
  active: boolean;
  numAttempts?: number;
}): StoredTimingScope {
  const maxTimeSeconds = input.limits?.maxTimeSeconds ?? null;
  return {
    key: `${input.scopeType}:${input.identifier}`,
    scopeType: input.scopeType,
    identifier: input.identifier,
    itemId: input.itemId,
    testPartId: input.testPartId ?? null,
    sectionId: input.sectionId ?? null,
    status: input.status,
    enteredAt: input.active ? input.startedAt : null,
    exitedAt: null,
    activeSince: input.active ? input.startedAt : null,
    elapsedMilliseconds: 0,
    minTimeSeconds: input.limits?.minTimeSeconds ?? null,
    maxTimeSeconds,
    allowLateSubmission: input.limits?.allowLateSubmission ?? false,
    deadlineAt:
      maxTimeSeconds === null || !input.active
        ? null
        : new Date(Date.parse(input.startedAt) + maxTimeSeconds * 1000).toISOString(),
    unlimited: maxTimeSeconds === null,
    numAttempts: input.numAttempts ?? 0,
  };
}

function applyPolicyTimingToLimits(
  limits: QtiTimeLimitsSnapshot | null,
  policy: AttemptPolicyState,
): QtiTimeLimitsSnapshot | null {
  if (!limits) {
    return null;
  }

  if (isPolicyTimingUnlimited(policy)) {
    return {
      ...limits,
      maxTimeSeconds: null,
    };
  }

  if (limits.maxTimeSeconds === null) {
    return limits;
  }

  return {
    ...limits,
    maxTimeSeconds: limits.maxTimeSeconds + Math.max(0, policy.timing.additionalTimeSeconds),
  };
}

function resolveItemTimingLocation(
  qtiTiming: QtiTimingMetadataSnapshot,
  itemId: string,
): {
  testPartId: string;
  sectionId: string;
  itemRef: QtiAssessmentItemRefTimingSnapshot | null;
} {
  const itemRef =
    qtiTiming.itemRefs.find((entry) => (entry.itemId ?? entry.identifier) === itemId) ?? null;

  return {
    testPartId: itemRef?.testPartId ?? qtiTiming.testParts[0]?.identifier ?? "default-test-part",
    sectionId: itemRef?.sectionId ?? qtiTiming.sections[0]?.identifier ?? "default-section",
    itemRef,
  };
}
