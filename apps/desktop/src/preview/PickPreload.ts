// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import { ipcRenderer } from "electron";
import { getElementContext } from "react-grab/primitives";
import type {
  DesktopPreviewAnnotationTheme,
  PickedElementPayload,
  PickedElementStackFrame,
  PreviewAnnotationPayload,
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
  PreviewAnnotationRegionTarget,
  PreviewAnnotationStrokeTarget,
  PreviewAnnotationStyleChange,
} from "@t3tools/contracts";

import { previewAnnotationStyles } from "./AnnotationStyles.generated.ts";
import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_SELECTION_CLAIMED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";
const OVERLAY_ATTRIBUTE = "data-t3code-annotation-ui";
const Z_INDEX_OVERLAY = 2147483646;
const PRIMARY = "var(--t3-primary)";
const PRIMARY_FILL = "color-mix(in srgb, var(--t3-primary) 10%, transparent)";
const MAX_MARQUEE_ELEMENTS = 20;
const CONTENT_LAYER_Z_INDEX = 1;
const CHROME_LAYER_Z_INDEX = 10;
const FRAME_BRIDGE_SOURCE = "t3code-preview-annotation";
const isMainFrame = process.isMainFrame;

type AnnotationTool = "select" | "marquee" | "draw" | "erase";

interface AnnotationComputedStyles {
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly lineHeight: string;
  readonly color: string;
  readonly backgroundColor: string;
  readonly opacity: string;
  readonly borderRadius: string;
  readonly borderColor: string;
  readonly borderWidth: string;
  readonly padding: string;
  readonly margin: string;
  readonly gap: string;
}

interface FrameElementTarget {
  readonly id: string;
  readonly element: PickedElementPayload;
  readonly rect: PreviewAnnotationRect;
  readonly computedStyles: AnnotationComputedStyles;
}

interface FrameAnnotationState {
  readonly pageUrl: string;
  readonly pageTitle: string | null;
  readonly elements: ReadonlyArray<FrameElementTarget>;
  readonly regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  readonly strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  readonly styleChanges: ReadonlyArray<PreviewAnnotationStyleChange>;
}

interface FrameStateMessage {
  readonly source: typeof FRAME_BRIDGE_SOURCE;
  readonly kind: "state";
  readonly sessionId: string;
  readonly frameId: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly state: FrameAnnotationState;
}

type FrameCommand =
  | { readonly kind: "tool"; readonly tool: AnnotationTool }
  | {
      readonly kind: "marquee-select";
      readonly operationId: string;
      readonly rect: PreviewAnnotationRect;
      readonly additive: boolean;
    }
  | { readonly kind: "style"; readonly property: string; readonly value: string };
type FrameMarqueeSelectionCommand = Extract<FrameCommand, { readonly kind: "marquee-select" }>;

interface FrameCommandMessage {
  readonly source: typeof FRAME_BRIDGE_SOURCE;
  readonly kind: "command";
  readonly sessionId: string;
  readonly command: FrameCommand;
}

interface FrameToolRequestMessage {
  readonly source: typeof FRAME_BRIDGE_SOURCE;
  readonly kind: "tool-request";
  readonly sessionId: string;
  readonly tool: AnnotationTool;
}

interface FrameDrawGestureMessage {
  readonly source: typeof FRAME_BRIDGE_SOURCE;
  readonly kind: "draw-gesture";
  readonly sessionId: string;
  readonly phase: "start" | "move" | "end" | "cancel";
  readonly pointerId: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly point: PreviewAnnotationPoint;
}

interface FrameMarqueeGestureMessage {
  readonly source: typeof FRAME_BRIDGE_SOURCE;
  readonly kind: "marquee-gesture";
  readonly sessionId: string;
  readonly phase: "start" | "move" | "end" | "cancel";
  readonly pointerId: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly point: PreviewAnnotationPoint;
  readonly additive: boolean;
}

interface FrameMarqueeSelectionMessage {
  readonly source: typeof FRAME_BRIDGE_SOURCE;
  readonly kind: "marquee-selection";
  readonly sessionId: string;
  readonly operationId: string;
}

type FrameBridgeMessage =
  | FrameStateMessage
  | FrameCommandMessage
  | FrameToolRequestMessage
  | FrameDrawGestureMessage
  | FrameMarqueeGestureMessage
  | FrameMarqueeSelectionMessage;

interface SelectedElement {
  id: string;
  element: Element;
  outline: HTMLDivElement;
  label: HTMLDivElement;
  baselineStyles: Map<string, string>;
  capture: Promise<PickedElementPayload | null>;
}

type AnnotationOrigin =
  | {
      readonly kind: "element";
      readonly anchor: Element;
      readonly anchorRect: PreviewAnnotationRect;
      readonly scrollX: number;
      readonly scrollY: number;
    }
  | {
      readonly kind: "viewport";
      readonly scrollX: number;
      readonly scrollY: number;
    };

interface AnnotationSession {
  teardown: (notifyMain: boolean) => void;
  applyTheme: (theme: DesktopPreviewAnnotationTheme) => void;
}

let activeSession: AnnotationSession | null = null;
let idSequence = 0;
let annotationTheme: DesktopPreviewAnnotationTheme | null = null;

const applyAnnotationTheme = (
  host: HTMLElement,
  theme: DesktopPreviewAnnotationTheme | null,
): void => {
  if (!theme) return;
  host.style.colorScheme = theme.colorScheme;
  const variables = {
    "--t3-radius": theme.radius,
    "--t3-background": theme.background,
    "--t3-foreground": theme.foreground,
    "--t3-popover": theme.popover,
    "--t3-popover-foreground": theme.popoverForeground,
    "--t3-primary": theme.primary,
    "--t3-primary-foreground": theme.primaryForeground,
    "--t3-muted": theme.muted,
    "--t3-muted-foreground": theme.mutedForeground,
    "--t3-accent": theme.accent,
    "--t3-accent-foreground": theme.accentForeground,
    "--t3-border": theme.border,
    "--t3-input": theme.input,
    "--t3-ring": theme.ring,
    "--t3-font-sans": theme.fontSans,
    "--t3-font-mono": theme.fontMono,
  };
  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value);
  }
};

const reportHumanPointerInput = (event: PointerEvent): void => {
  if (!event.isTrusted) return;
  ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
    kind: "pointer",
    x: event.clientX,
    y: event.clientY,
    button: event.button,
  });
};

const reportHumanKeyInput = (event: KeyboardEvent): void => {
  if (!event.isTrusted) return;
  ipcRenderer.send(HUMAN_INPUT_CHANNEL, {
    kind: "key",
    key: event.key,
    code: event.code,
  });
};

window.addEventListener("pointerdown", reportHumanPointerInput, true);
window.addEventListener("keydown", reportHumanKeyInput, true);

const nextId = (prefix: string): string => {
  idSequence += 1;
  return `${prefix}_${idSequence.toString(36)}`;
};

const rectFromDomRect = (rect: DOMRect): PreviewAnnotationRect => ({
  x: rect.left,
  y: rect.top,
  width: rect.width,
  height: rect.height,
});

const normalizeRect = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PreviewAnnotationRect => ({
  x: Math.min(startX, endX),
  y: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

const intersectRects = (
  rect: PreviewAnnotationRect,
  clip: PreviewAnnotationRect,
): PreviewAnnotationRect => {
  const x = Math.max(rect.x, clip.x);
  const y = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width);
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
};

const clipToViewport = (rect: PreviewAnnotationRect): PreviewAnnotationRect =>
  intersectRects(rect, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });

const snapshotComputedStyles = (element: Element): AnnotationComputedStyles => {
  const computed = getComputedStyle(element);
  return {
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize,
    fontWeight: computed.fontWeight,
    lineHeight: computed.lineHeight,
    color: computed.color,
    backgroundColor: computed.backgroundColor,
    opacity: computed.opacity,
    borderRadius: computed.borderRadius,
    borderColor: computed.borderColor,
    borderWidth: computed.borderWidth,
    padding: computed.padding,
    margin: computed.margin,
    gap: computed.gap,
  };
};

const frameOwnerElements = (): ReadonlyArray<HTMLIFrameElement | HTMLFrameElement> =>
  Array.from(document.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>("iframe,frame"));

