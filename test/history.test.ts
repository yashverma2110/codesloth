import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/background/github";
import { fetchHistory, QUOTA_RESERVE } from "../src/background/history-fetch";
import { buildHistory, capNote, fileStory, HISTORY_SOFT_CAP, initials, looksLikeAfterReview, pickCommits, relTime, stepCommits, storyActive, type RawCommit, type RawCommitFile } from "../src/shared/history";

const C = (sha: string, message: string, date: string, extra: Partial<RawCommit> = {}): RawCommit => ({
  sha,
  commit: { message, author: { name: "Yash Verma", date } },
  author: { login: "yashverma2110" },
  parents: [{ sha: "p" }],
  ...extra,
});
const F = (filename: string, additions = 1, deletions = 0, extra: Partial<RawCommitFile> = {}): RawCommitFile => ({ filename, additions, deletions, status: "modified", ...extra });

describe("commit history building", () => {
  const commits = [
    C("c1", "feat(quota): add versioned quota allocation API\n\nlong body", "2026-10-09T11:19:00Z"),
    C("c2", "feat(quota): validate allocation SKU values", "2026-10-09T11:22:16Z"),
    C("c3", "docs: align sqlc generation instructions", "2026-10-09T11:32:02Z"),
    C("c4", "refactor(quota): rename period kind to interval", "2026-10-11T10:11:29Z"),
  ];
  const files: Record<string, RawCommitFile[]> = {
    c1: [F("repository/quota_allocation.go", 177), F("repository/database.go", 55, 6), F("unrelated/gone.go", 3)],
    c2: [F("repository/quota_allocation.go", 3, 3)],
    c3: [F("README.md", 1, 1)],
    c4: [F("repository/quota_allocation.go", 25, 25)],
  };
  const paths = ["repository/quota_allocation.go", "repository/database.go", "README.md"];
  const h = buildHistory(commits, (s) => files[s], paths);

  it("keeps commits oldest -> newest with first-line messages, authors and initials", () => {
    expect(h.commits.map((c) => c.message)).toEqual(["feat(quota): add versioned quota allocation API", "feat(quota): validate allocation SKU values", "docs: align sqlc generation instructions", "refactor(quota): rename period kind to interval"]);
    expect(h.commits[0]).toMatchObject({ login: "yashverma2110", name: "Yash Verma", initials: "YV", date: "2026-10-09T11:19:00Z" });
    expect(h.totalCommits).toBe(4);
    expect(h.notes).toEqual([]);
  });
  it("records per-file touches with that commit's +/- and ignores files not in the PR", () => {
    expect(h.files["repository/quota_allocation.go"]).toEqual([
      { c: 0, additions: 177, deletions: 0 },
      { c: 1, additions: 3, deletions: 3 },
      { c: 3, additions: 25, deletions: 25 },
    ]);
    expect(h.files["repository/database.go"]).toEqual([{ c: 0, additions: 55, deletions: 6 }]);
    expect(Object.keys(h.files)).not.toContain("unrelated/gone.go");
  });
  it("step line counts distinct commits", () => {
    expect(stepCommits(h, ["repository/quota_allocation.go", "repository/database.go"])).toEqual([0, 1, 3]);
  });
  it("follows renames backwards so history stays with the file", () => {
    const hh = buildHistory(
      [C("a", "add", "2026-01-01T00:00:00Z"), C("b", "tweak", "2026-01-02T00:00:00Z"), C("c", "move", "2026-01-03T00:00:00Z"), C("d", "edit", "2026-01-04T00:00:00Z")],
      (s) => ({ a: [F("old/x.ts", 10)], b: [F("old/x.ts", 2, 1)], c: [F("new/x.ts", 0, 0, { status: "renamed", previous_filename: "old/x.ts" })], d: [F("new/x.ts", 4, 4), F("old/x.ts", 9, 0, { status: "added" })] })[s],
      ["new/x.ts", "old/x.ts"],
    );
    expect(hh.files["new/x.ts"].map((t) => [t.c, t.as ?? ""])).toEqual([[0, "old/x.ts"], [1, "old/x.ts"], [2, ""], [3, ""]]);
    // a *new* old/x.ts added after the rename is a different file
    expect(hh.files["old/x.ts"].map((t) => t.c)).toEqual([3]);
  });
  it("skips merge commits (their diff is mostly the base branch)", () => {
    const hh = buildHistory([C("a", "add", "2026-01-01T00:00:00Z"), C("m", "Merge branch 'main'", "2026-01-02T00:00:00Z", { parents: [{ sha: "1" }, { sha: "2" }] }), C("b", "fix", "2026-01-03T00:00:00Z")], (s) => ({ a: [F("x.ts")], m: [F("x.ts", 50)], b: [F("x.ts")] })[s], ["x.ts"]);
    expect(hh.commits[1].merge).toBe(true);
    expect(hh.files["x.ts"].map((t) => t.c)).toEqual([0, 2]);
    expect(fileStory(hh, "x.ts").touches.at(-1)!.newest).toBe(true);
  });
});

