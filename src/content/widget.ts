import type { AnalyzeResult, AuthStatus, PRRef, Request, Response } from "../shared/messages";
import { diffAnchor, prKey } from "../shared/pr-url";
import type { Layer } from "../engine/types";
import { WIDGET_CSS } from "./widget.css";
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

/** Talk to the background worker. The token never comes back to the page side. */
async function rpc<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error("Extension background not available. Reload the page.");
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.data;
}

const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg>`;

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
  private bodyEl!: HTMLElement;
  private refreshBtn!: HTMLButtonElement;
  private pos: WidgetPosition = { side: "right", top: 0 };
  private open = false;
  private pr: PRRef | null = null;
  private result: AnalyzeResult | null = null;
  private auth: AuthStatus | null = null;
  private busy = false;
  private preferredHeight?: number;
  private suppressClick = false;
  private cleanups: (() => void)[] = [];

  async mount() {
    this.host = el("div", { id: HOST_ID });
    // Closed shadow root: GitHub's page scripts can't reach into the widget's DOM.
    const shadow = this.host.attachShadow({ mode: "closed" });
    shadow.append(el("style", {}, WIDGET_CSS));
    this.root = el("div", { class: "root" });
    shadow.append(this.root);

    this.bubble = el("button", { class: "bubble", type: "button", title: "PR Layers (Alt+Shift+L)", "aria-label": "Toggle PR Layers", "aria-expanded": "false" }) as HTMLButtonElement;
    this.bubble.innerHTML = ICON;
    this.bubble.append(el("span", { class: "dot" }));

    this.titleEl = el("div", { class: "ttl" }, "PR Layers");
    this.refreshBtn = el("button", { type: "button", title: "Re-analyze (ignores cache)" }, "Re-analyze") as HTMLButtonElement;
    const closeBtn = el("button", { type: "button", class: "x", title: "Close (Esc)", "aria-label": "Close" }, "✕");
    const hdr = el("div", { class: "hdr" }, this.titleEl, this.refreshBtn, closeBtn);
    this.subEl = el("div", { class: "sub" });
    this.bodyEl = el("div", { class: "body" });
    this.panel = el("div", { class: "panel", role: "dialog", "aria-label": "PR Layers" }, hdr, this.subEl, this.bodyEl);
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
    this.refreshBtn.addEventListener("click", () => void this.analyze(true));
    this.enableDrag(this.bubble, true);
    this.enableDrag(hdr, false);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.open) return;
      const inWidget = e.composedPath().includes(this.host);
      const a = document.activeElement as HTMLElement | null;
      // Don't steal Esc from GitHub's own text fields (e.g. cancelling a comment).
      const typingInPage = !!a && a !== this.host && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
      if (inWidget || !typingInPage) this.toggle("escape");
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
    mq.addEventListener("change", applyTheme);
    const mo = new MutationObserver(applyTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode"] });
    this.cleanups.push(() => mq.removeEventListener("change", applyTheme), () => mo.disconnect());

    // Remember a user-resized height for this page session.
    const ro = new ResizeObserver(() => {
      if (!this.panel.hidden && this.panel.style.height) this.preferredHeight = this.panel.getBoundingClientRect().height;
    });
    ro.observe(this.panel);
    this.cleanups.push(() => ro.disconnect());

    this.pos = await loadPosition({ get: () => rpc({ type: "widget:getPosition" }), set: async () => {} }, viewport());
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
    this.cleanups.forEach((f) => f());
    this.cleanups = [];
    this.host?.remove();
  }

  setPr(pr: PRRef | null) {
    const changed = !this.pr || !pr || prKey(pr) !== prKey(this.pr);
    this.pr = pr;
    if (changed) {
      this.result = null;
      this.bodyEl.replaceChildren();
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
    } else if (ev === "escape" || ev === "close") {
      this.bubble.focus({ preventScroll: true });
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
    this.bubble.title = none ? "PR Layers: set up a read-only token" : `PR Layers (@${this.auth?.login ?? "token"}) · Alt+Shift+L`;
    if (none && this.open) this.renderSetup();
  }

  onAuthChanged() {
    this.result = null;
    void this.refreshAuth().then(() => {
      if (this.open && this.auth?.method === "pat") void this.analyze(false);
    });
  }

  progress(pr: PRRef, text: string) {
    if (this.pr && prKey(pr) === prKey(this.pr) && this.busy) this.subEl.textContent = text;
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
    if (this.preferredHeight) this.panel.style.height = `${Math.min(this.preferredHeight, place.maxHeight)}px`;
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

  // ---------- content ----------

  private renderSetup() {
    const btn = el("button", { type: "button", class: "btn primary" }, "Set up token");
    btn.addEventListener("click", () => void rpc({ type: "openOnboarding" }));
    this.subEl.textContent = "";
    this.bodyEl.replaceChildren(
      el(
        "div",
        { class: "setup" },
        el("p", {}, "PR Layers needs a fine-grained GitHub token with only ", el("b", {}, "Pull requests: Read-only"), " and ", el("b", {}, "Contents: Read-only"), "."),
        el("p", { class: "muted" }, "The token stays inside the extension. This page never sees it."),
        btn,
      ),
    );
  }

  async analyze(force: boolean) {
    if (!this.pr || this.busy) return;
    if (this.auth?.method !== "pat") return this.renderSetup();
    this.busy = true;
    this.refreshBtn.disabled = true;
    this.subEl.textContent = "Analyzing…";
    const pr = this.pr;
    try {
      const res = await rpc<AnalyzeResult>({ type: "analyze", pr, force });
      if (!this.pr || prKey(this.pr) !== prKey(pr)) return;
      this.result = res;
      await this.renderResult(res);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "no_token" || err.code === "unauthorized") {
        this.renderSetup();
        this.subEl.replaceChildren(el("span", { class: "err" }, err.message));
      } else {
        this.subEl.replaceChildren(el("span", { class: "err" }, err.message));
      }
    } finally {
      this.busy = false;
      this.refreshBtn.disabled = false;
    }
  }

  private async renderResult(res: AnalyzeResult) {
    this.titleEl.textContent = `#${res.pr.number} ${res.meta.title}`;
    this.titleEl.title = res.meta.title;
    const rate = res.rate ? ` · API ${res.rate.remaining}/${res.rate.limit}` : "";
    this.subEl.replaceChildren(
      el("div", {}, `${res.plan.stats.files} files · +${res.plan.stats.additions}/−${res.plan.stats.deletions} · ${res.plan.layers.length} layers · ${res.fromCache ? "cached" : "fresh"} @ ${res.meta.headSha.slice(0, 7)}${rate}`),
      ...res.plan.warnings.map((w) => el("div", { class: "warn" }, "⚠ " + w)),
    );
    const key = `${prKey(res.pr)}@${res.meta.headSha}`;
    const reviewed = await rpc<Record<string, boolean>>({ type: "reviewed:get", key }).catch(() => ({}) as Record<string, boolean>);
    this.bodyEl.replaceChildren(...res.plan.layers.map((l, i) => this.renderLayer(l, i, reviewed, key)));
  }

  private renderLayer(l: Layer, i: number, reviewed: Record<string, boolean>, key: string) {
    const done = !!reviewed[l.id];
    const d = el("details", { class: "layer" + (done ? " done" : "") });
    if (!done && i < 2) d.setAttribute("open", "");
    const cb = el("input", { type: "checkbox", title: "Mark layer reviewed", "aria-label": `Mark ${l.title} reviewed` }) as HTMLInputElement;
    cb.checked = done;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      reviewed[l.id] = cb.checked;
      void rpc({ type: "reviewed:set", key, value: reviewed }).catch(() => {});
      d.classList.toggle("done", cb.checked);
      if (cb.checked) d.removeAttribute("open");
    });
    d.append(
      el(
        "summary",
        {},
        cb,
        el("span", { class: "idx" }, `L${i}`),
        el("span", { class: "ltitle" }, l.title),
        el("span", { class: "stats" }, `${l.stats.files} · `, el("span", { class: "add" }, `+${l.stats.additions}`), " ", el("span", { class: "del" }, `−${l.stats.deletions}`)),
      ),
      el("div", { class: "desc" }, l.description),
    );
    const ul = el("ul", { class: "files" });
    for (const f of l.files) {
      const slash = f.path.lastIndexOf("/");
      const st = { added: "A", removed: "D", renamed: "R", modified: "M", copied: "C", changed: "M", unchanged: "·" }[f.status];
      const li = el(
        "li",
        { class: "file", tabindex: "0", title: f.previousPath ? `renamed from ${f.previousPath}` : f.path },
        el("div", { class: "path" }, el("span", { class: "st" }, st), el("span", { class: "dir" }, slash >= 0 ? f.path.slice(0, slash + 1) : ""), f.path.slice(slash + 1), " ", el("span", { class: "add" }, `+${f.additions}`), " ", el("span", { class: "del" }, `−${f.deletions}`)),
        el("div", { class: "reason" }, f.reason),
      );
      const go = () => void jumpTo(f.path);
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
      ul.append(li);
    }
    d.append(ul);
    return d;
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
