import {
  importLtiToolKeyPairFromJwk,
  LtiDynamicRegistration,
  type LtiToolKeyMaterial,
  LTITool,
} from "@longsightgroup/lti-tool";
// drizzle-orm is a direct dependency because @longsightgroup/lti-tool/storage/d1
// resolves D1Storage against drizzle types at runtime in the Worker bundle.
import { D1Storage } from "@longsightgroup/lti-tool/storage/d1";
import { readHarborLtiStateSecret } from "./config";

export interface HarborLtiToolEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET: string;
  LTI_STATE_SECRET?: string;
  LTI_TOOL_PRIVATE_KEY_JWK: string;
  HARBOR_PUBLIC_ORIGIN?: string;
}

interface HarborLtiCore {
  storage: D1Storage;
  ltiTool: LTITool;
}

interface HarborLtiTenantComposition {
  readonly storage: D1Storage;
  readonly keyMaterial: LtiToolKeyMaterial;
  readonly stateSecret: Uint8Array;
}

let importedKeyMaterial: Promise<LtiToolKeyMaterial> | null = null;
let importedKeySource: string | null = null;

export function readHarborLtiPublicOrigin(env: HarborLtiToolEnv): string {
  const configuredOrigin = env.HARBOR_PUBLIC_ORIGIN?.trim();
  if (!configuredOrigin) {
    throw new Error("HARBOR_PUBLIC_ORIGIN is required for LTI dynamic registration");
  }

  const url = new URL(configuredOrigin);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("HARBOR_PUBLIC_ORIGIN must be an HTTP origin without a path");
  }

  return url.origin;
}

export async function getHarborLtiCore(
  env: HarborLtiToolEnv,
  tenantId: string,
): Promise<HarborLtiCore> {
  const composition = await createHarborLtiTenantComposition(env, tenantId);
  return {
    storage: composition.storage,
    ltiTool: new LTITool({
      stateSecret: composition.stateSecret,
      keyPair: composition.keyMaterial.keyPair,
      security: {
        keyId: composition.keyMaterial.keyId,
      },
      storage: composition.storage,
    }),
  };
}

export async function getHarborLtiTool(env: HarborLtiToolEnv, tenantId: string): Promise<LTITool> {
  return (await getHarborLtiCore(env, tenantId)).ltiTool;
}

export async function getHarborLtiDynamicRegistration(
  env: HarborLtiToolEnv,
  tenantId: string,
): Promise<LtiDynamicRegistration> {
  const composition = await createHarborLtiTenantComposition(env, tenantId);
  const origin = readHarborLtiPublicOrigin(env);

  return new LtiDynamicRegistration({
    stateSecret: composition.stateSecret,
    keyPair: composition.keyMaterial.keyPair,
    security: {
      keyId: composition.keyMaterial.keyId,
    },
    storage: composition.storage,
    dynamicRegistration: buildDynamicRegistrationConfig(origin),
  });
}

export async function getHarborLtiPublicJwks(env: HarborLtiToolEnv) {
  return { keys: [(await getKeyMaterial(env)).publicJwk] };
}

function buildDynamicRegistrationConfig(origin: string) {
  return {
    url: origin,
    name: "QFlowLearn Delivery",
    description: "Cloudflare-native assessment delivery",
    loginUri: `${origin}/api/lti/login`,
    launchUri: `${origin}/api/lti/launch`,
    jwksUri: `${origin}/api/lti/jwks`,
    deepLinkingUri: `${origin}/api/lti/deep-linking`,
  };
}

async function createHarborLtiTenantComposition(
  env: HarborLtiToolEnv,
  tenantId: string,
): Promise<HarborLtiTenantComposition> {
  return {
    storage: new D1Storage({ database: env.HARBOR_DB, tenantId }),
    keyMaterial: await getKeyMaterial(env),
    stateSecret: new TextEncoder().encode(readHarborLtiStateSecret(env)),
  };
}

function getKeyMaterial(env: HarborLtiToolEnv): Promise<LtiToolKeyMaterial> {
  const keyJwk = readRequiredPrivateKeyJwk(env);
  if (!importedKeyMaterial || importedKeySource !== keyJwk) {
    importedKeySource = keyJwk;
    importedKeyMaterial = importLtiToolKeyPairFromJwk(keyJwk);
  }

  return importedKeyMaterial;
}

function readRequiredPrivateKeyJwk(env: HarborLtiToolEnv): string {
  const keyJwk = env.LTI_TOOL_PRIVATE_KEY_JWK?.trim();
  if (!keyJwk) {
    throw new Error("LTI_TOOL_PRIVATE_KEY_JWK is required");
  }

  return keyJwk;
}
