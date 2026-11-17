import {
  createEmptyAttemptPolicyState,
  createDefaultAccommodationTimingEvidence,
  type AttemptAccommodationState,
  type AttemptAccommodationTimingEvidence,
  type EffectiveAccommodationSnapshot,
  type HarborAdditionalTestingTimeAccommodation,
  type HarborAccommodationProfileDefinition,
  type HarborShellAccommodationState,
  type HarborTestingTimeAllocationPolicy,
  isHarborQti3ColorTheme,
  readHarborAfaPnpSupport,
  mergeHarborAfaPnpEntitlements,
} from "@harbor/attempt-protocol";

type AssignmentLearnerOverrideLike = {
  id: string;
  accommodations: AttemptAccommodationState;
};

type ProfileRow = {
  assignment_id: string;
  profile_id: string;
  profile_json: string;
};

export async function resolveEffectiveAccommodationSnapshot(input: {
  db: D1Database;
  tenantId: string;
  learnerId: string;
  assignmentOverride?: AssignmentLearnerOverrideLike | null;
  now?: string;
}): Promise<EffectiveAccommodationSnapshot> {
  const now = input.now ?? new Date().toISOString();
  const rows = await input.db
    .prepare(
      "SELECT learner_accommodation_assignments.id AS assignment_id, accommodation_profiles.id AS profile_id, accommodation_profiles.profile_json FROM learner_accommodation_assignments INNER JOIN accommodation_profiles ON accommodation_profiles.id = learner_accommodation_assignments.profile_id AND accommodation_profiles.tenant_id = learner_accommodation_assignments.tenant_id WHERE learner_accommodation_assignments.tenant_id = ? AND learner_accommodation_assignments.learner_id = ? AND learner_accommodation_assignments.status = ? AND accommodation_profiles.status = ? AND learner_accommodation_assignments.effective_at <= ? AND (learner_accommodation_assignments.expires_at IS NULL OR learner_accommodation_assignments.expires_at > ?) ORDER BY learner_accommodation_assignments.effective_at ASC, learner_accommodation_assignments.id ASC",
    )
    .bind(input.tenantId, input.learnerId, "active", "active", now, now)
    .all<ProfileRow>();

  let accommodations = createEmptyAttemptPolicyState().accommodations;
  let shellTools: HarborShellAccommodationState = {};
  const profileIds: string[] = [];
  const learnerProfileAssignmentIds: string[] = [];

  for (const row of rows.results) {
    const profile = parseProfileDefinition(row.profile_json);
    accommodations = mergeAccommodations(accommodations, {
      rendererPnp: profile.rendererPnp ?? {},
      sessionControl: profile.sessionControl ?? {},
      pnpEntitlement: profile.pnpEntitlement ?? {},
      additionalTestingTime: profile.additionalTestingTime,
    });
    shellTools = mergeShellTools(shellTools, profile.shellTools ?? {});
    profileIds.push(row.profile_id);
    learnerProfileAssignmentIds.push(row.assignment_id);
  }

  if (input.assignmentOverride) {
    accommodations = mergeAccommodations(accommodations, input.assignmentOverride.accommodations);
  }

  return {
    profileIds,
    accommodations: {
      ...accommodations,
      shellTools,
    },
    shellTools,
    source: {
      learnerProfileAssignmentIds,
      assignmentOverrideId: input.assignmentOverride?.id ?? null,
    },
  };
}

export async function writeAttemptAccommodationSnapshot(input: {
  db: D1Database;
  attemptId: string;
  tenantId: string;
  learnerId?: string | null;
  assignmentId?: string | null;
  snapshot: EffectiveAccommodationSnapshot;
  timing?: AttemptAccommodationTimingEvidence;
  createdAt?: string;
}): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const timing = input.timing ?? createDefaultAccommodationTimingEvidence();
  await input.db
    .prepare(
      "INSERT INTO attempt_accommodation_snapshots (id, attempt_id, tenant_id, learner_id, assignment_id, profile_ids_json, learner_assignment_ids_json, assignment_override_id, accommodations_json, shell_tools_json, timing_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET profile_ids_json = excluded.profile_ids_json, learner_assignment_ids_json = excluded.learner_assignment_ids_json, assignment_override_id = excluded.assignment_override_id, accommodations_json = excluded.accommodations_json, shell_tools_json = excluded.shell_tools_json, timing_json = excluded.timing_json",
    )
    .bind(
      createId("accsnap"),
      input.attemptId,
      input.tenantId,
      input.learnerId ?? null,
      input.assignmentId ?? null,
      JSON.stringify(input.snapshot.profileIds),
      JSON.stringify(input.snapshot.source.learnerProfileAssignmentIds),
      input.snapshot.source.assignmentOverrideId ?? null,
      JSON.stringify(input.snapshot.accommodations),
      JSON.stringify(input.snapshot.shellTools),
      JSON.stringify(timing),
      createdAt,
    )
    .run();
}

