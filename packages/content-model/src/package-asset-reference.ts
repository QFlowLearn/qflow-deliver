export type PackageAssetReferenceFailure =
  | "empty"
  | "external"
  | "absolute"
  | "query"
  | "path-traversal"
  | "malformed";

export type PackageAssetReferenceResolution =
  | { readonly ok: true; readonly href: string; readonly fragment: string }
  | { readonly ok: false; readonly reason: PackageAssetReferenceFailure };

/** Describe why an authored package reference was rejected. */
export function packageAssetReferenceFailureMessage(reason: PackageAssetReferenceFailure): string {
  switch (reason) {
    case "empty":
      return "reference is empty";
    case "external":
      return "external references are not allowed";
    case "absolute":
      return "absolute paths are not allowed";
    case "query":
      return "query strings are not allowed";
    case "path-traversal":
      return "path-traversal is not allowed";
    case "malformed":
      return "reference is malformed";
  }
}

/** Resolves an authored reference without allowing it to escape the item package. */
export function resolvePackageAssetReference(
  itemHref: string,
  reference: string,
): PackageAssetReferenceResolution {
  const value = reference.trim();
  if (!value || value.startsWith("#")) return { ok: false, reason: "empty" };
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) {
    return { ok: false, reason: "external" };
  }
  if (value.startsWith("/") || value.includes("\\")) {
    return { ok: false, reason: "absolute" };
  }
  if (value.includes("?")) return { ok: false, reason: "query" };
  if (/%2f|%5c|%2e%2e/i.test(value)) return { ok: false, reason: "path-traversal" };

  const [pathReference = "", ...fragmentParts] = value.split("#");
  let decodedReference: string;
  try {
    decodedReference = decodeURIComponent(pathReference);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const referenceSegments = decodedReference.split("/");
  const itemSegments = itemHref.split("/");
  if (itemSegments.some((segment) => segment === "..")) {
    return { ok: false, reason: "path-traversal" };
  }

  const resolvedSegments = [...itemSegments.slice(0, -1)];
  for (const segment of referenceSegments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolvedSegments.length === 0) {
        return { ok: false, reason: "path-traversal" };
      }
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(segment);
  }

  const href = resolvedSegments.filter((segment) => segment !== "").join("/");
  if (!href) return { ok: false, reason: "empty" };
  return {
    ok: true,
    href,
    fragment: fragmentParts.length > 0 ? `#${fragmentParts.join("#")}` : "",
  };
}
