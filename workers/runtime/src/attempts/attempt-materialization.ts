import {
  readQtiResponseSnapshots,
  readQtiValidationSnapshots,
  type AttemptEventEnvelope,
  type AttemptItemQtiSnapshot,
  type AttemptSubmissionMaterializationInput,
  type AttemptSubmissionSummary,
} from "@harbor/attempt-protocol";
import {
  readItemTimingScope,
  readScopeElapsedMilliseconds,
  truncateSeconds,
  type StoredScopedTimingState,
  type StoredTimingScope,
} from "./attempt-timing";

export interface AttemptMaterializationContext {
  scopedTiming: StoredScopedTimingState;
  manifestItems: Record<
    string,
    {
      itemIdentifier: string | null;
      itemTitle: string | null;
      timeDependent: boolean;
    }
  >;
  submissionMaterialization: AttemptSubmissionMaterializationInput;
}

/** Merge candidate answers without replacing the attempt authority's delivered item order. */
export function mergeSubmissionMaterialization(
  existing: AttemptSubmissionMaterializationInput,
  incoming: AttemptSubmissionMaterializationInput | null,
): AttemptSubmissionMaterializationInput {
  if (!incoming) {
    return existing;
  }
  const safeIncoming = stripClientOutcomeVariables(incoming);

  return {
    itemOrder: existing.itemOrder,
    testState: safeIncoming.testState ?? existing.testState,
    partStates: {
      ...existing.partStates,
      ...safeIncoming.partStates,
    },
    sectionStates: {
      ...existing.sectionStates,
      ...safeIncoming.sectionStates,
    },
    items: mergeItemSnapshotsPreservingServerState(existing.items, safeIncoming.items),
  };
}

export function enrichSubmissionMaterializationWithBuiltins(
  context: AttemptMaterializationContext,
  materialization: AttemptSubmissionMaterializationInput,
  now = new Date().toISOString(),
): AttemptSubmissionMaterializationInput {
  const testState = withContainerTimingState(
    materialization.testState,
    readContainerTimingScope(context.scopedTiming, "assessment-test"),
    now,
    "duration",
  );
  const partStates = { ...materialization.partStates };
  const sectionStates = { ...materialization.sectionStates };
  for (const scope of context.scopedTiming.scopes) {
    if (scope.scopeType === "test-part") {
      const partState = withContainerTimingState(
        partStates[scope.identifier] ?? {
          identifier: scope.identifier,
          responseVariables: [],
          outcomeVariables: [],
        },
        scope,
        now,
        `duration.test-part.${scope.identifier}`,
      );
      if (partState) {
        partStates[scope.identifier] = partState;
      }
    }
    if (scope.scopeType === "assessment-section") {
      const sectionState = withContainerTimingState(
        sectionStates[scope.identifier] ?? {
          identifier: scope.identifier,
          responseVariables: [],
          outcomeVariables: [],
        },
        scope,
        now,
        `duration.assessment-section.${scope.identifier}`,
      );
      if (sectionState) {
        sectionStates[scope.identifier] = sectionState;
      }
    }
  }

  const items = { ...materialization.items };
  for (const itemId of materialization.itemOrder) {
    const manifestItem = context.manifestItems[itemId];
    const existing = items[itemId];
    const responseVariables = withBuiltinResponseVariables(
      existing?.responseVariables ?? [],
      context,
      itemId,
      now,
    );
    const outcomeVariables = withBuiltinOutcomeVariables(
      existing?.outcomeVariables ?? [],
      context,
      itemId,
    );

    items[itemId] = {
      itemId,
      itemIdentifier: existing?.itemIdentifier ?? manifestItem?.itemIdentifier ?? itemId,
      itemTitle: existing?.itemTitle ?? manifestItem?.itemTitle ?? itemId,
      capturedAt: existing?.capturedAt ?? now,
      responseVariables,
      outcomeVariables,
      validationMessages: existing?.validationMessages ?? [],
      ...(existing?.stateJson !== undefined ? { stateJson: existing.stateJson } : {}),
      ...(existing?.serverState !== undefined ? { serverState: existing.serverState } : {}),
    };
  }

  return {
    ...materialization,
    testState,
    partStates,
    sectionStates,
    items,
  };
}

