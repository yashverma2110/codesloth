// Run the risk engine on a cached real PR (.tmp/<owner>_<repo>_<n>) with optional base fetches via gh.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { analyze } from "../../src/engine/analyze";
import { analyzeRisk } from "../../src/engine/risk";
const [spec] = process.argv.slice(2);
const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(spec)!;
const [, owner, repo, num] = m;
const dir = `/workspace/pr-stacks-extension/.tmp/${owner}_${repo}_${num}`;
const gh = (p: string, raw = false) => execFileSync("gh", ["api", ...(raw ? ["-H", "Accept: application/vnd.github.raw+json"] : []), p], { encoding: "utf8", maxBuffer: 1 << 28 });
const cache = (name: string, fn: () => string) => { const p = `${dir}/risk_${name.replace(/[^\w.-]/g, "_")}`; if (existsSync(p)) return readFileSync(p, "utf8"); let v = ""; try { v = fn(); } catch { v = "\u0000missing"; } writeFileSync(p, v); return v; };
const ls = readdirSync(dir);
const filesName = ls.find((n) => /files/.test(n) && n.endsWith(".json"))!;
const files = JSON.parse(readFileSync(`${dir}/${filesName}`, "utf8"));
const pr = JSON.parse(cache("pr.json", () => gh(`repos/${owner}/${repo}/pulls/${num}`)));
const contents: Record<string, string> = {};
for (const n of ls) if (n.startsWith("raw_")) { const path = n.slice(4); const f = files.find((x: any) => x.filename.replace(/[^\w.-]/g, "_") === path); if (f) contents[f.filename] = readFileSync(`${dir}/${n}`, "utf8"); }
const base = pr.base.sha;
const baseContents: Record<string, string> = {};
for (const f of files) if (/\.sql$|\.prisma$/.test(f.filename) && /schema/i.test(f.filename) && f.status !== "added") { const t = cache(`base_${f.filename}`, () => gh(`repos/${owner}/${repo}/contents/${f.filename}?ref=${base}`, true)); if (!t.startsWith("\u0000")) baseContents[f.filename] = t; }
const baseDirs: Record<string, string[]> = {};
for (const f of files) if (/migrat/i.test(f.filename)) { const d = f.filename.slice(0, f.filename.lastIndexOf("/")); if (baseDirs[d]) continue; const t = cache(`dir_${d}`, () => gh(`repos/${owner}/${repo}/contents/${d}?ref=${base}`)); if (!t.startsWith("\u0000")) baseDirs[d] = JSON.parse(t).map((x: any) => x.name); }
const cfg = cache("codesloth.yml", () => gh(`repos/${owner}/${repo}/contents/.codesloth.yml?ref=${base}`, true));
const plan = analyze({ files, contents });
const r = analyzeRisk({ files, contents, baseContents, baseDirs, configText: cfg.startsWith("\u0000") ? undefined : cfg }, plan);
const by = (s: string) => r.findings.filter((f) => f.severity === s);
const fileSev = new Map<string, string>();
for (const f of r.findings) if (f.severity !== "low") { const cur = fileSev.get(f.path); if (!cur || f.severity === "high") fileSev.set(f.path, f.severity); }
console.log(`${spec}: ${files.length} files · findings high ${by("high").length} / medium ${by("medium").length} / low ${by("low").length} · files red ${[...fileSev.values()].filter((v) => v === "high").length}, amber ${[...fileSev.values()].filter((v) => v === "medium").length}`);
for (const f of r.findings) console.log(`  ${f.severity.padEnd(6)} ${f.path}  [${f.rule}] ${f.title}${f.line ? ` @${f.line.side}${f.line.n}` : ""}${f.adjust ? "  {" + f.adjust.join(" ") + "}" : ""}\n         ${f.excerpt ?? ""}`);
for (const p of r.passed) console.log(`  passed ${p.path}: ${p.text}`);
console.log("  notChecked:", r.notChecked.join(", ") || "-", "| config:", r.config);
if (process.argv.includes("--json")) writeFileSync(`${dir}/risk.json`, JSON.stringify(r, null, 1));
