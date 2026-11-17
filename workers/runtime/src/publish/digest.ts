/** Return a lowercase SHA-256 digest for immutable publication bytes. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toExactArrayBuffer(data));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function toExactArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data.buffer;
  }
  return data.slice().buffer as ArrayBuffer;
}
