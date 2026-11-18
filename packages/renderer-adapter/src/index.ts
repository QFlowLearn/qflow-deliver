import type {
  HarborQti3ColorTheme,
  RendererPnpAccommodation,
  RendererSessionControlAccommodation,
} from "@harbor/attempt-protocol";
import { createElement, createRef, render } from "preact";
import {
  QtiAssessmentItemPlayer,
  type QtiAssessmentItemPlayerHandle,
  type QtiAssessmentItemPlayerProps,
} from "@longsightgroup/qti3-player-preact";
import {
  type QtiAttemptStateV1,
  type QtiCatalogSupportResolution,
  type QtiCatalogSupportResolutionOptions,
  type QtiResolvedCatalogReference,
  type QtiResolvedCatalogSupport,
  type QtiTextToSpeechTraversal,
} from "@longsightgroup/qti3-core";
import {
  applyHarborBuiltInsToPlayer,
  stripHarborBuiltInsFromAttemptState,
  stripHarborBuiltInsFromPlayerDetail,
} from "./qti3-builtins-compat";
export {
  mapInteractionRegionsToAnswerMaskChoiceRegions,
  type RendererAnswerMaskChoiceRegion,
} from "./interaction-regions";
export { findHarborRendererInteractionCapabilityGaps } from "./interaction-capabilities";
import { mapInteractionRegionsToAnswerMaskChoiceRegions } from "./interaction-regions";
import type { RendererAnswerMaskChoiceRegion } from "./interaction-regions";
import { createPackageAssetResolvers, type RendererPackageAsset } from "./package-assets";

export {
  resolvePackageAssetReference,
  type PackageAssetReferenceFailure,
  type PackageAssetReferenceResolution,
} from "@harbor/content-model";
export { createPackageAssetResolvers, type RendererPackageAsset } from "./package-assets";
export {
  projectGlossaryCatalogDelivery,
  type GlossaryCatalogDeliveryProjection,
  type GlossaryCatalogMatch,
} from "./glossary-catalog";
export {
  isKeywordTranslationMimeType,
  projectKeywordTranslationCatalogDelivery,
  type KeywordTranslationCatalogFile,
  type KeywordTranslationCatalogMatch,
  type KeywordTranslationCatalogProjection,
} from "./keyword-translation-catalog";
export {
  readFetchedCatalogText,
  resolveHarborCatalogSupportDelivery,
  resolveHarborCatalogSupportEvidenceEntries,
} from "./catalog-delivery-resolution";

export function resolveRendererColorTheme(
  configuration: RendererConfiguration,
): HarborQti3ColorTheme {
  return configuration.pnp.textAppearance?.colorStyle ?? "qti3-player-color-default";
}

export type RendererCatalogSupportResolutionOptions = QtiCatalogSupportResolutionOptions;
export type RendererCatalogSupportResolution = QtiCatalogSupportResolution;
export type RendererCatalogDeliveryResolution = NonNullable<
  ReturnType<QtiAssessmentItemPlayerHandle["getCatalogDeliveryResolution"]>
>;
export type RendererResolvedCatalogReference = QtiResolvedCatalogReference;
export type RendererResolvedCatalogSupport = QtiResolvedCatalogSupport;
export type RendererTextToSpeechTraversal = QtiTextToSpeechTraversal;

type QtiPlayerLoadOptions = NonNullable<QtiAssessmentItemPlayerProps["loadOptions"]>;
type QtiCatalogRequestPolicy = NonNullable<QtiAssessmentItemPlayerProps["catalogRequestPolicy"]>;
export type RendererCatalogRequestEventDetail = Parameters<
  NonNullable<QtiAssessmentItemPlayerProps["onCatalogRequest"]>
>[0] & { readonly returnFocusElement: HTMLElement | null };
type QtiPlayerSessionControl = NonNullable<QtiPlayerLoadOptions["sessionControl"]>;
type QtiScoreAttemptOptions = NonNullable<
  Parameters<QtiAssessmentItemPlayerHandle["scoreAttempt"]>[0]
>;

export interface RendererConfiguration {
  guid: string;
  itemHref: string;
  assets: readonly RendererPackageAsset[];
  catalogRequestPolicy?: QtiCatalogRequestPolicy;
  pnp: RendererPnpAccommodation;
  sessionControl: RendererSessionControlAccommodation;
  keywordEmphasisEnabled?: boolean;
  builtIns?: {
    duration?: number;
    numAttempts?: number;
    completionStatus?: "not_attempted" | "unknown" | "completed" | "incomplete";
  };
  state?: QtiAttemptStateV1;
}

