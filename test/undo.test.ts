import { describe, expect, it } from "vitest";
import type { LayerPlan } from "../src/engine/types";
import { canUndo, clearReview, keepStale, popUndo, pruneUndo, pushUndo, rebaseUndo, setFilesReviewed, UNDO_LIMIT, untickStale, type ReviewState, type UndoEntry } from "../src/content/review-logic";

const F = (path: string, sha: string) => ({ path, sha, status: "modified", additions: 1, deletions: 0, category: "source", reason: "" }) as any;
const plan = (shas: Record<string, string>): LayerPlan =>
  ({
    layers: [
      { id: "core", index: 0, files: [F("a.ts", shas["a.ts"]), F("b.ts", shas["b.ts"])] },
      { id: "tests", index: 1, files: [F("a.test.ts", shas["a.test.ts"])] },
    ],
    edges: [],
    warnings: [],
  }) as unknown as LayerPlan;
const P1 = plan({ "a.ts": "a1", "b.ts": "b1", "a.test.ts": "t1" });

/** Simulate "Mark file as reviewed & next" on `path` at time `t`. */
function mark(state: ReviewState, stack: UndoEntry[], p: LayerPlan, path: string, t: string, viewed = false) {
  const f = p.layers.flatMap((l) => l.files).find((x) => x.path === path)!;
  const s = setFilesReviewed(state, [f], true, "h1", t);
  return { state: s, stack: pushUndo(stack, { path, at: s.files[path].at, viewed }) };
}

describe("← Previous undo stack", () => {
  it("is empty (disabled) at first", () => {
    expect(canUndo([], { v: 2, files: {} })).toBe(false);
    expect(popUndo([], { v: 2, files: {} })).toBeNull();
  });

  it("undoes multiple marks in reverse order, across steps", () => {
    let st: ReviewState = { v: 2, files: {} };
    let stack: UndoEntry[] = [];
    ({ state: st, stack } = mark(st, stack, P1, "a.ts", "t1"));
    ({ state: st, stack } = mark(st, stack, P1, "b.ts", "t2")); // step 1 done
    ({ state: st, stack } = mark(st, stack, P1, "a.test.ts", "t3", true)); // step 2
    expect(canUndo(stack, st)).toBe(true);
    let r = popUndo(stack, st)!;
    expect(r.entry).toEqual({ path: "a.test.ts", at: "t3", viewed: true });
    expect(Object.keys(r.state.files).sort()).toEqual(["a.ts", "b.ts"]);
    r = popUndo(r.stack, r.state)!;
    expect(r.entry.path).toBe("b.ts"); // back into step 1
    r = popUndo(r.stack, r.state)!;
    expect(r.entry.path).toBe("a.ts");
    expect(r.state.files).toEqual({});
    expect(popUndo(r.stack, r.state)).toBeNull();
  });

  it("skips files whose tick is gone (unticked by hand) or was re-made", () => {
    let st: ReviewState = { v: 2, files: {} };
    let stack: UndoEntry[] = [];
    ({ state: st, stack } = mark(st, stack, P1, "a.ts", "t1"));
    ({ state: st, stack } = mark(st, stack, P1, "b.ts", "t2"));
    st = setFilesReviewed(st, [P1.layers[0].files[1]], false); // untick b.ts via checkbox
    expect(pruneUndo(stack, st).map((e) => e.path)).toEqual(["a.ts"]);
    expect(popUndo(stack, st)!.entry.path).toBe("a.ts");
    st = setFilesReviewed(st, [P1.layers[0].files[1]], true, "h1", "t9"); // re-ticked via checkbox: not a mark & next
    expect(pruneUndo(stack, st).map((e) => e.path)).toEqual(["a.ts"]);
  });

  it("a file re-marked later appears once, at the top", () => {
    let st: ReviewState = { v: 2, files: {} };
    let stack: UndoEntry[] = [];
    ({ state: st, stack } = mark(st, stack, P1, "a.ts", "t1"));
    ({ state: st, stack } = mark(st, stack, P1, "b.ts", "t2"));
    ({ state: st, stack } = mark(st, stack, P1, "a.ts", "t3"));
    expect(stack.map((e) => e.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("Restart review clears it", () => {
    let st: ReviewState = { v: 2, files: {} };
    let stack: UndoEntry[] = [];
    ({ state: st, stack } = mark(st, stack, P1, "a.ts", "t1"));
    expect(canUndo(stack, clearReview("h2"))).toBe(false);
    expect(canUndo(stack, st)).toBe(true); // Restart's Undo restores the state, and the stack applies again
  });

  it("after 'Untick changed files' the stale entries are dropped; 'Keep my ticks' keeps them", () => {
    let st: ReviewState = { v: 2, files: {} };
    let stack: UndoEntry[] = [];
    ({ state: st, stack } = mark(st, stack, P1, "a.ts", "t1"));
    ({ state: st, stack } = mark(st, stack, P1, "b.ts", "t2"));
    const P2 = plan({ "a.ts": "a1", "b.ts": "b2", "a.test.ts": "t1" }); // push changed b.ts
    const unticked = untickStale(P2, st, "h2");
    expect(pruneUndo(stack, unticked).map((e) => e.path)).toEqual(["a.ts"]);
    expect(popUndo(stack, unticked)!.entry.path).toBe("a.ts");
    const kept = keepStale(P2, st, "h2", "t5");
    const rebased = rebaseUndo(stack, st, kept);
    expect(rebased.map((e) => [e.path, e.at])).toEqual([["a.ts", "t1"], ["b.ts", "t5"]]);
    expect(popUndo(rebased, kept)!.entry.path).toBe("b.ts");
  });

  it("is capped", () => {
    let stack: UndoEntry[] = [];
    for (let i = 0; i < UNDO_LIMIT + 5; i++) stack = pushUndo(stack, { path: `f${i}`, at: "t", viewed: false });
    expect(stack).toHaveLength(UNDO_LIMIT);
    expect(stack[0].path).toBe("f5");
  });
});
