import type { StaffActorRole } from "./staff";
import type { AttemptStatus, BootstrapTimingState } from "./bootstrap";
import type {
  HarborAdditionalTestingTimeAccommodation,
  HarborQti3ColorTheme,
  HarborShellAccommodationState,
  HarborTestingTimeAllocationPolicy,
  RendererPnpAccommodation,
  RendererSessionControlAccommodation,
} from "./accommodation-types";
import {
  HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
  resolveHarborAfaPnpEntitlement,
  type HarborAfaPnpEntitlement,
} from "./pnp-policy";

export * from "./accommodation-types";
export * from "./pnp-policy";

export const ATTEMPT_POLICY_PATH_TEMPLATE = "/api/attempts/:attemptId/policy";
export const INTERNAL_ATTEMPT_POLICY_PATH_TEMPLATE = "/internal/attempts/:attemptId/policy";

export const ATTEMPT_POLICY_COMMAND_TYPES = [
  "transfer-workstation",
  "extend-time",
  "reopen-attempt",
  "post-operator-message",
  "set-accommodations",
] as const;

export type AttemptPolicyCommandType = (typeof ATTEMPT_POLICY_COMMAND_TYPES)[number];

export type AttemptPolicyActorRole = "operator" | "instructor" | "system" | StaffActorRole;
export type AttemptOperatorMessageLevel = "info" | "warning" | "critical";
export type AttemptReopenStatus = "closed" | "reopened";

export interface AttemptPolicyActorIdentity {
  role: AttemptPolicyActorRole;
  actorId: string;
  displayName: string | null;
}

export interface AttemptAccommodationState {
  rendererPnp: RendererPnpAccommodation;
  sessionControl: RendererSessionControlAccommodation;
  shellTools?: HarborShellAccommodationState;
  pnpEntitlement?: HarborAfaPnpEntitlement;
  additionalTestingTime?: HarborAdditionalTestingTimeAccommodation;
}

export interface HarborAccommodationProfileDefinition {
  rendererPnp?: RendererPnpAccommodation;
  sessionControl?: RendererSessionControlAccommodation;
  shellTools?: HarborShellAccommodationState;
  pnpEntitlement?: HarborAfaPnpEntitlement;
  additionalTestingTime?: HarborAdditionalTestingTimeAccommodation;
}

export interface EffectiveAccommodationSnapshot {
  profileIds: string[];
  accommodations: AttemptAccommodationState;
  shellTools: HarborShellAccommodationState;
  source: {
    learnerProfileAssignmentIds: string[];
    assignmentOverrideId?: string | null;
  };
}

export interface AttemptAccommodationTimingEvidence {
  additionalTimeSeconds: number;
  effectiveTimeLimitSeconds: number | null;
  unlimited: boolean;
  additionalTestingTime: HarborAdditionalTestingTimeAccommodation | null;
  allocationPolicy: HarborTestingTimeAllocationPolicy | null;
}

export interface AttemptAccommodationEvidenceSummary {
  profileIds: string[];
  learnerProfileAssignmentIds: string[];
  assignmentOverrideId: string | null;
  pnp: string[];
  shellTools: string[];
  extraTimeSeconds: number;
  effectiveTimeLimitSeconds: number | null;
  colorTheme: HarborQti3ColorTheme | null;
  masking: boolean;
  ttsReadAloud: boolean;
  captions: boolean;
  transcripts: boolean;
  calculator: NonNullable<HarborShellAccommodationState["calculator"]>;
  notes: boolean;
}

export function createDefaultAccommodationTimingEvidence(): AttemptAccommodationTimingEvidence {
  return {
    additionalTimeSeconds: 0,
    effectiveTimeLimitSeconds: null,
    unlimited: false,
    additionalTestingTime: null,
    allocationPolicy: null,
  };
}

export function resolveAccommodationTimingEvidence(input: {
  baseTimeLimitSeconds: number | null;
  policyAdditionalTimeSeconds?: number | null;
  accommodations?: AttemptAccommodationState | null;
}): AttemptAccommodationTimingEvidence {
  const baseTimeLimitSeconds = input.baseTimeLimitSeconds;
  const policyAdditionalTimeSeconds = Math.max(
    0,
    Math.round(input.policyAdditionalTimeSeconds ?? 0),
  );
  const additionalTestingTime =
    input.accommodations?.additionalTestingTime &&
    input.accommodations.additionalTestingTime.mode !== "none"
      ? input.accommodations.additionalTestingTime
      : null;

  if (additionalTestingTime?.mode === "unlimited") {
    return {
      additionalTimeSeconds: policyAdditionalTimeSeconds,
      effectiveTimeLimitSeconds: null,
      unlimited: true,
      additionalTestingTime,
      allocationPolicy: additionalTestingTime.allocationPolicy ?? "whole-assessment",
    };
  }

  const pnpAdditionalTimeSeconds =
    baseTimeLimitSeconds === null
      ? 0
      : resolveAdditionalTestingTimeSeconds(baseTimeLimitSeconds, additionalTestingTime);
  const additionalTimeSeconds = policyAdditionalTimeSeconds + pnpAdditionalTimeSeconds;

  return {
    additionalTimeSeconds,
    effectiveTimeLimitSeconds:
      baseTimeLimitSeconds === null ? null : baseTimeLimitSeconds + additionalTimeSeconds,
    unlimited: baseTimeLimitSeconds === null,
    additionalTestingTime,
    allocationPolicy: additionalTestingTime?.allocationPolicy ?? null,
  };
}

