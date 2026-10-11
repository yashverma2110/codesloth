import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/background/github";
import type { LayerPlan } from "../src/engine/types";
import { clearReview, dismissStale, fileReview, keepStale, normalizeReviewState, progress, reviewedAtHead, setFilesReviewed, staleBannerVisible, staleFiles, staleSummary, untickStale } from "../src/content/review-logic";

const F = (path: string, sha: string) => ({ path, sha, status: "modified", additions: 1, deletions: 0, category: "source", reason: "" }) as any;
const plan = (shas: Record<string, string>): LayerPlan =>
  ({
    layers: [
      { id: "core", index: 0, title: "", label: "", description: "", stats: { files: 2, additions: 2, deletions: 0 }, files: [F("a.ts", shas["a.ts"]), F("b.ts", shas["b.ts"])] },
      { id: "tests", index: 1, title: "", label: "", description: "", stats: { files: 1, additions: 1, deletions: 0 }, files: [F("a.test.ts", shas["a.test.ts"])] },
    ],
    edges: [],
    warnings: [],
  }) as unknown as LayerPlan;

const OLD = "1111111";
const NEW = "2222222";
const before = plan({ "a.ts": "a1", "b.ts": "b1", "a.test.ts": "t1" });
const after = plan({ "a.ts": "a2", "b.ts": "b1", "a.test.ts": "t2" }); // a.ts and a.test.ts changed in the new push
const reviewed = setFilesReviewed(setFilesReviewed({ v: 2, files: {} }, before.layers[0].files, true, OLD, "2026-10-10T10:00:00Z"), before.layers[1].files, true, OLD, "2026-10-10T10:05:00Z");

describe("stale reviews", () => {
  it("files whose fingerprint changed are stale: ticks kept, not counted as reviewed", () => {
    expect(staleFiles(after, reviewed).map((f) => f.path)).toEqual(["a.ts", "a.test.ts"]);
    expect(fileReview(reviewed, after.layers[0].files[0])).toBe("changed");
    expect(Object.keys(reviewed.files)).toHaveLength(3); // nothing auto-unticked
    expect(progress(after, reviewed).text).toBe("Step 1 of 2 · 1 of 3 files reviewed · 2 stale");
    expect(progress(before, reviewed).stale).toBe(0);
    expect(reviewedAtHead(reviewed, ["a.ts", "a.test.ts"])).toBe(OLD);
  });

  it("banner shows once per head: dismiss/untick/keep acknowledge it; a new push brings it back", () => {
    expect(staleBannerVisible(after, reviewed, NEW)).toBe(true);
    const dismissed = dismissStale(reviewed, NEW);
    expect(staleBannerVisible(after, dismissed, NEW)).toBe(false);
    expect(staleFiles(after, dismissed)).toHaveLength(2); // rows stay amber
    // persisted through storage round-trip
    expect(staleBannerVisible(after, normalizeReviewState(JSON.parse(JSON.stringify(dismissed))), NEW)).toBe(false);
    // another push changes a file again -> new head, banner back
    const later = plan({ "a.ts": "a3", "b.ts": "b1", "a.test.ts": "t2" });
    expect(staleBannerVisible(later, dismissed, "3333333")).toBe(true);
    // no stale files -> no banner even for a new head
    expect(staleBannerVisible(before, reviewed, NEW)).toBe(false);
  });

  it("Untick changed files removes only the stale ticks; Keep my ticks re-fingerprints them", () => {
    const u = untickStale(after, reviewed, NEW);
    expect(Object.keys(u.files)).toEqual(["b.ts"]);
    expect(u.ack).toBe(NEW);
    const k = keepStale(after, reviewed, NEW, "2026-10-11T00:00:00Z");
    expect(staleFiles(after, k)).toEqual([]);
    expect(k.files["a.ts"]).toEqual({ sha: "a2", at: "2026-10-11T00:00:00Z", headSha: NEW });
    expect(k.files["b.ts"].headSha).toBe(OLD);
    expect(progress(after, k).text).toBe("All 3 files reviewed");
  });

  it("says how many new commits from the commit story, else the compare API; detects force-pushes", () => {
    const history = {
      commits: [{ sha: "0000000", message: "c0" }, { sha: OLD, message: "c1" }, { sha: "aaaaaaa", message: "fix a" }, { sha: NEW, message: "tests" }],
      files: { "a.ts": [{ c: 0 }, { c: 2 }], "a.test.ts": [{ c: 3 }], "b.ts": [{ c: 1 }] },
    };
    const s1 = staleSummary(after, reviewed, history, null);
    expect(s1.text).toBe("2 new commits changed 2 files you reviewed.");
    expect(s1.files).toEqual([{ path: "a.ts", commits: ["fix a"] }, { path: "a.test.ts", commits: ["tests"] }]);
    expect(staleSummary(after, reviewed, null, { status: "ahead", aheadBy: 5 }).text).toBe("5 new commits changed 2 files you reviewed.");
    // force-push: the old head isn't an ancestor any more (diverged) or is gone (404) -> fingerprints still decide
    const fp = staleSummary(after, reviewed, null, { status: "diverged", aheadBy: 3 });
    expect(fp.forcePushed).toBe(true);
    expect(fp.text).toBe("The PR was force-pushed; 2 files you reviewed changed.");
    expect(staleSummary(after, reviewed, null, { status: "missing", aheadBy: 0 }).text).toMatch(/force-pushed/);
    expect(staleSummary(after, reviewed, null, null).text).toBe("New commits changed 2 files you reviewed.");
    const one = setFilesReviewed(reviewed, [before.layers[1].files[0]], false);
    expect(staleSummary(after, one, null, { status: "ahead", aheadBy: 1 }).text).toBe("1 new commit changed 1 file you reviewed.");
  });

  it("Restart review clears every tick and stale state", () => {
    const c = clearReview(NEW);
    expect(c.files).toEqual({});
    expect(staleFiles(after, c)).toEqual([]);
    expect(progress(after, c).text).toBe("Step 1 of 2 · 0 of 3 files reviewed");
  });
});

describe("compare API (read-only)", () => {
  const mk = (status: number, body: unknown) => {
    const urls: string[] = [];
    const methods: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      methods.push(String(init?.method));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4000" } });
    }) as unknown as typeof fetch;
    return { c: new GitHubClient(async () => "t", f), urls, methods };
  };
  it("returns status/ahead_by; 404 (old SHA gone after force-push) is 'missing'", async () => {
    const a = mk(200, { status: "ahead", ahead_by: 2, files: [] });
    expect(await a.c.compare({ owner: "o", repo: "r", number: 1 }, OLD, NEW)).toEqual({ status: "ahead", aheadBy: 2 });
    expect(a.urls[0]).toBe(`https://api.github.com/repos/o/r/compare/${OLD}...${NEW}?per_page=1`);
    expect(a.methods).toEqual(["GET"]);
    expect(await mk(200, { status: "diverged", ahead_by: 3 }).c.compare({ owner: "o", repo: "r", number: 1 }, OLD, NEW)).toEqual({ status: "diverged", aheadBy: 3 });
    expect(await mk(404, { message: "Not Found" }).c.compare({ owner: "o", repo: "r", number: 1 }, OLD, NEW)).toEqual({ status: "missing", aheadBy: 0 });
  });
});
