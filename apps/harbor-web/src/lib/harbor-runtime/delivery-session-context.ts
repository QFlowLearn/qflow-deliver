import type {
  AttemptEventCommitResponse,
  AttemptPolicyReadResponse,
  AttemptPolicyState,
  AuthoritativeAttemptSessionState,
} from "@harbor/attempt-protocol";
import type { BootstrappedSession } from "../bootstrap-client";
import type { RuntimeRecoveryCache } from "./recovery-session-cache";
import type { RendererLifecycleRuntime } from "./renderer-lifecycle";
import type { MutableRef } from "./ref-like";
import type { DeliverySessionState } from "./delivery-session-state";

export const RECOVERY_HEARTBEAT_INTERVAL_MS = 5_000;
export const TIMING_CLOCK_INTERVAL_MS = 1_000;
export const DEADLINE_WARNING_THRESHOLD_SECONDS = 60;
export const ATTEMPT_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DeliverySessionInput {
  rendererLifecycle: MutableRef<RendererLifecycleRuntime>;
  clearStudentSessionState(this: void): void;
  refreshStudentAssignments(this: void): void | Promise<void>;
}

export interface DeliverySessionActions {
  applyBootstrappedSession(this: void, session: BootstrappedSession): Promise<void>;
  applyPolicyProjection(
    this: void,
    projection: Omit<AttemptPolicyReadResponse, "policy"> & {
      policy?: AttemptPolicyState;
    },
    statusMessage: string,
  ): Promise<void>;
  buildReceiptStatusMessage(this: void): string;
  clearHistoryRefreshTimer(this: void): void;
  handleCommitResponse(
    this: void,
    response: AttemptEventCommitResponse,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  ensureRuntimeContentLoaded(
    this: void,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  maybeHandleDeadlineAutomation(this: void): Promise<void>;
  maybeProjectDeliveryContextError(this: void, error: unknown): void;
  persistAuthoritativeSessionState(
    this: void,
    state: import("../attempt-client").AttemptClientState,
  ): void;
  purgeExpiredRecoveryRecords(this: void): Promise<void>;
  recordCurrentItemPresented(
    this: void,
    presentationSource: "bootstrap" | "resume" | "navigation" | "replay",
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  refreshAssessmentHistory(
    this: void,
    attemptId?: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  replayPendingWork(this: void, reason: string): Promise<void>;
  scheduleHistoryRefreshIfPending(this: void, attemptId: string): void;
  startRecoveryHeartbeat(this: void): void;
  syncRecoveryState(this: void): Promise<void>;
  toAuthoritativeSessionState(
    this: void,
    session: BootstrappedSession,
  ): AuthoritativeAttemptSessionState;
}

export interface DeliverySessionContext {
  input: DeliverySessionInput;
  state: DeliverySessionState;
  // Populated after all action factories are created; action methods must read it only after factory init.
  actions: DeliverySessionActions;
}

export interface DeliverySessionLifecycle {
  recoveryCache: RuntimeRecoveryCache;
  handleBrowserOnline(this: void): void;
  handleVisibilityChange(this: void): void;
  handlePageHide(this: void): void;
  handlePageFreeze(this: void): void;
  startTimingClock(this: void): void;
  stopTimingClock(this: void): void;
  stopRecoveryHeartbeat(this: void): void;
  clearHistoryRefreshTimer(this: void): void;
  maybeProjectDeliveryContextError(this: void, error: unknown): void;
}
