/** Interactive Graph view: pan/zoom, hover neighbours, search, layer filter, cluster expand, click-to-jump. */
import type { LayerPlan } from "../engine/types";
import { buildGraph, GENERATED_NODE, layerColor, searchNodes, type Graph } from "./build";
import { layoutGraph, perRowFor, type Layout } from "./layout";
import { graphTree } from "./svg";
import { toDom } from "./vdom";

export const GRAPH_VIEW_CSS = `
.gv { display:flex; flex-direction:column; height:100%; min-height:0; }
.gv-bar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border); }
.gv-bar input[type=search] { flex:1 1 140px; min-width:100px; font:inherit; font-size:12px; padding:4px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg); }
.gv-bar button { font:inherit; font-size:12px; padding:3px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--fg); cursor:pointer; }
.gv-bar button.gv-primary { background:var(--btn,#1f883d); border-color:var(--btn,#1f883d); color:#fff; font-weight:600; }
.gv-legend { display:flex; flex-wrap:wrap; gap:4px; padding:6px 10px; border-bottom:1px solid var(--border); }
.gv-chip { display:inline-flex; align-items:center; gap:4px; font:inherit; font-size:11px; padding:2px 7px; border-radius:999px; border:1px solid var(--border); background:var(--bg); color:var(--fg); cursor:pointer; }
.gv-chip[aria-pressed=false] { opacity:.45; text-decoration:line-through; }
.gv-chip i { width:9px; height:9px; border-radius:2px; display:inline-block; }
.gv-note { padding:4px 10px; font-size:11.5px; color:var(--muted); }
.gv-canvas { position:relative; flex:1; min-height:220px; overflow:hidden; cursor:grab; touch-action:none; background:var(--bg2); }
.gv-canvas.panning { cursor:grabbing; }
.gv-canvas svg { position:absolute; inset:0; width:100%; height:100%; }
.gv-bar, .gv-legend, .gv-note, .gv-key { flex-shrink:0; }
.gv-key { padding:4px 10px 8px; font-size:11px; color:var(--muted); display:flex; gap:12px; flex-wrap:wrap; }
.gv-key svg { vertical-align:middle; }
.gv-more { text-decoration:underline dotted; cursor:help; }
`;

/** The initial view never zooms out below this (readable labels); wider graphs scroll sideways. */
export const HOME_MIN_ZOOM = 0.7;

export interface GraphViewOptions {
  onJump(path: string): void;
  onExpand?(): void;
  onOpenTab?(): void;
  /** Fewer nodes per row for the small panel. */
  compact?: boolean;
  doc?: Document;
}

interface ReviewInfo {
  reviewedLayers: ReadonlySet<string>;
  reviewedPaths?: ReadonlySet<string>;
  changedPaths: ReadonlySet<string>;
  risk?: ReadonlyMap<string, "high" | "medium" | "low">;
}

export class GraphView {
  readonly el: HTMLElement;
  private canvas: HTMLElement;
  private legend: HTMLElement;
  private note: HTMLElement;
  private search: HTMLInputElement;
  private svg: SVGSVGElement | null = null;
  private root: SVGGElement | null = null;
  private plan: LayerPlan | null = null;
  private info: ReviewInfo = { reviewedLayers: new Set(), changedPaths: new Set() };
  private hidden = new Set<string>();
  private expanded = new Set<string>();
  private graph: Graph | null = null;
  private layout: Layout | null = null;
  private t = { k: 1, x: 0, y: 0 };
  private nodeEls = new Map<string, Element>();
  private edgeEls: Element[] = [];
  private doc: Document;

