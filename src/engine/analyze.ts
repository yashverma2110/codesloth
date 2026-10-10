import type { AnalyzeInput, Category, FileNode, Layer, LayerFile, LayerPlan, PRFile } from "./types";
import { classifyFile, detectLang } from "./classify";
import { parseGitAttributes } from "./glob";
import { contentFromAddedPatch, parsePatch } from "./patch";
import { extractJsImports } from "./imports/js";
import { extractVueImports } from "./imports/vue";
import { extractGoImports, goTopLevelDecls, stripGoComments } from "./imports/go";
import { extractPythonImports } from "./imports/python";
import { buildResolveContext, dirname, resolveGo, resolveJs, resolvePython } from "./resolve";
import { computeDepths } from "./graph";

export const ENGINE_VERSION = "0.1.0";

const MAX_CALLER_LEVELS = 4;
const SPLIT_LAYER_FILES = 25;

const short = (p: string) => p.split("/").slice(-2).join("/");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function listSome(paths: string[], label: (p: string) => string, max = 3): string {
  const head = paths.slice(0, max).map(label).join(", ");
  return paths.length > max ? `${head} +${paths.length - max} more` : head;
}

/** Stem used for test<->source pairing, e.g. "Button.test.tsx" -> "button", "test_user.py" -> "user". */
export function testStem(path: string): string {
  let b = baseName(path).toLowerCase();
  b = b.replace(/\.(d\.ts|[cm]?[jt]sx?|vue|py|pyi|go)$/, "");
  b = b.replace(/\.(test|spec|cy|e2e|unit|integration)$/, "");
  b = b.replace(/_test$/, "").replace(/^test_/, "");
  return b;
}

export function sourceStem(path: string): string {
  const b = baseName(path).toLowerCase().replace(/\.(d\.ts|[cm]?[jt]sx?|vue|py|pyi|go)$/, "").replace(/^_+(?=\w)/, "");
  return b === "index" || b === "__init__" ? baseName(dirname(path)).toLowerCase() : b;
}

interface Ctx {
  nodes: Map<string, FileNode>;
  contentsUsed: number;
  partial: string[];
}

function fileText(f: PRFile, input: AnalyzeInput, ctx: Ctx): string | undefined {
  const full = input.contents?.[f.filename];
  if (full !== undefined) {
    ctx.contentsUsed++;
    return full;
  }
  if (f.status === "added") return contentFromAddedPatch(f.patch);
  if (f.patch) {
    return parsePatch(f.patch).headView;
  }
  return undefined;
}