function parseProfileDefinition(value: string): HarborAccommodationProfileDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return sanitizeProfileDefinition(parsed as Record<string, unknown>);
}

function sanitizeProfileDefinition(
  profile: Record<string, unknown>,
): HarborAccommodationProfileDefinition {
  const rendererPnp = readRecord(profile.rendererPnp);
  const sessionControl = readRecord(profile.sessionControl);
  const shellTools = readRecord(profile.shellTools);
  const pnpEntitlement = readRecord(profile.pnpEntitlement);
  const additionalTestingTime = readRecord(profile.additionalTestingTime);
  return {
    rendererPnp: rendererPnp ? sanitizeRendererPnp(rendererPnp) : undefined,
    sessionControl: sessionControl ? sanitizeSessionControl(sessionControl) : undefined,
    shellTools: shellTools ? sanitizeShellTools(shellTools) : undefined,
    pnpEntitlement: pnpEntitlement ? sanitizePnpEntitlement(pnpEntitlement) : undefined,
    additionalTestingTime: additionalTestingTime
      ? sanitizeAdditionalTestingTime(additionalTestingTime)
      : undefined,
  };
}

function sanitizeRendererPnp(
  value: Record<string, unknown>,
): AttemptAccommodationState["rendererPnp"] {
  const textAppearance = readRecord(value.textAppearance);
  const colorStyle = textAppearance?.colorStyle;
  return {
    ...(textAppearance && isHarborQti3ColorTheme(colorStyle)
      ? { textAppearance: { colorStyle } }
      : {}),
    ...(typeof value.glossaryOnScreen === "boolean"
      ? { glossaryOnScreen: value.glossaryOnScreen }
      : {}),
    ...(typeof value.keywordTranslationLanguage === "string"
      ? { keywordTranslationLanguage: value.keywordTranslationLanguage.trim() }
      : {}),
    ...(typeof value.extSbacGlossaryIllustration === "boolean"
      ? { extSbacGlossaryIllustration: value.extSbacGlossaryIllustration }
      : {}),
    ...(typeof value.layoutSingleColumn === "boolean"
      ? { layoutSingleColumn: value.layoutSingleColumn }
      : {}),
  };
}

function sanitizeSessionControl(
  value: Record<string, unknown>,
): AttemptAccommodationState["sessionControl"] {
  const timeLimits = readRecord(value.time_limits);
  return {
    ...(typeof value.allow_comment === "boolean" ? { allow_comment: value.allow_comment } : {}),
    ...(typeof value.allow_review === "boolean" ? { allow_review: value.allow_review } : {}),
    ...(typeof value.allow_skipping === "boolean" ? { allow_skipping: value.allow_skipping } : {}),
    ...(typeof value.max_attempts === "number" ? { max_attempts: value.max_attempts } : {}),
    ...(typeof value.show_feedback === "boolean" ? { show_feedback: value.show_feedback } : {}),
    ...(typeof value.show_solution === "boolean" ? { show_solution: value.show_solution } : {}),
    ...(typeof value.validate_responses === "boolean"
      ? { validate_responses: value.validate_responses }
      : {}),
    ...(timeLimits
      ? {
          time_limits: {
            ...(typeof timeLimits.min_time === "number" || timeLimits.min_time === null
              ? { min_time: timeLimits.min_time }
              : {}),
            ...(typeof timeLimits.max_time === "number" || timeLimits.max_time === null
              ? { max_time: timeLimits.max_time }
              : {}),
            ...(typeof timeLimits.allow_late_submission === "boolean"
              ? { allow_late_submission: timeLimits.allow_late_submission }
              : {}),
          },
        }
      : {}),
  };
}

