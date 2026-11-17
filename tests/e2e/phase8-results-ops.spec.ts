import { expect, test } from "@playwright/test";

const resultsOpsRows = [
  {
    attemptId: "attempt_failed_finalization",
    assignmentId: "assign_results_ops",
    assessmentVersionId: "aver_results_ops_v1",
    sourceReceiptId: "receipt_failed_finalization",
    context: {
      tenantId: "tenant_results_ops",
      assessmentId: "asm_results_ops",
      assessmentSlug: "results-ops",
      assessmentTitle: "Results Ops Assessment",
      assignmentTitle: "District CFA",
    },
    finalization: {
      finalizationId: "rfinal_failed_finalization",
      status: "failed",
      errorMessage: "Results ops materialization failure",
      submittedAt: "2026-03-28T18:00:00.000Z",
      finalizedAt: "2026-03-28T18:01:00.000Z",
      updatedAt: "2026-03-28T18:01:00.000Z",
    },
    result: null,
    export: null,
    remediation: {
      pendingCount: 0,
      failedCount: 1,
      latestRequest: {
        requestId: "rrem_failed_history_01",
        scope: "result-finalization",
        status: "failed",
        retryOfRequestId: null,
        requestedAt: "2026-03-28T18:02:00.000Z",
        completedAt: "2026-03-28T18:03:00.000Z",
        errorMessage: "Workflow could not reacquire result materialization context",
      },
    },
  },
  {
    attemptId: "attempt_pending_export",
    assignmentId: "assign_results_ops",
    assessmentVersionId: "aver_results_ops_v1",
    sourceReceiptId: "receipt_pending_export",
    context: {
      tenantId: "tenant_results_ops",
      assessmentId: "asm_results_ops",
      assessmentSlug: "results-ops",
      assessmentTitle: "Results Ops Assessment",
      assignmentTitle: "District CFA",
    },
    finalization: {
      finalizationId: "rfinal_pending_export",
      status: "complete",
      errorMessage: null,
      submittedAt: "2026-03-28T18:05:00.000Z",
      finalizedAt: "2026-03-28T18:05:20.000Z",
      updatedAt: "2026-03-28T18:05:20.000Z",
    },
    result: {
      status: "complete",
      totalScore: 8,
      maxScore: 10,
      passed: true,
      finalizedAt: "2026-03-28T18:05:20.000Z",
    },
    export: {
      exportId: "rexp_pending_export",
      format: "qti3-results-report",
      status: "pending",
      retryOfExportId: null,
      artifact: null,
      exportedAt: null,
      errorMessage: null,
      updatedAt: "2026-03-28T18:05:40.000Z",
    },
    remediation: {
      pendingCount: 0,
      failedCount: 0,
      latestRequest: null,
    },
  },
];

const retryableResultsOpsRows = [
  resultsOpsRows[0],
  {
    attemptId: "attempt_failed_export",
    assignmentId: "assign_results_ops_alt",
    assessmentVersionId: "aver_results_ops_v1",
    sourceReceiptId: "receipt_failed_export",
    context: {
      tenantId: "tenant_results_ops_alt",
      assessmentId: "asm_results_ops_alt",
      assessmentSlug: "results-ops-alt",
      assessmentTitle: "Results Ops Alt Assessment",
      assignmentTitle: "Makeup CFA",
    },
    finalization: {
      finalizationId: "rfinal_failed_export",
      status: "complete",
      errorMessage: null,
      submittedAt: "2026-03-28T18:08:00.000Z",
      finalizedAt: "2026-03-28T18:08:15.000Z",
      updatedAt: "2026-03-28T18:08:15.000Z",
    },
    result: {
      status: "complete",
      totalScore: 7,
      maxScore: 10,
      passed: true,
      finalizedAt: "2026-03-28T18:08:15.000Z",
    },
    export: {
      exportId: "rexp_failed_export",
      format: "qti3-results-report",
      status: "failed",
      retryOfExportId: null,
      artifact: null,
      exportedAt: null,
      errorMessage: "R2 write timed out",
      updatedAt: "2026-03-28T18:09:00.000Z",
    },
    remediation: {
      pendingCount: 0,
      failedCount: 0,
      latestRequest: null,
    },
  },
];

