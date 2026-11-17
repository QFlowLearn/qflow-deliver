import { createElement, type ComponentChild } from "preact";
import type { AssessmentInstructionBlock } from "@harbor/content-model";

type SafeContentNode = AssessmentInstructionBlock["content"][number];

/** Render one shared-sanitizer content node without reparsing authored HTML. */
export function renderSafeContentNode(node: SafeContentNode): ComponentChild {
  if (node.kind === "text") return node.text;
  return createElement(node.name, { ...node.attributes }, node.children.map(renderSafeContentNode));
}