export function analyze(input: AnalyzeInput): LayerPlan {
  const warnings: string[] = [];
  const gitattributes = input.gitattributes ? parseGitAttributes(input.gitattributes) : undefined;
  const ctx: Ctx = { nodes: new Map(), contentsUsed: 0, partial: [] };
  const texts = new Map<string, string | undefined>();

  // 1) classify
  for (const f of input.files) {
    const text = f.status === "removed" ? undefined : fileText(f, input, ctx);
    texts.set(f.filename, text);
    const classification = classifyFile(f, { gitattributes, content: text });
    ctx.nodes.set(f.filename, {
      path: f.filename,
      previousPath: f.previous_filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      blobSha: f.sha,
      patchAvailable: !!f.patch,
      lang: detectLang(f.filename),
      classification,
      imports: [],
      dependsOn: [],
      dependents: [],
    });
  }

  // 2) imports + resolution (only for files that participate in the graph)
  const live = input.files.filter((f) => f.status !== "removed").map((f) => f.filename);
  const rctx = buildResolveContext(live, input.goMods);
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  const graphCats: Category[] = ["source", "contract", "test", "mechanical"];
  let edgeCount = 0;

  for (const n of ctx.nodes.values()) {
    if (n.status === "removed" || !graphCats.includes(n.classification.category)) continue;
    const text = texts.get(n.path);
    if (!text) continue;
    try {
      if (n.lang === "js" || n.lang === "vue") {
        const specs = n.lang === "vue" ? extractVueImports(text) : extractJsImports(text);
        n.imports = specs;
        for (const s of specs) {
          const hit = resolveJs(n.path, s, rctx);
          if (hit) addEdge(n.path, hit);
        }
      } else if (n.lang === "go") {
        const specs = extractGoImports(text);
        n.imports = specs;
        for (const s of specs) for (const hit of resolveGo(n.path, s, rctx)) addEdge(n.path, hit);
      } else if (n.lang === "python") {
        const imps = extractPythonImports(text);
        n.imports = imps.map((i) => i.module);
        for (const i of imps) for (const hit of resolvePython(n.path, i, rctx)) addEdge(n.path, hit);
      }
    } catch (e) {
      warnings.push(`Could not parse imports in ${n.path}: ${(e as Error).message}`);
    }
  }

  // 2b) Go same-package def-use: files in one package share identifiers without imports.
  for (const [dir, files] of rctx.goDirs) {
    const nonTest = files.filter((p) => !p.endsWith("_test.go") && ctx.nodes.get(p)?.classification.category === "source");
    if (nonTest.length < 2) continue;
    const newDecls = new Map<string, string>(); // symbol -> defining file (only symbols on added lines)
    const dup = new Set<string>();
    for (const p of nonTest) {
      const f = input.files.find((x) => x.filename === p);
      const addedText = f?.status === "added" ? texts.get(p) ?? "" : parsePatch(f?.patch).added.join("\n");
      for (const sym of goTopLevelDecls(addedText)) {
        if (sym.length < 3) continue;
        if (newDecls.has(sym) && newDecls.get(sym) !== p) dup.add(sym);
        newDecls.set(sym, p);
      }
    }
    for (const s of dup) newDecls.delete(s);
    if (!newDecls.size) continue;
    for (const p of nonTest) {
      const code = stripGoComments(texts.get(p) ?? "");
      const words = new Set(code.match(/\b[A-Za-z_]\w*\b/g) ?? []);
      for (const [sym, def] of newDecls) if (def !== p && words.has(sym)) addEdge(p, def);
    }
    void dir;
  }

  for (const [from, tos] of edges) {
    for (const to of tos) {
      edgeCount++;
      ctx.nodes.get(from)?.dependsOn.push(to);
      ctx.nodes.get(to)?.dependents.push(from);
    }
  }

  // 3) depths over source files only (contracts and tests are placed by category)
  const isSrc = (p: string) => ctx.nodes.get(p)?.classification.category === "source";
  const srcNodes = [...ctx.nodes.values()].filter((n) => n.classification.category === "source").map((n) => n.path);
  const srcEdges = new Map<string, Set<string>>();
  for (const [from, tos] of edges) {
    if (!isSrc(from)) continue;
    const t = [...tos].filter(isSrc);
    if (t.length) srcEdges.set(from, new Set(t));
  }
  // Go: a package (directory) is the unit of compilation and review, so keep its files in one layer
  // by linking them into a ring (they become one strongly connected component).
  const goPkgOf = new Map<string, string>();
  for (const [dir, files] of rctx.goDirs) {
    const pkg = files.filter((p) => !p.endsWith("_test.go") && isSrc(p)).sort();
    for (const p of pkg) goPkgOf.set(p, dir);
    if (pkg.length < 2) continue;
    pkg.forEach((p, i) => {
      const next = pkg[(i + 1) % pkg.length];
      if (!srcEdges.has(p)) srcEdges.set(p, new Set());
      srcEdges.get(p)!.add(next);
    });
  }
  const { depth, cycleOf } = computeDepths(srcNodes, srcEdges);
  const srcDependents = (p: string) => ctx.nodes.get(p)!.dependents.filter(isSrc);
  const srcDependsOn = (p: string) => ctx.nodes.get(p)!.dependsOn.filter(isSrc);

  // 4) bucket
  type Bucket = { key: string; title: string; description: string; order: number; files: string[] };
  const buckets = new Map<string, Bucket>();
  const put = (key: string, order: number, title: string, description: string, path: string) => {
    if (!buckets.has(key)) buckets.set(key, { key, title, description, order, files: [] });
    buckets.get(key)!.files.push(path);
  };
  const layerOf = new Map<string, string>(); // path -> bucket title (for reasons)

  const D = {
    mechanical: ["Mechanical changes", "Pure renames, copies and formatting-only edits. Skim to confirm nothing else changed."],
    contract: ["Contracts & schemas", "Types, schemas, migrations and API specs that other code builds on. Review these first."],
    core: ["Core", "Changed code that other changed files import, and which doesn't depend on other changed code."],
    standalone: ["Standalone changes", "Source changes with no import links to other files in this PR."],
    removed: ["Deleted code", "Source files removed by this PR. Check nothing still depends on them."],
    test: ["Tests", "Tests, ordered to follow the layers of the code they cover."],
    configdocs: ["Config, docs & assets", "Manifests, tooling/CI/infra config, documentation and static assets."],
    generated: ["Generated & lockfiles", "Lockfiles, build output, vendored and generated code. Usually skim-only."],
  } as const;

  const ORDER = { mechanical: 0, contract: 10, core: 20, caller: 30, standalone: 60, removed: 65, test: 70, configdocs: 80, generated: 90 };

  for (const n of ctx.nodes.values()) {
    const cat = n.classification.category;
    if (cat === "mechanical") put("mechanical", ORDER.mechanical, ...D.mechanical, n.path);
    else if (cat === "contract") put("contract", ORDER.contract, ...D.contract, n.path);
    else if (cat === "test") continue; // placed after
    else if (cat === "config" || cat === "docs") put("configdocs", ORDER.configdocs, ...D.configdocs, n.path);
    else if (cat === "generated") put("generated", ORDER.generated, ...D.generated, n.path);
    else if (n.status === "removed") put("removed", ORDER.removed, ...D.removed, n.path);
    else {
      const d = depth.get(n.path) ?? 0;
      const comp = cycleOf.get(n.path) ?? [n.path];
      const hasDependents = comp.some((q) => srcDependents(q).some((x) => !comp.includes(x)));
      if (d === 0 && !hasDependents) put("standalone", ORDER.standalone, ...D.standalone, n.path);
      else if (d === 0) put("core", ORDER.core, ...D.core, n.path);
      else {
        const lvl = Math.min(d, MAX_CALLER_LEVELS);
        const title = `Callers · level ${lvl}${d >= MAX_CALLER_LEVELS && lvl === MAX_CALLER_LEVELS ? "+" : ""}`;
        put(`caller${lvl}`, ORDER.caller + lvl, title, lvl === 1 ? "Code that imports the Core layer." : `Code that builds on callers one level below (import depth ${lvl}${lvl === MAX_CALLER_LEVELS ? "+" : ""}).`, n.path);
      }
    }
  }

  // 5) split oversized code layers by package/directory
  const splitKey = (p: string) => {
    const segs = p.split("/");
    const containers = new Set(["packages", "apps", "services", "libs", "lib", "modules", "cmd", "internal", "pkg", "src", "plugins", "components", "pages", "views", "app"]);
    if (segs.length > 2 && containers.has(segs[0])) return segs.slice(0, 2).join("/");
    return segs.length > 1 ? segs[0] : "(root)";
  };
  for (const b of [...buckets.values()]) {
    if (!/^(core|caller\d|standalone)$/.test(b.key) || b.files.length <= SPLIT_LAYER_FILES) continue;
    const groups = new Map<string, string[]>();
    for (const p of b.files) groups.set(splitKey(p), [...(groups.get(splitKey(p)) ?? []), p]);
    if (groups.size < 2) continue;
    buckets.delete(b.key);
    let k = 0;
    for (const [g, files] of [...groups.entries()].sort((a, c) => a[0].localeCompare(c[0]))) {
      buckets.set(`${b.key}:${g}`, { key: `${b.key}:${g}`, title: `${b.title} · ${g}`, description: b.description, order: b.order + k++ / 100, files });
    }
  }
  for (const b of buckets.values()) for (const p of b.files) layerOf.set(p, b.title);

  // 6) tests: pair with subject, order after code layers by subject order
  const bucketOrder = (p: string | undefined) => {
    if (!p) return 999;
    for (const b of buckets.values()) if (b.files.includes(p)) return b.order;
    return 999;
  };
  const allSource = [...ctx.nodes.values()].filter((n) => ["source", "contract"].includes(n.classification.category));
  const testFiles: { path: string; subject?: string; why?: string }[] = [];
  for (const n of ctx.nodes.values()) {
    if (n.classification.category !== "test") continue;
    const stem = testStem(n.path);
    const deps = n.dependsOn.filter((p) => ["source", "contract"].includes(ctx.nodes.get(p)?.classification.category ?? ""));
    let subject: string | undefined;
    let why: string | undefined;
    const byName = (cands: FileNode[]) =>
      cands
        .filter((s) => sourceStem(s.path) === stem)
        .sort((a, b) => commonDirScore(b.path, n.path) - commonDirScore(a.path, n.path))[0];
    const named = byName(deps.map((p) => ctx.nodes.get(p)!));
    if (named) {
      subject = named.path;
      why = `imports and is named after ${short(subject)}`;
    } else if (deps.length) {
      subject = deps.sort((a, b) => commonDirScore(b, n.path) - commonDirScore(a, n.path))[0];
      why = `imports ${listSome(deps, short)}`;
    } else {
      const s = byName(allSource);
      if (s) {
        subject = s.path;
        why = `named after ${short(s.path)}`;
      } else if (n.lang === "go") {
        const pkg = (rctx.goDirs.get(dirname(n.path)) ?? []).filter((p) => !p.endsWith("_test.go") && isSrc(p));
        if (pkg.length) {
          subject = pkg[0];
          why = `Go test for package ${dirname(n.path) || "(root)"}`;
        }
      }
    }
    n.testSubject = subject;
    testFiles.push({ path: n.path, subject, why });
  }
  testFiles.sort((a, b) => bucketOrder(a.subject) - bucketOrder(b.subject) || (a.subject ?? "~").localeCompare(b.subject ?? "~") || a.path.localeCompare(b.path));
  for (const t of testFiles) put("test", ORDER.test, ...D.test, t.path);

  // 7) reasons
  const lockfileManifests: Record<string, RegExp> = {
    "package-lock.json": /(^|\/)package\.json$/,
    "yarn.lock": /(^|\/)package\.json$/,
    "pnpm-lock.yaml": /(^|\/)package\.json$/,
    "go.sum": /(^|\/)go\.mod$/,
    "poetry.lock": /(^|\/)pyproject\.toml$/,
    "uv.lock": /(^|\/)pyproject\.toml$/,
    "pdm.lock": /(^|\/)pyproject\.toml$/,
    "pipfile.lock": /(^|\/)Pipfile$/,
    "bun.lock": /(^|\/)package\.json$/,
  };
  const reasonFor = (n: FileNode): string => {
    const cat = n.classification.category;
    const cyc = cycleOf.get(n.path);
    let cycNote = "";
    if (cyc) {
      const myPkg = goPkgOf.get(n.path);
      const others = cyc.filter((p) => p !== n.path && !(myPkg !== undefined && goPkgOf.get(p) === myPkg));
      if (myPkg !== undefined) cycNote = ` · Go package ${myPkg || "(root)"}/ kept together`;
      if (others.length) cycNote += ` · in an import cycle with ${listSome(others, short)} (kept together)`;
    }
    // Collapse Go deps to their package so "imports 9 files" reads as "imports pkg/".
    const label = (p: string) => (goPkgOf.has(p) && goPkgOf.get(p) !== goPkgOf.get(n.path) ? `${goPkgOf.get(p) || "(root)"}/` : short(p));
    const uniq = (ps: string[]) => {
      const seen = new Set<string>();
      return ps.filter((p) => {
        const k = label(p);
        if (seen.has(k) || goPkgOf.get(p) === goPkgOf.get(n.path) && goPkgOf.has(p)) return false;
        seen.add(k);
        return true;
      });
    };
    if (cat === "test") {
      const t = testFiles.find((x) => x.path === n.path)!;
      return t.subject ? `tests ${short(t.subject)} (${layerOf.get(t.subject) ?? "?"}): ${t.why}` : `${n.classification.reason}; no changed subject found`;
    }
    if (cat === "generated") {
      const lf = lockfileManifests[baseName(n.path).toLowerCase()];
      const dirOf = dirname(n.path);
      const manifest = lf ? [...ctx.nodes.keys()].find((p) => lf.test(p) && dirname(p) === dirOf) : undefined;
      return manifest ? `${n.classification.reason}; goes with the ${short(manifest)} change` : n.classification.reason;
    }
    if (cat === "contract") {
      const users = n.dependents.filter((p) => p !== n.path);
      return users.length ? `${n.classification.reason}; used by ${listSome(users, short)}` : n.classification.reason;
    }
    if (cat !== "source") return n.classification.reason;
    if (n.status === "removed") return "file deleted";
    const deps = uniq(srcDependsOn(n.path));
    const users = uniq(srcDependents(n.path));
    const contractDeps = n.dependsOn.filter((p) => ctx.nodes.get(p)?.classification.category === "contract");
    if (!deps.length && !users.length) {
      const c = contractDeps.length ? `; uses contracts ${listSome(contractDeps, short)}` : "";
      return cycNote ? `no links outside its package${c}${cycNote}` : `no import links to other changed source files${c}`;
    }
    if (!deps.length) return `used by ${listSome(users, label)}${cycNote}`;
    return `imports ${listSome(deps, (p) => `${label(p)} [${layerOf.get(p) ?? "?"}]`)}${users.length ? `; used by ${listSome(users, label)}` : ""}${cycNote}`;
  };

  // 8) assemble
  const sorted = [...buckets.values()].sort((a, b) => a.order - b.order);
  const layers: Layer[] = sorted.map((b, i) => {
    const files: LayerFile[] = b.files.map((p) => {
      const n = ctx.nodes.get(p)!;
      return {
        path: p,
        previousPath: n.previousPath,
        status: n.status,
        additions: n.additions,
        deletions: n.deletions,
        category: n.classification.category,
        reason: reasonFor(n),
      };
    });
    if (b.key !== "test") files.sort((x, y) => x.path.localeCompare(y.path));
    return {
      id: b.key,
      index: i,
      title: b.title,
      description: b.description,
      files,
      stats: {
        files: files.length,
        additions: files.reduce((s, f) => s + f.additions, 0),
        deletions: files.reduce((s, f) => s + f.deletions, 0),
      },
    };
  });

  for (const n of ctx.nodes.values()) {
    if (n.status === "added" || n.status === "removed" || n.lang === "other") continue;
    if (!["source", "contract", "test"].includes(n.classification.category)) continue;
    if (input.contents?.[n.path] === undefined && n.patchAvailable) ctx.partial.push(n.path);
  }
  const missingPatch = input.files.filter((f) => !f.patch && f.status !== "removed" && f.changes > 0).length;
  if (missingPatch) warnings.push(`${missingPatch} file(s) have no patch from the API (binary or too large); placed by path only.`);
  if (ctx.partial.length)
    warnings.push(`${ctx.partial.length} modified file(s) analysed from the diff only (full contents not fetched); imports outside changed hunks may be missed.`);

  return {
    version: 1,
    engineVersion: ENGINE_VERSION,
    layers,
    warnings,
    stats: {
      files: input.files.length,
      additions: input.files.reduce((s, f) => s + f.additions, 0),
      deletions: input.files.reduce((s, f) => s + f.deletions, 0),
      edges: edgeCount,
      contentsUsed: ctx.contentsUsed,
    },
  };
}

function commonDirScore(a: string, b: string): number {
  const as = a.split("/"), bs = b.split("/");
  let i = 0;
  while (i < as.length - 1 && i < bs.length - 1 && as[i] === bs[i]) i++;
  return i;
}

/** Which files would benefit from fetching full contents (modified source/test/contract files whose imports matter). */
export function filesNeedingContents(files: PRFile[], max: number): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.status === "removed" || f.status === "added") continue;
    if (detectLang(f.filename) === "other") continue;
    const c = classifyFile(f).category;
    if (c === "generated" || c === "docs" || c === "config") continue;
    if (c === "mechanical" && f.changes === 0) continue;
    out.push(f.filename);
    if (out.length >= max) break;
  }
  return out;
}