export function materializeSubmitState(
  context: AttemptMaterializationContext,
  incoming: AttemptSubmissionMaterializationInput | null,
  now = new Date().toISOString(),
): AttemptSubmissionMaterializationInput {
  const merged = mergeSubmissionMaterialization(context.submissionMaterialization, incoming);
  return enrichSubmissionMaterializationWithBuiltins(
    {
      ...context,
      submissionMaterialization: merged,
    },
    merged,
    now,
  );
}

export function readSubmissionMaterializationFromResponseChange(
  context: AttemptMaterializationContext,
  event: AttemptEventEnvelope<"response.changed" | "item.submit-requested">,
  now = new Date().toISOString(),
): AttemptSubmissionMaterializationInput | null {
  const responseState = event.payload.responseState;

  if (!responseState || typeof responseState !== "object") {
    return null;
  }

  const responseRecord = responseState as Record<string, unknown>;
  const itemState =
    responseRecord.itemState &&
    typeof responseRecord.itemState === "object" &&
    !Array.isArray(responseRecord.itemState)
      ? (responseRecord.itemState as Record<string, unknown>)
      : null;

  if (!itemState) {
    return null;
  }

  const manifestItem = context.manifestItems[event.itemRef.itemId];
  const itemSnapshot: AttemptItemQtiSnapshot = {
    itemId: event.itemRef.itemId,
    itemIdentifier: manifestItem?.itemIdentifier ?? event.itemRef.itemId,
    itemTitle: manifestItem?.itemTitle ?? event.itemRef.itemId,
    capturedAt:
      typeof responseRecord.capturedAt === "string" && responseRecord.capturedAt
        ? responseRecord.capturedAt
        : null,
    responseVariables: withBuiltinResponseVariables(
      readQtiResponseSnapshots(itemState),
      context,
      event.itemRef.itemId,
      now,
    ),
    outcomeVariables: withBuiltinOutcomeVariables([], context, event.itemRef.itemId),
    validationMessages: readQtiValidationSnapshots(itemState),
  };

  return {
    itemOrder: context.submissionMaterialization.itemOrder,
    testState: null,
    partStates: {},
    sectionStates: {},
    items: {
      [itemSnapshot.itemId]: itemSnapshot,
    },
  };
}

function mergeItemSnapshotsPreservingServerState(
  existing: AttemptSubmissionMaterializationInput["items"],
  incoming: AttemptSubmissionMaterializationInput["items"],
): AttemptSubmissionMaterializationInput["items"] {
  return Object.fromEntries(
    [...new Set([...Object.keys(existing), ...Object.keys(incoming)])].map((itemId) => {
      const existingItem = existing[itemId];
      const incomingItem = incoming[itemId];
      if (!incomingItem) return [itemId, existingItem] as const;
      if (existingItem?.stateJson === undefined || incomingItem.stateJson !== undefined) {
        return [itemId, incomingItem] as const;
      }

      return [
        itemId,
        {
          ...incomingItem,
          stateJson: existingItem.stateJson,
          ...(existingItem.serverState ? { serverState: existingItem.serverState } : {}),
        },
      ] as const;
    }),
  );
}

export function readSubmitLikePayload(event: AttemptEventEnvelope): {
  submissionSummary?: AttemptSubmissionSummary | null;
  submissionMaterialization?: AttemptSubmissionMaterializationInput | null;
} | null {
  if (event.type === "submit.requested") {
    return (event as AttemptEventEnvelope<"submit.requested">).payload;
  }

  if (event.type === "timing.auto-submit.requested") {
    return (event as AttemptEventEnvelope<"timing.auto-submit.requested">).payload;
  }

  return null;
}

