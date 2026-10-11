import type { AnalyzeInput, Category, FileNode, Layer, LayerFile, LayerPlan, PlanEdge, PRFile } from "./types";
import { classifyFile, detectLang } from "./classify";
import { parseGitAttributes } from "./glob";
import { contentFromAddedPatch, parsePatch } from "./patch";
import { extractJsImports } from "./imports/js";
import { extractVueImports } from "./imports/vue";
import { extractGoImports, goTopLevelDecls, stripGoComments } from "./imports/go";
import { extractPythonImports } from "./imports/python";
import { buildResolveContext, dirname, resolveGo, resolveJs, resolvePython } from "./resolve";
import { computeDepths } from "./graph";
import { aKind, CALLER_HEADINGS, capitalize, contractKind, contractKindsPhrase, fileLabel, isLockfile, namesList, plural } from "./copy";

export const ENGINE_VERSION = "0.3.1";

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
  // A second context that also knows the deleted files, used only to detect changed files that
  // still import something this PR deletes.
  const removedSet = new Set(input.files.filter((f) => f.status === "removed").map((f) => f.filename));
  const rctxAll = removedSet.size ? buildResolveContext(input.files.map((f) => f.filename), input.goMods) : rctx;
  const removedUsers = new Map<string, Set<string>>();
  // Deleted Go files whose package still has files: imports resolve to the package, so the graph
  // can't tell whether anything still uses what was deleted.
  const removedUnverifiable = new Set(
    [...removedSet].filter((p) => p.endsWith(".go") && !p.endsWith("_test.go") && live.some((q) => q.endsWith(".go") && dirname(q) === dirname(p))),
  );
  const noteRemoved = (from: string, hits: string[]) => {
    if (!removedSet.size || !hits.length || !hits.every((h) => removedSet.has(h))) return;
    for (const h of hits) {
      if (!removedUsers.has(h)) removedUsers.set(h, new Set());
      removedUsers.get(h)!.add(from);
    }
  };
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
          else if (removedSet.size) {
            const gone = resolveJs(n.path, s, rctxAll);
            if (gone) noteRemoved(n.path, [gone]);
          }
        }
      } else if (n.lang === "go") {
        const specs = extractGoImports(text);
        n.imports = specs;
        for (const s of specs) {
          const hits = resolveGo(n.path, s, rctx);
          for (const hit of hits) addEdge(n.path, hit);
          if (!hits.length && removedSet.size) noteRemoved(n.path, resolveGo(n.path, s, rctxAll));
        }
      } else if (n.lang === "python") {
        const imps = extractPythonImports(text);
        n.imports = imps.map((i) => i.module);
        for (const i of imps) {
          const hits = resolvePython(n.path, i, rctx);
          for (const hit of hits) addEdge(n.path, hit);
          if (!hits.length && removedSet.size) noteRemoved(n.path, resolvePython(n.path, i, rctxAll));
        }
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
  type Kind = "mechanical" | "contract" | "core" | "caller" | "standalone" | "removed" | "test" | "configdocs" | "generated";
  type Bucket = { key: string; kind: Kind; level?: number; area?: string; order: number; files: string[] };
  const buckets = new Map<string, Bucket>();
  const put = (key: string, order: number, kind: Kind, path: string, level?: number) => {
    if (!buckets.has(key)) buckets.set(key, { key, kind, level, order, files: [] });
    buckets.get(key)!.files.push(path);
  };

  const ORDER = { mechanical: 0, contract: 10, core: 20, caller: 30, standalone: 60, removed: 65, test: 70, configdocs: 80, generated: 90 };

  for (const n of ctx.nodes.values()) {
    const cat = n.classification.category;
    if (cat === "mechanical") put("mechanical", ORDER.mechanical, "mechanical", n.path);
    else if (cat === "contract") put("contract", ORDER.contract, "contract", n.path);
    else if (cat === "test") continue; // placed after
    else if (cat === "config" || cat === "docs") put("configdocs", ORDER.configdocs, "configdocs", n.path);
    else if (cat === "generated") put("generated", ORDER.generated, "generated", n.path);
    else if (n.status === "removed") put("removed", ORDER.removed, "removed", n.path);
    else {
      const d = depth.get(n.path) ?? 0;
      const comp = cycleOf.get(n.path) ?? [n.path];
      const hasDependents = comp.some((q) => srcDependents(q).some((x) => !comp.includes(x)));
      if (d === 0 && !hasDependents) put("standalone", ORDER.standalone, "standalone", n.path);
      else if (d === 0) put("core", ORDER.core, "core", n.path);
      else {
        const lvl = Math.min(d, MAX_CALLER_LEVELS);
        put(`caller${lvl}`, ORDER.caller + lvl, "caller", n.path, lvl);
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
      buckets.set(`${b.key}:${g}`, { ...b, key: `${b.key}:${g}`, area: g, order: b.order + k++ / 100, files });
    }
  }

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
  for (const t of testFiles) put("test", ORDER.test, "test", t.path);

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
  const allPaths = [...ctx.nodes.keys()];
  const lbl = (p: string) => fileLabel(p, allPaths);
  const reasonFor = (n: FileNode): string => {
    const cat = n.classification.category;
    const cyc = cycleOf.get(n.path);
    const notes: string[] = [];
    if (cyc) {
      const myPkg = goPkgOf.get(n.path);
      const others = cyc.filter((p) => p !== n.path && !(myPkg !== undefined && goPkgOf.get(p) === myPkg));
      if (myPkg !== undefined && (rctx.goDirs.get(myPkg) ?? []).filter((q) => goPkgOf.has(q)).length >= 2) notes.push(`kept with the rest of Go package ${myPkg || "(root)"}/`);
      if (others.length) notes.push(`in an import cycle with ${namesList(others, lbl)}, so kept together`);
    }
    // Collapse Go deps to their package so "uses 9 files" reads as "uses pkg/".
    const label = (p: string) => (goPkgOf.has(p) && goPkgOf.get(p) !== goPkgOf.get(n.path) ? (goPkgOf.get(p) ? `${goPkgOf.get(p)}/` : "the root package") : lbl(p));
    const notSamePkg = (ps: string[]) => ps.filter((p) => !(goPkgOf.has(p) && goPkgOf.get(p) === goPkgOf.get(n.path)));
    const tail = notes.length ? ` · ${capitalize(notes.join("; "))}` : "";
    if (cat === "test") {
      const t = testFiles.find((x) => x.path === n.path)!;
      if (!t.subject) return `${capitalize(n.classification.reason)}, with no matching changed file`;
      if (t.why?.startsWith("Go test for package")) return `Tests for Go package ${dirname(n.path) || "(root)"}/`;
      return t.why?.startsWith("named after") ? `Tests for ${lbl(t.subject)} (matched by name)` : `Tests for ${lbl(t.subject)}`;
    }
    if (cat === "generated") {
      const lf = lockfileManifests[baseName(n.path).toLowerCase()];
      const dirOf = dirname(n.path);
      const manifest = lf ? [...ctx.nodes.keys()].find((p) => lf.test(p) && dirname(p) === dirOf) : undefined;
      if (manifest) return `Lockfile for the ${lbl(manifest)} change`;
      return isLockfile(n.path) ? "Lockfile (no matching manifest change in this PR)" : capitalize(n.classification.reason);
    }
    if (cat === "contract") {
      const users = n.dependents.filter((p) => p !== n.path);
      const kind = capitalize(contractKind(n.path, n.classification.reason));
      return users.length ? `${kind} · Imported by ${namesList(users, lbl)}` : `${kind} · ${capitalize(n.classification.reason)}`;
    }
    if (cat !== "source") return capitalize(n.classification.reason);
    if (n.status === "removed") {
      const u = [...(removedUsers.get(n.path) ?? [])];
      if (u.length) return `Deleted, but still imported by ${namesList(u, lbl)}`;
      if (removedUnverifiable.has(n.path)) return `Deleted from Go package ${dirname(n.path) || "(root)"}/, which still exists; check nothing else in it still uses this code`;
      return "Deleted; no changed file imports it";
    }
    const deps = notSamePkg(srcDependsOn(n.path));
    const users = notSamePkg(srcDependents(n.path));
    const contractDeps = n.dependsOn.filter((p) => ctx.nodes.get(p)?.classification.category === "contract");
    const parts: string[] = [];
    if (deps.length) parts.push(`Uses ${namesList(deps, label)}`);
    if (users.length) parts.push(`${parts.length ? "imported" : "Imported"} by ${namesList(users, label)}`);
    if (!parts.length) {
      parts.push(cyc && goPkgOf.has(n.path) ? "No links outside its package" : "No imports to or from other changed code");
      if (contractDeps.length) parts.push(`uses ${namesList(contractDeps, lbl)}`);
    }
    return parts.join("; ") + tail;
  };

  // 8) groups + edges for the graph view
  const groupOf = new Map<string, string>();
  for (const [p, dir] of goPkgOf) if ((rctx.goDirs.get(dir) ?? []).filter((q) => goPkgOf.has(q)).length >= 2) groupOf.set(p, `pkg:${dir || "(root)"}`);
  const cycles = [...new Set(cycleOf.values())];
  cycles.forEach((c, i) => {
    const nonPkg = c.filter((p) => !groupOf.has(p));
    if (nonPkg.length >= 2) for (const p of nonPkg) groupOf.set(p, `cycle:${i}`);
  });
  const planEdges: PlanEdge[] = [];
  const pairs = new Set(testFiles.filter((t) => t.subject).map((t) => `${t.path}->${t.subject}`));
  for (const [from, tos] of edges) for (const to of tos) if (!pairs.has(`${from}->${to}`)) planEdges.push({ from, to, kind: "import" });
  for (const t of testFiles) if (t.subject) planEdges.push({ from: t.path, to: t.subject, kind: "test" });

  // 9) assemble
  const sorted = [...buckets.values()].sort((a, b) => a.order - b.order);
  const copy = layerCopyFor(sorted, {
    nodes: ctx.nodes,
    testSubjects: new Map(testFiles.filter((t) => t.subject).map((t) => [t.path, t.subject!])),
    removedUsers,
    removedUnverifiable,
    isSrc,
  });
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
        sha: n.blobSha,
        ...(groupOf.has(p) ? { group: groupOf.get(p) } : {}),
      };
    });
    if (b.key !== "test") files.sort((x, y) => x.path.localeCompare(y.path));
    return {
      id: b.key,
      index: i,
      title: copy[i].title,
      label: copy[i].label,
      description: copy[i].because,
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
    edges: planEdges,
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


interface CopyCtx {
  nodes: Map<string, FileNode>;
  testSubjects: Map<string, string>;
  removedUsers: Map<string, Set<string>>;
  removedUnverifiable: Set<string>;
  isSrc: (p: string) => boolean;
}

interface LayerCopy {
  title: string;
  label: string;
  because: string;
}

/** Headings ("Review this first", "Then review these"...) and "because" lines from real plan data. */
function layerCopyFor(buckets: { key: string; kind: string; level?: number; area?: string; files: string[] }[], c: CopyCtx): LayerCopy[] {
  let reviewedSomething = false; // has a layer before this one asked for a real review?
  // import depth of code layers: core = 0, callers = their level (for "uses X from the step before")
  const levelOf = new Map<string, number>();
  for (const b of buckets) for (const p of b.files) if (b.kind === "core") levelOf.set(p, 0);
  else if (b.kind === "caller") levelOf.set(p, b.level ?? 1);
  const out: LayerCopy[] = [];
  const these = (n: number) => (n === 1 ? "this file" : "these files");
  const inArea = (b: { area?: string }) => (b.area ? ` in ${b.area}/` : "");
  for (const b of buckets) {
    const n = b.files.length;
    const files = b.files.map((p) => c.nodes.get(p)!);
    const outside = (paths: string[]) => [...new Set(paths)].filter((p) => !b.files.includes(p));
    let t: LayerCopy;
    switch (b.kind) {
      case "mechanical": {
        const renames = files.filter((f) => f.classification.kind === "rename-only" || f.classification.kind === "copy-only").length;
        const fmt = n - renames;
        const what =
          n === 1
            ? renames ? "a pure rename" : "a formatting-only edit"
            : [renames ? plural(renames, "pure rename") : "", fmt ? plural(fmt, "formatting-only edit") : ""].filter(Boolean).join(" and ");
        const it = n === 1 ? "this" : "these";
        t = { title: reviewedSomething ? `Skim ${it}` : `Skim ${it} first`, label: "Mechanical", because: `As ${n === 1 ? "this is" : "these are"} ${what} with no other changes` };
        break;
      }
      case "contract": {
        const kinds = files.map((f) => contractKind(f.path, f.classification.reason));
        const users = outside(files.flatMap((f) => f.dependents));
        const phrase = n === 1 ? aKind(kinds[0]) : contractKindsPhrase(kinds);
        const are = n === 1 ? "this is" : "these are";
        t = {
          title: reviewedSomething ? "Review this next" : "Review this first",
          label: "Contracts",
          because: users.length ? `As ${are} ${phrase} that ${plural(users.length, "other changed file")} ${users.length === 1 ? "builds" : "build"} on` : `As ${are} ${phrase} everything else builds on`,
        };
        reviewedSomething = true;
        break;
      }
      case "core": {
        const users = outside(files.flatMap((f) => f.dependents));
        t = {
          title: reviewedSomething ? "Review this next" : "Review this first",
          label: b.area ? `Core · ${b.area}` : "Core",
          because: `As ${these(n)}${inArea(b)} ${n === 1 ? "is" : "are"} imported by ${plural(users.length, "other changed file")}`,
        };
        reviewedSomething = true;
        break;
      }
      case "caller": {
        const lvl = b.level ?? 1;
        const title = CALLER_HEADINGS[Math.min(lvl, CALLER_HEADINGS.length) - 1];
        const usesPrev = outside(files.flatMap((f) => f.dependsOn)).filter((p) => levelOf.get(p) === lvl - 1);
        let because: string;
        if (lvl === 1 && !b.area) because = n === 1 ? "As this uses the changes you just reviewed" : "As these use the changes you just reviewed";
        else if (lvl === 1) because = `As ${these(n)}${inArea(b)} use${n === 1 ? "s" : ""} the changes you just reviewed`;
        else if (usesPrev.length) because = `As ${these(n)}${inArea(b)} use${n === 1 ? "s" : ""} ${namesList(usesPrev, (p) => fileLabel(p))} from the step before`;
        else because = `As ${these(n)}${inArea(b)} build${n === 1 ? "s" : ""} on the step before`;
        t = { title, label: `Callers ${lvl}${b.area ? ` · ${b.area}` : ""}`, because };
        reviewedSomething = true;
        break;
      }
      case "standalone":
        t = {
          title: reviewedSomething ? "Then review these on their own" : "Review these first",
          label: b.area ? `Standalone · ${b.area}` : "Standalone",
          because: `As ${these(n)}${inArea(b)} ${n === 1 ? "doesn't" : "don't"} import, and ${n === 1 ? "isn't" : "aren't"} imported by, other changed code`,
        };
        reviewedSomething = true;
        break;
      case "removed": {
        const still = [...new Set(b.files.flatMap((p) => [...(c.removedUsers.get(p) ?? [])]))];
        const unknown = b.files.filter((p) => c.removedUnverifiable.has(p)).length;
        let because: string;
        if (still.length) because = `As this code was deleted, but ${plural(still.length, "changed file")} still ${still.length === 1 ? "imports" : "import"} it: check ${namesList(still, (p) => fileLabel(p))}`;
        else if (!unknown) because = "As this code was deleted and nothing changed still depends on it";
        else if (unknown === n) because = "As this code was deleted from Go packages that still exist, so check nothing still uses it";
        else because = `As this code was deleted; no changed file imports it, but ${plural(unknown, "file")} came from ${unknown === 1 ? "a Go package that still exists, so check it" : "Go packages that still exist, so check those"}`;
        t = { title: "Then check what was removed", label: "Deleted", because };
        break;
      }
      case "test": {
        const subjects = new Set(b.files.map((p) => c.testSubjects.get(p)).filter((x): x is string => !!x));
        const orphan = b.files.filter((p) => !c.testSubjects.has(p)).length;
        let because = subjects.size ? `As these cover the ${plural(subjects.size, "file")} above` : "As these are the tests changed in this PR";
        if (subjects.size === 1) because = "As these cover the file above";
        if (subjects.size && orphan) because += ` (${plural(orphan, "test file")} ${orphan === 1 ? "has" : "have"} no matching changed file)`;
        if (n === 1) because = because.replace(/^As these cover/, "As this covers");
        t = { title: "Now the tests", label: "Tests", because };
        break;
      }
      case "configdocs": {
        const cfg = files.filter((f) => f.classification.category === "config").length;
        const docs = n - cfg;
        const assets = files.filter((f) => f.classification.kind === "asset").length;
        const docWord = assets && assets === docs ? "assets" : assets ? "docs and assets" : "docs";
        if (cfg && docs) t = { title: "Then config and docs", label: "Config & docs", because: `As these are settings and ${docWord} for this change` };
        else if (cfg) t = { title: "Then the config", label: "Config", because: `As ${n === 1 ? "this is a setting" : "these are settings"} for this change` };
        else t = { title: `Then the ${docWord}`, label: capitalize(docWord), because: `As ${n === 1 ? "this is" : "these are"} ${docWord} for this change` };
        break;
      }
      default: {
        const locks = b.files.filter(isLockfile).length;
        const gen = n - locks;
        const what = locks && gen ? "generated files and lockfiles" : locks ? (locks === 1 ? "a lockfile" : "lockfiles") : gen === 1 ? "a generated file" : "generated files";
        t = { title: "Skim last", label: "Generated", because: `As ${n === 1 ? "this is" : "these are"} ${what}` };
      }
    }
    out.push(t);
  }
  return out;
}