function resolveAdditionalTestingTimeSeconds(
  baseTimeLimitSeconds: number,
  additionalTestingTime: HarborAdditionalTestingTimeAccommodation | null,
): number {
  if (!additionalTestingTime) {
    return 0;
  }

  if (additionalTestingTime.mode === "time-multiplier") {
    return Math.max(
      0,
      Math.round(
        baseTimeLimitSeconds * Math.max(1, additionalTestingTime.multiplier ?? 1) -
          baseTimeLimitSeconds,
      ),
    );
  }

  if (additionalTestingTime.mode === "fixed-minutes") {
    return Math.max(0, Math.round((additionalTestingTime.fixedMinutes ?? 0) * 60));
  }

  return 0;
}

export function buildAttemptAccommodationEvidenceSummary(input: {
  profileIds: string[];
  learnerProfileAssignmentIds: string[];
  assignmentOverrideId?: string | null;
  accommodations: AttemptAccommodationState;
  shellTools?: HarborShellAccommodationState;
  timing?: AttemptAccommodationTimingEvidence;
}): AttemptAccommodationEvidenceSummary {
  const rendererPnp = input.accommodations.rendererPnp ?? {};
  const sessionControl = input.accommodations.sessionControl ?? {};
  const shellTools = {
    ...input.accommodations.shellTools,
    ...input.shellTools,
  };
  const colorTheme = rendererPnp.textAppearance?.colorStyle ?? null;
  const timing = input.timing ?? createDefaultAccommodationTimingEvidence();

  return {
    profileIds: input.profileIds,
    learnerProfileAssignmentIds: input.learnerProfileAssignmentIds,
    assignmentOverrideId: input.assignmentOverrideId ?? null,
    pnp: [
      ...buildPnpEvidenceLabels(rendererPnp, sessionControl),
      ...buildAdditionalTestingTimeEvidenceLabels(input.accommodations.additionalTestingTime),
      ...buildPnpEntitlementEvidenceLabels(input.accommodations.pnpEntitlement),
    ],
    shellTools: buildShellToolEvidenceLabels(shellTools),
    extraTimeSeconds: Math.max(0, timing.additionalTimeSeconds),
    effectiveTimeLimitSeconds: timing.effectiveTimeLimitSeconds,
    colorTheme,
    masking: shellTools.answerMasking === true,
    ttsReadAloud: shellTools.textToSpeech === true,
    captions: shellTools.captions === true,
    transcripts: shellTools.transcripts === true,
    calculator: shellTools.calculator ?? "none",
    notes: shellTools.notepad === true,
  };
}

export interface AttemptPolicyTimingState {
  additionalTimeSeconds: number;
  effectiveTimeLimitSeconds: number | null;
  effectiveSoftCloseAt: string | null;
  effectiveAcceptUntil: string | null;
}

export interface AttemptPolicyReopenState {
  status: AttemptReopenStatus;
  reopenedAt: string | null;
  reopenUntil: string | null;
}

export interface AttemptOperatorMessageState {
  messageId: string;
  level: AttemptOperatorMessageLevel;
  title: string;
  body: string;
  postedAt: string;
  effectiveUntil: string | null;
}

export interface AttemptPolicyState {
  overlayRevision: number;
  timing: AttemptPolicyTimingState;
  reopen: AttemptPolicyReopenState;
  operatorMessage: AttemptOperatorMessageState | null;
  accommodations: AttemptAccommodationState;
}

export function createEmptyAttemptPolicyState(): AttemptPolicyState {
  return {
    overlayRevision: 0,
    timing: {
      additionalTimeSeconds: 0,
      effectiveTimeLimitSeconds: null,
      effectiveSoftCloseAt: null,
      effectiveAcceptUntil: null,
    },
    reopen: {
      status: "closed",
      reopenedAt: null,
      reopenUntil: null,
    },
    operatorMessage: null,
    accommodations: {
      rendererPnp: {},
      sessionControl: {},
      shellTools: {},
    },
  };
}

