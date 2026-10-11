/**
 * Fixtures for screenshots and the overflow check:
 *  - adds the engine's real risk report to test/fixtures/overflow/gitea-39426-plan.json (from .tmp cache of the public PR)
 *  - writes test/fixtures/risk/red-plan.json: the ILLUSTRATIVE red PR (test/fixtures/risk/red-pr.ts) as an AnalyzeResult
 * Usage: npx tsx scripts/dev/make-risk-fixtures.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { analyze } from "../../src/engine/analyze";
import { analyzeRisk } from "../../src/engine/risk";
import type { PRFile } from "../../src/engine/types";
import { RED_PR } from "../../test/fixtures/risk/red-pr";

const giteaDir = ".tmp/go-gitea_gitea_39426";
if (existsSync(giteaDir)) {
  const files: PRFile[] = JSON.parse(readFileSync(`${giteaDir}/files.json`, "utf8"));
  const contents: Record<string, string> = {};
  for (const n of readdirSync(giteaDir).filter((x) => x.startsWith("raw_"))) {
    const f = files.find((x) => `raw_${x.filename.replace(/[^\w.-]/g, "_")}` === n);
    if (f) contents[f.filename] = readFileSync(`${giteaDir}/${n}`, "utf8");
  }
  const p = "test/fixtures/overflow/gitea-39426-plan.json";
  const fx = JSON.parse(readFileSync(p, "utf8"));
  fx.risk = analyzeRisk({ files, contents }, fx.plan);
  writeFileSync(p, JSON.stringify(fx));
  console.log(`gitea: ${fx.risk.findings.length} findings`);
}
const plan = analyze({ files: RED_PR });
const risk = analyzeRisk({ files: RED_PR }, plan);
risk.config = "Illustrative fixture (not a real PR).";
const add = RED_PR.reduce((s, f) => s + f.additions, 0);
const del = RED_PR.reduce((s, f) => s + f.deletions, 0);
writeFileSync(
  "test/fixtures/risk/red-plan.json",
  JSON.stringify({ pr: { owner: "example", repo: "quota-service", number: 99 }, meta: { title: "ILLUSTRATIVE: drop consumed (edits a merged migration)", headSha: "0000000illustrative", baseSha: "0000000base", changedFiles: RED_PR.length, additions: add, deletions: del, htmlUrl: "https://github.com/example/quota-service/pull/99", state: "open" }, plan, risk }),
);
console.log(`red: ${risk.findings.filter((f) => f.severity === "high").length} high, ${risk.findings.filter((f) => f.severity === "medium").length} medium`);
