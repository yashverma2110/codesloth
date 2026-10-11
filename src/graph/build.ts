/** Turn a LayerPlan into graph nodes/edges for the Graph view. Pure; no DOM. */
import type { LayerPlan, LayerFile } from "../engine/types";

export type NodeKind = "file" | "cluster" | "generated";

export interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Files represented by this node (one for file nodes). */
  paths: string[];
  layerIndex: number;
  layerId: string;
  layerTitle: string;
  /** Short layer name, e.g. "Core". */
  layerLabel: string;
  additions: number;
  deletions: number;
  status?: LayerFile["status"];
  reason?: string;
  /** Visual group key (Go package / import cycle) for file nodes. */
  group?: string;
  reviewed: boolean;
  changed: boolean;
  /** Worst risky-change severity among the node's files (amber/red ring). */
  risk?: "high" | "medium" | "low";
}

/**
 * One edge per node pair (undirected): several imports between the same two files, an import plus a test pairing,
 * or imports both ways all collapse into one line. Direction is shown by the layering (upper steps are what lower
 * steps build on), not by arrowheads.
 */
export interface GEdge {
  /** The importer / test side of the first link seen (usually the lower node). */
  from: string;
  to: string;
  /** "test" when any link in the pair is a test pairing (drawn dashed), else "import". */
  kind: "import" | "test";
  /** How many file-level links this edge stands for (imports + test pairings, both directions, after clustering). */
  count: number;
  imports: number;
  tests: number;
  /** Links go both ways (import cycle). */
  mutual: boolean;
}

export interface GLayer {
  index: number;
  id: string;
  title: string;
  label: string;
  files: number;
  hidden: boolean;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  layers: GLayer[];
  neighbors: Map<string, Set<string>>;
  /** Number of files folded into directory clusters because the PR is large. */
  clusteredFiles: number;
  totalFiles: number;
}

export interface BuildOptions {
  /** Collapse the generated/lockfile layer into a single node (default true). */
  collapseGenerated?: boolean;
  /** Node ids (cluster ids or "generated") the user expanded. */
  expanded?: ReadonlySet<string>;
  hiddenLayers?: ReadonlySet<string>;
  reviewedLayers?: ReadonlySet<string>;
  /** Files marked reviewed (a node is dimmed when all its files are). */
  reviewedPaths?: ReadonlySet<string>;
  changedPaths?: ReadonlySet<string>;
  /** Risky files: path -> worst active severity. */
  risk?: ReadonlyMap<string, "high" | "medium" | "low">;
  /** Above this many nodes, files are clustered by directory (default 160). */
  maxNodes?: number;
}

export const GENERATED_NODE = "generated";
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirPrefix = (p: string, depth: number) => dirname(p).split("/").filter(Boolean).slice(0, depth).join("/");

export function clusterId(layerId: string, dir: string) {
  return `cluster:${layerId}:${dir}`;
}

