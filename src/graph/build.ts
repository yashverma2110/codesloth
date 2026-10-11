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
  additions: number;
  deletions: number;
  status?: LayerFile["status"];
  reason?: string;
  /** Visual group key (Go package / import cycle) for file nodes. */
  group?: string;
  reviewed: boolean;
  changed: boolean;
}

export interface GEdge {
  from: string;
  to: string;
  kind: "import" | "test";
  /** How many file-level edges this edge stands for (after clustering). */
  count: number;
}

export interface GLayer {
  index: number;
  id: string;
  title: string;
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
  changedPaths?: ReadonlySet<string>;
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

  const layers: GLayer[] = plan.layers.map((l) => ({ index: l.index, id: l.id, title: l.title, files: l.files.length, hidden: hidden.has(l.id) }));
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
        label: `${l.files.length} generated / lockfile${l.files.length === 1 ? "" : "s"}`,
        paths: l.files.map((f) => f.path),
        layerIndex: l.index,
        layerId: l.id,
        layerTitle: l.title,
        additions: l.stats.additions,
        deletions: l.stats.deletions,
        reason: "Collapsed by default; click to expand.",
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
        additions: fs.reduce((s, f) => s + f.additions, 0),
        deletions: fs.reduce((s, f) => s + f.deletions, 0),
        reason: `${fs.length} files in ${d || "(root)"}/ clustered because the PR is large; click to expand.`,
        reviewed: reviewed.has(l.id),
        changed: fs.some((f) => changed.has(f.path)),
      });
      for (const f of fs) nodeOf.set(f.path, cid);
    }
  }

  // Edges, re-mapped onto (possibly clustered) nodes and aggregated.
  const agg = new Map<string, GEdge>();
  for (const e of plan.edges ?? []) {
    const a = nodeOf.get(e.from);
    const b = nodeOf.get(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}\u0000${b}\u0000${e.kind}`;
    const ex = agg.get(k);
    if (ex) ex.count++;
    else agg.set(k, { from: a, to: b, kind: e.kind, count: 1 });
  }
  const edges = [...agg.values()];
  const neighbors = new Map<string, Set<string>>();
  for (const n of nodes) neighbors.set(n.id, new Set());
  for (const e of edges) {
    neighbors.get(e.from)!.add(e.to);
    neighbors.get(e.to)!.add(e.from);
  }
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
