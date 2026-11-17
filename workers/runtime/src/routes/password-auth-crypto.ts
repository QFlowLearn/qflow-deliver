export const PASSWORD_ALGORITHM = "PBKDF2-HMAC-SHA256";
export const PASSWORD_ITERATIONS = 310000;

const PASSWORD_SALT_BYTES = 32;
const PASSWORD_HASH_BYTES = 32;

export interface PasswordHashRecord {
  password_hash: string;
  password_salt: string;
  password_algorithm: string;
  password_iterations: number;
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hashBytes = await derivePasswordHash(password, saltBytes, PASSWORD_ITERATIONS);
  return {
    hash: bytesToBase64Url(hashBytes),
    salt: bytesToBase64Url(saltBytes),
  };
}

export async function verifyPassword(
  account: PasswordHashRecord,
  password: string,
): Promise<boolean> {
  if (
    account.password_algorithm !== PASSWORD_ALGORITHM ||
    account.password_iterations < PASSWORD_ITERATIONS
  ) {
    return false;
  }

  const salt = base64UrlToBytes(account.password_salt);
  const expectedHash = base64UrlToBytes(account.password_hash);
  const actualHash = await derivePasswordHash(password, salt, account.password_iterations);
  return constantTimeEqual(expectedHash, actualHash);
}

export async function spendPasswordVerificationWork(password: string): Promise<void> {
  const salt = new Uint8Array(PASSWORD_SALT_BYTES);
  await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomBase64Url(bytes: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: copyBuffer(salt), iterations },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
