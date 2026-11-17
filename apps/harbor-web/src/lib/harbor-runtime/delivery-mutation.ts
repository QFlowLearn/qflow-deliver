import type { AttemptEventCommitResponse } from "@harbor/attempt-protocol";

import type { RendererLifecycleRuntime } from "./renderer-lifecycle";
import type { MutableRef, RefLike } from "./ref-like";
import { requireMutableRef } from "./ref-like";

export interface DeliveryMutationContext {
  rendererLifecycle: MutableRef<RendererLifecycleRuntime>;
  handleCommitResponse(response: AttemptEventCommitResponse): Promise<void>;
  syncRecoveryState(): Promise<void>;
  maybeProjectDeliveryContextError(error: unknown): void;
  buildReceiptStatusMessage(): string;
  formatError(error: unknown): string;
  sessionIsStale: RefLike<boolean>;
  pendingReplayCount: RefLike<number>;
}

export function requireRendererLifecycle(
  rendererLifecycle: MutableRef<RendererLifecycleRuntime>,
): RendererLifecycleRuntime {
  return requireMutableRef(rendererLifecycle, "Renderer lifecycle");
}

export interface DeliveryMutationSetters {
  deliveryBusy: RefLike<boolean>;
  errorMessage: RefLike<string>;
  replayStatus: RefLike<string>;
}

export async function runDeliveryBusyMutation(
  ctx: DeliveryMutationContext,
  setters: DeliveryMutationSetters,
  input: {
    initialReplayStatus?: string;
    run: () => Promise<void>;
    onSuccess?: () => void;
    onError?: (error: unknown) => void;
    onFinally?: () => void;
    errorReplayStatus?: (error: unknown) => string;
  },
): Promise<void> {
  setters.deliveryBusy.value = true;
  setters.errorMessage.value = "";
  if (input.initialReplayStatus !== undefined) {
    setters.replayStatus.value = input.initialReplayStatus;
  }

  try {
    await input.run();
    input.onSuccess?.();
  } catch (error) {
    ctx.maybeProjectDeliveryContextError(error);
    await ctx.syncRecoveryState();
    if (input.errorReplayStatus) {
      setters.replayStatus.value = input.errorReplayStatus(error);
    } else {
      setters.errorMessage.value = ctx.formatError(error);
    }
    input.onError?.(error);
  } finally {
    setters.deliveryBusy.value = false;
    input.onFinally?.();
  }
}

export function finishDeliveryMutationSuccess(
  ctx: DeliveryMutationContext,
  setters: DeliveryMutationSetters,
): void {
  if (!ctx.sessionIsStale.value) {
    setters.replayStatus.value = ctx.buildReceiptStatusMessage();
  }
}

export function deliveryMutationErrorReplayStatus(
  ctx: DeliveryMutationContext,
  error: unknown,
): string {
  return ctx.pendingReplayCount.value > 0
    ? `${ctx.pendingReplayCount.value} saved update(s) will sync when the connection is available.`
    : ctx.formatError(error);
}
