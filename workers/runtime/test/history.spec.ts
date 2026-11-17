import { beforeEach, describe, expect, it } from "vitest";
import {
  resetBindings,
  getJson,
  postJson,
  publishFixture,
  issueAccessCode,
  createAssignedAttempt,
  seedAuthoritativeResult,
  launchAccessCodeAttempt,
  submitAttempt,
  finalizeQueuedSubmit,
  buildSubmissionSummary,
} from "./history-fixture";

beforeEach(async () => {
  await resetBindings();
});

describe("attempt score history", () => {
  it("prefers authoritative result rows when present and safely falls back for unfinalized retakes", async () => {
    const published = await publishFixture({
      tenantId: "tenant_attempt_history",
      assessmentSlug: "student-history-package",
    });
    const accessCode = await issueAccessCode(published.assessmentVersionId);
    const actor = {
      actorId: "student_01",
      actorDisplayName: "Student One",
    };

    const firstAttempt = await launchAccessCodeAttempt({
      accessCode,
      ...actor,
    });
    const firstSubmit = await submitAttempt({
      attemptId: firstAttempt.attemptId,
      currentItemRef: firstAttempt.session.currentItemRef,
      submissionSummary: buildSubmissionSummary({
        totalScore: 1,
        answeredItemCount: 2,
      }),
      sequenceNumber: 1,
      clientSessionId: "client_student_01",
      submissionMaterialization: {
        itemOrder: ["item-1", "item-2"],
        testState: {
          identifier: "test-1",
          outcomeVariables: [
            {
              identifier: "SCORE",
              value: 2,
            },
            {
              identifier: "MAXSCORE",
              value: 2,
            },
          ],
        },
        partStates: {
          "part-1": {
            identifier: "part-1",
            outcomeVariables: [],
          },
        },
        sectionStates: {
          "section-1": {
            identifier: "section-1",
            outcomeVariables: [],
          },
        },
        items: {
          "item-1": {
            itemId: "item-1",
            itemIdentifier: "item-1",
            itemTitle: "President One",
            capturedAt: "2026-03-27T12:00:00.000Z",
            responseVariables: [
              {
                identifier: "RESPONSE",
                value: "A",
              },
            ],
            outcomeVariables: [
              {
                identifier: "SCORE",
                value: 1,
              },
              {
                identifier: "MAXSCORE",
                value: 1,
              },
            ],
            validationMessages: [],
          },
          "item-2": {
            itemId: "item-2",
            itemIdentifier: "item-2",
            itemTitle: "President Two",
            capturedAt: "2026-03-27T12:00:00.000Z",
            responseVariables: [
              {
                identifier: "RESPONSE",
                value: "B",
              },
            ],
            outcomeVariables: [
              {
                identifier: "SCORE",
                value: 1,
              },
              {
                identifier: "MAXSCORE",
                value: 1,
              },
            ],
            validationMessages: [],
          },
        },
      },
      captureQueue: true,
    });

    expect(firstSubmit.receipt.attemptStatus).toBe("submitted");
    expect(firstSubmit.queuedEnvelope).toBeTruthy();
    await finalizeQueuedSubmit(firstSubmit.queuedEnvelope!);

    const secondAttempt = await launchAccessCodeAttempt({
      accessCode,
      ...actor,
    });

    expect(secondAttempt.attemptId).not.toBe(firstAttempt.attemptId);

    const secondSubmit = await submitAttempt({
      attemptId: secondAttempt.attemptId,
      currentItemRef: secondAttempt.session.currentItemRef,
      submissionSummary: buildSubmissionSummary({
        totalScore: 1,
        answeredItemCount: 2,
      }),
      sequenceNumber: 1,
      clientSessionId: "client_student_01",
    });

    expect(secondSubmit.receipt.attemptStatus).toBe("submitted");

    const historyResponse = await getJson(`/api/attempts/${secondAttempt.attemptId}/history`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json<{
      assessment: { title: string };
      attempts: Array<{
        attemptId: string;
        totalScore: number | null;
        maxScore: number | null;
        resultStatus?: string | null;
        finalization?: { status: string } | null;
        items: Array<{
          responseSummary?: string | null;
          score?: number | null;
        }>;
      }>;
    }>();

    expect(history.assessment.title).toBe("Student History Package");
    expect(history.attempts).toHaveLength(2);
    expect(history.attempts.map((attempt) => attempt.attemptId)).toEqual([
      secondAttempt.attemptId,
      firstAttempt.attemptId,
    ]);
    expect(history.attempts.map((attempt) => attempt.totalScore)).toEqual([null, 2]);
    expect(history.attempts.map((attempt) => attempt.maxScore)).toEqual([2, 2]);
    expect(history.attempts[0]?.resultStatus).toBe("pending");
    expect(history.attempts[0]?.finalization?.status).toBe("pending");
    expect(history.attempts[0]?.items.map((item) => item.score)).toEqual([null, null]);
    expect(history.attempts[1]?.items.map((item) => item.responseSummary)).toEqual(["A", "B"]);
  });

  it("scopes authoritative history to assignment and learner when the same learner has multiple assignments on one assessment", async () => {
    const published = await publishFixture({
      tenantId: "tenant_attempt_history",
      assessmentSlug: "student-history-package-assignment-scope",
    });

    const assignmentOneResponse = await postJson("/internal/assignments", {
      assignmentId: "assign_hist_01",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Assignment One",
      actor: {
        role: "instructor",
        actorId: "inst_history",
        displayName: "History Instructor",
      },
      policySnapshot: {
        availableFrom: "2026-03-27T00:00:00.000Z",
        availableUntil: "2026-03-30T00:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
      targets: [],
    });
    expect(assignmentOneResponse.status).toBe(201);

    const assignmentTwoResponse = await postJson("/internal/assignments", {
      assignmentId: "assign_hist_02",
      assessmentId: published.assessmentId,
      assessmentVersionId: published.assessmentVersionId,
      title: "Assignment Two",
      actor: {
        role: "instructor",
        actorId: "inst_history",
        displayName: "History Instructor",
      },
      policySnapshot: {
        availableFrom: "2026-03-27T00:00:00.000Z",
        availableUntil: "2026-03-30T00:00:00.000Z",
        reportingTimezone: "America/New_York",
        maxAttempts: 2,
        timeLimitSeconds: 1800,
        gracePeriodSeconds: 30,
        navigationMode: "free",
        standaloneAllowed: true,
        iframeAllowed: false,
        allowedEmbedOrigins: [],
        secureBrowserRequired: false,
        secureBrowserProviderHint: null,
        proctoringProvider: null,
      },
      targets: [],
    });
    expect(assignmentTwoResponse.status).toBe(201);

    const firstAssignmentAttempt = await createAssignedAttempt({
      assignmentId: "assign_hist_01",
      assessmentVersionId: published.assessmentVersionId,
      learnerId: "learner_hist_shared",
      displayName: "Shared Learner",
    });
    await seedAuthoritativeResult({
      attemptId: firstAssignmentAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_hist_01",
      totalScore: 4,
      maxScore: 5,
      submittedAt: "2026-03-28T12:00:00.000Z",
    });

    const secondAssignmentAttempt = await createAssignedAttempt({
      assignmentId: "assign_hist_01",
      assessmentVersionId: published.assessmentVersionId,
      learnerId: "learner_hist_shared",
      displayName: "Shared Learner",
    });
    await seedAuthoritativeResult({
      attemptId: secondAssignmentAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_hist_01",
      totalScore: 5,
      maxScore: 5,
      submittedAt: "2026-03-28T12:05:00.000Z",
    });

    const otherAssignmentAttempt = await createAssignedAttempt({
      assignmentId: "assign_hist_02",
      assessmentVersionId: published.assessmentVersionId,
      learnerId: "learner_hist_shared",
      displayName: "Shared Learner",
    });
    await seedAuthoritativeResult({
      attemptId: otherAssignmentAttempt.attemptId,
      assessmentVersionId: published.assessmentVersionId,
      assignmentId: "assign_hist_02",
      totalScore: 1,
      maxScore: 5,
      submittedAt: "2026-03-28T12:10:00.000Z",
    });

    const historyResponse = await getJson(
      `/api/attempts/${secondAssignmentAttempt.attemptId}/history`,
    );
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json<{
      assignmentId: string | null;
      assessment: { assignmentTitle: string | null };
      actor: { learnerId: string | null };
      attempts: Array<{
        attemptId: string;
        totalScore: number | null;
        resultStatus: string | null;
      }>;
    }>();

    expect(history.assignmentId).toBe("assign_hist_01");
    expect(history.assessment.assignmentTitle).toBe("Assignment One");
    expect(history.actor.learnerId).toBe("learner_hist_shared");
    expect(history.attempts.map((attempt) => attempt.attemptId)).toEqual([
      secondAssignmentAttempt.attemptId,
      firstAssignmentAttempt.attemptId,
    ]);
    expect(history.attempts.map((attempt) => attempt.totalScore)).toEqual([5, 4]);
    expect(history.attempts.map((attempt) => attempt.resultStatus)).toEqual([
      "complete",
      "complete",
    ]);
  });
});
