import { generate, parse, walk, type CssNode, type Rule, type SelectorList } from "css-tree";

const PLAYER_SCOPE_SELECTOR = ":where(qti-assessment-item-player)";
const ALLOWED_GROUPING_AT_RULES = new Set(["container", "layer", "media", "supports"]);

/** A stylesheet-policy failure safe to report as a package validation error. */
export type PackageStylesheetRejection =
  | { readonly reason: "invalid-css"; readonly message: string }
  | { readonly reason: "external-reference"; readonly message: string }
  | { readonly reason: "unsafe-construct"; readonly message: string };

/** The result of checking whether package CSS is self-contained. */
export type PackageStylesheetValidation =
  | { readonly ok: true; readonly stylesheet: string }
  | { readonly ok: false; readonly rejection: PackageStylesheetRejection };

/** Parses and scopes package CSS so it cannot select Harbor shell elements. */
export function validatePackageStylesheet(stylesheet: string): PackageStylesheetValidation {
  let stylesheetAst: CssNode;
  try {
    stylesheetAst = parse(stylesheet, {
      context: "stylesheet",
      parseCustomProperty: true,
    });
  } catch (cause: unknown) {
    return {
      ok: false,
      rejection: {
        reason: "invalid-css",
        message: cause instanceof Error ? cause.message : "Stylesheet CSS could not be parsed.",
      },
    };
  }

  let externalReference: "import" | "url" | undefined;
  let unsafeConstruct: string | undefined;
  walk(stylesheetAst, (node) => {
    if (node.type === "Url") {
      externalReference = "url";
      return;
    }
    if (node.type === "Atrule" && decodeCssIdentifier(node.name).toLowerCase() === "import") {
      externalReference = "import";
      return;
    }
    if (node.type === "Function" && decodeCssIdentifier(node.name).toLowerCase() === "url") {
      externalReference = "url";
    }
    if (node.type === "Atrule") {
      const name = decodeCssIdentifier(node.name).toLowerCase();
      if (name !== "import" && !ALLOWED_GROUPING_AT_RULES.has(name)) {
        unsafeConstruct = `@${name}`;
      }
    }
    if (
      node.type === "Declaration" &&
      decodeCssIdentifier(node.property).toLowerCase() === "position" &&
      generate(node.value).trim().toLowerCase() === "fixed"
    ) {
      unsafeConstruct = "position: fixed";
    }
  });

  if (externalReference) {
    return {
      ok: false,
      rejection: {
        reason: "external-reference",
        message: `Stylesheet ${externalReference} references are not allowed.`,
      },
    };
  }
  if (unsafeConstruct) {
    return {
      ok: false,
      rejection: {
        reason: "unsafe-construct",
        message: `Stylesheet ${unsafeConstruct} is not allowed in delivered item CSS.`,
      },
    };
  }

  const scopingFailure = scopeStylesheetRules(stylesheetAst);
  if (scopingFailure) {
    return {
      ok: false,
      rejection: { reason: "invalid-css", message: scopingFailure },
    };
  }
  return { ok: true, stylesheet: generate(stylesheetAst) };
}

function scopeStylesheetRules(stylesheetAst: CssNode): string | undefined {
  let failure: string | undefined;
  walk(stylesheetAst, {
    visit: "Rule",
    enter(node: Rule) {
      if (node.prelude.type !== "SelectorList") {
        failure = "Stylesheet contains a rule without a parseable selector list.";
        return this.break;
      }
      const scopedSelectors = node.prelude.children
        .toArray()
        .map((selector) => `${PLAYER_SCOPE_SELECTOR} ${generate(selector)}`)
        .join(",");
      const scopedPrelude = parse(scopedSelectors, { context: "selectorList" });
      if (scopedPrelude.type !== "SelectorList") {
        failure = "Stylesheet selectors could not be scoped to the item player.";
        return this.break;
      }
      node.prelude = scopedPrelude as SelectorList;
    },
  });
  return failure;
}

function decodeCssIdentifier(identifier: string): string {
  return identifier.replace(
    /\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|([^\n\f\r\da-f]))/gi,
    (_escape, hex: string | undefined, escapedCharacter: string | undefined) => {
      if (hex === undefined) return escapedCharacter ?? "";
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return "\uFFFD";
      }
      return String.fromCodePoint(codePoint);
    },
  );
}
