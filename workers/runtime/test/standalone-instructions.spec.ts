import { expect, it } from "vitest";
import JSZip from "jszip";
import {
  assessmentInstructionsForItem,
  parseAssessmentInstructionBlocks,
  type AssessmentInstructionBlock,
} from "@harbor/content-model";
import { parseHarborQtiPackage } from "../src/publish/qti-package-model";
import { prepareAssessmentInstructions } from "../src/publish/assessment-instructions";
import canonicalPackage from "../../../tests/fixtures/qti/part-settings/qflow-part-settings.zip.b64?raw";
import orderedTextXml from "../../../tests/fixtures/qti/part-settings/ordered-text.xml?raw";

const first = "item-b35efecb-927b-46d4-a4e8-21950c2e44e0-r1";
const second = "item-83eb5274-d3d0-4c39-b559-534205a21b2c-r1";

async function prepare(xml = orderedTextXml) {
  const zip = await JSZip.loadAsync(
    Uint8Array.from(atob(canonicalPackage), (value) => value.charCodeAt(0)),
  );
  zip.file("assessment.xml", xml);
  zip.file(
    "assets/map.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18"/></svg>',
  );
  const model = await parseHarborQtiPackage(await zip.generateAsync({ type: "uint8array" }));
  return prepareAssessmentInstructions(
    model.package.assessmentTest,
    model.package.items.map((item) => {
      const id = item.document?.item.identifier;
      if (!id) throw new Error("Fixture question has no identifier.");
      return { id, href: item.href };
    }),
  );
}

it("preserves leading, intermediate and trailing standalone scopes without inventing item membership", async () => {
  const result = await prepare();
  expect(result.assetHrefs).toEqual(["assets/map.svg"]);
  expect(result.blocks.map((block) => block.scopeIdentifier)).toEqual([
    "INTRO",
    "INTRO-TWO",
    "BETWEEN",
    "END",
    "END-TWO",
  ]);
  expect(
    result.blocks.map((block) => {
      if (!("anchor" in block))
        throw new Error("Standalone fixture became scoped question instructions.");
      expect("itemIds" in block).toBe(false);
      return block.anchor;
    }),
  ).toEqual([
    { position: "before", itemIds: [first] },
    { position: "before", itemIds: [first] },
    { position: "before", itemIds: [second] },
    { position: "after", itemIds: [second] },
    { position: "after", itemIds: [second] },
  ]);
  expect(JSON.stringify(result.blocks)).not.toContain("Private scorer key.");
  const wire = parseAssessmentInstructionBlocks(JSON.parse(JSON.stringify(result.blocks)));
  expect(wire).toEqual({ ok: true, value: result.blocks });
  expect(
    assessmentInstructionsForItem(result.blocks, first, [first, second]).map(
      (block) => block.scopeIdentifier,
    ),
  ).toEqual(["INTRO", "INTRO-TWO"]);
  expect(
    assessmentInstructionsForItem(result.blocks, second, [first, second]).map(
      (block) => block.scopeIdentifier,
    ),
  ).toEqual(["BETWEEN", "END", "END-TWO"]);
});

it("rejects ambiguous, invalid and absent standalone boundary records", async () => {
  const { blocks } = await prepare();
  const block = blocks[0];
  if (!("anchor" in block)) throw new Error("Standalone fixture has no boundary.");
  for (const invalid of [
    { ...block, itemIds: [first] },
    { ...block, scopeType: "test-part" },
    { ...block, anchor: { position: "middle", itemIds: [first] } },
    { ...block, anchor: { position: "before", itemIds: [] } },
    { ...block, anchor: { position: "before", itemIds: [first, first] } },
    { ...block, anchor: { position: "before", itemIds: [false] } },
    { ...block, anchor: { position: "before", itemIds: [first], alternate: second } },
    { ...block, anchor: null },
  ])
    expect(parseAssessmentInstructionBlocks([invalid])).toEqual({
      ok: false,
      code: "assessment.instructions.invalid",
    });
});

it("rejects unsupported standalone section structure and never crosses a part to invent its anchor", async () => {
  await expect(
    prepare(
      orderedTextXml.replace(
        '<qti-assessment-section identifier="FIRST" title="First question" visible="true">',
        '<qti-assessment-section identifier="FIRST" title="First question" visible="false">',
      ),
    ),
  ).rejects.toThrow("supported fixed section ordering");
  const xml = orderedTextXml.replace(
    '<qti-assessment-section identifier="FIRST"',
    '</qti-test-part><qti-test-part identifier="OTHER" navigation-mode="nonlinear" submission-mode="simultaneous"><qti-assessment-section identifier="FIRST"',
  );
  await expect(prepare(xml)).rejects.toThrow("question section in the same part");
});
