import { describe, expect, it } from "vitest";

import {
  signHmacSha256Base64Url,
  signHmacSha256Hex,
  verifyHmacSha256Base64Url,
  verifyHmacSha256Hex,
} from "../src/security/hmac-signed-value";

describe("HMAC signed values", () => {
  it("preserves base64url and hex wire encodings", async () => {
    const base64Url = await signHmacSha256Base64Url("secret", "payload");
    const hex = await signHmacSha256Hex("secret", "payload");

    expect(base64Url).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(base64Url).not.toContain("=");
    expect(hex).toMatch(/^[0-9a-f]{64}$/u);
    await expect(verifyHmacSha256Base64Url("secret", "payload", base64Url)).resolves.toBe(true);
    await expect(verifyHmacSha256Hex("secret", "payload", hex)).resolves.toBe(true);
  });

  it("rejects tampered, malformed, and wrong-secret signatures", async () => {
    const base64Url = await signHmacSha256Base64Url("secret", "payload");
    const hex = await signHmacSha256Hex("secret", "payload");

    await expect(verifyHmacSha256Base64Url("secret", "tampered", base64Url)).resolves.toBe(false);
    await expect(verifyHmacSha256Base64Url("wrong", "payload", base64Url)).resolves.toBe(false);
    await expect(verifyHmacSha256Base64Url("secret", "payload", "not+base64")).resolves.toBe(false);
    await expect(verifyHmacSha256Hex("secret", "tampered", hex)).resolves.toBe(false);
    await expect(verifyHmacSha256Hex("wrong", "payload", hex)).resolves.toBe(false);
    await expect(verifyHmacSha256Hex("secret", "payload", "not-hex")).resolves.toBe(false);
  });
});
