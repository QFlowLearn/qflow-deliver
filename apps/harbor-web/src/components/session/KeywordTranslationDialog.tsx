import type { Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { KeywordTranslationCatalogMatch } from "@harbor/renderer-adapter";
import { renderSafeContentNode } from "./SafeContentNode";

export interface KeywordTranslationMedia {
  readonly href: string;
  readonly mimeType: string;
}

export interface KeywordTranslationDialogProps {
  matches: Signal<readonly KeywordTranslationCatalogMatch[]>;
  requestedLanguage: Signal<string>;
  resolvedLanguage: Signal<string>;
  fallbackMessage: Signal<string>;
  availableLanguages: Signal<readonly string[]>;
  referencedContent: Signal<string>;
  media: Signal<KeywordTranslationMedia | null>;
  loading: Signal<boolean>;
  error: Signal<string>;
  dismiss: () => void;
  selectLanguage: (language: string) => void;
  recordMediaState: (state: "played" | "paused" | "stopped" | "finished") => void;
}

/** Presents one referenced keyword translation with language and fallback context. */
export function KeywordTranslationDialog(props: KeywordTranslationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const matches = props.matches.value;
  const open =
    matches.length > 0 ||
    props.loading.value ||
    props.error.value.length > 0 ||
    props.media.value !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-keyword-translation-close]")?.focus();
    }
  }, [open, matches]);

  if (!open) return null;

  const languageLabel = props.resolvedLanguage.value || "Authored default";
  const resolutionLabel = props.fallbackMessage.value
    ? `fallback for ${formatLanguage(props.requestedLanguage.value)}`
    : "exact requested language";
  const mediaLabel = `Keyword translation in ${formatLanguage(languageLabel)}, ${resolutionLabel}`;

  return (
    <dialog
      ref={dialogRef}
      class="glossary-dialog keyword-translation-dialog"
      aria-labelledby="keyword-translation-dialog-title"
      data-testid="keyword-translation-dialog"
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
          <h2 id="keyword-translation-dialog-title">Keyword translation</h2>
          <button
            type="button"
            class="secondary-action"
            data-keyword-translation-close
            onClick={() => dialogRef.current?.close()}
          >
            Close translation
          </button>
        </header>
        <div class="glossary-dialog__content" data-testid="keyword-translation-content">
          {props.availableLanguages.value.length > 1 && (
            <div class="keyword-translation-dialog__language">
              <label for="keyword-translation-language">Translation language</label>
              <select
                id="keyword-translation-language"
                value={props.requestedLanguage.value}
                onChange={(event) => props.selectLanguage(event.currentTarget.value)}
              >
                {props.availableLanguages.value.map((language) => (
                  <option key={language} value={language}>
                    {formatLanguage(language)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p class="keyword-translation-dialog__resolved" data-testid="resolved-language">
            Showing {formatLanguage(languageLabel)}
          </p>
          {props.fallbackMessage.value && (
            <p class="keyword-translation-dialog__fallback" role="status">
              {props.fallbackMessage.value}
            </p>
          )}
          <div lang={props.resolvedLanguage.value || undefined}>
            {matches.flatMap((match) => match.html.map(renderSafeContentNode))}
            {props.referencedContent.value && <p>{props.referencedContent.value}</p>}
          </div>
          {props.loading.value && <p>Loading translation…</p>}
          {props.media.value?.mimeType.startsWith("audio/") && (
            <audio
              controls
              preload="metadata"
              src={props.media.value.href}
              aria-label={mediaLabel}
              onPlay={() => props.recordMediaState("played")}
              onPause={() => props.recordMediaState("paused")}
              onEnded={() => props.recordMediaState("finished")}
            />
          )}
          {props.media.value?.mimeType.startsWith("video/") && (
            <video
              controls
              preload="metadata"
              width="480"
              height="270"
              src={props.media.value.href}
              aria-label={mediaLabel}
              onPlay={() => props.recordMediaState("played")}
              onPause={() => props.recordMediaState("paused")}
              onEnded={() => props.recordMediaState("finished")}
            />
          )}
          {props.error.value && <p role="alert">{props.error.value}</p>}
        </div>
      </div>
    </dialog>
  );
}

function formatLanguage(language: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(language) ?? language;
  } catch {
    return language;
  }
}
