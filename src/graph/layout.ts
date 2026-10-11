/**
 * Hand-rolled layered layout: one horizontal band per layer, top-to-bottom in review order
 * (contracts at the top). Within a band, nodes are ordered by the barycenter of their already
 * placed neighbours (fewer crossings), keeping Go packages / cycles / directories contiguous,
 * and wrapped into rows. O(V + E) per pass; fine for a few hundred nodes.
 */
import type { Graph, GNode } from "./build";

export interface LayoutOptions {
  nodeW?: number;
  nodeH?: number;
  gapX?: number;
  gapY?: number;
  bandPad?: number;
  bandGap?: number;
  maxPerRow?: number;
  labelW?: number;
}

export interface Pos {
  x: number;
  y: number;
}

export interface Band {
  layerIndex: number;
  layerId: string;
  title: string;
  label: string;
  y: number;
  h: number;
}

export interface GroupBox {
  key: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  pos: Map<string, Pos>;
  bands: Band[];
  groups: GroupBox[];
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
}

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function groupKey(n: GNode): string {
  return n.group ?? (n.kind === "file" ? `dir:${dirname(n.paths[0])}` : `node:${n.id}`);
}

/** Default node size: big enough to read at 100% zoom (v0.6.5; was 168×38). */
export const NODE_W = 200;
export const NODE_H = 48;
export const GAP_X = 20;

/** How many nodes fit on a row of a canvas this wide at 100% zoom (outer padding 16px each side). */
export function perRowFor(width: number, max = 8): number {
  return Math.max(1, Math.min(max, Math.floor((width - 32 + GAP_X) / (NODE_W + GAP_X))));
}

export function layoutGraph(g: Graph, o: LayoutOptions = {}): Layout {
  const nodeW = o.nodeW ?? NODE_W;
  const nodeH = o.nodeH ?? NODE_H;
  const gapX = o.gapX ?? GAP_X;
  const gapY = o.gapY ?? 20;
  const bandPad = o.bandPad ?? 34;
  const bandGap = o.bandGap ?? 14;
  const labelW = o.labelW ?? 0;
  const maxPerRow = Math.max(1, o.maxPerRow ?? 7);
  const rowW = maxPerRow * nodeW + (maxPerRow - 1) * gapX;

  const byLayer = new Map<number, GNode[]>();
  for (const n of g.nodes) byLayer.set(n.layerIndex, [...(byLayer.get(n.layerIndex) ?? []), n]);
  const layerIdx = [...byLayer.keys()].sort((a, b) => a - b);

  const pos = new Map<string, Pos>();
  const bands: Band[] = [];
  const groups: GroupBox[] = [];
  let y = 0;
  for (const li of layerIdx) {
    const ns = byLayer.get(li)!;
    // barycenter of already-placed neighbours (x centre)
    const bary = new Map<string, number>();
    for (const n of ns) {
      const xs = [...(g.neighbors.get(n.id) ?? [])].map((m) => pos.get(m)).filter((p): p is Pos => !!p).map((p) => p.x + nodeW / 2);
      if (xs.length) bary.set(n.id, xs.reduce((a, b) => a + b, 0) / xs.length);
    }
    const gb = new Map<string, number[]>();
    for (const n of ns) if (bary.has(n.id)) gb.set(groupKey(n), [...(gb.get(groupKey(n)) ?? []), bary.get(n.id)!]);
    const groupBary = (n: GNode) => {
      const v = gb.get(groupKey(n));
      return v ? v.reduce((a, b) => a + b, 0) / v.length : Infinity;
    };
    const sorted = [...ns].sort(
      (a, b) =>
        groupBary(a) - groupBary(b) ||
        groupKey(a).localeCompare(groupKey(b)) ||
        (bary.get(a.id) ?? Infinity) - (bary.get(b.id) ?? Infinity) ||
        a.label.localeCompare(b.label),
    );
    // Wrap into rows without splitting a package/cycle group when it fits on one row.
    const rows: GNode[][] = [[]];
    let i0 = 0;
    while (i0 < sorted.length) {
      let j = i0;
      const k = groupKey(sorted[i0]);
      while (j + 1 < sorted.length && groupKey(sorted[j + 1]) === k) j++;
      const run = sorted.slice(i0, j + 1);
      let cur = rows[rows.length - 1];
      if (sorted[i0].group && cur.length && cur.length + run.length > maxPerRow && run.length <= maxPerRow) rows.push((cur = []));
      for (const n of run) {
        if (cur.length >= maxPerRow) rows.push((cur = []));
        cur.push(n);
      }
      i0 = j + 1;
    }
    const bandTop = y;
    y += bandPad;
    for (const row of rows) {
      const w = row.length * nodeW + (row.length - 1) * gapX;
      let x = labelW + (rowW - w) / 2;
      for (const n of row) {
        pos.set(n.id, { x, y });
        x += nodeW + gapX;
      }
      // group boxes for consecutive members of the same package/cycle in this row
      let i = 0;
      while (i < row.length) {
        const k = row[i].group;
        let j = i;
        while (j + 1 < row.length && k && row[j + 1].group === k) j++;
        if (k && j > i) {
          const a = pos.get(row[i].id)!;
          const b = pos.get(row[j].id)!;
          groups.push({ key: k, label: k.startsWith("pkg:") ? `package ${k.slice(4)}` : "import cycle", x: a.x - 6, y: a.y - 14, w: b.x + nodeW - a.x + 12, h: nodeH + 20 });
        }
        i = j + 1;
      }
      y += nodeH + gapY;
    }
    y += bandPad / 2 - gapY;
    bands.push({ layerIndex: li, layerId: ns[0].layerId, title: ns[0].layerTitle, label: ns[0].layerLabel, y: bandTop, h: y - bandTop });
    y += bandGap;
  }
  return { pos, bands, groups, width: labelW + rowW, height: Math.max(0, y - bandGap), nodeW, nodeH };
}
