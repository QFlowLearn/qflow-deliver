import { describe, expect, it } from "vitest";
import type { BootstrapClaims, DeliveryPolicySnapshot } from "@harbor/attempt-protocol";
import { DEFAULT_DELIVERY_POLICY_SNAPSHOT } from "@harbor/content-model";
import { projectCandidateDeliveryPolicy } from "../src/delivery/candidate-delivery-policy";
import { fingerprintDeliveryPolicy } from "../src/delivery/delivery-policy";
import { issueBootstrapToken, verifyBootstrapToken } from "../src/launch/sign-bootstrap";

describe("candidate delivery policy boundary", () => {
  const key = "a".repeat(64);
  const browserKey = "b".repeat(64);
  const privatePolicy: DeliveryPolicySnapshot = {
    ...DEFAULT_DELIVERY_POLICY_SNAPSHOT,
    secureBrowserRequired: true,
    safeExamBrowser: {
      verificationMode: "config-key" as const,
      configKeyHash: key,
      browserExamKeys: [{ keyHash: browserKey }],
    },
  };

  it("removes SEB material without mutating the private policy", () => {
    const candidate = projectCandidateDeliveryPolicy(privatePolicy);
    expect(candidate.safeExamBrowser).toBeNull();
    expect(candidate.secureBrowserRequired).toBe(true);
    expect(privatePolicy.safeExamBrowser?.configKeyHash).toBe(key);
    expect(JSON.stringify(candidate)).not.toContain(key);
    expect(JSON.stringify(candidate)).not.toContain(browserKey);
  });

  it("binds hidden verification changes and ignores object property order", async () => {
    const changed = {
      ...privatePolicy,
      safeExamBrowser: { verificationMode: "config-key" as const, configKeyHash: "c".repeat(64) },
    };
    expect(projectCandidateDeliveryPolicy(changed)).toEqual(
      projectCandidateDeliveryPolicy(privatePolicy),
    );
    expect(await fingerprintDeliveryPolicy(changed)).not.toBe(
      await fingerprintDeliveryPolicy(privatePolicy),
    );
    const { safeExamBrowser, ...settings } = privatePolicy;
    const reordered = { safeExamBrowser, ...settings };
    expect(await fingerprintDeliveryPolicy(reordered)).toBe(
      await fingerprintDeliveryPolicy(privatePolicy),
    );
  });

  it("signs only a safe projection and a fingerprint into the actual launch token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Omit<BootstrapClaims, "deliveryPolicyFingerprint"> = {
      iss: "harbor-runtime",
      aud: "harbor-shell",
      sub: "attempt:policy-test",
      jti: "policy-test",
      iat: now,
      exp: now + 60,
      attemptId: "policy-test",
      assessmentVersionId: "version-test",
      deliveryPolicy: privatePolicy,
      manifest: { manifestObjectKey: "manifest-test" },
      currentItemRef: { itemId: "item-test", itemHref: "item.xml" },
      launch: {
        mode: "preview",
        actor: { kind: "preview-operator", id: "operator-test", displayName: null },
      },
    };
    const secret = "candidate-policy-test-signing-key";
    const token = await issueBootstrapToken({ secret, claims });
    const verified = await verifyBootstrapToken({ secret, token });
    expect(verified.deliveryPolicy.safeExamBrowser).toBeNull();
    expect(verified.deliveryPolicyFingerprint).toBe(await fingerprintDeliveryPolicy(privatePolicy));
    expect(JSON.stringify(verified)).not.toContain(key);
    expect(JSON.stringify(verified)).not.toContain(browserKey);
  });
});
