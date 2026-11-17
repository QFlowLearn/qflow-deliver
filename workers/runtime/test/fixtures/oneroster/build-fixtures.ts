import type {
  OneRosterCsvDataFileName,
  OneRosterCsvPackageWriteDiagnostic,
  OneRosterManifestFileMode,
} from "@longsightgroup/oneroster";
import {
  createOneRosterManifestFileModes,
  formatOneRosterDiagnosticLocation,
  oneRosterCsvDataFileNames,
  oneRosterCsvTableHeaders,
  oneRosterManifestRows,
  writeOneRosterCsvPackageZipFromFiles,
} from "@longsightgroup/oneroster";
import JSZip from "jszip";

type ManifestModeOverrides = Partial<Record<OneRosterCsvDataFileName, OneRosterManifestFileMode>>;

function csv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join(",")).join("\n");
}

/** Build a strict OneRoster 1.2 manifest for the supplied fixture files. */
export function buildOneRosterManifest(
  files: Record<string, string>,
  modeOverrides: ManifestModeOverrides = {},
): string {
  const presentFiles = oneRosterCsvDataFileNames.filter(
    (fileName) => files[fileName] !== undefined,
  );
  const fileModes = createOneRosterManifestFileModes(presentFiles, modeOverrides);
  return csv(oneRosterManifestRows(fileModes));
}

/** Return a copy of a fixture file map without one file. */
export function withoutOneRosterFile(
  files: Record<string, string>,
  omittedFileName: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).filter(([fileName]) => fileName !== omittedFileName),
  );
}

/** Build a multipart form containing a package-written valid OneRoster ZIP. */
export function buildOneRosterZipForm(files: Record<string, string>): FormData {
  const zipResult = writeOneRosterCsvPackageZipFromFiles(files);
  if (zipResult._tag === "err") {
    throw new Error(formatFixtureDiagnostics(zipResult.error));
  }

  return buildZipForm(arrayBufferFromBytes(zipResult.value));
}

