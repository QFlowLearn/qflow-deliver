export type CsvCell = string | number | boolean | null | undefined;

export function buildCsv(rows: CsvCell[][]): string {
  return rows
    .map((row) => row.map((cell) => escapeCsvCell(formatCsvCell(cell))).join(","))
    .join("\n");
}

export function formatCsvNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

export function escapeCsvCell(value: string): string {
  const safeValue = neutralizeSpreadsheetFormula(value);
  if (!/[",\n\r]/.test(safeValue)) {
    return safeValue;
  }

  return `"${safeValue.replaceAll('"', '""')}"`;
}

function formatCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function neutralizeSpreadsheetFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
