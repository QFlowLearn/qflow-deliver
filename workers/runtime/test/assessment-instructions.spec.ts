import { expect, it } from "vitest";
import JSZip from "jszip";
import { applyD1Migrations, env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import type { BootstrapEnvelope } from "@harbor/attempt-protocol";
import { parseAssessmentInstructionBlocks } from "@harbor/content-model";
import { parseHarborQtiPackage } from "../src/publish/qti-package-model";
import { prepareAssessmentInstructions } from "../src/publish/assessment-instructions";
import canonicalPackage from "../../../tests/fixtures/qti/part-settings/qflow-part-settings.zip.b64?raw";

const expectedItemIds = [
  "item-b35efecb-927b-46d4-a4e8-21950c2e44e0-r1",
  "item-83eb5274-d3d0-4c39-b559-534205a21b2c-r1",
];
const partId = "part-1-8f5609ae-0d4b-4b5a-95f9-2763d36de275";

async function readCanonicalPackage() {
  return JSZip.loadAsync(Uint8Array.from(atob(canonicalPackage), (value) => value.charCodeAt(0)));
}

async function prepare(zip: JSZip) {
  const model = await parseHarborQtiPackage(await zip.generateAsync({ type: "uint8array" }));
  return prepareAssessmentInstructions(
    model.package.assessmentTest,
    model.package.items.map((item) => {
      const identifier = item.document?.item.identifier;
      if (!identifier) throw new Error("Canonical fixture item has no identifier");
      return { id: identifier, href: item.href };
    }),
  );
}

it("preserves actual QFlow instructions with their exact part scope and item bindings", async () => {
  const prepared = await prepare(await readCanonicalPackage());
  expect(prepared.assetHrefs).toEqual([]);
  expect(prepared.blocks).toEqual([
    {
      scopeType: "test-part",
      scopeIdentifier: partId,
      title: "Part 1",
      itemIds: expectedItemIds,
      assetBaseHref: "assessment.xml",
      content: [
        {
          kind: "element",
          name: "section",
          attributes: {},
          children: [
            {
              kind: "element",
              name: "p",
              attributes: {},
              children: [
                {
                  kind: "text",
                  text: "Read every question before submitting.",
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
});

async function nestedInstructionPackage(): Promise<JSZip> {
  const source = await readCanonicalPackage();
  const test = source.file("assessment.xml");
  const manifest = source.file("imsmanifest.xml");
  if (!test || !manifest) throw new Error("Canonical test/manifest fixture is missing");
  const testXml = (await test.async("string"))
    .replace(
      '<qti-rubric-block view="candidate"',
      '<qti-rubric-block view="scorer" use="instructions"><qti-content-body><p>Private key.</p></qti-content-body></qti-rubric-block><qti-rubric-block view="candidate"',
    )
    .replace(
      "Read every question before submitting.</p>",
      'Read every question before submitting.</p><img src="assets/map.svg" alt="Reference map"/>',
    );
  source.file("assessment.xml", testXml);
  source.file(
    "assets/map.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const nested = new JSZip();
  nested.file(
    "imsmanifest.xml",
    (await manifest.async("string")).replaceAll('href="', 'href="content/'),
  );
  for (const [name, file] of Object.entries(source.files)) {
    if (!file.dir && name !== "imsmanifest.xml")
      nested.file(`content/${name}`, await file.async("uint8array"));
  }
  return nested;
}

it("binds already resolved item references once and discovers candidate assets relative to a nested test", async () => {
  const prepared = await prepare(await nestedInstructionPackage());
  expect(JSON.stringify(prepared.blocks)).not.toContain("Private key.");
  expect(prepared.blocks).toHaveLength(1);
  expect(prepared.blocks[0]).toMatchObject({
    scopeIdentifier: partId,
    itemIds: expectedItemIds,
    assetBaseHref: "content/assessment.xml",
  });
  expect(prepared.assetHrefs).toEqual(["content/assets/map.svg"]);
  expect(JSON.stringify(prepared.blocks)).toContain('"src":"assets/map.svg"');
});

it("publishes instruction-only assets immutably and resolves them through the correct pinned attempt", async () => {
  await applyD1Migrations(env.HARBOR_DB, env.TEST_MIGRATIONS);
  async function publishAndLaunch(zip: JSZip, slug: string) {
    const published = await workerExports.default.fetch(
      new Request(`https://harbor.local/internal/publish?assessmentSlug=${slug}`, {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-harbor-package-name": "instructions.zip",
          "x-harbor-tenant-id": "tenant_instruction_assets",
        },
        body: await zip.generateAsync({ type: "arraybuffer" }),
      }),
    );
    expect(published.status, await published.clone().text()).toBe(201);
    const version = await published.json<{
      assessmentVersionId: string;
      manifestObjectKey: string;
    }>();
    const launch = await workerExports.default.fetch(
      new Request("https://harbor.local/api/launch/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          assessmentVersionId: version.assessmentVersionId,
          actor: { kind: "preview-operator", id: "instruction-reader", displayName: "Reader" },
        }),
      }),
    );
    expect(launch.status).toBe(201);
    const envelope = await launch.json<BootstrapEnvelope>();
    const bootstrap = await workerExports.default.fetch(
      new Request("https://harbor.local/api/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bootstrapToken: envelope.bootstrapToken,
          clientSessionId: "instructions_client",
        }),
      }),
    );
    expect(bootstrap.status).toBe(200);
    const payload = await bootstrap.json<{ attemptId: string }>();
    return { ...version, attemptId: payload.attemptId };
  }
  const version = await publishAndLaunch(await nestedInstructionPackage(), "scoped-instructions");
  const stored = await env.CONTENT_BUCKET.get(version.manifestObjectKey);
  if (!stored) throw new Error("Publication did not store its manifest");
  const storedBytes = new Uint8Array(await stored.arrayBuffer());
  expect(new TextDecoder().decode(storedBytes)).not.toContain("Private key.");
  const response = await workerExports.default.fetch(
    new Request(`https://harbor.local/api/content/manifest?attemptId=${version.attemptId}`),
  );
  expect(response.status).toBe(200);
  const manifest = await response.json<{
    assessmentInstructions: unknown;
    assessmentVersionId: string;
  }>();
  expect(manifest.assessmentVersionId).toBe(version.assessmentVersionId);
  const parsed = parseAssessmentInstructionBlocks(manifest.assessmentInstructions);
  if (!parsed.ok) throw new Error("Delivery returned invalid instruction metadata");
  const blocks = parsed.value;
  expect(blocks).toHaveLength(1);
  let imageUrl: string | undefined;
  function findImage(nodes: (typeof blocks)[number]["content"]): void {
    for (const node of nodes) {
      if (node.kind === "element") {
        if (node.name === "img") imageUrl = node.attributes.src;
        findImage(node.children);
      }
    }
  }
  for (const block of blocks) findImage(block.content);
  if (!imageUrl) throw new Error("Instructions lost their candidate image");
  expect(imageUrl).toContain(`/api/content/assets/`);
  expect(new URL(imageUrl, "https://harbor.local").searchParams.get("attemptId")).toBe(
    version.attemptId,
  );
  const image = await workerExports.default.fetch(
    new Request(new URL(imageUrl, "https://harbor.local")),
  );
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/svg+xml");
  expect(await image.text()).toContain('<rect width="10" height="10"/>');
  const other = await publishAndLaunch(await readCanonicalPackage(), "other-instructions");
  const wrongAttemptUrl = new URL(imageUrl, "https://harbor.local");
  wrongAttemptUrl.searchParams.set("attemptId", other.attemptId);
  expect((await workerExports.default.fetch(new Request(wrongAttemptUrl))).status).toBe(404);
  const after = await env.CONTENT_BUCKET.get(version.manifestObjectKey);
  if (!after) throw new Error("Instruction delivery removed its manifest");
  expect(new Uint8Array(await after.arrayBuffer())).toEqual(storedBytes);
});

it("parses stored instruction records through the shared sanitizer and rejects malformed scope metadata", () => {
  const block = {
    scopeType: "test-part",
    scopeIdentifier: "P",
    title: null,
    itemIds: ["I"],
    assetBaseHref: "tests/assessment.xml",
    content: [
      {
        kind: "element",
        name: "a",
        attributes: { href: "javascript:bad()", onclick: "bad()" },
        children: [{ kind: "text", text: "Read help." }],
      },
    ],
  };
  expect(parseAssessmentInstructionBlocks(JSON.parse(JSON.stringify([block])))).toEqual({
    ok: true,
    value: [
      {
        ...block,
        content: [
          {
            kind: "element",
            name: "a",
            attributes: {},
            children: [{ kind: "text", text: "Read help." }],
          },
        ],
      },
    ],
  });
  for (const invalid of [
    null,
    [{ ...block, scopeType: "item-session" }],
    [{ ...block, itemIds: ["I", "I"] }],
    [{ ...block, assetBaseHref: "../test.xml" }],
    [{ ...block, content: [{ kind: "text", text: false }] }],
  ]) {
    expect(parseAssessmentInstructionBlocks(invalid)).toEqual({
      ok: false,
      code: "assessment.instructions.invalid",
    });
  }
});
