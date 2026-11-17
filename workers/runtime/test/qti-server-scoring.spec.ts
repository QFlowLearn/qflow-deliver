import { describe, expect, it } from "vitest";
import type { AttemptSubmissionMaterializationInput } from "@harbor/attempt-protocol";
import {
  DEFAULT_DELIVERY_POLICY_SNAPSHOT,
  DELIVERY_MANIFEST_SCHEMA_VERSION,
  type DeliveryManifest,
} from "@harbor/content-model";
import { scoreSubmissionWithAuthoritativeQti } from "../src/results/qti-server-scoring";

describe("authoritative qti server scoring", () => {
  it("materializes zero score for unprocessed media items that declare SCORE", async () => {
    const scored = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/interactive-media.xml": UNPROCESSED_MEDIA_ITEM_XML,
      }),
      manifest: createManifest({
        itemId: "interactive-media-20260318225145",
        objectKey: "items/interactive-media.xml",
      }),
      materialization: createMaterialization("interactive-media-20260318225145"),
      scoredAt: "2026-05-25T12:00:00.000Z",
    });

    const item = scored.items["interactive-media-20260318225145"];

    expect(item.outcomeVariables).toEqual(
      expect.arrayContaining([{ identifier: "SCORE", value: 0 }]),
    );
    expect(item.outcomeVariables).not.toContainEqual({
      identifier: "MAXSCORE",
      value: 0,
    });
    expect(item.stateJson).toMatchObject({
      outcomes: {
        SCORE: 0,
      },
    });
  });

  it("materializes zero score for end-attempt reference items that declare SCORE", async () => {
    const scored = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/end-attempt.xml": END_ATTEMPT_REFERENCE_ITEM_XML,
      }),
      manifest: createManifest({
        itemId: "end-attempt-reference",
        objectKey: "items/end-attempt.xml",
      }),
      materialization: createMaterialization("end-attempt-reference"),
      scoredAt: "2026-05-25T12:00:00.000Z",
    });

    const item = scored.items["end-attempt-reference"];

    expect(item.outcomeVariables).toEqual(
      expect.arrayContaining([{ identifier: "SCORE", value: 0 }]),
    );
    expect(item.outcomeVariables).not.toContainEqual({
      identifier: "HARBOR_SCORING_STATUS",
      value: "pending-manual-scoring",
    });
    expect(item.stateJson).toMatchObject({
      outcomes: {
        SCORE: 0,
      },
    });
  });

  it("marks manually scored interactions pending instead of zeroing SCORE", async () => {
    const scored = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/upload.xml": UNPROCESSED_UPLOAD_ITEM_XML,
      }),
      manifest: createManifest({
        itemId: "constructed-upload-reflection",
        objectKey: "items/upload.xml",
      }),
      materialization: createMaterialization("constructed-upload-reflection"),
      scoredAt: "2026-05-25T12:00:00.000Z",
    });

    const item = scored.items["constructed-upload-reflection"];

    expect(item.outcomeVariables).toEqual(
      expect.arrayContaining([
        {
          identifier: "HARBOR_SCORING_STATUS",
          value: "pending-manual-scoring",
        },
      ]),
    );
    expect(item.outcomeVariables).not.toContainEqual({
      identifier: "SCORE",
      value: 0,
    });
    expect(item.stateJson).toMatchObject({
      outcomes: {
        HARBOR_SCORING_STATUS: "pending-manual-scoring",
      },
    });
  });

  it("keeps manually scored interactions pending even when qti-core has a numeric default", async () => {
    const scored = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/drawing.xml": MANUAL_DRAWING_WITH_DEFAULT_SCORE_XML,
      }),
      manifest: createManifest({
        itemId: "constructed-drawing-annotation",
        objectKey: "items/drawing.xml",
      }),
      materialization: createMaterialization("constructed-drawing-annotation"),
      scoredAt: "2026-05-25T12:00:00.000Z",
    });

    expect(scored.items["constructed-drawing-annotation"].outcomeVariables).toEqual(
      expect.arrayContaining([
        {
          identifier: "HARBOR_SCORING_STATUS",
          value: "pending-manual-scoring",
        },
      ]),
    );
  });

  it("auto-scores extended text when response processing produces SCORE", async () => {
    const scored = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/extended-text.xml": AUTO_SCORED_EXTENDED_TEXT_XML,
      }),
      manifest: createManifest({
        itemId: "constructed-fdr-short-answer",
        objectKey: "items/extended-text.xml",
      }),
      materialization: createMaterialization("constructed-fdr-short-answer", [
        { identifier: "RESPONSE", value: "fireside chats" },
      ]),
      scoredAt: "2026-05-25T12:00:00.000Z",
    });

    const item = scored.items["constructed-fdr-short-answer"];

    expect(item.outcomeVariables).toEqual(
      expect.arrayContaining([{ identifier: "SCORE", value: 1 }]),
    );
    expect(item.outcomeVariables).not.toContainEqual({
      identifier: "HARBOR_SCORING_STATUS",
      value: "pending-manual-scoring",
    });
  });

  it("scores adaptive items through unified qti3 submission materialization", async () => {
    const firstTurn = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/adaptive.xml": ADAPTIVE_CHOICE_XML,
      }),
      manifest: createManifest({
        itemId: "adaptive-check",
        objectKey: "items/adaptive.xml",
      }),
      materialization: createMaterialization("adaptive-check", [
        { identifier: "RESPONSE", value: "B" },
      ]),
      scoredAt: "2026-05-25T12:00:00.000Z",
    });

    expect(firstTurn.items["adaptive-check"].outcomeVariables).toEqual(
      expect.arrayContaining([
        { identifier: "SCORE", value: 0 },
        { identifier: "TRACE", value: "wrong-first" },
        { identifier: "completionStatus", value: "unknown" },
      ]),
    );

    const secondTurn = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/adaptive.xml": ADAPTIVE_CHOICE_XML,
      }),
      manifest: createManifest({
        itemId: "adaptive-check",
        objectKey: "items/adaptive.xml",
      }),
      materialization: createMaterialization(
        "adaptive-check",
        [{ identifier: "RESPONSE", value: "A" }],
        firstTurn.items["adaptive-check"].stateJson,
      ),
      scoredAt: "2026-05-25T12:01:00.000Z",
    });

    expect(secondTurn.items["adaptive-check"].outcomeVariables).toEqual(
      expect.arrayContaining([
        { identifier: "SCORE", value: 1 },
        { identifier: "TRACE", value: "wrong-first" },
        { identifier: "completionStatus", value: "completed" },
      ]),
    );
    expect(secondTurn.items["adaptive-check"].stateJson).toMatchObject({
      status: "completed",
    });
  });

  it("still rejects invalid response-processed scoring definitions", async () => {
    await expect(
      scoreSubmissionWithAuthoritativeQti({
        bucket: createTextBucket({
          "items/processed-without-score.xml": PROCESSED_ITEM_WITHOUT_SCORE_XML,
        }),
        manifest: createManifest({
          itemId: "processed-without-score",
          objectKey: "items/processed-without-score.xml",
        }),
        materialization: createMaterialization("processed-without-score"),
        scoredAt: "2026-05-25T12:00:00.000Z",
      }),
    ).rejects.toThrow(
      "Built-in response-processing templates require an outcome declaration named SCORE",
    );
  });

  it("does not invent scoring status for non-scoring interactive items missing SCORE", async () => {
    const scored = await scoreSubmissionWithAuthoritativeQti({
      bucket: createTextBucket({
        "items/non-scoring-choice.xml": NON_SCORING_CHOICE_WITHOUT_SCORE_XML,
      }),
      manifest: createManifest({
        itemId: "non-scoring-choice",
        objectKey: "items/non-scoring-choice.xml",
      }),
      materialization: createMaterialization("non-scoring-choice", [
        { identifier: "RESPONSE", value: "A" },
      ]),
      scoredAt: "2026-05-25T12:00:00.000Z",
    });

    const item = scored.items["non-scoring-choice"];

    expect(item.outcomeVariables).not.toContainEqual({
      identifier: "SCORE",
      value: 0,
    });
    expect(item.outcomeVariables).not.toContainEqual({
      identifier: "HARBOR_SCORING_STATUS",
      value: "pending-manual-scoring",
    });
    expect(item.stateJson).toMatchObject({
      responses: {
        RESPONSE: "A",
      },
    });
  });
});

