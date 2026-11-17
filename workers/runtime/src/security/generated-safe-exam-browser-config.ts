import type { AssignmentPolicySnapshot, DeliveryPolicySnapshot } from "@harbor/attempt-protocol";
import type { SafeExamBrowserPolicySnapshot } from "@harbor/content-model";

type SebConfigValue =
  | string
  | number
  | boolean
  | null
  | SebConfigValue[]
  | { [key: string]: SebConfigValue };

export interface GeneratedSafeExamBrowserUrls {
  startUrl: string;
  quitUrl: string;
}

export interface GeneratedSafeExamBrowserConfigResolution {
  assignmentPolicy: AssignmentPolicySnapshot;
  deliveryPolicy: DeliveryPolicySnapshot;
  configKeyHash: string;
}

const textEncoder = new TextEncoder();

export function isGeneratedSafeExamBrowserConfigEnabled(
  policy: SafeExamBrowserPolicySnapshot | null | undefined,
): boolean {
  return policy?.generatedConfig?.enabled === true;
}

export function buildGeneratedSafeExamBrowserUrls(input: {
  requestUrl: string;
  assignmentId: string;
  launchToken: string;
}): GeneratedSafeExamBrowserUrls {
  const base = new URL(input.requestUrl);
  const startUrl = new URL("/", base.origin);
  startUrl.searchParams.set("mode", "institutional-sso");
  startUrl.searchParams.set("assignmentId", input.assignmentId);
  startUrl.searchParams.set("seb", "1");
  startUrl.searchParams.set("sebLaunchToken", input.launchToken);

  const quitUrl = new URL("/", base.origin);
  quitUrl.searchParams.set("sebQuit", "1");
  quitUrl.searchParams.set("assignmentId", input.assignmentId);

  return {
    startUrl: startUrl.toString(),
    quitUrl: quitUrl.toString(),
  };
}

export function buildGeneratedSafeExamBrowserSettings(input: {
  urls: GeneratedSafeExamBrowserUrls;
  allowQuit?: boolean | null;
}): Record<string, SebConfigValue> {
  return {
    allowPreferencesWindow: false,
    allowQuit: input.allowQuit ?? true,
    browserURLSalt: true,
    browserWindowAllowReload: true,
    browserWindowWebView: 3,
    downloadAndOpenSebConfig: true,
    enableJavaScript: true,
    enablePlugIns: false,
    enableRightMouse: false,
    enableSebBrowser: true,
    enableZoomPage: true,
    enableZoomText: true,
    quitURL: input.urls.quitUrl,
    sebConfigPurpose: 1,
    sendBrowserExamKey: true,
    showReloadButton: true,
    showTaskBar: true,
    startURL: input.urls.startUrl,
    URLFilterEnable: false,
    URLFilterEnableContentFilter: false,
  };
}

export async function resolveGeneratedSafeExamBrowserConfigPolicy(input: {
  assignmentPolicy: AssignmentPolicySnapshot;
  deliveryPolicy: DeliveryPolicySnapshot;
  requestUrl: string;
  assignmentId: string;
  launchToken: string;
}): Promise<GeneratedSafeExamBrowserConfigResolution | null> {
  const safeExamBrowser = input.assignmentPolicy.safeExamBrowser;
  if (!safeExamBrowser || !isGeneratedSafeExamBrowserConfigEnabled(safeExamBrowser)) {
    return null;
  }

  const urls = buildGeneratedSafeExamBrowserUrls({
    requestUrl: input.requestUrl,
    assignmentId: input.assignmentId,
    launchToken: input.launchToken,
  });
  const settings = buildGeneratedSafeExamBrowserSettings({
    urls,
    allowQuit: safeExamBrowser?.generatedConfig?.allowQuit,
  });
  const configKeyHash = await computeSafeExamBrowserConfigKeyHash(settings);
  const generatedSafeExamBrowser = {
    ...safeExamBrowser,
    configKeyHash,
    generatedConfig: {
      enabled: true,
      allowQuit: safeExamBrowser?.generatedConfig?.allowQuit ?? null,
    },
  };
  const assignmentPolicy: AssignmentPolicySnapshot = {
    ...input.assignmentPolicy,
    safeExamBrowser: generatedSafeExamBrowser,
  };
  const deliveryPolicy: DeliveryPolicySnapshot = {
    ...input.deliveryPolicy,
    safeExamBrowser: generatedSafeExamBrowser,
  };

  return {
    assignmentPolicy,
    deliveryPolicy,
    configKeyHash,
  };
}

export async function buildSafeExamBrowserConfigFile(
  settings: Record<string, SebConfigValue>,
): Promise<Uint8Array> {
  const xml = buildPlistXml(settings);
  const body = concatBytes(textEncoder.encode("plnd"), textEncoder.encode(xml));
  return gzipBytes(body);
}

export async function computeSafeExamBrowserConfigKeyHash(
  settings: Record<string, SebConfigValue>,
): Promise<string> {
  return sha256Hex(textEncoder.encode(serializeSebJson(settings)));
}

export function buildPlistXml(settings: Record<string, SebConfigValue>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderPlistValue(settings, 0),
    "</plist>",
    "",
  ].join("\n");
}

function renderPlistValue(value: SebConfigValue, depth: number): string {
  const indent = "  ".repeat(depth);
  const nextIndent = "  ".repeat(depth + 1);

  if (value === null) {
    return `${indent}<string></string>`;
  }

  if (typeof value === "string") {
    return `${indent}<string>${escapeXml(value)}</string>`;
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  }

  if (typeof value === "boolean") {
    return `${indent}<${value ? "true" : "false"}/>`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}<array/>`;
    }
    return [
      `${indent}<array>`,
      ...value.map((entry) => renderPlistValue(entry, depth + 1)),
      `${indent}</array>`,
    ].join("\n");
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length === 0) {
    return `${indent}<dict/>`;
  }

  return [
    `${indent}<dict>`,
    ...entries.flatMap(([key, entry]) => [
      `${nextIndent}<key>${escapeXml(key)}</key>`,
      renderPlistValue(entry, depth + 1),
    ]),
    `${indent}</dict>`,
  ].join("\n");
}

function serializeSebJson(value: SebConfigValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeSebJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value)
    .filter(([key, entry]) => key !== "originatorVersion" && !isEmptyDict(entry))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${serializeSebJson(entry)}`)
    .join(",")}}`;
}

function isEmptyDict(value: SebConfigValue): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
