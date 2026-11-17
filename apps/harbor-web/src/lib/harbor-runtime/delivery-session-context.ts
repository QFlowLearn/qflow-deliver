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
  clearStudentSessionState(): void;
  refreshStudentAssignments(): void | Promise<void>;
}

export interface DeliverySessionActions {
  applyBootstrappedSession(session: BootstrappedSession): Promise<void>;
  applyPolicyProjection(
    projection: Omit<AttemptPolicyReadResponse, "policy"> & {
      policy?: AttemptPolicyState;
    },
    statusMessage: string,
  ): Promise<void>;
  buildReceiptStatusMessage(): string;
  clearHistoryRefreshTimer(): void;
  handleCommitResponse(
    response: AttemptEventCommitResponse,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  ensureRuntimeContentLoaded(options?: { readonly signal?: AbortSignal }): Promise<void>;
  maybeHandleDeadlineAutomation(): Promise<void>;
  maybeProjectDeliveryContextError(error: unknown): void;
  persistAuthoritativeSessionState(state: import("../attempt-client").AttemptClientState): void;
  purgeExpiredRecoveryRecords(): Promise<void>;
  recordCurrentItemPresented(
    presentationSource: "bootstrap" | "resume" | "navigation" | "replay",
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  refreshAssessmentHistory(
    attemptId?: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  replayPendingWork(reason: string): Promise<void>;
  scheduleHistoryRefreshIfPending(attemptId: string): void;
  startRecoveryHeartbeat(): void;
  syncRecoveryState(): Promise<void>;
  toAuthoritativeSessionState(session: BootstrappedSession): AuthoritativeAttemptSessionState;
}

export interface DeliverySessionContext {
  input: DeliverySessionInput;
  state: DeliverySessionState;
  // Populated after all action factories are created; action methods must read it only after factory init.
  actions: DeliverySessionActions;
}

export interface DeliverySessionLifecycle {
  recoveryCache: RuntimeRecoveryCache;
  handleBrowserOnline(): void;
  handleVisibilityChange(): void;
  handlePageHide(): void;
  handlePageFreeze(): void;
  startTimingClock(): void;
  stopTimingClock(): void;
  stopRecoveryHeartbeat(): void;
  clearHistoryRefreshTimer(): void;
  maybeProjectDeliveryContextError(error: unknown): void;
}
