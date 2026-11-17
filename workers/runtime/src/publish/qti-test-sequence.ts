import { readStagedTestReporting } from "../results/staged-assessment-results";
import path from "node:path";
import { testDeliveryOwner } from "./qti-test-delivery-profile";
import {
  inspectQtiBinaryChoice,
  parseQtiTestExecution,
  type QtiAssessmentTestPackageModel,
  type QtiExecutableTest,
} from "@longsightgroup/qti3-core";
import { PublishInputError } from "./publish-errors";
import type { PreparedQtiItem } from "./qti-package-preparation";

/** Validated publication input; the original QTI XML remains the execution authority. */
export interface PreparedTestSequence {
  readonly xml: string;
  readonly itemIdsByRef: Record<string, string>;
  readonly answerCount: number;
}

/** Require a finite, constant-length route and bind every reference to one published item. */
export function prepareTestSequence(
  source: QtiAssessmentTestPackageModel | undefined,
  items: readonly PreparedQtiItem[],
): PreparedTestSequence | undefined {
  if (!source || testDeliveryOwner(source.xml) === "harbor") return undefined;
  const result = parseQtiTestExecution(source.xml);
  if (!result.ok)
    throw new PublishInputError(422, "This package uses unsupported QTI test sequencing.");
  if (result.value.kind === "fixed") return undefined;
  const test = result.value.test;
  const byHref = new Map(items.map((item) => [item.href, item]));
  const itemIdsByRef: Record<string, string> = {};
  const usedIds = new Set<string>();
  for (const section of test.sections) {
    for (const ref of section.items) {
      const item = byHref.get(path.posix.join(path.posix.dirname(source.href), ref.href));
      if (!item || usedIds.has(item.id))
        throw new PublishInputError(
          422,
          "Sequenced test references an unavailable or repeated item.",
        );
      const eligibility = inspectQtiBinaryChoice(new TextDecoder().decode(item.bytes));
      if (!eligibility.ok)
        throw new PublishInputError(
          422,
          `Question ${item.identifier} requires single-choice 0/1 scoring for sequenced delivery.`,
        );
      usedIds.add(item.id);
      itemIdsByRef[ref.identifier] = item.id;
    }
  }
  const answerCount = constantTestLength(test);
  try {
    readStagedTestReporting(test, answerCount);
  } catch {
    throw new PublishInputError(422, "Adaptive reporting metadata does not match this test.");
  }
  return { xml: source.xml, itemIdsByRef, answerCount };
}

function constantTestLength(test: QtiExecutableTest): number {
  const lengths = new Map<string, number>();
  for (let index = test.sections.length - 1; index >= 0; index--) {
    const section = test.sections[index];
    if (!section) throw new Error("Validated test section disappeared.");
    const destinations = section.branches.map((b) => b.target);
    const last = section.branches.at(-1)?.expression;
    if (last?.type !== "baseValue" || last.value !== true) {
      destinations.push(test.sections[index + 1]?.identifier ?? "EXIT_TEST");
    }
    const remaining = destinations.map((target) =>
      target === "EXIT_TEST" ? 0 : lengths.get(target),
    );
    const tail = remaining[0];
    if (tail === undefined || remaining.some((n) => n !== tail))
      throw new PublishInputError(
        422,
        "Sequenced tests must deliver the same number of questions on every route.",
      );
    lengths.set(section.identifier, section.items.length + tail);
  }
  const count = lengths.get(test.sections[0]?.identifier ?? "");
  if (count === undefined || count < 15 || count > 100 || count % 5 !== 0)
    throw new PublishInputError(
      422,
      "Sequenced tests must deliver 15 to 100 questions in groups of five.",
    );
  return count;
}
