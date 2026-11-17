import JSZip from "jszip";

/** Synthetic fixture: three groups, six possible blocks, 30 distinct binary questions. */
export async function stagedPackage(testXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  const resources: string[] = [];
  const dependencies: string[] = [];
  for (let stage = 0; stage < 3; stage++) {
    for (let level = 0; level <= Math.min(stage, 2); level++) {
      for (let index = 0; index < 5; index++) {
        const id = `stage${stage}_level${level}_${index}`;
        const href = `items/${id}.xml`;
        zip.file(href, binaryQuestionXml(id));
        resources.push(
          `<resource identifier="${id}" type="imsqti_item_xmlv3p0" href="${href}"><file href="${href}"/></resource>`,
        );
        dependencies.push(`<dependency identifierref="${id}"/>`);
      }
    }
  }
  zip.file("test.xml", testXml);
  zip.file(
    "imsmanifest.xml",
    `<?xml version="1.0"?><manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="staged"><organizations/><resources><resource identifier="test" type="imsqti_test_xmlv3p0" href="test.xml"><file href="test.xml"/>${dependencies.join("")}</resource>${resources.join("")}</resources></manifest>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

export function binaryQuestionXml(id: string): string {
  return `<?xml version="1.0"?>
<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="${id}" title="${id}" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"><qti-correct-response><qti-value>A</qti-value></qti-correct-response></qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float" normal-maximum="1"><qti-default-value><qti-value>0</qti-value></qti-default-value></qti-outcome-declaration>
  <qti-item-body><qti-choice-interaction response-identifier="RESPONSE" max-choices="1" min-choices="1"><qti-prompt>Question ${id}: choose the letter A.</qti-prompt><qti-simple-choice identifier="A">A</qti-simple-choice><qti-simple-choice identifier="B">B</qti-simple-choice></qti-choice-interaction></qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;
}
