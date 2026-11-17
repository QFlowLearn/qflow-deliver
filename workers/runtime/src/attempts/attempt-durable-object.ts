import {
  OUTBOX_RECOVERY_DELAY_MS,
  getOutboxWakeup,
  setOutboxWakeup,
  findAttemptDeadlineAlarm,
  reconcileAttemptAlarm,
} from "./attempt-alarm-schedule";
import { transferWorkstation } from "./workstation-transfer";
import { withAcceptedResponseCheckpoint } from "./attempt-response-checkpoint";
import {
  prepareGeneratedSafeExamBrowserRebind,
  projectGeneratedSafeExamBrowserRebind,
} from "./generated-safe-exam-browser-rebind";
import { recordSecureBrowserEvidence } from "../security/secure-browser-evidence";
import { FixedTestOrderRuntime } from "./fixed-test-order-runtime";
import { TestSessionRuntime } from "./test-session-runtime";
import { renderAttemptClientTiming } from "./attempt-client-timing";
import type {
  AttemptEventCommitResponse,
  AttemptEventEnvelope,
  AttemptPolicyCommand,
  AttemptPolicyReadResponse,
  AttemptSubmissionMaterializationInput,
  AttemptSubmissionSummary,
  AuthoritativeAttemptSessionState,
  CommitAttemptEventReceipt,
  CurrentItemRef,
} from "@harbor/attempt-protocol";
import {
  buildAttemptStateErrorPayload,
  currentItemRefsMatch,
  requiresCurrentItemEvidenceGuard,
  resolveAttemptDeliveryPreferences,
  resolveEntitledKeywordTranslationLanguage,
  validateKeywordTranslationLanguageSelection,
} from "./attempt-delivery-preferences";
import {
  applyScopedTimingEvent,
  buildTimingDecision,
  findExceededAutoSubmitDeadlineScope,
  findMinimumTimeBlockingScope,
  findMinimumSubmissionBlockingScope,
  readScopeElapsedMilliseconds,
  truncateSeconds,
} from "./attempt-timing";
import {
  enrichSubmissionMaterializationWithBuiltins,
  materializeSubmitState,
  mergeSubmissionMaterialization,
  readSubmissionMaterializationFromResponseChange,
  readSubmitLikePayload,
} from "./attempt-materialization";
import { preserveLateAttemptEvent } from "./attempt-late-evidence";
import { insertTimingEvidenceEvent } from "./attempt-accepted-projections";
import {
  applyAttemptPolicyCommand,
  buildPolicyReadResponse,
  readAttemptPolicyCommand,
} from "./attempt-policy-service";
import { AttemptCommitOutbox } from "./attempt-commit-outbox";
import {
  ensureAttemptState as ensureStoredAttemptState,
  STATE_KEY,
  type StoredAttemptState,
} from "./attempt-state-bootstrap";
import { AttemptDurableObjectRequestError, isStatusError } from "./attempt-request-error";
import {
  nullableHeaderValue,
  readAttemptEvent,
  readJsonObject,
  readOptionalStringValue,
  readRequiredString,
} from "./attempt-request-parsing";
import { resolveAttemptStatus } from "./attempt-status";
import { isUnsafeSafeExamBrowserUserAgentFallbackEnabled } from "../security/safe-exam-browser";
import {
  createDeliveryContextErrorResponse,
  isDeliveryContextError,
  requireAllowedDeliveryContext,
} from "../routes/delivery-context";
import {
  advanceAcceptedAdaptiveResponseTurn,
  renderCurrentAdaptiveItemView,
  type AdaptiveItemViewResponse,
} from "./adaptive-item-delivery";

export const ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER = "x-harbor-attempt-id";
export const ATTEMPT_COORDINATOR_CLIENT_SESSION_ID_HEADER = "x-harbor-client-session-id";
export const ATTEMPT_COORDINATOR_DELIVERY_CONTEXT_URL_HEADER = "x-harbor-delivery-context-url";

const RECEIPT_KEY_PREFIX = "receipt:";
const SERVER_DEADLINE_AUTO_SUBMIT_CLIENT_SESSION_ID = "server_deadline_auto_submit";

interface AttemptDurableObjectEnv {
  BOOTSTRAP_SIGNING_SECRET: string;
  HARBOR_DB: D1Database;
  CONTENT_BUCKET: R2Bucket;
  ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK?: string;
}

interface AttemptMaterializationResponse {
  attemptId: string;
  assessmentVersionId: string;
  assignmentId: string | null;
  submissionMaterialization: AttemptSubmissionMaterializationInput;
  submissionSummary: AttemptSubmissionSummary | null;
}

