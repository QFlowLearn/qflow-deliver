import { describe, expect, it } from "vitest";

import { readHarborLtiRegistrationLinkSecret } from "../src/lti/config";
import {
  createHarborLtiRegistrationPath,
  readHarborLtiRegistrationTenantId,
} from "../src/lti/registration-link";

describe("Harbor LTI registration links", () => {
  it("uses the dedicated normalized registration-link secret", async () => {
    const env = {
      LTI_REGISTRATION_LINK_SECRET: " registration-secret ",
    };

    expect(readHarborLtiRegistrationLinkSecret(env)).toBe("registration-secret");
    const path = await createHarborLtiRegistrationPath(env, "tenant_a");
    const registrationCode = path.slice("/api/lti/register/".length);

    await expect(readHarborLtiRegistrationTenantId(env, registrationCode)).resolves.toBe(
      "tenant_a",
    );
  });

  it("does not accept the LTI state secret for registration links", async () => {
    const misconfiguredEnv = {
      LTI_STATE_SECRET: "protocol-state-secret",
    } as never;

    await expect(createHarborLtiRegistrationPath(misconfiguredEnv, "tenant_a")).rejects.toThrow(
      "LTI_REGISTRATION_LINK_SECRET is required",
    );
    await expect(
      readHarborLtiRegistrationTenantId(misconfiguredEnv, "payload.signature"),
    ).rejects.toThrow("LTI_REGISTRATION_LINK_SECRET is required");
  });
});
