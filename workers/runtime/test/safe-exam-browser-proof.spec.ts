import { describe, expect, it } from "vitest";
import type { SafeExamBrowserPolicySnapshot } from "@harbor/content-model";
import { readSafeExamBrowserPolicy } from "../src/routes/safe-exam-browser-policy";
import {
  evaluateSafeExamBrowserProof,
  createSafeExamBrowserConfigKeyRequestHash,
  createSafeExamBrowserBrowserExamKeyRequestHashes,
  SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER,
  SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER,
  HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER,
  HARBOR_SAFE_EXAM_BROWSER_JS_REQUEST_HASH_HEADER,
  HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER,
} from "../src/security/safe-exam-browser";

const configKey = "a".repeat(64);
const browserKey = "b".repeat(64);
const url = "https://harbor.local/api/attempts/proof-test/events";
const policy: SafeExamBrowserPolicySnapshot = {
  verificationMode: "config-key-and-browser-exam-key",
  configKeyHash: configKey,
  browserExamKeys: [{ keyHash: browserKey, platform: "macos", sebVersion: "test-build" }],
};

async function proofHeaders(proofUrl: string, js = false): Promise<Headers> {
  const headers = new Headers();
  headers.set(
    js
      ? HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER
      : SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER,
    await createSafeExamBrowserConfigKeyRequestHash({
      requestUrl: proofUrl,
      configKeyHash: configKey,
    }),
  );
  const [proof] = await createSafeExamBrowserBrowserExamKeyRequestHashes({
    requestUrl: proofUrl,
    browserExamKey: browserKey,
  });
  if (!proof) throw new Error("Missing test browser proof");
  headers.set(
    js ? HARBOR_SAFE_EXAM_BROWSER_JS_REQUEST_HASH_HEADER : SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER,
    proof,
  );
  if (js) headers.set(HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER, proofUrl);
  return headers;
}

describe("explicit SEB verification requirements", () => {
  it("requires both configured proofs rather than accepting either", async () => {
    const complete = await proofHeaders(url);
    for (const missing of [
      SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER,
      SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER,
    ]) {
      const headers = new Headers(complete);
      headers.delete(missing);
      const result = await evaluateSafeExamBrowserProof({
        request: new Request(url, { headers }),
        policy,
        userAgentProvider: "safe-exam-browser",
      });
      expect(result.verified).toBe(false);
    }
    expect(
      await evaluateSafeExamBrowserProof({
        request: new Request(url, { headers: complete }),
        policy,
        userAgentProvider: null,
      }),
    ).toMatchObject({ verified: true, method: "config-key-and-browser-exam-key" });
  });

  it("rejects an incorrect required proof even with valid other proof and demo flags", async () => {
    for (const incorrect of [
      SAFE_EXAM_BROWSER_CONFIG_KEY_HASH_HEADER,
      SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER,
    ]) {
      const headers = await proofHeaders(url);
      headers.set(incorrect, "f".repeat(64));
      const result = await evaluateSafeExamBrowserProof({
        request: new Request(url, { headers }),
        policy: { ...policy, allowUserAgentFallback: true },
        userAgentProvider: "safe-exam-browser",
        allowUnsafeUserAgentFallback: true,
      });
      expect(result.verified).toBe(false);
      expect(result.method).toBeNull();
    }
  });

  it("checks JavaScript proofs against the same-origin page URL", async () => {
    const headers = await proofHeaders("https://harbor.local/session", true);
    expect(
      await evaluateSafeExamBrowserProof({
        request: new Request(url, { headers }),
        policy,
        userAgentProvider: null,
      }),
    ).toMatchObject({ verified: true });
    const foreign = await proofHeaders("https://unapproved.example/session", true);
    expect(
      await evaluateSafeExamBrowserProof({
        request: new Request(url, { headers: foreign }),
        policy,
        userAgentProvider: null,
      }),
    ).toMatchObject({ verified: false });
  });

  it("does not use an unselected proof as a fallback", async () => {
    const headers = await proofHeaders(url);
    headers.delete(SAFE_EXAM_BROWSER_REQUEST_HASH_HEADER);
    expect(
      await evaluateSafeExamBrowserProof({
        request: new Request(url, { headers }),
        policy: { ...policy, verificationMode: "browser-exam-key" },
        userAgentProvider: null,
      }),
    ).toMatchObject({ verified: false });
  });

  it("rejects missing/unknown modes and modes missing required verification material", () => {
    for (const value of [undefined, "either", "browser-exam-keys"]) {
      expect(() =>
        readSafeExamBrowserPolicy({ configKeyHash: configKey, verificationMode: value }),
      ).toThrow("verificationMode must explicitly select");
    }
    expect(() =>
      readSafeExamBrowserPolicy({
        verificationMode: "config-key-and-browser-exam-key",
        configKeyHash: configKey,
      }),
    ).toThrow("requires an approved Browser Exam Key");
    expect(() => readSafeExamBrowserPolicy({ ...policy, misspelledMode: "config-key" })).toThrow(
      "unsupported field",
    );
  });

  it("confines the named user-agent demo to a local request without real key policy", async () => {
    const demo: SafeExamBrowserPolicySnapshot = {
      verificationMode: "config-key",
      allowUserAgentFallback: true,
    };
    const input = {
      policy: demo,
      userAgentProvider: "safe-exam-browser",
      allowUnsafeUserAgentFallback: true,
    };
    expect(
      await evaluateSafeExamBrowserProof({ ...input, request: new Request(url) }),
    ).toMatchObject({ verified: false, method: "user-agent-demo" });
    expect(
      await evaluateSafeExamBrowserProof({
        ...input,
        request: new Request("https://production.example/exam"),
      }),
    ).toMatchObject({ verified: false, method: null });
  });
});