export class AttemptDurableObject {
  private readonly commitOutbox: AttemptCommitOutbox;
  private readonly testSessionRuntime: TestSessionRuntime;
  private readonly fixedOrderRuntime: FixedTestOrderRuntime;
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: AttemptDurableObjectEnv,
    private readonly alarmClock: () => number = Date.now,
  ) {
    this.commitOutbox = new AttemptCommitOutbox(
      state.storage,
      env,
      (operation) => state.blockConcurrencyWhile(operation),
      alarmClock,
    );
    this.testSessionRuntime = new TestSessionRuntime(env.CONTENT_BUCKET);
    this.fixedOrderRuntime = new FixedTestOrderRuntime(env.CONTENT_BUCKET);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/deliver-outbox") {
      readRequiredString(
        request.headers.get(ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER),
        "attempt id header is required",
      );
      return Response.json({ outcome: await this.commitOutbox.deliver() });
    }
    // State transitions still serialize content reads, policy changes and submission.
    const response = await this.state.blockConcurrencyWhile(() => this.handleRequest(request));
    if (request.method === "POST" && url.pathname === "/policy") {
      this.state.waitUntil(this.commitOutbox.deliver());
    }
    return response;
  }

  async alarm(): Promise<void> {
    // Deadline authority runs first and never waits for D1 delivery or its retry delay.
    await this.state.blockConcurrencyWhile(async () => {
      const current = await this.state.storage.get<StoredAttemptState>(STATE_KEY);
      const due = current ? findAttemptDeadlineAlarm(current) : null;
      if (current && due !== null && this.alarmClock() >= due.at) {
        await this.autoSubmitExceededDeadline(
          current.attemptId,
          new Date(this.alarmClock()).toISOString(),
        );
      }
      await this.state.storage.transaction(async (txn) => {
        const delivery = await getOutboxWakeup(txn);
        // Persist recovery before returning from this native alarm, even if delivery never starts.
        if (delivery !== null && delivery <= this.alarmClock()) {
          await setOutboxWakeup(txn, this.alarmClock() + OUTBOX_RECOVERY_DELAY_MS);
        } else await reconcileAttemptAlarm(txn);
      });
    });
    // Native alarm invocations serialize: external delivery must not keep this handler open.
    this.state.waitUntil(this.commitOutbox.deliver());
  }

  private async handleRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const attemptId = readRequiredString(
        request.headers.get(ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER),
        "attempt id header is required",
      );

      if (request.method === "POST" && url.pathname === "/commit") {
        const event = await readAttemptEvent(request);
        if (event.attemptId !== attemptId) {
          throw new AttemptDurableObjectRequestError(
            409,
            "Attempt event attemptId does not match the scoped attempt route",
          );
        }

        const storedState = await this.ensureAttemptState(attemptId);
        try {
          await requireAllowedDeliveryContext({
            request: createDeliveryContextRequest(request),
            deliveryPolicy: storedState.deliveryPolicy,
            allowUnsafeSafeExamBrowserUserAgentFallback:
              isUnsafeSafeExamBrowserUserAgentFallbackEnabled(
                this.env.ALLOW_UNSAFE_SEB_USER_AGENT_FALLBACK,
              ),
          });
        } catch (error: unknown) {
          if (isDeliveryContextError(error))
            await recordSecureBrowserEvidence({
              db: this.env.HARBOR_DB,
              attemptId,
              phase: "commit",
              policy: storedState.deliveryPolicy,
              context: error.deliveryContext,
            });
          throw error;
        }

        return Response.json(await this.commitEvent(attemptId, event, storedState), {
          status: 200,
        });
      }

      if (request.method === "POST" && url.pathname === "/generated-seb-rebind") {
        const current = await this.ensureAttemptState(attemptId);
        try {
          const rebound = await prepareGeneratedSafeExamBrowserRebind({
            db: this.env.HARBOR_DB,
            secret: this.env.BOOTSTRAP_SIGNING_SECRET,
            request,
            deliveryRequest: createDeliveryContextRequest(request),
            storedState: current,
          });
          await this.state.storage.put(STATE_KEY, rebound.state);
          await projectGeneratedSafeExamBrowserRebind(
            this.env.HARBOR_DB,
            rebound.state,
            rebound.assignmentPolicy,
          );
          await recordSecureBrowserEvidence({
            db: this.env.HARBOR_DB,
            attemptId,
            phase: "relaunch",
            policy: rebound.state.deliveryPolicy,
            context: rebound.context,
          });
          return Response.json({ deliveryPolicy: rebound.state.deliveryPolicy }, { status: 200 });
        } catch (error: unknown) {
          if (isDeliveryContextError(error))
            await recordSecureBrowserEvidence({
              db: this.env.HARBOR_DB,
              attemptId,
              phase: "relaunch",
              policy: current.deliveryPolicy,
              context: error.deliveryContext,
            });
          else if (isStatusError(error))
            await recordSecureBrowserEvidence({
              db: this.env.HARBOR_DB,
              attemptId,
              phase: "relaunch",
              policy: current.deliveryPolicy,
              blockedReason: "invalid-launch",
            });
          throw error;
        }
      }

      if (request.method === "GET" && url.pathname === "/session") {
        return Response.json(
          await this.getAuthoritativeSession(
            attemptId,
            nullableHeaderValue(request.headers.get(ATTEMPT_COORDINATOR_CLIENT_SESSION_ID_HEADER)),
          ),
          {
            status: 200,
          },
        );
      }

      if (request.method === "GET" && url.pathname === "/fixed-test-order") {
        const state = await this.ensureAttemptState(attemptId);
        return Response.json(
          state.fixedTestOrder
            ? {
                currentItemRef: state.currentItemRef,
                itemOrder: state.submissionMaterialization.itemOrder,
              }
            : null,
        );
      }
      if (request.method === "GET" && url.pathname === "/test-sequence") {
        const state = await this.ensureAttemptState(attemptId);
        return Response.json(
          state.testSequence
            ? {
                currentItemRef: state.currentItemRef,
                answered: state.testSequence.snapshot.submissions.length,
                target: state.testSequence.descriptor.answerCount,
                status: state.attemptStatus,
              }
            : null,
        );
      }

      if (request.method === "GET" && url.pathname === "/policy") {
        return Response.json(await this.getAuthoritativePolicy(attemptId), {
          status: 200,
        });
      }

      if (request.method === "GET" && url.pathname === "/submission-summary") {
        return Response.json(await this.getSubmissionSummary(attemptId), {
          status: 200,
        });
      }

      if (request.method === "GET" && url.pathname === "/result-materialization") {
        return Response.json(await this.getResultMaterialization(attemptId), {
          status: 200,
        });
      }

      if (request.method === "GET" && url.pathname === "/adaptive-item-view") {
        const itemId = readRequiredString(url.searchParams.get("itemId"), "itemId is required");
        return Response.json(await this.getAdaptiveItemView(attemptId, itemId), {
          status: 200,
        });
      }

      if (request.method === "POST" && url.pathname === "/policy") {
        const command = await readAttemptPolicyCommand(request);
        return Response.json(await this.applyPolicyCommand(attemptId, command), {
          status: 200,
        });
      }

      return Response.json({ error: "Route not found" }, { status: 404 });
    } catch (error) {
      if (isDeliveryContextError(error)) {
        return createDeliveryContextErrorResponse(error);
      }

      if (isStatusError(error)) {
        return Response.json(error.payload ?? { error: error.message }, { status: error.status });
      }

      throw error;
    }
  }

  private async commitEvent(
    attemptId: string,
    event: AttemptEventEnvelope,
    seedState?: StoredAttemptState,
    acceptedAt?: string,
  ): Promise<AttemptEventCommitResponse> {
    const storedState = seedState ?? (await this.ensureAttemptState(attemptId));
    const timing = renderAttemptClientTiming(storedState, undefined);
    const attemptStatus = resolveAttemptStatus(storedState);
    const serverTimestamp = acceptedAt ?? new Date().toISOString();

    if (attemptStatus === "submitted") {
      const storedReceiptForSubmittedAttempt =
        await this.state.storage.get<CommitAttemptEventReceipt>(receiptKey(event.idempotencyKey));
      if (storedReceiptForSubmittedAttempt) {
        return {
          outcome: "duplicate",
          attemptId,
          highestCommittedSequence: storedState.highestCommittedSequence,
          expectedNextSequence: storedState.highestCommittedSequence + 1,
          attemptStatus,
          currentItemRef: storedState.currentItemRef,
          timing,
          policy: storedState.policy,
          deliveryPreferences: resolveAttemptDeliveryPreferences(storedState),
          requestedSequenceNumber: event.sequenceNumber,
          storedReceipt: storedReceiptForSubmittedAttempt,
        };
      }

      if (event.type === "timing.auto-submit.requested" && storedState.submissionReceipt) {
        return {
          outcome: "duplicate",
          attemptId,
          highestCommittedSequence: storedState.highestCommittedSequence,
          expectedNextSequence: storedState.highestCommittedSequence + 1,
          attemptStatus,
          currentItemRef: storedState.currentItemRef,
          timing,
          policy: storedState.policy,
          deliveryPreferences: resolveAttemptDeliveryPreferences(storedState),
          requestedSequenceNumber: event.sequenceNumber,
          storedReceipt: storedState.submissionReceipt,
        };
      }

      return preserveLateAttemptEvent({
        db: this.env.HARBOR_DB,
        state: storedState,
        event,
        attemptStatus,
        serverTimestamp,
      });
    }

    if (
      attemptStatus === "expired_pending_recovery" &&
      event.type !== "submit.requested" &&
      event.type !== "timing.auto-submit.requested"
    ) {
      return preserveLateAttemptEvent({
        db: this.env.HARBOR_DB,
        state: storedState,
        event,
        attemptStatus,
        serverTimestamp,
      });
    }

    if (
      storedState.currentClientSessionId &&
      storedState.currentClientSessionId !== event.clientSessionId &&
      event.clientSessionId !== SERVER_DEADLINE_AUTO_SUBMIT_CLIENT_SESSION_ID
    ) {
      return {
        outcome: "stale_session",
        attemptId,
        highestCommittedSequence: storedState.highestCommittedSequence,
        expectedNextSequence: storedState.highestCommittedSequence + 1,
        attemptStatus,
        currentItemRef: storedState.currentItemRef,
        timing,
        policy: storedState.policy,
        deliveryPreferences: resolveAttemptDeliveryPreferences(storedState),
        requestedSequenceNumber: event.sequenceNumber,
        currentClientSessionId: null,
        requestedClientSessionId: event.clientSessionId,
      };
    }

    const storedReceipt = await this.state.storage.get<CommitAttemptEventReceipt>(
      receiptKey(event.idempotencyKey),
    );

    if (storedReceipt) {
      return {
        outcome: "duplicate",
        attemptId,
        highestCommittedSequence: storedState.highestCommittedSequence,
        expectedNextSequence: storedState.highestCommittedSequence + 1,
        attemptStatus,
        currentItemRef: storedState.currentItemRef,
        timing,
        policy: storedState.policy,
        deliveryPreferences: resolveAttemptDeliveryPreferences(storedState),
        requestedSequenceNumber: event.sequenceNumber,
        storedReceipt,
      };
    }

    const expectedNextSequence = storedState.highestCommittedSequence + 1;
    if (event.sequenceNumber < expectedNextSequence) {
      return {
        outcome: "stale_sequence",
        attemptId,
        highestCommittedSequence: storedState.highestCommittedSequence,
        expectedNextSequence,
        attemptStatus,
        currentItemRef: storedState.currentItemRef,
        timing,
        policy: storedState.policy,
        deliveryPreferences: resolveAttemptDeliveryPreferences(storedState),
        requestedSequenceNumber: event.sequenceNumber,
      };
    }

    if (event.sequenceNumber > expectedNextSequence) {
      return {
        outcome: "gap",
        attemptId,
        highestCommittedSequence: storedState.highestCommittedSequence,
        expectedNextSequence,
        attemptStatus,
        currentItemRef: storedState.currentItemRef,
        timing,
        policy: storedState.policy,
        deliveryPreferences: resolveAttemptDeliveryPreferences(storedState),
        requestedSequenceNumber: event.sequenceNumber,
        replayFromSequenceNumber: expectedNextSequence,
      };
    }

    validateHardDeadlineWrite(storedState, event, serverTimestamp);
    if (event.type === "submit.requested" || event.type === "timing.auto-submit.requested") {
      const blockingScope = findMinimumSubmissionBlockingScope(
        storedState.scopedTiming,
        serverTimestamp,
      );
      if (blockingScope)
        throw new AttemptDurableObjectRequestError(
          409,
          "Minimum assessment or part time has not elapsed",
          {
            ...buildAttemptStateErrorPayload(
              "Minimum assessment or part time has not elapsed",
              storedState,
              resolveAttemptStatus(storedState, serverTimestamp),
              timing,
            ),
            timingBlock: {
              scopeKey: blockingScope.key,
              scopeType: blockingScope.scopeType,
              identifier: blockingScope.identifier,
              minTimeSeconds: blockingScope.minTimeSeconds,
              elapsedTimeSeconds: truncateSeconds(
                readScopeElapsedMilliseconds(blockingScope, serverTimestamp),
              ),
            },
          },
        );
    }
    guardTestSequenceEvent(storedState, event);

    if (event.type === "navigation.requested") {
      validateNavigationRequest(
        storedState,
        event as AttemptEventEnvelope<"navigation.requested">,
        serverTimestamp,
      );
    }

    if (event.type === "keyword-translation.language.selected") {
      validateKeywordTranslationLanguageSelection(
        storedState,
        event as AttemptEventEnvelope<"keyword-translation.language.selected">,
      );
    }

    if (
      requiresCurrentItemEvidenceGuard(event) &&
      !currentItemRefsMatch(event.itemRef, storedState.currentItemRef)
    ) {
      throw new AttemptDurableObjectRequestError(
        409,
        "Observed evidence does not match the authoritative current item",
        buildAttemptStateErrorPayload(
          "Observed evidence does not match the authoritative current item",
          storedState,
        ),
      );
    }

    const appliedState = isTestAnswerEvent(event)
      ? await advanceTestSequenceAnswer({
          runtime: this.testSessionRuntime,
          bucket: this.env.CONTENT_BUCKET,
          state: storedState,
          event,
          at: serverTimestamp,
        })
      : applyCommittedEvent(storedState, event, serverTimestamp);
    const checkpoint = withAcceptedResponseCheckpoint(appliedState, event, serverTimestamp);
    if (!checkpoint.ok)
      throw new AttemptDurableObjectRequestError(checkpoint.status, checkpoint.message);
    const eventAppliedState = checkpoint.state;
    let nextState = await advanceAcceptedAdaptiveResponseTurn({
      bucket: this.env.CONTENT_BUCKET,
      storedState,
      nextState: eventAppliedState,
      event,
      serverTimestamp,
    });
    if (nextState.attemptStatus === "submitted" && nextState.testSequence) {
      nextState = {
        ...nextState,
        submissionSummary: summarizeTestSubmission(nextState, serverTimestamp),
      };
    }
    const timingDecision = buildTimingDecision(storedState, event, serverTimestamp);
    const receipt: CommitAttemptEventReceipt = {
      outcome: "accepted",
      receiptId: createId("rcpt"),
      attemptId,
      acceptedEventId: event.eventId,
      acceptedSequenceNumber: event.sequenceNumber,
      highestCommittedSequence: nextState.highestCommittedSequence,
      attemptStatus: resolveAttemptStatus(nextState, serverTimestamp),
      currentItemRef: nextState.currentItemRef,
      timing: renderAttemptClientTiming(nextState, serverTimestamp),
      policy: nextState.policy,
      deliveryPreferences: resolveAttemptDeliveryPreferences(nextState),
      ...(timingDecision ? { timingDecision } : {}),
      serverTimestamp,
    };

    const persistedState =
      nextState.attemptStatus === "submitted"
        ? {
            ...nextState,
            submissionReceipt: receipt,
          }
        : nextState;

    await this.commitOutbox.commit({
      state: persistedState,
      previousState: storedState,
      event,
      receipt,
      receiptStorageKey: receiptKey(event.idempotencyKey),
    });

    return receipt;
  }

  private async autoSubmitExceededDeadline(attemptId: string, requestedAt: string): Promise<void> {
    const storedState = await this.ensureAttemptState(attemptId);
    if (storedState.attemptStatus === "submitted") return;
    const deadline = findAttemptDeadlineAlarm(storedState);
    if (!deadline || Date.parse(requestedAt) < deadline.at) return;
    const deadlineScope = deadline.scope;

    const deadlineKey = [
      attemptId,
      storedState.scopedTiming.policyVersion,
      deadlineScope.key,
      deadlineScope.deadlineAt,
    ].join(":");
    const event: AttemptEventEnvelope<"timing.auto-submit.requested"> = {
      attemptId,
      eventId: createId("evt_deadline_auto_submit"),
      idempotencyKey: `deadline-auto-submit:${deadlineKey}`,
      sequenceNumber: storedState.highestCommittedSequence + 1,
      clientTimestamp: requestedAt,
      clientSessionId: SERVER_DEADLINE_AUTO_SUBMIT_CLIENT_SESSION_ID,
      itemRef: storedState.currentItemRef,
      type: "timing.auto-submit.requested",
      payload: {
        requestedAt: deadlineScope.deadlineAt ?? requestedAt,
        reason:
          deadlineScope.scopeType === "assessment-test"
            ? "assignment-deadline-reached"
            : "max-time-reached",
        scopeKey: deadlineScope.key,
        submissionSummary: storedState.submissionSummary,
        submissionMaterialization: null,
      },
    };
    const response = await this.commitEvent(attemptId, event, storedState, requestedAt);

    if (response.outcome === "accepted" || response.outcome === "duplicate") return;

    throw new AttemptDurableObjectRequestError(
      409,
      "Deadline auto-submit could not advance the attempt",
      {
        outcome: response.outcome,
        attemptStatus: response.attemptStatus,
      },
    );
  }

  private async getAuthoritativeSession(
    attemptId: string,
    clientSessionId: string | null,
  ): Promise<AuthoritativeAttemptSessionState> {
    const storedState = await this.ensureAttemptState(attemptId);
    if (
      clientSessionId &&
      storedState.currentClientSessionId &&
      clientSessionId !== storedState.currentClientSessionId &&
      storedState.attemptStatus !== "submitted"
    )
      throw new AttemptDurableObjectRequestError(
        409,
        "This attempt is active on another workstation. Ask an invigilator to transfer it to this workstation.",
      );
    const claimedState =
      clientSessionId &&
      storedState.attemptStatus !== "submitted" &&
      clientSessionId !== storedState.currentClientSessionId
        ? {
            ...storedState,
            currentClientSessionId: clientSessionId,
          }
        : storedState;

    if (claimedState !== storedState) {
      await this.state.storage.put(STATE_KEY, claimedState);
    }

    return {
      ...(claimedState.responseCheckpoint
        ? { responseCheckpoint: claimedState.responseCheckpoint }
        : {}),
      currentItemRef: claimedState.currentItemRef,
      sequence: {
        lastAcceptedSequence:
          claimedState.highestCommittedSequence === 0
            ? null
            : claimedState.highestCommittedSequence,
        nextSequence: claimedState.highestCommittedSequence + 1,
      },
      timing: renderAttemptClientTiming(claimedState, undefined),
      attemptStatus: resolveAttemptStatus(claimedState),
      deliveryPreferences: resolveAttemptDeliveryPreferences(claimedState),
    };
  }

  private async getAuthoritativePolicy(attemptId: string): Promise<AttemptPolicyReadResponse> {
    const storedState = await this.ensureAttemptState(attemptId);
    return buildPolicyReadResponse(storedState);
  }

  private async getSubmissionSummary(attemptId: string): Promise<{
    attemptId: string;
    submissionSummary: AttemptSubmissionSummary | null;
  }> {
    const storedState = await this.ensureAttemptState(attemptId);
    return {
      attemptId,
      submissionSummary: storedState.submissionSummary ?? null,
    };
  }

  private async getResultMaterialization(
    attemptId: string,
  ): Promise<AttemptMaterializationResponse> {
    const storedState = await this.ensureAttemptState(attemptId);
    return {
      attemptId,
      assessmentVersionId: storedState.assessmentVersionId,
      assignmentId: storedState.assignmentId,
      submissionMaterialization: enrichSubmissionMaterializationWithBuiltins(
        storedState,
        storedState.submissionMaterialization,
      ),
      submissionSummary: storedState.submissionSummary ?? null,
    };
  }

  private async getAdaptiveItemView(
    attemptId: string,
    itemId: string,
  ): Promise<AdaptiveItemViewResponse> {
    const storedState = await this.ensureAttemptState(attemptId);
    return renderCurrentAdaptiveItemView({
      bucket: this.env.CONTENT_BUCKET,
      storedState,
      itemId,
    });
  }

  private async applyPolicyCommand(
    attemptId: string,
    command: AttemptPolicyCommand,
  ): Promise<AttemptPolicyReadResponse> {
    const storedState = await this.ensureAttemptState(attemptId);
    if (command.type === "transfer-workstation") {
      const transferred = await transferWorkstation(this.state.storage, storedState, command);
      return buildPolicyReadResponse(transferred);
    }
    const nextState = applyAttemptPolicyCommand(storedState, command);
    const updatedAt = new Date().toISOString();

    await this.env.HARBOR_DB.batch([
      this.env.HARBOR_DB.prepare(
        "INSERT INTO attempt_policy_commands (id, attempt_id, command_type, actor_role, actor_id, actor_display_name, reason, issued_at, effective_at, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        command.commandId,
        attemptId,
        command.type,
        command.actor.role,
        command.actor.actorId,
        command.actor.displayName,
        command.reason,
        command.issuedAt,
        command.effectiveAt,
        JSON.stringify(command),
        updatedAt,
      ),
      this.env.HARBOR_DB.prepare(
        "INSERT INTO attempt_policy_overlays (attempt_id, overlay_revision, additional_time_seconds, reopen_status, reopened_at, reopen_until, operator_message_json, accommodations_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET overlay_revision = excluded.overlay_revision, additional_time_seconds = excluded.additional_time_seconds, reopen_status = excluded.reopen_status, reopened_at = excluded.reopened_at, reopen_until = excluded.reopen_until, operator_message_json = excluded.operator_message_json, accommodations_json = excluded.accommodations_json, updated_at = excluded.updated_at",
      ).bind(
        attemptId,
        nextState.policy.overlayRevision,
        nextState.policy.timing.additionalTimeSeconds,
        nextState.policy.reopen.status,
        nextState.policy.reopen.reopenedAt,
        nextState.policy.reopen.reopenUntil,
        nextState.policy.operatorMessage ? JSON.stringify(nextState.policy.operatorMessage) : null,
        JSON.stringify(nextState.policy.accommodations),
        updatedAt,
      ),
    ]);

    await this.commitOutbox.commitState(nextState);
    if (command.type === "extend-time" || command.type === "reopen-attempt") {
      await insertTimingEvidenceEvent({
        db: this.env.HARBOR_DB,
        storedState: nextState,
        eventType: "timing.policy.extended",
        sequenceNumber: null,
        itemRef: nextState.currentItemRef,
        payload: {
          commandId: command.commandId,
          commandType: command.type,
          effectiveTimingPolicyVersion: nextState.scopedTiming.policyVersion,
          additionalTimeSeconds: nextState.policy.timing.additionalTimeSeconds,
          effectiveSoftCloseAt: nextState.policy.timing.effectiveSoftCloseAt,
          effectiveAcceptUntil: nextState.policy.timing.effectiveAcceptUntil,
          source: command.actor.role,
        },
        createdAt: updatedAt,
      });
    }
    return buildPolicyReadResponse(nextState);
  }

  private async ensureAttemptState(attemptId: string): Promise<StoredAttemptState> {
    return ensureStoredAttemptState({
      storage: this.state.storage,
      db: this.env.HARBOR_DB,
      bucket: this.env.CONTENT_BUCKET,
      attemptId,
      fixedOrderRuntime: this.fixedOrderRuntime,
    });
  }
}