function buildPnpEvidenceLabels(
  rendererPnp: RendererPnpAccommodation,
  sessionControl: RendererSessionControlAccommodation,
): string[] {
  const labels: string[] = [];
  if (rendererPnp.textAppearance?.colorStyle) {
    labels.push("color-theme");
  }
  if (rendererPnp.glossaryOnScreen === true) {
    labels.push(HARBOR_GLOSSARY_ON_SCREEN_SUPPORT);
  }
  if (rendererPnp.keywordTranslationLanguage) {
    labels.push(`keyword-translation:${rendererPnp.keywordTranslationLanguage}`);
  }
  if (rendererPnp.extSbacGlossaryIllustration === true) {
    labels.push("glossary-illustration");
  }
  if (rendererPnp.layoutSingleColumn === true) {
    labels.push("layout-single-column");
  }
  if (sessionControl.allow_comment === true) {
    labels.push("comments-allowed");
  }
  if (sessionControl.allow_review === false) {
    labels.push("review-disabled");
  }
  if (sessionControl.allow_skipping === false) {
    labels.push("skipping-disabled");
  }
  if (sessionControl.show_feedback === true) {
    labels.push("feedback-visible");
  }
  if (sessionControl.show_solution === true) {
    labels.push("solution-visible");
  }
  if (sessionControl.validate_responses === true) {
    labels.push("response-validation");
  }
  if (sessionControl.time_limits?.max_time !== undefined) {
    labels.push(`renderer-max-time:${sessionControl.time_limits.max_time ?? "none"}`);
  }
  if (sessionControl.time_limits?.allow_late_submission === true) {
    labels.push("late-submission-allowed");
  }
  return labels;
}

function buildAdditionalTestingTimeEvidenceLabels(
  additionalTestingTime: HarborAdditionalTestingTimeAccommodation | undefined,
): string[] {
  if (!additionalTestingTime || additionalTestingTime.mode === "none") {
    return [];
  }

  const labels = [`additional-testing-time:${additionalTestingTime.mode}`];
  if (additionalTestingTime.mode === "time-multiplier") {
    labels.push(`time-multiplier:${additionalTestingTime.multiplier ?? 1}`);
  }
  if (additionalTestingTime.mode === "fixed-minutes") {
    labels.push(`fixed-minutes:${additionalTestingTime.fixedMinutes ?? 0}`);
  }
  if (additionalTestingTime.allocationPolicy) {
    labels.push(`time-allocation:${additionalTestingTime.allocationPolicy}`);
  }
  return labels;
}

function buildPnpEntitlementEvidenceLabels(
  entitlement: HarborAfaPnpEntitlement | undefined,
): string[] {
  const effectiveSupports =
    resolveHarborAfaPnpEntitlement({
      pnpEntitlement: entitlement,
    }).supports ?? [];
  const labels = effectiveSupports.map((support) => `pnp-support:${support}`);
  if (entitlement?.prohibitSet) {
    labels.push(...entitlement.prohibitSet.map((support) => `pnp-prohibit:${support}`));
  }
  if (entitlement?.languages) {
    labels.push(...entitlement.languages.map((language) => `pnp-language:${language}`));
  }
  return labels;
}

function buildShellToolEvidenceLabels(shellTools: HarborShellAccommodationState): string[] {
  const labels: string[] = [];
  if (shellTools.textToSpeech === true) {
    labels.push("spoken");
  }
  if (shellTools.lineReader === true) {
    labels.push("line-reader");
  }
  if (shellTools.answerMasking === true) {
    labels.push("answer-masking");
  }
  if (shellTools.calculator && shellTools.calculator !== "none") {
    labels.push(`${shellTools.calculator}-calculator`);
  }
  if (shellTools.notepad === true) {
    labels.push("note-taking-on-screen");
  }
  if (shellTools.captions === true) {
    labels.push("captions");
  }
  if (shellTools.transcripts === true) {
    labels.push("transcripts");
  }
  return labels;
}

interface AttemptPolicyCommandBase<TType extends AttemptPolicyCommandType> {
  commandId: string;
  type: TType;
  actor: AttemptPolicyActorIdentity;
  reason: string;
  issuedAt: string;
  effectiveAt: string;
}

export interface ExtendTimePolicyCommand extends AttemptPolicyCommandBase<"extend-time"> {
  additionalTimeSeconds: number;
}

export interface ReopenAttemptPolicyCommand extends AttemptPolicyCommandBase<"reopen-attempt"> {
  reopenUntil: string | null;
}

export interface PostOperatorMessagePayload {
  level: AttemptOperatorMessageLevel;
  title: string;
  body: string;
  effectiveUntil: string | null;
}

export interface PostOperatorMessagePolicyCommand extends AttemptPolicyCommandBase<"post-operator-message"> {
  message: PostOperatorMessagePayload;
}

export interface SetAccommodationsPolicyCommand extends AttemptPolicyCommandBase<"set-accommodations"> {
  accommodations: AttemptAccommodationState;
}

/** Transfer to the replacement workstation explicitly authorized by exam supervision. */
export interface TransferWorkstationPolicyCommand extends AttemptPolicyCommandBase<"transfer-workstation"> {
  clientSessionId: string;
}

export type AttemptPolicyCommand =
  | TransferWorkstationPolicyCommand
  | ExtendTimePolicyCommand
  | ReopenAttemptPolicyCommand
  | PostOperatorMessagePolicyCommand
  | SetAccommodationsPolicyCommand;

export interface AttemptPolicyReadResponse {
  attemptId: string;
  attemptStatus: AttemptStatus;
  timing: BootstrapTimingState;
  policy: AttemptPolicyState;
}
