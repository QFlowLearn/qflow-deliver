import { describe, expect, it } from "vitest";
import {
  isKeywordTranslationMimeType,
  projectKeywordTranslationCatalogDelivery,
} from "../../../packages/renderer-adapter/src/keyword-translation-catalog";

describe("keyword translation catalog delivery projection", () => {
  it.each([
    ["exact-language", false],
    ["primary-language", true],
    ["default", true],
    ["unlanguaged", true],
  ] as const)(
    "projects %s language resolution and fallback status",
    (selectionReason, fallback) => {
      const projection = projectKeywordTranslationCatalogDelivery({
        requestedLanguage: "es-MX",
        delivery: {
          referenceId: "keyword-reference",
          catalogId: "photosynthesis-supports",
          qtiName: "span",
          availableSupports: ["keyword-translation"],
          matches: [
            {
              catalogId: "photosynthesis-supports",
              support: "keyword-translation",
              default: selectionReason === "default",
              selectionReason,
              language: selectionReason === "unlanguaged" ? undefined : "es",
              html: [{ kind: "text", text: "Fotosíntesis" }],
              files: [],
            },
          ],
        },
      });

      expect(projection).toMatchObject({
        referenceId: "keyword-reference",
        requestedLanguage: "es-MX",
        resolvedLanguage: selectionReason === "unlanguaged" ? null : "es",
        selectionReason,
        fallback,
      });
    },
  );

  it("allows only explicit text, audio, and video MIME types", () => {
    expect(isKeywordTranslationMimeType("text/plain")).toBe(true);
    expect(isKeywordTranslationMimeType("text/html")).toBe(true);
    expect(isKeywordTranslationMimeType("audio/mpeg")).toBe(true);
    expect(isKeywordTranslationMimeType("video/mp4")).toBe(true);
    expect(isKeywordTranslationMimeType("application/pdf")).toBe(false);
    expect(isKeywordTranslationMimeType("image/png")).toBe(false);
    expect(isKeywordTranslationMimeType(undefined)).toBe(false);
  });
});
