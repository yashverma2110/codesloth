/** Risky changes: run every rule over a PR's files, then adjust severities and apply .codesloth.yml. Pure. */
import { detectLang } from "../classify";
import { hasGeneratedMarker } from "../patch";
import type { LayerPlan, PRFile } from "../types";
import { configRules, depsRules, envRules, lockfileOnly } from "./config";
import { DATA_LAYER, goFuncs, goRules, graphqlRules, jsExportNames, jsRules, openapiRules, packageExportsRule, prismaRules, protoRules, pythonRules, routeRules } from "./code";
import { added, type Hunk, parseHunks, removed } from "./hunks";
import { globMatch, isDocsPath, isMigration, isQueryFile, isSchemaFile, isSharedPath, isTestPath } from "./paths";
import { sqlFileRules, sqlInCode, type SqlCtx, tablesIn } from "./sql";
import type { Finding, Passed, RiskCategory, RiskInput, RiskReport, Severity } from "./types";
import { parseYaml, type Y } from "./yaml";

export * from "./types";
export const RISK_VERSION = 1;

export interface RiskConfig {
  sensitivity?: "relaxed" | "normal" | "strict";
  migrations: string[];
  queries: string[];
  dataLayer: string[];
  publicApi: string[];
  publicPrefixes: string[];
  ignore: string[];
  envReaders: string[];
  rules: Record<string, "off" | Severity>;
}

export const emptyConfig = (): RiskConfig => ({ migrations: [], queries: [], dataLayer: [], publicApi: [], publicPrefixes: [], ignore: [], envReaders: [], rules: {} });