function applyCommittedEvent(
  storedState: StoredAttemptState,
  event: AttemptEventEnvelope,
  serverTimestamp: string,
): StoredAttemptState {
  const scopedTiming = applyScopedTimingEvent(
    storedState.scopedTiming,
    storedState.currentItemRef,
    event,
    serverTimestamp,
  );

  if (event.type === "response.changed") {
    const responseEvent = event as AttemptEventEnvelope<"response.changed">;
    return {
      ...storedState,
      highestCommittedSequence: responseEvent.sequenceNumber,
      currentClientSessionId: responseEvent.clientSessionId,
      scopedTiming,
      submissionMaterialization: mergeSubmissionMaterialization(
        storedState.submissionMaterialization,
        readSubmissionMaterializationFromResponseChange(
          {
            ...storedState,
            scopedTiming,
          },
          responseEvent,
          serverTimestamp,
        ),
      ),
    };
  }

  if (event.type === "submit.requested" || event.type === "timing.auto-submit.requested") {
    const submitPayload = readSubmitLikePayload(event);
    const submissionSummary = submitPayload?.submissionSummary
      ? {
          ...submitPayload.submissionSummary,
          submittedAt: serverTimestamp,
        }
      : null;

    return {
      ...storedState,
      highestCommittedSequence: event.sequenceNumber,
      attemptStatus: "submitted",
      currentClientSessionId:
        event.clientSessionId === SERVER_DEADLINE_AUTO_SUBMIT_CLIENT_SESSION_ID
          ? storedState.currentClientSessionId
          : event.clientSessionId,
      scopedTiming,
      submissionMaterialization: materializeSubmitState(
        {
          ...storedState,
          scopedTiming,
        },
        storedState.testSequence ? null : (submitPayload?.submissionMaterialization ?? null),
        serverTimestamp,
      ),
      submissionSummary: storedState.testSequence ? null : submissionSummary,
    };
  }

  if (event.type === "navigation.requested") {
    const navigationEvent = event as AttemptEventEnvelope<"navigation.requested">;
    return {
      ...storedState,
      highestCommittedSequence: event.sequenceNumber,
      currentItemRef: navigationEvent.payload.targetItemRef,
      currentClientSessionId: event.clientSessionId,
      scopedTiming,
    };
  }

  if (event.type === "keyword-translation.language.selected") {
    const languageEvent = event as AttemptEventEnvelope<"keyword-translation.language.selected">;
    const entitledLanguage = resolveEntitledKeywordTranslationLanguage(
      storedState,
      languageEvent.payload.requestedLanguage,
    );
    return {
      ...storedState,
      highestCommittedSequence: event.sequenceNumber,
      currentClientSessionId: event.clientSessionId,
      deliveryPreferences: { keywordTranslationLanguage: entitledLanguage },
      scopedTiming,
    };
  }

  return {
    ...storedState,
    highestCommittedSequence: event.sequenceNumber,
    currentClientSessionId: event.clientSessionId,
    scopedTiming,
  };
}