const resultsOpsSummary = {
  finalization: {
    pendingCount: 0,
    failedCount: 1,
  },
  exports: {
    pendingCount: 1,
    failedCount: 0,
    completeCount: 4,
    retryPendingCount: 0,
    retryFailedCount: 0,
    retryCompleteCount: 1,
    latestUpdatedAt: "2026-03-28T18:05:40.000Z",
  },
  remediation: {
    pendingCount: 0,
    failedCount: 1,
    completeCount: 1,
    exportPendingCount: 0,
    exportFailedCount: 0,
    exportCompleteCount: 1,
    latestRequest: {
      requestId: "rrem_export_complete_01",
      scope: "result-export",
      status: "complete",
      retryOfRequestId: null,
      requestedAt: "2026-03-28T18:04:00.000Z",
      completedAt: "2026-03-28T18:04:20.000Z",
      errorMessage: null,
    },
  },
};

const resultsOpsFilters = {
  tenants: [
    {
      tenantId: "tenant_results_ops",
      rowCount: 2,
      failedCount: 1,
      pendingCount: 1,
    },
    {
      tenantId: "tenant_results_ops_alt",
      rowCount: 1,
      failedCount: 1,
      pendingCount: 0,
    },
  ],
  assignments: [
    {
      assignmentId: "assign_results_ops",
      tenantId: "tenant_results_ops",
      title: "District CFA",
      rowCount: 2,
      failedCount: 1,
      pendingCount: 1,
    },
    {
      assignmentId: "assign_results_ops_alt",
      tenantId: "tenant_results_ops_alt",
      title: "Makeup CFA",
      rowCount: 1,
      failedCount: 1,
      pendingCount: 0,
    },
  ],
};

const retryableResultsOpsSummary = {
  ...resultsOpsSummary,
  exports: {
    ...resultsOpsSummary.exports,
    failedCount: 1,
  },
};

test("results ops page uses a dedicated route and renders Harbor-owned status rows", async ({
  page,
}) => {
  await mockHarborShell(page, {
    rows: resultsOpsRows,
  });

  await page.goto("/");

  await expect(page.getByTestId("nav-link-assessments")).toBeVisible();
  await page.getByTestId("nav-link-assessments").click();
  await expect(page).toHaveURL(/\/assessments$/);
  await expect(page.getByTestId("nav-link-results-ops")).toBeVisible();
  await page.getByTestId("nav-link-results-ops").click();

  await expect(page).toHaveURL(/\/results-ops$/);
  await expect(page.getByTestId("harbor-shell")).toHaveAttribute("data-page", "results-ops");
  await expect(page.getByTestId("results-ops-page")).toBeVisible();
  await expect(page.getByTestId("results-ops-page-title")).toContainText("Score processing");
  await expect(page.getByTestId("results-ops-resend-summary")).toContainText(
    "1 completed retry exports",
  );

  const failedRow = page.getByTestId("results-ops-row-attempt_failed_finalization");
  await expect(failedRow).toBeVisible();
  await expect(failedRow).toContainText("failed");
  await expect(failedRow).toContainText("Results ops materialization failure");
  await expect(failedRow).toContainText("Retry Finalization");
  await expect(page.getByTestId("results-ops-context-attempt_failed_finalization")).toContainText(
    "tenant_results_ops",
  );
  await expect(page.getByTestId("results-ops-context-attempt_failed_finalization")).toContainText(
    "District CFA",
  );

  const pendingRow = page.getByTestId("results-ops-row-attempt_pending_export");
  await expect(pendingRow).toBeVisible();
  await expect(pendingRow).toContainText("pending");
  await expect(pendingRow).toContainText("qti3-results-report");
  await expect(pendingRow).toContainText("8 / 10");

  await page.getByTestId("results-ops-filter-status").selectOption("failed");
  await expect(pendingRow).toBeHidden();
  await expect(failedRow).toBeVisible();

  await page.getByTestId("results-ops-filter-status").selectOption("all");
  await page.getByTestId("results-ops-filter-tenant").selectOption("tenant_results_ops_alt");
  await expect(failedRow).toBeHidden();
});

