import type { Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { GlossaryCatalogMatch } from "@harbor/renderer-adapter";
import { renderSafeContentNode } from "./SafeContentNode";

export interface GlossaryDialogProps {
  state: Signal<GlossaryDialogState>;
  dismiss: () => void;
}

/** Renderable glossary dialog state projected from the session catalog request. */
export type GlossaryDialogState =
  | { readonly status: "closed" }
  | {
      readonly status: "open";
      readonly matches: readonly GlossaryCatalogMatch[];
      readonly remoteContent: GlossaryRemoteContent;
    };

/** Remote glossary content lifecycle for an open glossary dialog. */
export type GlossaryRemoteContent =
  | { readonly status: "none" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string }
  | { readonly status: "failed"; readonly message: string };

/** Displays the current glossary catalog delivery in a native modal dialog. */
export function GlossaryDialog(props: GlossaryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const state = props.state.value;
  const open = state.status === "open";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-glossary-close]")?.focus();
    }
  }, [open]);

  if (state.status === "closed") return null;

  const { matches, remoteContent } = state;
  const hasReferencedContent = remoteContent.status === "ready" && remoteContent.text.length > 0;

  return (
    <dialog
      ref={dialogRef}
      class="glossary-dialog"
      aria-labelledby="glossary-dialog-title"
      data-testid="glossary-dialog"
      onCancel={(event) => {
        event.preventDefault();
        dialogRef.current?.close();
      }}
      onClose={props.dismiss}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      <div class="glossary-dialog__surface">
        <header class="glossary-dialog__header">
          <h2 id="glossary-dialog-title">Glossary</h2>
          <button
            type="button"
            class="secondary-action"
            data-glossary-close
            onClick={() => dialogRef.current?.close()}
          >
            Close
          </button>
        </header>
        <div class="glossary-dialog__content" data-testid="glossary-content">
          {matches.flatMap((match) => match.html.map(renderSafeContentNode))}
          {remoteContent.status === "loading" && <p>Loading glossary content…</p>}
          {hasReferencedContent && <p>{remoteContent.text}</p>}
          {remoteContent.status === "failed" && <p role="alert">{remoteContent.message}</p>}
          {matches.length === 0 &&
            (remoteContent.status === "none" ||
              (remoteContent.status === "ready" && !hasReferencedContent)) && (
              <p>No glossary definition is available.</p>
            )}
        </div>
      </div>
    </dialog>
  );
}
