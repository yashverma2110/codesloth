/**
 * Build the bundled demo plan from cached real PR data (created by scripts/analyze-pr.ts).
 * Usage: npx tsx scripts/make-demo-plan.ts owner/repo#n out.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { analyze } from "../src/engine/analyze";
import { analyzeRisk } from "../src/engine/risk";
import type { PRFile } from "../src/engine/types";

const [, , ref, out] = process.argv;
const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref ?? "");
if (!m || !out) throw new Error("usage: make-demo-plan.ts owner/repo#n out.json");
const dir = `.tmp/${m[1]}_${m[2]}_${m[3]}`;
const pr = JSON.parse(readFileSync(`${dir}/pr.json`, "utf8"));
const files: PRFile[] = JSON.parse(readFileSync(`${dir}/files.json`, "utf8"));
const contents: Record<string, string> = {};
for (const f of files) {
  const p = `${dir}/raw_${f.filename.replace(/[^\w.-]/g, "_")}`;
  if (existsSync(p)) contents[f.filename] = readFileSync(p, "utf8");
}
const ga = `${dir}/raw_.gitattributes`;
const gm = `${dir}/raw_go.mod`;
const plan = analyze({ files, contents, gitattributes: existsSync(ga) ? readFileSync(ga, "utf8") : undefined, goMods: existsSync(gm) ? { "go.mod": readFileSync(gm, "utf8") } : {} });
// Risky changes from the same real data (no .codesloth.yml / base context: the demo has no network).
const risk = analyzeRisk({ files, contents }, plan);
risk.config = "Demo: computed from the sample's real diff; uses Strict so its low-level flags show.";
const demo = {
  pr: { owner: m[1], repo: m[2], number: Number(m[3]) },
  meta: { title: pr.title, headSha: pr.head.sha, baseSha: pr.base.sha, changedFiles: pr.changed_files, additions: pr.additions, deletions: pr.deletions, htmlUrl: pr.html_url, state: pr.merged_at ? "merged" : pr.state },
  plan,
  risk,
};
writeFileSync(out, JSON.stringify(demo));
console.log(`wrote ${out}: ${plan.layers.length} layers, ${plan.edges.length} edges, ${risk.findings.length} risk findings, ${JSON.stringify(demo).length} bytes`);