/** Read .codesloth.yml (only the `risk:` section). Returns the config and a status line for the UI. */
export function parseRiskConfig(text: string | undefined): { config: RiskConfig; note: string } {
  const c = emptyConfig();
  if (text === undefined) return { config: c, note: ".codesloth.yml: not found on the base branch" };
  let y: Y;
  try {
    y = parseYaml(text);
  } catch (e) {
    return { config: c, note: `.codesloth.yml ignored: ${(e as Error).message}` };
  }
  const risk = (y && typeof y === "object" && !Array.isArray(y) ? (y as Record<string, Y>).risk : null) as Record<string, Y> | null;
  if (!risk || typeof risk !== "object" || Array.isArray(risk)) return { config: c, note: ".codesloth.yml: no risk: section" };
  const list = (v: Y | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
  const s = risk.sensitivity;
  if (s === "relaxed" || s === "normal" || s === "strict") c.sensitivity = s;
  const paths = (risk.paths ?? {}) as Record<string, Y>;
  if (paths && typeof paths === "object" && !Array.isArray(paths)) {
    c.migrations = list(paths.migrations);
    c.queries = list(paths.queries);
    c.dataLayer = list(paths.data_layer);
    c.publicApi = list(paths.public_api);
    c.ignore = list(paths.ignore);
  }
  c.publicPrefixes = list(risk.public_prefixes);
  c.envReaders = list(risk.env_readers).map((r) => r.replace(/\($/, ""));
  const rules = risk.rules;
  let n = 0;
  if (rules && typeof rules === "object" && !Array.isArray(rules)) {
    for (const [id, v] of Object.entries(rules as Record<string, Y>)) {
      const sev = typeof v === "object" && v && !Array.isArray(v) ? (v as Record<string, Y>).severity : v;
      if (sev === "off" || sev === false) c.rules[id] = "off";
      else if (sev === "high" || sev === "medium" || sev === "low") c.rules[id] = sev;
      else continue;
      n++;
    }
  }
  const bits = [n ? `${n} rule override${n === 1 ? "" : "s"}` : "", c.ignore.length ? `${c.ignore.length} ignored path${c.ignore.length === 1 ? "" : "s"}` : "", c.sensitivity ? `sensitivity ${c.sensitivity}` : ""].filter(Boolean);
  return { config: c, note: `.codesloth.yml loaded from the base branch${bits.length ? ` (${bits.join(", ")})` : ""}` };
}

const up: Record<Severity, Severity> = { low: "medium", medium: "high", high: "high" };

/** Run all rules. `plan` supplies importer counts and generated-file classification. */
export function analyzeRisk(input: RiskInput, plan?: LayerPlan): RiskReport {
  const { config, note } = parseRiskConfig(input.configText);
  const files = input.files.filter((f) => !config.ignore.some((g) => globMatch(g, f.filename)));
  const parsed = files.map((f) => ({ f, hunks: parseHunks(f.patch) }));
  const category = new Map<string, string>();
  for (const l of plan?.layers ?? []) for (const lf of l.files) category.set(lf.path, lf.category);
  const importers: Record<string, number> = { ...(input.importers ?? {}) };
  if (!input.importers && plan) for (const e of plan.edges) if (e.kind === "import") importers[e.to] = (importers[e.to] ?? 0) + 1;
  const head = (f: PRFile) => input.contents?.[f.filename] ?? (f.status === "added" ? added(parseHunks(f.patch)).map((l) => l.text).join("\n") : "");
  const migText = (p: string) => {
    const f = files.find((x) => x.filename === p);
    return f ? (input.contents?.[p] ?? (f.patch ?? "")) : undefined;
  };
  const isMig = (p: string) => isMigration(p, migText(p)) || config.migrations.some((g) => globMatch(g, p));
  const isQuery = (p: string) => isQueryFile(p) || config.queries.some((g) => globMatch(g, p));

  // SQL context
  const createdInPr = new Set<string>();
  const baseTables = new Set<string>();
  let schemaText = "";
  for (const { f, hunks } of parsed) {
    if (!/\.(sql|go|py|[cm]?[jt]s)$/i.test(f.filename)) continue;
    for (const t of tablesIn(added(hunks).map((l) => l.text).join("\n"))) createdInPr.add(t);
    for (const t of tablesIn(hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "+")).map((l) => l.text).join("\n"))) baseTables.add(t);
    if (/\.sql$/i.test(f.filename) && (isSchemaFile(f.filename) || isMig(f.filename))) schemaText += "\n" + (input.contents?.[f.filename] ?? added(hunks).map((l) => l.text).join("\n"));
  }
  for (const [p, t] of Object.entries(input.baseContents ?? {})) {
    if (!/\.sql$/i.test(p)) continue;
    for (const x of tablesIn(t)) baseTables.add(x);
    schemaText += "\n" + t;
  }
  // a table that exists on base and is (re)created in the PR is still "existing"
  for (const t of baseTables) createdInPr.delete(t);
  const sqlCtx: SqlCtx = { createdInPr, baseTables, schemaText, prHasMigrations: parsed.some(({ f }) => isMig(f.filename) && f.status !== "removed"), baseDirs: input.baseDirs ?? {}, prPaths: new Set(files.map((f) => f.filename)) };

  // symbols present anywhere on the new side (moves don't count as removals)
  const newGo = new Set<string>();
  const newPy = new Set<string>();
  const newJs = new Set<string>();
  for (const { f, hunks } of parsed) {
    const lines = hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "-"));
    if (f.filename.endsWith(".go")) for (const x of goFuncs(lines)) newGo.add(x.key);
    if (f.filename.endsWith(".py")) for (const m of lines.map((l) => l.text).join("\n").matchAll(/def\s+(\w+)\s*\(/g)) newPy.add(m[1]);
    if (/\.([cm]?[jt]sx?|vue)$/.test(f.filename)) for (const x of jsExportNames(lines)) newJs.add(x.name);
  }

  const codeText = parsed
    .filter(({ f }) => /\.(go|py|[cm]?[jt]sx?|vue)$/.test(f.filename))
    .map(({ f, hunks }) => input.contents?.[f.filename] ?? hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "-")).map((l) => l.text).join("\n"))
    .join("\n");
  const envDeclared = new Set<string>();
  for (const { f, hunks } of parsed) if (/\.(ya?ml|env|example|properties|tf|json)$|(^|\/)\.env/.test(f.filename)) for (const l of added(hunks)) for (const m of l.text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) envDeclared.add(m[1]);
  const cfgCtx = { codeText, envDeclared };

  let findings: Finding[] = [];
  const passed: Passed[] = [];
  const notChecked: string[] = [];

  for (const { f, hunks } of parsed) {
    const p = f.filename;
    if (!f.patch && f.changes > 0 && f.status !== "removed" && !/\.(png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip)$/i.test(p) && category.get(p) !== "generated") {
      notChecked.push(p);
      continue;
    }
    if (isTestPath(p) || isDocsPath(p)) continue;
    const lang = detectLang(p);
    const ht = head(f);
    const dataLayer = DATA_LAYER.test(p) || config.dataLayer.some((g) => globMatch(g, p));
    const shared = isSharedPath(p, config.publicApi);
    const out: Finding[] = [];
    if (/\.sql$/i.test(p) || isMig(p) || isQuery(p)) {
      const r = sqlFileRules(f, hunks, sqlCtx, isMig(p));
      out.push(...r.findings);
      passed.push(...r.passed);
    }
    if (lang === "go") {
      out.push(...goRules(f, hunks, newGo, dataLayer || shared));
      out.push(...routeRules(f, hunks, "go", ht, config.publicPrefixes));
    } else if (lang === "python") {
      out.push(...pythonRules(f, hunks, newPy, dataLayer || shared, ht));
      out.push(...routeRules(f, hunks, "python", ht, config.publicPrefixes));
    } else if (lang === "js" || lang === "vue") {
      out.push(...jsRules(f, hunks, newJs, dataLayer, shared));
      out.push(...routeRules(f, hunks, "js", ht, config.publicPrefixes));
    }
    if (["go", "python", "js", "vue"].includes(lang) && !isMig(p)) out.push(...sqlInCode(p, hunks, sqlCtx));
    if (/\.prisma$/.test(p)) out.push(...prismaRules(f, hunks));
    if (/\.proto$/.test(p)) out.push(...protoRules(f, hunks));
    if (/\.(graphqls?|gql)$/.test(p)) out.push(...graphqlRules(f, hunks));
    if (/\.(ya?ml|json)$/i.test(p)) {
      const oa = openapiRules(f, hunks, ht);
      out.push(...oa);
      if (!oa.length || !/openapi|swagger/i.test(ht)) out.push(...configRules(f, hunks, cfgCtx, ht));
    } else out.push(...configRules(f, hunks, cfgCtx, ht));
    out.push(...depsRules(f, hunks), ...packageExportsRule(f, hunks, shared));
    findings.push(...out);
  }
  findings.push(...envRules(parsed.filter(({ f }) => !isTestPath(f.filename)), cfgCtx, config.envReaders));
  findings.push(...lockfileOnly(files));

  // ---- severity adjustments ----
  const queryFiles = files.filter((f) => isQuery(f.filename)).map((f) => f.filename.split("/").pop()!);
  findings = findings.map((x) => {
    const f: Finding & { adjust: string[] } = { ...x, adjust: [...(x.adjust ?? [])] };
    const gen = category.get(f.path) === "generated" || !!hasGeneratedMarker(input.contents?.[f.path] ?? parseHunks(files.find((y) => y.filename === f.path)?.patch).flatMap((h) => h.lines.filter((l) => l.kind !== "-")).slice(0, 15).map((l) => l.text).join("\n"));
    if (gen && f.category !== "deps") {
      f.severity = "low";
      const src = /\/db\/|sqlc|\.sql\.go$/.test(f.path) && queryFiles.length ? queryFiles.join(", ") : "its generator input";
      f.adjust.push(`Generated file: review ${src} instead.`);
    } else if (f.category === "data" || f.category === "api") {
      const n = importers[f.path] ?? 0;
      const lang = detectLang(f.path);
      const compiled = lang === "go" || /\.(tsx?|mts|cts)$/.test(f.path);
      if (n >= 3 && !compiled && f.severity !== "low") {
        f.severity = up[f.severity];
        f.adjust.push(`Raised: ${n} changed files import it, and ${lang === "python" ? "Python" : "JavaScript"} won't catch mismatches until runtime.`);
      } else if (n > 0) f.adjust.push(`Imported by ${n} changed file${n === 1 ? "" : "s"}.`);
      if (isSharedPath(f.path, config.publicApi) && /^(dal\.|orm\.)/.test(f.rule) && f.severity === "medium") {
        f.severity = "high";
        f.adjust.push("Raised: shared/library path; consumers outside this repo can't be checked here.");
      }
    }
    const o = config.rules[f.rule] ?? config.rules[f.rule.split(".")[0] + ".*"];
    if (o && o !== "off") {
      f.adjust.push(`.codesloth.yml sets ${f.rule} to ${o}.`);
      f.severity = o;
    }
    const { adjust, ...rest } = f;
    return adjust.length ? { ...rest, adjust } : rest;
  });
  findings = findings.filter((f) => config.rules[f.rule] !== "off" && config.rules[f.rule.split(".")[0] + ".*"] !== "off");
  // .codesloth.yml changed in this PR: flag it (the base version is what's applied)
  const cfgChange = files.find((f) => /(^|\/)\.codesloth\.ya?ml$/.test(f.filename));
  if (cfgChange) findings.push({ path: cfgChange.filename, rule: "cfg.codesloth", category: "config", severity: "medium", title: "Changes CodeSloth's risk rules", why: "This PR is checked with the base branch's version; the new rules apply after merge." });

  const seen = new Set<string>();
  findings = findings.filter((f) => {
    const k = `${f.path}|${f.rule}|${f.line?.side}${f.line?.n}|${f.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || (a.line?.n ?? 0) - (b.line?.n ?? 0));
  return { version: 1, findings, passed, notChecked, config: note, sensitivity: config.sensitivity } as RiskReport;
}

/* ---------------- what the UI shows ---------------- */

export { DEFAULT_RISK_PREFS, normalizeRiskPrefs, RISK_CATEGORIES, type RiskPrefs, type Sensitivity } from "./prefs";
import type { RiskPrefs, Sensitivity } from "./prefs";

/** Dismissal key: per file + rule (+ the matched text, so it comes back when those lines change). */
export function dismissKey(f: Finding): string {
  let h = 0;
  for (const ch of `${f.excerpt ?? ""}|${f.title}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `${f.path}|${f.rule}|${(h >>> 0).toString(36)}`;
}

export function visibleFindings(r: RiskReport | null | undefined, prefs: RiskPrefs, repoSensitivity?: Sensitivity): Finding[] {
  if (!r) return [];
  // the stricter of the user's and the repo's setting
  const order: Sensitivity[] = ["relaxed", "normal", "strict"];
  const s = repoSensitivity && order.indexOf(repoSensitivity) > order.indexOf(prefs.sensitivity) ? repoSensitivity : prefs.sensitivity;
  const allowed: Record<Sensitivity, Severity[]> = { relaxed: ["high"], normal: ["high", "medium"], strict: ["high", "medium", "low"] };
  return r.findings.filter((f) => allowed[s].includes(f.severity) && !prefs.off.includes(f.category));
}

export interface FileRisk {
  severity: Severity;
  findings: Finding[];
  dismissed: Finding[];
}

/** Group visible findings by file, minus dismissed ones. A file's severity is its worst active finding. */
export function riskByFile(visible: Finding[], dismissed: Record<string, unknown>): Map<string, FileRisk> {
  const out = new Map<string, FileRisk>();
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  for (const f of visible) {
    const e = out.get(f.path) ?? { severity: "low" as Severity, findings: [], dismissed: [] };
    if (dismissed[dismissKey(f)]) e.dismissed.push(f);
    else {
      e.findings.push(f);
      if (e.findings.length === 1 || rank[f.severity] < rank[e.severity]) e.severity = f.severity;
    }
    out.set(f.path, e);
  }
  return out;
}
