import { describe, expect, it } from "vitest";
import { mapInteractionRegionsToAnswerMaskChoiceRegions } from "../../../packages/renderer-adapter/src/interaction-regions";

describe("renderer adapter interaction regions", () => {
  it("fully supports every interaction with Harbor runtime evidence", async () => {
    const { findHarborRendererInteractionCapabilityGaps } = await loadRendererAdapter();
    expect(findHarborRendererInteractionCapabilityGaps()).toEqual([]);
  });

  it("maps stable qti3-player interaction regions to Harbor choice regions", () => {
    const canvasRect = rect({ top: 100, height: 200 });
    const element = { textContent: " Alpha " } as Element;

    expect(
      mapInteractionRegionsToAnswerMaskChoiceRegions(canvasRect, [
        {
          kind: "interaction",
          interactionType: "choice",
          label: "whole item",
          bounds: rect({ top: 100, height: 200 }),
          element,
        },
        {
          kind: "choice",
          interactionType: "choice",
          bounds: rect({ top: 120, height: 20 }),
          element,
        },
        {
          kind: "control",
          interactionType: "inlineChoice",
          label: "Inline choice",
          bounds: rect({ top: 260, height: 8 }),
          element,
        },
        {
          kind: "choice",
          interactionType: "choice",
          label: "Hidden",
          bounds: rect({ top: 270, height: 0 }),
          element,
        },
        {
          kind: "target",
          interactionType: "match",
          label: "Match target",
          bounds: rect({ top: 280, height: 20 }),
          element,
        },
      ]),
    ).toEqual([
      { index: 0, label: "Alpha", topPercent: 10, heightPercent: 10 },
      { index: 1, label: "Inline choice", topPercent: 80, heightPercent: 6 },
    ]);
  });
});

describe("renderer adapter media normalization", () => {
  it("replaces rendered audio object elements with playable media elements", async () => {
    const { normalizeRenderedMediaObjects } = await loadRendererAdapter();
    const objectElement = new FakeObjectElement({
      data: "/api/content/assets/audio-1",
      type: "audio/mpeg",
      title: "Listening passage",
      "data-qti-media-player-controls": "full",
    });
    objectElement.textContent = "Listen to the passage.";

    normalizeRenderedMediaObjects({
      querySelectorAll: () => [objectElement] as unknown as NodeListOf<HTMLObjectElement>,
    });

    const replacement = objectElement.replacement;
    expect(replacement?.tagName).toBe("audio");
    expect(replacement?.controls).toBe(true);
    expect(replacement?.preload).toBe("metadata");
    expect(replacement?.classNames).toContain("harbor-rendered-media");
    expect(replacement?.attributes.get("title")).toBe("Listening passage");
    expect(replacement?.attributes.get("aria-label")).toBe("Listen to the passage.");
    expect(replacement?.children[0]).toMatchObject({
      tagName: "source",
      src: "/api/content/assets/audio-1",
      type: "audio/mpeg",
    });
  });

  it("respects media object controls suppression", async () => {
    const { normalizeRenderedMediaObjects } = await loadRendererAdapter();
    const objectElement = new FakeObjectElement({
      data: "/api/content/assets/audio-2.mp3",
      type: "audio/mpeg",
      "data-media-player-controls": "none",
    });

    normalizeRenderedMediaObjects({
      querySelectorAll: () => [objectElement] as unknown as NodeListOf<HTMLObjectElement>,
    });

    expect(objectElement.replacement?.controls).toBe(false);
  });
});

async function loadRendererAdapter(): Promise<
  typeof import("../../../packages/renderer-adapter/src/index")
> {
  if (!("HTMLElement" in globalThis)) {
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: class HTMLElement {},
    });
  }
  return import("../../../packages/renderer-adapter/src/index");
}

function rect(input: { top: number; height: number; width?: number }): DOMRectReadOnly {
  return {
    top: input.top,
    bottom: input.top + input.height,
    left: 0,
    right: input.width ?? 100,
    x: 0,
    y: input.top,
    width: input.width ?? 100,
    height: input.height,
    toJSON: () => ({}),
  };
}

class FakeObjectElement {
  readonly ownerDocument = new FakeDocument();
  textContent = "";
  replacement: FakeMediaElement | null = null;
  readonly attributes: Array<{ name: string; value: string }>;

  constructor(private readonly attributeValues: Record<string, string>) {
    this.attributes = Object.entries(attributeValues).map(([name, value]) => ({ name, value }));
  }

  getAttribute(name: string): string | null {
    return this.attributeValues[name] ?? null;
  }

  replaceWith(element: FakeMediaElement): void {
    this.replacement = element;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeMediaElement | FakeSourceElement {
    return tagName === "source" ? new FakeSourceElement() : new FakeMediaElement(tagName);
  }

  createTextNode(value: string): string {
    return value;
  }
}

class FakeMediaElement {
  controls = false;
  preload = "";
  readonly attributes = new Map<string, string>();
  readonly children: Array<FakeSourceElement | string> = [];
  readonly classNames: string[] = [];
  readonly classList = {
    add: (className: string) => {
      this.classNames.push(className);
    },
  };

  constructor(readonly tagName: string) {}

  appendChild(child: FakeSourceElement | string): void {
    this.children.push(child);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

class FakeSourceElement extends FakeMediaElement {
  src = "";
  type = "";

  constructor() {
    super("source");
  }
}
