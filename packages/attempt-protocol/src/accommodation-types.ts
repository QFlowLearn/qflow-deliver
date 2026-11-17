export const HARBOR_QTI3_COLOR_THEMES = [
  "qti3-player-color-default",
  "qti3-player-color-defaultreverse",
  "qti3-player-color-blackwhite",
  "qti3-player-color-whiteblack",
  "qti3-player-color-blackrose",
  "qti3-player-color-roseblack",
  "qti3-player-color-dgraymgray",
  "qti3-player-color-mgraydgray",
  "qti3-player-color-yellowblue",
  "qti3-player-color-blueyellow",
  "qti3-player-color-blackcyan",
  "qti3-player-color-cyanblack",
  "qti3-player-color-blackcream",
  "qti3-player-color-creamblack",
] as const;

export type HarborQti3ColorTheme = (typeof HARBOR_QTI3_COLOR_THEMES)[number];

export function isHarborQti3ColorTheme(value: unknown): value is HarborQti3ColorTheme {
  return (
    typeof value === "string" && (HARBOR_QTI3_COLOR_THEMES as readonly string[]).includes(value)
  );
}

export interface RendererPnpTextAppearanceAccommodation {
  colorStyle?: HarborQti3ColorTheme;
}

export interface RendererPnpAccommodation {
  textAppearance?: RendererPnpTextAppearanceAccommodation;
  glossaryOnScreen?: boolean;
  keywordTranslationLanguage?: string;
  extSbacGlossaryIllustration?: boolean;
  layoutSingleColumn?: boolean;
}

export interface RendererSessionControlTimeLimitsAccommodation {
  min_time?: number | null;
  max_time?: number | null;
  allow_late_submission?: boolean;
}

export interface RendererSessionControlAccommodation {
  allow_comment?: boolean;
  allow_review?: boolean;
  allow_skipping?: boolean;
  max_attempts?: number;
  show_feedback?: boolean;
  show_solution?: boolean;
  time_limits?: RendererSessionControlTimeLimitsAccommodation;
  validate_responses?: boolean;
}

export interface HarborShellAccommodationState {
  textToSpeech?: boolean;
  lineReader?: boolean;
  answerMasking?: boolean;
  calculator?: "none" | "basic" | "scientific";
  notepad?: boolean;
  captions?: boolean;
  transcripts?: boolean;
}

export const HARBOR_ADDITIONAL_TESTING_TIME_MODES = [
  "none",
  "time-multiplier",
  "fixed-minutes",
  "unlimited",
] as const;

export type HarborAdditionalTestingTimeMode = (typeof HARBOR_ADDITIONAL_TESTING_TIME_MODES)[number];

export const HARBOR_TESTING_TIME_ALLOCATION_POLICIES = [
  "whole-assessment",
  "even-split",
  "proportional-split",
] as const;

export type HarborTestingTimeAllocationPolicy =
  (typeof HARBOR_TESTING_TIME_ALLOCATION_POLICIES)[number];

export interface HarborAdditionalTestingTimeAccommodation {
  mode: HarborAdditionalTestingTimeMode;
  multiplier?: number;
  fixedMinutes?: number;
  allocationPolicy?: HarborTestingTimeAllocationPolicy;
}
