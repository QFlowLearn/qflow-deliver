import { describe, expect, it } from "vitest";
import { validateSubmittedQtiResponses } from "../src/results/harbor-qti-response-validation";

describe("authoritative qti response validation", () => {
  it.each([
    { minimum: "", allowIncompleteResponses: false, ok: false },
    { minimum: ' min-choices="0"', allowIncompleteResponses: false, ok: true },
    { minimum: "", allowIncompleteResponses: true, ok: true },
  ])("applies Harbor scored-response policy: %j", ({ minimum, allowIncompleteResponses, ok }) => {
    const itemXml = choiceXml({ required: false })
      .replace(
        'base-type="identifier"/>',
        'base-type="identifier"><qti-correct-response><qti-value>A</qti-value></qti-correct-response></qti-response-declaration>',
      )
      .replace(' required="false"', minimum);

    const result = validateSubmittedQtiResponses({
      itemId: "scored-choice",
      itemXml,
      itemSnapshot: { responseVariables: [] },
      allowIncompleteResponses,
    });

    expect(result.ok).toBe(ok);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      ok ? [] : ["qti.response.required.missing"],
    );
  });

  it("blocks missing required responses when incomplete responses are disallowed", () => {
    const result = validateSubmittedQtiResponses({
      itemId: "required-choice",
      itemXml: choiceXml({ required: true }),
      itemSnapshot: { responseVariables: [] },
      allowIncompleteResponses: false,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "qti.response.required.missing", identifier: "RESPONSE" }),
    );
  });

  it("allows missing optional responses", () => {
    const result = validateSubmittedQtiResponses({
      itemId: "optional-choice",
      itemXml: choiceXml({ required: false }),
      itemSnapshot: { responseVariables: [] },
      allowIncompleteResponses: false,
    });

    expect(result).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("allows missing required responses when incomplete responses are allowed", () => {
    const result = validateSubmittedQtiResponses({
      itemId: "required-choice",
      itemXml: choiceXml({ required: true }),
      itemSnapshot: { responseVariables: [] },
      allowIncompleteResponses: true,
    });

    expect(result).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("validates multi-choice min and max bounds", () => {
    const tooFew = validateSubmittedQtiResponses({
      itemId: "multi-choice",
      itemXml: multiChoiceXml(),
      itemSnapshot: { responseVariables: [{ identifier: "RESPONSE", value: ["A"] }] },
      allowIncompleteResponses: false,
    });
    const tooMany = validateSubmittedQtiResponses({
      itemId: "multi-choice",
      itemXml: multiChoiceXml(),
      itemSnapshot: { responseVariables: [{ identifier: "RESPONSE", value: ["A", "B", "C"] }] },
      allowIncompleteResponses: false,
    });

    expect(tooFew.diagnostics).toContainEqual(
      expect.objectContaining({ code: "qti.response.minChoices" }),
    );
    expect(tooMany.diagnostics).toContainEqual(
      expect.objectContaining({ code: "qti.response.maxChoices" }),
    );
  });

  it("validates association min and max bounds", () => {
    const tooFew = validateSubmittedQtiResponses({
      itemId: "match",
      itemXml: matchXml(),
      itemSnapshot: { responseVariables: [{ identifier: "RESPONSE", value: ["A G1"] }] },
      allowIncompleteResponses: false,
    });
    const tooMany = validateSubmittedQtiResponses({
      itemId: "match",
      itemXml: matchXml(),
      itemSnapshot: {
        responseVariables: [{ identifier: "RESPONSE", value: ["A G1", "B G2", "C G3"] }],
      },
      allowIncompleteResponses: false,
    });

    expect(tooFew.diagnostics).toContainEqual(
      expect.objectContaining({ code: "qti.response.minAssociations" }),
    );
    expect(tooMany.diagnostics).toContainEqual(
      expect.objectContaining({ code: "qti.response.maxAssociations" }),
    );
  });

  it("rejects invalid cardinality shapes and undeclared identifiers", () => {
    const result = validateSubmittedQtiResponses({
      itemId: "choice",
      itemXml: choiceXml({ required: false }),
      itemSnapshot: {
        responseVariables: [
          { identifier: "RESPONSE", value: ["A", "B"] },
          { identifier: "SCORE", value: 1 },
        ],
      },
      allowIncompleteResponses: true,
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "qti.response.cardinality.invalid" }),
        expect.objectContaining({
          code: "qti.response.identifier.undeclared",
          identifier: "SCORE",
        }),
      ]),
    );
  });

  it("allows Harbor server built-in response variables", () => {
    const result = validateSubmittedQtiResponses({
      itemId: "choice",
      itemXml: choiceXml({ required: false }),
      itemSnapshot: {
        responseVariables: [
          { identifier: "RESPONSE", value: "A" },
          { identifier: "duration", value: 12.5 },
          { identifier: "numAttempts", value: 1 },
        ],
      },
      allowIncompleteResponses: false,
    });

    expect(result).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("reports authoritative item parse failures with a specific diagnostic code", () => {
    const result = validateSubmittedQtiResponses({
      itemId: "broken",
      itemXml: "<qti-assessment-item>",
      itemSnapshot: { responseVariables: [] },
      allowIncompleteResponses: false,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "qti.response.item.parse", identifier: null }),
    );
  });
});

function choiceXml(input: { required: boolean }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="choice" title="choice" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1" required="${input.required ? "true" : "false"}">
      <qti-simple-choice identifier="A">A</qti-simple-choice>
      <qti-simple-choice identifier="B">B</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
</qti-assessment-item>`;
}

function multiChoiceXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="multi" title="multi" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="multiple" base-type="identifier"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" min-choices="2" max-choices="2">
      <qti-simple-choice identifier="A">A</qti-simple-choice>
      <qti-simple-choice identifier="B">B</qti-simple-choice>
      <qti-simple-choice identifier="C">C</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
</qti-assessment-item>`;
}

function matchXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="match" title="match" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="multiple" base-type="directedPair"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <qti-match-interaction response-identifier="RESPONSE" min-associations="2" max-associations="2">
      <qti-simple-match-set>
        <qti-simple-associable-choice identifier="A" match-max="1">A</qti-simple-associable-choice>
        <qti-simple-associable-choice identifier="B" match-max="1">B</qti-simple-associable-choice>
        <qti-simple-associable-choice identifier="C" match-max="1">C</qti-simple-associable-choice>
      </qti-simple-match-set>
      <qti-simple-match-set>
        <qti-simple-associable-choice identifier="G1" match-max="1">G1</qti-simple-associable-choice>
        <qti-simple-associable-choice identifier="G2" match-max="1">G2</qti-simple-associable-choice>
        <qti-simple-associable-choice identifier="G3" match-max="1">G3</qti-simple-associable-choice>
      </qti-simple-match-set>
    </qti-match-interaction>
  </qti-item-body>
</qti-assessment-item>`;
}
