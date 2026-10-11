/** Render a laid-out graph to an SVG string (used by the interactive view and for static export). */
import type { Graph, GNode } from "./build";
import { layerColor } from "./build";
import type { Layout } from "./layout";
import { h, toString, type VNode } from "./vdom";

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** CSS for graph SVG; variables come from the widget theme (or are inlined for standalone export). */
export const GRAPH_CSS = `
.g-band rect { fill-opacity:.07; }
.g-band text { font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; fill:var(--muted,#59636e); }
.g-group rect { fill:none; stroke:var(--muted,#8c959f); stroke-dasharray:4 3; stroke-opacity:.7; rx:10; }
.g-group text { font:italic 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; fill:var(--muted,#59636e); }
.g-edge { fill:none; stroke:var(--edge,#8c959f); stroke-opacity:.55; stroke-width:1.2; }
.g-edge.test { stroke-dasharray:5 4; stroke:var(--add,#1a7f37); stroke-opacity:.6; }
.g-node rect.box { fill:var(--bg,#fff); stroke:var(--border,#d1d9e0); rx:7; }
.g-node .lbl { font:600 11.5px ui-monospace,SFMono-Regular,Menlo,monospace; fill:var(--fg,#1f2328); }
.g-node .meta { font:10.5px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; fill:var(--muted,#59636e); }
.g-node .meta .a { fill:var(--add,#1a7f37); } .g-node .meta .d { fill:var(--del,#d1242f); }
.g-node.cluster rect.box, .g-node.generated rect.box { stroke-dasharray:4 2; }
.g-node.reviewed { opacity:.45; }
.g-node .chk { font:700 12px sans-serif; fill:var(--add,#1a7f37); }
.g-node .chg { fill:#d4a72c; }
.g-root.hovering .g-node:not(.hl), .g-root.searching .g-node:not(.match) { opacity:.18; }
.g-root.hovering .g-edge:not(.hl) { stroke-opacity:.06; }
.g-root.hovering .g-edge.hl { stroke-opacity:1; stroke-width:2; }
.g-node.match rect.box { stroke:var(--accent,#0969da); stroke-width:2; }
.g-node { cursor:pointer; }
`;

export interface SvgOptions {
  standalone?: boolean;
  /** Theme variables for standalone export. */
  theme?: "light" | "dark";
}

function nodeTree(n: GNode, x: number, y: number, w: number, hh: number): VNode {
  const color = layerColor(n.layerId);
  const tip = [n.kind === "file" ? n.paths[0] : n.label, `+${n.additions} / −${n.deletions} · ${n.layerTitle}`, n.reason ?? "", n.reviewed ? "✓ layer reviewed" : "", n.changed ? "⚠ changed since reviewed" : ""]
    .filter(Boolean)
    .join("\n");
  const cls = ["g-node", n.kind, n.reviewed ? "reviewed" : ""].filter(Boolean).join(" ");
  return h(
    "g",
    { class: cls, "data-id": n.id, transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`, tabindex: 0, role: "button", "aria-label": n.kind === "file" ? n.paths[0] : n.label },
    h("title", {}, tip),
    h("rect", { class: "box", width: w, height: hh }),
    h("rect", { width: 5, height: hh, rx: 2, fill: color }),
    h("text", { class: "lbl", x: 12, y: 16 }, trunc(n.label, Math.floor((w - 30) / 7))),
    h("text", { class: "meta", x: 12, y: hh - 8 }, h("tspan", { class: "a" }, `+${n.additions}`), " ", h("tspan", { class: "d" }, `−${n.deletions}`), n.kind === "file" && n.status ? ` · ${n.status}` : ""),
    n.reviewed && h("text", { class: "chk", x: w - 16, y: 16 }, "✓"),
    n.changed && h("circle", { class: "chg", cx: w - 9, cy: hh - 10, r: 4 }, h("title", {}, "changed since reviewed")),
  );
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, w: number, hh: number): string {
  if (Math.abs(a.y - b.y) < 1) {
    const x1 = a.x + w / 2, x2 = b.x + w / 2, yy = a.y;
    return `M${x1},${yy} C${x1},${yy - 30} ${x2},${yy - 30} ${x2},${yy}`;
  }
  if (b.y < a.y) {
    // importer below imported (the usual case): top of importer -> bottom of imported
    const x1 = a.x + w / 2, y1 = a.y, x2 = b.x + w / 2, y2 = b.y + hh, my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
  const x1 = a.x + w / 2, y1 = a.y + hh, x2 = b.x + w / 2, y2 = b.y, my = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
}

export function graphTree(g: Graph, L: Layout, o: SvgOptions = {}): VNode {
  const pad = 16;
  const W = L.width + pad * 2;
  const H = L.height + pad * 2;
  const dark = o.theme === "dark";
  const kids: (VNode | false)[] = [
    h("defs", {}, h("marker", { id: "g-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, h("path", { d: "M0,0 L10,5 L0,10 z", fill: dark ? "#9198a1" : "#8c959f" }))),
  ];
  if (o.standalone) {
    const vars = dark
      ? "--fg:#f0f6fc;--muted:#9198a1;--border:#3d444d;--bg:#151b23;--accent:#4493f8;--add:#3fb950;--del:#f85149;--edge:#9198a1"
      : "--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--bg:#ffffff;--accent:#0969da;--add:#1a7f37;--del:#d1242f;--edge:#8c959f";
    kids.push(h("style", {}, `svg{${vars}} ${GRAPH_CSS}`), h("rect", { width: W, height: H, fill: dark ? "#0d1117" : "#f6f8fa" }));
  }
  const vp: (VNode | false)[] = [];
  for (const b of L.bands) {
    vp.push(h("g", { class: "g-band" }, h("rect", { x: 0, y: b.y, width: L.width, height: b.h, rx: 10, fill: layerColor(b.layerId) }), h("text", { x: 10, y: b.y + 17 }, `L${b.layerIndex} · ${b.title}`)));
  }
  for (const gr of L.groups) vp.push(h("g", { class: "g-group" }, h("rect", { x: gr.x, y: gr.y, width: gr.w, height: gr.h }), h("text", { x: gr.x + gr.w - 4, y: gr.y - 3, "text-anchor": "end" }, gr.label)));
  for (const e of g.edges) {
    const a = L.pos.get(e.from);
    const b = L.pos.get(e.to);
    if (!a || !b) continue;
    vp.push(
      h("path", {
        class: `g-edge ${e.kind}`,
        "data-from": e.from,
        "data-to": e.to,
        d: edgePath(a, b, L.nodeW, L.nodeH),
        "marker-end": "url(#g-arrow)",
        style: e.count > 1 ? `stroke-width:${Math.min(4, 1 + Math.log2(e.count)).toFixed(2)}` : undefined,
      }),
    );
  }
  for (const n of g.nodes) {
    const p = L.pos.get(n.id);
    if (p) vp.push(nodeTree(n, p.x, p.y, L.nodeW, L.nodeH));
  }
  kids.push(h("g", { class: "g-root" }, h("g", { class: "g-vp", transform: `translate(${pad},${pad})` }, ...vp)));
  return h("svg", { xmlns: "http://www.w3.org/2000/svg", class: "g-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}` }, ...kids);
}

export function renderSvg(g: Graph, L: Layout, o: SvgOptions = {}): string {
  return toString(graphTree(g, L, o));
}
