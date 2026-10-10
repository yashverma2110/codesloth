import { describe, expect, it } from "vitest";
import {
  BUBBLE, EDGE_MARGIN, TOP_SAFE, BOTTOM_SAFE, PANEL_WIDTH,
  bubbleLeft, clampDrag, clampTop, defaultPosition, isDrag, loadPosition, nextOpen, onResize,
  panelPlacement, parseStoredPosition, resolveTheme, snapPosition, snapSide, type PositionStore, type WidgetPosition,
} from "../src/content/widget-logic";
import { CONTENT_ALLOWED, isAllowedSender } from "../src/shared/messages";

const vp = { width: 1440, height: 900 };

describe("drag vs click", () => {
  it("small movements are clicks, larger ones are drags", () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(3, 3)).toBe(false); // ~4.2px
    expect(isDrag(4, 4)).toBe(true); // ~5.7px
    expect(isDrag(0, -10)).toBe(true);
  });
  it("keeps the bubble inside the viewport while dragging", () => {
    expect(clampDrag(-50, -50, vp)).toEqual({ x: 0, y: 0 });
    expect(clampDrag(5000, 5000, vp)).toEqual({ x: vp.width - BUBBLE, y: vp.height - BUBBLE });
    expect(clampDrag(300, 400, vp)).toEqual({ x: 300, y: 400 });
  });
});

describe("snap on release", () => {
  it("snaps to the nearer edge using the bubble center", () => {
    expect(snapSide(100, vp)).toBe("left");
    expect(snapSide(719, vp)).toBe("left");
    expect(snapSide(720, vp)).toBe("right");
    expect(snapPosition(10, 300, vp)).toEqual({ side: "left", top: 300 });
    expect(snapPosition(vp.width / 2 - BUBBLE / 2 + 1, 300, vp).side).toBe("right");
  });
  it("vertical position is free but clamped below GitHub's header and above the bottom", () => {
    expect(snapPosition(1000, 0, vp).top).toBe(TOP_SAFE);
    expect(snapPosition(1000, 99999, vp).top).toBe(vp.height - BUBBLE - BOTTOM_SAFE);
    expect(clampTop(NaN, vp)).toBe(vp.height - BUBBLE - BOTTOM_SAFE);
  });
  it("handles a viewport shorter than the safe area", () => {
    expect(clampTop(500, { width: 400, height: 100 })).toBe(TOP_SAFE);
  });
  it("docks the bubble to the chosen edge", () => {
    expect(bubbleLeft({ side: "left", top: 100 }, vp)).toBe(EDGE_MARGIN);
    expect(bubbleLeft({ side: "right", top: 100 }, vp)).toBe(vp.width - BUBBLE - EDGE_MARGIN);
  });
});

describe("panel placement opens toward the screen center", () => {
  it("bubble bottom-right -> panel anchored right, opening upward", () => {
    const p = panelPlacement({ side: "right", top: 800 }, vp);
    expect(p.direction).toBe("up");
    expect(p.left).toBe(vp.width - PANEL_WIDTH - EDGE_MARGIN);
    expect(p.bottom).toBe(vp.height - 800 + 8);
    expect(p.maxHeight).toBeLessThanOrEqual(800 - 8 - TOP_SAFE);
  });
  it("bubble top-left -> panel anchored left, opening downward", () => {
    const p = panelPlacement({ side: "left", top: 100 }, vp);
    expect(p.direction).toBe("down");
    expect(p.left).toBe(EDGE_MARGIN);
    expect(p.top).toBe(100 + BUBBLE + 8);
    expect(p.top! + p.maxHeight).toBeLessThanOrEqual(vp.height - BOTTOM_SAFE);
  });
  it("respects a user-resized preferred height and narrow viewports", () => {
    expect(panelPlacement({ side: "left", top: 100 }, vp, 300).maxHeight).toBe(300);
    const narrow = panelPlacement({ side: "right", top: 100 }, { width: 360, height: 700 });
    expect(narrow.width).toBe(360 - 2 * EDGE_MARGIN);
    expect(narrow.left).toBe(EDGE_MARGIN);
  });
});

describe("persistence", () => {
  const store = (v: unknown): PositionStore & { saved?: WidgetPosition } => ({ get: async () => v, set: async function (p) { this.saved = p; } });
  it("defaults to bottom-right", async () => {
    expect(await loadPosition(store(null), vp)).toEqual(defaultPosition(vp));
    expect(defaultPosition(vp).side).toBe("right");
  });
  it("restores a stored side and offset, clamped to the current viewport", async () => {
    expect(await loadPosition(store({ side: "left", top: 250 }), vp)).toEqual({ side: "left", top: 250 });
    expect(await loadPosition(store({ side: "left", top: 2000 }), vp)).toEqual({ side: "left", top: vp.height - BUBBLE - BOTTOM_SAFE });
  });
  it("ignores malformed stored values and storage errors", async () => {
    for (const bad of [{ side: "top", top: 1 }, { side: "left", top: "1" }, "x", 42, { side: "left", top: Infinity }]) {
      expect(parseStoredPosition(bad, vp)).toEqual(defaultPosition(vp));
    }
    expect(await loadPosition({ get: async () => { throw new Error("x"); }, set: async () => {} }, vp)).toEqual(defaultPosition(vp));
  });
  it("re-clamps on window resize, keeping the side", () => {
    expect(onResize({ side: "left", top: 800 }, { width: 800, height: 500 })).toEqual({ side: "left", top: 500 - BUBBLE - BOTTOM_SAFE });
  });
});

describe("toggle state machine", () => {
  it("bubble, toolbar and shortcut toggle; close, Esc and leaving the PR close", () => {
    expect(nextOpen(false, "bubble")).toBe(true);
    expect(nextOpen(true, "bubble")).toBe(false);
    expect(nextOpen(false, "toolbar")).toBe(true);
    expect(nextOpen(true, "shortcut")).toBe(false);
    for (const ev of ["close", "escape", "leave-pr"] as const) {
      expect(nextOpen(true, ev)).toBe(false);
      expect(nextOpen(false, ev)).toBe(false);
    }
  });
});

describe("theme", () => {
  it("follows GitHub's data-color-mode, falling back to OS preference for auto", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });
});

describe("message sender gating (token stays out of github.com)", () => {
  const ID = "abc", ORIGIN = "chrome-extension://abc/";
  const content = { id: ID, url: "https://github.com/o/r/pull/1", tab: {} };
  const page = { id: ID, url: "chrome-extension://abc/onboarding.html" };
  it("content scripts may only use the allow-listed requests", () => {
    for (const t of CONTENT_ALLOWED) expect(isAllowedSender({ type: t }, content, ID, ORIGIN)).toBe(true);
    for (const t of ["auth:save", "auth:validate", "auth:clear", "cache:clear"]) expect(isAllowedSender({ type: t }, content, ID, ORIGIN)).toBe(false);
  });
  it("extension pages may use everything; other extensions nothing", () => {
    expect(isAllowedSender({ type: "auth:save" }, page, ID, ORIGIN)).toBe(true);
    expect(isAllowedSender({ type: "analyze" }, { id: "other", url: "https://github.com/" }, ID, ORIGIN)).toBe(false);
  });
});