  constructor(private opts: GraphViewOptions) {
    this.doc = opts.doc ?? document;
    const d = this.doc;
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
      const e = d.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text) e.textContent = text;
      return e;
    };
    this.el = mk("div", { class: "gv" });
    const bar = mk("div", { class: "gv-bar" });
    this.search = mk("input", { type: "search", placeholder: "Search files…", "aria-label": "Search files in graph" }) as HTMLInputElement;
    const zoomOut = mk("button", { type: "button", title: "Zoom out", "aria-label": "Zoom out" }, "−");
    const zoomIn = mk("button", { type: "button", title: "Zoom in", "aria-label": "Zoom in" }, "+");
    const fit = mk("button", { type: "button", title: "Zoom out to show the whole graph" }, "Fit");
    const top = mk("button", { type: "button", title: "Back to step 1 at a readable size" }, "Top");
    bar.append(this.search, zoomOut, zoomIn, top, fit);
    if (opts.onExpand) {
      const b = mk("button", { type: "button", class: "gv-primary", title: "Recommended: open the graph in a large view (Esc to close)" }, "⤢ Expand");
      b.addEventListener("click", () => opts.onExpand!());
      bar.append(b);
    }
    if (opts.onOpenTab) {
      const b = mk("button", { type: "button", title: "Open the graph in a full browser tab", "aria-label": "Open the graph in a full browser tab" }, opts.compact ? "↗" : "↗ Tab");
      b.addEventListener("click", () => opts.onOpenTab!());
      bar.append(b);
    }
    this.legend = mk("div", { class: "gv-legend", role: "group", "aria-label": "Filter by step" });
    this.note = mk("div", { class: "gv-note" });
    this.canvas = mk("div", { class: "gv-canvas" });
    const key = mk("div", { class: "gv-key" });
    const more = "One line per file pair; hover a line for the count · thicker = more links · dimmed = reviewed · ● changed since reviewed · ⛔ red / ⚠ amber ring = risky change · dashed box = Go package / import cycle · wheel scrolls, Ctrl/⌘ + wheel or pinch zooms";
    key.append(this.keyItem(opts.compact ? "imports" : "imports (the lower file uses the upper one)", false), this.keyItem(opts.compact ? "test" : "test and the file it tests", true));
    // The small panel keeps the canvas tall: the long key moves into a tooltip.
    if (opts.compact) {
      key.title = more;
      key.append(mk("span", { class: "gv-more" }, "hover for more"));
    } else key.append(mk("span", {}, more));
    this.el.append(bar, this.legend, this.note, this.canvas, key);

    zoomIn.addEventListener("click", () => this.zoomBy(1.25));
    zoomOut.addEventListener("click", () => this.zoomBy(0.8));
    fit.addEventListener("click", () => this.fit());
    top.addEventListener("click", () => this.home());
    this.search.addEventListener("input", () => this.applySearch());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = [...searchNodes(this.graph!, this.search.value)][0];
        if (first) this.centerOn(first);
      }
    });
    this.wire();
  }

  private keyItem(label: string, dashed: boolean) {
    const s = this.doc.createElement("span");
    const svg = toDom({ tag: "svg", attrs: { width: 26, height: 8 }, children: [{ tag: "path", attrs: { d: "M1,4 L25,4", stroke: dashed ? "#1a7f37" : "#8c959f", "stroke-width": 1.5, "stroke-dasharray": dashed ? "4 3" : undefined, fill: "none" }, children: [] }] }, this.doc);
    s.append(svg, " " + label);
    return s;
  }

  setData(plan: LayerPlan, info?: Partial<ReviewInfo>) {
    this.plan = plan;
    this.info = { reviewedLayers: info?.reviewedLayers ?? new Set(), reviewedPaths: info?.reviewedPaths, changedPaths: info?.changedPaths ?? new Set(), risk: info?.risk };
    this.render(true);
  }

  private render(refit: boolean) {
    if (!this.plan) return;
    const width = this.canvas.clientWidth || 380;
    // As many full-size nodes per row as fit at a readable zoom (the panel may scale down to 80%).
    const maxPerRow = this.opts.compact ? perRowFor(width / 0.8, 3) : perRowFor(width, 8);
    this.graph = buildGraph(this.plan, { hiddenLayers: this.hidden, expanded: this.expanded, reviewedLayers: this.info.reviewedLayers, reviewedPaths: this.info.reviewedPaths, changedPaths: this.info.changedPaths, risk: this.info.risk });
    this.layout = layoutGraph(this.graph, { maxPerRow });
    this.renderLegend();
    const parts: string[] = [];
    if (this.graph.clusteredFiles) parts.push(`${this.graph.clusteredFiles} of ${this.graph.totalFiles} files grouped into directory clusters to keep this large PR fast. Click a cluster to expand it.`);
    const allFiles = this.graph.nodes.every((n) => n.kind === "file");
    parts.push(`${this.graph.nodes.length} ${allFiles ? "files" : "nodes"} · ${this.graph.edges.length} links.`);
    if (this.opts.compact && this.opts.onExpand) parts.push("Tip: ⤢ Expand for a bigger view.");
    this.note.textContent = parts.join(" ");
    const tree = graphTree(this.graph, this.layout);
    tree.attrs.width = "100%";
    tree.attrs.height = "100%";
    delete tree.attrs.viewBox;
    this.svg = toDom(tree, this.doc) as SVGSVGElement;
    this.root = this.svg.querySelector(".g-root");
    this.canvas.replaceChildren(this.svg);
    this.nodeEls.clear();
    this.svg.querySelectorAll(".g-node").forEach((n) => this.nodeEls.set(n.getAttribute("data-id")!, n));
    this.edgeEls = [...this.svg.querySelectorAll(".g-edge")];
    if (refit) requestAnimationFrame(() => this.home());
    else this.apply();
    this.applySearch();
  }

  private renderLegend() {
    const d = this.doc;
    this.legend.replaceChildren(
      ...this.graph!.layers.map((l) => {
        const b = d.createElement("button");
        b.type = "button";
        b.className = "gv-chip";
        b.setAttribute("aria-pressed", String(!l.hidden));
        b.title = `${l.hidden ? "Show" : "Hide"} step ${l.index + 1}: ${l.title} (${l.files} ${l.files === 1 ? "file" : "files"})`;
        b.setAttribute("aria-label", b.title);
        const i = d.createElement("i");
        i.style.background = layerColor(l.id);
        // Compact (panel): just the step number; each band in the graph is titled anyway.
        b.append(i, this.opts.compact ? `${l.index + 1}` : `${l.index + 1} ${l.title} · ${l.files}`);
        b.addEventListener("click", () => {
          if (this.hidden.has(l.id)) this.hidden.delete(l.id);
          else this.hidden.add(l.id);
          this.render(true);
        });
        return b;
      }),
    );
  }

  private size() {
    return { cw: this.canvas.clientWidth || 380, ch: this.canvas.clientHeight || 300, W: (this.layout?.width ?? 0) + 32, H: (this.layout?.height ?? 0) + 32 };
  }

  /** Keep some of the graph on screen: content may not scroll further than its own edges (plus a little slack). */
  private clamp() {
    const { cw, ch, W, H } = this.size();
    const slack = 40;
    const fitAxis = (v: number, view: number, content: number) => {
      const lo = Math.min(0, view - content) - slack;
      const hi = Math.max(0, view - content) + slack;
      return Math.min(hi, Math.max(lo, v));
    };
    this.t.x = fitAxis(this.t.x, cw, W * this.t.k);
    this.t.y = fitAxis(this.t.y, ch, H * this.t.k);
  }

  /**
   * Initial view: step 1 (the top band) in view at a readable zoom, centred horizontally. Never shrinks the whole
   * graph to fit, which makes big PRs unreadable; scroll down through the steps instead.
   */
  home() {
    if (!this.layout) return;
    const { cw, W } = this.size();
    const k = Math.max(HOME_MIN_ZOOM, Math.min(1, cw / W));
    this.t = { k, x: W * k <= cw ? (cw - W * k) / 2 : 0, y: 0 };
    this.apply();
  }

  /** Current transform (for tests and the overflow check). */
  get transform() {
    return { ...this.t };
  }

  private apply() {
    this.clamp();
    this.root?.setAttribute("transform", `translate(${this.t.x.toFixed(1)},${this.t.y.toFixed(1)}) scale(${this.t.k.toFixed(4)})`);
  }

  fit() {
    if (!this.layout) return;
    const cw = this.canvas.clientWidth || 380;
    const ch = this.canvas.clientHeight || 300;
    const W = this.layout.width + 32;
    const H = this.layout.height + 32;
    const k = Math.max(0.15, Math.min(1.1, cw / W, ch / H > 0.35 ? ch / H : 0.35));
    this.t = { k, x: (cw - W * k) / 2, y: 4 };
    this.apply();
  }

  private zoomBy(f: number, cx?: number, cy?: number) {
    const cw = this.canvas.clientWidth || 380;
    const ch = this.canvas.clientHeight || 300;
    const mx = cx ?? cw / 2;
    const my = cy ?? ch / 2;
    const k = Math.min(3, Math.max(0.1, this.t.k * f));
    const r = k / this.t.k;
    this.t = { k, x: mx - (mx - this.t.x) * r, y: my - (my - this.t.y) * r };
    this.apply();
  }

  private centerOn(id: string) {
    const p = this.layout?.pos.get(id);
    if (!p) return;
    const k = Math.max(this.t.k, 1);
    const cw = this.canvas.clientWidth || 380;
    const ch = this.canvas.clientHeight || 300;
    this.t = { k, x: cw / 2 - (p.x + 16 + this.layout!.nodeW / 2) * k, y: ch / 2 - (p.y + 16 + this.layout!.nodeH / 2) * k };
    this.apply();
    (this.nodeEls.get(id) as SVGGElement | undefined)?.focus?.({ preventScroll: true });
  }

  private applySearch() {
    if (!this.graph || !this.root) return;
    const m = searchNodes(this.graph, this.search.value);
    this.root.classList.toggle("searching", !!this.search.value.trim());
    for (const [id, el] of this.nodeEls) el.classList.toggle("match", m.has(id));
  }

  private highlight(id: string | null) {
    if (!this.root || !this.graph) return;
    this.root.classList.toggle("hovering", !!id);
    const nb = id ? this.graph.neighbors.get(id) ?? new Set() : new Set<string>();
    for (const [nid, el] of this.nodeEls) el.classList.toggle("hl", !!id && (nid === id || nb.has(nid)));
    for (const e of this.edgeEls) e.classList.toggle("hl", !!id && (e.getAttribute("data-from") === id || e.getAttribute("data-to") === id));
  }

  private activate(id: string) {
    const n = this.graph?.nodes.find((x) => x.id === id);
    if (!n) return;
    if (n.kind === "file") return this.opts.onJump(n.paths[0]);
    this.expanded.add(n.id === GENERATED_NODE ? GENERATED_NODE : n.id);
    this.render(false);
  }

  private wire() {
    let pan: { x: number; y: number; tx: number; ty: number; id: number; moved: boolean; node: string | null } | null = null;
    const nodeIdAt = (t: EventTarget | null) => ((t as Element | null)?.closest?.(".g-node")?.getAttribute("data-id") ?? null);
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      pan = { x: e.clientX, y: e.clientY, tx: this.t.x, ty: this.t.y, id: e.pointerId, moved: false, node: nodeIdAt(e.target) };
      this.canvas.setPointerCapture?.(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!pan || e.pointerId !== pan.id) {
        if (!pan) this.highlight(nodeIdAt(e.target));
        return;
      }
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < 4) return;
      pan.moved = true;
      this.canvas.classList.add("panning");
      this.t.x = pan.tx + dx;
      this.t.y = pan.ty + dy;
      this.apply();
    });
    const end = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pan.id) return;
      const p = pan;
      pan = null;
      this.canvas.classList.remove("panning");
      if (!p.moved && p.node) this.activate(p.node);
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this.canvas.addEventListener("pointerleave", () => !pan && this.highlight(null));
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight || 300 : 1;
        // Ctrl/⌘ + wheel zooms; a trackpad pinch arrives as a wheel event with ctrlKey set.
        if (e.ctrlKey || e.metaKey) {
          const r = this.canvas.getBoundingClientRect();
          this.zoomBy(Math.exp(-e.deltaY * unit * 0.01), e.clientX - r.left, e.clientY - r.top);
          return;
        }
        // Plain wheel scrolls through the steps (Shift + wheel scrolls sideways).
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
        this.t.x -= dx;
        this.t.y -= dy;
        this.apply();
      },
      { passive: false },
    );
    this.canvas.addEventListener("keydown", (e) => {
      const id = nodeIdAt(e.target);
      if (id && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.activate(id);
      }
    });
    this.canvas.addEventListener("focusin", (e) => this.highlight(nodeIdAt(e.target)));
    this.canvas.addEventListener("focusout", () => this.highlight(null));
  }
}
