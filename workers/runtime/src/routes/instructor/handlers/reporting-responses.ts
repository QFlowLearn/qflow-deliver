import type { InstructorContext } from "../context";

const CSV_CONTENT_TYPE = "text/csv;charset=utf-8";

export function respondCsvAttachment(
  body: string,
  filename: string,
  contentType = CSV_CONTENT_TYPE,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export function respondJsonOrCsv<T>(
  c: InstructorContext,
  url: URL,
  json: T,
  buildCsv: (exportType: string) => string,
  input: { defaultType: string; filenameBase: string },
): Response {
  if (url.searchParams.get("format") === "csv") {
    const exportType = url.searchParams.get("type") ?? input.defaultType;
    return respondCsvAttachment(
      buildCsv(exportType),
      `${input.filenameBase}-${exportType}-report.csv`,
    );
  }

  return c.json(json, 200);
}

export function respondCsvOrJson<T>(
  c: InstructorContext,
  url: URL,
  json: T,
  buildCsv: () => string,
  filename: string,
  contentType = CSV_CONTENT_TYPE,
): Response {
  if (url.searchParams.get("format") === "csv") {
    return respondCsvAttachment(buildCsv(), filename, contentType);
  }

  return c.json(json, 200);
}

export function respondZipAttachment(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes.slice(), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
