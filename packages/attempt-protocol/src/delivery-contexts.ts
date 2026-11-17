export const DELIVERY_CONTEXT_MODES = ["standalone", "iframe"] as const;
export type DeliveryContextMode = (typeof DELIVERY_CONTEXT_MODES)[number];

export const DELIVERY_CONTEXT_BLOCKED_REASONS = [
  "standalone_disallowed",
  "iframe_disallowed",
  "embed_origin_not_allowed",
  "secure_browser_required",
  "secure_browser_key_mismatch",
] as const;

export type DeliveryContextBlockedReason = (typeof DELIVERY_CONTEXT_BLOCKED_REASONS)[number];

export interface DeliveryContextEvaluation {
  mode: DeliveryContextMode;
  allowed: boolean;
  embedOrigin: string | null;
  secureBrowserRequired: boolean;
  secureBrowserPresent: boolean;
  secureBrowserVerified: boolean;
  secureBrowserVerificationMethod: string | null;
  secureBrowserProviderHint: string | null;
  blockedReason: DeliveryContextBlockedReason | null;
}

export function createAllowedDeliveryContext(
  overrides: Partial<DeliveryContextEvaluation> = {},
): DeliveryContextEvaluation {
  return {
    mode: "standalone",
    allowed: true,
    embedOrigin: null,
    secureBrowserRequired: false,
    secureBrowserPresent: false,
    secureBrowserVerified: false,
    secureBrowserVerificationMethod: null,
    secureBrowserProviderHint: null,
    blockedReason: null,
    ...overrides,
  };
}
