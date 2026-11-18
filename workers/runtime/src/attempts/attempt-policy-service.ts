import { renderAttemptClientTiming } from "./attempt-client-timing";
import type {
  AttemptPolicyCommand,
  TransferWorkstationPolicyCommand,
  AttemptPolicyReadResponse,
  AttemptPolicyState,
  AttemptStatus,
  AttemptTimingState,
  DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import { createEmptyAttemptPolicyState } from "@harbor/attempt-protocol";
import {
  isPolicyTimingUnlimited,
  renderTimingState,
  readScopeElapsedMilliseconds,
  synchronizeScopedTimingPolicy,
  type StoredScopedTimingState,
} from "./attempt-timing";
import { resolveAttemptStatus } from "./attempt-status";

export { readAttemptPolicyCommand } from "./attempt-policy-command";

export interface PolicyAttemptState {
  attemptId: string;
  attemptStatus: AttemptStatus;
  timing: AttemptTimingState;
  scopedTiming: StoredScopedTimingState;
  policy: AttemptPolicyState;
  deliveryPolicy: DeliveryPolicySnapshot;
}

interface AttemptPolicyOverlayRow {
  overlay_revision: number;
  additional_time_seconds: number;
  reopen_status: string;
  reopened_at: string | null;
  reopen_until: string | null;
  operator_message_json: string | null;
  accommodations_json: string;
}

export async function loadAttemptPolicyState(
  db: D1Database,
  attemptId: string,
  startedAt: string,
  deliveryPolicy: DeliveryPolicySnapshot,
): Promise<AttemptPolicyState> {
  const row = await db
    .prepare(
      "SELECT overlay_revision, additional_time_seconds, reopen_status, reopened_at, reopen_until, operator_message_json, accommodations_json FROM attempt_policy_overlays WHERE attempt_id = ?",
    )
    .bind(attemptId)
    .first<AttemptPolicyOverlayRow>();

  const defaultPolicy = createEmptyAttemptPolicyState();
  if (!row) {
    return synchronizePolicyState(defaultPolicy, startedAt, deliveryPolicy);
  }

  const loadedPolicy = createEmptyAttemptPolicyState();
  loadedPolicy.overlayRevision = row.overlay_revision;
  loadedPolicy.timing.additionalTimeSeconds = Math.max(0, row.additional_time_seconds);
  loadedPolicy.reopen = {
    status: row.reopen_status === "reopened" ? "reopened" : "closed",
    reopenedAt: row.reopened_at,
    reopenUntil: row.reopen_until,
  };

  if (row.operator_message_json) {
    loadedPolicy.operatorMessage = parseStoredPolicyJson<
      AttemptPolicyState["operatorMessage"] | null
    >(row.operator_message_json, "operator_message_json");
  }

  loadedPolicy.accommodations = parseStoredPolicyJson<AttemptPolicyState["accommodations"]>(
    row.accommodations_json,
    "accommodations_json",
  );

  return synchronizePolicyState(loadedPolicy, startedAt, deliveryPolicy);
}

export function applyAttemptPolicyCommand<TState extends PolicyAttemptState>(
  storedState: TState,
  command: Exclude<AttemptPolicyCommand, TransferWorkstationPolicyCommand>,
): TState {
  const startedAt = storedState.timing.startedAt ?? new Date().toISOString();
  const nextPolicy = clonePolicyState(storedState.policy);
  nextPolicy.overlayRevision += 1;

  if (command.type === "extend-time") {
    nextPolicy.timing.additionalTimeSeconds += command.additionalTimeSeconds;
  }

  if (command.type === "reopen-attempt") {
    nextPolicy.reopen = {
      status: "reopened",
      reopenedAt: command.effectiveAt,
      reopenUntil: command.reopenUntil,
    };
  }

  if (command.type === "post-operator-message") {
    nextPolicy.operatorMessage = {
      messageId: command.commandId,
      level: command.message.level,
      title: command.message.title,
      body: command.message.body,
      postedAt: command.effectiveAt,
      effectiveUntil: command.message.effectiveUntil,
    };
  }

  if (command.type === "set-accommodations") {
    nextPolicy.accommodations = {
      rendererPnp: {
        ...command.accommodations.rendererPnp,
      },
      sessionControl: {
        ...command.accommodations.sessionControl,
      },
      shellTools: {
        ...command.accommodations.shellTools,
      },
      ...(command.accommodations.pnpEntitlement
        ? {
            pnpEntitlement: clonePnpEntitlement(command.accommodations.pnpEntitlement),
          }
        : {}),
      ...(command.accommodations.additionalTestingTime
        ? {
            additionalTestingTime: {
              ...command.accommodations.additionalTestingTime,
            },
          }
        : {}),
    };
  }

  const synchronizedPolicy = synchronizePolicyState(
    nextPolicy,
    startedAt,
    storedState.deliveryPolicy,
  );

  const scopedTiming = synchronizeScopedTimingPolicy(storedState.scopedTiming, synchronizedPolicy);
  return {
    ...storedState,
    attemptStatus: command.type === "reopen-attempt" ? "reopened" : storedState.attemptStatus,
    policy: synchronizedPolicy,
    scopedTiming: {
      ...scopedTiming,
      scopes: scopedTiming.scopes.map((scope) =>
        command.type === "reopen-attempt" && scope.scopeType === "assessment-test"
          ? {
              ...scope,
              status: "interacting",
              elapsedMilliseconds: readScopeElapsedMilliseconds(scope, command.effectiveAt),
              activeSince: command.effectiveAt,
              exitedAt: null,
            }
          : scope,
      ),
    },
    timing: buildTimingState(startedAt, storedState.deliveryPolicy, synchronizedPolicy),
  };
}

export function buildPolicyReadResponse(
  storedState: PolicyAttemptState,
  now = new Date().toISOString(),
): AttemptPolicyReadResponse {
  return {
    attemptId: storedState.attemptId,
    attemptStatus: resolveAttemptStatus(storedState, now),
    timing: renderAttemptClientTiming(storedState, now),
    policy: storedState.policy,
  };
}

export function buildTimingState(
  startedAt: string,
  deliveryPolicy: DeliveryPolicySnapshot,
  policy: AttemptPolicyState,
): AttemptTimingState {
  const effectivePolicy = synchronizePolicyState(policy, startedAt, deliveryPolicy);

  return renderTimingState(
    {
      startedAt,
      expiresAt: effectivePolicy.timing.effectiveSoftCloseAt,
      softCloseAt: effectivePolicy.timing.effectiveSoftCloseAt,
      acceptUntil: effectivePolicy.timing.effectiveAcceptUntil,
      remainingTimeSeconds: effectivePolicy.timing.effectiveTimeLimitSeconds,
    },
    startedAt,
  );
}

function parseStoredPolicyJson<T>(value: string, columnName: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Attempt policy overlay contains invalid ${columnName}`);
  }
}

function clonePnpEntitlement(
  entitlement: NonNullable<AttemptPolicyState["accommodations"]["pnpEntitlement"]>,
): NonNullable<AttemptPolicyState["accommodations"]["pnpEntitlement"]> {
  return {
    ...(entitlement.supports ? { supports: [...entitlement.supports] } : {}),
    ...(entitlement.activateAtInitializationSet
      ? {
          activateAtInitializationSet: [...entitlement.activateAtInitializationSet],
        }
      : {}),
    ...(entitlement.activateAsOptionSet
      ? { activateAsOptionSet: [...entitlement.activateAsOptionSet] }
      : {}),
    ...(entitlement.prohibitSet ? { prohibitSet: [...entitlement.prohibitSet] } : {}),
    ...(entitlement.languages ? { languages: [...entitlement.languages] } : {}),
  };
}

function clonePolicyState(policy: AttemptPolicyState): AttemptPolicyState {
  return {
    overlayRevision: policy.overlayRevision,
    timing: {
      additionalTimeSeconds: policy.timing.additionalTimeSeconds,
      effectiveTimeLimitSeconds: policy.timing.effectiveTimeLimitSeconds,
      effectiveSoftCloseAt: policy.timing.effectiveSoftCloseAt,
      effectiveAcceptUntil: policy.timing.effectiveAcceptUntil,
    },
    reopen: {
      status: policy.reopen.status,
      reopenedAt: policy.reopen.reopenedAt,
      reopenUntil: policy.reopen.reopenUntil,
    },
    operatorMessage: policy.operatorMessage
      ? {
          ...policy.operatorMessage,
        }
      : null,
    accommodations: {
      rendererPnp: {
        ...(policy.accommodations.rendererPnp.textAppearance
          ? {
              textAppearance: {
                ...policy.accommodations.rendererPnp.textAppearance,
              },
            }
          : {}),
        ...(policy.accommodations.rendererPnp.glossaryOnScreen !== undefined
          ? {
              glossaryOnScreen: policy.accommodations.rendererPnp.glossaryOnScreen,
            }
          : {}),
        ...(policy.accommodations.rendererPnp.keywordTranslationLanguage !== undefined
          ? {
              keywordTranslationLanguage:
                policy.accommodations.rendererPnp.keywordTranslationLanguage,
            }
          : {}),
        ...(policy.accommodations.rendererPnp.extSbacGlossaryIllustration !== undefined
          ? {
              extSbacGlossaryIllustration:
                policy.accommodations.rendererPnp.extSbacGlossaryIllustration,
            }
          : {}),
        ...(policy.accommodations.rendererPnp.layoutSingleColumn !== undefined
          ? {
              layoutSingleColumn: policy.accommodations.rendererPnp.layoutSingleColumn,
            }
          : {}),
      },
      sessionControl: {
        ...(policy.accommodations.sessionControl.allow_comment !== undefined
          ? {
              allow_comment: policy.accommodations.sessionControl.allow_comment,
            }
          : {}),
        ...(policy.accommodations.sessionControl.allow_review !== undefined
          ? {
              allow_review: policy.accommodations.sessionControl.allow_review,
            }
          : {}),
        ...(policy.accommodations.sessionControl.allow_skipping !== undefined
          ? {
              allow_skipping: policy.accommodations.sessionControl.allow_skipping,
            }
          : {}),
        ...(policy.accommodations.sessionControl.max_attempts !== undefined
          ? {
              max_attempts: policy.accommodations.sessionControl.max_attempts,
            }
          : {}),
        ...(policy.accommodations.sessionControl.show_feedback !== undefined
          ? {
              show_feedback: policy.accommodations.sessionControl.show_feedback,
            }
          : {}),
        ...(policy.accommodations.sessionControl.show_solution !== undefined
          ? {
              show_solution: policy.accommodations.sessionControl.show_solution,
            }
          : {}),
        ...(policy.accommodations.sessionControl.validate_responses !== undefined
          ? {
              validate_responses: policy.accommodations.sessionControl.validate_responses,
            }
          : {}),
        ...(policy.accommodations.sessionControl.time_limits
          ? {
              time_limits: {
                ...policy.accommodations.sessionControl.time_limits,
              },
            }
          : {}),
      },
      shellTools: {
        ...policy.accommodations.shellTools,
      },
      ...(policy.accommodations.pnpEntitlement
        ? {
            pnpEntitlement: clonePnpEntitlement(policy.accommodations.pnpEntitlement),
          }
        : {}),
      ...(policy.accommodations.additionalTestingTime
        ? {
            additionalTestingTime: {
              ...policy.accommodations.additionalTestingTime,
            },
          }
        : {}),
    },
  };
}

function computeEffectiveTimingWindow(
  startedAt: string,
  deliveryPolicy: DeliveryPolicySnapshot,
  policy: AttemptPolicyState,
): {
  effectiveTimeLimitSeconds: number | null;
  softCloseAt: string | null;
  acceptUntil: string | null;
} {
  const additionalTimeSeconds = Math.max(0, policy.timing.additionalTimeSeconds);
  const effectiveTimeLimitSeconds =
    deliveryPolicy.timeLimitSeconds === null || isPolicyTimingUnlimited(policy)
      ? null
      : deliveryPolicy.timeLimitSeconds + additionalTimeSeconds;
  let softCloseAt =
    effectiveTimeLimitSeconds === null
      ? null
      : new Date(Date.parse(startedAt) + effectiveTimeLimitSeconds * 1000).toISOString();
  let acceptUntil =
    softCloseAt === null
      ? null
      : new Date(
          Date.parse(softCloseAt) + Math.max(0, deliveryPolicy.gracePeriodSeconds ?? 0) * 1000,
        ).toISOString();

  if (policy.reopen.status === "reopened" && policy.reopen.reopenUntil) {
    const reopenUntilMs = Date.parse(policy.reopen.reopenUntil);
    if (
      !Number.isNaN(reopenUntilMs) &&
      (softCloseAt === null || reopenUntilMs > Date.parse(softCloseAt))
    ) {
      softCloseAt = policy.reopen.reopenUntil;
    }

    if (
      !Number.isNaN(reopenUntilMs) &&
      (acceptUntil === null || reopenUntilMs > Date.parse(acceptUntil))
    ) {
      acceptUntil = policy.reopen.reopenUntil;
    }
  }

  return {
    effectiveTimeLimitSeconds,
    softCloseAt,
    acceptUntil,
  };
}

function synchronizePolicyState(
  policy: AttemptPolicyState,
  startedAt: string,
  deliveryPolicy: DeliveryPolicySnapshot,
): AttemptPolicyState {
  const timingWindow = computeEffectiveTimingWindow(startedAt, deliveryPolicy, policy);

  return {
    ...clonePolicyState(policy),
    timing: {
      additionalTimeSeconds: Math.max(0, policy.timing.additionalTimeSeconds),
      effectiveTimeLimitSeconds: timingWindow.effectiveTimeLimitSeconds,
      effectiveSoftCloseAt: timingWindow.softCloseAt,
      effectiveAcceptUntil: timingWindow.acceptUntil,
    },
  };
}
