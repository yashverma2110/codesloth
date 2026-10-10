import type { PRRef } from "./messages";

const RESERVED_OWNERS = new Set(["orgs", "settings", "marketplace", "notifications", "explore", "topics", "sponsors", "apps", "login", "search"]);

/** Parse https://github.com/{owner}/{repo}/pull/{n}[/files|/changes|/commits...] */
export function parsePrUrl(url: string | undefined): PRRef | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "github.com") return null;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(u.pathname);
  if (!m || RESERVED_OWNERS.has(m[1])) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export const prKey = (p: PRRef) => `${p.owner}/${p.repo}#${p.number}`;

/** GitHub's per-file diff anchor: "diff-" + hex SHA-256 of the file path. */
export async function diffAnchor(path: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return "diff-" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
