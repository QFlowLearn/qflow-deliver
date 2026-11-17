import { describe, expect, it } from "vitest";
import type { QtiCatalogSupportResolution } from "@longsightgroup/qti3-core";
import {
  readHarborAfaPnpSupport,
  resolveHarborAfaPnpEntitlement,
  resolveHarborPnpPolicy,
  resolveHarborKeywordTranslationLanguage,
  resolveHarborKeywordTranslationLanguages,
  resolveHarborCatalogSupportEntries,
  type HarborAfaPnpSupport,
} from "@harbor/attempt-protocol";

function pnpActivation(
  input: Parameters<typeof resolveHarborPnpPolicy>[0],
  support: HarborAfaPnpSupport,
) {
  return resolveHarborPnpPolicy(input).activations[support];
}

describe("Harbor catalog support helpers", () => {
  it("resolves item-relative catalog hrefs to delivery asset URLs and keeps fragments", () => {
    const entries = resolveHarborCatalogSupportEntries({
      resolution: buildResolution(),
      itemHref: "items/media-supports.xml",
      assets: [
        {
          href: "items/media/described.mp4",
          url: "/api/content/assets/asset:described.mp4?attemptId=attempt_1",
          mediaType: "video/mp4",
        },
        {
          href: "items/transcripts/presentation-en.html",
          url: "/api/content/assets/asset:presentation-en.html?attemptId=attempt_1",
          mediaType: "text/html",
        },
      ],
      supports: ["transcript", "audio-description", "caption"],
    });
    const keys = entries.map((entry) => entry.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          support: "audio-description",
          href: "media/described.mp4#t=2,9",
          url: "/api/content/assets/asset:described.mp4?attemptId=attempt_1#t=2,9",
          mediaType: "video/mp4",
        }),
        expect.objectContaining({
          support: "transcript",
          href: "transcripts/presentation-en.html",
          url: "/api/content/assets/asset:presentation-en.html?attemptId=attempt_1",
          mediaType: "text/html",
        }),
        expect.objectContaining({
          support: "transcript",
          href: null,
          url: null,
          mediaType: "text/html",
          text: "Inline transcript summary.",
        }),
        expect.objectContaining({
          support: "transcript",
          href: null,
          url: null,
          mediaType: "text/html",
          text: "Resumen de transcripcion.",
        }),
        expect.objectContaining({
          support: "caption",
          href: "captions/missing-en.vtt",
          url: null,
          mediaType: "text/vtt",
        }),
      ]),
    );
  });

  it("applies PNP activation precedence over legacy shell tools", () => {
    const blockedTranscriptInput: Parameters<typeof resolveHarborPnpPolicy>[0] = {
      shellTools: { transcripts: true },
      pnpEntitlement: { prohibitSet: ["transcript"] },
    };

    expect(pnpActivation(blockedTranscriptInput, "transcript")).toBe("blocked");
    expect(resolveHarborPnpPolicy(blockedTranscriptInput).catalogSupports).not.toContain(
      "transcript",
    );
    expect(
      pnpActivation(
        { pnpEntitlement: { activateAtInitializationSet: ["audio-description"] } },
        "audio-description",
      ),
    ).toBe("active");
    expect(
      pnpActivation(
        { pnpEntitlement: { activateAsOptionSet: ["sign-language"] } },
        "sign-language",
      ),
    ).toBe("available");
    expect(
      pnpActivation(
        { pnpEntitlement: { activateAtInitializationSet: ["keyword-emphasis"] } },
        "keyword-emphasis",
      ),
    ).toBe("active");
    expect(
      resolveHarborPnpPolicy({
        pnpEntitlement: { activateAtInitializationSet: ["keyword-emphasis"] },
      }).catalogSupports,
    ).not.toContain("keyword-emphasis");
  });

  it("dedupes explicit language preferences with renderer keyword translation", () => {
    expect(
      resolveHarborPnpPolicy({
        rendererPnp: { keywordTranslationLanguage: "es" },
        pnpEntitlement: { languages: ["en", "es", "en"] },
      }).languages,
    ).toEqual(["es", "en"]);
  });

  it("keeps keyword language selection within the ordered entitlement", () => {
    const policy = {
      rendererPnp: { keywordTranslationLanguage: "fr-CA" },
      pnpEntitlement: { languages: ["es", "fr-CA", "de"] },
    };

    expect(resolveHarborKeywordTranslationLanguages(policy)).toEqual(["fr-CA", "es", "de"]);
    expect(resolveHarborKeywordTranslationLanguage({ ...policy, selectedLanguage: "ES" })).toBe(
      "es",
    );
    expect(resolveHarborKeywordTranslationLanguage({ ...policy, selectedLanguage: "ja" })).toBe(
      "fr-CA",
    );
  });

  it("normalizes legacy PNP aliases to canonical support names", () => {
    const legacyTextToSpeech = readHarborAfaPnpSupport("text-to-speech");
    const legacySingleColumn = readHarborAfaPnpSupport("single-column-layout");
    const legacyNotepad = readHarborAfaPnpSupport("notepad");

    expect(legacyTextToSpeech).toBe("spoken");
    expect(legacySingleColumn).toBe("layout-single-column");
    expect(legacyNotepad).toBe("note-taking-on-screen");
    expect(
      resolveHarborAfaPnpEntitlement({
        shellTools: { textToSpeech: true, notepad: true },
        rendererPnp: { layoutSingleColumn: true },
        pnpEntitlement: {
          activateAtInitializationSet: legacyTextToSpeech ? [legacyTextToSpeech] : [],
          activateAsOptionSet: legacySingleColumn ? [legacySingleColumn] : [],
          prohibitSet: legacyNotepad ? [legacyNotepad] : [],
        },
      }),
    ).toMatchObject({
      supports: ["spoken", "layout-single-column"],
      prohibitSet: ["note-taking-on-screen"],
    });
    expect(
      pnpActivation(
        { pnpEntitlement: { prohibitSet: legacyTextToSpeech ? [legacyTextToSpeech] : [] } },
        "spoken",
      ),
    ).toBe("blocked");
    expect(
      resolveHarborPnpPolicy({ shellTools: { textToSpeech: true } }).catalogSupports,
    ).toContain("spoken");
  });
});