function createTextBucket(objects: Record<string, string>): R2Bucket {
  return {
    async get(key: string) {
      const text = objects[key];
      if (text === undefined) {
        return null;
      }

      return {
        async text() {
          return text;
        },
      };
    },
  } as unknown as R2Bucket;
}

function createManifest(input: { itemId: string; objectKey: string }): DeliveryManifest {
  return {
    schemaVersion: DELIVERY_MANIFEST_SCHEMA_VERSION,
    tenantId: "tenant-test",
    assessmentId: "asmt-test",
    assessmentVersionId: "vers-test",
    title: "Test Assessment",
    packageObjectKey: "package.zip",
    manifestObjectKey: "delivery.json",
    itemOrder: [input.itemId],
    items: {
      [input.itemId]: {
        id: input.itemId,
        identifier: input.itemId,
        title: input.itemId,
        href: `${input.itemId}.xml`,
        deliveryObjectKey: input.objectKey,
        objectKey: input.objectKey,
        assetIds: [],
        maxScore: null,
      },
    },
    assets: {},
    deliveryPolicySnapshot: DEFAULT_DELIVERY_POLICY_SNAPSHOT,
  };
}

function createMaterialization(
  itemId: string,
  responseVariables: AttemptSubmissionMaterializationInput["items"][string]["responseVariables"] = [],
  stateJson?: unknown,
): AttemptSubmissionMaterializationInput {
  return {
    itemOrder: [itemId],
    testState: null,
    partStates: {},
    sectionStates: {},
    items: {
      [itemId]: {
        itemId,
        itemIdentifier: itemId,
        itemTitle: itemId,
        capturedAt: "2026-05-25T11:59:00.000Z",
        responseVariables,
        outcomeVariables: [],
        validationMessages: [],
        ...(stateJson !== undefined ? { stateJson } : {}),
      },
    },
  };
}

