import type { Signal } from "@preact/signals";
import type { AssessmentInstructionBlock } from "@harbor/content-model";
import type { JSX } from "preact";
import type { HarborCatalogSupportEntry } from "@harbor/attempt-protocol";
import type { RendererAnswerMaskChoiceRegion } from "@harbor/renderer-adapter";
import { SessionCatalogSupportEntries } from "./SessionCatalogSupportEntries";
import { GlossaryDialog } from "./GlossaryDialog";
import { KeywordTranslationDialog } from "./KeywordTranslationDialog";
import type { SessionCatalogDialogProps } from "./session-renderer-shell-props";
import { AssessmentInstructions } from "./AssessmentInstructions";

type PlaybackState = "idle" | "playing" | "paused" | "unsupported";
type CalculatorOperator = "+" | "-" | "*" | "/";

export interface TextToSpeechControlsProps {
  visible: Signal<boolean>;
  playbackState: Signal<PlaybackState>;
  playbackStatusLabel: Signal<string>;
  currentSegmentText: Signal<string>;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: (reason?: string) => void;
}

export interface ShellToolButtonProps {
  visible: Signal<boolean>;
  pressed?: Signal<boolean>;
  expanded?: Signal<boolean>;
  controls?: string;
  testId: string;
  label: string;
  onClick: () => void;
}

export interface LineReaderControlsProps {
  active: Signal<boolean>;
  top: Signal<number>;
  height: Signal<number>;
}

export interface AnswerMaskControlsProps {
  active: Signal<boolean>;
  revealTop: Signal<number>;
  revealHeight: Signal<number>;
  answerMaskChoiceRegions: Signal<RendererAnswerMaskChoiceRegion[]>;
  selectedAnswerMaskChoiceRegionIndex: Signal<number | null>;
  revealAnswerMaskChoiceRegion: (region: RendererAnswerMaskChoiceRegion) => void;
}

export interface CalculatorPanelProps {
  visible: Signal<boolean>;
  left: Signal<number>;
  operator: Signal<CalculatorOperator>;
  right: Signal<number>;
  result: Signal<number | "Undefined">;
}

export interface NotepadPanelProps {
  visible: Signal<boolean>;
  text: Signal<string>;
}

export interface MediaSupportPanelProps {
  bindPanel: (element: HTMLElement | null) => void;
  captionsOpen: Signal<boolean>;
  transcriptsOpen: Signal<boolean>;
  mediaAlternativesOpen: Signal<boolean>;
  mediaAssets: Signal<unknown[]>;
  captionEntries: Signal<HarborCatalogSupportEntry[]>;
  transcriptEntries: Signal<HarborCatalogSupportEntry[]>;
  mediaAlternativeEntries: Signal<HarborCatalogSupportEntry[]>;
}

export interface RendererFrameProps {
  bindRendererMount: (element: HTMLDivElement | null) => void;
  lineReaderActive: Signal<boolean>;
  lineReaderStyle: Signal<JSX.CSSProperties>;
  maskActive: Signal<boolean>;
  maskRevealStyle: Signal<JSX.CSSProperties>;
  maskOverlayStyle: Signal<JSX.CSSProperties>;
}

export interface SessionRendererShellProps {
  assessmentInstructions: Signal<readonly AssessmentInstructionBlock[]>;
  toolsVisible: Signal<boolean>;
  textToSpeech: TextToSpeechControlsProps;
  lineReaderButton: ShellToolButtonProps;
  answerMaskButton: ShellToolButtonProps;
  captionsButton: ShellToolButtonProps;
  transcriptsButton: ShellToolButtonProps;
  mediaAlternativesButton: ShellToolButtonProps;
  lineReader: LineReaderControlsProps;
  answerMask: AnswerMaskControlsProps;
  calculator: CalculatorPanelProps;
  notepad: NotepadPanelProps;
  mediaSupport: MediaSupportPanelProps;
  frame: RendererFrameProps;
  catalogDialogs: SessionCatalogDialogProps;
}

