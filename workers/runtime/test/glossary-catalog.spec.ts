import { describe, expect, it } from "vitest";
import { projectGlossaryCatalogDelivery } from "../../../packages/renderer-adapter/src/glossary-catalog";
import { HARBOR_GLOSSARY_ON_SCREEN_SUPPORT } from "@harbor/attempt-protocol";

describe("glossary catalog delivery projection", () => {
  it("keeps glossary matches and selects the first text or HTML file reference", () => {
    const projection = projectGlossaryCatalogDelivery({
      referenceId: "reference",
      catalogId: "catalog",
      qtiName: "qti-catalog-reference",
      availableSupports: [HARBOR_GLOSSARY_ON_SCREEN_SUPPORT, "transcript"],
      matches: [
        {
          catalogId: "glossary",
          support: HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
          default: true,
          selectionReason: "default",
          html: [{ kind: "text", text: "Inline definition." }],
          files: [
            { href: "/api/content/assets/asset:term.html", mimeType: "text/html" },
            { href: "/api/content/assets/asset:term.txt", mimeType: "text/plain" },
          ],
        },
        {
          catalogId: "transcript",
          support: "transcript",
          default: false,
          selectionReason: "available",
          html: [],
          files: [{ href: "transcripts/en.html", mimeType: "text/html" }],
        },
      ],
    });

    expect(projection.matches).toHaveLength(1);
    expect(projection.referencedFile).toMatchObject({
      href: "/api/content/assets/asset:term.html",
      mimeType: "text/html",
    });
  });
});
