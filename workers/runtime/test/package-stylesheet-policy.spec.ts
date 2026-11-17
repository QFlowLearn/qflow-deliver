import { describe, expect, it } from "vitest";
import { validatePackageStylesheet } from "../src/publish/package-stylesheet-policy";

describe("package stylesheet policy", () => {
  it("accepts self-contained presentation CSS", () => {
    const result = validatePackageStylesheet(`
        .prompt { color: #123456; font-weight: 700; }
        .choice:focus-visible { outline: 3px solid currentColor; }
      `);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected valid stylesheet.");
    expect(result.stylesheet).toContain(":where(qti-assessment-item-player) .prompt");
    expect(result.stylesheet).toContain(":where(qti-assessment-item-player) .choice:focus-visible");
  });

  it.each(["body { display: none; }", ".session-actions { pointer-events: none; }"])(
    "scopes shell-targeting selector %s to the item player",
    (stylesheet) => {
      const result = validatePackageStylesheet(stylesheet);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error("Expected scoped stylesheet.");
      expect(result.stylesheet).toMatch(/^:where\(qti-assessment-item-player\) /);
    },
  );

  it.each(["@page { margin: 0; }", ".probe { position: fixed; inset: 0; }"])(
    "rejects global or viewport-level construct %s",
    (stylesheet) => {
      expect(validatePackageStylesheet(stylesheet)).toMatchObject({
        ok: false,
        rejection: { reason: "unsafe-construct" },
      });
    },
  );

  it.each([
    ['.probe { background-image: url("https://example.test/a.png"); }', "url"],
    ['.probe { background-image: u\\72l("https://example.test/a.png"); }', "url"],
    ['.probe { --image: u\\72l("https://example.test/a.png"); background: var(--image); }', "url"],
    ['@import "https://example.test/a.css";', "import"],
    ['@\\69mport "https://example.test/a.css";', "import"],
  ])("rejects external CSS construct %s", (stylesheet, construct) => {
    expect(validatePackageStylesheet(stylesheet)).toEqual({
      ok: false,
      rejection: {
        reason: "external-reference",
        message: `Stylesheet ${construct} references are not allowed.`,
      },
    });
  });
});