export function SessionRendererShell(props: SessionRendererShellProps) {
  return (
    <section class="renderer-shell">
      {props.toolsVisible.value && (
        <section
          class="accommodation-tools"
          aria-label="Accommodation tools"
          data-testid="accommodation-tools"
        >
          <div class="tool-row">
            <TextToSpeechControls {...props.textToSpeech} />
            <ShellToolButton {...props.lineReaderButton} />
            <ShellToolButton {...props.answerMaskButton} />
            <ShellToolButton {...props.captionsButton} />
            <ShellToolButton {...props.transcriptsButton} />
            <ShellToolButton {...props.mediaAlternativesButton} />
          </div>

          <LineReaderControls {...props.lineReader} />
          <AnswerMaskControls {...props.answerMask} />
          <CalculatorPanel {...props.calculator} />
          <NotepadPanel {...props.notepad} />
          <MediaSupportPanel {...props.mediaSupport} />
        </section>
      )}

      <AssessmentInstructions blocks={props.assessmentInstructions.value} position="before" />
      <RendererFrame {...props.frame} />
      <AssessmentInstructions blocks={props.assessmentInstructions.value} position="after" />
      <GlossaryDialog {...props.catalogDialogs.glossary} />
      <KeywordTranslationDialog {...props.catalogDialogs.keywordTranslation} />
    </section>
  );
}

function TextToSpeechControls(props: TextToSpeechControlsProps) {
  if (!props.visible.value) {
    return null;
  }

  return (
    <div
      class="tts-control-group"
      role="group"
      aria-label="Text-to-speech controls"
      data-testid="tts-control-group"
    >
      {(props.playbackState.value === "idle" || props.playbackState.value === "unsupported") && (
        <button
          class="secondary-action"
          type="button"
          data-testid="tts-start-button"
          onClick={props.start}
        >
          Speak
        </button>
      )}
      {props.playbackState.value === "playing" && (
        <button
          class="secondary-action"
          type="button"
          data-testid="tts-pause-button"
          onClick={props.pause}
        >
          Pause
        </button>
      )}
      {props.playbackState.value === "paused" && (
        <button
          class="secondary-action"
          type="button"
          data-testid="tts-resume-button"
          onClick={props.resume}
        >
          Resume
        </button>
      )}
      {(props.playbackState.value === "playing" || props.playbackState.value === "paused") && (
        <button
          class="secondary-action"
          type="button"
          data-testid="tts-stop-button"
          onClick={() => props.stop("candidate-stopped")}
        >
          Stop
        </button>
      )}
      {props.playbackStatusLabel.value && (
        <span
          class="tts-status"
          aria-live="polite"
          data-testid="tts-status"
          title={props.currentSegmentText.value}
        >
          {props.playbackStatusLabel.value}
        </span>
      )}
    </div>
  );
}

