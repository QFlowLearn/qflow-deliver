import { describe, expect, it } from "vitest";
import {
  packageAssetReferenceFailureMessage,
  resolvePackageAssetReference,
} from "@harbor/content-model";
import { createPackageAssetResolvers } from "../../../packages/renderer-adapter/src/package-assets";

describe("package-local asset delivery", () => {
  const assets = [
    {
      href: "items/styles/item.css",
      url: "/api/content/assets/asset:item.css?attemptId=attempt_1",
      mediaType: "text/css",
    },
    {
      href: "items/glossary/term.html",
      url: "/api/content/assets/asset:term.html?attemptId=attempt_1",
      mediaType: "text/html",
    },
  ] as const;

  it("resolves exact immutable package assets relative to the item", () => {
    const resolvers = createPackageAssetResolvers({ itemHref: "items/item.xml", assets });
    expect(resolvers.resolveAsset("glossary/term.html#definition")).toBe(
      "/api/content/assets/asset:term.html?attemptId=attempt_1#definition",
    );
    expect(
      resolvers.resolveStylesheet({ href: "styles/item.css", attributes: {}, source: undefined }),
    ).toMatchObject({
      href: "/api/content/assets/asset:item.css?attemptId=attempt_1",
      type: "text/css",
    });
  });

  it.each([
    ["https://example.test/item.css", "external"],
    ["//example.test/item.css", "external"],
    ["/item.css", "absolute"],
    ["../../../../outside/item.css", "path-traversal"],
    ["%2e%2e/item.css", "path-traversal"],
    ["styles%2fitem.css", "path-traversal"],
    ["styles/item.css?v=1", "query"],
  ])("rejects %s", (reference, reason) => {
    expect(resolvePackageAssetReference("items/item.xml", reference)).toEqual({
      ok: false,
      reason,
    });
  });

  it("resolves parent-relative references from the item directory", () => {
    expect(resolvePackageAssetReference("items/item.xml", "../assets/stimulus.svg")).toEqual({
      ok: true,
      href: "assets/stimulus.svg",
      fragment: "",
    });
  });

  it.each([
    ["empty", "reference is empty"],
    ["external", "external references are not allowed"],
    ["absolute", "absolute paths are not allowed"],
    ["query", "query strings are not allowed"],
    ["path-traversal", "path-traversal is not allowed"],
    ["malformed", "reference is malformed"],
  ] as const)("describes the %s rejection", (reason, message) => {
    expect(packageAssetReferenceFailureMessage(reason)).toBe(message);
  });

  it("rejects missing assets and non-CSS stylesheet media", () => {
    const resolvers = createPackageAssetResolvers({ itemHref: "items/item.xml", assets });
    expect(resolvers.resolveAsset("missing.css")).toBe("");
    expect(
      resolvers.resolveStylesheet({
        href: "glossary/term.html",
        attributes: {},
        source: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolvers.resolveStylesheet({
        href: "styles/item.css",
        type: "text/less",
        attributes: {},
        source: undefined,
      }),
    ).toBeUndefined();
  });
});
