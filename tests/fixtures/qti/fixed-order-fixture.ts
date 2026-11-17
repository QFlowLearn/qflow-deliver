import JSZip from "jszip";

/** Synthetic question inventory for fixed section-order verification. */
export const ids = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
const ref = (id: string) =>
  `<qti-assessment-item-ref identifier="ref_${id}" href="items/${id}.xml"${id === "B" ? ' fixed="true"' : ""}/>`;
/** Synthetic QTI test with protected, authored and shuffled section slots. */
export const xml = `<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="T" title="Stable shuffle">
<qti-test-part identifier="P" navigation-mode="linear" submission-mode="simultaneous"><qti-time-limits max-time="600"/>
<qti-assessment-section identifier="S1" title="Shuffled" visible="true"><qti-ordering shuffle="true"/>${ids.slice(0, 4).map(ref).join("")}</qti-assessment-section>
<qti-assessment-section identifier="S2" title="Authored" visible="true"><qti-ordering shuffle="false"/>${ids.slice(4, 6).map(ref).join("")}</qti-assessment-section>
<qti-assessment-section identifier="S3" title="Shuffled" visible="true"><qti-ordering shuffle="true"/>${ids.slice(6).map(ref).join("")}</qti-assessment-section>
</qti-test-part></qti-assessment-test>`;
/** Build the same complete scored synthetic package for Worker and browser verification. */
export async function createFixedOrderPackage(
  itemXml: string,
  stimulusSvg: string,
  testXml: string,
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "imsmanifest.xml",
    `<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="fixed-order"><resources><resource identifier="T" type="imsqti_test_xmlv3p0" href="test.xml"><file href="test.xml"/></resource>${ids.map((id) => `<resource identifier="resource_${id}" type="imsqti_item_xmlv3p0" href="items/${id}.xml"><file href="items/${id}.xml"/></resource>`).join("")}</resources></manifest>`,
  );
  zip.file("test.xml", testXml);
  for (const id of ids)
    zip.file(
      `items/${id}.xml`,
      itemXml
        .replace('identifier="item-1"', `identifier="${id}"`)
        .replace("What is 2 + 2?", `Question ${id}`)
        .replace(
          "<qti-item-body>",
          `<qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"><qti-correct-response><qti-value>B</qti-value></qti-correct-response></qti-response-declaration><qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"><qti-default-value><qti-value>0</qti-value></qti-default-value></qti-outcome-declaration><qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float"><qti-default-value><qti-value>1</qti-value></qti-default-value></qti-outcome-declaration><qti-item-body>`,
        )
        .replace(
          "</qti-assessment-item>",
          `<qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/></qti-assessment-item>`,
        ),
    );
  zip.file("assets/stimulus.svg", stimulusSvg);
  return zip.generateAsync({ type: "arraybuffer" });
}
