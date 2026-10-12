import type { AnalyzeResult, AuthStatus, PrefKey, PRRef, Request, Response } from "../shared/messages";
import { diffAnchor, prKey } from "../shared/pr-url";
import { scrollToDiff, scrollToLine } from "./scroll";
import { dismissKey, normalizeRiskPrefs, riskByFile, visibleFindings, type FileRisk, type RiskPrefs, DEFAULT_RISK_PREFS } from "../engine/risk";
import type { Finding } from "../engine/risk/types";
import type { RiskView } from "./risk-view";
import { normalizeDismissed, riskKey } from "../shared/risk-keys";
import { SYNC_MESSAGES, syncViewed } from "./viewed-sync";
import type { Layer } from "../engine/types";
import { WIDGET_CSS, WIDGET_CSS_V3 } from "./widget.css";
import { GRAPH_CSS } from "../graph/svg";
import { GraphView, GRAPH_VIEW_CSS } from "../graph/view";
import { toDom } from "../graph/vdom";
import { allFiles, clearReview, ctaTarget, currentStep, dismissStale, emptyReview, firstUnreviewed, keepStale, layerReview, locate, nextUnreviewed, normalizeReviewState, popUndo, progress, pruneUndo, pushUndo, rebaseUndo, reviewedAtHead, setFilesReviewed, staleBannerVisible, staleFiles, staleSummary, summarize, untickStale, type CompareInfo, type ReviewState, type UndoEntry } from "./review-logic";
import type { LayerFile } from "../engine/types";
import { renderReview } from "./review-view";
import { REVIEW_TOUR_TEXT, Tour, TOUR_CSS, type TourStep } from "./tour";
import demoData from "../demo/demo-plan.json";
import demoHistory from "../demo/demo-history.json";
import { DEFAULT_FONT_PREFS, FONT_ORDER, FONT_PREF_KEYS, FONTS, fontStack, fontVars, ligaturesOn, normalizeFontPrefs, SIZE_LABEL, SIZE_ORDER, type CodeFont, type FontPrefs, type FontSize } from "../shared/fonts";
import { applyDiffFont, ensureFontFaces } from "./fonts-dom";
import type { CommitHistory } from "../shared/history";
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

export const HOST_ID = "codesloth-widget-host";
export type View = "review" | "graph";
const DEMO = demoData as unknown as AnalyzeResult;
const DEMO_HISTORY = demoHistory as unknown as CommitHistory;

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

