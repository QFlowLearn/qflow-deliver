import { expect, test } from "@playwright/test";

const queueRow = {
  attemptId: "attempt_manual_e2e",
  attemptResultId: "ares_manual_e2e",
  assignmentId: "assign_manual_e2e",
  assignmentTitle: "Manual Scoring Lab",
  assessmentVersionId: "vers_manual_e2e",
  assessmentTitle: "Complex Presidents Workout",
  learner: {
    id: "learner_manual_e2e",
    tenantId: "tenant_local_demo",
    displayName: "Morgan Lee",
    email: "morgan@example.edu",
    createdAt: "2026-05-24T12:00:00.000Z",
    updatedAt: "2026-05-24T12:00:00.000Z",
  },
  submittedAt: "2026-05-24T12:10:00.000Z",
  pendingItemCount: 1,
  scoredItemCount: 0,
  latestReviewer: null,
  latestUpdatedAt: null,
  status: "needs-review",
};

const manualEntry = {
  id: "mscore_manual_e2e",
  attemptResultItemId: "aresitm_manual_e2e",
  itemId: "upload-presidents",
  status: "draft",
  score: 1.5,
  maxScore: 2,
  studentFeedback: "Clear work.",
  privateNote: "Rubric row B.",
  scoredBy: {
    role: "instructor",
    actorId: "inst_local_demo",
    displayName: "Local Instructor",
  },
  scoredAt: "2026-05-24T12:20:00.000Z",
  releasedAt: null,
  updatedAt: "2026-05-24T12:20:00.000Z",
};

function buildAttempt(manualScore: typeof manualEntry | null = null) {
  return {
    attemptId: queueRow.attemptId,
    attemptResultId: queueRow.attemptResultId,
    assignment: {
      id: queueRow.assignmentId,
      title: queueRow.assignmentTitle,
      status: "active",
    },
    assessment: {
      assessmentVersionId: queueRow.assessmentVersionId,
      title: queueRow.assessmentTitle,
    },
    learner: queueRow.learner,
    resultStatus: "pending",
    submittedAt: queueRow.submittedAt,
    finalizedAt: queueRow.submittedAt,
    items: [
      {
        attemptResultItemId: "aresitm_manual_e2e",
        itemId: "upload-presidents",
        itemIdentifier: "upload-presidents",
        itemTitle: "Upload your source analysis",
        itemPosition: 0,
        answered: true,
        responseSummary: "presidents-analysis.pdf",
        responseVariables: [{ identifier: "RESPONSE", value: "presidents-analysis.pdf" }],
        outcomeVariables: [
          { identifier: "HARBOR_SCORING_STATUS", value: "pending-manual-scoring" },
        ],
        authoredMaxScore: 2,
        pendingManualScoring: true,
        manualScore,
      },
    ],
    canFinalize: manualScore !== null,
    generatedAt: "2026-05-24T12:21:00.000Z",
  };
}

test("manual scoring page saves a draft and requires explicit release confirmation", async ({
  page,
}) => {
  let saved = false;
  let finalized = false;
  await mockManualScoringShell(page, {
    get saved() {
      return saved;
    },
    set saved(value: boolean) {
      saved = value;
    },
    get finalized() {
      return finalized;
    },
    set finalized(value: boolean) {
      finalized = value;
    },
  });

  await page.goto("/manual-scoring");

  await expect(page.getByTestId("harbor-shell")).toHaveAttribute("data-page", "manual-scoring");
  await expect(page.getByText("All assignments")).toBeVisible();
  await expect(page.getByTestId("manual-scoring-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Morgan Lee" })).toBeVisible();

  await page.getByRole("button", { name: "Morgan Lee" }).click();
  await expect(page.getByRole("heading", { name: "Morgan Lee" })).toBeVisible();
  await expect(page.locator(".response-summary")).toHaveText("presidents-analysis.pdf");
  await expect(page.locator("#manual-max-score-input")).toHaveAttribute("max", "2");

  await page.locator("#manual-score-input").fill("1.5");
  await page.locator("#manual-max-score-input").fill("2");
  await page.locator("#manual-feedback-input").fill("Clear work.");
  await page.locator("#manual-note-input").fill("Rubric row B.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("1.5 / 2")).toBeVisible();

  await page.getByRole("button", { name: "Finalize attempt" }).click();
  await expect(page.getByRole("button", { name: "Confirm release" })).toBeVisible();
  expect(finalized).toBe(false);

  await page.getByRole("button", { name: "Confirm release" }).click();
  await expect(page.getByText("No submitted attempts are awaiting manual scoring.")).toBeVisible();
  expect(saved).toBe(true);
  expect(finalized).toBe(true);
});

async function mockManualScoringShell(
  page: Parameters<typeof test>[0]["page"],
  state: {
    saved: boolean;
    finalized?: boolean;
  },
): Promise<void> {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        learner: {
          id: "learner_manual_e2e",
          displayName: "Morgan Lee",
          email: "morgan@example.edu",
        },
        session: {
          id: "session_manual_e2e",
          tenantId: "tenant_local_demo",
          providerKind: "institutional-sso",
          issuedAt: "2026-05-24T12:00:00.000Z",
        },
      }),
    });
  });

  await page.route("**/api/student/assignments", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ assignments: [] }),
    });
  });

  await page.route("**/api/instructor/assignments", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ assignments: [] }),
    });
  });

  await page.route("**/api/instructor/manual-scoring**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/instructor/manual-scoring") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: "2026-05-24T12:15:00.000Z",
          rows: state.finalized
            ? []
            : [
                {
                  ...queueRow,
                  scoredItemCount: state.saved ? 1 : 0,
                  latestReviewer: state.saved ? manualEntry.scoredBy : null,
                  latestUpdatedAt: state.saved ? manualEntry.updatedAt : null,
                  status: state.saved ? "ready-to-finalize" : "needs-review",
                },
              ],
        }),
      });
      return;
    }

    if (
      url.pathname === "/api/instructor/manual-scoring/attempts/attempt_manual_e2e" &&
      method === "GET"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildAttempt(state.saved ? manualEntry : null)),
      });
      return;
    }

    if (
      url.pathname ===
        "/api/instructor/manual-scoring/attempts/attempt_manual_e2e/items/upload-presidents" &&
      method === "PUT"
    ) {
      state.saved = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entry: manualEntry }),
      });
      return;
    }

    if (
      url.pathname === "/api/instructor/manual-scoring/attempts/attempt_manual_e2e/finalize" &&
      method === "POST"
    ) {
      state.finalized = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          attemptResultId: queueRow.attemptResultId,
          attemptId: queueRow.attemptId,
          status: "complete",
          totalScore: 1.5,
          maxScore: 2,
          finalizedAt: "2026-05-24T12:25:00.000Z",
        }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "manual scoring mock route not found" }),
    });
  });

  await page.route("**/api/instructor/**", async (route) => {
    if (route.request().url().includes("/api/instructor/manual-scoring")) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: [], summary: {}, filters: {}, assignment: null }),
    });
  });
}