const UNPROCESSED_MEDIA_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="interactive-media-20260318225145"
  title="Review the timeline."
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="integer"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <p>Use the timeline as a visual reference.</p>
    <qti-media-interaction response-identifier="RESPONSE" autostart="false" loop="false" label="Timeline reference">
      <qti-prompt>Open the media object for the timeline.</qti-prompt>
      <object data="data:image/svg+xml;base64,PHN2Zy8+" type="image/svg+xml" width="480" height="260" label="Presidential timeline"/>
    </qti-media-interaction>
  </qti-item-body>
</qti-assessment-item>`;

const END_ATTEMPT_REFERENCE_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="end-attempt-reference"
  title="Finish screen"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="boolean"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <qti-end-attempt-interaction response-identifier="RESPONSE" title="Finish">
      <qti-prompt>Finish the assessment.</qti-prompt>
    </qti-end-attempt-interaction>
  </qti-item-body>
</qti-assessment-item>`;

const PROCESSED_ITEM_WITHOUT_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="processed-without-score"
  title="Processed item without SCORE"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>A</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="A">A</qti-simple-choice>
      <qti-simple-choice identifier="B">B</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

const NON_SCORING_CHOICE_WITHOUT_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="non-scoring-choice"
  title="Practice choice"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"/>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="A">A</qti-simple-choice>
      <qti-simple-choice identifier="B">B</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
</qti-assessment-item>`;

const UNPROCESSED_UPLOAD_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="constructed-upload-reflection"
  title="Upload your reflection."
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="file"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-item-body>
    <qti-upload-interaction response-identifier="RESPONSE">
      <qti-prompt>Upload your reflection.</qti-prompt>
    </qti-upload-interaction>
  </qti-item-body>
</qti-assessment-item>`;

const MANUAL_DRAWING_WITH_DEFAULT_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="constructed-drawing-annotation"
  title="Annotate the map."
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="file"/>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float">
    <qti-default-value>
      <qti-value>0</qti-value>
    </qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-drawing-interaction response-identifier="RESPONSE">
      <qti-prompt>Annotate the map.</qti-prompt>
      <object data="data:image/svg+xml;base64,PHN2Zy8+" type="image/svg+xml" width="480" height="260"/>
    </qti-drawing-interaction>
  </qti-item-body>
  </qti-assessment-item>`;

const AUTO_SCORED_EXTENDED_TEXT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="constructed-fdr-short-answer"
  title="FDR short answer."
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="string">
    <qti-correct-response>
      <qti-value>fireside chats</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value>
      <qti-value>1</qti-value>
    </qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-extended-text-interaction response-identifier="RESPONSE">
      <qti-prompt>Name FDR's radio addresses.</qti-prompt>
    </qti-extended-text-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;

const ADAPTIVE_CHOICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="adaptive-check"
  title="Adaptive Check"
  adaptive="true"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response><qti-value>A</qti-value></qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>0</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value><qti-value>1</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-outcome-declaration identifier="TRACE" cardinality="single" base-type="identifier">
    <qti-default-value><qti-value>start</qti-value></qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="A">A</qti-simple-choice>
      <qti-simple-choice identifier="B">B</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing>
    <qti-response-condition>
      <qti-response-if>
        <qti-match>
          <qti-variable identifier="RESPONSE"/>
          <qti-correct identifier="RESPONSE"/>
        </qti-match>
        <qti-set-outcome-value identifier="SCORE">
          <qti-base-value base-type="float">1</qti-base-value>
        </qti-set-outcome-value>
        <qti-set-outcome-value identifier="completionStatus">
          <qti-base-value base-type="identifier">completed</qti-base-value>
        </qti-set-outcome-value>
      </qti-response-if>
      <qti-response-else>
        <qti-set-outcome-value identifier="TRACE">
          <qti-base-value base-type="identifier">wrong-first</qti-base-value>
        </qti-set-outcome-value>
      </qti-response-else>
    </qti-response-condition>
  </qti-response-processing>
</qti-assessment-item>`;
