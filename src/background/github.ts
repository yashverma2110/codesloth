import config from "../../config/extension.config.json";
import type { PRFile } from "../engine/types";
import type { PRMeta, PRRef } from "../shared/messages";

const API = "https://api.github.com";
export const MAX_PR_FILES = 3000; // documented cap of GET /pulls/{n}/files

export class GitHubError extends Error {
  constructor(message: string, public status: number, public code: string, public resetAt?: number) {
    super(message);
  }
}

export interface RateInfo {
  remaining: number;
  limit: number;
  reset: number;
}

export type TokenProvider = () => Promise<string | null>;

export class GitHubClient {
  rate?: RateInfo;
  constructor(private token: TokenProvider, private fetchImpl: typeof fetch = fetch.bind(globalThis)) {}

  private async request(path: string, opts: { accept?: string; etag?: string; allow404?: boolean } = {}, attempt = 0): Promise<Response> {
    const token = await this.token();
    const headers: Record<string, string> = {
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": config.apiVersion,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    // Read-only by construction: this client only ever issues GET requests.
    const res = await this.fetchImpl(API + path, { method: "GET", headers, cache: "no-store", credentials: "omit" });
    const rem = res.headers.get("x-ratelimit-remaining");
    if (rem !== null) {
      this.rate = {
        remaining: Number(rem),
        limit: Number(res.headers.get("x-ratelimit-limit") ?? 0),
        reset: Number(res.headers.get("x-ratelimit-reset") ?? 0),
      };
    }
    if (res.ok || res.status === 304) return res;
    if (res.status === 404 && opts.allow404) return res;

    // Rate limiting: primary (remaining=0) or secondary (retry-after / abuse message).
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      if (rem === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
        throw new GitHubError(`GitHub API rate limit exhausted; resets at ${new Date(reset).toLocaleTimeString()}.`, res.status, "rate_limited", reset);
      }
      if ((retryAfter || res.status === 429) && attempt < 2) {
        await sleep(Math.min((retryAfter || 5) * 1000, 60_000) * (attempt + 1));
        return this.request(path, opts, attempt + 1);
      }
      const body = await safeJson(res);
      if (/secondary rate limit/i.test(body?.message ?? "")) {
        throw new GitHubError("GitHub secondary rate limit hit; wait a minute and retry.", res.status, "secondary_rate_limited");
      }
      if (res.headers.get("x-github-sso")) {
        throw new GitHubError("This organization requires SAML SSO: authorize your token for the org (Settings → Developer settings → Tokens → Configure SSO).", res.status, "sso_required");
      }
      throw new GitHubError(body?.message ?? `Forbidden (${res.status})`, res.status, "forbidden");
    }
    if (res.status === 401) throw new GitHubError("Token rejected (401). Check that it hasn't expired or been revoked.", 401, "unauthorized");
    if (res.status === 404)
      throw new GitHubError("Not found (404). For private repos the token needs access to this repository (and Pull requests: Read).", 404, "not_found");
    if (res.status >= 500 && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return this.request(path, opts, attempt + 1);
    }
    const body = await safeJson(res);
    throw new GitHubError(body?.message ?? `GitHub API error ${res.status}`, res.status, "http_error");
  }

  async getUser(): Promise<{ login: string }> {
    return (await this.request("/user")).json();
  }

  /** Raw GET used for token validation: never throws on HTTP errors, returns status + relevant headers. */
  async probe(path: string, tokenOverride?: string): Promise<{ status: number; headers: Headers; json?: any }> {
    const token = tokenOverride ?? (await this.token());
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": config.apiVersion };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await this.fetchImpl(API + path, { method: "GET", headers, cache: "no-store", credentials: "omit" });
    let json: any;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, json };
  }

  async getPR(pr: PRRef, etag?: string): Promise<{ meta: PRMeta; etag?: string } | "not-modified"> {
    const res = await this.request(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { etag });
    if (res.status === 304) return "not-modified";
    const j = await res.json();
    return {
      etag: res.headers.get("etag") ?? undefined,
      meta: {
        title: j.title,
        headSha: j.head.sha,
        baseSha: j.base.sha,
        changedFiles: j.changed_files,
        additions: j.additions,
        deletions: j.deletions,
        htmlUrl: j.html_url,
        state: j.merged_at ? "merged" : j.state,
      },
    };
  }

  /** All changed files, paginated at 100/page up to GitHub's 3000-file cap. */
  async listFiles(pr: PRRef, onPage?: (n: number) => void): Promise<{ files: PRFile[]; truncated: boolean }> {
    const files: PRFile[] = [];
    for (let page = 1; page <= MAX_PR_FILES / 100; page++) {
      const res = await this.request(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`);
      const batch = (await res.json()) as PRFile[];
      files.push(...batch);
      onPage?.(files.length);
      const hasNext = /rel="next"/.test(res.headers.get("link") ?? "");
      if (!hasNext || batch.length < 100) return { files, truncated: false };
    }
    return { files, truncated: true };
  }

  /** Raw file contents at a ref, or undefined if missing / too large. */
  async getRaw(pr: PRRef, path: string, ref: string): Promise<string | undefined> {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.request(`/repos/${pr.owner}/${pr.repo}/contents/${enc}?ref=${ref}`, { accept: "application/vnd.github.raw+json", allow404: true });
    if (res.status === 404) return undefined;
    const text = await res.text();
    return text.length > config.maxFileBytesForContents ? undefined : text;
  }
}

/** Run async tasks with bounded concurrency (keeps us well under GitHub's 100-concurrent-request secondary limit). */
export async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function safeJson(res: Response): Promise<{ message?: string } | undefined> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