export interface RendererHostHandle {
  loadItemFromXml(xml: string, configuration: RendererConfiguration): void;
  updateBuiltIns(builtIns: NonNullable<RendererConfiguration["builtIns"]>): void;
  endAttempt(target: string): void;
  suspendAttempt(target: string): void;
  snapshotAttempt(target: string): void;
  scoreAttempt(target: string): void;
  getRenderedText(): string;
  getAnswerMaskChoiceRegions(): RendererAnswerMaskChoiceRegion[];
  getCatalogSupportResolution(
    options?: RendererCatalogSupportResolutionOptions,
  ): RendererCatalogSupportResolution | undefined;
  getCatalogDeliveryResolution(
    options?: RendererCatalogSupportResolutionOptions,
  ): RendererCatalogDeliveryResolution | undefined;
  getTextToSpeechTraversal(): RendererTextToSpeechTraversal | undefined;
  subscribeCatalogRequests(
    listener: (detail: RendererCatalogRequestEventDetail) => void,
  ): () => void;
}

export class QtiRendererHost extends HTMLElement implements RendererHostHandle {
  private readonly canvasElement: HTMLDivElement;
  private readonly statusElement: HTMLParagraphElement;
  private readonly playerRef = createRef<QtiAssessmentItemPlayerHandle>();
  private readonly catalogRequestListeners = new Set<
    (detail: RendererCatalogRequestEventDetail) => void
  >();
  private pendingCommand: "score" | "end" | null = null;
  private connected = false;
  private harborSessionControl: RendererSessionControlAccommodation = {};
  private harborBuiltIns: NonNullable<RendererConfiguration["builtIns"]> = {};

  constructor() {
    super();

    this.canvasElement = document.createElement("div");
    this.canvasElement.className = "renderer-canvas";

    this.statusElement = document.createElement("p");
    this.statusElement.className = "renderer-status";
    this.statusElement.hidden = true;
  }

  connectedCallback(): void {
    if (this.connected) {
      return;
    }

    this.connected = true;
    this.classList.add("renderer-host");
    this.dataset.testid = "renderer-host";
    this.appendChild(this.canvasElement as Node);
    this.appendChild(this.statusElement as Node);
    this.bindEvents();
  }

  disconnectedCallback(): void {
    render(null, this.canvasElement);
  }

  set statusMessage(value: string) {
    this.statusElement.textContent = value;
    this.statusElement.hidden = value.trim().length === 0;
  }

  loadItemFromXml(xml: string, configuration: RendererConfiguration): void {
    this.pendingCommand = null;
    this.harborSessionControl = configuration.sessionControl;
    this.harborBuiltIns = configuration.builtIns ?? {};
    applyPresentationConfiguration(this.canvasElement, configuration);
    const assetResolvers = createPackageAssetResolvers({
      itemHref: configuration.itemHref,
      assets: configuration.assets,
    });
    this.renderPlayer(
      xml,
      buildLoadOptions(configuration, assetResolvers),
      configuration.keywordEmphasisEnabled === true,
      configuration.catalogRequestPolicy,
    );
  }

  updateBuiltIns(builtIns: NonNullable<RendererConfiguration["builtIns"]>): void {
    this.harborBuiltIns = builtIns;
  }

  endAttempt(target: string): void {
    this.pendingCommand = "end";
    this.playerHandle.endAttempt(this.buildScoreAttemptOptions(target));
  }

  suspendAttempt(_target: string): void {
    this.playerHandle.suspend();
  }

  /** Capture a resumable checkpoint while the learner continues interacting. */
  snapshotAttempt(_target: string): void {
    const state = this.playerHandle.serialize();
    if (!state) throw new Error("Cannot checkpoint an unloaded QTI item.");
    this.dispatchEvent(
      new CustomEvent("snapshot-attempt-completed", {
        detail: { state: stripHarborBuiltInsFromAttemptState(state) },
      }),
    );
  }

  scoreAttempt(target: string): void {
    this.pendingCommand = "score";
    this.playerHandle.scoreAttempt(this.buildScoreAttemptOptions(target));
  }

  getRenderedText(): string {
    const selection = globalThis.getSelection?.()?.toString().trim();
    if (selection) {
      return normalizeText(selection);
    }

    return normalizeText(this.canvasElement.innerText ?? "");
  }

