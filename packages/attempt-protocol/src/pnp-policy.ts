import type {
  HarborShellAccommodationState,
  RendererPnpAccommodation,
} from "./accommodation-types";

/** Canonical AFA support identifier for learner-facing on-screen glossary content. */
export const HARBOR_GLOSSARY_ON_SCREEN_SUPPORT = "glossary-on-screen";

export const HARBOR_AFA_PNP_SUPPORTS = [
  "spoken",
  "transcript",
  "caption",
  "audio-description",
  "sign-language",
  "line-reader",
  "answer-masking",
  "calculator",
  "note-taking-on-screen",
  HARBOR_GLOSSARY_ON_SCREEN_SUPPORT,
  "keyword-translation",
  "glossary-illustration",
  "text-appearance",
  "layout-single-column",
  "keyword-emphasis",
  "magnification",
  "long-description",
  "tactile",
  "braille",
  "language-of-interface",
  "breaks",
] as const;

export const HARBOR_AFA_PNP_SUPPORT_ALIASES = [
  "text-to-speech",
  "notepad",
  "single-column-layout",
] as const;

export const HARBOR_AFA_PNP_SUPPORT_INPUTS = [
  ...HARBOR_AFA_PNP_SUPPORTS,
  ...HARBOR_AFA_PNP_SUPPORT_ALIASES,
] as const;

export type HarborAfaPnpSupport = (typeof HARBOR_AFA_PNP_SUPPORTS)[number];
export type HarborAfaPnpSupportInput = (typeof HARBOR_AFA_PNP_SUPPORT_INPUTS)[number];
export type HarborAfaPnpSupportActivation = "off" | "available" | "active" | "blocked";

export interface HarborAfaPnpEntitlement {
  supports?: HarborAfaPnpSupport[];
  activateAtInitializationSet?: HarborAfaPnpSupport[];
  activateAsOptionSet?: HarborAfaPnpSupport[];
  prohibitSet?: HarborAfaPnpSupport[];
  languages?: string[];
}

export interface HarborResolvedPnpPolicy {
  activations: Record<HarborAfaPnpSupport, HarborAfaPnpSupportActivation>;
  catalogSupports: string[];
  languages: string[];
  keywordEmphasisEnabled: boolean;
}

export function isHarborAfaPnpSupportInput(value: unknown): value is HarborAfaPnpSupportInput {
  return (
    typeof value === "string" &&
    (HARBOR_AFA_PNP_SUPPORT_INPUTS as readonly string[]).includes(value)
  );
}

export function isHarborAfaPnpSupport(value: unknown): value is HarborAfaPnpSupport {
  return (
    typeof value === "string" && (HARBOR_AFA_PNP_SUPPORTS as readonly string[]).includes(value)
  );
}

export function normalizeHarborAfaPnpSupport(value: HarborAfaPnpSupportInput): HarborAfaPnpSupport {
  if (value === "text-to-speech") {
    return "spoken";
  }
  if (value === "notepad") {
    return "note-taking-on-screen";
  }
  if (value === "single-column-layout") {
    return "layout-single-column";
  }
  return value;
}

export function readHarborAfaPnpSupport(value: unknown): HarborAfaPnpSupport | null {
  return isHarborAfaPnpSupportInput(value) ? normalizeHarborAfaPnpSupport(value) : null;
}

export function mergeHarborAfaPnpEntitlements(
  base: HarborAfaPnpEntitlement | undefined,
  override: HarborAfaPnpEntitlement | undefined,
): HarborAfaPnpEntitlement {
  return compactHarborAfaPnpEntitlement({
    supports: uniqueSupports(base?.supports, override?.supports),
    activateAtInitializationSet: uniqueSupports(
      base?.activateAtInitializationSet,
      override?.activateAtInitializationSet,
    ),
    activateAsOptionSet: uniqueSupports(base?.activateAsOptionSet, override?.activateAsOptionSet),
    prohibitSet: uniqueSupports(base?.prohibitSet, override?.prohibitSet),
    languages: uniqueStrings(base?.languages, override?.languages),
  });
}

/**
 * Returns the effective entitlement as flattened offered supports plus explicit prohibit
 * and language preferences. Activation-set fields from input are not preserved separately.
 */
