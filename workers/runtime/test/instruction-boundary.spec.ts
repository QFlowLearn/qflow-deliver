import { expect, it } from "vitest";
import { parseQtiFixedTestOrdering, prepareQtiFixedTestOrder } from "@longsightgroup/qti3-core";
import {
  assessmentInstructionsForItem,
  parseAssessmentInstructionBlocks,
  type AssessmentInstructionBlock,
} from "@harbor/content-model";

it("selects boundaries from generated and restored shared section orders", () => {
  const before: AssessmentInstructionBlock = {
    scopeType: "assessment-section",
    scopeIdentifier: "TEXT",
    title: null,
    anchor: { position: "before", itemIds: ["A", "B"] },
    assetBaseHref: "assessment.xml",
    content: [{ kind: "text", text: "Before this shuffled section." }],
  };
  const after: AssessmentInstructionBlock = {
    ...before,
    scopeIdentifier: "END",
    anchor: { position: "after", itemIds: ["A", "B"] },
  };
  const parsed = parseQtiFixedTestOrdering(`
    <qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="T" title="Order">
      <qti-test-part identifier="P" navigation-mode="nonlinear" submission-mode="simultaneous">
        <qti-assessment-section identifier="S" title="Questions" visible="true">
          <qti-ordering shuffle="true"/>
          <qti-assessment-item-ref identifier="A" href="a.xml"/>
          <qti-assessment-item-ref identifier="B" href="b.xml"/>
        </qti-assessment-section>
      </qti-test-part>
    </qti-assessment-test>`);
  if (!parsed.ok) throw new Error("Expected a supported shuffled section.");
  const permutations = new Set<string>();
  for (let seed = 0; seed < 16; seed++) {
    const generated = prepareQtiFixedTestOrder(parsed.value, { kind: "new", seed });
    if (!generated.ok) throw new Error("Expected a generated shared order.");
    const saved: unknown = JSON.parse(JSON.stringify(generated.value));
    const restored = prepareQtiFixedTestOrder(parsed.value, { kind: "restore", state: saved });
    if (!restored.ok) throw new Error("Expected an exact restored shared order.");
    expect(restored.value).toEqual(generated.value);
    const order = restored.value.sections.flatMap((section) => section.itemRefs);
    permutations.add(order.join(","));
    const first = order[0];
    const last = order[1];
    if (!first || !last) throw new Error("Expected two real questions.");
    expect(assessmentInstructionsForItem([before, after], first, order)).toEqual([before]);
    expect(assessmentInstructionsForItem([before, after], last, order)).toEqual([after]);
  }
  expect(permutations).toEqual(new Set(["A,B", "B,A"]));
  expect(assessmentInstructionsForItem([before, after], null, ["B", "A"])).toEqual([]);
  expect(() => assessmentInstructionsForItem([before], "A", ["A"])).toThrow(
    "missing from the attempt order",
  );
  expect(() => assessmentInstructionsForItem([before], "A", ["A", "A"])).toThrow(
    "missing from the attempt order",
  );
});

it("retains standalone scope identity and literal safe content beside unchanged scoped instructions", () => {
  const content = [{ kind: "text", text: "Read <script> literally. α & β" }];
  const standalone = {
    scopeType: "assessment-section",
    scopeIdentifier: "TEXT",
    title: "Text",
    anchor: { position: "before", itemIds: ["A", "B"] },
    assetBaseHref: "assessment.xml",
    content,
  };
  const scoped = {
    scopeType: "test-part",
    scopeIdentifier: "P",
    title: null,
    itemIds: ["A", "B"],
    assetBaseHref: "assessment.xml",
    content,
  };
  expect(parseAssessmentInstructionBlocks([scoped, standalone])).toEqual({
    ok: true,
    value: [scoped, standalone],
  });
  for (const invalid of [
    { ...standalone, itemIds: ["A"] },
    { ...standalone, scopeType: "test-part" },
    { ...standalone, anchor: { position: "middle", itemIds: ["A"] } },
    { ...standalone, anchor: { position: "before", itemIds: [] } },
    { ...standalone, anchor: { position: "before", itemIds: ["A", "A"] } },
    { ...standalone, anchor: { position: "before", itemIds: [false] } },
    { ...standalone, anchor: { position: "before", itemIds: ["A"], alternate: "B" } },
    { ...standalone, anchor: null },
    { ...standalone, assetBaseHref: "../assessment.xml" },
  ])
    expect(parseAssessmentInstructionBlocks([invalid])).toEqual({
      ok: false,
      code: "assessment.instructions.invalid",
    });
});
