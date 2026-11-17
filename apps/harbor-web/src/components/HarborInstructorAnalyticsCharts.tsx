import type {
  InstructorAssignmentReportingResponse,
  InstructorLearnerReportResponse,
} from "@harbor/attempt-protocol";
import HarborSvgBarChart from "@/components/HarborSvgBarChart";
import HarborSvgLineChart from "@/components/HarborSvgLineChart";

type ChartCard = {
  title: string;
  meta: string;
  value?: string;
};

type BarChartDatum = {
  label: string;
  value: number;
  color?: string;
};

type ChartMarker = {
  value: number;
  label: string;
};

type BarChartInput = ChartCard & {
  data: BarChartDatum[];
  color: string;
  orientation?: "horizontal" | "vertical";
  maxValue?: number;
  valueKind?: "number" | "percent";
  yMarker?: number;
  yMarkerLabel?: string;
};

type LineChartInput = ChartCard & {
  labels: string[];
  values: number[];
  color: string;
  maxValue?: number;
  valueKind?: "number" | "percent";
  yMarker?: number;
  yMarkerLabel?: string;
};

const blue = "#2563eb";
const green = "#059669";
const amber = "#d97706";
const red = "#dc2626";
const indigo = "#4f46e5";
const teal = "#0f766e";

export default function HarborInstructorAnalyticsCharts(props: {
  assignmentReport: InstructorAssignmentReportingResponse;
  learnerReport: InstructorLearnerReportResponse | null;
}) {
  const completionChart = buildCompletionChart(props.assignmentReport);
  const scoreDistributionChart = buildScoreDistributionChart(props.assignmentReport);
  const itemDifficultyChart = buildItemDifficultyChart(props.assignmentReport);
  const standardsMasteryChart = buildStandardsMasteryChart(props.assignmentReport);
  const learnerTrendChart = buildLearnerTrendChart(props.learnerReport);
  const hasCompletionChart = completionChart.data.some((datum) => datum.value > 0);
  const hasScoreDistributionChart = scoreDistributionChart.data.some((datum) => datum.value > 0);
  const hasItemDifficultyChart = itemDifficultyChart.data.length > 0;
  const hasStandardsMasteryChart =
    props.assignmentReport.standardsMastery.metadataAvailable &&
    standardsMasteryChart.data.length > 0;
  const hasLearnerTrendChart = learnerTrendChart.values.length > 1;

  return (
    <section class="analytics-panel" data-testid="instructor-analytics-charts">
      {hasCompletionChart && (
        <ChartCard
          title={completionChart.title}
          meta={completionChart.meta}
          value={completionChart.value}
        >
          <HarborSvgBarChart
            chartLabel="Assessment completion status chart"
            data={completionChart.data}
            color={completionChart.color}
          />
        </ChartCard>
      )}

      {hasScoreDistributionChart && (
        <ChartCard
          title={scoreDistributionChart.title}
          meta={scoreDistributionChart.meta}
          value={scoreDistributionChart.value}
        >
          <HarborSvgBarChart
            chartLabel="Score distribution chart"
            data={scoreDistributionChart.data}
            color={scoreDistributionChart.color}
          />
        </ChartCard>
      )}

      {hasItemDifficultyChart && (
        <ChartCard title={itemDifficultyChart.title} meta={itemDifficultyChart.meta} wide>
          <HarborSvgBarChart
            chartLabel="Item difficulty chart"
            data={itemDifficultyChart.data}
            color={itemDifficultyChart.color}
            marker={chartMarker(itemDifficultyChart)}
            maxValue={itemDifficultyChart.maxValue}
            orientation={itemDifficultyChart.orientation}
            valueKind={itemDifficultyChart.valueKind}
          />
        </ChartCard>
      )}

      {hasStandardsMasteryChart && (
        <ChartCard title={standardsMasteryChart.title} meta={standardsMasteryChart.meta} wide>
          <HarborSvgBarChart
            chartLabel="Standards mastery chart"
            data={standardsMasteryChart.data}
            color={standardsMasteryChart.color}
            marker={chartMarker(standardsMasteryChart)}
            maxValue={standardsMasteryChart.maxValue}
            orientation={standardsMasteryChart.orientation}
            valueKind={standardsMasteryChart.valueKind}
          />
        </ChartCard>
      )}

      {hasLearnerTrendChart && (
        <ChartCard title={learnerTrendChart.title} meta={learnerTrendChart.meta} wide>
          <HarborSvgLineChart
            chartLabel="Selected learner score trend chart"
            labels={learnerTrendChart.labels}
            values={learnerTrendChart.values}
            color={learnerTrendChart.color}
            marker={chartMarker(learnerTrendChart)}
            maxValue={learnerTrendChart.maxValue}
            valueKind={learnerTrendChart.valueKind}
          />
        </ChartCard>
      )}
    </section>
  );
}

