import type { AnalyzeResult, AuthStatus, PrefKey, PRRef, Request, Response } from "../shared/messages";
import { diffAnchor, prKey } from "../shared/pr-url";
import type { Layer } from "../engine/types";
import { WIDGET_CSS, WIDGET_CSS_V3 } from "./widget.css";
import { GRAPH_CSS } from "../graph/svg";
import { GraphView, GRAPH_VIEW_CSS } from "../graph/view";
import { toDom } from "../graph/vdom";
import { allFiles, ctaTarget, currentStep, emptyReview, firstUnreviewed, layerReview, locate, nextUnreviewed, normalizeReviewState, progress, setFilesReviewed, summarize, type ReviewState } from "./review-logic";
import type { LayerFile } from "../engine/types";
import { renderReview } from "./review-view";
import { REVIEW_TOUR_TEXT, Tour, TOUR_CSS, type TourStep } from "./tour";
import demoData from "../demo/demo-plan.json";
import {
  BUBBLE,
  bubbleLeft,
  clampDrag,
  clampTop,
  isDrag,
  loadPosition,
  nextOpen,
  onResize,
  panelPlacement,
  resolveTheme,
  snapPosition,
  snapSide,
  type ToggleEvent,
  type Viewport,
  type WidgetPosition,
} from "./widget-logic";

export const HOST_ID = "pr-layers-widget-host";
export type View = "review" | "graph";
const DEMO = demoData as unknown as AnalyzeResult;

/** Talk to the background worker. The token never comes back to the page side. */
async function rpc<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error("Extension background not available. Reload the page.");
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.data;
}
const getPref = <T>(key: PrefKey) => rpc<T | null>({ type: "prefs:get", key }).catch(() => null);
const setPref = (key: PrefKey, value: unknown) => rpc({ type: "prefs:set", key, value }).catch(() => {});

const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

