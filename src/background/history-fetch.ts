/** Fetch a PR's commit story with read-only GETs (see src/shared/history.ts). */
import { buildHistory, HISTORY_SOFT_CAP, isMerge, pickCommits, type CommitHistory, type RawCommitFile } from "../shared/history";
import type { PRRef } from "../shared/messages";
import { GitHubError, pool, type GitHubClient } from "./github";

/** Keep this much quota for the layer plan and normal browsing. */
export const QUOTA_RESERVE = 200;

export async function fetchHistory(client: GitHubClient, pr: PRRef, paths: readonly string[], opts: { totalCommits?: number; cap?: number; concurrency?: number } = {}): Promise<CommitHistory> {
  const listed = await client.listPrCommits(pr);
  const total = Math.max(opts.totalCommits ?? 0, listed.length);
  const picked = pickCommits(listed, opts.cap ?? HISTORY_SOFT_CAP);
  // A 1-commit PR has no story to tell: skip the extra request.
  if (total <= 1) return buildHistory(picked, () => [], paths, total, listed.length);
  const toFetch = picked.filter((c) => !isMerge(c));
  if (client.rate && client.rate.remaining < toFetch.length + QUOTA_RESERVE) {
    throw new GitHubError(`Skipped the commit story to save API quota (${client.rate.remaining} requests left).`, 429, "quota_reserve");
  }
  const files = new Map<string, RawCommitFile[]>();
  await pool(toFetch, opts.concurrency ?? 4, async (c) => {
    files.set(c.sha, await client.getCommitFiles(pr, c.sha));
  });
  return buildHistory(picked, (sha) => files.get(sha), paths, total, listed.length);
}