/** Build a multipart form containing arbitrary ZIP entries for malformed ZIP intake tests. */
export async function buildRawOneRosterZipForm(files: Record<string, string>): Promise<FormData> {
  const zip = new JSZip();
  for (const [fileName, text] of Object.entries(files)) {
    zip.file(fileName, text);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return buildZipForm(blob);
}

function buildZipForm(zipBlobPart: BlobPart): FormData {
  const form = new FormData();
  form.set("sourceName", "District OneRoster ZIP");
  form.set(
    "actor",
    JSON.stringify({
      role: "instructor",
      actorId: "inst_roster",
      displayName: "Roster Manager",
    }),
  );
  form.set("zip", new File([zipBlobPart], "oneroster.zip", { type: "application/zip" }));
  return form;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function formatFixtureDiagnostics(
  diagnostics: readonly OneRosterCsvPackageWriteDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => {
      const location = formatOneRosterDiagnosticLocation(diagnostic);
      return location === null
        ? `${diagnostic.code}: ${diagnostic.message}`
        : `${diagnostic.code} at ${location}: ${diagnostic.message}`;
    })
    .join("; ");
}

/** Build a minimal strict OneRoster fixture file map. */
export function buildOneRosterFiles(): Record<string, string> {
  const files = {
    "orgs.csv": csv([
      oneRosterCsvTableHeaders["orgs.csv"],
      ["district-1", "", "", "Example District", "district", "DIST-1", ""],
      ["school-1", "", "", "Example High School", "school", "SCH-1", "district-1"],
    ]),
    "academicSessions.csv": csv([
      oneRosterCsvTableHeaders["academicSessions.csv"],
      [
        "year-2026",
        "",
        "",
        "2026 School Year",
        "schoolYear",
        "2026-07-01",
        "2027-06-30",
        "",
        "2026",
      ],
      [
        "term-fall-2026",
        "",
        "",
        "Fall 2026",
        "term",
        "2026-08-10",
        "2026-12-18",
        "year-2026",
        "2026",
      ],
    ]),
    "courses.csv": csv([
      oneRosterCsvTableHeaders["courses.csv"],
      [
        "course-bio-1",
        "",
        "",
        "year-2026",
        "Biology I",
        "BIO-1",
        "9",
        "school-1",
        "Science",
        "SCI",
      ],
    ]),
    "classes.csv": csv([
      oneRosterCsvTableHeaders["classes.csv"],
      [
        "class-bio-1",
        "",
        "",
        "Biology I - Period 1",
        "9",
        "course-bio-1",
        "BIO-1-P1",
        "scheduled",
        "Room 12",
        "school-1",
        "term-fall-2026",
        "Science",
        "SCI",
        "1",
      ],
    ]),
    "users.csv": csv([
      oneRosterCsvTableHeaders["users.csv"],
      [
        "student-1",
        "",
        "",
        "true",
        "ada@example.edu",
        "",
        "Ada",
        "Lovelace",
        "",
        "S-1",
        "ada@example.edu",
        "",
        "",
        "",
        "9",
        "",
        "",
        "",
        "",
        "",
        "school-1",
        "",
      ],
      [
        "teacher-1",
        "",
        "",
        "true",
        "teacher@example.edu",
        "",
        "Marie",
        "Curie",
        "",
        "T-1",
        "teacher@example.edu",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "school-1",
        "",
      ],
    ]),
    "enrollments.csv": csv([
      oneRosterCsvTableHeaders["enrollments.csv"],
      [
        "enrollment-student-1",
        "",
        "",
        "class-bio-1",
        "school-1",
        "student-1",
        "student",
        "",
        "2026-08-10",
        "2026-12-18",
      ],
      [
        "enrollment-teacher-1",
        "",
        "",
        "class-bio-1",
        "school-1",
        "teacher-1",
        "teacher",
        "true",
        "2026-08-10",
        "2026-12-18",
      ],
    ]),
    "resources.csv": csv([
      oneRosterCsvTableHeaders["resources.csv"],
      [
        "resource-bio-guide",
        "",
        "",
        "vendor-guide-1",
        "Biology Study Guide",
        "student",
        "primary",
        "vendor-1",
        "app-1",
      ],
    ]),
    "classResources.csv": csv([
      oneRosterCsvTableHeaders["classResources.csv"],
      [
        "class-resource-1",
        "",
        "",
        "Biology Guide for Period 1",
        "class-bio-1",
        "resource-bio-guide",
      ],
    ]),
    "courseResources.csv": csv([
      oneRosterCsvTableHeaders["courseResources.csv"],
      [
        "course-resource-1",
        "",
        "",
        "Biology Guide for Course",
        "course-bio-1",
        "resource-bio-guide",
      ],
    ]),
    "categories.csv": csv([
      oneRosterCsvTableHeaders["categories.csv"],
      ["category-tests", "", "", "Tests", "100"],
    ]),
    "lineItems.csv": csv([
      oneRosterCsvTableHeaders["lineItems.csv"],
      [
        "lineitem-midterm",
        "",
        "",
        "Biology Midterm",
        "",
        "2026-10-01",
        "2026-10-15",
        "class-bio-1",
        "category-tests",
        "term-fall-2026",
        "0",
        "100",
        "school-1",
      ],
    ]),
    "scoreScales.csv": csv([
      oneRosterCsvTableHeaders["scoreScales.csv"],
      [
        "scale-percent",
        "",
        "",
        "Percent",
        "numeric",
        "school-1",
        "course-bio-1",
        "class-bio-1",
        "{0:100}",
      ],
    ]),
    "results.csv": csv([
      oneRosterCsvTableHeaders["results.csv"],
      [
        "result-ada-midterm",
        "",
        "",
        "lineitem-midterm",
        "student-1",
        "fully graded",
        "96",
        "2026-10-16",
        "Imported SIS result",
        "",
        "class-bio-1",
        "false",
        "false",
        "false",
        "false",
      ],
    ]),
    "resultScoreScales.csv": csv([
      oneRosterCsvTableHeaders["resultScoreScales.csv"],
      ["result-scale-midterm", "", "", "Midterm Percent", "result-ada-midterm", "scale-percent"],
    ]),
  };
  return {
    "manifest.csv": buildOneRosterManifest(files),
    ...files,
  };
}

/** Build a strict OneRoster fixture file map with delta enrollment withdrawals. */
export function buildOneRosterDeltaWithdrawalFiles(): Record<string, string> {
  const files = buildOneRosterFiles();
  return {
    ...files,
    "manifest.csv": buildOneRosterManifest(files, { "enrollments.csv": "delta" }),
    "enrollments.csv": csv([
      oneRosterCsvTableHeaders["enrollments.csv"],
      [
        "enrollment-student-1",
        "tobedeleted",
        "2026-06-30T00:00:00.000Z",
        "class-bio-1",
        "school-1",
        "student-1",
        "student",
        "",
        "2026-08-10",
        "2026-12-18",
      ],
      [
        "enrollment-teacher-1",
        "active",
        "2026-06-30T00:00:00.000Z",
        "class-bio-1",
        "school-1",
        "teacher-1",
        "teacher",
        "true",
        "2026-08-10",
        "2026-12-18",
      ],
    ]),
  };
}