  getAnswerMaskChoiceRegions(): RendererAnswerMaskChoiceRegion[] {
    const canvasRect = this.canvasElement.getBoundingClientRect();
    if (!this.playerRef.current) return [];
    return mapInteractionRegionsToAnswerMaskChoiceRegions(
      canvasRect,
      this.playerRef.current.getInteractionRegions(),
    );
  }

  getCatalogSupportResolution(
    options: RendererCatalogSupportResolutionOptions = {},
  ): RendererCatalogSupportResolution | undefined {
    return this.playerRef.current?.getCatalogSupportResolution(options);
  }

  getCatalogDeliveryResolution(
    options: RendererCatalogSupportResolutionOptions = {},
  ): RendererCatalogDeliveryResolution | undefined {
    return this.playerRef.current?.getCatalogDeliveryResolution(options);
  }

  getTextToSpeechTraversal(): RendererTextToSpeechTraversal | undefined {
    return this.playerRef.current?.getTextToSpeechTraversal();
  }

  subscribeCatalogRequests(
    listener: (detail: RendererCatalogRequestEventDetail) => void,
  ): () => void {
    this.catalogRequestListeners.add(listener);
    return () => this.catalogRequestListeners.delete(listener);
  }

  private get playerHandle(): QtiAssessmentItemPlayerHandle {
    if (!this.playerRef.current) {
      throw new Error("QTI assessment item player is not mounted.");
    }
    return this.playerRef.current;
  }

  private renderPlayer(
    xml: string,
    loadOptions: QtiPlayerLoadOptions,
    keywordEmphasisEnabled: boolean,
    catalogRequestPolicy: QtiCatalogRequestPolicy | undefined,
  ): void {
    render(
      createElement(QtiAssessmentItemPlayer, {
        ref: this.playerRef,
        xml,
        loadOptions,
        keywordEmphasisEnabled,
        catalogRequestPolicy,
        onCatalogRequest: (detail) => {
          const eventDetail: RendererCatalogRequestEventDetail = {
            ...detail,
            returnFocusElement:
              document.activeElement instanceof HTMLElement ? document.activeElement : null,
          };
          for (const listener of this.catalogRequestListeners) listener(eventDetail);
        },
        onReady: () => {
          normalizeRenderedMediaObjects(this.canvasElement);
          this.dispatchEvent(new CustomEvent("item-ready"));
        },
        onSuspend: (detail) => {
          this.dispatchEvent(
            new CustomEvent("suspend-attempt-completed", {
              detail: stripHarborBuiltInsFromPlayerDetail(detail),
            }),
          );
        },
        onScore: (detail) => {
          if (this.pendingCommand === "end") {
            return;
          }
          this.pendingCommand = null;
          this.dispatchEvent(
            new CustomEvent("score-attempt-completed", {
              detail: stripHarborBuiltInsFromPlayerDetail(detail),
            }),
          );
        },
        onValidation: (detail) => {
          const command = this.pendingCommand;
          this.pendingCommand = null;
          this.dispatchEvent(
            new CustomEvent(
              command === "end" ? "end-attempt-completed" : "score-attempt-completed",
              { detail: stripHarborBuiltInsFromPlayerDetail(detail) },
            ),
          );
        },
        onEndAttempt: (detail) => {
          this.pendingCommand = null;
          this.dispatchEvent(
            new CustomEvent("end-attempt-completed", {
              detail: stripHarborBuiltInsFromPlayerDetail(detail),
            }),
          );
        },
      }),
      this.canvasElement,
    );
  }

  private bindEvents(): void {
    for (const eventName of ["input", "change", "click", "keyup"] as const) {
      this.canvasElement.addEventListener(
        eventName,
        () => this.dispatchEvent(new CustomEvent("renderer-interaction-observed")),
        { capture: true },
      );
    }
  }

  private buildScoreAttemptOptions(target: string): QtiScoreAttemptOptions {
    applyHarborBuiltInsToPlayer(this.playerHandle, this.harborBuiltIns);
    return {
      validateResponses: shouldValidateScoreAttempt(target, this.harborSessionControl),
    };
  }
}

export function defineQtiRendererHost(): void {
  if (!customElements.get("harbor-qti-renderer-host")) {
    customElements.define("harbor-qti-renderer-host", QtiRendererHost);
  }
}