function ShellToolButton(props: ShellToolButtonProps) {
  if (!props.visible.value) {
    return null;
  }

  return (
    <button
      class="secondary-action"
      type="button"
      aria-pressed={props.pressed?.value}
      aria-expanded={props.expanded?.value}
      aria-controls={props.controls}
      data-testid={props.testId}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function LineReaderControls(props: LineReaderControlsProps) {
  if (!props.active.value) {
    return null;
  }

  return (
    <div class="tool-adjustments" data-testid="line-reader-adjustments">
      <label>
        <span>Reader position</span>
        <input
          value={props.top.value}
          type="range"
          min={5}
          max={90}
          onInput={(event) => {
            props.top.value = Number(event.currentTarget.value);
          }}
        />
      </label>
      <label>
        <span>Reader height</span>
        <input
          value={props.height.value}
          type="range"
          min={2}
          max={8}
          step={0.5}
          onInput={(event) => {
            props.height.value = Number(event.currentTarget.value);
          }}
        />
      </label>
    </div>
  );
}

function AnswerMaskControls(props: AnswerMaskControlsProps) {
  if (!props.active.value) {
    return null;
  }

  return (
    <div class="tool-adjustments" data-testid="answer-mask-adjustments">
      <label>
        <span>Reveal position</span>
        <input
          value={props.revealTop.value}
          type="range"
          min={0}
          max={90}
          onInput={(event) => {
            props.revealTop.value = Number(event.currentTarget.value);
          }}
        />
      </label>
      <label>
        <span>Reveal height</span>
        <input
          value={props.revealHeight.value}
          type="range"
          min={10}
          max={45}
          onInput={(event) => {
            props.revealHeight.value = Number(event.currentTarget.value);
          }}
        />
      </label>
      {props.answerMaskChoiceRegions.value.length > 0 && (
        <div class="choice-mask-controls">
          {props.answerMaskChoiceRegions.value.map((region) => (
            <button
              key={region.index}
              class="secondary-action"
              type="button"
              aria-pressed={props.selectedAnswerMaskChoiceRegionIndex.value === region.index}
              onClick={() => props.revealAnswerMaskChoiceRegion(region)}
            >
              Choice {region.index + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CalculatorPanel(props: CalculatorPanelProps) {
  if (!props.visible.value) {
    return null;
  }

  return (
    <details class="tool-panel">
      <summary>Calculator</summary>
      <div class="calculator-grid">
        <input
          value={props.left.value}
          type="number"
          inputMode="decimal"
          aria-label="Left value"
          onInput={(event) => {
            props.left.value = Number(event.currentTarget.value);
          }}
        />
        <select
          value={props.operator.value}
          aria-label="Operation"
          onChange={(event) => {
            props.operator.value = event.currentTarget.value as CalculatorOperator;
          }}
        >
          <option value="+">+</option>
          <option value="-">-</option>
          <option value="*">*</option>
          <option value="/">/</option>
        </select>
        <input
          value={props.right.value}
          type="number"
          inputMode="decimal"
          aria-label="Right value"
          onInput={(event) => {
            props.right.value = Number(event.currentTarget.value);
          }}
        />
        <output aria-live="polite">{props.result.value}</output>
      </div>
    </details>
  );
}

function NotepadPanel(props: NotepadPanelProps) {
  if (!props.visible.value) {
    return null;
  }

  return (
    <details class="tool-panel">
      <summary>Notes</summary>
      <textarea
        value={props.text.value}
        rows={4}
        spellcheck={true}
        aria-label="Student notes"
        onInput={(event) => {
          props.text.value = event.currentTarget.value;
        }}
      />
    </details>
  );
}

function MediaSupportPanel(props: MediaSupportPanelProps) {
  if (
    !props.captionsOpen.value &&
    !props.transcriptsOpen.value &&
    !props.mediaAlternativesOpen.value
  ) {
    return null;
  }

  return (
    <section
      id="media-support-panel"
      class="media-support-panel"
      role="region"
      aria-label="Media support content"
      tabIndex={-1}
      ref={props.bindPanel}
      data-testid="media-support-panel"
    >
      {props.mediaAssets.value.length === 0 ? (
        <p>Embedded media item</p>
      ) : props.mediaAlternativesOpen.value ? (
        <p>Resolved media alternatives</p>
      ) : null}
      {props.captionsOpen.value && (
        <SessionCatalogSupportEntries entries={props.captionEntries.value} />
      )}
      {props.transcriptsOpen.value && (
        <SessionCatalogSupportEntries entries={props.transcriptEntries.value} />
      )}
      {props.mediaAlternativesOpen.value && (
        <SessionCatalogSupportEntries entries={props.mediaAlternativeEntries.value} />
      )}
      {props.captionsOpen.value && props.captionEntries.value.length === 0 && (
        <p>No catalog caption support was resolved for this item.</p>
      )}
      {props.transcriptsOpen.value && props.transcriptEntries.value.length === 0 && (
        <p>No catalog transcript support was resolved for this item.</p>
      )}
      {props.mediaAlternativesOpen.value && props.mediaAlternativeEntries.value.length === 0 && (
        <p>No catalog media alternatives were resolved for this item.</p>
      )}
    </section>
  );
}

function RendererFrame(props: RendererFrameProps) {
  return (
    <div class={`renderer-tool-frame${props.maskActive.value ? " masked" : ""}`}>
      <div class="renderer-host-mount" ref={props.bindRendererMount} />
      {props.lineReaderActive.value && (
        <div
          class="line-reader"
          style={props.lineReaderStyle.value}
          aria-hidden="true"
          data-testid="line-reader-overlay"
        />
      )}
      {props.maskActive.value && (
        <>
          <div class="mask-reveal-window" style={props.maskRevealStyle.value} aria-hidden="true" />
          <div
            class="mask-overlay"
            style={props.maskOverlayStyle.value}
            role="region"
            aria-label="Answer masking"
            data-testid="answer-mask-overlay"
          >
            <button
              class="primary-action"
              type="button"
              onClick={() => {
                props.maskActive.value = false;
              }}
            >
              Reveal
            </button>
          </div>
        </>
      )}
    </div>
  );
}
