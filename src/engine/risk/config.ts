/** Config, env, infra and dependency rules. */
import type { PRFile } from "../types";
import { added, type HLine, type Hunk, newSide, oldSide, ref, removed, trimEx } from "./hunks";
import { isConfigFile, isK8s, isLockfile } from "./paths";
import type { Finding, RiskCategory } from "./types";

const mk = (category: RiskCategory, path: string, rule: string, severity: Finding["severity"], title: string, why: string, l?: HLine, extra: Partial<Finding> = {}): Finding => ({
  path,
  rule,
  category,
  severity,
  title,
  why,
  ...(l ? { line: ref(l), excerpt: trimEx(l.text) } : {}),
  ...extra,
});

interface KeyAt {
  key: string;
  value: string;
  line: HLine;
}

/** Key paths on changed lines of one side of a hunk (YAML/JSON by indentation, TOML/INI by [section], .env flat). */
export function changedKeys(path: string, lines: HLine[], want: "+" | "-"): KeyAt[] {
  const out: KeyAt[] = [];
  const flat = /(^|\/)\.env(\.[\w-]+)?$|\.(env|properties)$/i.test(path);
  const toml = /\.(toml|ini|cfg|conf)$/i.test(path);
  const json = /\.json$/i.test(path);
  const stack: { indent: number; key: string }[] = [];
  let section = "";
  for (const l of lines) {
    const t = l.text;
    if (!t.trim() || /^\s*(#|\/\/|;)/.test(t)) continue;
    let key: string | undefined;
    let value = "";
    if (flat) {
      const m = t.match(/^\s*(?:export\s+)?([\w.-]+)\s*[=:]\s*(.*)$/);
      if (m) [key, value] = [m[1], m[2].trim()];
    } else if (toml) {
      const s = t.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
      if (s) {
        section = s[1];
        continue;
      }
      const m = t.match(/^\s*([\w."-]+)\s*=\s*(.*)$/);
      if (m) [key, value] = [(section ? section + "." : "") + m[1].replace(/"/g, ""), m[2].trim()];
    } else {
      const m = json ? t.match(/^(\s*)"([^"]+)"\s*:\s*(.*?),?\s*$/) : t.match(/^(\s*)(?:-\s+)?([\w.\-/{}"']+)\s*:(?:\s+(.*)|\s*)$/);
      if (m) {
        const indent = m[1].length;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const k = m[2].replace(/["']/g, "");
        const full = [...stack.map((x) => x.key), k].join(".");
        value = (m[3] ?? "").trim();
        if (!value || value === "{" || value === "[" || value === "|" || value === ">") stack.push({ indent, key: k });
        key = full;
      }
    }
    if (key && l.kind === want) out.push({ key, value: value.replace(/\s+#.*$/, ""), line: l });
  }
  return out;
}

const INTERESTING = /(timeout|ttl|retr(y|ies)|limit|max|min|port|url|uri|host|endpoint|addr|dsn|replicas|pool|concurrency|batch|interval|expir|enabled|region|bucket|queue|topic)/i;
const FLAG = /(feature|flag|toggle|_enabled$|\.enabled$|^enabled$)/i;

export interface ConfigCtx {
  /** Text of every code file's added lines + fetched contents in the PR, for "still read" checks. */
  codeText: string;
  /** Env var names added to deploy/config files in this PR. */
  envDeclared: Set<string>;
}

export function configRules(f: PRFile, hunks: Hunk[], c: ConfigCtx, headText: string): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added") return out;
  if (/(^|\/)Dockerfile[^/]*$|\.dockerfile$/i.test(path)) return dockerRules(path, hunks);
  if (/\.tf$/.test(path)) return terraformRules(path, hunks);
  const ci = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$/.test(path);
  if (!isConfigFile(path) && !ci) return out;
  const k8s = isK8s(path, headText);

  const rem: KeyAt[] = [];
  const add: KeyAt[] = [];
  for (const h of hunks) {
    rem.push(...changedKeys(path, oldSide(h), "-"));
    add.push(...changedKeys(path, newSide(h), "+"));
  }
  const addBy = new Map(add.map((a) => [a.key, a]));
  const remKeys = new Set(rem.map((r) => r.key));
  const category: RiskCategory = "config";
  for (const r of rem) {
    const a = addBy.get(r.key);
    const leaf = r.key.split(".").pop()!;
    if (a) {
      if (a.value === r.value) continue;
      if (k8s && /^(image|containerPort|port|targetPort|replicas|cpu|memory|serviceAccountName|command|args)$/.test(leaf)) {
        out.push(mk(category, path, "infra.k8s", "medium", `Changes ${r.key}`, `Deployment setting: ${trimEx(r.value, 40)} → ${trimEx(a.value, 40)}.`, a.line));
      } else if (ci && /(^|\.)(permissions|on|environment|runs-on)(\.|$)/.test(r.key)) {
        out.push(mk(category, path, "infra.ci", "medium", `Changes CI ${r.key}`, `${trimEx(r.value, 40)} → ${trimEx(a.value, 40)}.`, a.line));
      } else if (FLAG.test(r.key) && [r.value, a.value].every((v) => /^["']?(true|false|on|off|yes|no|enabled|disabled|0|1)["']?$/i.test(v))) {
        out.push(mk(category, path, "cfg.flag-changed", "medium", `Flips feature flag ${r.key}`, `${trimEx(r.value, 30)} → ${trimEx(a.value, 30)}: behaviour changes for everyone using this config.`, a.line));
      } else if (INTERESTING.test(leaf)) {
        out.push(mk(category, path, "cfg.default-changed", "medium", `Changes ${r.key}`, `${trimEx(r.value, 40)} → ${trimEx(a.value, 40)}; timeouts, limits, ports and URLs change runtime behaviour.`, a.line));
      } else {
        out.push(mk(category, path, "cfg.default-changed", "low", `Changes ${r.key}`, `${trimEx(r.value, 40)} → ${trimEx(a.value, 40)}.`, a.line));
      }
      continue;
    }
    // renamed: same value under a new key at the same parent
    const parent = r.key.split(".").slice(0, -1).join(".");
    const ren = add.find((x) => !remKeys.has(x.key) && x.value === r.value && r.value !== "" && x.key.split(".").slice(0, -1).join(".") === parent);
    const stillRead = leaf.length >= 4 && new RegExp(`["'\`.]${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]?`).test(c.codeText);
    if (ren) {
      out.push(mk(category, path, "cfg.key-renamed", stillRead ? "high" : "medium", `Renames ${r.key} → ${ren.key.split(".").pop()}`, stillRead ? `Code in this PR still reads "${leaf}".` : "Anything reading the old key (code, deploy overrides, other services) gets nothing.", ren.line));
    } else if (k8s && /^(kind|ports|containerPort|port)$/.test(leaf)) {
      out.push(mk(category, path, "infra.k8s", /kind/.test(leaf) && /Service|Ingress/.test(r.value) ? "high" : "medium", `Removes ${r.key}${r.value ? ` (${trimEx(r.value, 30)})` : ""}`, "Removing a Service, Ingress or port cuts traffic to it.", r.line));
    } else {
      out.push(mk(category, path, "cfg.key-removed", stillRead ? "high" : "medium", `Removes ${r.key}`, stillRead ? `Code in this PR still reads "${leaf}".` : "Anything reading it falls back to a default or fails; check deploy overrides too.", r.line));
    }
  }
  return out;
}

function dockerRules(path: string, hunks: Hunk[]): Finding[] {
  const out: Finding[] = [];
  const instr = (ls: HLine[]) => ls.map((l) => ({ l, m: l.text.match(/^\s*(FROM|EXPOSE|ENTRYPOINT|CMD|USER)\s+(.*)$/i) })).filter((x) => x.m);
  const rem = instr(removed(hunks));
  const add = instr(added(hunks));
  for (const a of add) {
    const kw = a.m![1].toUpperCase();
    const r = rem.find((x) => x.m![1].toUpperCase() === kw);
    if (!r && kw !== "EXPOSE") continue;
    if (r && r.m![2].trim() === a.m![2].trim()) continue;
    out.push(mk("config", path, "infra.docker", "medium", `Changes ${kw}`, r ? `${trimEx(r.m![2], 40)} → ${trimEx(a.m![2], 40)}.` : "New exposed port.", a.l));
  }
  return out;
}

function terraformRules(path: string, hunks: Hunk[]): Finding[] {
  const out: Finding[] = [];
  const blocks = (ls: HLine[]) => ls.map((l) => ({ l, m: l.text.match(/^\s*(resource|module|data)\s+"([^"]+)"(?:\s+"([^"]+)")?/) })).filter((x) => x.m);
  const rem = blocks(removed(hunks));
  const add = blocks(added(hunks));
  const moved = added(hunks).some((l) => /^\s*moved\s*\{/.test(l.text));
  for (const r of rem) {
    if (r.m![1] === "data") continue;
    const id = `${r.m![2]}.${r.m![3] ?? ""}`;
    if (add.some((a) => `${a.m![2]}.${a.m![3] ?? ""}` === id)) continue;
    if (moved) continue;
    out.push(mk("config", path, "infra.terraform", "high", `Removes ${r.m![1]} ${r.m![2]}${r.m![3] ? "." + r.m![3] : ""}`, "Without a moved {} block, terraform destroys it (and recreates it if it was renamed).", r.l));
  }
  return out;
}

/* ---------------- env vars read in code ---------------- */

const ENV_READ = [
  /\bos\.(?:Getenv|LookupEnv)\(\s*"(\w+)"/g,
  /\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g,
  /\bprocess\.env\[\s*["'`](\w+)["'`]\s*\]/g,
  /\bos\.environ\[\s*["'](\w+)["']\s*\]/g,
  /\bos\.(?:environ\.get|getenv)\(\s*["'](\w+)["']/g,
  /\b(?:Get(?:Config)?Env|getEnv|GetEnvOrDefault|MustGetEnv|env)\(\s*["'`](\w+)["'`]/g,
];

export function envReads(text: string, extraReaders: string[] = []): { name: string; hasDefault: boolean; required: boolean }[] {
  const out: { name: string; hasDefault: boolean; required: boolean }[] = [];
  const res = [...ENV_READ, ...extraReaders.map((r) => new RegExp(String.raw`\b${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\(\s*["'\`](\w+)["'\`]`, "g"))];
  for (const re of res)
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
      const hasDefault = /LookupEnv|GetEnvOrDefault/.test(m[0]) || /^\s*,\s*[^)]/.test(rest) || /^\s*(\)\s*)?(\|\||\?\?|or\b)/.test(rest);
      // Fails when unset: os.environ["X"], MustGetEnv("X"), process.env.X!
      const required = /os\.environ\[|MustGetEnv/.test(m[0]) || (/process\.env/.test(m[0]) && /^!/.test(rest));
      out.push({ name: m[1], hasDefault, required });
    }
  return out;
}

export function envRules(files: { f: PRFile; hunks: Hunk[] }[], c: ConfigCtx, extraReaders: string[]): Finding[] {
  const out: Finding[] = [];
  const all = (kind: "+" | "-") => files.flatMap(({ f, hunks }) => (kind === "+" ? added(hunks) : removed(hunks)).flatMap((l) => envReads(l.text, extraReaders).map((r) => ({ ...r, f, l }))));
  const adds = all("+");
  const rems = all("-");
  const addNames = new Set(adds.map((a) => a.name));
  const remNames = new Set(rems.map((r) => r.name));
  const context = files.flatMap(({ hunks }) => hunks.flatMap((h) => h.lines.filter((l) => l.kind === " ")).flatMap((l) => envReads(l.text, extraReaders).map((r) => r.name)));
  for (const r of rems) {
    if (addNames.has(r.name) || context.includes(r.name)) continue;
    const sameFile = adds.filter((a) => a.f === r.f && !remNames.has(a.name));
    if (sameFile.length === 1) out.push(mk("config", r.f.filename, "cfg.env-renamed", "medium", `Env var ${r.name} → ${sameFile[0].name}`, `Every environment must set ${sameFile[0].name} before this deploys.`, sameFile[0].l));
    else out.push(mk("config", r.f.filename, "cfg.env-removed", "low", `No longer reads ${r.name}`, "Deploy config may still set it; harmless but stale.", r.l));
  }
  const seen = new Set<string>();
  for (const a of adds) {
    if (remNames.has(a.name) || context.includes(a.name) || seen.has(a.name)) continue;
    if (/\.(test|spec)\.|_test\.go$|(^|\/)tests?\//.test(a.f.filename)) continue;
    seen.add(a.name);
    if (rems.some((r) => r.f === a.f && !addNames.has(r.name))) continue; // reported as a rename
    const declared = c.envDeclared.has(a.name);
    const sev = a.required && !declared ? "medium" : "low";
    out.push(mk("config", a.f.filename, "cfg.env-added", sev, `Reads new env var ${a.name}`, a.hasDefault ? "Has a fallback default." : declared ? "Also added to config in this PR." : a.required ? "Fails when unset: every environment must set it before this deploys." : "Reads empty when unset; make sure deploys set it if it matters.", a.l));
  }
  return out;
}

/* ---------------- dependencies ---------------- */

const major = (v: string): [number, number] | null => {
  const m = v.replace(/^[\^~>=<v\s"']+/, "").match(/^(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
};
const isBump = (a: [number, number], b: [number, number]) => b[0] > a[0] || (a[0] === 0 && b[0] === 0 && b[1] > a[1]);

export function depsRules(f: PRFile, hunks: Hunk[]): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added" || f.status === "removed") return out;
  const pick = (ls: HLine[], re: RegExp) => ls.map((l) => ({ l, m: l.text.match(re) })).filter((x) => x.m) as { l: HLine; m: RegExpMatchArray }[];
  let re: RegExp | null = null;
  let engine: RegExp | null = null;
  if (/(^|\/)package\.json$/.test(path)) {
    re = /^\s*"(@?[\w./-]+)"\s*:\s*"([\^~>=<]*\s*v?\d[^"]*)"/;
    engine = /^\s*"(node|npm|pnpm|yarn)"\s*:\s*"([^"]+)"/;
  } else if (/(^|\/)go\.mod$/.test(path)) {
    re = /^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+?)(?:\/v(\d+))?\s+(v[\d.]+[^\s]*)/;
    engine = /^\s*(go|toolchain)\s+(\S+)/;
  } else if (/(^|\/)(requirements[^/]*\.txt|constraints[^/]*\.txt)$/.test(path)) re = /^\s*([\w.-]+)(?:\[[^\]]*\])?\s*(?:==|>=|~=|>)\s*([\d.]+)/;
  else if (/(^|\/)pyproject\.toml$/.test(path)) {
    re = /^\s*"?([\w.-]+)(?:\[[^\]]*\])?\s*(?:=\s*"[\^~>=]*|(?:==|>=|~=)\s*)([\d.]+)/;
    engine = /^\s*(requires-python|python)\s*=\s*"([^"]+)"/;
  } else return out;
  const goMajor = (m: RegExpMatchArray) => (m[2] ? `v${m[2]}.0.0` : m[3]);
  const name = (m: RegExpMatchArray) => (/go\.mod$/.test(path) ? m[1] : m[1].toLowerCase());
  const ver = (m: RegExpMatchArray) => (/go\.mod$/.test(path) ? goMajor(m) : m[2]);
  const rem = pick(removed(hunks), re);
  const add = pick(added(hunks), re);
  for (const a of add) {
    if (/package\.json$/.test(path) && /^(version|name|node|npm|pnpm|yarn)$/.test(a.m[1])) continue;
    const r = rem.find((x) => name(x.m) === name(a.m));
    if (!r) continue;
    const va = major(ver(a.m)!);
    const vr = major(ver(r.m)!);
    if (va && vr && isBump(vr, va))
      out.push(mk("deps", path, "deps.major", "medium", `Major upgrade: ${name(a.m)} ${vr[0]}${vr[0] === 0 ? "." + vr[1] : ""} → ${va[0]}${va[0] === 0 ? "." + va[1] : ""}`, "Major versions may change behaviour or APIs; check the changelog.", a.l));
  }
  for (const r of rem) {
    if (/package\.json$/.test(path) && /^(version|name|node|npm|pnpm|yarn)$/.test(r.m[1])) continue;
    if (!add.some((a) => name(a.m) === name(r.m))) out.push(mk("deps", path, "deps.removed", "low", `Removes dependency ${name(r.m)}`, "Code still importing it fails to build or run.", r.l));
  }
  if (engine) {
    const er = pick(removed(hunks), engine);
    for (const a of pick(added(hunks), engine)) {
      const r = er.find((x) => x.m[1] === a.m[1]);
      if (r && r.m[2] !== a.m[2]) out.push(mk("deps", path, "deps.engine", "medium", `Changes ${a.m[1]} ${r.m[2]} → ${a.m[2]}`, "Build images and CI need the new runtime/toolchain.", a.l));
    }
  }
  return out;
}

/** Lockfiles that changed without their manifest. */
export function lockfileOnly(files: PRFile[]): Finding[] {
  const out: Finding[] = [];
  const dirs = new Map<string, PRFile[]>();
  for (const f of files) {
    const d = f.filename.includes("/") ? f.filename.slice(0, f.filename.lastIndexOf("/")) : "";
    dirs.set(d, [...(dirs.get(d) ?? []), f]);
  }
  for (const [, fs] of dirs) {
    const locks = fs.filter((f) => isLockfile(f.filename));
    const manifest = fs.some((f) => /(^|\/)(package\.json|go\.mod|pyproject\.toml|Pipfile|Cargo\.toml|Gemfile|composer\.json|requirements[^/]*\.txt)$/.test(f.filename));
    if (!manifest) for (const l of locks) out.push({ path: l.filename, rule: "deps.lockfile-only", category: "deps", severity: "low", title: "Lockfile-only change", why: "Resolved versions moved without a manifest change; usually a routine refresh." });
  }
  return out;
}