const projectFrameState = (
  message: FrameStateMessage,
  owner: HTMLIFrameElement | HTMLFrameElement,
): FrameStateMessage => {
  const ownerRect = owner.getBoundingClientRect();
  const borderScaleX = owner.offsetWidth > 0 ? ownerRect.width / owner.offsetWidth : 1;
  const borderScaleY = owner.offsetHeight > 0 ? ownerRect.height / owner.offsetHeight : 1;
  const contentRect = {
    x: ownerRect.left + owner.clientLeft * borderScaleX,
    y: ownerRect.top + owner.clientTop * borderScaleY,
    width: owner.clientWidth * borderScaleX,
    height: owner.clientHeight * borderScaleY,
  };
  const scaleX = message.viewport.width > 0 ? contentRect.width / message.viewport.width : 1;
  const scaleY = message.viewport.height > 0 ? contentRect.height / message.viewport.height : 1;
  const visibleFrame = clipToViewport(contentRect);
  const mapPoint = (point: PreviewAnnotationPoint): PreviewAnnotationPoint => ({
    x: contentRect.x + point.x * scaleX,
    y: contentRect.y + point.y * scaleY,
  });
  const mapRect = (rect: PreviewAnnotationRect): PreviewAnnotationRect =>
    intersectRects(
      {
        x: contentRect.x + rect.x * scaleX,
        y: contentRect.y + rect.y * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      },
      visibleFrame,
    );
  return {
    ...message,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    state: {
      ...message.state,
      elements: message.state.elements.map((target) => ({ ...target, rect: mapRect(target.rect) })),
      regions: message.state.regions.map((region) => ({ ...region, rect: mapRect(region.rect) })),
      strokes: message.state.strokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map(mapPoint),
        bounds: mapRect(stroke.bounds),
        width: stroke.width * Math.min(scaleX, scaleY),
      })),
    },
  };
};

const isUsableRect = (rect: PreviewAnnotationRect): boolean => rect.width >= 3 && rect.height >= 3;

function unionRects(
  rects: ReadonlyArray<PreviewAnnotationRect>,
  padding = 20,
): PreviewAnnotationRect | null {
  const visibleRects = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (visibleRects.length === 0) return null;
  const left = Math.min(...visibleRects.map((rect) => rect.x));
  const top = Math.min(...visibleRects.map((rect) => rect.y));
  const right = Math.max(...visibleRects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...visibleRects.map((rect) => rect.y + rect.height));
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  const maxWidth = Math.max(1, window.innerWidth - x);
  const maxHeight = Math.max(1, window.innerHeight - y);
  return {
    x,
    y,
    width: Math.min(maxWidth, right - left + padding * 2),
    height: Math.min(maxHeight, bottom - top + padding * 2),
  };
}

function isAnnotationNode(element: Element): boolean {
  return element instanceof Element && element.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null;
}

function pickFromPoint(clientX: number, clientY: number): Element | null {
  for (const candidate of document.elementsFromPoint(clientX, clientY)) {
    if (!(candidate instanceof Element)) continue;
    if (isAnnotationNode(candidate)) continue;
    if (candidate === document.documentElement || candidate === document.body) continue;
    if (candidate instanceof HTMLIFrameElement || candidate instanceof HTMLFrameElement)
      return null;
    return candidate;
  }
  return null;
}

function describeRawElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const classes =
    element instanceof HTMLElement && typeof element.className === "string"
      ? element.className
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((name) => `.${name}`)
          .join("")
      : "";
  return `${tag}${id}${classes}`;
}

function createBox(color: string, fill: string): HTMLDivElement {
  const node = document.createElement("div");
  node.setAttribute(OVERLAY_ATTRIBUTE, "");
  node.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    `border:2px solid ${color}`,
    `background:${fill}`,
    "border-radius:3px",
    "box-sizing:border-box",
    "display:none",
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(";");
  return node;
}

function positionBox(node: HTMLElement, rect: PreviewAnnotationRect): void {
  if (rect.width <= 0 || rect.height <= 0) {
    node.style.display = "none";
    return;
  }
  node.style.display = "block";
  node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

function createLabel(): HTMLDivElement {
  const label = document.createElement("div");
  label.setAttribute(OVERLAY_ATTRIBUTE, "");
  label.className =
    "fixed z-1 max-w-70 overflow-hidden rounded-md bg-primary px-2 py-1 font-sans text-xs font-semibold text-primary-foreground shadow-md";
  label.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "white-space:nowrap",
    "text-overflow:ellipsis",
    `z-index:${CONTENT_LAYER_Z_INDEX}`,
  ].join(";");
  return label;
}

function updateSelectedVisual(target: SelectedElement, measuredRect?: PreviewAnnotationRect): void {
  if (!target.element.isConnected) {
    target.outline.style.display = "none";
    target.label.style.display = "none";
    return;
  }
  const rect =
    measuredRect ?? clipToViewport(rectFromDomRect(target.element.getBoundingClientRect()));
  positionBox(target.outline, rect);
  if (rect.width <= 0 || rect.height <= 0) {
    target.label.style.display = "none";
    return;
  }
  target.label.textContent = describeRawElement(target.element);
  target.label.style.display = "block";
  target.label.style.transform = `translate(${Math.max(4, rect.x)}px, ${Math.max(4, rect.y - 22)}px)`;
}

function toStackFrame(frame: {
  functionName?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}): PickedElementStackFrame {
  return {
    functionName: frame.functionName ?? null,
    fileName: frame.fileName ?? null,
    lineNumber: frame.lineNumber ?? null,
    columnNumber: frame.columnNumber ?? null,
  };
}

async function captureElement(element: Element): Promise<PickedElementPayload | null> {
  try {
    const context = await getElementContext(element);
    const stack = (context.stack ?? []).map(toStackFrame);
    return {
      pageUrl: location.href,
      pageTitle: document.title?.trim() || null,
      tagName: element.tagName.toLowerCase(),
      selector: context.selector,
      htmlPreview: context.htmlPreview ?? "",
      componentName: context.componentName,
      source: stack[0] ?? null,
      stack,
      styles: context.styles ?? "",
      pickedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function createButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.className =
    "inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-transparent px-2 font-sans text-xs font-medium text-foreground outline-none hover:bg-accent disabled:pointer-events-none disabled:opacity-60";
  return button;
}

function styleControl(input: HTMLInputElement | HTMLSelectElement): void {
  input.setAttribute("aria-label", input.getAttribute("aria-label") ?? "Style value");
  input.className =
    "h-7 min-w-0 w-full appearance-none rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground shadow-xs outline-none";
}

function createUnitControl(input: HTMLInputElement): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:relative;min-width:0";
  const unit = document.createElement("span");
  unit.textContent = input.dataset.unit ?? "";
  unit.className =
    "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-mono text-xs text-muted-foreground";
  wrapper.append(input, unit);
  return wrapper;
}

function createField(
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className =
    "grid min-h-7 grid-cols-[82px_minmax(0,1fr)] items-center gap-2 font-sans text-xs font-medium text-muted-foreground";
  const text = document.createElement("span");
  text.textContent = labelText;
  styleControl(input);
  label.append(
    text,
    input instanceof HTMLInputElement && input.dataset.unit ? createUnitControl(input) : input,
  );
  return label;
}

function createStyleSection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "grid gap-1 border-t border-border py-2";
  return section;
}

function createUnitInput(unit: string, placeholder = "0"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.placeholder = placeholder;
  input.style.paddingRight = "30px";
  input.dataset.unit = unit;
  return input;
}