function buildLoadOptions(
  configuration: RendererConfiguration,
  assetResolvers: ReturnType<typeof createPackageAssetResolvers>,
): QtiPlayerLoadOptions {
  const state = configuration.state
    ? stripHarborBuiltInsFromAttemptState(configuration.state)
    : undefined;

  return {
    state,
    status: "interacting",
    sessionControl: readSessionControl(configuration.sessionControl),
    resolveAsset: assetResolvers.resolveAsset,
    resolveStylesheet: assetResolvers.resolveStylesheet,
  };
}

function readSessionControl(value: RendererSessionControlAccommodation): QtiPlayerSessionControl {
  return {
    validateResponses: value.validate_responses !== false,
    showFeedback: value.show_feedback === true,
  };
}

function applyPresentationConfiguration(
  canvasElement: HTMLElement,
  configuration: RendererConfiguration,
): void {
  // Snapshot this live list before removing previous theme classes.
  const previousClasses = Array.from(canvasElement.classList);
  for (const className of previousClasses) {
    if (className.startsWith("qti3-player-color-")) {
      canvasElement.classList.remove(className);
    }
  }

  canvasElement.classList.add(resolveRendererColorTheme(configuration));

  canvasElement.dataset.singleColumn =
    configuration.pnp.layoutSingleColumn === true ? "true" : "false";
}

function shouldValidateScoreAttempt(
  target: string,
  sessionControl: RendererSessionControlAccommodation,
): boolean {
  if (sessionControl.validate_responses === false) {
    return false;
  }

  if (target === "harborSaveDraft") {
    return false;
  }

  if (target === "harborNavigateSelected") {
    return true;
  }

  return sessionControl.allow_skipping === false;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeRenderedMediaObjects(root: {
  querySelectorAll(selectors: "object"): NodeListOf<HTMLObjectElement>;
}): void {
  for (const objectElement of root.querySelectorAll("object")) {
    const mediaKind = renderedObjectMediaKind(objectElement);
    const sourceUrl = objectElement.getAttribute("data");
    if (!mediaKind || !sourceUrl) {
      continue;
    }

    const document = objectElement.ownerDocument;
    const mediaElement = document.createElement(mediaKind);
    const sourceElement = document.createElement("source");
    const fallbackText = normalizeText(objectElement.textContent ?? "");
    sourceElement.src = sourceUrl;
    sourceElement.type = objectElement.getAttribute("type") ?? "";
    mediaElement.appendChild(sourceElement);
    copyRenderedMediaAttributes(objectElement, mediaElement);
    if (mediaControlsMode(objectElement) !== "none") {
      mediaElement.controls = true;
    }
    mediaElement.preload = "metadata";
    mediaElement.classList.add("harbor-rendered-media");
    if (!mediaElement.hasAttribute("aria-label") && !mediaElement.hasAttribute("aria-labelledby")) {
      mediaElement.setAttribute("aria-label", fallbackText || "Media");
    }
    if (fallbackText) {
      mediaElement.appendChild(document.createTextNode(fallbackText));
    }
    objectElement.replaceWith(mediaElement);
  }
}

function renderedObjectMediaKind(element: Element): "audio" | "video" | null {
  const type = element.getAttribute("type")?.trim().toLowerCase() ?? "";
  const data = element.getAttribute("data")?.trim().toLowerCase() ?? "";
  if (type.startsWith("audio/") || /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#].*)?$/.test(data)) {
    return "audio";
  }
  if (type.startsWith("video/") || /\.(m4v|mov|mp4|ogv|webm)(?:[?#].*)?$/.test(data)) {
    return "video";
  }
  return null;
}

function copyRenderedMediaAttributes(source: Element, target: HTMLMediaElement): void {
  for (const { name, value } of source.attributes) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "data" || normalizedName === "type") {
      continue;
    }
    if (normalizedName === "width" || normalizedName === "height") {
      if (target instanceof HTMLVideoElement) {
        target.setAttribute(name, value);
      }
      continue;
    }
    if (
      normalizedName === "id" ||
      normalizedName === "class" ||
      normalizedName === "title" ||
      normalizedName === "lang" ||
      normalizedName === "dir" ||
      normalizedName.startsWith("aria-") ||
      normalizedName.startsWith("data-")
    ) {
      target.setAttribute(name, value);
    }
  }
}

function mediaControlsMode(element: Element): "full" | "none" {
  const value =
    element.getAttribute("data-qti-media-player-controls") ??
    element.getAttribute("data-media-player-controls");
  return value?.trim().toLowerCase() === "none" ? "none" : "full";
}

declare global {
  interface HTMLElementTagNameMap {
    "harbor-qti-renderer-host": QtiRendererHost;
  }
}