function sanitizeShellTools(value: Record<string, unknown>): HarborShellAccommodationState {
  const calculator = value.calculator;
  return {
    ...(typeof value.textToSpeech === "boolean" ? { textToSpeech: value.textToSpeech } : {}),
    ...(typeof value.lineReader === "boolean" ? { lineReader: value.lineReader } : {}),
    ...(typeof value.answerMasking === "boolean" ? { answerMasking: value.answerMasking } : {}),
    ...(calculator === "none" || calculator === "basic" || calculator === "scientific"
      ? { calculator }
      : {}),
    ...(typeof value.notepad === "boolean" ? { notepad: value.notepad } : {}),
    ...(typeof value.captions === "boolean" ? { captions: value.captions } : {}),
    ...(typeof value.transcripts === "boolean" ? { transcripts: value.transcripts } : {}),
  };
}

function sanitizePnpEntitlement(
  value: Record<string, unknown>,
): AttemptAccommodationState["pnpEntitlement"] {
  return {
    ...sanitizePnpSupportSet(value.supports, "supports"),
    ...sanitizePnpSupportSet(value.activateAtInitializationSet, "activateAtInitializationSet"),
    ...sanitizePnpSupportSet(value.activateAsOptionSet, "activateAsOptionSet"),
    ...sanitizePnpSupportSet(value.prohibitSet, "prohibitSet"),
    ...(Array.isArray(value.languages)
      ? {
          languages: value.languages
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        }
      : {}),
  };
}

function sanitizeAdditionalTestingTime(
  value: Record<string, unknown>,
): HarborAdditionalTestingTimeAccommodation | undefined {
  const mode = value.mode;
  if (
    mode !== "none" &&
    mode !== "time-multiplier" &&
    mode !== "fixed-minutes" &&
    mode !== "unlimited"
  ) {
    return undefined;
  }

  const allocationPolicy = readAllocationPolicy(value.allocationPolicy);
  return {
    mode,
    ...(mode === "time-multiplier" &&
    typeof value.multiplier === "number" &&
    Number.isFinite(value.multiplier)
      ? { multiplier: Math.max(1, value.multiplier) }
      : {}),
    ...(mode === "fixed-minutes" &&
    typeof value.fixedMinutes === "number" &&
    Number.isFinite(value.fixedMinutes)
      ? { fixedMinutes: Math.max(0, value.fixedMinutes) }
      : {}),
    ...(allocationPolicy ? { allocationPolicy } : {}),
  };
}

function readAllocationPolicy(value: unknown): HarborTestingTimeAllocationPolicy | null {
  return value === "whole-assessment" || value === "even-split" || value === "proportional-split"
    ? value
    : null;
}

function sanitizePnpSupportSet(
  value: unknown,
  key: keyof NonNullable<AttemptAccommodationState["pnpEntitlement"]>,
): Partial<NonNullable<AttemptAccommodationState["pnpEntitlement"]>> {
  if (!Array.isArray(value)) {
    return {};
  }

  return {
    [key]: value.flatMap((entry) => {
      const support = readHarborAfaPnpSupport(entry);
      return support ? [support] : [];
    }),
  };
}

function mergeAccommodations(
  base: AttemptAccommodationState,
  override: AttemptAccommodationState,
): AttemptAccommodationState {
  const pnpEntitlement = mergeHarborAfaPnpEntitlements(
    base.pnpEntitlement,
    override.pnpEntitlement,
  );

  return {
    rendererPnp: {
      ...base.rendererPnp,
      ...override.rendererPnp,
      textAppearance: {
        ...(base.rendererPnp.textAppearance ?? {}),
        ...(override.rendererPnp.textAppearance ?? {}),
      },
    },
    sessionControl: {
      ...base.sessionControl,
      ...override.sessionControl,
      time_limits: {
        ...(base.sessionControl.time_limits ?? {}),
        ...(override.sessionControl.time_limits ?? {}),
      },
    },
    shellTools: {
      ...(base.shellTools ?? {}),
      ...(override.shellTools ?? {}),
    },
    ...(Object.keys(pnpEntitlement).length > 0 ? { pnpEntitlement } : {}),
    ...((override.additionalTestingTime ?? base.additionalTestingTime)
      ? {
          additionalTestingTime: override.additionalTestingTime ?? base.additionalTestingTime,
        }
      : {}),
  };
}

function mergeShellTools(
  base: HarborShellAccommodationState,
  override: HarborShellAccommodationState,
): HarborShellAccommodationState {
  return {
    ...base,
    ...override,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
