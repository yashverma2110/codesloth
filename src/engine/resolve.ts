import type { PyImport } from "./imports/python";

export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Normalize a POSIX path, resolving "." and "..". Returns null if it escapes the root. */
export function normalize(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".d.ts", ".json", ".css", ".scss", ".sass", ".less"];

export interface ResolveContext {
  /** All changed file paths at head (excluding removed). */
  changed: Set<string>;
  /** Index: path without extension -> paths (for extension-less matching). */
  byStem: Map<string, string[]>;
  /** go.mod module paths: module dir ("" for root) -> module path. */
  goModules: { dir: string; module: string }[];
  /** Changed Go files grouped by directory. */
  goDirs: Map<string, string[]>;
  /** Path alias prefixes, e.g. "@/" -> ["src/"] */
  aliases: [string, string[]][];
}

const stripExt = (p: string) => p.replace(/\.(d\.ts|[cm]?[jt]sx?|vue|json|css|scss|sass|less|py|pyi|go)$/, "");

export function buildResolveContext(paths: string[], goMods: Record<string, string> = {}): ResolveContext {
  const changed = new Set(paths);
  const byStem = new Map<string, string[]>();
  const goDirs = new Map<string, string[]>();
  for (const p of paths) {
    const s = stripExt(p);
    byStem.set(s, [...(byStem.get(s) ?? []), p]);
    if (p.endsWith(".go")) {
      const d = dirname(p);
      goDirs.set(d, [...(goDirs.get(d) ?? []), p]);
    }
  }
  const goModules: { dir: string; module: string }[] = [];
  for (const [path, text] of Object.entries(goMods)) {
    const m = /^\s*module\s+(\S+)/m.exec(text);
    if (m) goModules.push({ dir: dirname(path), module: m[1] });
  }
  goModules.sort((a, b) => b.dir.length - a.dir.length);
  // Common Vue/Nuxt/Vite aliases. Week 2: read tsconfig/jsconfig "paths" and vite.config aliases.
  const aliases: [string, string[]][] = [
    ["@/", ["src/"]],
    ["~/", ["src/", ""]],
    ["@@/", [""]],
    ["~~/", [""]],
    ["src/", ["src/"]],
  ];
  return { changed, byStem, goModules, goDirs, aliases };
}

function tryJsCandidates(base: string, ctx: ResolveContext): string | undefined {
  if (ctx.changed.has(base)) return base;
  for (const e of JS_EXTS) if (ctx.changed.has(base + e)) return base + e;
  for (const e of JS_EXTS) if (ctx.changed.has(base + "/index" + e)) return base + "/index" + e;
  // ESM TS convention: import "./x.js" that is really ./x.ts
  const m = /\.(m|c)?js$/.exec(base);
  if (m) {
    const s = base.slice(0, -m[0].length);
    for (const e of [".ts", ".tsx", ".mts", ".cts"]) if (ctx.changed.has(s + e)) return s + e;
  }
  return undefined;
}

/** Resolve a JS/TS/Vue import specifier to a changed file, or undefined (external or unchanged). */
export function resolveJs(fromPath: string, spec: string, ctx: ResolveContext): string | undefined {
  const clean = spec.split("?")[0];
  if (clean.startsWith(".")) {
    const n = normalize(dirname(fromPath) + "/" + clean);
    return n === null ? undefined : tryJsCandidates(n, ctx);
  }
  if (clean.startsWith("/")) return tryJsCandidates(clean.slice(1), ctx);
  for (const [prefix, targets] of ctx.aliases) {
    if (!clean.startsWith(prefix)) continue;
    const rest = clean.slice(prefix.length);
    // In a monorepo the alias is relative to the package root: try the nearest ancestor containing a match.
    const fromDirs = ancestors(dirname(fromPath));
    for (const d of fromDirs) {
      for (const t of targets) {
        const hit = tryJsCandidates(normalize((d ? d + "/" : "") + t + rest) ?? "", ctx);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  for (;;) {
    out.push(d);
    if (!d) break;
    d = dirname(d);
  }
  return out;
}

/** Resolve a Go import path to the changed non-test .go files in that package directory. */
export function resolveGo(fromPath: string, importPath: string, ctx: ResolveContext): string[] {
  const fromDir = dirname(fromPath);
  let dir: string | undefined;
  for (const m of ctx.goModules) {
    if (importPath === m.module || importPath.startsWith(m.module + "/")) {
      const rel = importPath.slice(m.module.length).replace(/^\//, "");
      dir = normalize((m.dir ? m.dir + "/" : "") + rel) ?? undefined;
      break;
    }
  }
  if (dir === undefined) {
    // No go.mod known: longest changed directory that is a suffix of the import path.
    let best = "";
    for (const d of ctx.goDirs.keys()) {
      if (!d) continue;
      if ((importPath === d || importPath.endsWith("/" + d)) && d.length > best.length) best = d;
    }
    if (best) dir = best;
  }
  if (dir === undefined || dir === fromDir) return [];
  return (ctx.goDirs.get(dir) ?? []).filter((p) => !p.endsWith("_test.go"));
}

function pyCandidates(modPath: string): string[] {
  return [modPath + ".py", modPath + ".pyi", modPath + "/__init__.py"];
}

function commonPrefixLen(a: string, b: string): number {
  const as = a.split("/"), bs = b.split("/");
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i++;
  return i;
}

function findPySuffix(cands: string[], ctx: ResolveContext, fromPath: string): string | undefined {
  for (const c of cands) if (ctx.changed.has(c)) return c;
  // absolute imports in repos with src/ layouts or nested packages: match by path suffix,
  // preferring the candidate that shares the longest directory prefix with the importing file.
  let best: string | undefined;
  let bestScore = -1;
  for (const p of ctx.changed) {
    for (const c of cands) {
      if (!p.endsWith("/" + c)) continue;
      const score = commonPrefixLen(p, fromPath) * 1000 - p.length;
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
  }
  return best;
}

/** Resolve a Python import to changed files (module and, for `from pkg import mod`, submodules). */
export function resolvePython(fromPath: string, imp: PyImport, ctx: ResolveContext): string[] {
  const out = new Set<string>();
  const dots = /^\.*/.exec(imp.module)![0].length;
  const rest = imp.module.slice(dots).replace(/\./g, "/");
  let baseDir: string | null = "";
  if (dots > 0) {
    let d = dirname(fromPath);
    for (let i = 1; i < dots; i++) d = dirname(d);
    baseDir = d;
  }
  const modPath = dots > 0 ? normalize((baseDir ? baseDir + "/" : "") + rest) ?? "" : rest;
  const exact = (cands: string[]) => (dots > 0 ? cands.find((c) => ctx.changed.has(c)) : findPySuffix(cands, ctx, fromPath));
  if (modPath) {
    const hit = exact(pyCandidates(modPath));
    if (hit) out.add(hit);
  }
  for (const name of imp.names) {
    const sub = (modPath ? modPath + "/" : "") + name;
    const hit = exact(pyCandidates(sub));
    if (hit) out.add(hit);
  }
  out.delete(fromPath);
  return [...out];
}
