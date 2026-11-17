import { importJWK, SignJWT } from "jose";
import { vi } from "vitest";

export const PLATFORM_PRIVATE_JWK = {
  kty: "EC",
  x: "mi9xmm1TKc3uXIScOiQJmGp0iOrty6TiAkWu0XBJQ80",
  y: "oYmJp1NRUafGLAB23ZtZaFIHl2rGop2ZXc6rwP_fN9s",
  crv: "P-256",
  d: "8sGcrYlcpc7XTMeOduRhR5zhavBUttH2bVtU1yZt-wE",
  alg: "ES256",
  use: "sig",
  kid: "platform-test-1",
} as const;

export const PLATFORM_PUBLIC_JWK = {
  kty: "EC",
  x: "mi9xmm1TKc3uXIScOiQJmGp0iOrty6TiAkWu0XBJQ80",
  y: "oYmJp1NRUafGLAB23ZtZaFIHl2rGop2ZXc6rwP_fN9s",
  crv: "P-256",
  alg: "ES256",
  use: "sig",
  kid: "platform-test-1",
} as const;

export function stubPlatformJwksFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      if (requestUrl === "https://platform.harbor.test/jwks") {
        return Response.json({ keys: [PLATFORM_PUBLIC_JWK] });
      }

      return new Response("not found", { status: 404 });
    }),
  );
}

export function extractAuthorizeParams(location: string | null): {
  state: string;
  nonce: string;
  login_hint: string;
  redirect_uri: string;
} {
  if (!location) {
    throw new Error("LTI authorization redirect location is required");
  }
  const authorizeUrl = new URL(location, "https://harbor.local");
  const state = authorizeUrl.searchParams.get("state");
  const nonce = authorizeUrl.searchParams.get("nonce");
  const loginHint = authorizeUrl.searchParams.get("login_hint");
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");

  if (!state || !nonce || !loginHint || !redirectUri) {
    throw new Error("LTI authorization redirect is missing required parameters");
  }

  return {
    state,
    nonce,
    login_hint: loginHint,
    redirect_uri: redirectUri,
  };
}

export function extractDeepLinkingJwt(html: string): string {
  const match = html.match(/name="JWT" value="([^"]+)"/u);
  if (!match) {
    throw new Error("deep linking JWT input not found");
  }

  return match[1];
}

export async function issueSignedIdToken(input: {
  issuer: string;
  audience: string | string[];
  subject: string;
  nonce: string;
  deploymentId: string;
  targetLinkUri: string;
  resourceLinkId: string;
  contextId?: string | null;
  displayName?: string;
  email?: string | null;
  ags?: {
    lineitem?: string;
    lineitems?: string;
    scopes?: string[];
  };
  nrps?: {
    membershipUrl?: string;
    versions?: string[];
  };
  custom?: Record<string, string>;
}): Promise<string> {
  const key = await importJWK(PLATFORM_PRIVATE_JWK, "ES256");
  return new SignJWT({
    nonce: input.nonce,
    given_name: "Taylor",
    family_name: "LTI",
    name: input.displayName ?? "Taylor LTI",
    email: input.email ?? "taylor.lti@example.edu",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": input.deploymentId,
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": input.targetLinkUri,
    "https://purl.imsglobal.org/spec/lti/claim/roles": [
      "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
    ],
    "https://purl.imsglobal.org/spec/lti/claim/resource_link": {
      id: input.resourceLinkId,
    },
    ...(input.custom
      ? {
          "https://purl.imsglobal.org/spec/lti/claim/custom": input.custom,
        }
      : {}),
    ...(input.ags?.lineitem || input.ags?.lineitems
      ? {
          "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint": {
            scope: input.ags.scopes ?? ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
            ...(input.ags.lineitem ? { lineitem: input.ags.lineitem } : {}),
            ...(input.ags.lineitems ? { lineitems: input.ags.lineitems } : {}),
          },
        }
      : {}),
    ...(input.nrps?.membershipUrl
      ? {
          "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice": {
            context_memberships_url: input.nrps.membershipUrl,
            service_versions: input.nrps.versions ?? ["2.0"],
          },
        }
      : {}),
    ...(input.contextId
      ? {
          "https://purl.imsglobal.org/spec/lti/claim/context": {
            id: input.contextId,
          },
        }
      : {}),
  })
    .setProtectedHeader({ alg: "ES256", kid: "platform-test-1" })
    .setIssuedAt()
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setExpirationTime("5m")
    .sign(key);
}

export async function issueSignedDeepLinkingIdToken(input: {
  issuer: string;
  audience: string;
  subject: string;
  nonce: string;
  deploymentId: string;
  targetLinkUri: string;
  returnUrl: string;
  roles?: string[];
}): Promise<string> {
  const key = await importJWK(PLATFORM_PRIVATE_JWK, "ES256");
  return new SignJWT({
    nonce: input.nonce,
    given_name: "Dana",
    family_name: "Instructor",
    name: "Dana Instructor",
    email: "dana.instructor@example.edu",
    "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingRequest",
    "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": input.deploymentId,
    "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": input.targetLinkUri,
    "https://purl.imsglobal.org/spec/lti/claim/roles": input.roles ?? [
      "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
    ],
    "https://purl.imsglobal.org/spec/lti/claim/context": {
      id: "context-deep-linking",
      label: "BIO 101",
      title: "Biology 101",
    },
    "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings": {
      deep_link_return_url: input.returnUrl,
      accept_types: ["ltiResourceLink"],
      accept_presentation_document_targets: ["iframe", "window"],
      accept_multiple: false,
      auto_create: true,
      data: "opaque-platform-data",
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: "platform-test-1" })
    .setIssuedAt()
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setExpirationTime("5m")
    .sign(key);
}
