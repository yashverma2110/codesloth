/**
 * Build the bundled demo commit story from a real public PR with read-only `gh api` GETs.
 * Usage: npx tsx scripts/make-demo-history.ts owner/repo#123 src/demo/demo-plan.json src/demo/demo-history.json
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { buildHistory, isMerge, pickCommits, type RawCommit, type RawCommitFile } from "../src/shared/history";

const [ref, planPath, out] = process.argv.slice(2);
const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref ?? "");
if (!m || !planPath || !out) throw new Error("usage: owner/repo#n plan.json out.json");
const [, owner, repo, num] = m;
const gh = (path: string) => JSON.parse(execFileSync("gh", ["api", "-X", "GET", path], { encoding: "utf8", maxBuffer: 64 << 20 }));
const commits: RawCommit[] = [];
for (let page = 1; page <= 3; page++) {
  const b = gh(`repos/${owner}/${repo}/pulls/${num}/commits?per_page=100&page=${page}`) as RawCommit[];
  commits.push(...b);
  if (b.length < 100) break;
}
const picked = pickCommits(commits);
const files = new Map<string, RawCommitFile[]>();
for (const c of picked.filter((c) => !isMerge(c))) {
  const all: RawCommitFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const j = gh(`repos/${owner}/${repo}/commits/${c.sha}?per_page=100&page=${page}`) as { files?: RawCommitFile[] };
    const b = j.files ?? [];
    all.push(...b.map((f) => ({ filename: f.filename, status: f.status, previous_filename: f.previous_filename, additions: f.additions, deletions: f.deletions })));
    if (b.length < 100) break;
  }
  files.set(c.sha, all);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const paths: string[] = plan.plan.layers.flatMap((l: { files: { path: string }[] }) => l.files.map((f) => f.path));
const h = buildHistory(picked, (s) => files.get(s), paths, commits.length, commits.length);
writeFileSync(out, JSON.stringify(h, null, 1) + "\n");
console.log(`wrote ${out}: ${h.commits.length} commits, ${Object.values(h.files).filter((t) => t.length).length}/${paths.length} files with history`);
