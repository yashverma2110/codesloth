import { describe, expect, it } from "vitest";
import { changedSinceReviewed, normalizeReviewState, setReviewed, snapshotLayer, summarize } from "../src/content/review-logic";
import { placeCard } from "../src/content/tour";
import type { Layer, LayerPlan } from "../src/engine/types";

const L = (files: [string, string | null][]): Layer => ({
  id: "core",
  index: 0,
  title: "Review this first",
  label: "Core",
  description: "",
  stats: { files: files.length, additions: 0, deletions: 0 },
  files: files.map(([path, sha]) => ({ path, sha, status: "modified", additions: 1, deletions: 0, category: "source", reason: "" })),
});

describe("changed since reviewed", () => {
  it("is clean right after marking reviewed", () => {
    const l = L([["a.ts", "1"], ["b.ts", "2"]]);
    expect(changedSinceReviewed(l, snapshotLayer(l))).toEqual([]);
  });
  it("flags files whose blob changed, new files and files that left the layer", () => {
    const before = L([["a.ts", "1"], ["b.ts", "2"], ["c.ts", "3"]]);
    const snap = snapshotLayer(before, "old");
    const after = L([["a.ts", "1"], ["b.ts", "9"], ["d.ts", "4"]]);
    expect(changedSinceReviewed(after, snap).sort()).toEqual(["b.ts", "c.ts", "d.ts"]);
  });
  it("summarizes reviewed / changed layers and counts only unchanged files as reviewed", () => {
    const l = L([["a.ts", "1"], ["b.ts", "2"]]);
    let st = setReviewed({}, l, true, "h1", "2026-01-01T00:00:00Z");
    st = { core: { ...st.core, files: { ...st.core.files, "b.ts": "old" } } };
    const plan = { layers: [l] } as unknown as LayerPlan;
    const s = summarize(plan, st);
    expect([...s.reviewedLayers]).toEqual(["core"]);
    expect([...s.changedLayers]).toEqual(["core"]);
    expect([...s.changedPaths]).toEqual(["b.ts"]);
    expect(s.reviewedFiles).toBe(1);
    expect(setReviewed(st, l, false)).toEqual({});
  });
  it("ignores the old v0.2 boolean format", () => {
    expect(normalizeReviewState({ core: true, x: { at: "t", files: { a: "1" } }, y: null })).toEqual({ x: { at: "t", files: { a: "1" } } });
    expect(normalizeReviewState("nope")).toEqual({});
  });
});

describe("tour card placement", () => {
  const vp = { width: 1000, height: 800 };
  const card = { w: 290, h: 150 };
  it("goes below the target when there is room, clamped horizontally", () => {
    const r = { left: 950, right: 990, top: 100, bottom: 120, width: 40, height: 20 } as DOMRect;
    expect(placeCard(r, card, vp)).toEqual({ left: 1000 - 290 - 12, top: 132 });
  });
  it("flips above when there is no room below", () => {
    const r = { left: 100, right: 300, top: 700, bottom: 720, width: 200, height: 20 } as DOMRect;
    expect(placeCard(r, card, vp).top).toBe(700 - 150 - 12);
  });
  it("centers when there is no target", () => {
    expect(placeCard(null, card, vp)).toEqual({ left: 355, top: 325 });
  });
});

import { currentStep, groupByFolder, progress } from "../src/content/review-logic";
describe("checklist helpers", () => {
  const mk = (id: string, files: [string, string][]): Layer => ({ ...L(files), id });
  const plan = { layers: [mk("a", [["x/1.ts", "1"]]), mk("b", [["y/2.ts", "2"], ["y/3.ts", "3"]])] } as unknown as LayerPlan;
  it("current step is the first not reviewed (or changed since)", () => {
    expect(currentStep(plan, {})).toBe(0);
    const st = setReviewed({}, plan.layers[0], true);
    expect(currentStep(plan, st)).toBe(1);
    const stale = { a: { ...st.a, files: { "x/1.ts": "old" } } };
    expect(currentStep(plan, stale)).toBe(0);
    expect(currentStep(plan, setReviewed(st, plan.layers[1], true))).toBe(-1);
  });
  it("progress text pluralizes and handles all-done", () => {
    expect(progress(plan, {}).text).toBe("Step 1 of 2 · 0 of 3 files reviewed");
    const st = setReviewed(setReviewed({}, plan.layers[0], true), plan.layers[1], true);
    expect(progress(plan, st).text).toBe("All 2 steps reviewed · 3 of 3 files");
    expect(progress(plan, st).ratio).toBe(1);
  });
  it("groups files by folder in first-appearance order", () => {
    const g = groupByFolder([{ path: "a/b/x.py" }, { path: "c/y.py" }, { path: "a/b/z.py" }, { path: "root.md" }]);
    expect(g.map((x) => [x.dir, x.files.map((f) => f.name)])).toEqual([["a/b/", ["x.py", "z.py"]], ["c/", ["y.py"]], ["", ["root.md"]]]);
  });
});
