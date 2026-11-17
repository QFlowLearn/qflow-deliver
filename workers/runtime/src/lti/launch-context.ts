import type { LTISession } from "@longsightgroup/lti-tool";

import type { LtiRegistrationRow } from "./types";

/** Verified launch context produced once at verify/bind and reused through Harbor entry flows. */
export interface VerifiedLtiLaunch {
  readonly ltiSession: LTISession;
  readonly registration: LtiRegistrationRow;
}
