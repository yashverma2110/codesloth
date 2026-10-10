import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, pool } from "../src/background/github";

type Call = { url: string; init?: RequestInit };
function mockFetch(handler: (url: string) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1", ...headers } });
const pr = { owner: "o", repo: "r", number: 1 };

describe("GitHubClient", () => {
  it("paginates PR files until there is no next link and only uses GET with the bearer token", async () => {
    const { f, calls } = mockFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const n = page < 3 ? 100 : 7;
      const files = Array.from({ length: n }, (_, i) => ({ filename: `f${page}-${i}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1, sha: "s" }));
      return json(files, page < 3 ? { link: `<x?page=${page + 1}>; rel="next"` } : {});
    });
    const c = new GitHubClient(async () => "github_pat_x", f);
    const { files, truncated } = await c.listFiles(pr);
    expect(files).toHaveLength(207);
    expect(truncated).toBe(false);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer github_pat_x");
    }
    expect(c.rate?.remaining).toBe(4999);
  });

  it("stops at GitHub's 3000-file cap and reports truncation", async () => {
    const { f, calls } = mockFetch(() => json(Array.from({ length: 100 }, () => ({ filename: "x" })), { link: '<x>; rel="next"' }));
    const r = await new GitHubClient(async () => "t", f).listFiles(pr);
    expect(r.files).toHaveLength(3000);
    expect(r.truncated).toBe(true);
    expect(calls).toHaveLength(30);
  });

  it("throws a rate-limit error with reset time when the primary limit is exhausted", async () => {
    const { f } = mockFetch(() => json({ message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" }, 403));
    await expect(new GitHubClient(async () => "t", f).getPR(pr)).rejects.toMatchObject({ code: "rate_limited", resetAt: 2_000_000_000_000 });
  });

  it("maps 404 to an access hint and 401 to unauthorized", async () => {
    const c404 = new GitHubClient(async () => "t", mockFetch(() => json({}, {}, 404)).f);
    await expect(c404.getPR(pr)).rejects.toBeInstanceOf(GitHubError);
    await expect(c404.getPR(pr)).rejects.toMatchObject({ code: "not_found" });
    const c401 = new GitHubClient(async () => "t", mockFetch(() => json({}, {}, 401)).f);
    await expect(c401.getPR(pr)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("returns not-modified on 304 with If-None-Match", async () => {
    const { f, calls } = mockFetch(() => new Response(null, { status: 304 }));
    expect(await new GitHubClient(async () => "t", f).getPR(pr, '"etag1"')).toBe("not-modified");
    expect((calls[0].init?.headers as Record<string, string>)["If-None-Match"]).toBe('"etag1"');
  });

  it("getRaw returns undefined for 404 and encodes paths", async () => {
    const { f, calls } = mockFetch(() => json({}, {}, 404));
    expect(await new GitHubClient(async () => "t", f).getRaw(pr, "src/a b.ts", "abc")).toBeUndefined();
    expect(calls[0].url).toContain("/contents/src/a%20b.ts?ref=abc");
  });

  it("pool limits concurrency", async () => {
    let active = 0, max = 0;
    await pool([...Array(20).keys()], 4, async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    });
    expect(max).toBe(4);
  });
});
