import type { DeliveryPolicySnapshot } from "@harbor/attempt-protocol";

/** Project delivery settings without the server's SEB verification material. */
export function projectCandidateDeliveryPolicy(
  policy: DeliveryPolicySnapshot,
): DeliveryPolicySnapshot {
  const { safeExamBrowser, ...candidatePolicy } = policy;
  return safeExamBrowser === undefined
    ? candidatePolicy
    : { ...candidatePolicy, safeExamBrowser: null };
}
