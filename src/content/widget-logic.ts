/**
 * Pure positioning / state logic for the floating widget. No DOM access, so it's unit-testable.
 * Coordinates are CSS pixels relative to the viewport.
 */

export type Side = "left" | "right";

export interface WidgetPosition {
  side: Side;
  /** Distance from the top of the viewport to the top of the bubble. */
  top: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const BUBBLE = 48;
export const EDGE_MARGIN = 16;
/** Keep clear of GitHub's global header (~64px). */
export const TOP_SAFE = 72;
export const BOTTOM_SAFE = 16;
export const DRAG_THRESHOLD = 5;
export const PANEL_WIDTH = 400;
export const PANEL_GAP = 8;
export const PANEL_MIN_HEIGHT = 200;
export const PANEL_MAX_HEIGHT = 720;

export function defaultPosition(vp: Viewport): WidgetPosition {
  return { side: "right", top: clampTop(vp.height - BUBBLE - 24, vp) };
}

/** Clamp the bubble's top so the whole bubble stays visible and below GitHub's header. */
export function clampTop(top: number, vp: Viewport): number {
  const lo = TOP_SAFE;
  const hi = Math.max(lo, vp.height - BUBBLE - BOTTOM_SAFE);
  if (!Number.isFinite(top)) return hi;
  return Math.round(Math.min(Math.max(top, lo), hi));
}

/** On release, snap to whichever edge the bubble's center is closer to. */
export function snapSide(bubbleCenterX: number, vp: Viewport): Side {
  return bubbleCenterX < vp.width / 2 ? "left" : "right";
}

/** Final resting position after a drag ends with the bubble's top-left at (x, y). */
export function snapPosition(x: number, y: number, vp: Viewport): WidgetPosition {
  return { side: snapSide(x + BUBBLE / 2, vp), top: clampTop(y, vp) };
}

/** Left coordinate of the bubble when docked. */
export function bubbleLeft(pos: WidgetPosition, vp: Viewport): number {
  return pos.side === "left" ? EDGE_MARGIN : Math.max(EDGE_MARGIN, vp.width - BUBBLE - EDGE_MARGIN);
}

/** A pointer movement only counts as a drag once it exceeds the threshold; below that it's a click. */
export function isDrag(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/** While dragging, keep the bubble fully inside the viewport. */
export function clampDrag(x: number, y: number, vp: Viewport): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, vp.width - BUBBLE)),
    y: Math.min(Math.max(y, 0), Math.max(0, vp.height - BUBBLE)),
  };
}

export interface PanelPlacement {
  left: number;
  width: number;
  /** Either top (opens downward) or bottom (opens upward) is set. */
  top?: number;
  bottom?: number;
  maxHeight: number;
  direction: "down" | "up";
}

/**
 * Place the panel next to the docked bubble, opening toward the screen center:
 * horizontally it grows inward from the bubble's edge; vertically it opens down if the bubble
 * is in the upper half, otherwise up.
 */
export function panelPlacement(pos: WidgetPosition, vp: Viewport, preferredHeight?: number): PanelPlacement {
  const width = Math.min(PANEL_WIDTH, vp.width - 2 * EDGE_MARGIN);
  const left = pos.side === "left" ? EDGE_MARGIN : Math.max(EDGE_MARGIN, vp.width - width - EDGE_MARGIN);
  const bubbleCenter = pos.top + BUBBLE / 2;
  const down = bubbleCenter < vp.height / 2;
  const cap = (avail: number) => Math.max(Math.min(PANEL_MIN_HEIGHT, avail), Math.min(PANEL_MAX_HEIGHT, preferredHeight ?? PANEL_MAX_HEIGHT, avail));
  if (down) {
    const top = pos.top + BUBBLE + PANEL_GAP;
    return { left, width, top, maxHeight: cap(vp.height - top - BOTTOM_SAFE), direction: "down" };
  }
  const bottom = vp.height - pos.top + PANEL_GAP;
  return { left, width, bottom, maxHeight: cap(vp.height - bottom - TOP_SAFE), direction: "up" };
}

/** Validate a stored position (anything malformed falls back to the default). */
export function parseStoredPosition(raw: unknown, vp: Viewport): WidgetPosition {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if ((r.side === "left" || r.side === "right") && typeof r.top === "number" && Number.isFinite(r.top)) {
      return { side: r.side, top: clampTop(r.top, vp) };
    }
  }
  return defaultPosition(vp);
}

/** Re-clamp after a window resize. Side is kept; top is clamped into the new viewport. */
export function onResize(pos: WidgetPosition, vp: Viewport): WidgetPosition {
  return { side: pos.side, top: clampTop(pos.top, vp) };
}

export type ToggleEvent = "bubble" | "toolbar" | "shortcut" | "close" | "escape" | "leave-pr";

/** Open/close state machine. */
export function nextOpen(open: boolean, ev: ToggleEvent): boolean {
  switch (ev) {
    case "bubble":
    case "toolbar":
    case "shortcut":
      return !open;
    case "close":
    case "escape":
    case "leave-pr":
      return false;
  }
}

/** Resolve GitHub's theme: <html data-color-mode="light|dark|auto">, falling back to prefers-color-scheme. */
export function resolveTheme(colorMode: string | null | undefined, prefersDark: boolean): "light" | "dark" {
  if (colorMode === "dark") return "dark";
  if (colorMode === "light") return "light";
  return prefersDark ? "dark" : "light";
}

/** Persistence via an injectable store (the background worker in production). */
export interface PositionStore {
  get(): Promise<unknown>;
  set(pos: WidgetPosition): Promise<void>;
}

export async function loadPosition(store: PositionStore, vp: Viewport): Promise<WidgetPosition> {
  try {
    return parseStoredPosition(await store.get(), vp);
  } catch {
    return defaultPosition(vp);
  }
}
