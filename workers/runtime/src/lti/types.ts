import type { HarborLtiToolEnv } from "./tool";

export interface LtiRegistrationRow {
  id: string;
  tenant_id: string;
  issuer: string;
  client_id: string;
  deployment_id: string;
  authorization_endpoint: string;
  token_endpoint: string | null;
  jwks_url: string;
}

export interface HarborRegistrationPersistInput {
  registrationId: string;
  tenantId: string;
  issuer: string;
  clientId: string;
  deploymentId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUrl: string;
}

export type LtiEnv = HarborLtiToolEnv & {
  CONTENT_BUCKET: R2Bucket;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
};

export interface LtiResourceLinkRow {
  assignment_id: string;
  section_id: string | null;
  context_id: string | null;
}

export interface LtiDeepLinkPlacementRequest {
  assignmentId: string;
  sectionId: string | null;
  title: string | null;
  text: string | null;
  lineItem: {
    label: string | null;
    scoreMaximum: number;
    tag: string | null;
  } | null;
}

export interface LtiDeepLinkPlacementRow {
  assignment_id: string;
  section_id: string | null;
  context_id: string | null;
}

export const HARBOR_LTI_PLACEMENT_KEY = "harbor_deep_link_placement_key";
export const HARBOR_LTI_ASSIGNMENT_ID = "harbor_assignment_id";
export const HARBOR_LTI_SECTION_ID = "harbor_section_id";
