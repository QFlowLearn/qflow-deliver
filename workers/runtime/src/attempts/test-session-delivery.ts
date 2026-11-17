import { loadTestSessionDefinition, type TestSessionRuntime } from "./test-session-runtime";
import {
  parseQtiXml,
  snapshotQtiTestSession,
  startQtiTest,
  submitQtiTestAnswer,
  type QtiTestSessionSnapshot,
} from "@longsightgroup/qti3-core";
import type { AttemptEventEnvelope, CurrentItemRef } from "@harbor/attempt-protocol";
import type { TestSequenceDescriptor } from "@harbor/content-model";
import type { StoredAttemptState } from "./attempt-state-bootstrap";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";
import { readSubmissionMaterializationFromResponseChange } from "./attempt-materialization";
import { materializeHarborQtiItemSubmission } from "../results/harbor-qti-submission-materialization";
import { applyScopedTimingEvent } from "./attempt-timing";
import { validateParsedQtiResponses } from "../results/harbor-qti-response-validation";

/** Persisted execution state; XML and binding remain pinned to the published version. */
export interface StoredTestSequence {
  readonly descriptor: TestSequenceDescriptor;
  readonly snapshot: QtiTestSessionSnapshot;
}

/** Load and validate the pinned test before starting an attempt. */
export async function initializeTestSequence(
  bucket: R2Bucket,
  descriptor: TestSequenceDescriptor,
  current: CurrentItemRef,
): Promise<StoredTestSequence> {
  const test = await loadTestSessionDefinition(bucket, descriptor.objectKey);
  const started = startQtiTest(test);
  if (!started.ok) throw new AttemptDurableObjectRequestError(409, "Published test cannot start");
  const session = started.value;
  if (
    session.status !== "active" ||
    descriptor.itemIdsByRef[session.currentItemRef] !== current.itemId
  )
    throw new AttemptDurableObjectRequestError(409, "Published test and initial item do not agree");
  return { descriptor, snapshot: snapshotQtiTestSession(session) };
}

/** Reject arbitrary navigation, stale answer edits and injected final-submit materialization. */
export function guardTestSequenceEvent(
  state: StoredAttemptState,
  event: AttemptEventEnvelope,
): void {
  if (!state.testSequence) {
    if (event.type === "item.submit-requested")
      throw new AttemptDurableObjectRequestError(
        409,
        "This attempt does not use sequenced answer submission",
      );
    return;
  }
  if (event.type === "navigation.requested")
    throw new AttemptDurableObjectRequestError(409, "Submit the current answer to continue");
  if (
    event.itemRef.itemId !== state.currentItemRef.itemId ||
    event.itemRef.itemHref !== state.currentItemRef.itemHref
  )
    throw new AttemptDurableObjectRequestError(409, "Only the current question accepts changes");
}

