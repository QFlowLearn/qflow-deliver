type ChartDatum = {
  label: string;
  value: number;
  color?: string;
};

type ChartMarker = {
  value: number;
  label: string;
};

export default function HarborSvgBarChart(props: {
  chartLabel: string;
  data: ChartDatum[];
  color: string;
  marker?: ChartMarker;
  orientation?: "horizontal" | "vertical";
  maxValue?: number;
  valueKind?: "number" | "percent";
}) {
  const orientation = props.orientation ?? "vertical";
  const valueKind = props.valueKind ?? "number";
  const chartWidth = 640;
  const chartHeight =
    orientation === "horizontal" ? Math.max(210, props.data.length * 30 + 48) : 210;
  const scaleMax = getScaleMax(
    props.data.map((datum) => datum.value),
    props.marker?.value,
    props.maxValue,
  );
  const ticks = uniqueNumbers([
    0,
    valueKind === "percent" ? 50 : Math.round(scaleMax / 2),
    scaleMax,
  ]);

  if (orientation === "horizontal") {
    const margin = { top: 16, right: 62, bottom: 28, left: 160 };
    const plotWidth = chartWidth - margin.left - margin.right;
    const plotHeight = chartHeight - margin.top - margin.bottom;
    const rowHeight = plotHeight / Math.max(1, props.data.length);
    const barHeight = Math.min(18, rowHeight * 0.54);
    const markerX = props.marker
      ? margin.left + (clamp(props.marker.value, 0, scaleMax) / scaleMax) * plotWidth
      : null;

    return (
      <svg
        class="svg-chart"
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        role="img"
        aria-label={props.chartLabel}
        preserveAspectRatio="none"
      >
        <title>{props.chartLabel}</title>
        <g class="chart-grid" aria-hidden="true">
          {ticks.map((tick) => {
            const x = margin.left + (tick / scaleMax) * plotWidth;
            return (
              <g key={tick}>
                <line x1={x} x2={x} y1={margin.top} y2={margin.top + plotHeight} />
                <text x={x} y={chartHeight - 8} text-anchor="middle">
                  {formatValue(tick, valueKind)}
                </text>
              </g>
            );
          })}
        </g>
        {markerX !== null && props.marker && (
          <g class="chart-marker" aria-hidden="true">
            <line x1={markerX} x2={markerX} y1={margin.top} y2={margin.top + plotHeight} />
            <text x={markerX + 4} y={margin.top + 10}>
              {props.marker.label}
            </text>
          </g>
        )}
        <g class="bar-series">
          {props.data.map((datum, index) => {
            const width = (clampNonNegative(datum.value) / scaleMax) * plotWidth;
            const y = margin.top + index * rowHeight + (rowHeight - barHeight) / 2;
            return (
              <g key={`${datum.label}-${index}`} class="bar-row">
                <text x={margin.left - 8} y={y + barHeight / 2 + 4} text-anchor="end">
                  {datum.label}
                </text>
                <rect
                  x={margin.left}
                  y={y}
                  width={width}
                  height={barHeight}
                  rx="4"
                  fill={datum.color ?? props.color}
                />
                <text
                  x={Math.min(margin.left + width + 8, chartWidth - 10)}
                  y={y + barHeight / 2 + 4}
                >
                  {formatValue(datum.value, valueKind)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    );
  }

  const margin = { top: 18, right: 20, bottom: 46, left: 38 };
  const plotWidth = chartWidth - margin.left - margin.right;
  const plotHeight = chartHeight - margin.top - margin.bottom;
  const slotWidth = plotWidth / Math.max(1, props.data.length);
  const barWidth = Math.min(58, slotWidth * 0.58);
  const baselineY = margin.top + plotHeight;
  const markerY = props.marker
    ? margin.top + plotHeight - (clamp(props.marker.value, 0, scaleMax) / scaleMax) * plotHeight
    : null;

  return (
    <svg
      class="svg-chart"
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      role="img"
      aria-label={props.chartLabel}
      preserveAspectRatio="none"
    >
      <title>{props.chartLabel}</title>
      <g class="chart-grid" aria-hidden="true">
        {ticks.map((tick) => {
          const y = margin.top + plotHeight - (tick / scaleMax) * plotHeight;
          return (
            <g key={tick}>
              <line x1={margin.left} x2={chartWidth - margin.right} y1={y} y2={y} />
              <text x={margin.left - 8} y={y + 4} text-anchor="end">
                {formatValue(tick, valueKind)}
              </text>
            </g>
          );
        })}
      </g>
      {markerY !== null && props.marker && (
        <g class="chart-marker" aria-hidden="true">
          <line x1={margin.left} x2={chartWidth - margin.right} y1={markerY} y2={markerY} />
          <text x={chartWidth - margin.right} y={markerY - 5} text-anchor="end">
            {props.marker.label}
          </text>
        </g>
      )}
      <g class="bar-series">
        {props.data.map((datum, index) => {
          const height = (clampNonNegative(datum.value) / scaleMax) * plotHeight;
          const x = margin.left + index * slotWidth + (slotWidth - barWidth) / 2;
          const y = baselineY - height;
          return (
            <g key={`${datum.label}-${index}`} class="bar-column">
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={height}
                rx="4"
                fill={datum.color ?? props.color}
              />
              <text x={x + barWidth / 2} y={y - 5} text-anchor="middle">
                {formatValue(datum.value, valueKind)}
              </text>
              <text x={x + barWidth / 2} y={baselineY + 18} text-anchor="middle">
                {datum.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function getScaleMax(
  values: number[],
  markerValue: number | undefined,
  requestedMax: number | undefined,
): number {
  if (requestedMax !== undefined && requestedMax > 0) return requestedMax;
  const rawMax = Math.max(0, markerValue ?? 0, ...values);
  return niceCeil(rawMax);
}

function niceCeil(value: number): number {
  if (value <= 1) return 1;
  if (value <= 5) return Math.ceil(value);
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * base;
}

function formatValue(value: number, valueKind: "number" | "percent"): string {
  const rounded = Math.round(value * 10) / 10;
  const formatted = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return valueKind === "percent" ? `${formatted}%` : formatted;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].filter((tick) => tick >= 0);
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
