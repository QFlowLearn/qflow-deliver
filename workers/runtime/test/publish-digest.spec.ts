import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/publish/digest";

describe("publication digest", () => {
  it("hashes only the supplied Uint8Array view", async () => {
    const backingBytes = new Uint8Array([99, 1, 2, 3, 88]);
    const view = backingBytes.subarray(1, 4);

    expect(await sha256Hex(view)).toBe(await sha256Hex(new Uint8Array([1, 2, 3])));
    expect(await sha256Hex(view)).not.toBe(await sha256Hex(backingBytes));
  });
});