const ICON = {
  tag: "svg",
  attrs: { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
  children: [
    { tag: "path", attrs: { d: "M12 3 3 7.5l9 4.5 9-4.5L12 3Z" }, children: [] },
    { tag: "path", attrs: { d: "m3 12 9 4.5 9-4.5" }, children: [] },
    { tag: "path", attrs: { d: "m3 16.5 9 4.5 9-4.5" }, children: [] },
  ],
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export class Widget {
  private host!: HTMLElement;
  private root!: HTMLElement;
  private bubble!: HTMLButtonElement;
  private panel!: HTMLElement;
  private titleEl!: HTMLElement;
  private subEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private tabs!: Record<View, HTMLButtonElement>;
  private panes!: Record<View, HTMLElement>;
  private menuBtn!: HTMLButtonElement;
  /** Steps the user has expanded; reset per plan and seeded with the current step. */
  private openSteps = new Set<string>();
  private openFor = "";
  private menu!: HTMLElement;
  private overlay: HTMLElement | null = null;
  private graphView: GraphView | null = null;
  private overlayGraph: GraphView | null = null;
  private tour: Tour | null = null;
  private pos: WidgetPosition = { side: "right", top: 0 };
  private open = false;
  private view: View = "review";
  private pr: PRRef | null = null;
  private result: AnalyzeResult | null = null;
  private review: ReviewState = emptyReview();
  /** Selected file (highlighted; target of "Mark file as reviewed & next"). */
  private selected: string | null = null;
  private demo = false;
  private auth: AuthStatus | null = null;
  private busy = false;
  private preferredHeight?: number;
  private suppressClick = false;
  private cleanups: (() => void)[] = [];

  async mount() {
    this.host = el("div", { id: HOST_ID });
    // Closed shadow root: GitHub's page scripts can't reach into the widget's DOM.
    const shadow = this.host.attachShadow({ mode: "closed" });
    shadow.append(el("style", {}, WIDGET_CSS + WIDGET_CSS_V3 + GRAPH_CSS + GRAPH_VIEW_CSS + TOUR_CSS));
    this.root = el("div", { class: "root" });
    shadow.append(this.root);

    this.bubble = el("button", { class: "bubble", type: "button", title: "PR Layers (Alt+Shift+L)", "aria-label": "Toggle PR Layers", "aria-expanded": "false" }) as HTMLButtonElement;
    this.bubble.append(toDom(ICON), el("span", { class: "dot" }));

    this.titleEl = el("div", { class: "ttl" }, "PR Layers");
    this.menuBtn = el("button", { type: "button", class: "icon", title: "More: re-analyze, tour, demo, settings, details", "aria-label": "More options", "aria-haspopup": "menu", "aria-expanded": "false" }, "⋯") as HTMLButtonElement;
    const closeBtn = el("button", { type: "button", class: "x", title: "Close (Esc)", "aria-label": "Close" }, "✕");
    const hdr = el("div", { class: "hdr" }, this.titleEl, this.menuBtn, closeBtn);
    this.menu = el("div", { class: "menu", role: "menu", hidden: "" });

    // GitHub-style underline tabs with full ARIA tab semantics.
    const tablist = el("div", { class: "tabs", role: "tablist", "aria-label": "PR Layers views" });
    const mkTab = (v: View, label: string) => el("button", { type: "button", role: "tab", id: `prl-tab-${v}`, "aria-controls": `prl-pane-${v}`, "aria-selected": "false", tabindex: "-1", class: "tab" }, label) as HTMLButtonElement;
    this.tabs = { review: mkTab("review", "Review"), graph: mkTab("graph", "Graph") };
    tablist.append(this.tabs.review, this.tabs.graph);
    this.panes = {
      review: el("div", { class: "pane body", role: "tabpanel", id: "prl-pane-review", "aria-labelledby": "prl-tab-review", tabindex: "0" }),
      graph: el("div", { class: "pane graph", role: "tabpanel", id: "prl-pane-graph", "aria-labelledby": "prl-tab-graph", hidden: "" }),
    };
    this.bannerEl = el("div", { class: "banner", hidden: "" });
    this.subEl = el("div", { class: "sub", "aria-live": "polite" });
    this.panel = el("div", { class: "panel", role: "dialog", "aria-label": "PR Layers" }, hdr, this.menu, tablist, this.bannerEl, this.subEl, this.panes.review, this.panes.graph);
    this.panel.hidden = true;
    this.root.append(this.panel, this.bubble);
    // documentElement (not body): GitHub's Turbo navigation replaces <body>.
    document.documentElement.append(this.host);

    this.bubble.addEventListener("click", () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.toggle("bubble");
    });
    closeBtn.addEventListener("click", () => this.toggle("close"));
    this.menuBtn.addEventListener("click", () => this.toggleMenu());
    this.panel.addEventListener("keydown", (e) => this.onPanelKey(e));
    for (const v of ["review", "graph"] as View[]) this.tabs[v].addEventListener("click", () => this.setView(v, true));
    tablist.addEventListener("keydown", (e) => {
      const order: View[] = ["review", "graph"];
      const i = order.indexOf(this.view);
      let next: View | null = null;
      if (e.key === "ArrowRight") next = order[(i + 1) % order.length];
      else if (e.key === "ArrowLeft") next = order[(i + order.length - 1) % order.length];
      else if (e.key === "Home") next = order[0];
      else if (e.key === "End") next = order[order.length - 1];
      if (next) {
        e.preventDefault();
        this.setView(next, true);
        this.tabs[next].focus();
      }
    });
    this.enableDrag(this.bubble, true);
    this.enableDrag(hdr, false);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.open) return;
      const inWidget = e.composedPath().includes(this.host);
      const a = document.activeElement as HTMLElement | null;
      // Don't steal Esc from GitHub's own text fields (e.g. cancelling a comment).
      const typingInPage = !!a && a !== this.host && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
      if (!inWidget && typingInPage) return;
      e.stopPropagation();
      if (this.tour?.isActive()) this.tour.end(false);
      else if (!this.menu.hidden) this.toggleMenu(false);
      else if (this.overlay) this.closeOverlay();
      else this.toggle("escape");
    };
    document.addEventListener("keydown", onKey, true);
    const onResizeWin = () => {
      this.pos = onResize(this.pos, viewport());
      this.layout();
    };
    window.addEventListener("resize", onResizeWin);
    this.cleanups.push(() => document.removeEventListener("keydown", onKey, true), () => window.removeEventListener("resize", onResizeWin));

    // Theme: follow GitHub's data-color-mode, else the OS preference.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => this.root.classList.toggle("dark", resolveTheme(document.documentElement.getAttribute("data-color-mode"), mq.matches) === "dark");
    applyTheme();
    mq.addEventListener?.("change", applyTheme);
    const mo = new MutationObserver(applyTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
    this.cleanups.push(() => mq.removeEventListener?.("change", applyTheme), () => mo.disconnect());

    const ro = new ResizeObserver(() => {
      if (!this.panel.hidden && this.panel.style.height) this.preferredHeight = this.panel.getBoundingClientRect().height;
    });
    ro.observe(this.panel);
    this.cleanups.push(() => ro.disconnect());

    this.pos = await loadPosition({ get: () => rpc({ type: "widget:getPosition" }), set: async () => {} }, viewport());
    const savedView = await getPref<View>("view");
    this.setView(savedView === "graph" ? "graph" : "review", false);
    this.layout();
    await this.refreshAuth();
  }

  isMounted() {
    return !!this.host?.isConnected;
  }

  remount() {
    if (this.host && !this.host.isConnected) document.documentElement.append(this.host);
  }

  unmount() {
    this.tour?.end(false);
    this.cleanups.forEach((f) => f());
    this.cleanups = [];
    this.host?.remove();
  }

  setPr(pr: PRRef | null) {
    const changed = !this.pr || !pr || prKey(pr) !== prKey(this.pr);
    this.pr = pr;
    if (changed && !this.demo) {
      this.result = null;
      this.panes.review.replaceChildren();
      this.subEl.textContent = "";
      this.titleEl.textContent = pr ? `PR Layers · #${pr.number}` : "PR Layers";
      if (this.open) void this.analyze(false);
    }
  }

  toggle(ev: ToggleEvent) {
    const want = nextOpen(this.open, ev);
    if (want === this.open) return;
    this.open = want;
    this.panel.hidden = !want;
    this.bubble.setAttribute("aria-expanded", String(want));
    this.layout();
    if (want) {
      void this.refreshAuth().then(() => {
        if (!this.result) void this.analyze(false);
      });
    } else {
      this.tour?.end(false);
      this.toggleMenu(false);
      this.closeOverlay();
      if (ev === "escape" || ev === "close") this.bubble.focus({ preventScroll: true });
    }
  }

  async refreshAuth() {
    try {
      this.auth = await rpc<AuthStatus>({ type: "auth:status" });
    } catch {
      this.auth = null;
    }
    const none = this.auth?.method !== "pat";
    this.bubble.classList.toggle("needs-setup", none);
    this.bubble.title = none ? "PR Layers: set up a read-only token (or try the demo)" : `PR Layers (@${this.auth?.login ?? "token"}) · Alt+Shift+L`;
    if (none && this.open && !this.demo) this.renderSetup();
  }

  onAuthChanged() {
    if (this.demo) return void this.refreshAuth();
    this.result = null;
    void this.refreshAuth().then(() => {
      if (this.open && this.auth?.method === "pat") void this.analyze(false);
    });
  }

  progress(pr: PRRef, text: string) {
    if (this.pr && prKey(pr) === prKey(this.pr) && this.busy) this.subEl.textContent = text;
  }

  // ---------- views ----------

  setView(v: View, persist: boolean) {
    this.view = v;
    for (const k of ["review", "graph"] as View[]) {
      const on = k === v;
      this.tabs[k].setAttribute("aria-selected", String(on));
      this.tabs[k].tabIndex = on ? 0 : -1;
      this.panes[k].hidden = !on;
    }
    this.panel.classList.toggle("graph-mode", v === "graph");
    if (persist) void setPref("view", v);
    this.layout();
    if (v === "graph") this.renderGraph();
  }

  private toggleMenu(force?: boolean) {
    const show = force ?? this.menu.hidden;
    this.menu.hidden = !show;
    this.menuBtn.setAttribute("aria-expanded", String(show));
    if (!show) return;
    const item = (label: string, fn: () => void) => {
      const b = el("button", { type: "button", role: "menuitem" }, label);
      b.addEventListener("click", () => {
        this.toggleMenu(false);
        fn();
      });
      return b;
    };
    const res = this.result;
    const meta: HTMLElement[] = [];
    if (res) {
      const fmt = (n: number) => n.toLocaleString("en-US");
      if (!this.demo) meta.push(el("div", { class: "meta" }, `Head commit ${res.meta.headSha.slice(0, 7)} · ${res.fromCache ? "cached" : "fresh"}`));
      if (res.rate) meta.push(el("div", { class: "meta" }, `GitHub API ${fmt(res.rate.remaining)} / ${fmt(res.rate.limit)} left`));
      meta.push(el("div", { class: "meta" }, `${fmt(res.plan.stats.files)} files · +${fmt(res.plan.stats.additions)} / −${fmt(res.plan.stats.deletions)} lines`));
      for (const w of res.plan.warnings) meta.push(el("div", { class: "meta warn" }, "⚠ " + w));
    }
    this.menu.replaceChildren(
      item(this.demo ? "Reload demo" : "Re-analyze", () => (this.demo ? this.loadDemo() : void this.analyze(true))),
      item("Take the tour", () => this.startTour()),
      this.demo ? item("Exit demo", () => this.exitDemo()) : item("Try demo (sample PR, no token needed)", () => this.loadDemo(true)),
      item("Token & settings…", () => void rpc({ type: "openOnboarding" })),
      ...(meta.length ? [el("div", { class: "sep", role: "separator" }), ...meta] : []),
    );
    (this.menu.firstElementChild as HTMLElement | null)?.focus();
  }

  // ---------- layout & drag ----------

  private layout(dragXY?: { x: number; y: number }) {
    const vp = viewport();
    const x = dragXY ? dragXY.x : bubbleLeft(this.pos, vp);
    const y = dragXY ? dragXY.y : this.pos.top;
    Object.assign(this.bubble.style, { left: `${x}px`, top: `${y}px` });
    if (this.panel.hidden) return;
    const p = dragXY ? { side: snapSide(x + BUBBLE / 2, vp), top: clampTop(y, vp) } : this.pos;
    const place = panelPlacement(p, vp, this.preferredHeight);
    Object.assign(this.panel.style, {
      left: `${place.left}px`,
      width: `${place.width}px`,
      top: place.top !== undefined ? `${place.top}px` : "auto",
      bottom: place.bottom !== undefined ? `${place.bottom}px` : "auto",
      maxHeight: `${place.maxHeight}px`,
    });
    const h = this.preferredHeight ?? (this.view === "graph" ? 560 : undefined);
    this.panel.style.height = h ? `${Math.min(h, place.maxHeight)}px` : "";
  }

  private enableDrag(handle: HTMLElement, isBubble: boolean) {
    let start: { px: number; py: number; bx: number; by: number; id: number } | null = null;
    let dragging = false;
    let last = { x: 0, y: 0 };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (!isBubble && (e.target as HTMLElement).closest("button,input,a")) return;
      start = { px: e.clientX, py: e.clientY, bx: bubbleLeft(this.pos, viewport()), by: this.pos.top, id: e.pointerId };
      dragging = false;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!dragging && !isDrag(dx, dy)) return;
      if (!dragging) {
        dragging = true;
        this.bubble.classList.add("dragging");
        this.panel.classList.add("dragging");
      }
      last = clampDrag(start.bx + dx, start.by + dy, viewport());
      this.layout(last);
      e.preventDefault();
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      start = null;
      if (!dragging) return;
      dragging = false;
      this.bubble.classList.remove("dragging");
      this.panel.classList.remove("dragging");
      this.pos = snapPosition(last.x, last.y, viewport());
      this.layout();
      void rpc({ type: "widget:setPosition", position: this.pos }).catch(() => {});
      // A drag must not also count as a click on the bubble.
      if (isBubble) this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // ---------- data ----------

  private renderSetup() {
    const btn = el("button", { type: "button", class: "btn primary" }, "Set up token");
    btn.addEventListener("click", () => void rpc({ type: "openOnboarding" }));
    const demo = el("button", { type: "button", class: "btn" }, "Try demo");
    demo.addEventListener("click", () => this.loadDemo(true));
    this.subEl.textContent = "";
    this.panes.review.replaceChildren(
      el(
        "div",
        { class: "setup" },
        el("p", {}, "PR Layers needs a fine-grained GitHub token with only ", el("b", {}, "Pull requests: Read-only"), " and ", el("b", {}, "Contents: Read-only"), "."),
        el("p", { class: "muted" }, "The token stays inside the extension. This page never sees it."),
        el("div", { class: "row" }, btn, demo),
        el("p", { class: "muted" }, "Try demo loads a real sample (fastapi/fastapi#16403) so you can learn the Review and Graph tabs without a token."),
      ),
    );
    if (this.view === "graph") this.panes.graph.replaceChildren(el("div", { class: "setup muted" }, "Set up a token or try the demo to see the graph."));
  }

  async analyze(force: boolean) {
    if (this.demo) return;
    if (!this.pr || this.busy) return;
    if (this.auth?.method !== "pat") return this.renderSetup();
    this.busy = true;
    this.subEl.textContent = "Analyzing…";
    const pr = this.pr;
    try {
      const res = await rpc<AnalyzeResult>({ type: "analyze", pr, force });
      if (!this.pr || prKey(this.pr) !== prKey(pr) || this.demo) return;
      this.result = res;
      this.review = normalizeReviewState(await rpc({ type: "reviewed:get", key: prKey(res.pr) }).catch(() => ({})));
      this.renderAll();
      void this.maybeAutoTour();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "no_token" || err.code === "unauthorized") this.renderSetup();
      this.subEl.replaceChildren(el("span", { class: "err" }, err.message));
    } finally {
      this.busy = false;
    }
  }

  /** Demo mode: a bundled real plan, no token or network needed. Seeds one stale "reviewed" layer to show the change flag. */
  loadDemo(withTour = false) {
    this.demo = true;
    this.result = DEMO;
    const core = DEMO.plan.layers.find((l) => l.id === "core") ?? DEMO.plan.layers[0];
    // Pretend the first Core file was reviewed, then pushed again (older blob SHA), to show the change flag.
    const first = core.files[0];
    this.review = first ? setFilesReviewed(emptyReview(), [{ path: first.path, sha: "an-older-blob-sha" }], true, "demo-old-head", "2026-10-09T12:00:00Z") : emptyReview();
    this.openFor = "";
    this.bannerEl.hidden = false;
    const exit = el("button", { type: "button", class: "btn" }, "Exit demo");
    exit.addEventListener("click", () => this.exitDemo());
    this.bannerEl.replaceChildren(el("span", {}, `Demo: real sample ${DEMO.pr.owner}/${DEMO.pr.repo}#${DEMO.pr.number}. Ticks aren't saved.`), exit);
    this.renderAll();
    if (withTour) {
      this.setView("review", false);
      requestAnimationFrame(() => this.startTour());
    }
  }

  exitDemo() {
    this.demo = false;
    this.result = null;
    this.review = emptyReview();
    this.bannerEl.hidden = true;
    this.panes.review.replaceChildren();
    this.panes.graph.replaceChildren();
    this.graphView = null;
    this.titleEl.textContent = this.pr ? `PR Layers · #${this.pr.number}` : "PR Layers";
    void this.refreshAuth().then(() => this.analyze(false));
  }

  private renderAll() {
    const res = this.result;
    if (!res) return;
    this.titleEl.textContent = `#${res.pr.number} ${res.meta.title}`;
    this.titleEl.title = res.meta.title;
    const s = summarize(res.plan, this.review);
    const key = `${prKey(res.pr)}@${res.meta.headSha}${this.demo ? ":demo" : ""}`;
    if (this.openFor !== key) {
      this.openFor = key;
      this.openSteps = new Set();
      this.selected = null;
      const cur = currentStep(res.plan, this.review);
      if (cur >= 0) this.openSteps.add(res.plan.layers[cur].id);
    }
    const pg = progress(res.plan, this.review);
    const bar = el("div", { class: "pbar", role: "progressbar", "aria-label": "Files reviewed", "aria-valuemin": "0", "aria-valuemax": String(pg.totalFiles), "aria-valuenow": String(pg.reviewedFiles) }, el("i"));
    (bar.firstChild as HTMLElement).style.width = `${Math.round(pg.ratio * 100)}%`;
    const [stepPart, filesPart] = pg.text.split(" · ");
    this.subEl.replaceChildren(el("div", { class: "plbl" }, el("b", {}, stepPart), el("span", {}, filesPart ?? "")), bar);
    this.menuBtn.classList.toggle("has-warn", res.plan.warnings.length > 0);
    const scroll = this.panes.review.scrollTop;
    this.panes.review.replaceChildren(
      renderReview(res.plan, this.review, {
        open: this.openSteps,
        selected: this.selected,
        onSelect: (p) => this.select(p),
        onToggleFile: (f, on) => this.setFileReviewed(f, on),
        onToggleStep: (l, on) => this.setStepReviewed(l, on),
        onOpen: (l, open) => {
          if (open) this.openSteps.add(l.id);
          else this.openSteps.delete(l.id);
          this.renderAll();
          this.focusIn(`[data-layer="${CSS.escape(l.id)}"] .sh`);
        },
        onMarkNext: (l) => this.markNext(l, true),
      }),
    );
    this.panes.review.scrollTop = scroll;
    if (this.view === "graph") this.renderGraph();
    this.overlayGraph?.setData(res.plan, { reviewedLayers: s.reviewedLayers, reviewedPaths: s.reviewedPaths, changedPaths: s.changedPaths });
  }

  private focusIn(sel: string) {
    const e = this.panes.review.querySelector(sel) as HTMLElement | null;
    e?.focus({ preventScroll: true });
    e?.scrollIntoView?.({ block: "nearest" });
  }

  private saveReview() {
    if (!this.demo && this.result) void rpc({ type: "reviewed:set", key: prKey(this.result.pr), value: this.review }).catch(() => {});
  }

  /** Step checkbox: tick all of its files, or untick all. */
  private setStepReviewed(l: Layer, on: boolean) {
    const res = this.result;
    if (!res) return;
    this.review = setFilesReviewed(this.review, l.files, on, res.meta.headSha);
    this.saveReview();
    if (on) {
      this.openSteps.delete(l.id);
      const cur = currentStep(res.plan, this.review);
      if (cur >= 0) this.openSteps.add(res.plan.layers[cur].id);
    }
    this.renderAll();
  }

  private setFileReviewed(f: LayerFile, on: boolean) {
    if (!this.result) return;
    this.review = setFilesReviewed(this.review, [f], on, this.result.meta.headSha);
    this.saveReview();
    this.renderAll();
    this.focusIn(`.ftick[data-path="${CSS.escape(f.path)}"]`);
  }

  /** Select a file (opening its step) and jump to its diff. */
  select(path: string, focus = false) {
    const res = this.result;
    if (!res) return;
    const at = locate(res.plan, path);
    if (!at) return;
    this.selected = path;
    this.openSteps.add(res.plan.layers[at.layer].id);
    this.renderAll();
    if (focus) this.focusIn(`.fbtn[data-path="${CSS.escape(path)}"]`);
    void this.jump(path);
  }

  /**
   * "Mark file as reviewed & next →": marks the selected file (or the step's first unreviewed file), then selects the
   * next unreviewed file in the step, or opens the next step that has one, and jumps to it.
   */
  markNext(l?: Layer, focusCta = false) {
    const res = this.result;
    if (!res) return;
    const li = l ? res.plan.layers.indexOf(l) : (locate(res.plan, this.selected ?? "")?.layer ?? currentStep(res.plan, this.review));
    if (li < 0) return;
    const target = ctaTarget(res.plan, this.review, li, this.selected);
    if (!target) return;
    const file = res.plan.layers[li].files[target.file];
    this.review = setFilesReviewed(this.review, [file], true, res.meta.headSha);
    this.saveReview();
    const next = nextUnreviewed(res.plan, this.review, target);
    if (layerReview(res.plan.layers[li], this.review).state === "done") this.openSteps.delete(res.plan.layers[li].id);
    this.selected = next?.path ?? null;
    if (next) this.openSteps.add(res.plan.layers[next.layer].id);
    this.renderAll();
    if (next) {
      const step = `[data-layer="${CSS.escape(res.plan.layers[next.layer].id)}"]`;
      if (focusCta) this.focusIn(`${step} .next`);
      this.panes.review.querySelector(`.fbtn[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView?.({ block: "nearest" });
      void this.jump(next.path);
    } else {
      this.focusIn(".alldone");
    }
  }

  /** j / k: move the selection through files in review order. */
  private moveSelection(dir: 1 | -1) {
    const res = this.result;
    if (!res) return;
    const all = allFiles(res.plan);
    if (!all.length) return;
    const i = this.selected ? all.findIndex((f) => f.path === this.selected) : -1;
    let to: number;
    if (i < 0) {
      const cur = currentStep(res.plan, this.review);
      const start = cur >= 0 ? firstUnreviewed(res.plan, this.review, cur) : null;
      to = start ? all.findIndex((f) => f.path === start.path) : dir > 0 ? 0 : all.length - 1;
    } else to = Math.min(all.length - 1, Math.max(0, i + dir));
    this.select(all[to].path, true);
  }

  /** Panel shortcuts (n, j, k). Only when focus is in the panel and not in a text field. */
  private onPanelKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || this.view !== "review" || this.tour?.isActive()) return;
    const t = e.composedPath()[0] as HTMLElement | undefined;
    if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type)))) return;
    const k = e.key.toLowerCase();
    if (k === "n") this.markNext(undefined, false);
    else if (k === "j") this.moveSelection(1);
    else if (k === "k") this.moveSelection(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private renderGraph() {
    if (!this.result) return;
    if (!this.graphView) {
      this.graphView = new GraphView({
        compact: true,
        onJump: (p) => void this.jump(p),
        onExpand: () => this.openOverlay(),
        onOpenTab: () => void rpc({ type: "graph:openTab", pr: this.result!.pr, headSha: this.result!.meta.headSha, demo: this.demo }).catch((e) => (this.subEl.textContent = (e as Error).message)),
      });
      this.panes.graph.replaceChildren(this.graphView.el);
    }
    const s = summarize(this.result.plan, this.review);
    this.graphView.setData(this.result.plan, { reviewedLayers: s.reviewedLayers, reviewedPaths: s.reviewedPaths, changedPaths: s.changedPaths });
  }

  private openOverlay() {
    if (!this.result || this.overlay) return;
    const close = el("button", { type: "button", class: "x", title: "Close (Esc)", "aria-label": "Close graph" }, "✕");
    close.addEventListener("click", () => this.closeOverlay());
    this.overlayGraph = new GraphView({ onJump: (p) => void this.jump(p) });
    const box = el(
      "div",
      { class: "ov-box", role: "dialog", "aria-modal": "true", "aria-label": "Dependency graph" },
      el("div", { class: "hdr" }, el("div", { class: "ttl" }, `Graph · #${this.result.pr.number} ${this.result.meta.title}`), close),
      this.overlayGraph.el,
    );
    this.overlay = el("div", { class: "overlay" }, box);
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.closeOverlay();
    });
    this.root.append(this.overlay);
    const s = summarize(this.result.plan, this.review);
    this.overlayGraph.setData(this.result.plan, { reviewedLayers: s.reviewedLayers, reviewedPaths: s.reviewedPaths, changedPaths: s.changedPaths });
    close.focus();
  }

  private closeOverlay() {
    this.overlay?.remove();
    this.overlay = null;
    this.overlayGraph = null;
  }

  private async jump(path: string) {
    if (this.demo && this.result) {
      const url = `https://github.com/${this.result.pr.owner}/${this.result.pr.repo}/pull/${this.result.pr.number}/files#${await diffAnchor(path)}`;
      const a = el("a", { href: url, target: "_blank", rel: "noopener" }, "open it on GitHub");
      const exit = el("button", { type: "button", class: "btn" }, "Exit demo");
      exit.addEventListener("click", () => this.exitDemo());
      this.bannerEl.replaceChildren(el("span", { class: "toast" }, `Demo: on a real PR this opens the diff for ${path.slice(path.lastIndexOf("/") + 1)}. You can `, a, "."), exit);
      return;
    }
    this.closeOverlay();
    await jumpTo(path);
  }

  // ---------- tour ----------

  private async maybeAutoTour() {
    if (this.tour?.isActive() || this.view !== "review") return;
    if ((await getPref<boolean>("tourDone")) === true) return;
    requestAnimationFrame(() => this.startTour());
  }

  startTour() {
    if (!this.result) {
      // No PR data yet (e.g. no token): use the demo so every step has something to point at.
      this.loadDemo(false);
    }
    if (!this.open) this.toggle("bubble");
    this.setView("review", false);
    this.tour?.end(false);
    const q = (sel: string) => () => this.panes.review.querySelector(sel);
    const peek = (on: boolean) => () => this.panes.review.querySelector('[data-tour="file"]')?.classList.toggle("peek", on);
    const T = REVIEW_TOUR_TEXT;
    const steps: TourStep[] = [
      { target: q('[data-tour="step"] .sh'), ...T.layers, before: peek(false) },
      { target: q('.step.open [data-tour="why"]'), ...T.reasons, before: peek(false) },
      { target: q('[data-tour="file"]'), ...T.jump, before: peek(true) },
      { target: q('.step.open [data-tour="next"]'), ...T.check, before: peek(false) },
      { target: q('[data-tour="changed"]'), ...T.changed, before: peek(false) },
    ];
    this.tour = new Tour(this.root, steps, () => {
      peek(false)();
      void setPref("tourDone", true);
    });
    this.tour.start();
  }
}

/** Jump to a file using GitHub's own per-file anchor: #diff-<sha256(path)>. */
export async function jumpTo(path: string): Promise<void> {
  const anchor = await diffAnchor(path);
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(location.pathname);
  if (!m) return;
  const onFiles = /\/pull\/\d+\/(files|changes)(\/|$)/.test(location.pathname);
  if (!onFiles) {
    location.href = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}/files#${anchor}`;
    return;
  }
  if (location.hash === `#${anchor}`) history.replaceState(null, "", location.pathname + location.search);
  location.hash = anchor;
  const target = document.getElementById(anchor) ?? document.querySelector(`[data-tagsearch-path="${CSS.escape(path)}"]`);
  target?.scrollIntoView({ block: "start" });
}
