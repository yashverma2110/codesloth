/**
 * Run the layering engine against a real public PR using the GitHub CLI (`gh api`, read-only GETs).
 * Usage: npx tsx scripts/analyze-pr.ts owner/repo#123 [--no-contents] [--json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { analyze, filesNeedingContents } from "../src/engine/analyze";
import type { PRFile } from "../src/engine/types";

const arg = process.argv[2];
const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(arg ?? "");
if (!m) {
  console.error("usage: analyze-pr.ts owner/repo#123 [--no-contents] [--json]");
  process.exit(1);
}
const [, owner, repo, num] = m;
const noContents = process.argv.includes("--no-contents");
const asJson = process.argv.includes("--json");
const cacheDir = `.tmp/${owner}_${repo}_${num}`;
mkdirSync(cacheDir, { recursive: true });

function gh(path: string, raw = false): string {
  const args = ["api", "-H", "X-GitHub-Api-Version: 2026-03-10"];
  if (raw) args.push("-H", "Accept: application/vnd.github.raw+json");
  args.push(path);
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}
function cached(name: string, fn: () => string): string {
  const p = `${cacheDir}/${name.replace(/[^\w.-]/g, "_")}`;
  if (existsSync(p)) return readFileSync(p, "utf8");
  const v = fn();
  writeFileSync(p, v);
  return v;
}
function tryRaw(path: string, ref: string): string | undefined {
  try {
    return cached(`raw_${path}`, () => gh(`repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${ref}`, true));
  } catch {
    return undefined;
  }
}

const pr = JSON.parse(cached("pr.json", () => gh(`repos/${owner}/${repo}/pulls/${num}`)));
const files: PRFile[] = JSON.parse(
  cached("files.json", () => {
    const all: PRFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch: PRFile[] = JSON.parse(gh(`repos/${owner}/${repo}/pulls/${num}/files?per_page=100&page=${page}`));
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return JSON.stringify(all);
  }),
);
const head = pr.head.sha as string;

const contents: Record<string, string> = {};
if (!noContents) {
  for (const p of filesNeedingContents(files, 150)) {
    const t = tryRaw(p, head);
    if (t !== undefined && t.length < 400_000) contents[p] = t;
  }
}
const gitattributes = tryRaw(".gitattributes", head);
const goMods: Record<string, string> = {};
if (files.some((f) => f.filename.endsWith(".go"))) {
  const root = tryRaw("go.mod", head);
  if (root) goMods["go.mod"] = root;
  for (const f of files) if (f.filename.endsWith("/go.mod")) {
    const t = tryRaw(f.filename, head);
    if (t) goMods[f.filename] = t;
  }
}

const t0 = performance.now();
const plan = analyze({ files, contents, gitattributes, goMods });
const ms = (performance.now() - t0).toFixed(0);

if (asJson) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(`# ${owner}/${repo}#${num}: ${pr.title}`);
  console.log(`head ${head.slice(0, 7)} · ${plan.stats.files} files · +${plan.stats.additions}/-${plan.stats.deletions} · ${plan.stats.edges} dependency edges · contents fetched for ${plan.stats.contentsUsed} files · engine ${ms} ms`);
  for (const w of plan.warnings) console.log(`  ! ${w}`);
  for (const l of plan.layers) {
    console.log(`\n## L${l.index} ${l.title}  (${l.stats.files} files, +${l.stats.additions}/-${l.stats.deletions})`);
    const max = Number(process.env.MAX_FILES ?? 8);
    for (const f of l.files.slice(0, max)) console.log(`  - ${f.path}  [+${f.additions}/-${f.deletions}]\n      ${f.reason}`);
    if (l.files.length > max) console.log(`  … ${l.files.length - max} more`);
  }
}
