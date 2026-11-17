import { describe, expect, it } from "vitest";
import {
  oneRosterCsvBindingVersion,
  oneRosterCsvManifestOneRosterVersion,
} from "@longsightgroup/oneroster";

import { planOneRosterHierarchy } from "../src/provisioning/oneroster-apply";
import {
  canonicalizeOneRosterFiles,
  translateOneRosterCsvFiles,
} from "../src/provisioning/oneroster-csv";
import {
  buildOneRosterDeltaWithdrawalFiles,
  buildOneRosterFiles,
} from "./fixtures/oneroster/build-fixtures";

describe("oneroster csv adapter", () => {
  it("uses the corrected CSV Binding 1.2.1 rules with a 1.2 manifest version", () => {
    expect(oneRosterCsvBindingVersion).toBe("1.2.1");
    expect(oneRosterCsvManifestOneRosterVersion).toBe("1.2");
  });

  it("canonicalizes file maps deterministically without changing supplied paths", () => {
    expect(
      canonicalizeOneRosterFiles({
        "b.csv": "2",
        "a.csv": "1",
      }),
    ).toBe(
      canonicalizeOneRosterFiles({
        "a.csv": "1",
        "b.csv": "2",
      }),
    );

    expect(canonicalizeOneRosterFiles({ "nested/manifest.csv": "m" })).not.toBe(
      canonicalizeOneRosterFiles({ "manifest.csv": "m" }),
    );
  });

  it("counts class hierarchy records from planned roster sections", () => {
    const translated = translateOneRosterCsvFiles(buildOneRosterFilesWithStaffOnlyClass());
    expect(translated.errors).toEqual([]);
    if (translated.validatedPackage === null) {
      throw new Error("Expected valid OneRoster package");
    }

    const hierarchyPlan = planOneRosterHierarchy({
      validatedPackage: translated.validatedPackage,
      sections: [{ externalId: "class-bio-1", harborId: "section_1" }],
    });

    expect(hierarchyPlan.summary.classMetadataUpsertCount).toBe(1);
    expect(hierarchyPlan.summary.classStaffUpsertCount).toBe(1);
    expect(hierarchyPlan.summary.staffUserUpsertCount).toBe(1);
  });

  it("treats delta tobedeleted lifecycle as inactive for roster membership projection", () => {
    const translated = translateOneRosterCsvFiles(buildOneRosterDeltaWithdrawalFiles());

    expect(translated.errors).toEqual([]);
    expect(translated.rows[0]?.raw.status).toBe("inactive");
  });

  it("treats disabled users as inactive even when enrollment lifecycle is active", () => {
    const files = buildOneRosterFiles();
    const translated = translateOneRosterCsvFiles({
      ...files,
      "users.csv": files["users.csv"].replace(
        "student-1,,,true,ada@example.edu",
        "student-1,,,false,ada@example.edu",
      ),
    });

    expect(translated.errors).toEqual([]);
    expect(translated.rows[0]?.raw.status).toBe("inactive");
  });

  it("requires paired subjects and subjectCodes values under CSV Binding 1.2.1", () => {
    const files = buildOneRosterFiles();
    const translated = translateOneRosterCsvFiles({
      ...files,
      "courses.csv": files["courses.csv"].replace(",Science,SCI", ",Science,"),
    });

    expect(translated.validatedPackage).toBeNull();
    expect(translated.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.row.invalid_list",
          field: expect.stringContaining("courses.csv"),
        }),
      ]),
    );
  });

  it("requires users.userIds entries to use the corrected type:id syntax", () => {
    const files = buildOneRosterFiles();
    const translated = translateOneRosterCsvFiles({
      ...files,
      "users.csv": files["users.csv"].replace(
        "student-1,,,true,ada@example.edu,",
        "student-1,,,true,ada@example.edu,ada-local-id",
      ),
    });

    expect(translated.validatedPackage).toBeNull();
    expect(translated.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "oneroster.row.invalid_list",
          field: expect.stringContaining("users.csv"),
        }),
      ]),
    );
  });
});

function buildOneRosterFilesWithStaffOnlyClass(): Record<string, string> {
  const files = buildOneRosterFiles();
  return {
    ...files,
    "classes.csv": [
      files["classes.csv"],
      [
        "class-staff-only",
        "",
        "",
        "Biology I - Office Hours",
        "9",
        "course-bio-1",
        "BIO-1-OH",
        "scheduled",
        "Room 13",
        "school-1",
        "term-fall-2026",
        "Science",
        "SCI",
        "2",
      ].join(","),
    ].join("\n"),
    "enrollments.csv": [
      files["enrollments.csv"],
      [
        "enrollment-teacher-office-hours",
        "",
        "",
        "class-staff-only",
        "school-1",
        "teacher-1",
        "teacher",
        "true",
        "2026-08-10",
        "2026-12-18",
      ].join(","),
    ].join("\n"),
  };
}
