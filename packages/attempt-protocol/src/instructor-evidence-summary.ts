import type { HarborAfaPnpSupport } from "./pnp-policy";

interface InstructorEvidenceSummaryProjection {
  readonly summaryField: string;
  readonly support: HarborAfaPnpSupport;
  readonly state: string;
  readonly csvColumn: string;
  readonly displayLabel: string;
  readonly definition: string;
}

/**
 * Defines the flat instructor-report projections derived from accommodation evidence.
 *
 * The public summary and CSV remain flat for compatibility, while this table is the
 * single source for initialization, aggregation, and export metadata.
 */
export const INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS = [
  {
    summaryField: "glossaryAvailableCount",
    support: "glossary-on-screen",
    state: "offered",
    csvColumn: "glossary_available_events",
    displayLabel: "Glossary Available Events",
    definition: "Count of glossary offered evidence events for the attempt.",
  },
  {
    summaryField: "glossaryOpenedCount",
    support: "glossary-on-screen",
    state: "opened",
    csvColumn: "glossary_opened_events",
    displayLabel: "Glossary Opened Events",
    definition: "Count of glossary opening actions for the attempt.",
  },
  {
    summaryField: "glossaryUnavailableCount",
    support: "glossary-on-screen",
    state: "unavailable",
    csvColumn: "glossary_unavailable_events",
    displayLabel: "Glossary Unavailable Events",
    definition: "Count of unavailable glossary results for the attempt.",
  },
  {
    summaryField: "keywordTranslationAvailableCount",
    support: "keyword-translation",
    state: "offered",
    csvColumn: "keyword_translation_available_events",
    displayLabel: "Keyword Translation Available Events",
    definition: "Count of keyword-translation offered evidence events for the attempt.",
  },
  {
    summaryField: "keywordTranslationUsedCount",
    support: "keyword-translation",
    state: "activated",
    csvColumn: "keyword_translation_used_events",
    displayLabel: "Keyword Translation Used Events",
    definition: "Count of successfully activated keyword translations for the attempt.",
  },
  {
    summaryField: "keywordTranslationUnavailableCount",
    support: "keyword-translation",
    state: "unavailable",
    csvColumn: "keyword_translation_unavailable_events",
    displayLabel: "Keyword Translation Unavailable Events",
    definition: "Count of unavailable keyword-translation results for the attempt.",
  },
] as const satisfies readonly InstructorEvidenceSummaryProjection[];

export type InstructorAccommodationEvidenceSummaryField =
  (typeof INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS)[number]["summaryField"];

/** Flat accommodation evidence counters exposed by instructor report responses. */
export type InstructorAccommodationEvidenceSummary = {
  [Field in InstructorAccommodationEvidenceSummaryField]: number;
};

/** Creates all configured accommodation evidence counters with zero values. */
export function createEmptyInstructorAccommodationEvidenceSummary(): InstructorAccommodationEvidenceSummary {
  // SAFETY: every field in the mapped type comes from this exact projection list.
  return Object.fromEntries(
    INSTRUCTOR_EVIDENCE_SUMMARY_PROJECTIONS.map(({ summaryField }) => [summaryField, 0]),
  ) as InstructorAccommodationEvidenceSummary;
}
