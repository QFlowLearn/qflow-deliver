import path from "node:path";
import { resolvePackageAssetReference } from "@harbor/content-model";
import { PublishInputError } from "./publish-errors";

/** Inline referenced assessment stimuli into Harbor's candidate-delivery XML projection. */
export function inlineAssessmentStimuli(input: {
  entriesByPath: ReadonlyMap<string, Uint8Array>;
  itemHref: string;
  itemXml: string;
}): string {
  const stimulusRefs = extractAssessmentStimulusRefs(input.itemXml, input.itemHref);
  if (stimulusRefs.length === 0) {
    return input.itemXml;
  }

  const stimulusBlocks: Array<{
    identifier: string;
    dockedBlock: string;
    fallbackBlock: string;
  }> = [];
  for (const stimulusRef of stimulusRefs) {
    const stimulusBytes = input.entriesByPath.get(stimulusRef.href);
    if (!stimulusBytes) {
      throw new PublishInputError(
        422,
        `Unsupported package structure: missing ${stimulusRef.href}`,
      );
    }

    const stimulusXml = new TextDecoder().decode(stimulusBytes);
    const stimulusBody = extractStimulusBodyXml(stimulusXml, stimulusRef.href);
    const rebasedBody = rebaseXmlAssetReferences({
      xml: stimulusBody,
      sourceHref: stimulusRef.href,
      targetHref: input.itemHref,
    });

    const dockedBlock = [
      `<div class="qti-shared-stimulus harbor-assessment-stimulus" data-stimulus-idref="${escapeXmlAttribute(stimulusRef.identifier)}" data-harbor-stimulus-identifier="${escapeXmlAttribute(stimulusRef.identifier)}">`,
      rebasedBody.trim(),
      "</div>",
    ].join("\n");

    const fallbackBlock = [
      `<qti-rubric-block view="candidate" class="harbor-assessment-stimulus" data-harbor-stimulus-identifier="${escapeXmlAttribute(stimulusRef.identifier)}">`,
      "<qti-content-body>",
      rebasedBody.trim(),
      "</qti-content-body>",
      "</qti-rubric-block>",
    ].join("\n");

    stimulusBlocks.push({
      identifier: stimulusRef.identifier,
      dockedBlock,
      fallbackBlock,
    });
  }

  const withoutStimulusRefs = input.itemXml.replace(ASSESSMENT_STIMULUS_REF_PATTERN, "");
  const dockedStimulusIdentifiers = new Set<string>();
  const withDockedStimuli = withoutStimulusRefs.replace(
    SHARED_STIMULUS_DOCK_PATTERN,
    (dockXml: string, attributes: string) => {
      const className = readXmlAttributeFromText(attributes, "class") ?? "";
      const stimulusIdentifier = readXmlAttributeFromText(attributes, "data-stimulus-idref");
      if (!className.split(/\s+/).includes("qti-shared-stimulus") || !stimulusIdentifier) {
        return dockXml;
      }

      const stimulusBlock = stimulusBlocks.find((block) => block.identifier === stimulusIdentifier);
      if (!stimulusBlock) {
        return dockXml;
      }

      dockedStimulusIdentifiers.add(stimulusIdentifier);
      return stimulusBlock.dockedBlock;
    },
  );

  const fallbackBlocks = stimulusBlocks
    .filter((block) => !dockedStimulusIdentifiers.has(block.identifier))
    .map((block) => block.fallbackBlock);
  if (fallbackBlocks.length === 0) {
    return withDockedStimuli;
  }

  return insertXmlAfterOpeningElement({
    xml: withDockedStimuli,
    localName: "qti-item-body",
    insertion: `\n${fallbackBlocks.join("\n")}\n`,
  });
}

const ASSESSMENT_STIMULUS_REF_PATTERN =
  /<((?:[A-Za-z_][\w.-]*:)?qti-assessment-stimulus-ref)\b([^>]*?)(?:\/>|>[\s\S]*?<\/\1>)/gi;
const SHARED_STIMULUS_DOCK_PATTERN = /<div\b([^>]*)>\s*<\/div>/gi;

function extractAssessmentStimulusRefs(
  itemXml: string,
  itemHref: string,
): Array<{ identifier: string; href: string }> {
  return [...itemXml.matchAll(ASSESSMENT_STIMULUS_REF_PATTERN)].map((match) => {
    const attributes = match[2] ?? "";
    const href = readXmlAttributeFromText(attributes, "href");
    const identifier = readXmlAttributeFromText(attributes, "identifier") ?? href ?? "stimulus";
    if (!href) {
      throw new PublishInputError(
        422,
        `Unsupported package structure: item ${itemHref} has a qti-assessment-stimulus-ref without href`,
      );
    }

    const resolution = resolvePackageAssetReference(itemHref, href);
    if (!resolution.ok) {
      throw new PublishInputError(
        422,
        `Unsupported package structure: item ${itemHref} has an invalid qti-assessment-stimulus-ref href ${href}`,
      );
    }

    return {
      identifier,
      href: resolution.href,
    };
  });
}

function extractStimulusBodyXml(stimulusXml: string, stimulusHref: string): string {
  const match = stimulusXml.match(
    /<((?:[A-Za-z_][\w.-]*:)?qti-stimulus-body)\b[^>]*>([\s\S]*?)<\/\1>/i,
  );
  if (!match?.[2]?.trim()) {
    throw new PublishInputError(
      422,
      `Unsupported package structure: stimulus ${stimulusHref} has no qti-stimulus-body content`,
    );
  }

  return match[2];
}

function insertXmlAfterOpeningElement(input: {
  xml: string;
  localName: string;
  insertion: string;
}): string {
  const pattern = new RegExp(`<((?:[A-Za-z_][\\w.-]*:)?${input.localName})\\b[^>]*>`, "i");
  const match = input.xml.match(pattern);
  if (!match?.[0]) {
    throw new PublishInputError(
      422,
      `Unsupported package structure: assessment item has no ${input.localName}`,
    );
  }

  const index = match.index ?? 0;
  return `${input.xml.slice(0, index + match[0].length)}${input.insertion}${input.xml.slice(index + match[0].length)}`;
}

function rebaseXmlAssetReferences(input: {
  xml: string;
  sourceHref: string;
  targetHref: string;
}): string {
  return input.xml.replace(
    /(src|href|data)=("|')([^"']+)("|')/g,
    (match, attribute: string, openingQuote: string, rawValue: string, closingQuote: string) => {
      const rebased = rebasePackageHref({
        rawValue,
        sourceHref: input.sourceHref,
        targetHref: input.targetHref,
      });

      return rebased
        ? `${attribute}=${openingQuote}${escapeXmlAttribute(rebased)}${closingQuote}`
        : match;
    },
  );
}

function rebasePackageHref(input: {
  rawValue: string;
  sourceHref: string;
  targetHref: string;
}): string | null {
  if (
    input.rawValue.startsWith("data:") ||
    input.rawValue.startsWith("http://") ||
    input.rawValue.startsWith("https://") ||
    input.rawValue.startsWith("//") ||
    input.rawValue.startsWith("#")
  ) {
    return null;
  }

  const resolution = resolvePackageAssetReference(input.sourceHref, input.rawValue);
  if (!resolution.ok) return null;

  const relativeHref = path.posix.relative(path.posix.dirname(input.targetHref), resolution.href);

  return `${relativeHref || path.posix.basename(resolution.href)}${resolution.fragment}`;
}

function readXmlAttributeFromText(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\s${name}=("|')([^"']+)\\1`, "i"));
  return match?.[2]?.trim() || null;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
