/** Lightweight coach-mark walkthrough rendered inside the widget's shadow root. */
export interface TourStep {
  /** Element to highlight (null = centered card). */
  target: () => Element | null;
  title: string;
  body: string;
  /** Run before showing the step (e.g. open a <details>). */
  before?: () => void;
}

export const TOUR_CSS = `
.tour-ring { position:fixed; z-index:2147483002; border:2px solid var(--accent); border-radius:8px; box-shadow:0 0 0 9999px rgba(0,0,0,.38); pointer-events:none; transition:all .15s ease; }
.tour-card { position:fixed; z-index:2147483003; width:290px; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow); padding:12px 14px; font-size:13px; }
.tour-card h4 { margin:0 0 6px; font-size:14px; }
.tour-card p { margin:0 0 10px; color:var(--fg); }
.tour-card .row { display:flex; gap:6px; align-items:center; }
.tour-card .row .sp { flex:1; color:var(--muted); font-size:12px; }
`;

export function placeCard(target: DOMRect | null, card: { w: number; h: number }, vp: { width: number; height: number }) {
  const m = 12;
  if (!target) return { left: Math.round((vp.width - card.w) / 2), top: Math.round((vp.height - card.h) / 2) };
  let top = target.bottom + m;
  if (top + card.h > vp.height - m) top = target.top - card.h - m;
  if (top < m) top = Math.min(vp.height - card.h - m, Math.max(m, target.top));
  let left = target.left + target.width / 2 - card.w / 2;
  left = Math.min(Math.max(m, left), vp.width - card.w - m);
  // If the card would cover the target (e.g. a tall target), put it beside it.
  if (top < target.bottom && top + card.h > target.top) {
    left = target.left - card.w - m >= m ? target.left - card.w - m : Math.min(vp.width - card.w - m, target.right + m);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

export class Tour {
  private i = 0;
  private ring: HTMLElement;
  private card: HTMLElement;
  private active = false;
  private onMove = () => this.position();

  constructor(private host: HTMLElement, private steps: TourStep[], private onDone: (completed: boolean) => void) {
    this.ring = document.createElement("div");
    this.ring.className = "tour-ring";
    this.card = document.createElement("div");
    this.card.className = "tour-card";
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-modal", "false");
    this.card.tabIndex = -1;
    this.card.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") this.next();
      else if (e.key === "ArrowLeft") this.back();
    });
  }

  isActive() {
    return this.active;
  }

  start(at = 0) {
    this.active = true;
    this.i = at;
    this.host.append(this.ring, this.card);
    window.addEventListener("resize", this.onMove);
    window.addEventListener("scroll", this.onMove, true);
    this.show();
  }

  end(completed = false) {
    if (!this.active) return;
    this.active = false;
    this.ring.remove();
    this.card.remove();
    window.removeEventListener("resize", this.onMove);
    window.removeEventListener("scroll", this.onMove, true);
    this.onDone(completed);
  }

  next() {
    if (this.i >= this.steps.length - 1) return this.end(true);
    this.i++;
    this.show();
  }

  back() {
    if (this.i === 0) return;
    this.i--;
    this.show();
  }

  private show() {
    const s = this.steps[this.i];
    s.before?.();
    const t = s.target();
    revealInScroller(t as HTMLElement | null);
    const mk = (tag: string, cls: string, text: string) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      e.textContent = text;
      return e;
    };
    const back = mk("button", "btn", "Back");
    const next = mk("button", "btn primary", this.i === this.steps.length - 1 ? "Done" : "Next");
    const skip = mk("button", "btn", "Skip");
    (back as HTMLButtonElement).disabled = this.i === 0;
    back.addEventListener("click", () => this.back());
    next.addEventListener("click", () => this.next());
    skip.addEventListener("click", () => this.end(false));
    const row = mk("div", "row", "");
    row.append(mk("span", "sp", `${this.i + 1} of ${this.steps.length}`), skip, back, next);
    this.card.setAttribute("aria-label", s.title);
    this.card.replaceChildren(mk("h4", "", s.title), mk("p", "", s.body), row);
    this.position();
    (next as HTMLButtonElement).focus({ preventScroll: true });
  }

  private position() {
    if (!this.active) return;
    const t = this.steps[this.i].target();
    const r = t ? t.getBoundingClientRect() : null;
    if (r && r.width + r.height > 0) {
      Object.assign(this.ring.style, { display: "block", left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    } else {
      Object.assign(this.ring.style, { display: "block", left: "50%", top: "50%", width: "0px", height: "0px" });
    }
    const cr = this.card.getBoundingClientRect();
    const p = placeCard(r && r.width + r.height > 0 ? r : null, { w: cr.width || 290, h: cr.height || 150 }, { width: window.innerWidth, height: window.innerHeight });
    Object.assign(this.card.style, { left: `${p.left}px`, top: `${p.top}px` });
  }
}

export const REVIEW_TOUR_TEXT = {
  layers: {
    title: "Review in numbered steps",
    body: "The PR is split into steps in reading order, e.g. \u201cStart with the schemas\u201d, then the code that uses them, then the tests. The step you're on is open and the rest are collapsed. Click any step to open it.",
  },
  reasons: {
    title: "Why this step comes now",
    body: "Each step has one line explaining its place, worked out from this PR, e.g. \u201c43 other changed files build on these.\u201d",
  },
  jump: {
    title: "Click a file to jump to its diff",
    body: "Files are grouped by folder. The dot shows if a file is new, modified, renamed or deleted, and the bar shows lines added. Hover or focus a file to see how it connects, e.g. \u201cImported by routing.py and 3 others\u201d. Click it to select it and open its diff.",
  },
  check: {
    title: "Mark file as reviewed & next",
    body: "When you've read the selected file, this marks it reviewed (\u2713), selects the next file and jumps to its diff. After the last file in a step, it opens the next step. ← Previous undoes the last one: it unticks that file and takes you back to it. Shortcuts while the panel has focus: n = mark & next, p = previous (undo), j / k = move the selection. Each file and step also has a checkbox. Reviews are saved only in this browser.",
  },
  risk: {
    title: "Risky changes",
    body: "Rule-based flags for SQL and migrations, config and env, the data layer and API contracts. \u26d4 Likely breaking means the compiler and tests probably won't catch it; \u26a0 Review carefully means it's checked or additive but worth a closer look. Show only risky filters the steps, List jumps to each file, and r goes to the next risky file. Select a file to see each reason with a line link (e.g. R178) into the diff; Not breaking dismisses one for this PR. Sensitivity and categories are in \u22ef and Token & settings.",
  },
  changed: {
    title: "Changed since you reviewed it",
    body: "If new commits change files you already reviewed, their ticks turn into an amber \u26a0 (stale) and this banner asks what to do: Untick changed files to re-read just those, or Keep my ticks. To start over, use \u21ba Restart review in the tab row. You can reopen this tour from \u22ef \u2192 Take the tour.",
  },
};

/** Scroll the nearest scrollable ancestor (inside the panel) so `el` is visible; never the page or panel frame. */
function revealInScroller(el: HTMLElement | null) {
  if (!el) return;
  let sc: HTMLElement | null = el.parentElement;
  while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  if (!sc) return;
  const p = sc.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < p.top) sc.scrollTop -= p.top - r.top + 8;
  else if (r.bottom > p.bottom) sc.scrollTop += r.bottom - p.bottom + 8;
}
