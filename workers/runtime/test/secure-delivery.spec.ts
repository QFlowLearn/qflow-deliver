import { describe, expect, it } from "vitest";
import { assertDeliverySafeItemXml, buildDeliverySafeItemXml } from "../src/qti/secure-delivery";

describe("qti secure delivery", () => {
  it("redacts scoring mappings and declaration defaults handled by qti3-core", () => {
    const deliveryXml = buildDeliverySafeItemXml(ITEM_WITH_SCORING_SECRETS_XML);

    expect(deliveryXml).not.toContain("qti-correct-response");
    expect(deliveryXml).not.toContain("qti-mapping");
    expect(deliveryXml).not.toContain("qti-default-value");
    expect(deliveryXml).not.toContain("qti-response-processing");
    expect(deliveryXml).not.toContain("qti-feedback-inline");
    expect(() => assertDeliverySafeItemXml(deliveryXml)).not.toThrow();
  });

  it("rejects delivered XML that still contains scoring mappings", () => {
    expect(() => assertDeliverySafeItemXml(ITEM_WITH_SCORING_SECRETS_XML)).toThrow(
      /forbidden QTI delivery content/,
    );
  });
});

const ITEM_WITH_SCORING_SECRETS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="choice" title="choice" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>A</qti-value>
    </qti-correct-response>
    <qti-default-value>
      <qti-value>B</qti-value>
    </qti-default-value>
    <qti-mapping default-value="0">
      <qti-map-entry map-key="A" mapped-value="1"/>
    </qti-mapping>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float">
    <qti-default-value>
      <qti-value>0</qti-value>
    </qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="A">A</qti-simple-choice>
      <qti-simple-choice identifier="B">B</qti-simple-choice>
    </qti-choice-interaction>
    <qti-feedback-inline outcome-identifier="SCORE" identifier="correct" show-hide="show">Correct</qti-feedback-inline>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;
