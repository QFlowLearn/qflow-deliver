import {
  type AssignmentLearnerOverrideRecord,
  type AssignmentLearnerPolicyOverrides,
  type AssignmentPolicySnapshot,
  type DeliveryPolicySnapshot,
} from "@harbor/attempt-protocol";
import type { OverrideRow } from "./types";
import { parseAccommodations, parsePolicyOverrides } from "./json-parsers";

export async function readAssignmentLearnerOverride(
  db: D1Database,
  assignmentId: string,
  learnerId: string,
): Promise<AssignmentLearnerOverrideRecord | null> {
  const row = await db
    .prepare(
      "SELECT id, assignment_id, learner_id, policy_overrides_json, accommodations_json, created_by_role, created_by_id, created_by_display_name, updated_by_role, updated_by_id, updated_by_display_name, created_at, updated_at FROM assignment_learner_overrides WHERE assignment_id = ? AND learner_id = ?",
    )
    .bind(assignmentId, learnerId)
    .first<OverrideRow>();

  return row ? mapOverrideRow(row) : null;
}

export function applyAssignmentLearnerPolicyOverrides(
  base: AssignmentPolicySnapshot,
  overrides: AssignmentLearnerPolicyOverrides,
): AssignmentPolicySnapshot {
  return {
    ...base,
    maxAttempts: overrides.maxAttempts ?? base.maxAttempts,
    timeLimitSeconds:
      overrides.timeLimitSeconds !== undefined ? overrides.timeLimitSeconds : base.timeLimitSeconds,
    gracePeriodSeconds:
      overrides.gracePeriodSeconds !== undefined
        ? overrides.gracePeriodSeconds
        : base.gracePeriodSeconds,
    navigationMode: overrides.navigationMode ?? base.navigationMode,
    standaloneAllowed: overrides.standaloneAllowed ?? base.standaloneAllowed,
    iframeAllowed: overrides.iframeAllowed ?? base.iframeAllowed,
    allowedEmbedOrigins: overrides.allowedEmbedOrigins ?? base.allowedEmbedOrigins,
    secureBrowserRequired: overrides.secureBrowserRequired ?? base.secureBrowserRequired,
    secureBrowserProviderHint:
      overrides.secureBrowserProviderHint !== undefined
        ? overrides.secureBrowserProviderHint
        : base.secureBrowserProviderHint,
    safeExamBrowser:
      overrides.safeExamBrowser !== undefined ? overrides.safeExamBrowser : base.safeExamBrowser,
    proctoringProvider:
      overrides.proctoringProvider !== undefined
        ? overrides.proctoringProvider
        : base.proctoringProvider,
  };
}

export function applyLearnerOverrideToDeliveryPolicy(
  base: DeliveryPolicySnapshot,
  overrides: AssignmentLearnerPolicyOverrides,
): DeliveryPolicySnapshot {
  return {
    ...base,
    maxAttempts: overrides.maxAttempts ?? base.maxAttempts,
    timeLimitSeconds:
      overrides.timeLimitSeconds !== undefined ? overrides.timeLimitSeconds : base.timeLimitSeconds,
    gracePeriodSeconds:
      overrides.gracePeriodSeconds !== undefined
        ? overrides.gracePeriodSeconds
        : base.gracePeriodSeconds,
    navigationMode: overrides.navigationMode ?? base.navigationMode,
    standaloneAllowed: overrides.standaloneAllowed ?? base.standaloneAllowed,
    iframeAllowed: overrides.iframeAllowed ?? base.iframeAllowed,
    allowedEmbedOrigins: overrides.allowedEmbedOrigins ?? base.allowedEmbedOrigins,
    secureBrowserRequired: overrides.secureBrowserRequired ?? base.secureBrowserRequired,
    secureBrowserProviderHint:
      overrides.secureBrowserProviderHint !== undefined
        ? overrides.secureBrowserProviderHint
        : base.secureBrowserProviderHint,
    safeExamBrowser:
      overrides.safeExamBrowser !== undefined ? overrides.safeExamBrowser : base.safeExamBrowser,
  };
}

export function mapOverrideRow(row: OverrideRow): AssignmentLearnerOverrideRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    learnerId: row.learner_id,
    policyOverrides: parsePolicyOverrides(row.policy_overrides_json),
    accommodations: parseAccommodations(row.accommodations_json),
    createdBy: {
      role: row.created_by_role,
      actorId: row.created_by_id,
      displayName: row.created_by_display_name,
    },
    updatedBy: {
      role: row.updated_by_role,
      actorId: row.updated_by_id,
      displayName: row.updated_by_display_name,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
