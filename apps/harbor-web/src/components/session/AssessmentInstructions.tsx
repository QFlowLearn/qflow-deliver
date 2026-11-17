import type { AssessmentInstructionBlock } from "@harbor/content-model";
import { renderSafeContentNode } from "./SafeContentNode";

/** Display the candidate content belonging to the current question's authored scopes. */
export function AssessmentInstructions(props: {
  blocks: readonly AssessmentInstructionBlock[];
  position: "before" | "after";
}) {
  const blocks = props.blocks.filter((block) =>
    "anchor" in block ? block.anchor.position === props.position : props.position === "before",
  );
  if (!blocks.length) return null;
  return (
    <section
      class="assessment-instructions"
      aria-label={
        props.position === "before" ? "Assessment instructions" : "Instructions after this question"
      }
      data-testid={`assessment-instructions-${props.position}`}
    >
      {blocks.map((block, index) => (
        <div key={`${block.scopeType}:${block.scopeIdentifier}:${index}`}>
          <h2>{block.title ? `${block.title}: instructions` : "Instructions"}</h2>
          {block.content.map(renderSafeContentNode)}
        </div>
      ))}
    </section>
  );
}
