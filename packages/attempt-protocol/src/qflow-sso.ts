export const QFLOW_SSO_LAUNCH_TOKEN_ISSUER = "qflowlearn";
export const QFLOW_SSO_LAUNCH_TOKEN_AUDIENCE = "harbor:qflow-sso-launch";
export const QFLOW_SSO_LAUNCH_TOKEN_TTL_SECONDS = 5 * 60;

export interface QflowSsoLaunchTokenLearnerClaims {
  subject: string;
  displayName: string;
  email?: string | null;
}

export interface QflowSsoLaunchTokenClaims {
  iss: typeof QFLOW_SSO_LAUNCH_TOKEN_ISSUER;
  aud: typeof QFLOW_SSO_LAUNCH_TOKEN_AUDIENCE;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  qflowTenantId: string;
  assignmentId: string;
  learner: QflowSsoLaunchTokenLearnerClaims;
}