describe("signals", () => {
  it("After review: fixup/squash/address comments/review feedback/nit/PR feedback, case-insensitive", () => {
    for (const m of ["fixup! feat: x", "squash! wip", "Address review comments", "addressed comments", "address PR comments", "Review feedback", "PR feedback", "nit: rename", "fix nits", "Addressing feedback"])
      expect(looksLikeAfterReview(m), m).toBe(true);
    for (const m of ["feat(quota): add versioned quota allocation API", "init project", "unit tests", "refactor(quota): rename period kind to interval", "Add address field", "review page layout"])
      expect(looksLikeAfterReview(m), m).toBe(false);
  });
  it("Late change only for a file touched only in the newest commit, multi-commit, complete history", () => {
    const commits = [C("a", "add", "2026-01-01T00:00:00Z"), C("b", "Address review comments", "2026-01-02T00:00:00Z")];
    const h = buildHistory(commits, (s) => ({ a: [F("x.ts")], b: [F("x.ts"), F("late.ts")] })[s], ["x.ts", "late.ts"]);
    expect(fileStory(h, "late.ts").lateChange).toBe(true);
    expect(fileStory(h, "x.ts").lateChange).toBe(false);
    expect(fileStory(h, "x.ts").afterReview).toBe(true);
    expect(fileStory(h, "x.ts").touches.map((t) => t.afterReview)).toEqual([false, true]);
    const capped = { ...h, totalCommits: 5 };
    expect(fileStory(capped, "late.ts").lateChange).toBe(false); // older commits weren't fetched
    const single = buildHistory([commits[0]], () => [F("x.ts")], ["x.ts"]);
    expect(storyActive(single)).toBe(false);
    expect(fileStory(single, "x.ts").lateChange).toBe(false);
  });
});

describe("caps, helpers", () => {
  it("soft cap keeps the latest 100 and explains it", () => {
    const list = Array.from({ length: 180 }, (_, i) => i);
    expect(pickCommits(list)).toEqual(list.slice(80));
    expect(pickCommits(list).length).toBe(HISTORY_SOFT_CAP);
    expect(capNote(180, 180, 100)).toBe("Showing the latest 100 of 180 commits");
    expect(capNote(400, 250, 100)).toBe("GitHub lists only 250 of this PR's 400 commits; showing 100 of those");
    expect(capNote(4, 4, 4)).toBeNull();
  });
  it("initials and relative time", () => {
    expect(initials("Yash Verma", "yashverma2110")).toBe("YV");
    expect(initials("Sebastián Ramírez", "tiangolo")).toBe("SR");
    expect(initials(undefined, "dependabot[bot]")).toBe("DE");
    expect(initials("", "")).toBe("?");
    const now = Date.parse("2026-10-11T10:19:00Z");
    expect(relTime("2026-10-11T10:11:29Z", now)).toBe("8 min ago");
    expect(relTime("2026-10-09T11:19:00Z", now)).toBe("2 days ago");
    expect(relTime("2026-10-11T10:18:50Z", now)).toBe("just now");
    expect(relTime("2026-10-11T06:00:00Z", now)).toBe("4 h ago");
    expect(relTime("2026-09-01T00:00:00Z", now)).toBe("6 weeks ago");
    expect(relTime("nope", now)).toBe("");
  });
});

describe("fetchHistory (read-only GETs)", () => {
  const json = (body: unknown, headers: Record<string, string> = {}, remaining = "4000") =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": remaining, "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1", ...headers } });
  const pr = { owner: "o", repo: "r", number: 2 };
  function client(nCommits: number, remaining = "4000") {
    const urls: string[] = [];
    const methods: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      methods.push(String(init?.method));
      const u = new URL(url);
      const page = Number(u.searchParams.get("page") ?? 1);
      if (u.pathname.endsWith("/pulls/2/commits")) {
        const all = Array.from({ length: Math.min(nCommits, 250) }, (_, i) => C(`s${i}`, `commit ${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`));
        const batch = all.slice((page - 1) * 100, page * 100);
        return json(batch, page * 100 < all.length ? { link: '<x>; rel="next"' } : {}, remaining);
      }
      const m = /\/commits\/(s\d+)$/.exec(u.pathname);
      if (m) {
        // two pages of files for s0, one page otherwise
        if (m[1] === "s0" && page === 1) return json({ files: [F("a.ts")] }, { link: '<x>; rel="next"' }, remaining);
        if (m[1] === "s0") return json({ files: [F("b.ts")] }, {}, remaining);
        return json({ files: [F("a.ts")] }, {}, remaining);
      }
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    return { c: new GitHubClient(async () => "t", f), urls, methods };
  }
  it("lists commits, fetches each commit's files (paginated), only with GET", async () => {
    const { c, urls, methods } = client(3);
    const h = await fetchHistory(c, pr, ["a.ts", "b.ts"], { totalCommits: 3 });
    expect(h.commits).toHaveLength(3);
    expect(h.files["a.ts"].map((t) => t.c)).toEqual([0, 1, 2]);
    expect(h.files["b.ts"].map((t) => t.c)).toEqual([0]);
    expect(urls.filter((u) => /\/commits\/s0/.test(u))).toHaveLength(2);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });
  it("caps at GitHub's 250 listed and fetches files for the latest 100 only", async () => {
    const { c, urls } = client(400);
    const h = await fetchHistory(c, pr, ["a.ts"], { totalCommits: 400 });
    expect(urls.filter((u) => u.includes("/pulls/2/commits"))).toHaveLength(3);
    expect(urls.filter((u) => /\/commits\/s\d+/.test(u))).toHaveLength(100);
    expect(h.commits[0].sha).toBe("s150");
    expect(h.notes[0]).toMatch(/only 250 of this PR's 400/);
  });
  it("one-commit PRs skip the per-commit request; low quota skips the story", async () => {
    const one = client(1);
    const h = await fetchHistory(one.c, pr, ["a.ts"]);
    expect(storyActive(h)).toBe(false);
    expect(one.urls).toHaveLength(1);
    const low = client(5, String(QUOTA_RESERVE));
    await expect(fetchHistory(low.c, pr, ["a.ts"])).rejects.toThrow(/save API quota/);
  });
});
