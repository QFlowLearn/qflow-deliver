import { describe, expect, it } from "vitest";
import {
  applyAccommodationSupportCounts,
  buildAccommodationSupportEvidencePayload,
  createEmptyInstructorAccommodationEvidenceSummary,
  INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS,
  projectAttemptEventAccommodationEvidence,
  readAccommodationEvidenceLanguage,
} from "@harbor/attempt-protocol";

describe("accommodation evidence helpers", () => {
  it("initializes every configured instructor evidence projection", () => {
    const summary = createEmptyInstructorAccommodationEvidenceSummary();

    expect(Object.keys(summary)).toEqual(
      INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.map(({ summaryField }) => summaryField),
    );
    expect(Object.values(summary)).toEqual(INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.map(() => 0));
    expect(
      new Set(INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.map(({ csvColumn }) => csvColumn)).size,
    ).toBe(INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.length);
  });

  it("builds canonical scalar language fields from catalog entries", () => {
    const payload = buildAccommodationSupportEvidencePayload({
      support: "keyword-translation",
      state: "activated",
      activation: "available",
      entries: [
        {
          key: "k1",
          referenceId: "ref-1",
          support: "keyword-translation",
          catalogId: "catalog-1",
          label: "Keyword Translation",
          requestedLanguage: "fr-CA",
          language: "es",
          selectionReason: "primary-language",
          assetReference: "items/translations/sample-es.txt",
          href: "items/translations/sample-es.txt",
          url: "/assets/items/translations/sample-es.txt",
          mediaType: "text/plain",
          text: null,
        },
      ],
      reason: "translation-shown",
      control: "keyword-translation-dialog",
    });

    expect(payload.requestedLanguage).toBe("fr-CA");
    expect(payload.resolvedLanguage).toBe("es");
    expect(payload.selectionReason).toBe("primary-language");
    expect(payload).not.toHaveProperty("requestedLanguages");
    expect(payload).not.toHaveProperty("sourceHrefs");
  });

  it("does not project raw or signed catalog hrefs into evidence", () => {
    const payload = buildAccommodationSupportEvidencePayload({
      support: "keyword-translation",
      state: "unavailable",
      activation: "available",
      entries: [
        {
          key: "unsafe-reference",
          referenceId: "ref-unsafe",
          support: "keyword-translation",
          catalogId: "catalog-unsafe",
          label: "Keyword Translation",
          requestedLanguage: "fr-CA",
          language: null,
          selectionReason: "unavailable",
          assetReference: null,
          href: "https://delivery.example/signed?token=secret",
          url: null,
          mediaType: "text/html",
          text: null,
        },
      ],
    });

    expect(JSON.stringify(payload)).not.toContain("delivery.example");
    expect(JSON.stringify(payload)).not.toContain("token=secret");
  });

  it("projects keyword language attempt events into accommodation evidence", () => {
    expect(
      projectAttemptEventAccommodationEvidence(
        "keyword-translation.language.selected",
        {
          requestedLanguage: "FR-ca",
        },
        "fr-CA",
      ),
    ).toEqual({
      support: "keyword-translation",
      state: "language-selected",
      requestedLanguage: "FR-ca",
      resolvedLanguage: "fr-CA",
      eventSource: "attempt-event",
    });
  });

  it("reads scalar language fields with legacy list fallback", () => {
    expect(
      readAccommodationEvidenceLanguage(
        { requestedLanguages: ["es-MX"], resolvedLanguages: ["es"] },
        "requestedLanguage",
      ),
    ).toBe("es-MX");
    expect(readAccommodationEvidenceLanguage({ resolvedLanguage: "es" }, "resolvedLanguage")).toBe(
      "es",
    );
  });

  it("maps generic accommodation counts into instructor summary fields", () => {
    const summary = {
      glossaryAvailableCount: 0,
      glossaryOpenedCount: 0,
      glossaryUnavailableCount: 0,
      keywordTranslationAvailableCount: 0,
      keywordTranslationUsedCount: 0,
      keywordTranslationUnavailableCount: 0,
    };
    const counts = new Map<string, Map<string, number>>([
      [
        "glossary-on-screen",
        new Map([
          ["offered", 2],
          ["opened", 1],
        ]),
      ],
      [
        "keyword-translation",
        new Map([
          ["offered", 1],
          ["activated", 3],
        ]),
      ],
    ]);

    applyAccommodationSupportCounts(summary, counts);

    expect(summary).toEqual({
      glossaryAvailableCount: 2,
      glossaryOpenedCount: 1,
      glossaryUnavailableCount: 0,
      keywordTranslationAvailableCount: 1,
      keywordTranslationUsedCount: 3,
      keywordTranslationUnavailableCount: 0,
    });
  });
});
