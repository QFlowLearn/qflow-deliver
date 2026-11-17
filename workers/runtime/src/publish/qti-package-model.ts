import {
  parseQtiPackageFromEntries,
  readQtiPackageZipEntriesAsync,
  type QtiDiagnostic,
  type QtiPackageEntry,
  type QtiPackageParseResult,
} from "@longsightgroup/qti3-core";
import { createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";
import { PublishInputError } from "./publish-errors";

/** Canonical qti3-core package model plus an indexed view of its raw entries. */
export interface HarborQtiPackageModel {
  readonly package: Omit<QtiPackageParseResult, "packageShape"> & {
    readonly packageShape: Exclude<QtiPackageParseResult["packageShape"], "unknown">;
  };
  readonly entriesByPath: ReadonlyMap<string, QtiPackageEntry>;
}

/** qti3 errors Harbor either projects into readiness or enforces through a local delivery policy. */
const HARBOR_IMPORT_NONFATAL_DIAGNOSTIC_CODES = new Set([
  "package.timing.range.invalid",
  "package.asset.missing",
  "package.path.escape",
  "package.attribute.min-time.number",
  "package.attribute.max-time.number",
  "package.attribute.allow-late-submission.boolean",
  "package.attribute.max-attempts.number",
  "package.attribute.show-feedback.boolean",
  "package.attribute.allow-review.boolean",
  "package.attribute.show-solution.boolean",
  "package.attribute.allow-comment.boolean",
  "package.attribute.allow-skipping.boolean",
  "package.attribute.validate-responses.boolean",
  "package.attribute.visible.boolean",
]);

/** Parse an uploaded package once through qti3-core and classify fatal import diagnostics. */
export async function parseHarborQtiPackage(
  packageBytes: Uint8Array,
): Promise<HarborQtiPackageModel> {
  const diagnostics: QtiDiagnostic[] = [];
  const entries = await readQtiPackageZipEntriesAsync(
    packageBytes,
    {
      inflateRaw: (bytes, context) => inflateEntry(bytes, context.maxOutputLength),
    },
    diagnostics,
  );
  const extractionFailure = diagnostics.find(isFatalImportDiagnostic);
  if (extractionFailure) {
    throw new PublishInputError(422, `Unsupported package structure: ${extractionFailure.message}`);
  }
  const parsed = parseQtiPackageFromEntries(entries);
  const fatalDiagnostic = parsed.diagnostics.find(isFatalImportDiagnostic);
  if (fatalDiagnostic) {
    throw new PublishInputError(422, `Unsupported package structure: ${fatalDiagnostic.message}`);
  }
  if (parsed.packageShape === "unknown") {
    throw new PublishInputError(422, "Unsupported package structure: no importable QTI resources");
  }

  return {
    package: { ...parsed, packageShape: parsed.packageShape },
    entriesByPath: new Map(parsed.entries.map((entry) => [entry.path, entry])),
  };
}

function isFatalImportDiagnostic(diagnostic: QtiDiagnostic): boolean {
  if (diagnostic.severity !== "error") return false;
  if (diagnostic.code === "xml.parse") return true;
  if (!diagnostic.code.startsWith("package.")) return false;
  return !HARBOR_IMPORT_NONFATAL_DIAGNOSTIC_CODES.has(diagnostic.code);
}

/** Stream into a fixed output buffer; stop as soon as an entry exceeds its declared size. */
async function inflateEntry(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const output = new Uint8Array(limit);
  // Bounded chunks avoid workerd's exact-fit synchronous inflater allocation failure.
  const inflater = createInflateRaw({ chunkSize: Math.max(64, Math.min(16_384, limit)) });
  const stream = Readable.from([bytes]).pipe(inflater);
  let length = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Invalid inflater output.");
    if (chunk.byteLength > limit - length) throw new Error("ZIP entry exceeds its declared size.");
    output.set(chunk, length);
    length += chunk.byteLength;
  }
  return output.subarray(0, length);
}
