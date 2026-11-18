const encoder = new TextEncoder();

/** Imports a non-empty UTF-8 secret as an HMAC-SHA-256 key. */
export function importHmacSha256Key(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("HMAC secret is required");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Signs a UTF-8 value with HMAC-SHA-256. */
export async function signHmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await importHmacSha256Key(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

/** Verifies a base64url HMAC-SHA-256 signature for a UTF-8 value. */
export async function verifyHmacSha256Base64Url(
  secret: string,
  value: string,
  encodedSignature: string,
): Promise<boolean> {
  try {
    const key = await importHmacSha256Key(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      toBufferSource(decodeBase64Url(encodedSignature)),
      encoder.encode(value),
    );
  } catch {
    return false;
  }
}

/** Signs a UTF-8 value with HMAC-SHA-256 and returns lowercase hex. */
export async function signHmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await importHmacSha256Key(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return encodeHex(new Uint8Array(signature));
}

/** Verifies a lowercase or uppercase hex HMAC-SHA-256 signature. */
export async function verifyHmacSha256Hex(
  secret: string,
  value: string,
  encodedSignature: string,
): Promise<boolean> {
  try {
    const key = await importHmacSha256Key(secret);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      toBufferSource(decodeHex(encodedSignature)),
      encoder.encode(value),
    );
  } catch {
    return false;
  }
}

/** Encodes bytes using unpadded base64url. */
export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Decodes strict unpadded base64url input. */
export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid base64url value");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function encodeHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error("Invalid HMAC-SHA-256 hex value");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function toBufferSource(value: Uint8Array): BufferSource {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
