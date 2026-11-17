import type { Signal } from "@preact/signals";
import type { AssessmentInstructionBlock } from "@harbor/content-model";
import type { JSX } from "preact";
import type { HarborCatalogSupportEntry } from "@harbor/attempt-protocol";
import type { RendererAnswerMaskChoiceRegion } from "@harbor/renderer-adapter";
import type { GlossaryDialogProps } from "./GlossaryDialog";
import type { KeywordTranslationDialogProps } from "./KeywordTranslationDialog";
import type { SessionRendererShellProps } from "./SessionRendererShell";

export interface SessionCatalogDialogProps {
  glossary: GlossaryDialogProps;
  keywordTranslation: KeywordTranslationDialogProps;
}

export function buildSessionRendererShellProps(input: {
  assessmentInstructions: Signal<readonly AssessmentInstructionBlock[]>;
  bindMediaSupportPanel: (element: HTMLElement | null) => void;
  bindRendererMount: (element: HTMLDivElement | null) => void;
  catalogDialogs: SessionCatalogDialogProps;
  calculatorLeft: Signal<number>;
  calculatorOperator: Signal<"+" | "-" | "*" | "/">;
  calculatorResult: Signal<number | "Undefined">;
  calculatorRight: Signal<number>;
  captionsPanelOpen: Signal<boolean>;
  answerMaskChoiceRegions: Signal<RendererAnswerMaskChoiceRegion[]>;
  currentItemCaptionEntries: Signal<HarborCatalogSupportEntry[]>;
  currentItemMediaAlternativeEntries: Signal<HarborCatalogSupportEntry[]>;
  currentItemMediaAssets: Signal<unknown[]>;
  currentItemTranscriptEntries: Signal<HarborCatalogSupportEntry[]>;
  lineReaderActive: Signal<boolean>;
  lineReaderHeight: Signal<number>;
  lineReaderStyle: Signal<JSX.CSSProperties>;
  lineReaderTop: Signal<number>;
  maskActive: Signal<boolean>;
  maskOverlayStyle: Signal<JSX.CSSProperties>;
  maskRevealHeight: Signal<number>;
  maskRevealStyle: Signal<JSX.CSSProperties>;
  maskRevealTop: Signal<number>;
  mediaAlternativesPanelOpen: Signal<boolean>;
  notepadText: Signal<string>;
  pauseTextToSpeech: () => void;
  resumeTextToSpeech: () => void;
  revealAnswerMaskChoiceRegion: (region: RendererAnswerMaskChoiceRegion) => void;
  selectedAnswerMaskChoiceRegionIndex: Signal<number | null>;
  shellToolsVisible: Signal<boolean>;
  showAnswerMaskingTool: Signal<boolean>;
  showCalculatorTool: Signal<boolean>;
  showCaptionTool: Signal<boolean>;
  showLineReaderTool: Signal<boolean>;
  showMediaAlternativesTool: Signal<boolean>;
  showNotepadTool: Signal<boolean>;
  showTextToSpeechTool: Signal<boolean>;
  showTranscriptTool: Signal<boolean>;
  startTextToSpeech: () => void;
  stopTextToSpeech: (reason?: string) => void;
  toggleCaptionsPanel: () => void;
  toggleMediaAlternativesPanel: () => void;
  toggleTranscriptsPanel: () => void;
  transcriptsPanelOpen: Signal<boolean>;
  ttsCurrentSegmentText: Signal<string>;
  ttsPlaybackState: Signal<"idle" | "playing" | "paused" | "unsupported">;
  ttsPlaybackStatusLabel: Signal<string>;
}): SessionRendererShellProps {
  return {
    assessmentInstructions: input.assessmentInstructions,
    toolsVisible: input.shellToolsVisible,
    textToSpeech: {
      visible: input.showTextToSpeechTool,
      playbackState: input.ttsPlaybackState,
      playbackStatusLabel: input.ttsPlaybackStatusLabel,
      currentSegmentText: input.ttsCurrentSegmentText,
      start: input.startTextToSpeech,
      pause: input.pauseTextToSpeech,
      resume: input.resumeTextToSpeech,
      stop: input.stopTextToSpeech,
    },
    lineReaderButton: {
      visible: input.showLineReaderTool,
      pressed: input.lineReaderActive,
      testId: "line-reader-tool-button",
      label: "Line Reader",
      onClick: () => {
        input.lineReaderActive.value = !input.lineReaderActive.value;
      },
    },
    answerMaskButton: {
      visible: input.showAnswerMaskingTool,
      pressed: input.maskActive,
      testId: "answer-mask-tool-button",
      label: "Mask",
      onClick: () => {
        input.maskActive.value = !input.maskActive.value;
      },
    },
    captionsButton: {
      visible: input.showCaptionTool,
      expanded: input.captionsPanelOpen,
      controls: "media-support-panel",
      testId: "captions-tool-button",
      label: "Captions",
      onClick: input.toggleCaptionsPanel,
    },
    transcriptsButton: {
      visible: input.showTranscriptTool,
      expanded: input.transcriptsPanelOpen,
      controls: "media-support-panel",
      testId: "transcripts-tool-button",
      label: "Transcript",
      onClick: input.toggleTranscriptsPanel,
    },
    mediaAlternativesButton: {
      visible: input.showMediaAlternativesTool,
      expanded: input.mediaAlternativesPanelOpen,
      controls: "media-support-panel",
      testId: "media-alternatives-tool-button",
      label: "Alternatives",
      onClick: input.toggleMediaAlternativesPanel,
    },
    lineReader: {
      active: input.lineReaderActive,
      top: input.lineReaderTop,
      height: input.lineReaderHeight,
    },
    answerMask: {
      active: input.maskActive,
      revealTop: input.maskRevealTop,
      revealHeight: input.maskRevealHeight,
      answerMaskChoiceRegions: input.answerMaskChoiceRegions,
      selectedAnswerMaskChoiceRegionIndex: input.selectedAnswerMaskChoiceRegionIndex,
      revealAnswerMaskChoiceRegion: input.revealAnswerMaskChoiceRegion,
    },
    calculator: {
      visible: input.showCalculatorTool,
      left: input.calculatorLeft,
      operator: input.calculatorOperator,
      right: input.calculatorRight,
      result: input.calculatorResult,
    },
    notepad: {
      visible: input.showNotepadTool,
      text: input.notepadText,
    },
    mediaSupport: {
      bindPanel: input.bindMediaSupportPanel,
      captionsOpen: input.captionsPanelOpen,
      transcriptsOpen: input.transcriptsPanelOpen,
      mediaAlternativesOpen: input.mediaAlternativesPanelOpen,
      mediaAssets: input.currentItemMediaAssets,
      captionEntries: input.currentItemCaptionEntries,
      transcriptEntries: input.currentItemTranscriptEntries,
      mediaAlternativeEntries: input.currentItemMediaAlternativeEntries,
    },
    frame: {
      bindRendererMount: input.bindRendererMount,
      lineReaderActive: input.lineReaderActive,
      lineReaderStyle: input.lineReaderStyle,
      maskActive: input.maskActive,
      maskRevealStyle: input.maskRevealStyle,
      maskOverlayStyle: input.maskOverlayStyle,
    },
    catalogDialogs: input.catalogDialogs,
  };
}
