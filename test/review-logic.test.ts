import { describe, expect, it } from "vitest";
import { allFiles, ctaTarget, currentStep, emptyReview, fileReview, groupByFolder, isLastUnreviewed, layerReview, locate, nextUnreviewed, normalizeReviewState, progress, setFilesReviewed, summarize } from "../src/content/review-logic";
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

describe("per-file review state", () => {
  const plan = (layers: Layer[]) => ({ layers }) as unknown as LayerPlan;
  it("marks files with their blob SHA and flags content changed since", () => {
    const l = L([["a.ts", "1"], ["b.ts", "2"]]);
    let st = setFilesReviewed(emptyReview(), l.files, true, "h1", "2026-01-01T00:00:00Z");
    expect(st.files["a.ts"]).toEqual({ sha: "1", at: "2026-01-01T00:00:00Z", headSha: "h1" });
    expect(layerReview(l, st)).toEqual({ state: "done", reviewed: 2, changed: [] });
    const after = L([["a.ts", "1"], ["b.ts", "9"], ["c.ts", "3"]]);
    expect(fileReview(st, after.files[1])).toBe("changed");
    expect(fileReview(st, after.files[2])).toBe("none");
    expect(layerReview(after, st)).toEqual({ state: "partial", reviewed: 1, changed: ["b.ts"] });
    const s = summarize(plan([after]), st);
    expect([...s.reviewedLayers]).toEqual([]);
    expect([...s.changedLayers]).toEqual(["core"]);
    expect([...s.changedPaths]).toEqual(["b.ts"]);
    expect([...s.reviewedPaths]).toEqual(["a.ts"]);
    expect(s.reviewedFiles).toBe(1);
    st = setFilesReviewed(st, [l.files[0]], false);
    expect(Object.keys(st.files)).toEqual(["b.ts"]);
  });
  it("migrates v0.3/v0.4 per-layer snapshots and drops junk", () => {
    expect(normalizeReviewState({ core: true, x: { at: "t", headSha: "h", files: { a: "1", b: null } }, y: null })).toEqual({
      v: 2,
      files: { a: { sha: "1", at: "t", headSha: "h" }, b: { sha: null, at: "t", headSha: "h" } },
    });
    expect(normalizeReviewState({ v: 2, files: { a: { sha: "1", at: "t" }, b: { sha: 3, at: "t" } } })).toEqual({ v: 2, files: { a: { sha: "1", at: "t" } } });
    expect(normalizeReviewState("nope")).toEqual(emptyReview());
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

describe("checklist helpers", () => {
  const mk = (id: string, files: [string, string][]): Layer => ({ ...L(files), id });
  const plan = { layers: [mk("a", [["x/1.ts", "1"]]), mk("b", [["y/2.ts", "2"], ["y/3.ts", "3"], ["y/4.ts", "4"]])] } as unknown as LayerPlan;
  const [A, B] = plan.layers;
  it("current step is the first with an unreviewed or changed file", () => {
    expect(currentStep(plan, emptyReview())).toBe(0);
    const st = setFilesReviewed(emptyReview(), A.files, true);
    expect(currentStep(plan, st)).toBe(1);
    expect(currentStep(plan, setFilesReviewed(st, [{ path: "x/1.ts", sha: "old" }], true))).toBe(0);
    expect(currentStep(plan, setFilesReviewed(st, B.files, true))).toBe(-1);
  });
  it("progress counts files and ends with 'All N files reviewed'", () => {
    expect(progress(plan, emptyReview()).text).toBe("Step 1 of 2 · 0 of 4 files reviewed");
    expect(progress(plan, setFilesReviewed(emptyReview(), [B.files[0]], true)).text).toBe("Step 1 of 2 · 1 of 4 files reviewed");
    const all = setFilesReviewed(setFilesReviewed(emptyReview(), A.files, true), B.files, true);
    expect(progress(plan, all).text).toBe("All 4 files reviewed");
    expect(progress(plan, all).ratio).toBe(1);
  });
  it("CTA target is the selected unreviewed file, else the step's first unreviewed", () => {
    let st = setFilesReviewed(emptyReview(), [B.files[0]], true);
    expect(ctaTarget(plan, st, 1, null)?.path).toBe("y/3.ts");
    expect(ctaTarget(plan, st, 1, "y/4.ts")?.path).toBe("y/4.ts");
    expect(ctaTarget(plan, st, 1, "y/2.ts")?.path).toBe("y/3.ts"); // selected but already reviewed
    expect(ctaTarget(plan, st, 1, "x/1.ts")?.path).toBe("y/3.ts"); // selection in another step
    st = setFilesReviewed(st, B.files, true);
    expect(ctaTarget(plan, st, 1, null)).toBeNull();
  });
  it("next file: same step (wrapping), then the next step with unreviewed files, then null", () => {
    let st = setFilesReviewed(emptyReview(), [B.files[1]], true);
    expect(nextUnreviewed(plan, st, { layer: 1, file: 1, path: "y/3.ts" })?.path).toBe("y/4.ts");
    st = setFilesReviewed(st, [B.files[2]], true);
    expect(nextUnreviewed(plan, st, { layer: 1, file: 2, path: "y/4.ts" })?.path).toBe("y/2.ts"); // wraps within the step
    st = setFilesReviewed(st, [B.files[0]], true);
    expect(nextUnreviewed(plan, st, { layer: 1, file: 0, path: "y/2.ts" })).toEqual({ layer: 0, file: 0, path: "x/1.ts" });
    expect(isLastUnreviewed(plan, st, "x/1.ts")).toBe(true);
    st = setFilesReviewed(st, A.files, true);
    expect(nextUnreviewed(plan, st, { layer: 0, file: 0, path: "x/1.ts" })).toBeNull();
    expect(allFiles(plan).map((f) => f.path)).toEqual(["x/1.ts", "y/2.ts", "y/3.ts", "y/4.ts"]);
    expect(locate(plan, "y/3.ts")).toEqual({ layer: 1, file: 1, path: "y/3.ts" });
  });
  it("groups files by folder in first-appearance order", () => {
    const g = groupByFolder([{ path: "a/b/x.py" }, { path: "c/y.py" }, { path: "a/b/z.py" }, { path: "root.md" }]);
    expect(g.map((x) => [x.dir, x.files.map((f) => f.name)])).toEqual([["a/b/", ["x.py", "z.py"]], ["c/", ["y.py"]], ["", ["root.md"]]]);
  });
});
