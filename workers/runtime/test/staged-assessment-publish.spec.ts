import qflowPackage from "../../../tests/fixtures/qti/staged-assessment/qflow-100.zip.b64?raw";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { prepareQtiPackage } from "../src/publish/qti-package-preparation";
import { binaryQuestionXml, stagedPackage } from "../../../tests/fixtures/staged-package";
import testXml from "../../../tests/fixtures/qti/staged-assessment/test.xml?raw";

it("binds all 30 alternatives while validating a constant 15-answer route", async () => {
  const prepared = await prepareQtiPackage(await stagedPackage(testXml));
  expect(prepared.items).toHaveLength(30);
  expect(prepared.testSequence?.answerCount).toBe(15);
  expect(prepared.testSequence?.itemIdsByRef.stage1_level1_item0).toBe("stage1_level1_0");
});

it("rejects unsupported selection, backward branching and unequal route lengths", async () => {
  for (const xml of [
    testXml.replace(
      "<qti-assessment-item-ref",
      '<qti-selection select="1"/><qti-assessment-item-ref',
    ),
    testXml.replace('target="stage1_level1"', 'target="stage0_level0"'),
    testXml.replace('target="stage1_level1"', 'target="EXIT_TEST"'),
  ])
    await expect(prepareQtiPackage(await stagedPackage(xml))).rejects.toMatchObject({
      status: 422,
    });
});

it("rejects a route whose item cannot produce an authoritative binary score", async () => {
  const zip = await JSZip.loadAsync(await stagedPackage(testXml));
  zip.file(
    "items/stage0_level0_0.xml",
    binaryQuestionXml("stage0_level0_0").replace(/<qti-response-processing[^>]+\/>/, ""),
  );
  await expect(
    prepareQtiPackage(await zip.generateAsync({ type: "uint8array" })),
  ).rejects.toMatchObject({ status: 422 });
});

it("accepts a compressed canonical package at the bounded inflater boundary", async () => {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await stagedPackage(testXml));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  expect((await prepareQtiPackage(bytes)).testSequence?.answerCount).toBe(15);
});

it("accepts the actual QFlow 100-answer package", async () => {
  const bytes = Uint8Array.from(atob(qflowPackage), (character) => character.charCodeAt(0));
  expect((await prepareQtiPackage(bytes)).testSequence?.answerCount).toBe(100);
});