export function resolveHarborAfaPnpEntitlement(input: {
  rendererPnp?: RendererPnpAccommodation;
  shellTools?: HarborShellAccommodationState;
  pnpEntitlement?: HarborAfaPnpEntitlement;
}): HarborAfaPnpEntitlement {
  const resolved = resolveHarborPnpPolicy(input);
  const supports = HARBOR_AFA_PNP_SUPPORTS.filter((support) =>
    isHarborAfaPnpSupportOffered(resolved.activations[support]),
  );

  return compactHarborAfaPnpEntitlement({
    supports,
    prohibitSet: normalizeSupportList(input.pnpEntitlement?.prohibitSet),
    languages: resolved.languages,
  });
}

/** @deprecated Prefer `resolveHarborPnpPolicy(input).activations[support]`. */
export function resolveHarborAfaPnpSupportActivation(input: {
  rendererPnp?: RendererPnpAccommodation;
  shellTools?: HarborShellAccommodationState;
  pnpEntitlement?: HarborAfaPnpEntitlement;
  support: HarborAfaPnpSupportInput;
}): HarborAfaPnpSupportActivation {
  return resolveHarborPnpPolicy(input).activations[normalizeHarborAfaPnpSupport(input.support)];
}

export function resolveHarborPnpPolicy(input: {
  rendererPnp?: RendererPnpAccommodation;
  shellTools?: HarborShellAccommodationState;
  pnpEntitlement?: HarborAfaPnpEntitlement;
}): HarborResolvedPnpPolicy {
  const explicit = input.pnpEntitlement ?? {};
  const prohibited = new Set(normalizeSupportList(explicit.prohibitSet));
  const active = new Set(normalizeSupportList(explicit.activateAtInitializationSet));
  const available = new Set([
    ...normalizeSupportList(explicit.supports),
    ...normalizeSupportList(explicit.activateAsOptionSet),
    ...deriveHarborAfaSupports(input.rendererPnp ?? {}, input.shellTools ?? {}),
  ]);

  const activations = Object.fromEntries(
    HARBOR_AFA_PNP_SUPPORTS.map((support) => {
      const activation = prohibited.has(support)
        ? "blocked"
        : active.has(support)
          ? "active"
          : available.has(support)
            ? "available"
            : "off";
      return [support, activation];
    }),
  ) as Record<HarborAfaPnpSupport, HarborAfaPnpSupportActivation>;

  return {
    activations,
    catalogSupports: uniqueStrings(
      HARBOR_AFA_PNP_SUPPORTS.flatMap((support) =>
        isHarborAfaPnpSupportOffered(activations[support])
          ? HARBOR_AFA_CATALOG_SUPPORTS[support]
          : [],
      ),
    ),
    languages: resolveHarborKeywordTranslationLanguages(input),
    keywordEmphasisEnabled: isHarborAfaPnpSupportOffered(activations["keyword-emphasis"]),
  };
}

/** Returns the ordered languages a learner may select for keyword translation. */
export function resolveHarborKeywordTranslationLanguages(input: {
  rendererPnp?: RendererPnpAccommodation;
  pnpEntitlement?: HarborAfaPnpEntitlement;
}): string[] {
  return uniqueStrings(
    input.rendererPnp?.keywordTranslationLanguage
      ? [input.rendererPnp.keywordTranslationLanguage]
      : [],
    input.pnpEntitlement?.languages,
  );
}

/** Resolves a persisted selection against the current ordered entitlement. */
export function resolveHarborKeywordTranslationLanguage(input: {
  rendererPnp?: RendererPnpAccommodation;
  pnpEntitlement?: HarborAfaPnpEntitlement;
  selectedLanguage?: string | null;
}): string | null {
  const languages = resolveHarborKeywordTranslationLanguages(input);
  const selectedLanguage = input.selectedLanguage?.trim();
  if (selectedLanguage) {
    const selected = languages.find(
      (language) => language.toLowerCase() === selectedLanguage.toLowerCase(),
    );
    if (selected) return selected;
  }
  return languages.at(0) ?? null;
}

export function isHarborAfaPnpSupportOffered(activation: HarborAfaPnpSupportActivation): boolean {
  return activation === "available" || activation === "active";
}

/** @deprecated Prefer `resolveHarborPnpPolicy(input).catalogSupports`. */
export function resolveHarborAfaCatalogSupportFilters(input: {
  rendererPnp?: RendererPnpAccommodation;
  shellTools?: HarborShellAccommodationState;
  pnpEntitlement?: HarborAfaPnpEntitlement;
}): string[] {
  return resolveHarborPnpPolicy(input).catalogSupports;
}

