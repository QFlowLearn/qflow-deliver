import type { HarborAfaPnpSupport, HarborAfaPnpSupportActivation } from "./pnp-policy";
import { isHarborAfaPnpSupport } from "./pnp-policy";
import type { HarborCatalogSupportEntry } from "./catalog-supports";
import {
  INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS,
  type InstructorAccommodationEvidenceSummary,
} from "./instructor-evidence-summary";

/** Supports that emit availability evidence when renderer metadata refreshes. */
export const HARBOR_CATALOG_AVAILABILITY_EVIDENCE_SUPPORTS = [
  "spoken",
  "caption",
  "transcript",
  "audio-description",
  "sign-language",
  "glossary-on-screen",
  "keyword-translation",
] as const satisfies readonly HarborAfaPnpSupport[];

export type HarborCatalogAvailabilityEvidenceSupport =
  (typeof HARBOR_CATALOG_AVAILABILITY_EVIDENCE_SUPPORTS)[number];

export const ACCOMMODATION_SUPPORT_EVIDENCE_STATES = [
  "offered",
  "opened",
  "closed",
  "activated",
  "paused",
  "resumed",
  "stopped",
  "finished",
  "played",
  "unavailable",
  "suppressed",
  "language-selected",
] as const;

export type AccommodationSupportEvidenceState =
  (typeof ACCOMMODATION_SUPPORT_EVIDENCE_STATES)[number];

const ACCOMMODATION_SUPPORT_ACTIVATIONS = [
  "off",
  "available",
  "active",
  "blocked",
] as const satisfies readonly HarborAfaPnpSupportActivation[];

export const ACCOMMODATION_CATALOG_AVAILABILITIES = [
  "available",
  "missing",
  "suppressed",
  "not-applicable",
] as const;

export type AccommodationCatalogAvailability =
  (typeof ACCOMMODATION_CATALOG_AVAILABILITIES)[number];

export interface AccommodationSupportEvidencePayload {
  support: HarborAfaPnpSupport;
  state: AccommodationSupportEvidenceState;
  activation: HarborAfaPnpSupportActivation;
  catalogAvailability: AccommodationCatalogAvailability;
  entryCount: number;
  catalogIds: string[];
  referenceIds: string[];
  requestedLanguage: string | null;
  resolvedLanguage: string | null;
  selectionReason: string | null;
  assetReferences: string[];
  mediaTypes: string[];
  inlineHtmlCount: number;
  eventSource: "accommodation-support" | "attempt-event";
  reason?: string;
  control?: string;
  segmentCount?: number;
  language?: string | null;
}

export interface BuildAccommodationSupportEvidencePayloadInput {
  support: HarborAfaPnpSupport;
  state: AccommodationSupportEvidenceState;
  activation: HarborAfaPnpSupportActivation;
  entries?: readonly HarborCatalogSupportEntry[];
  reason?: string;
  control?: string;
  eventSource?: AccommodationSupportEvidencePayload["eventSource"];
  requestedLanguage?: string | null;
  resolvedLanguage?: string | null;
  selectionReason?: string | null;
  segmentCount?: number;
  language?: string | null;
}

/** Parses an untrusted accommodation-support payload into its canonical evidence contract. */
export function parseAccommodationSupportEvidencePayload(
  value: unknown,
): AccommodationSupportEvidencePayload | null {
  if (!isRecord(value)) return null;
  if (!isHarborAfaPnpSupport(value.support)) return null;
  if (!includesString(ACCOMMODATION_SUPPORT_EVIDENCE_STATES, value.state)) return null;
  if (!includesString(ACCOMMODATION_SUPPORT_ACTIVATIONS, value.activation)) return null;
  if (!includesString(ACCOMMODATION_CATALOG_AVAILABILITIES, value.catalogAvailability)) return null;
  if (!isNonNegativeInteger(value.entryCount) || !isNonNegativeInteger(value.inlineHtmlCount)) {
    return null;
  }
  if (
    !isStringArray(value.catalogIds) ||
    !isStringArray(value.referenceIds) ||
    !isStringArray(value.assetReferences) ||
    !isStringArray(value.mediaTypes)
  ) {
    return null;
  }
  if (!isNullableString(value.requestedLanguage)) return null;
  if (!isNullableString(value.resolvedLanguage)) return null;
  if (!isNullableString(value.selectionReason)) return null;
  if (value.eventSource !== "accommodation-support" && value.eventSource !== "attempt-event") {
    return null;
  }
  if (!isOptionalString(value.reason) || !isOptionalString(value.control)) return null;
  if (value.segmentCount !== undefined && !isNonNegativeInteger(value.segmentCount)) return null;
  if (value.language !== undefined && !isNullableString(value.language)) return null;

  return {
    support: value.support,
    state: value.state,
    activation: value.activation,
    catalogAvailability: value.catalogAvailability,
    entryCount: value.entryCount,
    catalogIds: [...value.catalogIds],
    referenceIds: [...value.referenceIds],
    requestedLanguage: value.requestedLanguage,
    resolvedLanguage: value.resolvedLanguage,
    selectionReason: value.selectionReason,
    assetReferences: [...value.assetReferences],
    mediaTypes: [...value.mediaTypes],
    inlineHtmlCount: value.inlineHtmlCount,
    eventSource: value.eventSource,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    ...(value.control !== undefined ? { control: value.control } : {}),
    ...(value.segmentCount !== undefined ? { segmentCount: value.segmentCount } : {}),
    ...(value.language !== undefined ? { language: value.language } : {}),
  };
}