function stripClientOutcomeVariables(
  materialization: AttemptSubmissionMaterializationInput,
): AttemptSubmissionMaterializationInput {
  return {
    itemOrder: materialization.itemOrder,
    testState: stripContainerOutcomeVariables(materialization.testState),
    partStates: Object.fromEntries(
      Object.entries(materialization.partStates).map(([identifier, state]) => [
        identifier,
        stripContainerOutcomeVariables(state),
      ]),
    ),
    sectionStates: Object.fromEntries(
      Object.entries(materialization.sectionStates).map(([identifier, state]) => [
        identifier,
        stripContainerOutcomeVariables(state),
      ]),
    ),
    items: Object.fromEntries(
      Object.entries(materialization.items).map(([itemId, item]) => {
        const { stateJson: _clientStateJson, serverState: _clientServerState, ...safeItem } = item;
        return [
          itemId,
          {
            ...safeItem,
            outcomeVariables: [],
          },
        ];
      }),
    ),
  };
}

function stripContainerOutcomeVariables<
  TState extends AttemptSubmissionMaterializationInput["testState"],
>(state: TState): TState {
  return state
    ? ({
        ...state,
        outcomeVariables: [],
      } as TState)
    : state;
}

function withContainerTimingState(
  state: AttemptSubmissionMaterializationInput["testState"],
  scope: StoredTimingScope | null,
  now: string,
  identifier: string,
): NonNullable<AttemptSubmissionMaterializationInput["testState"]> | null {
  if (!scope && !state) {
    return null;
  }

  const nextState =
    state ??
    (scope
      ? {
          identifier: scope.identifier,
          responseVariables: [],
          outcomeVariables: [],
        }
      : null);
  if (!nextState || !scope || !shouldExportContainerDuration(scope, now)) {
    return nextState;
  }

  return {
    ...nextState,
    responseVariables: upsertVariables(nextState.responseVariables ?? [], [
      {
        identifier,
        value: truncateSeconds(readScopeElapsedMilliseconds(scope, now)),
      },
    ]),
  };
}

function shouldExportContainerDuration(scope: StoredTimingScope, now: string): boolean {
  return (
    scope.minTimeSeconds !== null ||
    scope.maxTimeSeconds !== null ||
    readScopeElapsedMilliseconds(scope, now) > 0
  );
}

function readContainerTimingScope(
  scopedTiming: StoredScopedTimingState,
  scopeType: "assessment-test",
): StoredTimingScope | null {
  return scopedTiming.scopes.find((scope) => scope.scopeType === scopeType) ?? null;
}

function withBuiltinResponseVariables(
  variables: AttemptItemQtiSnapshot["responseVariables"],
  context: AttemptMaterializationContext,
  itemId: string,
  now: string,
): AttemptItemQtiSnapshot["responseVariables"] {
  const itemScope = readItemTimingScope(context.scopedTiming, itemId);
  const manifestItem = context.manifestItems[itemId];
  const durationSeconds = itemScope
    ? truncateSeconds(readScopeElapsedMilliseconds(itemScope, now))
    : 0;
  return upsertVariables(variables, [
    {
      identifier: "numAttempts",
      value: itemScope?.numAttempts ?? 0,
    },
    ...(manifestItem?.timeDependent || itemScope
      ? [
          {
            identifier: "duration",
            value: durationSeconds,
          },
        ]
      : []),
  ]);
}

function withBuiltinOutcomeVariables(
  variables: AttemptItemQtiSnapshot["outcomeVariables"],
  context: AttemptMaterializationContext,
  itemId: string,
): AttemptItemQtiSnapshot["outcomeVariables"] {
  const itemScope = readItemTimingScope(context.scopedTiming, itemId);
  const existingCompletion = variables.find(
    (variable) => variable.identifier === "completionStatus",
  );

  if (existingCompletion) {
    return variables;
  }

  return [
    ...variables,
    {
      identifier: "completionStatus",
      value: itemScope && (itemScope.numAttempts ?? 0) > 0 ? "unknown" : "not_attempted",
    },
  ];
}

function upsertVariables(
  variables: AttemptItemQtiSnapshot["responseVariables"],
  builtins: AttemptItemQtiSnapshot["responseVariables"],
): AttemptItemQtiSnapshot["responseVariables"] {
  const next = variables.filter(
    (variable) => !builtins.some((builtin) => builtin.identifier === variable.identifier),
  );
  next.push(...builtins);
  return next;
}
