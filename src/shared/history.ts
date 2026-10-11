/**
 * Commit story: per-file commit history for a PR, built from read-only GETs
 * (GET /pulls/{n}/commits and GET /commits/{sha}). Pure; unit-tested.
 */

/** GitHub lists at most 250 commits for a PR (GET /pulls/{n}/commits). */
export const MAX_LISTED_COMMITS = 250;
/** Soft cap on commits we fetch file lists for (one request each). */
export const HISTORY_SOFT_CAP = 100;

export interface CommitInfo {
  sha: string;
  /** First line of the commit message. */
  message: string;
  login?: string;
  name?: string;
  initials: string;
  /** Author date, ISO 8601. */
  date: string;
  /** Merge commit (e.g. base branch merged in): not counted as touching files. */
  merge?: true;
}

export interface FileTouch {
  /** Index into CommitHistory.commits. */
  c: number;
  additions: number;
  deletions: number;
  /** The file's path in that commit, if different (renamed later). */
  as?: string;
}

export interface CommitHistory {
  version: 1;
  /** Commits in the PR (GitHub's count; may be more than GitHub would list). */
  totalCommits: number;
  /** Commits included, oldest -> newest (the latest ones when capped). */
  commits: CommitInfo[];
  /** PR file path (as in the final diff) -> commits that touched it, oldest -> newest. */
  files: Record<string, FileTouch[]>;
  /** Human-readable notes, e.g. "Showing the latest 100 of 312 commits". */
  notes: string[];
}

/** Subset of GET /pulls/{n}/commits items we use. */
export interface RawCommit {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } | null; committer?: { date?: string } | null };
  author?: { login?: string } | null;
  parents?: { sha: string }[];
}

export const isMerge = (c: Pick<RawCommit, "parents">) => (c.parents?.length ?? 0) > 1;

/** Subset of GET /commits/{sha} `files` items we use. */
export interface RawCommitFile {
  filename: string;
  status?: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
}

export function initials(name?: string, login?: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length >= 2) return (first(words[0]) + first(words[words.length - 1])).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (login ?? "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?";
}
const first = (w: string) => [...w.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "";

/** Which commits to fetch file lists for: the latest `cap` of those listed. */
export function pickCommits<T>(listed: readonly T[], cap = HISTORY_SOFT_CAP): T[] {
  return listed.length > cap ? listed.slice(listed.length - cap) : [...listed];
}

export function capNote(totalCommits: number, listed: number, shown: number): string | null {
  if (totalCommits > listed && listed >= MAX_LISTED_COMMITS) return `GitHub lists only ${listed} of this PR's ${totalCommits} commits; showing ${shown} of those`;
  if (shown < totalCommits) return `Showing the latest ${shown} of ${totalCommits} commits`;
  return null;
}

/**
 * Build per-file history. `commits` oldest -> newest; `filesOf` gives each commit's changed files.
 * Renames are followed backwards from the final paths, so a file renamed a.ts -> b.ts in commit 3
 * keeps the touches from commits 1-2 made to a.ts.
 */
export function buildHistory(commits: readonly RawCommit[], filesOf: (sha: string) => readonly RawCommitFile[] | undefined, prPaths: readonly string[], totalCommits = commits.length, listed = commits.length): CommitHistory {
  const infos: CommitInfo[] = commits.map((c) => {
    const name = c.commit.author?.name ?? undefined;
    const login = c.author?.login ?? undefined;
    return {
      sha: c.sha,
      message: (c.commit.message ?? "").split("\n")[0].trim(),
      ...(login ? { login } : {}),
      ...(name ? { name } : {}),
      initials: initials(name, login),
      date: c.commit.author?.date ?? c.commit.committer?.date ?? "",
      ...(isMerge(c) ? { merge: true as const } : {}),
    };
  });
  // current name (at the point in history we're walking) -> final PR path
  const alias = new Map<string, string>(prPaths.map((p) => [p, p]));
  const touches = new Map<string, FileTouch[]>();
  for (let i = commits.length - 1; i >= 0; i--) {
    // A merge commit's diff (against its first parent) is mostly the base branch's changes: skip it.
    if (isMerge(commits[i])) continue;
    for (const f of filesOf(commits[i].sha) ?? []) {
      const final = alias.get(f.filename);
      if (final === undefined) continue;
      const t: FileTouch = { c: i, additions: f.additions, deletions: f.deletions, ...(f.filename !== final ? { as: f.filename } : {}) };
      (touches.get(final) ?? touches.set(final, []).get(final)!).unshift(t);
      if (f.status === "renamed" && f.previous_filename && f.previous_filename !== f.filename) {
        alias.delete(f.filename);
        alias.set(f.previous_filename, final);
      }
    }
  }
  const files: Record<string, FileTouch[]> = {};
  for (const p of prPaths) files[p] = touches.get(p) ?? [];
  const note = capNote(totalCommits, listed, commits.length);
  return { version: 1, totalCommits, commits: infos, files, notes: note ? [note] : [] };
}

/** Commit messages that look like review follow-ups. */
export const AFTER_REVIEW_RE = /^(?:fixup!|squash!|amend!)|\baddress(?:ed|es|ing)?\s+(?:the\s+|all\s+)?(?:pr\s+|code\s+)?(?:review\s+)?(?:comments?|feedback)\b|\b(?:review|pr)\s+(?:feedback|comments?)\b|\bnits?\b/i;

export function looksLikeAfterReview(message: string): boolean {
  return AFTER_REVIEW_RE.test(message);
}

/** Has the story anything to tell? Single-commit PRs hide the whole feature. */
export function storyActive(h: CommitHistory | null | undefined): h is CommitHistory {
  return !!h && h.totalCommits > 1 && authored(h).length > 1;
}

/** Indexes of non-merge commits, oldest -> newest. */
export function authored(h: CommitHistory): number[] {
  return h.commits.flatMap((c, i) => (c.merge ? [] : [i]));
}

export interface FileStory {
  touches: (FileTouch & { commit: CommitInfo; afterReview: boolean; newest: boolean })[];
  afterReview: boolean;
  lateChange: boolean;
}

export function fileStory(h: CommitHistory, path: string): FileStory {
  const own = authored(h);
  const last = own[own.length - 1] ?? -1;
  const touches = (h.files[path] ?? []).map((t) => ({ ...t, commit: h.commits[t.c], afterReview: looksLikeAfterReview(h.commits[t.c]?.message ?? ""), newest: t.c === last }));
  const complete = h.commits.length === h.totalCommits; // can't call it "late" if older commits weren't fetched
  return {
    touches,
    afterReview: touches.some((t) => t.afterReview),
    lateChange: h.totalCommits > 1 && complete && touches.length === 1 && touches[0].c === last,
  };
}

/** Distinct commits that touched any of the paths, as a sorted list of indexes. */
export function stepCommits(h: CommitHistory, paths: readonly string[]): number[] {
  const s = new Set<number>();
  for (const p of paths) for (const t of h.files[p] ?? []) s.add(t.c);
  return [...s].sort((a, b) => a - b);
}

/** "just now", "8 min ago", "3 h ago", "2 days ago", "3 weeks ago", "4 months ago", "2 years ago". */
export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? "" : "s"} ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  const y = Math.round(d / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}