export function buildAccommodationSupportEvidencePayload(
  input: BuildAccommodationSupportEvidencePayloadInput,
): AccommodationSupportEvidencePayload {
  const entries = input.entries ?? [];
  const requestedLanguages = uniqueStringList(
    entries
      .map((entry) => entry.requestedLanguage)
      .filter((language): language is string => Boolean(language)),
  );
  const resolvedLanguages = uniqueStringList(
    entries
      .map((entry) => entry.language)
      .filter((language): language is string => Boolean(language)),
  );
  const selectionReasons = uniqueStringList(entries.map((entry) => entry.selectionReason));

  const payload: AccommodationSupportEvidencePayload = {
    support: input.support,
    state: input.state,
    activation: input.activation,
    catalogAvailability:
      input.support === "spoken"
        ? "not-applicable"
        : entries.length > 0
          ? "available"
          : input.state === "suppressed"
            ? "suppressed"
            : "missing",
    entryCount: entries.length,
    catalogIds: uniqueStringList(entries.map((entry) => entry.catalogId)),
    referenceIds: uniqueStringList(entries.map((entry) => entry.referenceId)),
    requestedLanguage: input.requestedLanguage ?? requestedLanguages.at(0) ?? null,
    resolvedLanguage: input.resolvedLanguage ?? resolvedLanguages.at(0) ?? null,
    selectionReason: input.selectionReason ?? selectionReasons.at(0) ?? null,
    assetReferences: uniqueStringList(
      entries
        .map((entry) => entry.assetReference)
        .filter((reference): reference is string => Boolean(reference)),
    ),
    mediaTypes: uniqueStringList(
      entries
        .map((entry) => entry.mediaType)
        .filter((mediaType): mediaType is string => Boolean(mediaType)),
    ),
    inlineHtmlCount: entries.filter((entry) => entry.text).length,
    eventSource: input.eventSource ?? "accommodation-support",
  };

  if (input.reason) payload.reason = input.reason;
  if (input.control) payload.control = input.control;
  if (input.segmentCount !== undefined) payload.segmentCount = input.segmentCount;
  if (input.language !== undefined) payload.language = input.language;

  return payload;
}

export function shouldDedupeAccommodationSupportEvidence(
  state: AccommodationSupportEvidenceState,
  dedupe?: boolean,
): boolean {
  return dedupe ?? (state === "offered" || state === "unavailable" || state === "suppressed");
}

export async function buildAccommodationEvidenceIdempotencyKey(input: {
  readonly attemptId: string;
  readonly itemId: string;
  readonly itemHref: string;
  readonly support: HarborAfaPnpSupport;
  readonly state: AccommodationSupportEvidenceState;
  readonly requestedLanguage: string | null;
  readonly resolvedLanguage: string | null;
  readonly selectionReason: string | null;
}): Promise<string> {
  const canonical = JSON.stringify([
    input.attemptId,
    input.itemId,
    input.itemHref,
    input.support,
    input.state,
    input.requestedLanguage,
    input.resolvedLanguage,
    input.selectionReason,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `support-availability:${fingerprint}`;
}

export function projectAttemptEventAccommodationEvidence(
  eventType: string,
  rawPayload: Record<string, unknown>,
  resolvedLanguage: string | null = null,
): Record<string, unknown> | null {
  if (eventType !== "keyword-translation.language.selected") {
    return null;
  }

  const requestedLanguage = readOptionalString(rawPayload.requestedLanguage);
  return {
    support: "keyword-translation",
    state: "language-selected",
    requestedLanguage,
    resolvedLanguage,
    eventSource: "attempt-event",
  };
}

export function readAccommodationEvidenceLanguage(
  payload: Record<string, unknown>,
  key: "requestedLanguage" | "resolvedLanguage",
): string | null {
  const scalar = readOptionalString(payload[key]);
  if (scalar) return scalar;
  const list = payload[`${key}s`];
  if (!Array.isArray(list)) return null;
  for (const value of list) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

/** Applies configured support/state counts to the compatible flat report summary. */
export function applyAccommodationSupportCounts(
  summary: InstructorAccommodationEvidenceSummary,
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
): void {
  for (const projection of INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS) {
    summary[projection.summaryField] = counts.get(projection.support)?.get(projection.state) ?? 0;
  }
}

function uniqueStringList(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function includesString<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
