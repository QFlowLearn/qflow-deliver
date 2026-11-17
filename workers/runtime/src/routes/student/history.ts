import { summarizeStagedAssessment, type AttemptVariableSnapshot } from "@harbor/attempt-protocol";
import type {
  AssignmentHistoryResponse,
  AssignmentHistoryAttemptSummary,
  AttemptSubmissionSummary,
  AttemptResultStatus,
  AuthoritativeAttemptSessionState,
} from "@harbor/attempt-protocol";
import { HARBOR_MANUAL_FEEDBACK_OUTCOME_IDENTIFIER } from "@harbor/attempt-protocol";

import { ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER } from "../../attempts/attempt-durable-object";
import { readLatestScoreRevisionsByResultId } from "../../results/score-amendments";
import type { AppContext } from "../hono-utils";
import { readAttemptIdParam } from "../route-params";

interface HistoryEnv {
  HARBOR_DB: D1Database;
  ATTEMPT_COORDINATOR: DurableObjectNamespace;
}

class AttemptHistoryRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface AttemptHistoryContextRow {
  id: string;
  assignment_id: string | null;
  assignment_title: string | null;
  assessment_id: string;
  assessment_version_id: string;
  assessment_title: string;
  actor_kind: string;
  actor_id: string | null;
  actor_display_name: string | null;
}

interface AttemptHistoryCandidateRow {
  id: string;
  assessment_version_id: string;
  created_at: string;
}

export async function handleAttemptHistoryRequest(c: AppContext): Promise<Response> {
  return readAttemptHistory({
    env: c.env,
    attemptId: readAttemptIdParam(c),
  });
}

export async function readAttemptHistory(input: {
  env: HistoryEnv;
  attemptId: string;
}): Promise<Response> {
  const context = await loadHistoryContext(input.env.HARBOR_DB, input.attemptId);
  const candidates = await loadHistoryCandidates(input.env.HARBOR_DB, context);
  const authoritativeAttempts = await loadAuthoritativeHistoryAttempts(
    input.env.HARBOR_DB,
    candidates,
  );

  const attempts = (
    await Promise.all(
      candidates.map(async (candidate) => {
        const authoritative = authoritativeAttempts.get(candidate.id);
        if (authoritative) {
          return authoritative;
        }

        return loadHistoryAttempt(input.env.ATTEMPT_COORDINATOR, candidate);
      }),
    )
  )
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));

  const payload: AssignmentHistoryResponse = {
    attemptId: input.attemptId,
    assignmentId: context.assignment_id,
    assessment: {
      id: context.assessment_id,
      title: context.assessment_title,
      assessmentVersionId: context.assessment_version_id,
      assignmentTitle: context.assignment_title,
    },
    actor: {
      kind: context.actor_kind,
      id: context.actor_id,
      displayName: context.actor_display_name,
      learnerId: context.actor_kind === "student-learner" ? context.actor_id : null,
    },
    attempts,
  };

  return Response.json(payload, { status: 200 });
}

async function loadHistoryContext(
  db: D1Database,
  attemptId: string,
): Promise<AttemptHistoryContextRow> {
  const row = await db
    .prepare(
      "SELECT attempts.id, attempts.assignment_id, assignments.title AS assignment_title, versions.assessment_id, attempts.assessment_version_id, assessments.title AS assessment_title, attempts.actor_kind, attempts.actor_id, attempts.actor_display_name FROM attempt_entries attempts INNER JOIN assessment_versions versions ON versions.id = attempts.assessment_version_id INNER JOIN assessments ON assessments.id = versions.assessment_id LEFT JOIN assignments ON assignments.id = attempts.assignment_id WHERE attempts.id = ?",
    )
    .bind(attemptId)
    .first<AttemptHistoryContextRow>();

  if (!row) {
    throw new AttemptHistoryRequestError(404, "Attempt entry not found");
  }

  return row;
}

async function loadHistoryCandidates(
  db: D1Database,
  context: AttemptHistoryContextRow,
): Promise<AttemptHistoryCandidateRow[]> {
  const queryParts = [
    "SELECT attempts.id, attempts.assessment_version_id, attempts.created_at",
    "FROM attempt_entries attempts",
  ];
  const bindings: Array<string> = [];

  if (context.assignment_id && context.actor_kind === "student-learner" && context.actor_id) {
    queryParts.push("WHERE attempts.assignment_id = ?");
    queryParts.push("AND attempts.actor_kind = ?");
    queryParts.push("AND attempts.actor_id = ?");
    bindings.push(context.assignment_id, context.actor_kind, context.actor_id);
  } else {
    queryParts.push(
      "INNER JOIN assessment_versions versions ON versions.id = attempts.assessment_version_id",
    );
    queryParts.push("WHERE versions.assessment_id = ?");
    queryParts.push("AND attempts.actor_kind = ?");
    bindings.push(context.assessment_id, context.actor_kind);

    if (context.actor_id) {
      queryParts.push("AND attempts.actor_id = ?");
      bindings.push(context.actor_id);
    } else {
      queryParts.push("AND attempts.actor_id IS NULL");
      if (context.actor_display_name) {
        queryParts.push("AND attempts.actor_display_name = ?");
        bindings.push(context.actor_display_name);
      } else {
        queryParts.push("AND attempts.actor_display_name IS NULL");
      }
    }
  }

  queryParts.push("ORDER BY attempts.created_at DESC");
  queryParts.push("LIMIT 20");

  const result = await db
    .prepare(queryParts.join(" "))
    .bind(...bindings)
    .all<AttemptHistoryCandidateRow>();

  return result.results;
}

