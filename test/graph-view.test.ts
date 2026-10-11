// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { GraphView, HOME_MIN_ZOOM } from "../src/graph/view";
import type { LayerPlan } from "../src/engine/types";
import { readFileSync } from "node:fs";

const res = JSON.parse(readFileSync("src/demo/demo-plan.json", "utf8"));
const plan: LayerPlan = res.plan;

/** happy-dom's WheelEvent drops modifier keys from the init dict, so set them explicitly. */
function wheel(deltaY: number, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const e = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(mods)) Object.defineProperty(e, k, { value: v });
  return e;
}

function mount(w: number, h: number, compact = false) {
  const v = new GraphView({ onJump: () => {}, compact, onExpand: compact ? () => {} : undefined });
  document.body.replaceChildren(v.el);
  const canvas = v.el.querySelector(".gv-canvas") as HTMLElement;
  Object.defineProperty(canvas, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: h, configurable: true });
  v.setData(plan);
  v.home();
  return { v, canvas };
}

describe("GraphView navigation (v0.6.5)", () => {
  it("opens on step 1 at a readable zoom instead of shrinking the whole graph", () => {
    const { v } = mount(380, 500, true);
    const t = v.transform;
    expect(t.k).toBeGreaterThanOrEqual(HOME_MIN_ZOOM);
    expect(t.k).toBeLessThanOrEqual(1);
    expect(t.y).toBe(0);
    // The first band is at the top of the canvas.
    expect(v.el.querySelector(".g-band text")!.textContent).toMatch(/^Step 1 · /);
  });

  it("plain wheel scrolls vertically; Ctrl/⌘ + wheel (or pinch) zooms", () => {
    const { v, canvas } = mount(380, 300, true);
    const k0 = v.transform.k;
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    expect(v.transform.k).toBe(k0);
    expect(v.transform.y).toBe(-120);
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100000, bubbles: true, cancelable: true }));
    expect(v.transform.y).toBeLessThanOrEqual(40); // clamped near the top
    canvas.dispatchEvent(wheel(-100, { ctrlKey: true }));
    expect(v.transform.k).toBeGreaterThan(k0);
    const k1 = v.transform.k;
    canvas.dispatchEvent(wheel(100, { metaKey: true }));
    expect(v.transform.k).toBeLessThan(k1);
  });

  it("can't scroll the graph off screen", () => {
    const { v, canvas } = mount(380, 300, true);
    for (let i = 0; i < 50; i++) canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000, bubbles: true, cancelable: true }));
    expect(v.transform.y).toBeGreaterThan(-100000);
    const y = v.transform.y;
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000, bubbles: true, cancelable: true }));
    expect(v.transform.y).toBe(y); // already at the bottom limit
  });

  it("no arrowheads; Expand is the primary action in the panel, with a tip", () => {
    const { v } = mount(380, 500, true);
    expect(v.el.querySelector("marker, [marker-end]")).toBeNull();
    const exp = [...v.el.querySelectorAll(".gv-bar button")].find((b) => /Expand/.test(b.textContent!))!;
    expect(exp.classList.contains("gv-primary")).toBe(true);
    expect(v.el.querySelector(".gv-note")!.textContent).toMatch(/Tip: ⤢ Expand/);
    // Each edge has a tooltip with the link count
    expect(v.el.querySelector(".g-link title")!.textContent).toMatch(/link|pairing/);
  });
});