function validateNavigationRequest(
  storedState: StoredAttemptState,
  event: AttemptEventEnvelope<"navigation.requested">,
  now: string,
): void {
  if (!currentItemRefsMatch(event.itemRef, storedState.currentItemRef)) {
    throw new AttemptDurableObjectRequestError(
      409,
      "Navigation request does not match the authoritative current item",
      buildAttemptStateErrorPayload(
        "Navigation request does not match the authoritative current item",
        storedState,
      ),
    );
  }

  const currentIndex = storedState.allowedItemRefs.findIndex((itemRef) =>
    currentItemRefsMatch(itemRef, storedState.currentItemRef),
  );
  const targetIndex = storedState.allowedItemRefs.findIndex((itemRef) =>
    currentItemRefsMatch(itemRef, event.payload.targetItemRef),
  );

  if (currentIndex === -1 || targetIndex === -1) {
    throw new AttemptDurableObjectRequestError(
      409,
      "Navigation target is not part of the pinned delivery manifest",
      buildAttemptStateErrorPayload(
        "Navigation target is not part of the pinned delivery manifest",
        storedState,
      ),
    );
  }

  if (storedState.deliveryPolicy.navigationMode !== "linear") {
    return;
  }

  if (targetIndex > currentIndex) {
    const blockingScope = findMinimumTimeBlockingScope(
      storedState.scopedTiming,
      storedState.currentItemRef.itemId,
      now,
    );
    if (blockingScope) {
      throw new AttemptDurableObjectRequestError(
        409,
        "Minimum time has not elapsed for this item in linear navigation",
        {
          ...buildAttemptStateErrorPayload(
            "Minimum time has not elapsed for this item in linear navigation",
            storedState,
            resolveAttemptStatus(storedState),
            renderAttemptClientTiming(storedState, now),
          ),
          timingBlock: {
            scopeKey: blockingScope.key,
            scopeType: blockingScope.scopeType,
            identifier: blockingScope.identifier,
            minTimeSeconds: blockingScope.minTimeSeconds,
            elapsedTimeSeconds: truncateSeconds(readScopeElapsedMilliseconds(blockingScope, now)),
          },
        },
      );
    }
  }

  if (targetIndex < currentIndex || targetIndex > currentIndex + 1) {
    throw new AttemptDurableObjectRequestError(
      409,
      "Linear navigation only allows staying on the current item or moving to the next pinned item",
      buildAttemptStateErrorPayload(
        "Linear navigation only allows staying on the current item or moving to the next pinned item",
        storedState,
      ),
    );
  }
}

