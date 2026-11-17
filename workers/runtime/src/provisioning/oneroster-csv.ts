import type {
  OneRosterCsvPackageDiagnostic,
  OneRosterCsvValidatedFullPackage,
  OneRosterResolvedStudentEnrollment,
} from "@longsightgroup/oneroster";
import {
  formatOneRosterDiagnosticLocation,
  formatOneRosterUserDisplayName,
  getOneRosterRecordStatus,
  getOneRosterUserStatus,
  iterateResolvedStudentEnrollments,
  parseAndValidateOneRosterCsvFullFiles,
  parseAndValidateOneRosterCsvFullZip,
} from "@longsightgroup/oneroster";
import type { RosterProvisioningError } from "@harbor/attempt-protocol";

const VALIDATION_OPTIONS = { referenceMode: "allRows" as const };

/** Row shape consumed by Harbor's roster planning path. */
export interface OneRosterTranslatedRosterRow {
  rowNumber: number;
  raw: Record<string, string>;
}

/** Result of strict OneRoster parsing and Harbor roster projection. */
export interface OneRosterTranslationResult {
  rows: OneRosterTranslatedRosterRow[];
  errors: RosterProvisioningError[];
  rowCount: number;
  validatedPackage: OneRosterCsvValidatedFullPackage | null;
}

/** Parse strict OneRoster 1.2 CSV file contents and project student roster rows. */
export function translateOneRosterCsvFiles(
  files: Record<string, string>,
): OneRosterTranslationResult {
  const validatedResult = parseAndValidateOneRosterCsvFullFiles(files, VALIDATION_OPTIONS);
  return validatedResult._tag === "err"
    ? createFailedTranslation(validatedResult.error)
    : projectOneRosterPackage(validatedResult.value);
}

/** Parse strict OneRoster 1.2 ZIP bytes and project student roster rows. */
export function translateOneRosterCsvZip(bytes: Uint8Array): OneRosterTranslationResult {
  const validatedResult = parseAndValidateOneRosterCsvFullZip(bytes, VALIDATION_OPTIONS);
  return validatedResult._tag === "err"
    ? createFailedTranslation(validatedResult.error)
    : projectOneRosterPackage(validatedResult.value);
}

/** Canonicalize JSON file-map input for deterministic provisioning run hashing. */
export function canonicalizeOneRosterFiles(files: Record<string, string>): string {
  return JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function projectOneRosterPackage(
  validatedPackage: OneRosterCsvValidatedFullPackage,
): OneRosterTranslationResult {
  const studentEnrollmentCount = validatedPackage.fullPackage.rosteringPackage.enrollments.filter(
    (enrollment) => enrollment.role === "student",
  ).length;
  return {
    rows: [...iterateResolvedStudentEnrollments(validatedPackage, { includeInactive: true })].map(
      projectStudentEnrollment,
    ),
    errors: [],
    rowCount: studentEnrollmentCount,
    validatedPackage,
  };
}

function projectStudentEnrollment(
  resolvedEnrollment: OneRosterResolvedStudentEnrollment,
): OneRosterTranslatedRosterRow {
  const { classRecord, enrollment, user } = resolvedEnrollment;
  const membershipStatus =
    getOneRosterUserStatus(user) === "inactive" ||
    getOneRosterRecordStatus(enrollment) === "inactive"
      ? "inactive"
      : "active";
  return {
    rowNumber: enrollment.rowNumber,
    raw: {
      learner_id: user.sourcedId,
      display_name: formatOneRosterUserDisplayName(user),
      email: user.email ?? "",
      section_id: classRecord.sourcedId,
      section_name: classRecord.title,
      status: membershipStatus,
      oneroster_enrollment_sourced_id: enrollment.sourcedId,
      oneroster_school_sourced_id: enrollment.schoolSourcedId || classRecord.schoolSourcedId || "",
      oneroster_course_sourced_id: classRecord.courseSourcedId,
      oneroster_term_sourced_ids: classRecord.termSourcedIds.join(","),
    },
  };
}

function createFailedTranslation(
  diagnostics: readonly OneRosterCsvPackageDiagnostic[] | OneRosterCsvPackageDiagnostic,
): OneRosterTranslationResult {
  const normalizedDiagnostics = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
  return {
    rows: [],
    errors: normalizedDiagnostics.map(mapOneRosterDiagnostic),
    rowCount: 0,
    validatedPackage: null,
  };
}

function mapOneRosterDiagnostic(
  diagnostic: OneRosterCsvPackageDiagnostic,
): RosterProvisioningError {
  return {
    rowNumber: diagnostic.rowNumber ?? null,
    field: formatOneRosterDiagnosticLocation(diagnostic),
    code: `oneroster.${diagnostic.code}`,
    message: diagnostic.message,
    rawRow: null,
  };
}