test("results ops page exposes explicit retry scopes and shows pending remediation without implying in-place rewrites", async ({
  page,
}) => {
  const retryRequests: Array<{ attemptId: string; scope: string; reason: string }> = [];
  await mockHarborShell(page, {
    rows: retryableResultsOpsRows,
    summary: retryableResultsOpsSummary,
    retryRequests,
  });

  await page.goto("/results-ops");

  const finalizationRow = page.getByTestId("results-ops-row-attempt_failed_finalization");
  const exportRow = page.getByTestId("results-ops-row-attempt_failed_export");

  await expect(finalizationRow.getByTestId("retry-button-attempt_failed_finalization")).toHaveText(
    "Retry Finalization",
  );
  await expect(exportRow.getByTestId("retry-button-attempt_failed_export")).toHaveText(
    "Retry Export",
  );

  await exportRow.getByTestId("retry-button-attempt_failed_export").click();

  expect(retryRequests).toEqual([
    {
      attemptId: "attempt_failed_export",
      scope: "result-export",
      reason: "Retry failed result export",
    },
  ]);

  await expect(exportRow).toContainText("Export failed");
  await expect(exportRow).toContainText("R2 write timed out");
  await expect(exportRow).toContainText("Retry in progress");
});

async function mockHarborShell(
  page: Parameters<typeof test>[0]["page"],
  input: {
    rows: typeof resultsOpsRows;
    summary?: typeof resultsOpsSummary;
    retryRequests?: Array<{ attemptId: string; scope: string; reason: string }>;
  },
): Promise<void> {
  const rows = structuredClone(input.rows);
  const summary = structuredClone(input.summary ?? resultsOpsSummary);

  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        learner: {
          id: "learner_results_ops",
          displayName: "Morgan Lee",
          email: "morgan.lee@example.edu",
        },
        session: {
          id: "session_results_ops",
          tenantId: "tenant_local_demo",
          providerKind: "institutional-sso",
          issuedAt: "2026-03-28T17:55:00.000Z",
        },
      }),
    });
  });

  await page.route("**/api/student/assignments", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assignments: [],
      }),
    });
  });

  await page.route("**/api/instructor/assignments", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        assignments: [],
      }),
    });
  });

  await page.route("**/api/instructor/results-ops", async (route) => {
    const url = new URL(route.request().url());
    const tenantId = url.searchParams.get("tenantId");
    const assignmentId = url.searchParams.get("assignmentId");
    const scopedRows = rows.filter((row) => {
      if (tenantId && row.context.tenantId !== tenantId) {
        return false;
      }
      if (assignmentId && row.assignmentId !== assignmentId) {
        return false;
      }

      return true;
    });

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: scopedRows,
        summary,
        filters: resultsOpsFilters,
      }),
    });
  });

  await page.route("**/api/instructor/results-ops/attempts/*/retry", async (route) => {
    const url = new URL(route.request().url());
    const attemptId = url.pathname.split("/")[5] ?? "";
    const body = route.request().postDataJSON() as {
      scope: "result-finalization" | "result-export";
      reason: string;
    };
    const row = rows.find((entry) => entry.attemptId === attemptId);

    if (!row) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Attempt not found",
        }),
      });
      return;
    }

    input.retryRequests?.push({
      attemptId,
      scope: body.scope,
      reason: body.reason,
    });

    row.remediation.pendingCount = 1;
    row.remediation.latestRequest = {
      requestId: `rrem_${attemptId}`,
      scope: body.scope,
      status: "pending",
      retryOfRequestId: null,
      requestedAt: "2026-03-28T18:12:00.000Z",
      completedAt: null,
      errorMessage: null,
    };
    summary.remediation.pendingCount = 1;
    if (body.scope === "result-export") {
      summary.remediation.exportPendingCount = 1;
    }
    summary.remediation.latestRequest = row.remediation.latestRequest;

    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        existing: false,
        request: {
          requestId: `rrem_${attemptId}`,
          attemptId,
          assignmentId: row.assignmentId,
          assessmentVersionId: row.assessmentVersionId,
          sourceReceiptId: row.sourceReceiptId,
          scope: body.scope,
          status: "pending",
          retryOfRequestId: null,
          resultFinalizationId: row.finalization.finalizationId,
          resultExportId: row.export?.exportId ?? null,
          requestedBy: {
            role: "instructor",
            actorId: "inst_local_demo",
            displayName: "Local Instructor",
          },
          reason: body.reason,
          completedAt: null,
          errorMessage: null,
          createdAt: "2026-03-28T18:12:00.000Z",
          updatedAt: "2026-03-28T18:12:00.000Z",
        },
      }),
    });
  });
}