function validateHardDeadlineWrite(
  storedState: StoredAttemptState,
  event: AttemptEventEnvelope,
  now: string,
): void {
  if (event.type === "submit.requested" || event.type === "timing.auto-submit.requested") {
    return;
  }

  const deadlineScope = findExceededAutoSubmitDeadlineScope(storedState.scopedTiming, now);
  if (!deadlineScope) {
    return;
  }

  const message =
    "A hard timing deadline has elapsed; an explicit timing auto-submit event is required before more work can be accepted";
  throw new AttemptDurableObjectRequestError(409, message, {
    ...buildAttemptStateErrorPayload(
      message,
      storedState,
      resolveAttemptStatus(storedState, now),
      renderAttemptClientTiming(storedState, now),
    ),
    timingBlock: {
      scopeKey: deadlineScope.key,
      scopeType: deadlineScope.scopeType,
      identifier: deadlineScope.identifier,
      deadlineAt: deadlineScope.deadlineAt,
      allowLateSubmission: deadlineScope.allowLateSubmission,
    },
  });
}

function receiptKey(idempotencyKey: string): string {
  return `${RECEIPT_KEY_PREFIX}${idempotencyKey}`;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createDeliveryContextRequest(request: Request): Request {
  const originalUrl = readRequiredString(
    request.headers.get(ATTEMPT_COORDINATOR_DELIVERY_CONTEXT_URL_HEADER),
    "delivery context url header is required",
  );
  const headers = new Headers(request.headers);
  headers.delete(ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER);
  headers.delete(ATTEMPT_COORDINATOR_DELIVERY_CONTEXT_URL_HEADER);

  return new Request(originalUrl, {
    method: request.method,
    headers,
  });
}
import {
  advanceTestSequenceAnswer,
  guardTestSequenceEvent,
  summarizeTestSubmission,
} from "./test-session-delivery";

function isTestAnswerEvent(
  event: AttemptEventEnvelope,
): event is AttemptEventEnvelope<"item.submit-requested"> {
  return (
    event.type === "item.submit-requested" &&
    "responseKey" in event.payload &&
    "responseState" in event.payload
  );
}