/** Score and advance one answer; the caller atomically commits this state with its receipt. */
export async function advanceTestSequenceAnswer(input: {
  bucket: R2Bucket;
  runtime: TestSessionRuntime;
  state: StoredAttemptState;
  event: AttemptEventEnvelope<"item.submit-requested">;
  at: string;
}): Promise<StoredAttemptState> {
  const sequence = input.state.testSequence;
  if (!sequence) throw new AttemptDurableObjectRequestError(409, "Attempt has no test sequence");
  const { test, session } = await input.runtime.restore(
    sequence.descriptor.objectKey,
    sequence.snapshot,
  );
  if (
    session.status !== "active" ||
    sequence.descriptor.itemIdsByRef[session.currentItemRef] !== input.event.itemRef.itemId ||
    input.event.payload.responseKey !== input.event.itemRef.itemId
  )
    throw new AttemptDurableObjectRequestError(409, "Answer does not match the current test item");
  const itemId = input.event.itemRef.itemId;
  const source = input.state.manifestItems[itemId];
  const incoming = readSubmissionMaterializationFromResponseChange(
    input.state,
    input.event,
    input.at,
  );
  const submitted = incoming?.items[itemId];
  if (!source || !submitted || submitted.responseVariables.length === 0)
    throw new AttemptDurableObjectRequestError(422, "Choose an answer before continuing");
  const xml = await input.bucket.get(source.objectKey);
  if (!xml) throw new AttemptDurableObjectRequestError(500, "Published question is unavailable");
  const itemXml = await xml.text();
  const parsed = parseQtiXml(itemXml);
  if (!parsed.ok || !parsed.document)
    throw new AttemptDurableObjectRequestError(409, "Published question cannot be scored");
  const validation = validateParsedQtiResponses({
    itemId,
    item: parsed.document.item,
    itemSnapshot: submitted,
    allowIncompleteResponses: false,
  });
  if (!validation.ok)
    throw new AttemptDurableObjectRequestError(422, "Choose a valid answer before continuing");
  const scored = materializeHarborQtiItemSubmission({
    itemId,
    itemXml,
    existing: submitted,
    allowIncompleteResponses: false,
  });
  const score = scored.outcomeVariables.find((v) => v.identifier === "SCORE")?.value;
  if (score !== 0 && score !== 1)
    throw new AttemptDurableObjectRequestError(422, "Question did not produce a binary score");
  const advanced = submitQtiTestAnswer(test, session, { itemRef: session.currentItemRef, score });
  if (!advanced.ok)
    throw new AttemptDurableObjectRequestError(409, "Answer cannot advance this test route");
  const next = advanced.value;
  const nextId =
    next.status === "active" ? sequence.descriptor.itemIdsByRef[next.currentItemRef] : itemId;
  const currentItemRef = input.state.allowedItemRefs.find((r) => r.itemId === nextId);
  if (!currentItemRef)
    throw new AttemptDurableObjectRequestError(
      409,
      "Published route references an unavailable question",
    );
  const itemOrder = next.submissions.map((s) => {
    const id = sequence.descriptor.itemIdsByRef[s.itemRef];
    if (!id)
      throw new AttemptDurableObjectRequestError(409, "Published route has a missing item binding");
    return id;
  });
  if (next.status === "active") itemOrder.push(currentItemRef.itemId);
  const timingEvent:
    | AttemptEventEnvelope<"navigation.requested">
    | AttemptEventEnvelope<"submit.requested"> =
    next.status === "active"
      ? { ...input.event, type: "navigation.requested", payload: { targetItemRef: currentItemRef } }
      : { ...input.event, type: "submit.requested", payload: {} };
  return {
    ...input.state,
    highestCommittedSequence: input.event.sequenceNumber,
    currentClientSessionId: input.event.clientSessionId,
    currentItemRef,
    attemptStatus: next.status === "completed" ? "submitted" : input.state.attemptStatus,
    scopedTiming: applyScopedTimingEvent(
      input.state.scopedTiming,
      input.state.currentItemRef,
      timingEvent,
      input.at,
    ),
    testSequence: {
      descriptor: sequence.descriptor,
      snapshot: input.runtime.remember(sequence.descriptor.objectKey, test, next),
    },
    submissionMaterialization: {
      ...input.state.submissionMaterialization,
      itemOrder,
      items: {
        ...input.state.submissionMaterialization.items,
        [itemId]: { ...submitted, ...scored, serverState: { testSubmission: { score } } },
      },
    },
  };
}

/** Server-owned receipt summary keeps a submitted route visible while finalization runs. */
export function summarizeTestSubmission(state: StoredAttemptState, submittedAt: string) {
  const sequence = state.testSequence;
  if (!sequence) throw new Error("A sequenced summary requires a test session.");
  const accepted = new Set(
    sequence.snapshot.submissions.map((entry) => sequence.descriptor.itemIdsByRef[entry.itemRef]),
  );
  const items = state.submissionMaterialization.itemOrder.map((itemId) => {
    const source = state.manifestItems[itemId];
    if (!source?.itemIdentifier || !source.itemTitle)
      throw new Error("Submitted item metadata is unavailable.");
    return {
      itemId,
      itemIdentifier: source.itemIdentifier,
      itemTitle: source.itemTitle,
      answered: accepted.has(itemId),
      score: null,
      maxScore: 1,
    };
  });
  return {
    submittedAt,
    itemCount: items.length,
    answeredItemCount: accepted.size,
    scoredItemCount: 0,
    totalScore: null,
    maxScore: items.length,
    items,
  };
}
