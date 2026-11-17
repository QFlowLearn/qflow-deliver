import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseHarborQtiPackage } from "../src/publish/qti-package-model";
import { PublishInputError } from "../src/publish/publish-errors";

describe("Harbor qti3 package adapter", () => {
  it("stops inflation at the entry's declared output limit", async () => {
    const zip = new JSZip();
    zip.file("imsmanifest.xml", manifestXml);
    zip.file("items/item.xml", itemXml);
    const packageBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const view = new DataView(
      packageBytes.buffer,
      packageBytes.byteOffset,
      packageBytes.byteLength,
    );
    // Forge smaller output sizes in both ZIP headers without changing the compressed content.
    for (let offset = 0; offset + 28 <= packageBytes.length; offset += 1) {
      const signature = view.getUint32(offset, true);
      if (signature === 0x04034b50 && view.getUint32(offset + 22, true) > 0)
        view.setUint32(offset + 22, 1, true);
      if (signature === 0x02014b50 && view.getUint32(offset + 24, true) > 0)
        view.setUint32(offset + 24, 1, true);
    }

    await expect(parseHarborQtiPackage(packageBytes)).rejects.toThrow("could not be inflated");
  });

  it("retains exact entry bytes from a deflated package", async () => {
    const itemBytes = new TextEncoder().encode(itemXml);
    const zip = new JSZip();
    zip.file("imsmanifest.xml", manifestXml);
    zip.file("items/item.xml", itemBytes);
    const packageBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

    const parsed = await parseHarborQtiPackage(packageBytes);
    const retainedBytes = parsed.entriesByPath.get("items/item.xml")?.bytes;

    expect(retainedBytes).toEqual(itemBytes);
    expect(await sha256(retainedBytes ?? new Uint8Array())).toBe(await sha256(itemBytes));
  });

  it("keeps supported timing diagnostics nonfatal for Harbor readiness findings", async () => {
    const zip = new JSZip();
    zip.file("imsmanifest.xml", assessmentTestManifestXml);
    zip.file("assessment.xml", assessmentTestXml);
    zip.file("items/item.xml", itemXml);

    const parsed = await parseHarborQtiPackage(
      await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
    );

    expect(parsed.package.packageShape).toBe("assessment-test-resource");
    expect(parsed.package.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package.attribute.min-time.number" }),
        expect.objectContaining({ code: "package.attribute.allow-late-submission.boolean" }),
      ]),
    );
  });

  it("maps fatal package diagnostics to a 422 publish error", async () => {
    const zip = new JSZip();
    zip.file("items/item.xml", itemXml);
    const packageBytes = await zip.generateAsync({ type: "uint8array" });

    await expect(parseHarborQtiPackage(packageBytes)).rejects.toThrow(
      expect.objectContaining<Partial<PublishInputError>>({ status: 422 }),
    );
  });

  it("fails closed for qti3 package errors not explicitly handled as readiness findings", async () => {
    const zip = new JSZip();
    zip.file(
      "imsmanifest.xml",
      manifestXml.replace(
        "  </resources>",
        `    <resource identifier="item-duplicate" type="imsqti_item_xmlv3p0" href="items/item.xml">
      <file href="items/item.xml"/>
    </resource>
  </resources>`,
      ),
    );
    zip.file("items/item.xml", itemXml);
    const packageBytes = await zip.generateAsync({ type: "uint8array" });

    await expect(parseHarborQtiPackage(packageBytes)).rejects.toThrow(
      expect.objectContaining<Partial<PublishInputError>>({ status: 422 }),
    );
  });
});

const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="package">
  <resources>
    <resource identifier="item" type="imsqti_item_xmlv3p0" href="items/item.xml">
      <file href="items/item.xml"/>
    </resource>
  </resources>
</manifest>`;

const assessmentTestManifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest xmlns="http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1" identifier="package">
  <resources>
    <resource identifier="test" type="imsqti_test_xmlv3p0" href="assessment.xml">
      <file href="assessment.xml"/>
    </resource>
    <resource identifier="item" type="imsqti_item_xmlv3p0" href="items/item.xml">
      <file href="items/item.xml"/>
    </resource>
  </resources>
</manifest>`;

const assessmentTestXml = `<qti-assessment-test xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="test" title="Test">
  <qti-time-limits min-time="invalid" allow-late-submission="maybe"/>
  <qti-test-part identifier="part" navigation-mode="linear" submission-mode="individual">
    <qti-assessment-section identifier="section" visible="true">
      <qti-assessment-item-ref identifier="ref" href="items/item.xml"/>
    </qti-assessment-section>
  </qti-test-part>
</qti-assessment-test>`;

const itemXml = `<qti-assessment-item xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="item" title="Item" adaptive="false" time-dependent="false">
  <qti-item-body><p>Prompt</p></qti-item-body>
</qti-assessment-item>`;

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