export function buildGraph(plan: LayerPlan, opts: BuildOptions = {}): Graph {
  const collapseGenerated = opts.collapseGenerated ?? true;
  const expanded = opts.expanded ?? new Set<string>();
  const hidden = opts.hiddenLayers ?? new Set<string>();
  const reviewed = opts.reviewedLayers ?? new Set<string>();
  const changed = opts.changedPaths ?? new Set<string>();
  const maxNodes = opts.maxNodes ?? 160;

  const layers: GLayer[] = plan.layers.map((l) => ({ index: l.index, id: l.id, title: l.title, label: l.label ?? l.title, files: l.files.length, hidden: hidden.has(l.id) }));
  const visible = plan.layers.filter((l) => !hidden.has(l.id));
  const nodeOf = new Map<string, string>(); // path -> node id
  const nodes: GNode[] = [];

  const fileNode = (l: (typeof plan.layers)[number], f: LayerFile): GNode => ({
    id: f.path,
    kind: "file",
    label: basename(f.path),
    paths: [f.path],
    layerIndex: l.index,
    layerId: l.id,
    layerTitle: l.title,
    layerLabel: l.label ?? l.title,
    additions: f.additions,
    deletions: f.deletions,
    status: f.status,
    reason: f.reason,
    group: f.group,
    reviewed: reviewed.has(l.id),
    changed: changed.has(f.path),
  });

  // Count candidate nodes to decide clustering depth.
  const isGenCollapsed = (id: string) => collapseGenerated && id === "generated" && !expanded.has(GENERATED_NODE);
  const fileCount = visible.reduce((s, l) => s + (isGenCollapsed(l.id) ? 1 : l.files.length), 0);

  // Find the finest directory depth that brings the node count under the cap.
  let depth = Infinity;
  if (fileCount > maxNodes) {
    const maxDepth = Math.max(1, ...visible.flatMap((l) => l.files.map((f) => dirname(f.path).split("/").length)));
    depth = 1;
    for (let d = maxDepth; d >= 1; d--) {
      if (countWithClusters(visible, d, new Set(), isGenCollapsed) <= maxNodes) {
        depth = d;
        break;
      }
    }
  }

  let clusteredFiles = 0;
  for (const l of visible) {
    if (isGenCollapsed(l.id)) {
      const n: GNode = {
        id: GENERATED_NODE,
        kind: "generated",
        label: l.files.length === 1 ? "1 generated file / lockfile" : `${l.files.length} generated files / lockfiles`,
        paths: l.files.map((f) => f.path),
        layerIndex: l.index,
        layerId: l.id,
        layerTitle: l.title,
    layerLabel: l.label ?? l.title,
        additions: l.stats.additions,
        deletions: l.stats.deletions,
        reason: `${l.description}. Collapsed by default; click to expand.`,
        reviewed: reviewed.has(l.id),
        changed: l.files.some((f) => changed.has(f.path)),
      };
      nodes.push(n);
      for (const f of l.files) nodeOf.set(f.path, n.id);
      continue;
    }
    if (depth === Infinity) {
      for (const f of l.files) {
        nodes.push(fileNode(l, f));
        nodeOf.set(f.path, f.path);
      }
      continue;
    }
    const byDir = new Map<string, LayerFile[]>();
    for (const f of l.files) {
      const d = dirPrefix(f.path, depth);
      byDir.set(d, [...(byDir.get(d) ?? []), f]);
    }
    for (const [d, fs] of byDir) {
      const cid = clusterId(l.id, d);
      if (fs.length < 2 || expanded.has(cid)) {
        for (const f of fs) {
          nodes.push(fileNode(l, f));
          nodeOf.set(f.path, f.path);
        }
        continue;
      }
      clusteredFiles += fs.length;
      nodes.push({
        id: cid,
        kind: "cluster",
        label: `${d || "(root)"}/ (${fs.length})`,
        paths: fs.map((f) => f.path),
        layerIndex: l.index,
        layerId: l.id,
        layerTitle: l.title,
    layerLabel: l.label ?? l.title,
        additions: fs.reduce((s, f) => s + f.additions, 0),
        deletions: fs.reduce((s, f) => s + f.deletions, 0),
        reason: `${fs.length} files in ${d || "(root)"}/, grouped because the PR is large; click to expand.`,
        reviewed: reviewed.has(l.id),
        changed: fs.some((f) => changed.has(f.path)),
      });
      for (const f of fs) nodeOf.set(f.path, cid);
    }
  }

  // Edges, re-mapped onto (possibly clustered) nodes and merged per unordered node pair.
  const agg = new Map<string, GEdge>();
  const seen = new Set<string>();
  for (const e of plan.edges ?? []) {
    const a = nodeOf.get(e.from);
    const b = nodeOf.get(e.to);
    if (!a || !b || a === b) continue;
    // The same file-level link listed twice (e.g. two import statements) counts once.
    const raw = `${e.from}\u0000${e.to}\u0000${e.kind}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    let ex = agg.get(k);
    if (!ex) agg.set(k, (ex = { from: a, to: b, kind: "import", count: 0, imports: 0, tests: 0, mutual: false }));
    ex.count++;
    if (e.kind === "test") ex.tests++;
    else ex.imports++;
    if (ex.tests) ex.kind = "test";
    if (ex.from !== a) ex.mutual = ex.mutual || e.kind === "import";
  }
  const edges = [...agg.values()];
  const neighbors = new Map<string, Set<string>>();
  for (const n of nodes) neighbors.set(n.id, new Set());
  for (const e of edges) {
    neighbors.get(e.from)!.add(e.to);
    neighbors.get(e.to)!.add(e.from);
  }
  if (opts.risk?.size)
    for (const n of nodes) {
      const sev = n.paths.map((p) => opts.risk!.get(p)).filter(Boolean);
      n.risk = sev.includes("high") ? "high" : sev.includes("medium") ? "medium" : sev.length ? "low" : undefined;
    }
  if (opts.reviewedPaths?.size) for (const n of nodes) if (!n.reviewed && n.paths.length && n.paths.every((p) => opts.reviewedPaths!.has(p))) n.reviewed = true;
  return { nodes, edges, layers, neighbors, clusteredFiles, totalFiles: plan.layers.reduce((s, l) => s + l.files.length, 0) };
}

function countWithClusters(visible: LayerPlan["layers"], depth: number, expanded: ReadonlySet<string>, isGenCollapsed: (id: string) => boolean): number {
  let n = 0;
  for (const l of visible) {
    if (isGenCollapsed(l.id)) {
      n++;
      continue;
    }
    const byDir = new Map<string, number>();
    for (const f of l.files) byDir.set(dirPrefix(f.path, depth), (byDir.get(dirPrefix(f.path, depth)) ?? 0) + 1);
    for (const [d, c] of byDir) n += c < 2 || expanded.has(clusterId(l.id, d)) ? c : 1;
  }
  return n;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Tooltip for an edge: who links to whom and how many links the single line stands for. */
export function edgeTitle(e: GEdge, g: Pick<Graph, "nodes">): string {
  const name = (id: string) => {
    const n = g.nodes.find((x) => x.id === id);
    return n ? n.label : id;
  };
  const a = name(e.from);
  const b = name(e.to);
  const head = e.mutual ? `${a} ↔ ${b} (import each other)` : e.tests && !e.imports ? `${a} tests ${b}` : `${a} → ${b}`;
  const parts: string[] = [];
  if (e.imports) parts.push(plural(e.imports, "import link"));
  if (e.tests) parts.push(e.tests === 1 ? "test pairing" : plural(e.tests, "test pairing"));
  return `${head}\n${parts.join(" + ")}`;
}

/** Case-insensitive search over file paths; returns matching node ids. */
export function searchNodes(g: Graph, q: string): Set<string> {
  const s = q.trim().toLowerCase();
  if (!s) return new Set();
  return new Set(g.nodes.filter((n) => n.label.toLowerCase().includes(s) || n.paths.some((p) => p.toLowerCase().includes(s))).map((n) => n.id));
}

/** Stable color per layer id (works in light and dark themes). */
export function layerColor(layerId: string): string {
  const base = layerId.split(":")[0];
  const map: Record<string, string> = {
    mechanical: "#8c959f",
    contract: "#8250df",
    core: "#0969da",
    caller1: "#1b7c83",
    caller2: "#2da44e",
    caller3: "#9a6700",
    caller4: "#bc4c00",
    standalone: "#57606a",
    removed: "#cf222e",
    test: "#1a7f37",
    configdocs: "#bf8700",
    generated: "#6e7781",
  };
  return map[base] ?? "#57606a";
}