function pathFromPoints(points: ReadonlyArray<PreviewAnnotationPoint>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y} l 0.01 0.01`;
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  path += ` L ${last.x} ${last.y}`;
  return path;
}

function strokeBounds(
  points: ReadonlyArray<PreviewAnnotationPoint>,
  width: number,
): PreviewAnnotationRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = width + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  const right = Math.max(...xs) + padding;
  const bottom = Math.max(...ys) + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function startAnnotation(sessionId: string, frameId: string): void {
  activeSession?.teardown(false);
  let finished = false;
  const host = document.createElement("div");
  host.setAttribute(OVERLAY_ATTRIBUTE, "");
  host.style.cssText = `position:fixed;inset:0;z-index:${Z_INDEX_OVERLAY};pointer-events:none`;
  applyAnnotationTheme(host, annotationTheme);
  const shadowRoot = host.attachShadow({ mode: "closed" });
  const themeStyle = document.createElement("style");
  themeStyle.textContent = previewAnnotationStyles;
  shadowRoot.appendChild(themeStyle);

  const root = document.createElement("div");
  root.setAttribute(OVERLAY_ATTRIBUTE, "");
  root.className = "fixed inset-0 font-sans text-foreground";
  root.style.cssText = "pointer-events:none";
  const cursorStyle = document.createElement("style");
  cursorStyle.setAttribute(OVERLAY_ATTRIBUTE, "");
  cursorStyle.textContent = `html[data-t3code-annotation-tool] body, html[data-t3code-annotation-tool] body * { cursor: crosshair !important; } [${OVERLAY_ATTRIBUTE}], [${OVERLAY_ATTRIBUTE}] * { cursor: default !important; } [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-inner-spin-button, [${OVERLAY_ATTRIBUTE}] input[type=number]::-webkit-outer-spin-button { appearance:none; margin:0; }`;
  document.documentElement.appendChild(cursorStyle);
  shadowRoot.appendChild(root);

  const hoverOutline = createBox(PRIMARY, PRIMARY_FILL);
  const marqueeBox = createBox(PRIMARY, PRIMARY_FILL);
  root.append(hoverOutline, marqueeBox);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute(OVERLAY_ATTRIBUTE, "");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.cssText = "position:fixed;inset:0;overflow:visible;pointer-events:none";
  svg.style.zIndex = String(CONTENT_LAYER_Z_INDEX);
  root.appendChild(svg);

  const toolbar = document.createElement("div");
  toolbar.setAttribute(OVERLAY_ATTRIBUTE, "");
  toolbar.className =
    "pointer-events-auto fixed top-2.5 left-1/2 flex -translate-x-1/2 gap-0.5 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-lg backdrop-blur-xl";
  toolbar.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  if (isMainFrame) root.appendChild(toolbar);

  const editor = document.createElement("div");
  editor.setAttribute(OVERLAY_ATTRIBUTE, "");
  editor.className =
    "pointer-events-auto fixed hidden max-h-[calc(100vh-16px)] w-[min(360px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-border bg-popover/96 text-popover-foreground shadow-2xl backdrop-blur-xl";
  editor.style.zIndex = String(CHROME_LAYER_Z_INDEX);
  if (isMainFrame) root.appendChild(editor);

  const composerRow = document.createElement("div");
  composerRow.className = "flex items-start gap-2 p-2";

  const adjust = createButton("", "Expand annotation editor");
  adjust.setAttribute("aria-label", "Expand annotation editor");
  adjust.setAttribute("aria-expanded", "false");
  adjust.className +=
    " h-8 w-8 shrink-0 bg-muted p-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground";
  adjust.innerHTML =
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12M7 3v4M13 8v4M9 13v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  composerRow.appendChild(adjust);

  const comment = document.createElement("textarea");
  comment.placeholder = "Describe the change…";
  comment.rows = 1;
  comment.className =
    "min-h-8 max-h-24 min-w-0 flex-1 resize-none overflow-y-hidden border-0 border-b border-b-transparent bg-transparent px-0 py-1.5 font-sans text-sm leading-5 text-foreground outline-none ring-0 placeholder:text-muted-foreground focus:border-b-primary focus:outline-none focus:ring-0";
  composerRow.appendChild(comment);

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.textContent = "⠿";
  dragHandle.title = "Drag annotation editor";
  dragHandle.className =
    "hidden h-8 w-6 shrink-0 cursor-grab select-none border-0 bg-transparent p-0 font-sans text-lg font-bold leading-5 text-muted-foreground";
  composerRow.appendChild(dragHandle);

  const submit = createButton("Attach", "Attach annotation and screenshot");
  submit.className +=
    " h-8 shrink-0 border-primary bg-primary px-3 text-primary-foreground shadow-sm hover:bg-primary/90";
  composerRow.appendChild(submit);
  editor.appendChild(composerRow);

  const stylePanel = document.createElement("div");
  stylePanel.className =
    "hidden max-h-[min(176px,calc(100vh-180px))] overflow-auto border-t border-border bg-muted/40 px-3";
  editor.appendChild(stylePanel);

  const selected = new Map<Element, SelectedElement>();
  const regions: PreviewAnnotationRegionTarget[] = [];
  const strokes: PreviewAnnotationStrokeTarget[] = [];
  const styleChanges = new Map<string, PreviewAnnotationStyleChange>();
  const remoteFrames = new Map<string, FrameAnnotationState>();
  const childFrameStates = new Map<
    string,
    { readonly sourceWindow: WindowProxy; readonly message: FrameStateMessage }
  >();
  const regionOrigins = new Map<
    string,
    { readonly origin: AnnotationOrigin; readonly node: HTMLDivElement }
  >();
  const strokeOrigins = new Map<
    string,
    { readonly origin: AnnotationOrigin; readonly path: SVGPathElement }
  >();
  const toolButtons = new Map<AnnotationTool, HTMLButtonElement>();
  const pendingMarqueeRegions = new Map<string, string>();
  let tool: AnnotationTool = "select";
  let hoveredElement: Element | null = null;
  let activeMarquee: {
    pointerId: number;
    start: PreviewAnnotationPoint;
    additive: boolean;
  } | null = null;
  let activeStroke: {
    pointerId: number;
    target: PreviewAnnotationStrokeTarget;
    path: SVGPathElement;
  } | null = null;
  let pendingCapture = false;
  let editorExpanded = false;
  let editorWasShown = false;
  let editorPosition: { left: number; top: number } | null = null;
  let editorDrag: { pointerId: number; offsetX: number; offsetY: number } | null = null;
  let editorLayoutFrame: number | null = null;
  let repaintFrame: number | null = null;
  let publishFrame: number | null = null;
  let relayFrame: number | null = null;

  const resizeComment = (): void => {
    const maxHeight = 96;
    comment.style.height = "auto";
    const nextHeight = Math.min(comment.scrollHeight, maxHeight);
    comment.style.height = `${nextHeight}px`;
    comment.style.overflowY = comment.scrollHeight > maxHeight ? "auto" : "hidden";
    queueEditorLayout();
  };
  comment.addEventListener("input", resizeComment);

  const captureAnnotationOrigin = (anchor: Element | null): AnnotationOrigin =>
    anchor
      ? {
          kind: "element",
          anchor,
          anchorRect: rectFromDomRect(anchor.getBoundingClientRect()),
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        }
      : {
          kind: "viewport",
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        };

  const annotationOffset = (origin: AnnotationOrigin): PreviewAnnotationPoint => {
    if (origin.kind === "element" && origin.anchor.isConnected) {
      const rect = origin.anchor.getBoundingClientRect();
      return {
        x: rect.left - origin.anchorRect.x,
        y: rect.top - origin.anchorRect.y,
      };
    }
    return {
      x: -(window.scrollX - origin.scrollX),
      y: -(window.scrollY - origin.scrollY),
    };
  };

  const currentRegionRect = (region: PreviewAnnotationRegionTarget): PreviewAnnotationRect => {
    const visual = regionOrigins.get(region.id);
    if (!visual) return region.rect;
    const offset = annotationOffset(visual.origin);
    return {
      ...region.rect,
      x: region.rect.x + offset.x,
      y: region.rect.y + offset.y,
    };
  };

  const currentStroke = (stroke: PreviewAnnotationStrokeTarget): PreviewAnnotationStrokeTarget => {
    const visual = strokeOrigins.get(stroke.id);
    if (!visual) return stroke;
    const offset = annotationOffset(visual.origin);
    return {
      ...stroke,
      points: stroke.points.map((point) => ({
        x: point.x + offset.x,
        y: point.y + offset.y,
      })),
      bounds: {
        ...stroke.bounds,
        x: stroke.bounds.x + offset.x,
        y: stroke.bounds.y + offset.y,
      },
    };
  };

  let publishRevision = 0;
  const publishState = (): void => {
    if (isMainFrame || finished) return;
    const revision = ++publishRevision;
    void Promise.all(
      Array.from(selected.values()).map(async (target) => {
        const element = await target.capture;
        if (!element || !target.element.isConnected) return null;
        for (const change of styleChanges.values()) {
          if (change.targetId === target.id) change.selector = element.selector;
        }
        return {
          id: target.id,
          element,
          rect: clipToViewport(rectFromDomRect(target.element.getBoundingClientRect())),
          computedStyles: snapshotComputedStyles(target.element),
        } satisfies FrameElementTarget;
      }),
    ).then((captured) => {
      if (finished || revision !== publishRevision) return;
      const message: FrameStateMessage = {
        source: FRAME_BRIDGE_SOURCE,
        kind: "state",
        sessionId,
        frameId,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        state: {
          pageUrl: location.href,
          pageTitle: document.title?.trim() || null,
          elements: captured.filter((target) => target !== null),
          regions: regions.map((region) => ({
            ...region,
            rect: clipToViewport(currentRegionRect(region)),
          })),
          strokes: strokes.map((stroke) => {
            const current = currentStroke(stroke);
            return { ...current, bounds: clipToViewport(current.bounds) };
          }),
          styleChanges: Array.from(styleChanges.values()),
        },
      };
      window.parent.postMessage(message, "*");
    });
  };

  const queuePublishState = (): void => {
    if (isMainFrame || finished || publishFrame !== null) return;
    publishFrame = window.requestAnimationFrame(() => {
      publishFrame = null;
      publishState();
    });
  };

  const broadcastFrameCommand = (command: FrameCommand): void => {
    for (const owner of frameOwnerElements()) {
      if (!owner.contentWindow) continue;
      let childCommand = command;
      if (command.kind === "marquee-select") {
        const ownerRect = owner.getBoundingClientRect();
        const scaleX = owner.offsetWidth > 0 ? ownerRect.width / owner.offsetWidth : 1;
        const scaleY = owner.offsetHeight > 0 ? ownerRect.height / owner.offsetHeight : 1;
        const contentX = ownerRect.left + owner.clientLeft * scaleX;
        const contentY = ownerRect.top + owner.clientTop * scaleY;
        childCommand = {
          ...command,
          rect: {
            x: (command.rect.x - contentX) / scaleX,
            y: (command.rect.y - contentY) / scaleY,
            width: command.rect.width / scaleX,
            height: command.rect.height / scaleY,
          },
        };
      }
      owner.contentWindow.postMessage(
        {
          source: FRAME_BRIDGE_SOURCE,
          kind: "command",
          sessionId,
          command: childCommand,
        } satisfies FrameCommandMessage,
        "*",
      );
    }
  };

  const remoteTargets = (): ReadonlyArray<FrameElementTarget> =>
    Array.from(remoteFrames.values()).flatMap((state) => state.elements);

  const remoteTargetRects = (): ReadonlyArray<PreviewAnnotationRect> =>
    Array.from(remoteFrames.values()).flatMap((state) => [
      ...state.elements.map((target) => target.rect),
      ...state.regions.map((region) => region.rect),
      ...state.strokes.map((stroke) => stroke.bounds),
    ]);

  const updateStatus = (measuredLocalRects?: ReadonlyArray<PreviewAnnotationRect>): void => {
    const hasTargets =
      selected.size > 0 ||
      regions.length > 0 ||
      strokes.length > 0 ||
      remoteTargetRects().length > 0;
    const hasVisibleTarget =
      unionRects([
        ...(measuredLocalRects ?? [
          ...Array.from(selected.values(), (target) =>
            clipToViewport(rectFromDomRect(target.element.getBoundingClientRect())),
          ),
          ...regions.map((region) => clipToViewport(currentRegionRect(region))),
          ...strokes.map((stroke) => clipToViewport(currentStroke(stroke).bounds)),
        ]),
        ...remoteTargetRects(),
      ]) !== null;
    editor.style.display = isMainFrame && hasTargets && hasVisibleTarget ? "flex" : "none";
    submit.disabled = !hasTargets;
    submit.style.opacity = hasTargets ? "1" : "0.45";
    adjust.disabled = !hasTargets;
    stylePanel.style.display =
      editorExpanded && (selected.size > 0 || remoteTargets().length > 0) ? "grid" : "none";
    queueEditorLayout();
    if (isMainFrame && hasVisibleTarget && !editorWasShown) {
      editorWasShown = true;
      window.setTimeout(() => comment.focus({ preventScroll: true }), 0);
    }
  };

  const refreshToolButtons = (): void => {
    for (const [candidate, button] of toolButtons) {
      const active = candidate === tool;
      button.classList.toggle("bg-primary/10", active);
      button.classList.toggle("text-primary", active);
      button.classList.toggle("text-foreground", !active);
    }
    if (tool !== "select") {
      hoveredElement = null;
      hoverOutline.style.display = "none";
    }
    if (tool !== "marquee") {
      marqueeBox.style.display = "none";
      activeMarquee = null;
    }
    if (tool !== "draw" && activeStroke) {
      activeStroke.path.remove();
      activeStroke = null;
    }
    document.documentElement.setAttribute("data-t3code-annotation-tool", tool);
  };

  const removeSelected = (target: SelectedElement): void => {
    if (target.element instanceof HTMLElement || target.element instanceof SVGElement) {
      for (const [property, baseline] of target.baselineStyles) {
        if (baseline) target.element.style.setProperty(property, baseline);
        else target.element.style.removeProperty(property);
      }
    }
    selected.delete(target.element);
    target.outline.remove();
    target.label.remove();
    for (const [key, change] of styleChanges) {
      if (change.targetId === target.id) styleChanges.delete(key);
    }
    updateStatus();
    queuePublishState();
  };

  const clearTargetsExcept = (keepFrameId: string, keepTargetIds: ReadonlyArray<string>): void => {
    const keep = frameId === keepFrameId ? new Set(keepTargetIds) : new Set<string>();
    for (const target of Array.from(selected.values())) {
      if (!keep.has(target.id)) removeSelected(target);
    }
    for (let index = regions.length - 1; index >= 0; index -= 1) {
      const region = regions[index];
      if (!region || keep.has(region.id)) continue;
      regions.splice(index, 1);
      regionOrigins.get(region.id)?.node.remove();
      regionOrigins.delete(region.id);
    }
    for (let index = strokes.length - 1; index >= 0; index -= 1) {
      const stroke = strokes[index];
      if (!stroke || keep.has(stroke.id)) continue;
      strokes.splice(index, 1);
      strokeOrigins.get(stroke.id)?.path.remove();
      strokeOrigins.delete(stroke.id);
    }
    updateStatus();
    queuePublishState();
  };

  const addSelected = (element: Element): SelectedElement => {
    const existing = selected.get(element);
    if (existing) return existing;
    const target: SelectedElement = {
      id: `${frameId}:${nextId("element")}`,
      element,
      outline: createBox(PRIMARY, PRIMARY_FILL),
      label: createLabel(),
      baselineStyles: new Map(),
      capture: captureElement(element),
    };
    selected.set(element, target);
    root.append(target.outline, target.label);
    updateSelectedVisual(target);
    updateStatus();
    if (editorExpanded) {
      stylePanel.style.display = "grid";
      syncStyleControls();
    }
    queuePublishState();
    return target;
  };

  const toggleSelected = (element: Element, additive: boolean): void => {
    const existing = selected.get(element);
    if (existing) {
      removeSelected(existing);
      return;
    }
    if (!additive) {
      for (const target of Array.from(selected.values())) removeSelected(target);
    }
    const target = addSelected(element);
    if (!additive) {
      clearTargetsExcept(frameId, [target.id]);
      ipcRenderer.send(ANNOTATION_SELECTION_CLAIMED_CHANNEL, sessionId, frameId, [target.id]);
    }
  };

  const setStyleForSelected = (property: string, value: string): void => {
    for (const target of selected.values()) {
      if (!(target.element instanceof HTMLElement || target.element instanceof SVGElement))
        continue;
      if (!target.baselineStyles.has(property)) {
        target.baselineStyles.set(property, target.element.style.getPropertyValue(property));
      }
      const key = `${target.id}:${property}`;
      const previousValue =
        styleChanges.get(key)?.previousValue ??
        getComputedStyle(target.element).getPropertyValue(property).trim();
      target.element.style.setProperty(property, value, "important");
      styleChanges.set(key, {
        targetId: target.id,
        selector: null,
        property,
        previousValue,
        value,
      });
      updateSelectedVisual(target);
    }
    queuePublishState();
    if (isMainFrame) broadcastFrameCommand({ kind: "style", property, value });
  };

  const textSection = createStyleSection();
  const colorsSection = createStyleSection();
  const bordersSection = createStyleSection();
  const sizingSection = createStyleSection();
  stylePanel.append(textSection, colorsSection, bordersSection, sizingSection);

  const fontFamily = document.createElement("select");
  for (const value of ["inherit", "system-ui", "sans-serif", "serif", "monospace"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    fontFamily.appendChild(option);
  }
  fontFamily.addEventListener("change", () => setStyleForSelected("font-family", fontFamily.value));
  textSection.appendChild(createField("Font", fontFamily));

  const fontSize = createUnitInput("px", "16");
  fontSize.min = "1";
  fontSize.max = "300";
  fontSize.addEventListener("input", () => {
    if (fontSize.value) setStyleForSelected("font-size", `${fontSize.value}px`);
  });
  textSection.appendChild(createField("Font size", fontSize));

  const fontWeight = document.createElement("select");
  for (const value of ["300", "400", "500", "600", "700", "800", "900"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    fontWeight.appendChild(option);
  }
  fontWeight.addEventListener("change", () => setStyleForSelected("font-weight", fontWeight.value));
  textSection.appendChild(createField("Font weight", fontWeight));

  const lineHeight = document.createElement("input");
  lineHeight.type = "text";
  lineHeight.placeholder = "normal / 1.4";
  lineHeight.addEventListener("change", () => {
    if (lineHeight.value.trim()) setStyleForSelected("line-height", lineHeight.value.trim());
  });
  textSection.appendChild(createField("Line height", lineHeight));

  const createColorRow = (
    labelText: string,
    property: string,
    section: HTMLElement,
  ): { row: HTMLLabelElement; color: HTMLInputElement; text: HTMLInputElement } => {
    const row = document.createElement("label");
    row.className =
      "grid min-h-7 grid-cols-[82px_minmax(0,1fr)] items-center gap-2 font-sans text-xs font-medium text-muted-foreground";
    const label = document.createElement("span");
    label.textContent = labelText;
    const control = document.createElement("div");
    control.className =
      "grid h-7 grid-cols-[22px_minmax(0,1fr)] items-center gap-1 rounded-md border border-input bg-background px-1 shadow-xs";
    const color = document.createElement("input");
    color.type = "color";
    color.setAttribute("aria-label", labelText);
    color.style.cssText =
      "width:20px;height:20px;padding:0;border:0;border-radius:5px;overflow:hidden;background:transparent;cursor:pointer";
    const text = document.createElement("input");
    text.type = "text";
    text.setAttribute("aria-label", `${labelText} value`);
    text.className =
      "min-w-0 w-full border-0 bg-transparent font-mono text-xs text-foreground outline-none";
    color.addEventListener("input", () => {
      text.value = color.value;
      setStyleForSelected(property, color.value);
    });
    text.addEventListener("change", () => {
      const value = text.value.trim();
      if (!value) return;
      setStyleForSelected(property, value);
      if (/^#[0-9a-f]{6}$/i.test(value)) color.value = value;
    });
    control.append(color, text);
    row.append(label, control);
    section.appendChild(row);
    return { row, color, text };
  };

  const textColor = createColorRow("Text color", "color", colorsSection);
  const backgroundColor = createColorRow("Background", "background-color", colorsSection);

  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "1";
  opacity.step = "0.05";
  opacity.value = "1";
  opacity.style.accentColor = PRIMARY;
  opacity.addEventListener("input", () => setStyleForSelected("opacity", opacity.value));
  colorsSection.appendChild(createField("Opacity", opacity));

  const radius = createUnitInput("px", "0");
  radius.min = "0";
  radius.max = "300";
  radius.addEventListener("input", () => {
    if (radius.value) setStyleForSelected("border-radius", `${radius.value}px`);
  });
  bordersSection.appendChild(createField("Radius", radius));

  const borderColor = createColorRow("Border color", "border-color", bordersSection);

  const borderWidth = createUnitInput("px", "0");
  borderWidth.min = "0";
  borderWidth.max = "100";
  borderWidth.addEventListener("input", () => {
    if (borderWidth.value) {
      setStyleForSelected("border-style", "solid");
      setStyleForSelected("border-width", `${borderWidth.value}px`);
    }
  });
  bordersSection.appendChild(createField("Border width", borderWidth));

  const dimensions = document.createElement("div");
  dimensions.style.cssText =
    "display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px;align-items:center";
  const dimensionLabel = document.createElement("div");
  dimensionLabel.className = "grid gap-2 font-sans text-xs font-medium text-muted-foreground";
  dimensionLabel.innerHTML = "<span>Width</span><span>Height</span>";
  const dimensionControls = document.createElement("div");
  dimensionControls.style.cssText = "position:relative;display:grid;gap:3px;padding-left:22px";
  const widthInput = createUnitInput("px", "auto");
  const heightInput = createUnitInput("px", "auto");
  styleControl(widthInput);
  styleControl(heightInput);
  const aspectLock = createButton("", "Lock aspect ratio");
  aspectLock.setAttribute("aria-pressed", "true");
  aspectLock.style.cssText +=
    ";position:absolute;left:0;top:50%;transform:translateY(-50%);width:18px;height:38px;padding:0";
  aspectLock.className += " bg-primary/10 text-primary";
  dimensionControls.append(
    createUnitControl(widthInput),
    createUnitControl(heightInput),
    aspectLock,
  );
  dimensions.append(dimensionLabel, dimensionControls);
  sizingSection.appendChild(dimensions);

  let aspectLocked = true;
  let aspectRatio = 1;
  const refreshAspectButton = (): void => {
    aspectLock.innerHTML = aspectLocked
      ? '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M8 6.5 9.5 5A3.5 3.5 0 0 1 14.5 10l-1.5 1.5M12 13.5 10.5 15A3.5 3.5 0 0 1 5.5 10L7 8.5M7.5 12.5l5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="m6 6 8 8M8 6.5 9.5 5A3.5 3.5 0 0 1 14 9M12 13.5 10.5 15A3.5 3.5 0 0 1 6 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    aspectLock.setAttribute("aria-pressed", String(aspectLocked));
    aspectLock.classList.toggle("bg-primary/10", aspectLocked);
    aspectLock.classList.toggle("text-primary", aspectLocked);
    aspectLock.classList.toggle("bg-muted", !aspectLocked);
    aspectLock.classList.toggle("text-muted-foreground", !aspectLocked);
  };
  aspectLock.addEventListener("click", () => {
    aspectLocked = !aspectLocked;
    refreshAspectButton();
  });
  widthInput.addEventListener("input", () => {
    const width = Number(widthInput.value);
    if (!Number.isFinite(width) || width <= 0) return;
    setStyleForSelected("width", `${width}px`);
    if (aspectLocked && aspectRatio > 0) {
      const height = Math.max(1, Math.round(width / aspectRatio));
      heightInput.value = String(height);
      setStyleForSelected("height", `${height}px`);
    }
  });
  heightInput.addEventListener("input", () => {
    const height = Number(heightInput.value);
    if (!Number.isFinite(height) || height <= 0) return;
    setStyleForSelected("height", `${height}px`);
    if (aspectLocked && aspectRatio > 0) {
      const width = Math.max(1, Math.round(height * aspectRatio));
      widthInput.value = String(width);
      setStyleForSelected("width", `${width}px`);
    }
  });
  refreshAspectButton();

  const addSpacingField = (
    label: string,
    property: string,
    placeholder: string,
  ): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.addEventListener("change", () => {
      if (input.value.trim()) setStyleForSelected(property, input.value.trim());
    });
    sizingSection.appendChild(createField(label, input));
    return input;
  };
  const padding = addSpacingField("Padding", "padding", "0 0 0 0");
  const margin = addSpacingField("Margin", "margin", "0 0 0 0");
  const gap = addSpacingField("Gap", "gap", "0px");

  const syncStyleControls = (): void => {
    const local = selected.values().next().value as SelectedElement | undefined;
    const remote = remoteTargets()[0];
    if (!local && !remote) return;
    const computed = local ? snapshotComputedStyles(local.element) : remote!.computedStyles;
    const rect = local ? local.element.getBoundingClientRect() : remote!.rect;
    aspectRatio = rect.height > 0 ? rect.width / rect.height : 1;
    widthInput.value = String(Math.round(rect.width));
    heightInput.value = String(Math.round(rect.height));
    fontSize.value = String(Math.round(Number.parseFloat(computed.fontSize) || 16));
    fontWeight.value = computed.fontWeight.match(/^[0-9]+$/) ? computed.fontWeight : "400";
    lineHeight.value = computed.lineHeight;
    fontFamily.value = Array.from(fontFamily.options).some(
      (option) => option.value === computed.fontFamily,
    )
      ? computed.fontFamily
      : "inherit";
    textColor.text.value = computed.color;
    backgroundColor.text.value = computed.backgroundColor;
    borderColor.text.value = computed.borderColor;
    opacity.value = computed.opacity;
    radius.value = String(Math.round(Number.parseFloat(computed.borderRadius) || 0));
    borderWidth.value = String(Math.round(Number.parseFloat(computed.borderWidth) || 0));
    padding.value = computed.padding;
    margin.value = computed.margin;
    gap.value = computed.gap === "normal" ? "0px" : computed.gap;
  };

  const tools: ReadonlyArray<[AnnotationTool, string, string]> = [
    ["select", "Select", "Select elements (V)"],
    ["marquee", "Region", "Draw a region or marquee-select elements (R)"],
    ["draw", "Draw", "Draw freehand (D)"],
    ["erase", "Erase", "Remove an annotation target (E)"],
  ];
  for (const [candidate, label, title] of tools) {
    const button = createButton(label, title);
    button.className += " h-8 px-2.5 text-sm";
    button.addEventListener("click", () => {
      tool = candidate;
      refreshToolButtons();
      broadcastFrameCommand({ kind: "tool", tool });
    });
    toolButtons.set(candidate, button);
    toolbar.appendChild(button);
  }

  const applyDrawGesture = (message: FrameDrawGestureMessage): void => {
    if (!isMainFrame) return;
    if (message.phase === "start") {
      activeStroke?.path.remove();
      const stroke: PreviewAnnotationStrokeTarget = {
        id: `${frameId}:${nextId("stroke")}`,
        color: annotationTheme?.primary ?? "#2563eb",
        width: 4,
        points: [message.point],
        bounds: { x: message.point.x, y: message.point.y, width: 1, height: 1 },
      };
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(OVERLAY_ATTRIBUTE, "");
      path.setAttribute("data-stroke-id", stroke.id);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke.color);
      path.setAttribute("stroke-width", String(stroke.width));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      activeStroke = { pointerId: message.pointerId, target: stroke, path };
      return;
    }
    if (!activeStroke || activeStroke.pointerId !== message.pointerId) return;
    if (message.phase === "cancel") {
      activeStroke.path.remove();
      activeStroke = null;
      return;
    }
    const lastPoint = activeStroke.target.points.at(-1);
    if (!lastPoint || lastPoint.x !== message.point.x || lastPoint.y !== message.point.y) {
      activeStroke.target.points = [...activeStroke.target.points, message.point];
      activeStroke.target.bounds = strokeBounds(
        activeStroke.target.points,
        activeStroke.target.width,
      );
      activeStroke.path.setAttribute("d", pathFromPoints(activeStroke.target.points));
    }
    if (message.phase === "move") return;
    if (activeStroke.target.points.length > 1) {
      strokes.push(activeStroke.target);
      strokeOrigins.set(activeStroke.target.id, {
        origin: captureAnnotationOrigin(null),
        path: activeStroke.path,
      });
    } else activeStroke.path.remove();
    activeStroke = null;
    updateStatus();
  };

  const sendDrawGesture = (phase: FrameDrawGestureMessage["phase"], event: PointerEvent): void => {
    const message = {
      source: FRAME_BRIDGE_SOURCE,
      kind: "draw-gesture",
      sessionId,
      phase,
      pointerId: event.pointerId,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      point: { x: event.clientX, y: event.clientY },
    } satisfies FrameDrawGestureMessage;
    if (isMainFrame) applyDrawGesture(message);
    else window.parent.postMessage(message, "*");
  };

  const applyMarqueeGesture = (message: FrameMarqueeGestureMessage): void => {
    if (!isMainFrame) return;
    if (message.phase === "start") {
      activeMarquee = {
        pointerId: message.pointerId,
        start: message.point,
        additive: message.additive,
      };
      return;
    }
    if (!activeMarquee || activeMarquee.pointerId !== message.pointerId) return;
    if (message.phase === "cancel") {
      marqueeBox.style.display = "none";
      activeMarquee = null;
      return;
    }
    const rect = normalizeRect(
      activeMarquee.start.x,
      activeMarquee.start.y,
      message.point.x,
      message.point.y,
    );
    if (message.phase === "move") {
      positionBox(marqueeBox, rect);
      return;
    }
    marqueeBox.style.display = "none";
    const additive = activeMarquee.additive;
    activeMarquee = null;
    if (!isUsableRect(rect)) return;
    const command = {
      kind: "marquee-select",
      operationId: `${frameId}:${nextId("marquee")}`,
      rect,
      additive,
    } satisfies FrameMarqueeSelectionCommand;
    const found = applyMarqueeSelection(command);
    if (found.length === 0) {
      const region: PreviewAnnotationRegionTarget = {
        id: `${frameId}:${nextId("region")}`,
        rect,
      };
      regions.push(region);
      const regionBox = createBox(PRIMARY, "color-mix(in srgb, var(--t3-primary) 6%, transparent)");
      regionBox.setAttribute("data-region-id", region.id);
      positionBox(regionBox, rect);
      root.appendChild(regionBox);
      regionOrigins.set(region.id, {
        origin: captureAnnotationOrigin(null),
        node: regionBox,
      });
      pendingMarqueeRegions.set(command.operationId, region.id);
    }
    broadcastFrameCommand(command);
    updateStatus();
  };

  const sendMarqueeGesture = (
    phase: FrameMarqueeGestureMessage["phase"],
    event: PointerEvent,
  ): void => {
    const message = {
      source: FRAME_BRIDGE_SOURCE,
      kind: "marquee-gesture",
      sessionId,
      phase,
      pointerId: event.pointerId,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      point: { x: event.clientX, y: event.clientY },
      additive: event.shiftKey,
    } satisfies FrameMarqueeGestureMessage;
    if (isMainFrame) applyMarqueeGesture(message);
    else window.parent.postMessage(message, "*");
  };

  const applyFrameCommand = (command: FrameCommand): void => {
    if (command.kind === "tool") {
      tool = command.tool;
      refreshToolButtons();
      return;
    }
    if (command.kind === "marquee-select") {
      applyMarqueeSelection(command);
      return;
    }
    setStyleForSelected(command.property, command.value);
  };

  const onSelectionClaimed = (
    _event: Electron.IpcRendererEvent,
    claimedSessionId: string,
    keepFrameId: string,
    keepTargetIds: ReadonlyArray<string>,
  ): void => {
    if (claimedSessionId !== sessionId) return;
    clearTargetsExcept(keepFrameId, keepTargetIds);
  };

  const relayChildState = (
    entry: {
      readonly sourceWindow: WindowProxy;
      readonly message: FrameStateMessage;
    },
    refreshMain = true,
  ): void => {
    const owner = frameOwnerElements().find(
      (candidate) => candidate.contentWindow === entry.sourceWindow,
    );
    const message = owner
      ? projectFrameState(entry.message, owner)
      : {
          ...entry.message,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          state: {
            ...entry.message.state,
            elements: [],
            regions: [],
            strokes: [],
            styleChanges: [],
          },
        };
    if (!isMainFrame) {
      window.parent.postMessage(message, "*");
      return;
    }
    if (
      message.state.elements.length === 0 &&
      message.state.regions.length === 0 &&
      message.state.strokes.length === 0
    ) {
      remoteFrames.delete(message.frameId);
    } else {
      remoteFrames.set(message.frameId, message.state);
    }
    if (refreshMain) {
      updateStatus();
      if (editorExpanded) syncStyleControls();
    }
  };

  const relayChildStates = (refreshMain = true): void => {
    for (const entry of childFrameStates.values()) relayChildState(entry, false);
    if (isMainFrame && refreshMain) {
      updateStatus();
      if (editorExpanded) syncStyleControls();
    }
  };

  const queueRelayChildStates = (): void => {
    if (finished || childFrameStates.size === 0 || relayFrame !== null) return;
    relayFrame = window.requestAnimationFrame(() => {
      relayFrame = null;
      relayChildStates();
    });
  };

  const onFrameBridgeMessage = (event: MessageEvent<FrameBridgeMessage>): void => {
    const message = event.data;
    if (!message || message.source !== FRAME_BRIDGE_SOURCE || message.sessionId !== sessionId) {
      return;
    }
    if (message.kind === "state") {
      const owner = frameOwnerElements().find(
        (candidate) => candidate.contentWindow === event.source,
      );
      if (!owner?.contentWindow) return;
      const entry = { sourceWindow: owner.contentWindow, message };
      childFrameStates.set(message.frameId, entry);
      relayChildState(entry);
      return;
    }
    if (message.kind === "marquee-selection") {
      const fromChild = frameOwnerElements().some(
        (candidate) => candidate.contentWindow === event.source,
      );
      if (!fromChild) return;
      if (!isMainFrame) {
        window.parent.postMessage(message, "*");
        return;
      }
      const regionId = pendingMarqueeRegions.get(message.operationId);
      if (!regionId) return;
      pendingMarqueeRegions.delete(message.operationId);
      const regionIndex = regions.findIndex((region) => region.id === regionId);
      if (regionIndex < 0) return;
      regions.splice(regionIndex, 1);
      regionOrigins.get(regionId)?.node.remove();
      regionOrigins.delete(regionId);
      updateStatus();
      return;
    }
    if (message.kind === "draw-gesture" || message.kind === "marquee-gesture") {
      const owner = frameOwnerElements().find(
        (candidate) => candidate.contentWindow === event.source,
      );
      if (!owner?.contentWindow) return;
      const ownerRect = owner.getBoundingClientRect();
      const borderScaleX = owner.offsetWidth > 0 ? ownerRect.width / owner.offsetWidth : 1;
      const borderScaleY = owner.offsetHeight > 0 ? ownerRect.height / owner.offsetHeight : 1;
      const contentX = ownerRect.left + owner.clientLeft * borderScaleX;
      const contentY = ownerRect.top + owner.clientTop * borderScaleY;
      const contentWidth = owner.clientWidth * borderScaleX;
      const contentHeight = owner.clientHeight * borderScaleY;
      const projected = {
        ...message,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        point: {
          x:
            contentX +
            message.point.x *
              (message.viewport.width > 0 ? contentWidth / message.viewport.width : 1),
          y:
            contentY +
            message.point.y *
              (message.viewport.height > 0 ? contentHeight / message.viewport.height : 1),
        },
      } satisfies FrameDrawGestureMessage | FrameMarqueeGestureMessage;
      if (!isMainFrame) {
        window.parent.postMessage(projected, "*");
        return;
      }
      if (projected.kind === "draw-gesture") applyDrawGesture(projected);
      else applyMarqueeGesture(projected);
      return;
    }
    if (message.kind === "tool-request") {
      if (isMainFrame) {
        applyFrameCommand({ kind: "tool", tool: message.tool });
        broadcastFrameCommand({ kind: "tool", tool: message.tool });
      } else {
        window.parent.postMessage(message, "*");
      }
      return;
    }
    if (event.source === window.parent && !isMainFrame) {
      applyFrameCommand(message.command);
      broadcastFrameCommand(message.command);
      return;
    }
    if (isMainFrame) {
      applyFrameCommand(message.command);
      broadcastFrameCommand(message.command);
    } else {
      window.parent.postMessage(message, "*");
    }
  };

  const clampEditorPosition = (left: number, top: number): { left: number; top: number } => {
    const margin = 8;
    const rect = editor.getBoundingClientRect();
    return {
      left: Math.min(
        Math.max(margin, left),
        Math.max(margin, window.innerWidth - rect.width - margin),
      ),
      top: Math.min(
        Math.max(margin, top),
        Math.max(margin, window.innerHeight - rect.height - margin),
      ),
    };
  };

  const applyEditorPosition = (position: { left: number; top: number }): void => {
    const clamped = clampEditorPosition(position.left, position.top);
    editor.style.left = `${clamped.left}px`;
    editor.style.top = `${clamped.top}px`;
    editor.style.right = "auto";
    editor.style.bottom = "auto";
    if (editorExpanded) editorPosition = clamped;
  };

  const getAnnotationBounds = (): PreviewAnnotationRect | null =>
    unionRects(
      [
        ...Array.from(selected.values(), (target) =>
          clipToViewport(rectFromDomRect(target.element.getBoundingClientRect())),
        ),
        ...regions.map((region) => clipToViewport(currentRegionRect(region))),
        ...strokes.map((stroke) => clipToViewport(currentStroke(stroke).bounds)),
        ...remoteTargetRects(),
      ],
      0,
    );

  const positionCompactEditor = (): void => {
    const bounds = getAnnotationBounds();
    if (!bounds) return;
    const editorRect = editor.getBoundingClientRect();
    const gap = 8;
    const candidates = [
      { left: bounds.x + bounds.width + gap, top: bounds.y },
      { left: bounds.x - editorRect.width - gap, top: bounds.y },
      {
        left: bounds.x + bounds.width - editorRect.width,
        top: bounds.y + bounds.height + gap,
      },
      {
        left: bounds.x + bounds.width - editorRect.width,
        top: bounds.y - editorRect.height - gap,
      },
    ];
    const overflow = (position: { left: number; top: number }): number =>
      Math.max(0, -position.left) +
      Math.max(0, -position.top) +
      Math.max(0, position.left + editorRect.width - window.innerWidth) +
      Math.max(0, position.top + editorRect.height - window.innerHeight);
    const best = candidates.reduce((current, candidate) =>
      overflow(candidate) < overflow(current) ? candidate : current,
    );
    applyEditorPosition(best);
  };

  function queueEditorLayout(): void {
    if (!isMainFrame) return;
    if (editorLayoutFrame !== null) window.cancelAnimationFrame(editorLayoutFrame);
    editorLayoutFrame = window.requestAnimationFrame(() => {
      editorLayoutFrame = null;
      if (editor.style.display === "none") return;
      if (editorExpanded && editorPosition) applyEditorPosition(editorPosition);
      else positionCompactEditor();
    });
  }

  adjust.addEventListener("click", () => {
    if (selected.size === 0 && remoteTargets().length === 0) return;
    if (!editorExpanded) {
      const rect = editor.getBoundingClientRect();
      editorExpanded = true;
      editorPosition = { left: rect.left, top: rect.top };
      stylePanel.style.display = selected.size > 0 || remoteTargets().length > 0 ? "grid" : "none";
      dragHandle.style.display = "block";
      adjust.setAttribute("aria-expanded", "true");
      adjust.title = "Collapse annotation editor";
      adjust.setAttribute("aria-label", "Collapse annotation editor");
      syncStyleControls();
    } else {
      editorExpanded = false;
      editorPosition = null;
      stylePanel.style.display = "none";
      dragHandle.style.display = "none";
      adjust.setAttribute("aria-expanded", "false");
      adjust.title = "Expand annotation editor";
      adjust.setAttribute("aria-label", "Expand annotation editor");
    }
    queueEditorLayout();
  });

  const onEditorPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !editorExpanded) return;
    const rect = editor.getBoundingClientRect();
    editorDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    dragHandle.setPointerCapture(event.pointerId);
    dragHandle.style.cursor = "grabbing";
    event.preventDefault();
    event.stopPropagation();
  };

  const onEditorPointerMove = (event: PointerEvent): void => {
    if (!editorDrag || editorDrag.pointerId !== event.pointerId) return;
    applyEditorPosition({
      left: event.clientX - editorDrag.offsetX,
      top: event.clientY - editorDrag.offsetY,
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const onEditorPointerUp = (event: PointerEvent): void => {
    if (!editorDrag || editorDrag.pointerId !== event.pointerId) return;
    editorDrag = null;
    dragHandle.style.cursor = "grab";
    if (dragHandle.hasPointerCapture(event.pointerId))
      dragHandle.releasePointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  dragHandle.addEventListener("pointerdown", onEditorPointerDown);
  dragHandle.addEventListener("pointermove", onEditorPointerMove);
  dragHandle.addEventListener("pointerup", onEditorPointerUp);
  dragHandle.addEventListener("pointercancel", onEditorPointerUp);

  const repaint = (): void => {
    if (relayFrame !== null) window.cancelAnimationFrame(relayFrame);
    relayFrame = null;
    relayChildStates(false);

    const hoverRect =
      tool === "select" && hoveredElement?.isConnected
        ? clipToViewport(rectFromDomRect(hoveredElement.getBoundingClientRect()))
        : null;
    const selectedVisuals = Array.from(selected.values(), (target) => ({
      target,
      rect: target.element.isConnected
        ? clipToViewport(rectFromDomRect(target.element.getBoundingClientRect()))
        : null,
    }));
    const regionVisuals = regions.flatMap((region) => {
      const visual = regionOrigins.get(region.id);
      return visual ? [{ visual, rect: clipToViewport(currentRegionRect(region)) }] : [];
    });
    const strokeVisuals = strokes.flatMap((stroke) => {
      const visual = strokeOrigins.get(stroke.id);
      if (!visual) return [];
      const current = currentStroke(stroke);
      return [{ visual, current }];
    });

    if (hoverRect) positionBox(hoverOutline, hoverRect);
    else hoverOutline.style.display = "none";
    for (const { target, rect } of selectedVisuals) {
      if (rect) updateSelectedVisual(target, rect);
      else updateSelectedVisual(target);
    }
    for (const { visual, rect } of regionVisuals) positionBox(visual.node, rect);
    for (const { visual, current } of strokeVisuals) {
      visual.path.setAttribute("d", pathFromPoints(current.points));
    }

    updateStatus([
      ...selectedVisuals.flatMap(({ rect }) => (rect ? [rect] : [])),
      ...regionVisuals.map(({ rect }) => rect),
      ...strokeVisuals.map(({ current }) => clipToViewport(current.bounds)),
    ]);
    if (!isMainFrame) {
      if (publishFrame !== null) window.cancelAnimationFrame(publishFrame);
      publishFrame = null;
      publishState();
    }
  };

  const queueRepaint = (): void => {
    if (finished || repaintFrame !== null) return;
    repaintFrame = window.requestAnimationFrame(() => {
      repaintFrame = null;
      repaint();
    });
  };

  const removeTargetAtPoint = (x: number, y: number): boolean => {
    for (const target of Array.from(selected.values()).toReversed()) {
      const rect = target.element.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        removeSelected(target);
        return true;
      }
    }
    const regionIndex = regions.findIndex((region) => {
      const rect = currentRegionRect(region);
      return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
    });
    if (regionIndex >= 0) {
      const [removed] = regions.splice(regionIndex, 1);
      if (removed) {
        regionOrigins.get(removed.id)?.node.remove();
        regionOrigins.delete(removed.id);
      }
      updateStatus();
      queuePublishState();
      return true;
    }
    const strokeIndex = strokes.findIndex((stroke) => {
      const bounds = currentStroke(stroke).bounds;
      return (
        x >= bounds.x &&
        x <= bounds.x + bounds.width &&
        y >= bounds.y &&
        y <= bounds.y + bounds.height
      );
    });
    if (strokeIndex >= 0) {
      const [removed] = strokes.splice(strokeIndex, 1);
      if (removed) {
        strokeOrigins.get(removed.id)?.path.remove();
        strokeOrigins.delete(removed.id);
      }
      updateStatus();
      queuePublishState();
      return true;
    }
    return false;
  };

  function selectElementsInRect(rect: PreviewAnnotationRect): ReadonlyArray<SelectedElement> {
    const candidates = Array.from(document.querySelectorAll("body *"))
      .filter(
        (element) =>
          !isAnnotationNode(element) &&
          !(element instanceof HTMLIFrameElement) &&
          !(element instanceof HTMLFrameElement),
      )
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect: candidate }) => {
        if (candidate.width < 2 || candidate.height < 2) return false;
        return !(
          candidate.right < rect.x ||
          candidate.left > rect.x + rect.width ||
          candidate.bottom < rect.y ||
          candidate.top > rect.y + rect.height
        );
      })
      .filter(({ element, rect: candidate }) => {
        const centerX = candidate.left + candidate.width / 2;
        const centerY = candidate.top + candidate.height / 2;
        return (
          centerX >= rect.x &&
          centerX <= rect.x + rect.width &&
          centerY >= rect.y &&
          centerY <= rect.y + rect.height &&
          (element.children.length === 0 ||
            element instanceof HTMLButtonElement ||
            element instanceof HTMLAnchorElement ||
            element.getAttribute("role") === "button")
        );
      })
      .sort(
        (left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height,
      )
      .slice(0, MAX_MARQUEE_ELEMENTS);
    return candidates.map((candidate) => addSelected(candidate.element));
  }

  function applyMarqueeSelection(
    command: FrameMarqueeSelectionCommand,
  ): ReadonlyArray<SelectedElement> {
    if (!command.additive) {
      clearTargetsExcept(frameId, []);
      if (isMainFrame) pendingMarqueeRegions.clear();
    }
    const found = selectElementsInRect(command.rect);
    if (found.length > 0 && !isMainFrame) {
      window.parent.postMessage(
        {
          source: FRAME_BRIDGE_SOURCE,
          kind: "marquee-selection",
          sessionId,
          operationId: command.operationId,
        } satisfies FrameMarqueeSelectionMessage,
        "*",
      );
    }
    return found;
  }

  const clearHoverOutline = (): void => {
    hoveredElement = null;
    hoverOutline.style.display = "none";
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (tool === "draw") {
      sendDrawGesture("move", event);
      return;
    }
    if (tool === "marquee") {
      sendMarqueeGesture("move", event);
      return;
    }
    if (isAnnotationNode(event.target as Element)) {
      clearHoverOutline();
      return;
    }
    if (tool === "select") {
      const target = pickFromPoint(event.clientX, event.clientY);
      if (target) {
        hoveredElement = target;
        positionBox(hoverOutline, clipToViewport(rectFromDomRect(target.getBoundingClientRect())));
      } else clearHoverOutline();
      return;
    }
    clearHoverOutline();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isAnnotationNode(event.target as Element)) return;
    event.preventDefault();
    event.stopPropagation();
    if (tool === "select") {
      const target = pickFromPoint(event.clientX, event.clientY);
      if (target) toggleSelected(target, event.shiftKey);
      return;
    }
    if (tool === "erase") {
      removeTargetAtPoint(event.clientX, event.clientY);
      return;
    }
    if (tool === "draw") {
      sendDrawGesture("start", event);
      return;
    }
    sendMarqueeGesture("start", event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (tool === "draw") {
      event.preventDefault();
      event.stopPropagation();
      sendDrawGesture("end", event);
      return;
    }
    if (tool === "marquee") {
      event.preventDefault();
      event.stopPropagation();
      sendMarqueeGesture("end", event);
    }
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (tool === "draw") {
      sendDrawGesture("cancel", event);
      return;
    }
    if (tool === "marquee") sendMarqueeGesture("cancel", event);
  };

  const onClick = (event: MouseEvent): void => {
    if (isAnnotationNode(event.target as Element)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerOut = (event: PointerEvent): void => {
    if (
      event.relatedTarget === null ||
      event.relatedTarget instanceof HTMLIFrameElement ||
      event.relatedTarget instanceof HTMLFrameElement
    ) {
      clearHoverOutline();
    }
  };

  const onWindowBlur = (): void => {
    clearHoverOutline();
  };

  const restoreStyles = (): void => {
    for (const target of selected.values()) {
      if (!(target.element instanceof HTMLElement || target.element instanceof SVGElement))
        continue;
      for (const [property, baseline] of target.baselineStyles) {
        if (baseline) target.element.style.setProperty(property, baseline);
        else target.element.style.removeProperty(property);
      }
    }
  };

  const frameObserver = new MutationObserver(queueRelayChildStates);

  const teardown = (notifyMain: boolean): void => {
    if (finished) return;
    if (!isMainFrame) {
      const message: FrameStateMessage = {
        source: FRAME_BRIDGE_SOURCE,
        kind: "state",
        sessionId,
        frameId,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        state: {
          pageUrl: location.href,
          pageTitle: document.title?.trim() || null,
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
        },
      };
      window.parent.postMessage(message, "*");
    }
    finished = true;
    restoreStyles();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("pointerout", onPointerOut, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", queueRepaint, true);
    window.removeEventListener("resize", queueRepaint);
    window.removeEventListener("message", onFrameBridgeMessage);
    frameObserver.disconnect();
    dragHandle.removeEventListener("pointerdown", onEditorPointerDown);
    dragHandle.removeEventListener("pointermove", onEditorPointerMove);
    dragHandle.removeEventListener("pointerup", onEditorPointerUp);
    dragHandle.removeEventListener("pointercancel", onEditorPointerUp);
    if (editorLayoutFrame !== null) window.cancelAnimationFrame(editorLayoutFrame);
    if (repaintFrame !== null) window.cancelAnimationFrame(repaintFrame);
    if (publishFrame !== null) window.cancelAnimationFrame(publishFrame);
    if (relayFrame !== null) window.cancelAnimationFrame(relayFrame);
    ipcRenderer.off(CANCEL_PICK_CHANNEL, onCancel);
    ipcRenderer.off(ANNOTATION_CAPTURED_CHANNEL, onCaptured);
    ipcRenderer.off(ANNOTATION_SELECTION_CLAIMED_CHANNEL, onSelectionClaimed);
    document.documentElement.removeAttribute("data-t3code-annotation-tool");
    cursorStyle.remove();
    host.remove();
    activeSession = null;
    if (notifyMain) ipcRenderer.send(ELEMENT_PICKED_CHANNEL, null);
  };

  const onCancel = (): void => teardown(false);
  const onCaptured = (): void => teardown(false);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isAnnotationNode(event.target as Element) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      teardown(true);
      return;
    }
    if (event.key === "v") tool = "select";
    else if (event.key === "r") tool = "marquee";
    else if (event.key === "d") tool = "draw";
    else if (event.key === "e") tool = "erase";
    else return;
    refreshToolButtons();
    if (isMainFrame) broadcastFrameCommand({ kind: "tool", tool });
    else {
      window.parent.postMessage(
        {
          source: FRAME_BRIDGE_SOURCE,
          kind: "tool-request",
          sessionId,
          tool,
        } satisfies FrameToolRequestMessage,
        "*",
      );
    }
  };

  submit.addEventListener("click", () => {
    const remoteStates = Array.from(remoteFrames.values());
    if (
      pendingCapture ||
      (selected.size === 0 &&
        regions.length === 0 &&
        strokes.length === 0 &&
        remoteStates.every(
          (state) =>
            state.elements.length === 0 && state.regions.length === 0 && state.strokes.length === 0,
        ))
    )
      return;
    pendingCapture = true;
    submit.disabled = true;
    submit.textContent = "Capturing…";
    void Promise.all(
      Array.from(selected.values()).map(async (target) => {
        const element = await target.capture;
        if (!element) return null;
        for (const change of styleChanges.values()) {
          if (change.targetId === target.id) change.selector = element.selector;
        }
        return {
          id: target.id,
          element,
          rect: clipToViewport(rectFromDomRect(target.element.getBoundingClientRect())),
        };
      }),
    ).then((captured) => {
      const elements = [
        ...captured.filter((target) => target !== null),
        ...remoteStates.flatMap((state) =>
          state.elements.map(({ computedStyles: _, ...target }) => target),
        ),
      ];
      const currentRegions = [
        ...regions.map((region) => ({
          ...region,
          rect: clipToViewport(currentRegionRect(region)),
        })),
        ...remoteStates.flatMap((state) => state.regions),
      ];
      const currentStrokes = [
        ...strokes.map((stroke) => {
          const current = currentStroke(stroke);
          return { ...current, bounds: clipToViewport(current.bounds) };
        }),
        ...remoteStates.flatMap((state) => state.strokes),
      ];
      const annotation: PreviewAnnotationPayload = {
        id: nextId("annotation"),
        pageUrl: location.href,
        pageTitle: document.title?.trim() || null,
        comment: comment.value.trim(),
        elements,
        regions: currentRegions,
        strokes: currentStrokes,
        styleChanges: [
          ...styleChanges.values(),
          ...remoteStates.flatMap((state) => state.styleChanges),
        ],
        screenshot: null,
        createdAt: new Date().toISOString(),
      };
      editor.style.display = "none";
      toolbar.style.display = "none";
      hoverOutline.style.display = "none";
      const screenshotRect = unionRects([
        ...elements.map((target) => target.rect),
        ...currentRegions.map((region) => region.rect),
        ...currentStrokes.map((stroke) => stroke.bounds),
      ]);
      ipcRenderer.send(ELEMENT_PICKED_CHANNEL, annotation, screenshotRect);
    });
  });
  comment.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    submit.click();
  });

  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  window.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  window.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: false });
  window.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
  window.addEventListener("click", onClick, { capture: true, passive: false });
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("keydown", onKeyDown, { capture: true });
  window.addEventListener("scroll", queueRepaint, { capture: true, passive: true });
  window.addEventListener("resize", queueRepaint, { passive: true });
  window.addEventListener("message", onFrameBridgeMessage);
  frameObserver.observe(document.documentElement, { childList: true, subtree: true });
  ipcRenderer.on(CANCEL_PICK_CHANNEL, onCancel);
  ipcRenderer.on(ANNOTATION_CAPTURED_CHANNEL, onCaptured);
  ipcRenderer.on(ANNOTATION_SELECTION_CLAIMED_CHANNEL, onSelectionClaimed);
  document.documentElement.appendChild(host);
  refreshToolButtons();
  updateStatus();
  activeSession = {
    teardown,
    applyTheme: (theme) => applyAnnotationTheme(host, theme),
  };
  queuePublishState();
}

ipcRenderer.on(
  START_PICK_CHANNEL,
  (
    _event,
    theme: DesktopPreviewAnnotationTheme | undefined,
    sessionId: string,
    frameId: string,
  ) => {
    if (theme) annotationTheme = theme;
    startAnnotation(sessionId, frameId);
  },
);
ipcRenderer.on(ANNOTATION_THEME_CHANNEL, (_event, theme: DesktopPreviewAnnotationTheme) => {
  annotationTheme = theme;
  activeSession?.applyTheme(theme);
});
ipcRenderer.on(CANCEL_PICK_CHANNEL, () => activeSession?.teardown(false));