/** CodeSloth mark (concept 1, assets/icons/icon-tiny.svg) without its tile: the bubble itself is the tile. Built as a vdom tree, so no innerHTML. */
const E = (attrs: Record<string, string | number>) => ({ tag: "ellipse", attrs, children: [] });
const P = (attrs: Record<string, string | number>) => ({ tag: "path", attrs, children: [] });
const ICON = {
  tag: "svg",
  attrs: { viewBox: "20 24 88 84", "aria-hidden": "true", class: "sloth" },
  children: [
    E({ cx: 64, cy: 66, rx: 40, ry: 37, fill: "#B88A5E" }),
    E({ cx: 64, cy: 69, rx: 33, ry: 28, fill: "#F4E8D2" }),
    E({ cx: 49, cy: 62, rx: 13.2, ry: 8.16, transform: "rotate(-25 49 62)", fill: "#5A3B26" }),
    P({ d: "M43 61.5 L55 61.5", stroke: "#F4E8D2", "stroke-width": 3.6, "stroke-linecap": "round" }),
    E({ cx: 79, cy: 62, rx: 13.2, ry: 8.16, transform: "rotate(25 79 62)", fill: "#5A3B26" }),
    P({ d: "M73 61.5 L85 61.5", stroke: "#F4E8D2", "stroke-width": 3.6, "stroke-linecap": "round" }),
    E({ cx: 64, cy: 76, rx: 6, ry: 4.5, fill: "#22160E" }),
  ],
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

/**
 * Demo: steps 1-2 were reviewed at an older head (the PR's 3rd commit), then "pushed" again: two of those files now
 * have newer content, so their ticks are stale and the banner shows. Computed from the bundled real data.
 */
function demoReview(): ReviewState {
  const [core, callers] = DEMO.plan.layers;
  const files = [...(core?.files ?? []), ...(callers?.files ?? [])];
  const base = DEMO_HISTORY.commits[2]?.sha ?? "demo-old-head";
  let st = setFilesReviewed(emptyReview(), files, true, base, "2026-09-26T14:00:00Z");
  const staled = [files[0], files.find((f) => f.path.endsWith("routing.py")) ?? files[1]].filter(Boolean);
  st = setFilesReviewed(st, staled.map((f) => ({ path: f!.path, sha: "an-older-blob-sha" })), true, base, "2026-09-26T14:00:00Z");
  return st;
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
  /** Pinned Review footer (CTA row + hint, or the done message), outside the scrolling list. */
  private footEl!: HTMLElement;
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
  /** "Sync with GitHub Viewed" (options page / ⋯ menu); off by default. */
  private syncOn = false;
  /** Files whose GitHub Viewed state couldn't be synced: path -> tooltip. */
  private unsynced = new Map<string, string>();
  /** Commit story for the current result; loaded lazily after the plan renders. */
  private history: CommitHistory | null = null;
  private historyKey = "";
  private historyNote: string | null = null;
  /** Timeline expanded (session pref, default closed) / showing all commits (this selection only). */
  private storyOpen = false;
  private storyAll = false;
  /** Stale-review banner: file list expanded; compare result for "N new commits" when the commit story can't tell. */
  private staleListOpen = false;
  private compare: { key: string; info: CompareInfo | null } | null = null;
  /** Restart review: inline confirm shown / undo toast. */
  private confirmRestart = false;
  private notice: { text: string; undo?: () => void } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private restartBtn!: HTMLButtonElement;
  /** Code font settings (tab-row "Aa" popover). */
  private fontPrefs: FontPrefs = { ...DEFAULT_FONT_PREFS };
  private fontBtn!: HTMLButtonElement;
  private fontPop!: HTMLElement;
  private demo = false;
  /** Risky changes: user settings, per-PR "Not breaking" dismissals, filter/list state. */
  private riskPrefs: RiskPrefs = { ...DEFAULT_RISK_PREFS };
  private dismissed: Record<string, string> = {};
  private riskFilter = false;
  private riskListOpen = false;
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

    this.bubble = el("button", { class: "bubble", type: "button", title: "CodeSloth (Alt+Shift+L)", "aria-label": "Toggle CodeSloth", "aria-expanded": "false" }) as HTMLButtonElement;
    this.bubble.append(toDom(ICON), el("span", { class: "dot" }));

    this.titleEl = el("div", { class: "ttl" }, "CodeSloth");
    this.menuBtn = el("button", { type: "button", class: "icon", title: "More: re-analyze, tour, demo, settings, details", "aria-label": "More options", "aria-haspopup": "menu", "aria-expanded": "false" }, "⋯") as HTMLButtonElement;
    const closeBtn = el("button", { type: "button", class: "x", title: "Close (Esc)", "aria-label": "Close" }, "✕");
    const hdr = el("div", { class: "hdr" }, this.titleEl, this.menuBtn, closeBtn);
    this.menu = el("div", { class: "menu", role: "menu", hidden: "" });

    // GitHub-style underline tabs with full ARIA tab semantics.
    const tablist = el("div", { class: "tabs", role: "tablist", "aria-label": "CodeSloth views" });
    const mkTab = (v: View, label: string) => el("button", { type: "button", role: "tab", id: `prl-tab-${v}`, "aria-controls": `prl-pane-${v}`, "aria-selected": "false", tabindex: "-1", class: "tab" }, label) as HTMLButtonElement;
    this.tabs = { review: mkTab("review", "Review"), graph: mkTab("graph", "Graph") };
    tablist.append(this.tabs.review, this.tabs.graph);
    // Restart review: compact ghost button at the right end of the tab row (Review tab only; icon-only when narrow).
    this.restartBtn = el("button", { type: "button", class: "restart", title: "Restart review: clear all ticks for this PR", "aria-label": "Restart review", hidden: "" }, el("span", { class: "ri", "aria-hidden": "true" }, "↺"), el("span", { class: "lbl" }, "Restart review")) as HTMLButtonElement;
    this.restartBtn.addEventListener("click", () => this.askRestart());
    // Code font: "Aa" popover, on both tabs, left of Restart.
    this.fontBtn = el("button", { type: "button", class: "fontbtn", title: "Code font & size", "aria-label": "Code font and size", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "prl-fontpop" }, el("span", { class: "aa", "aria-hidden": "true" }, "Aa")) as HTMLButtonElement;
    this.fontBtn.addEventListener("click", () => this.toggleFontPop());
    this.fontPop = el("div", { class: "fontpop", id: "prl-fontpop", role: "dialog", "aria-label": "Code font", hidden: "" });
    this.fontPop.addEventListener("keydown", (e) => this.onFontPopKey(e));
    const tabbar = el("div", { class: "tabbar" }, tablist, this.fontBtn, this.restartBtn);
    this.panes = {
      review: el("div", { class: "pane body", role: "tabpanel", id: "prl-pane-review", "aria-labelledby": "prl-tab-review", tabindex: "0" }),
      graph: el("div", { class: "pane graph", role: "tabpanel", id: "prl-pane-graph", "aria-labelledby": "prl-tab-graph", hidden: "" }),
    };
    this.footEl = el("div", { class: "rfoot", role: "group", "aria-label": "Review actions", hidden: "" });
    this.panes.review.addEventListener("scroll", () => this.updateFootShade(), { passive: true });
    this.bannerEl = el("div", { class: "banner", hidden: "" });
    this.subEl = el("div", { class: "sub", "aria-live": "polite" });
    this.panel = el("div", { class: "panel", role: "dialog", "aria-label": "CodeSloth" }, hdr, this.menu, tabbar, this.fontPop, this.bannerEl, this.subEl, this.panes.review, this.footEl, this.panes.graph);
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
      else if (!this.fontPop.hidden) this.toggleFontPop(false);
      else if (!this.menu.hidden) this.toggleMenu(false);
      else if (this.overlay) this.closeOverlay();
      else this.toggle("escape");
    };
    document.addEventListener("keydown", onKey, true);
    // Click outside the popover closes it.
    this.root.addEventListener("pointerdown", (e) => {
      if (!this.fontPop.hidden && !e.composedPath().some((n) => n === this.fontPop || n === this.fontBtn)) this.toggleFontPop(false, false);
    });
    void this.loadFontPrefs();
    void this.loadRiskPrefs();
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
    void this.loadSyncPref();
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
    applyDiffFont(document, null);
    this.cleanups.forEach((f) => f());
    this.cleanups = [];
    this.host?.remove();
  }

  setPr(pr: PRRef | null) {
    const changed = !this.pr || !pr || prKey(pr) !== prKey(this.pr);
    this.pr = pr;
    if (changed && !this.demo) {
      this.result = null;
      this.footEl.replaceChildren();
    this.panes.review.replaceChildren();
      this.subEl.textContent = "";
      this.titleEl.textContent = pr ? `CodeSloth · #${pr.number}` : "CodeSloth";
      if (this.open) void this.analyze(false);
    }
  }

  toggle(ev: ToggleEvent) {
    const want = nextOpen(this.open, ev);
    if (want === this.open) return;
    this.open = want;
    this.panel.hidden = !want;
    this.bubble.setAttribute("aria-expanded", String(want));
    this.updateBubble();
    this.layout();
    if (want) {
      void this.loadSyncPref();
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
    this.bubble.title = none ? "CodeSloth: set up a read-only token (or try the demo)" : `CodeSloth (@${this.auth?.login ?? "token"}) · Alt+Shift+L`;
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
    this.updateRestart();
    this.syncFoot();
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
      if (this.historyNote) meta.push(el("div", { class: "meta" }, this.historyNote));
      for (const n of this.history?.notes ?? []) meta.push(el("div", { class: "meta" }, `Commit story: ${n}`));
      if (!res.risk && !this.demo) meta.push(el("div", { class: "meta warn" }, "⚠ Risky changes: checks didn't run for this analysis. Re-analyze to try again."));
      else if (res.risk?.config) meta.push(el("div", { class: "meta" }, `Risky changes: ${res.risk.config}`));
    }
    this.menu.replaceChildren(
      item(this.demo ? "Reload demo" : "Re-analyze", () => (this.demo ? this.loadDemo() : void this.analyze(true))),
      item("Take the tour", () => this.startTour()),
      ...(this.result ? [item("Restart review…", () => this.askRestart())] : []),
      this.demo ? item("Exit demo", () => this.exitDemo()) : item("Try demo (sample PR, no token needed)", () => this.loadDemo(true)),
      this.syncItem(),
      ...(this.result && !this.demo ? [item(`Risk sensitivity: ${this.riskPrefs.sensitivity[0].toUpperCase()}${this.riskPrefs.sensitivity.slice(1)} (click to change)`, () => this.cycleSensitivity())] : []),
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
    // The Graph tab takes the full available panel height unless the user resized the panel.
    const h = this.preferredHeight ?? (this.view === "graph" ? place.maxHeight : undefined);
    this.panel.style.height = h ? `${Math.min(h, place.maxHeight)}px` : "";
    this.updateFootShade();
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
    this.footEl.replaceChildren();
    this.panes.review.replaceChildren(
      el(
        "div",
        { class: "setup" },
        el("p", {}, "CodeSloth needs a fine-grained GitHub token with only ", el("b", {}, "Pull requests: Read-only"), " and ", el("b", {}, "Contents: Read-only"), "."),
        el("p", { class: "muted" }, "Your token is stored only on this device, in CodeSloth's extension storage. GitHub pages and other extensions can't read it. It's sent only to api.github.com, for read-only requests."),
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
      this.dismissed = normalizeDismissed(await rpc({ type: "reviewed:get", key: riskKey(res.pr) }).catch(() => ({})));
      this.renderAll();
      void this.maybeAutoTour();
      void this.loadHistory(res);
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
    this.history = DEMO_HISTORY;
    this.historyNote = null;
    this.historyKey = "demo";
    this.review = demoReview();
    this.dismissed = {};
    this.riskFilter = false;
    this.riskListOpen = false;
    this.staleListOpen = false;
    this.compare = null;
    this.clearNotice();
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
    this.clearNotice();
    this.compare = null;
    this.result = null;
    this.history = null;
    this.historyKey = "";
    this.review = emptyReview();
    this.dismissed = {};
    this.riskFilter = false;
    this.bannerEl.hidden = true;
    this.footEl.replaceChildren();
    this.panes.review.replaceChildren();
    this.panes.graph.replaceChildren();
    this.graphView = null;
    this.titleEl.textContent = this.pr ? `CodeSloth · #${this.pr.number}` : "CodeSloth";
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
      this.riskFilter = false;
      this.riskListOpen = false;
      const cur = currentStep(res.plan, this.review);
      if (cur >= 0) this.openSteps.add(res.plan.layers[cur].id);
    }
    const pg = progress(res.plan, this.review);
    const bar = el("div", { class: "pbar", role: "progressbar", "aria-label": "Files reviewed", "aria-valuemin": "0", "aria-valuemax": String(pg.totalFiles), "aria-valuenow": String(pg.reviewedFiles) }, el("i"));
    (bar.firstChild as HTMLElement).style.width = `${Math.round(pg.ratio * 100)}%`;
    const [stepPart, filesPart, stalePart] = pg.text.split(" · ");
    this.subEl.replaceChildren(el("div", { class: "plbl" }, el("b", {}, stepPart), el("span", {}, filesPart ?? "", stalePart ? el("span", { class: "stale-n", title: "Ticked files that changed since you reviewed them" }, ` · ${stalePart}`) : "")), bar);
    const head = res.meta.headSha;
    const bannerOn = staleBannerVisible(res.plan, this.review, head);
    const staleSum = staleFiles(res.plan, this.review).length ? staleSummary(res.plan, this.review, this.history, this.compare?.info) : null;
    if (bannerOn) this.maybeCompare(res);
    this.menuBtn.classList.toggle("has-warn", res.plan.warnings.length > 0);
    const scroll = this.panes.review.scrollTop;
    const undoStack = this.undoStack();
    this.footEl.replaceChildren();
    this.panes.review.replaceChildren(
      renderReview(res.plan, this.review, {
        open: this.openSteps,
        selected: this.selected,
        unsynced: this.unsynced,
        history: this.history,
        storyOpen: this.storyOpen,
        storyAll: this.storyAll,
        onToggleStory: (open) => {
          this.storyOpen = open;
          void setPref("storyOpen", open);
          this.renderAll();
          this.focusIn("li.file.sel .tltog");
        },
        onToggleStoryAll: (all) => {
          this.storyAll = all;
          this.renderAll();
          this.focusIn("li.file.sel .tlmore");
        },
        commitUrl: (sha) => `https://github.com/${res.pr.owner}/${res.pr.repo}/pull/${res.pr.number}/commits/${sha}`,
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
        onPrevious: () => this.previous(true),
        canPrevious: undoStack.length > 0,
        previousPath: undoStack[undoStack.length - 1]?.path ?? null,
        stale: bannerOn ? staleSum : null,
        staleCommits: new Map((staleSum?.files ?? []).map((f) => [f.path, f.commits])),
        staleListOpen: this.staleListOpen,
        onToggleStaleList: (open) => {
          this.staleListOpen = open;
          this.renderAll();
          this.focusIn('.stalebar [data-act="show"]');
        },
        onUntickStale: () => this.untickStale(),
        onKeepStale: () => this.keepStale(),
        onDismissStale: () => {
          this.review = dismissStale(this.review, head);
          this.saveReview();
          this.renderAll();
        },
        risk: this.riskView(),
      }),
    );
    const src = this.panes.review.querySelector(".rfoot-src");
    this.footEl.replaceChildren(...(src ? [...src.children] : []));
    src?.remove();
    this.syncFoot();
    const top = this.panes.review.firstElementChild;
    if (this.confirmRestart || this.notice) top?.prepend(this.restartNotice(Object.keys(this.review.files).length));
    this.updateRestart();
    this.updateBubble();
    this.panes.review.scrollTop = scroll;
    if (this.view === "graph") this.renderGraph();
    this.overlayGraph?.setData(res.plan, { reviewedLayers: s.reviewedLayers, reviewedPaths: s.reviewedPaths, changedPaths: s.changedPaths, risk: this.riskSeverities() });
  }

  /** The footer shows only on the Review tab, when it has a CTA or the done message. */
  private syncFoot() {
    this.footEl.hidden = this.view !== "review" || !this.footEl.childElementCount;
    this.updateFootShade();
  }

  /** Top border/shadow on the footer while list content continues beneath it. */
  private updateFootShade() {
    const p = this.panes.review;
    this.footEl.classList.toggle("shade", !this.footEl.hidden && p.scrollHeight - p.scrollTop - p.clientHeight > 1);
  }

  /* ---------------- risky changes ---------------- */

  /** Active (visible, not dismissed) findings grouped by file. */
  private riskFiles(): Map<string, FileRisk> {
    const r = this.result?.risk;
    // The demo sample only has low-level flags, so demo mode shows Strict (it says so in the list).
    const prefs = this.demo ? { ...this.riskPrefs, sensitivity: "strict" as const } : this.riskPrefs;
    return riskByFile(visibleFindings(r, prefs, r?.sensitivity), this.dismissed);
  }

  private riskSeverities(): Map<string, "high" | "medium" | "low"> {
    const out = new Map<string, "high" | "medium" | "low">();
    for (const [p, v] of this.riskFiles()) if (v.findings.length) out.set(p, v.severity);
    return out;
  }

  private riskView(): RiskView | undefined {
    const res = this.result;
    if (!res) return undefined;
    const r = res.risk;
    const notes: string[] = [];
    if (!r) {
      if (!this.demo) notes.push("Risk checks didn't run for this analysis. Re-analyze to try again.");
    } else {
      if (r.config) notes.push(r.config);
      if (r.notChecked.length) notes.push(`Not checked (GitHub sent no diff): ${r.notChecked.length} file${r.notChecked.length === 1 ? "" : "s"}`);
      const s = this.riskPrefs.sensitivity;
      if (!this.demo) notes.push(`Sensitivity: ${s[0].toUpperCase()}${s.slice(1)}${r.sensitivity && r.sensitivity !== s ? ` (repo asks for ${r.sensitivity}; the stricter applies)` : ""}${this.riskPrefs.off.length ? ` · off: ${this.riskPrefs.off.join(", ")}` : ""}`);
    }
    return {
      byFile: this.riskFiles(),
      passed: r?.passed ?? [],
      filter: this.riskFilter,
      listOpen: this.riskListOpen,
      notes,
      onFilter: (on) => {
        this.riskFilter = on;
        if (on) for (const l of res.plan.layers) if (l.files.some((f) => this.riskFiles().get(f.path)?.findings.length)) this.openSteps.add(l.id);
        this.renderAll();
        this.focusIn('[data-act="risk-filter"]');
      },
      onList: (open) => {
        this.riskListOpen = open;
        this.renderAll();
        this.focusIn('[data-act="risk-list"]');
      },
      onSelect: (p) => this.select(p, true),
      onDismiss: (f) => this.setDismissed(f, true),
      onRestore: (f) => this.setDismissed(f, false),
      onLine: (f, line) => void this.jumpLine(f.path, line),
    };
  }

  private setDismissed(f: Finding, on: boolean) {
    const k = dismissKey(f);
    const next = { ...this.dismissed };
    if (on) next[k] = new Date().toISOString();
    else delete next[k];
    this.dismissed = next;
    if (!this.demo && this.result) void rpc({ type: "reviewed:set", key: riskKey(this.result.pr), value: next }).catch(() => {});
    this.renderAll();
    this.focusIn(`li.file.sel .rcard .fd[data-rule="${CSS.escape(f.rule)}"] .linkbtn, li.file.sel .rcard .linkbtn, li.file.sel .fbtn`);
  }

  /** r: select the next file with an active finding, in review order (wraps). */
  nextRisky() {
    const res = this.result;
    if (!res) return;
    const risky = this.riskFiles();
    const all = allFiles(res.plan).filter((f) => risky.get(f.path)?.findings.length);
    if (!all.length) return;
    const order = allFiles(res.plan).map((f) => f.path);
    const at = this.selected ? order.indexOf(this.selected) : -1;
    const next = all.find((f) => order.indexOf(f.path) > at) ?? all[0];
    this.select(next.path, true);
  }

  /** Risk sensitivity / category settings (also on the settings page). */
  async loadRiskPrefs() {
    const [s, off] = await Promise.all([getPref<string>("riskSensitivity"), getPref<string[]>("riskOff")]);
    this.riskPrefs = normalizeRiskPrefs(s, off);
    if (this.result) this.renderAll();
  }

  private cycleSensitivity() {
    const order = ["relaxed", "normal", "strict"] as const;
    const next = order[(order.indexOf(this.riskPrefs.sensitivity) + 1) % order.length];
    this.riskPrefs = { ...this.riskPrefs, sensitivity: next };
    void setPref("riskSensitivity", next);
    this.renderAll();
  }

  private async jumpLine(path: string, line: { side: "R" | "L"; n: number }) {
    const res = this.result;
    if (!res) return;
    const anchor = await diffAnchor(path);
    const filesUrl = `https://github.com/${res.pr.owner}/${res.pr.repo}/pull/${res.pr.number}/files`;
    if (this.demo) {
      const a = el("a", { href: `${filesUrl}#${anchor}${line.side}${line.n}`, target: "_blank", rel: "noopener" }, "open that line on GitHub");
      const exit = el("button", { type: "button", class: "btn" }, "Exit demo");
      exit.addEventListener("click", () => this.exitDemo());
      this.bannerEl.replaceChildren(el("span", { class: "toast" }, `Demo: on a real PR this scrolls to ${line.side}${line.n} in ${path.slice(path.lastIndexOf("/") + 1)}. You can `, a, "."), exit);
      return;
    }
    this.closeOverlay();
    const onFiles = /\/pull\/\d+\/(files|changes)(\/|$)/.test(location.pathname);
    const r = await scrollToLine(path, anchor, line.side, line.n, filesUrl, onFiles, { doc: document, win: window });
    if (r === "file" || r === "missing") this.setNotice(`Line ${line.side}${line.n} isn't loaded in GitHub's diff (collapsed or not rendered yet); scrolled to the file instead.`);
    if (r === "file" || r === "missing") this.renderAll();
  }

  private focusIn(sel: string) {
    const f = this.footEl.querySelector(sel) as HTMLElement | null;
    if (f) return f.focus({ preventScroll: true });
    const e = this.panes.review.querySelector(sel) as HTMLElement | null;
    e?.focus({ preventScroll: true });
    if (e) this.reveal(e);
  }

  /** Scroll only the Review pane (never the panel or page) so `el` is visible. */
  private reveal(target: HTMLElement) {
    const pane = this.panes.review;
    const el = (target.closest("li.file") as HTMLElement | null) ?? target; // include the selected file's timeline
    const p = pane.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < p.top) pane.scrollTop -= p.top - r.top + 8;
    else if (r.bottom > p.bottom) pane.scrollTop += Math.min(r.bottom - p.bottom + 8, r.top - p.top - 8);
  }

  /* ---------------- code font ---------------- */

  /** (Re)read font settings and apply them live (also called when another page changes them). */
  async loadFontPrefs() {
    const raw: Record<string, unknown> = {};
    await Promise.all(FONT_PREF_KEYS.map(async (k) => (raw[k] = await getPref(k))));
    this.fontPrefs = normalizeFontPrefs(raw);
    this.applyFonts();
  }

  private applyFonts() {
    const p = this.fontPrefs;
    if (p.codeFont !== "default") ensureFontFaces(document, (path) => chrome.runtime.getURL(path));
    for (const [k, v] of Object.entries(fontVars(p))) this.root.style.setProperty(k, v);
    this.root.dataset.font = p.codeFont;
    this.root.dataset.size = p.fontSize;
    applyDiffFont(document, p);
    if (!this.fontPop.hidden) this.renderFontPop();
  }

  private setFontPref<K extends keyof FontPrefs>(key: K, value: FontPrefs[K]) {
    this.fontPrefs = { ...this.fontPrefs, [key]: value };
    void setPref(key as PrefKey, value);
    this.applyFonts();
    if (this.view === "graph") this.renderGraph();
  }

  toggleFontPop(force?: boolean, returnFocus = true) {
    const show = force ?? this.fontPop.hidden;
    if (show === !this.fontPop.hidden) return;
    this.fontPop.hidden = !show;
    this.fontBtn.setAttribute("aria-expanded", String(show));
    if (show) {
      this.toggleMenu(false);
      ensureFontFaces(document, (path) => chrome.runtime.getURL(path)); // so each name can preview in its font
      this.renderFontPop();
      (this.fontPop.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement | null)?.focus();
    } else if (returnFocus) this.fontBtn.focus({ preventScroll: true });
  }

  private renderFontPop() {
    const p = this.fontPrefs;
    const act = (this.root.getRootNode() as ShadowRoot | Document).activeElement as HTMLElement | null;
    const focusSel = act && this.fontPop.contains(act) ? (act.dataset.font ? `[data-font="${act.dataset.font}"]` : act.dataset.size ? `[data-size="${act.dataset.size}"]` : act.id ? `#${act.id}` : null) : null;
    const bar = this.fontBtn.parentElement as HTMLElement;
    this.fontPop.style.top = `${bar.offsetTop + bar.offsetHeight + 4}px`;
    const fontGroup = el("div", { class: "fp-group", role: "radiogroup", "aria-label": "Code font" });
    for (const k of FONT_ORDER) {
      const on = p.codeFont === k;
      const b = el("button", { type: "button", role: "radio", class: "fp-font", "aria-checked": String(on), tabindex: on ? "0" : "-1", "data-font": k }, el("span", { class: "fp-name" }, FONTS[k].label), el("span", { class: "fp-sample", "aria-hidden": "true" }, "=> != {}"));
      b.style.fontFamily = fontStack(k);
      b.style.fontVariantLigatures = k !== "default" && ligaturesOn({ ...p, codeFont: k }) ? "normal" : "none";
      b.addEventListener("click", () => this.setFontPref("codeFont", k as CodeFont));
      fontGroup.append(b);
    }
    const sizeGroup = el("div", { class: "fp-seg", role: "radiogroup", "aria-label": "Panel text size" });
    for (const sz of SIZE_ORDER) {
      const on = p.fontSize === sz;
      const b = el("button", { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1", "data-size": sz }, SIZE_LABEL[sz]);
      b.addEventListener("click", () => this.setFontPref("fontSize", sz as FontSize));
      sizeGroup.append(b);
    }
    const lig = el("input", { type: "checkbox", id: "prl-fp-lig" }) as HTMLInputElement;
    lig.checked = ligaturesOn(p);
    lig.addEventListener("change", () => this.setFontPref("ligatures", lig.checked));
    const ui = el("input", { type: "checkbox", id: "prl-fp-ui" }) as HTMLInputElement;
    ui.checked = p.uiFont;
    ui.addEventListener("change", () => this.setFontPref("uiFont", ui.checked));
    const bundled = p.codeFont !== "default";
    const diff = el("input", { type: "checkbox", id: "prl-fp-diff" }) as HTMLInputElement;
    diff.checked = p.diffFont;
    diff.addEventListener("change", () => this.setFontPref("diffFont", diff.checked));
    const kids: (HTMLElement | false)[] = [
      el("div", { class: "fp-h" }, "Code font"),
      fontGroup,
      el("div", { class: "fp-h" }, "Size"),
      sizeGroup,
      // Only fonts with ligature features get the toggle; "all panel text" only makes sense for a bundled font.
      FONTS[p.codeFont].hasLigatures && el("label", { class: "fp-chk", title: "Combine sequences like => and != into one glyph" }, lig, el("span", {}, "Ligatures")),
      bundled && el("label", { class: "fp-chk", title: `Also use ${FONTS[p.codeFont].label} for headings, why-lines and reasons, not just file names and SHAs` }, ui, el("span", {}, "Use for all panel text")),
      el("label", { class: "fp-chk", title: "Best effort: restyles GitHub's diff lines with this font (classic and new view)" }, diff, el("span", {}, "Also use in GitHub diffs")),
    ];
    this.fontPop.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
    if (focusSel) (this.fontPop.querySelector(focusSel) as HTMLElement | null)?.focus();
  }

  /** Arrow keys move within a radio group; Tab is trapped inside the popover; Esc is handled globally. */
  private onFontPopKey(e: KeyboardEvent) {
    const t = e.composedPath()[0] as HTMLElement;
    if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key) && t.getAttribute("role") === "radio") {
      const radios = [...(t.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
      const i = radios.indexOf(t);
      const next = radios[(i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : radios.length - 1)) % radios.length];
      e.preventDefault();
      next.click();
      (this.fontPop.querySelector(`[role="radio"][data-${next.dataset.font ? "font" : "size"}="${next.dataset.font ?? next.dataset.size}"]`) as HTMLElement | null)?.focus();
      return;
    }
    if (e.key === "Tab") {
      const items = [...this.fontPop.querySelectorAll<HTMLElement>('[role="radio"][tabindex="0"], input:not(:disabled)')];
      if (!items.length) return;
      const i = items.indexOf(t);
      const next = e.shiftKey ? items[(i <= 0 ? items.length : i) - 1] : items[(i + 1) % items.length];
      e.preventDefault();
      next.focus();
    }
    e.stopPropagation(); // keep n/j/k from firing while choosing
  }

  /** Stale dot on the bubble while the panel is closed. */
  private updateBubble() {
    const res = this.result;
    this.bubble.classList.toggle("stale", !this.open && !!res && staleFiles(res.plan, this.review).length > 0);
  }

  private updateRestart() {
    const res = this.result;
    this.restartBtn.hidden = !res || this.view !== "review";
    const n = res ? Object.keys(this.review.files).length : 0;
    this.restartBtn.disabled = n === 0;
    this.restartBtn.title = n ? `Restart review: clear all ${n} tick${n === 1 ? "" : "s"} for this PR` : "Restart review (nothing ticked yet)";
  }

  /** "N new commits": ask the compare API (1 read-only GET) when the commit story doesn't contain the reviewed head. */
  private maybeCompare(res: AnalyzeResult) {
    if (this.demo) return;
    const base = reviewedAtHead(this.review, staleFiles(res.plan, this.review).map((f) => f.path));
    if (!base || this.history?.commits.some((c) => c.sha === base)) return;
    const key = `${base}...${res.meta.headSha}`;
    if (this.compare?.key === key) return;
    this.compare = { key, info: null };
    void rpc<CompareInfo>({ type: "compare:get", pr: res.pr, base, head: res.meta.headSha })
      .then((info) => {
        if (this.compare?.key !== key) return;
        this.compare = { key, info };
        this.renderAll();
      })
      .catch(() => {});
  }

  /** Banner: remove the stale ticks, then open the first changed file's step and select it. */
  private untickStale() {
    const res = this.result;
    if (!res) return;
    const stale = staleFiles(res.plan, this.review);
    this.review = untickStale(res.plan, this.review, res.meta.headSha);
    this.saveReview();
    void this.syncFiles(stale, false);
    this.staleListOpen = false;
    if (stale[0]) this.select(stale[0].path, true);
    else this.renderAll();
  }

  /** Banner: accept the new versions as reviewed. */
  private keepStale() {
    const res = this.result;
    if (!res) return;
    const stale = staleFiles(res.plan, this.review);
    const before = this.review;
    this.review = keepStale(res.plan, this.review, res.meta.headSha);
    this.setUndoStack(rebaseUndo(this.undoStack(), before, this.review));
    this.saveReview();
    void this.syncFiles(stale, true);
    this.staleListOpen = false;
    this.renderAll();
  }

  askRestart() {
    if (!this.result || !Object.keys(this.review.files).length) return;
    this.toggleMenu(false);
    if (this.view !== "review") this.setView("review", true);
    this.clearNotice();
    this.confirmRestart = true;
    this.renderAll();
    this.panes.review.scrollTop = 0;
    (this.panes.review.querySelector('.restart-note [data-act="clear"]') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Clear every tick and stale state for this PR; back to step 1's first file. Undo for ~6 s. */
  restartReview() {
    const res = this.result;
    if (!res) return;
    const prev = this.review;
    const ticked = allFiles(res.plan).map((r) => res.plan.layers[r.layer].files[r.file]).filter((f) => prev.files[f.path]);
    this.confirmRestart = false;
    const prevUndo = this.undoStack();
    this.review = clearReview(res.meta.headSha);
    this.setUndoStack([]);
    this.saveReview();
    void this.syncFiles(ticked, false);
    const n = Object.keys(prev.files).length;
    this.setNotice(`Cleared ${n} tick${n === 1 ? "" : "s"}.`, () => {
      this.review = prev;
      this.setUndoStack(prevUndo);
      this.saveReview();
      void this.syncFiles(ticked, true);
      this.clearNotice();
      this.renderAll();
    });
    this.openSteps = new Set(res.plan.layers[0] ? [res.plan.layers[0].id] : []);
    this.selected = null;
    const first = res.plan.layers[0]?.files[0];
    this.panes.review.scrollTop = 0;
    if (first) this.select(first.path, true);
    else this.renderAll();
    this.panes.review.scrollTop = 0;
  }

  private setNotice(text: string, undo?: () => void) {
    this.clearNotice();
    this.notice = { text, undo };
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      if (this.result) this.renderAll();
    }, 6000);
  }

  private clearNotice() {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.notice = null;
    this.confirmRestart = false;
  }

  /** Inline confirm ("Clear all N ticks for this PR?") or the Undo toast, at the top of the Review tab. */
  private restartNotice(n: number): HTMLElement {
    if (this.confirmRestart) {
      const clear = el("button", { type: "button", class: "btn primary sm", "data-act": "clear" }, "Clear ticks");
      clear.addEventListener("click", () => this.restartReview());
      const cancel = el("button", { type: "button", class: "btn sm", "data-act": "cancel" }, "Cancel");
      cancel.addEventListener("click", () => {
        this.confirmRestart = false;
        this.renderAll();
        this.restartBtn.focus({ preventScroll: true });
      });
      return el("div", { class: "restart-note", role: "alertdialog", "aria-label": "Restart review" }, el("span", { class: "msg" }, `Clear all ${n} tick${n === 1 ? "" : "s"} for this PR?`), el("span", { class: "sacts" }, clear, cancel));
    }
    const note = this.notice!;
    const box = el("div", { class: "restart-note toast", role: "status" }, el("span", { class: "msg" }, note.text));
    if (note.undo) {
      const undo = el("button", { type: "button", class: "linkbtn", "data-act": "undo" }, "Undo");
      undo.addEventListener("click", note.undo);
      box.append(undo);
    }
    return box;
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
    void this.syncFiles(l.files, on);
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
    void this.syncFiles([f], on);
    this.renderAll();
    this.focusIn(`.ftick[data-path="${CSS.escape(f.path)}"]`);
  }

  /** Select a file (opening its step) and jump to its diff. */
  select(path: string, focus = false) {
    const res = this.result;
    if (!res) return;
    const at = locate(res.plan, path);
    if (!at) return;
    if (this.selected !== path) this.storyAll = false;
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
    this.setUndoStack(pushUndo(this.undoStack(), { path: file.path, at: this.review.files[file.path].at, viewed: this.syncOn && !this.demo }));
    this.saveReview();
    const next = nextUnreviewed(res.plan, this.review, target);
    if (layerReview(res.plan.layers[li], this.review).state === "done") this.openSteps.delete(res.plan.layers[li].id);
    this.selected = next?.path ?? null;
    if (next) this.openSteps.add(res.plan.layers[next.layer].id);
    this.renderAll();
    if (next) {
      const step = `[data-layer="${CSS.escape(res.plan.layers[next.layer].id)}"]`;
      if (focusCta) this.focusIn(`.rfoot ${step} .next`);
      const row = this.panes.review.querySelector(`.fbtn[data-path="${CSS.escape(next.path)}"]`);
      if (row) this.reveal(row as HTMLElement);
    } else {
      this.focusIn(".alldone");
    }
    // Tick GitHub's Viewed first (if enabled), let the page settle, then scroll to the next file.
    void this.syncFiles([file], true).then(() => (next ? this.jump(next.path) : undefined));
  }

  /** Session-only undo stack for "← Previous", per PR (kept in memory across GitHub's soft navigations). */
  private undoStacks = new Map<string, UndoEntry[]>();

  private undoKey(): string | null {
    return this.result ? `${this.demo ? "demo:" : ""}${prKey(this.result.pr)}` : null;
  }

  /** The PR's stack, pruned of entries whose tick is gone (unticked, Restart review, Untick changed files). */
  undoStack(): UndoEntry[] {
    const k = this.undoKey();
    if (!k) return [];
    const s = pruneUndo(this.undoStacks.get(k) ?? [], this.review);
    this.undoStacks.set(k, s);
    return s;
  }

  private setUndoStack(s: UndoEntry[]) {
    const k = this.undoKey();
    if (k) this.undoStacks.set(k, s);
  }

  /**
   * "← Previous" (p): undo the last "Mark file as reviewed & next". Unticks that file, re-selects it, reopens its step
   * and scrolls to its diff. Also unticks GitHub Viewed when CodeSloth ticked it and sync is still on.
   */
  previous(focusCta = false) {
    const res = this.result;
    if (!res) return;
    const r = popUndo(this.undoStack(), this.review);
    if (!r) return;
    this.review = r.state;
    this.setUndoStack(r.stack);
    this.saveReview();
    const at = locate(res.plan, r.entry.path);
    const file = at ? res.plan.layers[at.layer].files[at.file] : null;
    if (!at || !file) {
      this.renderAll();
      return;
    }
    if (this.selected !== file.path) this.storyAll = false;
    this.selected = file.path;
    this.openSteps.add(res.plan.layers[at.layer].id);
    this.renderAll();
    const step = `[data-layer="${CSS.escape(res.plan.layers[at.layer].id)}"]`;
    if (focusCta) this.focusIn(this.undoStack().length ? `.rfoot ${step} .prev` : `.rfoot ${step} .next`);
    const row = this.panes.review.querySelector(`.fbtn[data-path="${CSS.escape(file.path)}"]`);
    if (row) this.reveal(row as HTMLElement);
    const unview = r.entry.viewed ? this.syncFiles([file], false) : Promise.resolve();
    void unview.then(() => this.jump(file.path));
  }

  /** Fetch the commit story in the background; the plan is already on screen. Failure just hides it. */
  private async loadHistory(res: AnalyzeResult) {
    const key = `${prKey(res.pr)}@${res.meta.headSha}`;
    if (this.historyKey === key) return;
    this.historyKey = key;
    this.history = null;
    this.historyNote = "Commit story: loading…";
    try {
      const paths = res.plan.layers.flatMap((l) => l.files.map((f) => f.path));
      const h = await rpc<CommitHistory>({ type: "history:get", pr: res.pr, headSha: res.meta.headSha, commits: res.meta.commits, paths });
      if (this.historyKey !== key || this.demo) return;
      this.history = h;
      this.historyNote = null;
      this.renderAll();
    } catch (e) {
      if (this.historyKey !== key) return;
      this.historyNote = `Commit story unavailable: ${(e as Error).message}`;
    }
  }

  private async loadSyncPref() {
    this.syncOn = (await getPref<boolean>("syncViewed")) === true;
    this.storyOpen = (await getPref<boolean>("storyOpen").catch(() => null)) === true;
    if (!this.syncOn && this.unsynced.size) {
      this.unsynced.clear();
      this.renderAll();
    }
  }

  private syncItem() {
    const b = el("button", { type: "button", role: "menuitemcheckbox", "aria-checked": String(this.syncOn), title: "Best effort: ticks GitHub's own per-file Viewed checkbox when you mark a file reviewed here" }, `${this.syncOn ? "✓ " : ""}Sync with GitHub Viewed`);
    b.addEventListener("click", () => {
      this.toggleMenu(false);
      this.syncOn = !this.syncOn;
      void setPref("syncViewed", this.syncOn);
      if (!this.syncOn && this.unsynced.size) {
        this.unsynced.clear();
        this.renderAll();
      }
    });
    return b;
  }

  /**
   * Best-effort: mirror reviewed ticks onto GitHub's per-file Viewed control by clicking it in the page.
   * Resolves once the clicks for rendered files have happened (not when GitHub confirms them).
   */
  private async syncFiles(files: readonly LayerFile[], want: boolean): Promise<void> {
    if (this.demo || !this.syncOn || !files.length) return;
    const env = { doc: document, win: window };
    const anchors = await Promise.all(files.map((f) => diffAnchor(f.path)));
    const results = files.map((f, i) =>
      syncViewed(f.path, anchors[i], want, env).then((r) => {
        const had = this.unsynced.has(f.path);
        if (r === "missing" || r === "failed") this.unsynced.set(f.path, SYNC_MESSAGES[r]);
        else this.unsynced.delete(f.path);
        if (had !== this.unsynced.has(f.path) || r === "missing" || r === "failed") this.renderAll();
      }),
    );
    void Promise.all(results);
    await new Promise<void>((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));
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

  /** Panel shortcuts (n, p, j, k). Only when focus is in the panel and not in a text field. */
  private onPanelKey(e: KeyboardEvent) {
    if (e.altKey || e.ctrlKey || e.metaKey || this.view !== "review" || this.tour?.isActive()) return;
    const t = e.composedPath()[0] as HTMLElement | undefined;
    if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type)))) return;
    const k = e.key.toLowerCase();
    if (k === "n") this.markNext(undefined, false);
    else if (k === "p") this.previous(false);
    else if (k === "j") this.moveSelection(1);
    else if (k === "k") this.moveSelection(-1);
    else if (k === "r") this.nextRisky();
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
    this.graphView.setData(this.result.plan, { reviewedLayers: s.reviewedLayers, reviewedPaths: s.reviewedPaths, changedPaths: s.changedPaths, risk: this.riskSeverities() });
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
    this.overlayGraph.setData(this.result.plan, { reviewedLayers: s.reviewedLayers, reviewedPaths: s.reviewedPaths, changedPaths: s.changedPaths, risk: this.riskSeverities() });
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
      { target: () => this.footEl.querySelector('[data-tour="next"]'), ...T.check, before: peek(false) },
      // Only when this PR has flags to point at (always true in the demo).
      ...(this.panes.review.querySelector('[data-tour="risk"]') ? [{ target: q('[data-tour="risk"]'), ...T.risk, before: peek(false) }] : []),
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
  await scrollToDiff(path, anchor, `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}/files`, onFiles, { doc: document, win: window });
}