async function loadAuthoritativeHistoryAttempts(
  db: D1Database,
  candidates: AttemptHistoryCandidateRow[],
): Promise<Map<string, AssignmentHistoryAttemptSummary>> {
  if (candidates.length === 0) {
    return new Map();
  }

  const candidateIds = candidates.map((candidate) => candidate.id);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const placeholders = candidateIds.map(() => "?").join(", ");
  const results = await db
    .prepare(
      `SELECT
         finalizations.attempt_id,
         finalizations.assignment_id,
         COALESCE(results.assessment_version_id, finalizations.assessment_version_id) AS assessment_version_id,
         finalizations.status AS finalization_status,
         finalizations.error_message,
         finalizations.updated_at,
         finalizations.submitted_at,
         results.id AS attempt_result_id,
         results.status AS result_status,
         results.total_score,
         results.max_score,
         results.test_outcome_variables_json
       FROM result_finalizations finalizations
       LEFT JOIN attempt_results results ON results.attempt_id = finalizations.attempt_id
       WHERE finalizations.attempt_id IN (${placeholders})
       ORDER BY finalizations.submitted_at DESC, finalizations.id DESC`,
    )
    .bind(...candidateIds)
    .all<{
      attempt_id: string;
      assignment_id: string | null;
      assessment_version_id: string;
      finalization_status: "pending" | "complete" | "failed";
      error_message: string | null;
      updated_at: string;
      submitted_at: string;
      attempt_result_id: string | null;
      result_status: AttemptResultStatus | null;
      total_score: number | null;
      max_score: number | null;
      test_outcome_variables_json: string | null;
    }>();

  if (results.results.length === 0) {
    return new Map();
  }

  const latestResultByAttempt = new Map<string, (typeof results.results)[number]>();
  for (const row of results.results) {
    if (!latestResultByAttempt.has(row.attempt_id)) {
      latestResultByAttempt.set(row.attempt_id, row);
    }
  }

  const resultIds = [...latestResultByAttempt.values()]
    .map((row) => row.attempt_result_id)
    .filter((value): value is string => Boolean(value));
  if (resultIds.length === 0) {
    return new Map(
      [...latestResultByAttempt.values()].flatMap((row) => {
        const candidate = candidateById.get(row.attempt_id);
        if (!candidate) {
          return [];
        }
        if (!row.attempt_result_id && row.finalization_status === "pending") {
          return [];
        }

        return [
          [
            row.attempt_id,
            {
              attemptId: row.attempt_id,
              assignmentId: row.assignment_id,
              assessmentVersionId: row.assessment_version_id,
              createdAt: candidate.created_at,
              submittedAt: row.submitted_at,
              totalScore: row.total_score,
              maxScore: row.max_score,
              answeredItemCount: 0,
              scoredItemCount: 0,
              itemCount: 0,
              resultStatus: row.result_status ?? row.finalization_status,
              finalization: {
                status: row.finalization_status,
                errorMessage: row.error_message,
                updatedAt: row.updated_at,
              },
              latestScoreRevision: null,
              items: [],
            },
          ] as const,
        ];
      }),
    );
  }

  const itemRows = await db
    .prepare(
      `SELECT attempt_result_id, item_position, item_id, item_identifier, item_title, answered, response_summary_text, score, max_score, base_score, base_max_score, score_amended, score_amendment_ids_json, outcome_variables_json FROM attempt_result_items WHERE attempt_result_id IN (${resultIds
        .map(() => "?")
        .join(", ")}) ORDER BY item_position ASC, created_at ASC, id ASC`,
    )
    .bind(...resultIds)
    .all<{
      attempt_result_id: string;
      item_position: number | null;
      item_id: string;
      item_identifier: string | null;
      item_title: string | null;
      answered: number;
      response_summary_text: string | null;
      score: number | null;
      max_score: number | null;
      base_score: number | null;
      base_max_score: number | null;
      score_amended: number;
      score_amendment_ids_json: string;
      outcome_variables_json: string;
    }>();
  const revisionByResultId = await readLatestScoreRevisionsByResultId(db, resultIds);
  const itemsByResultId = new Map<string, AttemptSubmissionSummary["items"]>();

  for (const row of itemRows.results) {
    const items = itemsByResultId.get(row.attempt_result_id) ?? [];
    items.push({
      itemId: row.item_id,
      itemIdentifier: row.item_identifier ?? row.item_id,
      itemTitle: row.item_title ?? row.item_id,
      answered: row.answered === 1,
      responseSummary: row.response_summary_text,
      manualFeedback: readManualFeedback(row.outcome_variables_json),
      score: row.score,
      maxScore: row.max_score,
      baseScore: row.base_score,
      baseMaxScore: row.base_max_score,
      scoreAmended: row.score_amended === 1,
      scoreAmendmentIds: parseStringArray(row.score_amendment_ids_json),
    });
    itemsByResultId.set(row.attempt_result_id, items);
  }

  return new Map(
    [...latestResultByAttempt.values()].flatMap((row) => {
      const candidate = candidateById.get(row.attempt_id);
      if (!candidate) {
        return [];
      }
      if (!row.attempt_result_id && row.finalization_status === "pending") {
        return [];
      }

      const items = row.attempt_result_id ? (itemsByResultId.get(row.attempt_result_id) ?? []) : [];
      return [
        [
          row.attempt_id,
          {
            attemptId: row.attempt_id,
            assignmentId: row.assignment_id,
            assessmentVersionId: row.assessment_version_id,
            createdAt: candidate.created_at,
            submittedAt: row.submitted_at,
            totalScore: row.total_score,
            maxScore: row.max_score,
            stagedAssessment: summarizeStagedAssessment(
              readVariables(row.test_outcome_variables_json),
              itemRows.results
                .filter((item) => item.attempt_result_id === row.attempt_result_id)
                .map((item) => ({
                  answered: item.answered === 1,
                  score: item.score,
                  outcomeVariables: readVariables(item.outcome_variables_json),
                })),
            ),
            answeredItemCount: items.filter((item) => item.answered).length,
            scoredItemCount: items.filter((item) => item.score !== null).length,
            itemCount: items.length,
            resultStatus: row.result_status ?? row.finalization_status,
            finalization: {
              status: row.finalization_status,
              errorMessage: row.error_message,
              updatedAt: row.updated_at,
            },
            latestScoreRevision: row.attempt_result_id
              ? (revisionByResultId.get(row.attempt_result_id) ?? null)
              : null,
            items,
          },
        ] as const,
      ];
    }),
  );
}

