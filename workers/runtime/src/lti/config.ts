/** Environment values accepted by Harbor's canonical LTI secret parser. */
export interface HarborLtiSecretEnv {
  readonly LTI_STATE_SECRET?: string;
}

/** Returns the state secret reserved for lti-tool protocol state. */
export function readHarborLtiStateSecret(env: HarborLtiSecretEnv): string {
  const stateSecret = env.LTI_STATE_SECRET?.trim();
  if (!stateSecret) {
    throw new Error("LTI_STATE_SECRET is required");
  }
  return stateSecret;
}

export function readHarborLtiRegistrationLinkSecret(env: {
  readonly LTI_REGISTRATION_LINK_SECRET?: string;
}): string {
  const secret = env.LTI_REGISTRATION_LINK_SECRET?.trim();
  if (!secret) {
    throw new Error("LTI_REGISTRATION_LINK_SECRET is required");
  }
  return secret;
}
