import type {
  DeliveryContextEvaluation,
  DeliveryContextMode,
  DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import { createAllowedDeliveryContext } from "@harbor/attempt-protocol";

import { LaunchRequestError } from "../launch/create-preview-attempt";
import {
  evaluateSafeExamBrowserProof,
  isSafeExamBrowserProvider,
  normalizeSafeExamBrowserProvider,
} from "../security/safe-exam-browser";

export const DELIVERY_CONTEXT_FRAME_MODE_HEADER = "x-harbor-frame-mode";
export const DELIVERY_CONTEXT_EMBED_ORIGIN_HEADER = "x-harbor-embed-origin";
export const DELIVERY_CONTEXT_SECURE_BROWSER_PROVIDER_HEADER = "x-harbor-secure-browser-provider";
export const DELIVERY_CONTEXT_MODE_QUERY_PARAM = "contextMode";
export const DELIVERY_CONTEXT_EMBED_ORIGIN_QUERY_PARAM = "embedOrigin";
export const DELIVERY_CONTEXT_SECURE_BROWSER_PROVIDER_QUERY_PARAM = "secureBrowserProvider";

export class DeliveryContextError extends LaunchRequestError {
  constructor(
    readonly deliveryContext: DeliveryContextEvaluation,
    message = buildBlockedContextMessage(deliveryContext),
  ) {
    super(403, message);
  }
}

export async function requireAllowedDeliveryContext(input: {
  request: Request;
  deliveryPolicy: DeliveryPolicySnapshot;
  allowUnsafeSafeExamBrowserUserAgentFallback?: boolean;
}): Promise<DeliveryContextEvaluation> {
  const deliveryContext = await evaluateDeliveryContext(input);
  if (!deliveryContext.allowed) {
    throw new DeliveryContextError(deliveryContext);
  }

  return deliveryContext;
}

export async function evaluateDeliveryContext(input: {
  request: Request;
  deliveryPolicy: DeliveryPolicySnapshot;
  allowUnsafeSafeExamBrowserUserAgentFallback?: boolean;
}): Promise<DeliveryContextEvaluation> {
  const mode = readDeliveryMode(input.request);
  const embedOrigin = mode === "iframe" ? readEmbedOrigin(input.request) : null;
  const userAgentSecureBrowserProvider = readSecureBrowserProvider(input.request);
  const safeExamBrowserProof = await evaluateSafeExamBrowserProof({
    request: input.request,
    policy: input.deliveryPolicy.safeExamBrowser,
    userAgentProvider: userAgentSecureBrowserProvider,
    allowUnsafeUserAgentFallback: input.allowUnsafeSafeExamBrowserUserAgentFallback,
  });
  const secureBrowserProvider = safeExamBrowserProof.provider ?? userAgentSecureBrowserProvider;
  const secureBrowserRequired = input.deliveryPolicy.secureBrowserRequired ?? false;
  const secureBrowserProviderHint =
    normalizeOptionalString(input.deliveryPolicy.secureBrowserProviderHint) ??
    secureBrowserProvider;
  const safeExamBrowserExpected =
    isSafeExamBrowserProvider(secureBrowserProviderHint) ||
    isSafeExamBrowserProvider(secureBrowserProvider) ||
    (input.deliveryPolicy.safeExamBrowser !== undefined &&
      input.deliveryPolicy.safeExamBrowser !== null);
  const unsupportedSecureBrowserProvider =
    secureBrowserProvider !== null &&
    !isSafeExamBrowserProvider(secureBrowserProvider) &&
    !safeExamBrowserProof.verified;

  const deliveryContext = createAllowedDeliveryContext({
    mode,
    embedOrigin,
    secureBrowserRequired,
    secureBrowserPresent: secureBrowserProvider !== null || safeExamBrowserProof.present,
    secureBrowserVerified: safeExamBrowserProof.verified,
    secureBrowserVerificationMethod: safeExamBrowserProof.method,
    secureBrowserProviderHint,
  });

  if (mode === "standalone" && input.deliveryPolicy.standaloneAllowed === false) {
    return {
      ...deliveryContext,
      allowed: false,
      blockedReason: "standalone_disallowed",
    };
  }

  if (mode === "iframe") {
    if (input.deliveryPolicy.iframeAllowed === false) {
      return {
        ...deliveryContext,
        allowed: false,
        blockedReason: "iframe_disallowed",
      };
    }

    const allowedOrigins = normalizeAllowedEmbedOrigins(input.deliveryPolicy.allowedEmbedOrigins);
    if (!embedOrigin || !allowedOrigins.includes(embedOrigin)) {
      return {
        ...deliveryContext,
        allowed: false,
        blockedReason: "embed_origin_not_allowed",
      };
    }
  }

  if (secureBrowserRequired && unsupportedSecureBrowserProvider) {
    return {
      ...deliveryContext,
      allowed: false,
      blockedReason: "secure_browser_key_mismatch",
    };
  }

  if (
    secureBrowserRequired &&
    safeExamBrowserExpected &&
    !safeExamBrowserProof.verified &&
    safeExamBrowserProof.method !== "user-agent-demo"
  ) {
    return {
      ...deliveryContext,
      allowed: false,
      blockedReason: safeExamBrowserProof.mismatch
        ? "secure_browser_key_mismatch"
        : "secure_browser_required",
    };
  }

  if (secureBrowserRequired && secureBrowserProvider === null) {
    return {
      ...deliveryContext,
      allowed: false,
      blockedReason: "secure_browser_required",
    };
  }

  return deliveryContext;
}

export function createDeliveryContextErrorResponse(error: DeliveryContextError): Response {
  return Response.json(
    {
      error: error.message,
      deliveryContext: error.deliveryContext,
    },
    { status: error.status },
  );
}

export function isDeliveryContextError(error: unknown): error is DeliveryContextError {
  return error instanceof DeliveryContextError;
}

function readDeliveryMode(request: Request): DeliveryContextMode {
  const url = new URL(request.url);
  const value = (
    request.headers.get(DELIVERY_CONTEXT_FRAME_MODE_HEADER) ??
    url.searchParams.get(DELIVERY_CONTEXT_MODE_QUERY_PARAM)
  )
    ?.trim()
    .toLowerCase();

  return value === "iframe" ? "iframe" : "standalone";
}

function readEmbedOrigin(request: Request): string | null {
  const url = new URL(request.url);
  const explicitOrigin = normalizeOrigin(
    request.headers.get(DELIVERY_CONTEXT_EMBED_ORIGIN_HEADER) ??
      url.searchParams.get(DELIVERY_CONTEXT_EMBED_ORIGIN_QUERY_PARAM),
  );
  if (explicitOrigin) {
    return explicitOrigin;
  }

  const originHeader = normalizeOrigin(request.headers.get("origin"));
  if (originHeader) {
    return originHeader;
  }

  const referrer = normalizeOptionalString(request.headers.get("referer"));
  if (!referrer) {
    return null;
  }

  try {
    return new URL(referrer).origin;
  } catch {
    return null;
  }
}

function readSecureBrowserProvider(request: Request): string | null {
  const url = new URL(request.url);
  const explicitProvider = normalizeOptionalString(
    request.headers.get(DELIVERY_CONTEXT_SECURE_BROWSER_PROVIDER_HEADER) ??
      url.searchParams.get(DELIVERY_CONTEXT_SECURE_BROWSER_PROVIDER_QUERY_PARAM),
  );
  if (explicitProvider) {
    return normalizeSafeExamBrowserProvider(explicitProvider) ?? explicitProvider;
  }

  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (userAgent.includes("safeexambrowser")) {
    return "safe-exam-browser";
  }

  return null;
}

function normalizeAllowedEmbedOrigins(origins: string[] | undefined): string[] {
  return (origins ?? [])
    .map((origin) => normalizeOrigin(origin))
    .filter((origin): origin is string => origin !== null);
}

function normalizeOrigin(value: string | null | undefined): string | null {
  const candidate = normalizeOptionalString(value);
  if (!candidate || candidate === "null") {
    return null;
  }

  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildBlockedContextMessage(deliveryContext: DeliveryContextEvaluation): string {
  switch (deliveryContext.blockedReason) {
    case "standalone_disallowed":
      return "This assessment cannot be launched outside an approved embedded delivery context.";
    case "iframe_disallowed":
      return "This assessment cannot be launched inside an embedded delivery context.";
    case "embed_origin_not_allowed":
      return "This embedded origin is not allowed for the pinned delivery policy.";
    case "secure_browser_required":
      return deliveryContext.secureBrowserProviderHint
        ? `This assessment requires ${deliveryContext.secureBrowserProviderHint}.`
        : "This assessment requires a secure browser.";
    case "secure_browser_key_mismatch":
      return deliveryContext.secureBrowserProviderHint
        ? `This assessment requires a verified ${deliveryContext.secureBrowserProviderHint} key.`
        : "This assessment requires a verified secure browser key.";
    default:
      return "This delivery context is not allowed for the pinned delivery policy.";
  }
}
