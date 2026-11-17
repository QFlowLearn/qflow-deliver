import { describe, expect, it } from "vitest";
import { parseQtiXml, type QtiInteraction } from "@longsightgroup/qti3-core";

describe("qti3-core compatibility", () => {
  it("exposes structured rich prompt and choice content", () => {
    const parsed = parseQtiXml(RICH_CHOICE_ITEM_XML);
    const interaction = parsed.document?.item.interactions[0] as QtiInteraction | undefined;

    expect(interaction?.prompt).toBe("Choose x squared");
    expect(interaction?.promptContent).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "element", qtiName: "math" })]),
    );
    expect(interaction?.choices[0]).toMatchObject({
      identifier: "A",
      text: "alpha",
    });
    expect(interaction?.choices[0]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "element", qtiName: "math" })]),
    );
    expect(interaction?.choices[1]).toMatchObject({
      identifier: "B",
      text: "Beta image",
    });
    expect(interaction?.choices[1]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "element", qtiName: "img" })]),
    );
  });

  it("parses XHTML extended-text interactions for delivery", () => {
    const parsed = parseQtiXml(XHTML_EXTENDED_TEXT_ITEM_XML);
    const interaction = parsed.document?.item.interactions[0];

    expect(parsed.diagnostics).toEqual([]);
    expect(interaction).toMatchObject({
      type: "extendedText",
      responseIdentifier: "RESPONSE",
      attributes: expect.objectContaining({
        format: "xhtml",
      }),
    });
  });
});

const RICH_CHOICE_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="rich-choice"
  title="Rich choice"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE">
      <qti-prompt>
        Choose <math alttext="x squared"><mi>x</mi></math>
        <annotation>teacher note</annotation>
      </qti-prompt>
      <qti-simple-choice identifier="A">
        <math alttext="alpha"><mi>a</mi></math>
      </qti-simple-choice>
      <qti-simple-choice identifier="B">
        <img src="b.png" alt="Beta image"/>
      </qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
</qti-assessment-item>`;

const XHTML_EXTENDED_TEXT_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="extended-text-xhtml"
  title="Extended text XHTML"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="string"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <p>Use rich formatting in the response.</p>
    <qti-extended-text-interaction
      response-identifier="RESPONSE"
      expected-length="200"
      expected-lines="6"
      format="xhtml">
      <qti-prompt>Write a formatted response.</qti-prompt>
    </qti-extended-text-interaction>
  </qti-item-body>
</qti-assessment-item>`;
