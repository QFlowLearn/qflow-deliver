import { describe, expect, it } from "vitest";
import { createItemSession, parseQtiXml, type QtiAttemptStateV1 } from "@longsightgroup/qti3-core";
import {
  readQtiOutcomeSnapshots,
  readQtiResponseSnapshots,
  readQtiValidationSnapshots,
} from "@harbor/attempt-protocol";

describe("qti3 attempt state bridge", () => {
  it("returns empty snapshots for an unanswered qti3 item", () => {
    const state = createState();

    expect(readQtiResponseSnapshots(state)).toEqual([]);
    expect(readQtiOutcomeSnapshots(state)).toEqual([]);
  });

  it("materializes answered response variables at Harbor boundaries", () => {
    const state = createState({
      responses: {
        RESPONSE: "choice-a",
      },
    });

    expect(readQtiResponseSnapshots(state)).toEqual([
      { identifier: "RESPONSE", value: "choice-a" },
    ]);
  });

  it("materializes scored SCORE and MAXSCORE outcome variables", () => {
    const state = createState({
      outcomes: {
        SCORE: 1,
        MAXSCORE: 1,
        completionStatus: "completed",
      },
      status: "completed",
    });

    expect(readQtiOutcomeSnapshots(state)).toEqual([
      { identifier: "SCORE", value: 1 },
      { identifier: "MAXSCORE", value: 1 },
      { identifier: "completionStatus", value: "completed" },
    ]);
  });

  it("materializes qti3-core numeric declaration defaults", () => {
    const session = createScoredFixtureSession();
    const state = session.serialize();

    expect(state.outcomes.MAXSCORE).toBe(1);
    expect(typeof state.outcomes.MAXSCORE).toBe("number");
    expect(readQtiOutcomeSnapshots(state)).toContainEqual({
      identifier: "MAXSCORE",
      value: 1,
    });
  });

  it("materializes qti3-core scored unanswered items as zero", () => {
    const session = createScoredFixtureSession();
    const result = session.score();

    expect(result.state.outcomes.SCORE).toBe(0);
    expect(result.state.outcomes.MAXSCORE).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it("converts qti diagnostics to Harbor validation snapshots", () => {
    const state = createState({
      validationMessages: [
        {
          code: "qti.validation.required",
          severity: "error",
          message: "A response is required.",
          path: "RESPONSE",
        },
        {
          code: "qti.validation.fallback",
          severity: "warning",
          message: "Fallback message.",
        },
      ],
    });

    expect(readQtiValidationSnapshots(state)).toEqual([
      { identifier: "RESPONSE", message: "A response is required." },
      { identifier: "qti.validation.fallback", message: "Fallback message." },
    ]);
  });

  it("preserves restored suspended qti3 state without compatibility conversion", () => {
    const state = createState({
      status: "suspended",
      responses: {
        RESPONSE: ["A", "B"],
      },
      outcomes: {
        SCORE: 0.5,
      },
    });

    expect(readQtiResponseSnapshots(state)).toEqual([
      { identifier: "RESPONSE", value: ["A", "B"] },
    ]);
    expect(readQtiOutcomeSnapshots(state)).toEqual([{ identifier: "SCORE", value: 0.5 }]);
  });
});

function createState(overrides: Partial<QtiAttemptStateV1> = {}): QtiAttemptStateV1 {
  return {
    schema: "qti3.attempt-state.v1",
    itemIdentifier: "item-1",
    status: "interacting",
    responses: {},
    outcomes: {},
    validationMessages: [],
    ...overrides,
  };
}

function createScoredFixtureSession() {
  const parsed = parseQtiXml(SCORED_ITEM_XML);
  if (!parsed.document) {
    throw new Error("Expected scored fixture QTI XML to parse.");
  }

  return createItemSession(parsed.document);
}

const SCORED_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item
  xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
  identifier="item-1"
  title="Opening Warmup"
  adaptive="false"
  time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response>
      <qti-value>A</qti-value>
    </qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
  <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float">
    <qti-default-value>
      <qti-value>1</qti-value>
    </qti-default-value>
  </qti-outcome-declaration>
  <qti-item-body>
    <qti-prompt>Which president served as the first president of the United States?</qti-prompt>
    <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
      <qti-simple-choice identifier="A">George Washington</qti-simple-choice>
      <qti-simple-choice identifier="B">John Adams</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct"/>
</qti-assessment-item>`;