async function loadHistoryAttempt(
  coordinator: DurableObjectNamespace,
  candidate: AttemptHistoryCandidateRow,
): Promise<AssignmentHistoryAttemptSummary | null> {
  const stub = coordinator.get(coordinator.idFromName(candidate.id));
  const [sessionResponse, summaryResponse] = await Promise.all([
    stub.fetch("https://harbor-attempt.local/session", {
      headers: {
        [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: candidate.id,
      },
    }),
    stub.fetch("https://harbor-attempt.local/submission-summary", {
      headers: {
        [ATTEMPT_COORDINATOR_ATTEMPT_ID_HEADER]: candidate.id,
      },
    }),
  ]);

  if (!sessionResponse.ok || !summaryResponse.ok) {
    return null;
  }

  const session = await sessionResponse.json<AuthoritativeAttemptSessionState>();
  const summaryPayload = await summaryResponse.json<{
    attemptId: string;
    submissionSummary: AttemptSubmissionSummary | null;
  }>();

  if (session.attemptStatus !== "submitted" || !summaryPayload.submissionSummary?.submittedAt) {
    return null;
  }

  return {
    attemptId: candidate.id,
    assignmentId: null,
    assessmentVersionId: candidate.assessment_version_id,
    createdAt: candidate.created_at,
    submittedAt: summaryPayload.submissionSummary.submittedAt,
    totalScore: null,
    maxScore: summaryPayload.submissionSummary.maxScore,
    answeredItemCount: summaryPayload.submissionSummary.answeredItemCount,
    scoredItemCount: 0,
    itemCount: summaryPayload.submissionSummary.itemCount,
    resultStatus: "pending",
    finalization: {
      status: "pending",
      errorMessage: null,
      updatedAt: summaryPayload.submissionSummary.submittedAt,
    },
    latestScoreRevision: null,
    items: summaryPayload.submissionSummary.items.map((item) => ({
      ...item,
      score: null,
    })),
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function readManualFeedback(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const feedback = parsed.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        (entry as { identifier?: unknown }).identifier ===
          HARBOR_MANUAL_FEEDBACK_OUTCOME_IDENTIFIER,
    );
    const feedbackValue = (feedback as { value?: unknown } | undefined)?.value;
    return typeof feedbackValue === "string" && feedbackValue.trim() ? feedbackValue.trim() : null;
  } catch {
    return null;
  }
}

function readVariables(value: string | null): AttemptVariableSnapshot[] {
  if (value === null) return [];
  const raw: unknown = JSON.parse(value);
  if (!Array.isArray(raw)) throw new Error("Invalid stored result variables.");
  return raw.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("identifier" in entry) ||
      typeof entry.identifier !== "string" ||
      !("value" in entry)
    )
      throw new Error("Invalid stored result variable.");
    return { identifier: entry.identifier, value: entry.value };
  });
}
