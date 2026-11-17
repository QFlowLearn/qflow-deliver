type ChartMarker = {
  value: number;
  label: string;
};

export default function HarborSvgLineChart(props: {
  chartLabel: string;
  labels: string[];
  values: number[];
  color: string;
  marker?: ChartMarker;
  maxValue?: number;
  valueKind?: "number" | "percent";
}) {
  const valueKind = props.valueKind ?? "percent";
  const chartWidth = 640;
  const chartHeight = 210;
  const margin = { top: 18, right: 36, bottom: 44, left: 52 };
  const plotWidth = chartWidth - margin.left - margin.right;
  const plotHeight = chartHeight - margin.top - margin.bottom;
  const scaleMax = Math.max(1, props.maxValue ?? 100);
  const points = props.values.map((value, index) => {
    const x =
      props.values.length === 1
        ? margin.left + plotWidth / 2
        : margin.left + (index / (props.values.length - 1)) * plotWidth;
    const y = margin.top + plotHeight - (clamp(value, 0, scaleMax) / scaleMax) * plotHeight;
    return {
      label: props.labels[index] ?? `Point ${index + 1}`,
      value,
      x,
      y,
      anchor: index === 0 ? "start" : index === props.values.length - 1 ? "end" : "middle",
    };
  });
  const linePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
  const markerY = props.marker
    ? margin.top + plotHeight - (clamp(props.marker.value, 0, scaleMax) / scaleMax) * plotHeight
    : null;
  const labelStep = props.labels.length <= 6 ? 1 : Math.ceil(props.labels.length / 5);
  const visibleLabels = points.filter(
    (_, index) => index === 0 || index === props.labels.length - 1 || index % labelStep === 0,
  );

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
        {[0, scaleMax / 2, scaleMax].map((tick) => {
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
      <polyline
        class="trend-line"
        points={linePoints}
        stroke={props.color}
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <g class="trend-points">
        {points.map((point) => (
          <circle key={point.label} cx={point.x} cy={point.y} r="4" fill={props.color}>
            <title>
              {point.label}: {formatValue(point.value, valueKind)}
            </title>
          </circle>
        ))}
      </g>
      <g class="axis-labels" aria-hidden="true">
        {visibleLabels.map((point) => (
          <text key={point.label} x={point.x} y={chartHeight - 10} text-anchor={point.anchor}>
            {point.label}
          </text>
        ))}
      </g>
    </svg>
  );
}

function formatValue(value: number, valueKind: "number" | "percent"): string {
  const rounded = Math.round(value * 10) / 10;
  const formatted = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return valueKind === "percent" ? `${formatted}%` : formatted;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