function ChartCard(props: {
  title: string;
  meta: string;
  value?: string;
  wide?: boolean;
  children: preact.ComponentChildren;
}) {
  return (
    <article class={`analytics-chart${props.wide ? " analytics-chart--wide" : ""}`}>
      <div class="chart-header">
        <div>
          <h3>{props.title}</h3>
          <p>{props.meta}</p>
        </div>
        {props.value && <strong>{props.value}</strong>}
      </div>
      <div class="chart-host">{props.children}</div>
    </article>
  );
}

function buildCompletionChart(report: InstructorAssignmentReportingResponse): BarChartInput {
  const summary = report.summary;
  const notSubmitted = Math.max(0, summary.targetedLearnerCount - summary.submittedAttemptCount);
  return {
    title: "Completion",
    meta: `${summary.submittedAttemptCount} submitted`,
    value: `${summary.targetedLearnerCount}`,
    data: [
      { label: "Scored", value: summary.scoredAttemptCount, color: green },
      { label: "Pending", value: summary.pendingCount, color: amber },
      { label: "Failed", value: summary.failedCount, color: red },
      { label: "Not submitted", value: notSubmitted, color: blue },
    ],
    color: blue,
  };
}

function buildScoreDistributionChart(report: InstructorAssignmentReportingResponse): BarChartInput {
  const bins = [
    { label: "0-59", value: 0 },
    { label: "60-69", value: 0 },
    { label: "70-79", value: 0 },
    { label: "80-89", value: 0 },
    { label: "90-100", value: 0 },
  ];
  for (const row of report.rosterSummary) {
    if (row.percentScore === null) continue;
    const percent = clampPercent(row.percentScore);
    const binIndex = percent < 60 ? 0 : percent < 70 ? 1 : percent < 80 ? 2 : percent < 90 ? 3 : 4;
    bins[binIndex].value += 1;
  }
  return {
    title: "Score Distribution",
    meta: `${report.summary.scoredAttemptCount} scored`,
    value: formatChartPercent(report.summary.averagePercent),
    data: bins.map((bin) => ({ label: bin.label, value: bin.value })),
    color: indigo,
  };
}

function buildItemDifficultyChart(report: InstructorAssignmentReportingResponse): BarChartInput {
  return {
    title: "Item Difficulty",
    meta: "Average percent by item",
    data: report.itemAnalysis.slice(0, 6).map((item) => ({
      label: trimLabel(item.itemTitle || item.itemIdentifier || item.itemId, 18),
      value: clampPercent(item.averagePercent ?? 0),
    })),
    color: amber,
    orientation: "horizontal",
    maxValue: 100,
    valueKind: "percent",
    yMarker: 70,
    yMarkerLabel: "70%",
  };
}

function buildStandardsMasteryChart(report: InstructorAssignmentReportingResponse): BarChartInput {
  return {
    title: "Standards Mastery",
    meta: "Average percent by aligned standard",
    data: report.standardsMastery.rows.slice(0, 6).map((standard) => ({
      label: trimLabel(standard.label, 18),
      value: clampPercent(standard.averagePercent ?? 0),
    })),
    color: teal,
    orientation: "horizontal",
    maxValue: 100,
    valueKind: "percent",
    yMarker: 70,
    yMarkerLabel: "70%",
  };
}

function buildLearnerTrendChart(
  learnerReport: InstructorLearnerReportResponse | null,
): LineChartInput {
  if (!learnerReport) {
    return {
      title: "Learner Trend",
      meta: "Selected learner",
      labels: [],
      values: [],
      color: green,
      maxValue: 100,
      valueKind: "percent",
      yMarker: 70,
      yMarkerLabel: "70%",
    };
  }

  const rows = [...learnerReport.attempts]
    .filter((attempt) => attempt.percentScore !== null)
    .sort((a, b) => a.launchedAt.localeCompare(b.launchedAt))
    .map((attempt, index) => ({
      label: `Attempt ${index + 1}`,
      value: clampPercent(attempt.percentScore ?? 0),
    }));
  return {
    title: "Learner Trend",
    meta: learnerReport.learner.displayName,
    labels: rows.map((row) => row.label),
    values: rows.map((row) => row.value),
    color: green,
    maxValue: 100,
    valueKind: "percent",
    yMarker: 70,
    yMarkerLabel: "70%",
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function trimLabel(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`
    : trimmed;
}

function formatChartPercent(value: number | null): string {
  return value === null ? "n/a" : `${clampPercent(value)}%`;
}

function chartMarker(input: { yMarker?: number; yMarkerLabel?: string }): ChartMarker | undefined {
  if (input.yMarker === undefined) return undefined;
  return {
    value: input.yMarker,
    label: input.yMarkerLabel ?? `${input.yMarker}`,
  };
}