/** @deprecated Prefer `resolveHarborPnpPolicy(input).languages`. */
export function resolveHarborAfaPnpLanguages(input: {
  rendererPnp?: RendererPnpAccommodation;
  pnpEntitlement?: HarborAfaPnpEntitlement;
}): string[] {
  return resolveHarborPnpPolicy(input).languages;
}

const HARBOR_AFA_CATALOG_SUPPORTS: Record<HarborAfaPnpSupport, string[]> = {
  spoken: ["spoken"],
  transcript: ["transcript"],
  caption: ["caption"],
  "audio-description": ["audio-description"],
  "sign-language": ["sign-language"],
  "line-reader": [],
  "answer-masking": [],
  calculator: [],
  "note-taking-on-screen": [],
  [HARBOR_GLOSSARY_ON_SCREEN_SUPPORT]: [HARBOR_GLOSSARY_ON_SCREEN_SUPPORT],
  "keyword-translation": ["keyword-translation"],
  "glossary-illustration": ["glossary-illustration"],
  "text-appearance": [],
  "layout-single-column": [],
  "keyword-emphasis": [],
  magnification: [],
  "long-description": ["long-description"],
  tactile: ["tactile"],
  braille: ["braille"],
  "language-of-interface": [],
  breaks: [],
};

function deriveHarborAfaSupports(
  rendererPnp: RendererPnpAccommodation,
  shellTools: HarborShellAccommodationState,
): HarborAfaPnpSupport[] {
  const supports: HarborAfaPnpSupport[] = [];
  if (shellTools.textToSpeech === true) supports.push("spoken");
  if (shellTools.transcripts === true) supports.push("transcript");
  if (shellTools.captions === true) supports.push("caption");
  if (shellTools.lineReader === true) supports.push("line-reader");
  if (shellTools.answerMasking === true) supports.push("answer-masking");
  if (shellTools.calculator && shellTools.calculator !== "none") {
    supports.push("calculator");
  }
  if (shellTools.notepad === true) supports.push("note-taking-on-screen");
  if (rendererPnp.glossaryOnScreen === true) supports.push(HARBOR_GLOSSARY_ON_SCREEN_SUPPORT);
  if (rendererPnp.keywordTranslationLanguage) supports.push("keyword-translation");
  if (rendererPnp.extSbacGlossaryIllustration === true) {
    supports.push("glossary-illustration");
  }
  if (rendererPnp.textAppearance?.colorStyle) supports.push("text-appearance");
  if (rendererPnp.layoutSingleColumn === true) supports.push("layout-single-column");
  return supports;
}

function normalizeSupportList(
  values: readonly HarborAfaPnpSupportInput[] | undefined,
): HarborAfaPnpSupport[] {
  return values?.map((value) => normalizeHarborAfaPnpSupport(value)) ?? [];
}

function compactHarborAfaPnpEntitlement(
  entitlement: HarborAfaPnpEntitlement,
): HarborAfaPnpEntitlement {
  return {
    ...(entitlement.supports && entitlement.supports.length > 0
      ? { supports: entitlement.supports }
      : {}),
    ...(entitlement.activateAtInitializationSet &&
    entitlement.activateAtInitializationSet.length > 0
      ? { activateAtInitializationSet: entitlement.activateAtInitializationSet }
      : {}),
    ...(entitlement.activateAsOptionSet && entitlement.activateAsOptionSet.length > 0
      ? { activateAsOptionSet: entitlement.activateAsOptionSet }
      : {}),
    ...(entitlement.prohibitSet && entitlement.prohibitSet.length > 0
      ? { prohibitSet: entitlement.prohibitSet }
      : {}),
    ...(entitlement.languages && entitlement.languages.length > 0
      ? { languages: entitlement.languages }
      : {}),
  };
}

function uniqueSupports(
  ...groups: Array<readonly HarborAfaPnpSupportInput[] | undefined>
): HarborAfaPnpSupport[] {
  return [...new Set(groups.flatMap((group) => normalizeSupportList(group)))];
}

function uniqueStrings(...groups: Array<readonly string[] | undefined>): string[] {
  return [
    ...new Set(
      groups
        .flatMap((group) => group ?? [])
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}
