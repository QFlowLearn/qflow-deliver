import type { DeliveryContextEvaluation, DeliveryPolicySnapshot } from "@harbor/attempt-protocol";
import { fingerprintDeliveryPolicy } from "../delivery/delivery-policy";
import { appendAttemptTimelineEvent } from "../routes/operator-actions";

/** Persist verification decisions without keys, request URLs, tokens, or answer payloads. */
export async function recordSecureBrowserEvidence(
  input: {
    readonly db: D1Database;
    readonly attemptId: string;
    readonly phase: "bootstrap" | "relaunch" | "commit";
    readonly policy: DeliveryPolicySnapshot;
  } & (
    | { readonly context: DeliveryContextEvaluation; readonly blockedReason?: never }
    | { readonly context?: never; readonly blockedReason: "invalid-launch" }
  ),
): Promise<void> {
  if (!input.policy.secureBrowserRequired && !input.policy.safeExamBrowser) return;
  const context = input.context;
  await appendAttemptTimelineEvent({
    db: input.db,
    attemptId: input.attemptId,
    eventType: "secure-browser",
    summary: {
      phase: input.phase,
      outcome:
        input.blockedReason || context?.allowed === false
          ? "blocked"
          : context?.secureBrowserVerified
            ? "verified"
            : "demo-only",
      verificationMode: input.policy.safeExamBrowser?.verificationMode ?? null,
      verificationMethod: context?.secureBrowserVerificationMethod ?? null,
      blockedReason: input.blockedReason ?? context?.blockedReason ?? null,
      policyFingerprint: await fingerprintDeliveryPolicy(input.policy),
    },
  });
}