function buildResolution(): QtiCatalogSupportResolution {
  return {
    itemIdentifier: "media-supports",
    references: [
      {
        referenceId: "catalog-reference-1",
        idref: "audio-transcript",
        qtiName: "qti-prompt",
        matches: [
          {
            catalogId: "audio-transcript",
            support: "transcript",
            default: true,
            selectionReason: "default",
            language: "en",
            attributes: {},
            cardAttributes: {},
            catalogAttributes: {},
            fileHrefs: [
              {
                href: "transcripts/presentation-en.html",
                mimeType: "text/html",
                attributes: {},
              },
            ],
            htmlContent: {
              text: "Inline transcript summary.",
              children: [],
              attributes: {},
            },
          },
          {
            catalogId: "audio-transcript",
            support: "transcript",
            default: false,
            selectionReason: "available",
            language: "es",
            attributes: {},
            cardAttributes: {},
            catalogAttributes: {},
            fileHrefs: [],
            htmlContent: {
              text: "Resumen de transcripcion.",
              children: [],
              attributes: {},
            },
          },
        ],
      },
      {
        referenceId: "catalog-reference-2",
        idref: "media-alternatives",
        qtiName: "div",
        matches: [
          {
            catalogId: "media-alternatives",
            support: "audio-description",
            default: true,
            selectionReason: "default",
            attributes: {},
            cardAttributes: {},
            catalogAttributes: {},
            fileHrefs: [
              {
                href: "media/described.mp4#t=2,9",
                mimeType: "video/mp4",
                attributes: {},
              },
            ],
          },
          {
            catalogId: "media-alternatives",
            support: "caption",
            default: true,
            selectionReason: "default",
            attributes: {},
            cardAttributes: {},
            catalogAttributes: {},
            fileHrefs: [
              {
                href: "captions/missing-en.vtt",
                mimeType: "text/vtt",
                attributes: {},
              },
            ],
          },
        ],
      },
    ],
  };
}
