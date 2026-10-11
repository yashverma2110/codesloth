/**
 * Smooth scrolling to a file's diff on GitHub's Files changed page (classic and the React view).
 *
 * - Element in the DOM: scroll it into view smoothly, below GitHub's sticky headers, and set the URL hash
 *   with history.replaceState (so GitHub doesn't do its own instant jump).
 * - Not in the DOM (the React view virtualizes long PRs): fall back to the anchor navigation GitHub
 *   understands, wait for the element (MutationObserver + timeout), then make a final smooth adjust.
 * - prefers-reduced-motion: instant scroll and no highlight flash.
 * Never moves keyboard focus.
 */

export interface ScrollEnv {
  doc: Document;
  win: Window;
  /** Override for tests; defaults to matchMedia("(prefers-reduced-motion: reduce)"). */
  reducedMotion?: boolean;
  /** How long to wait for a virtualized file to render (ms). */
  timeoutMs?: number;
}

/** Extra gap between the sticky headers and the file header. */
export const SCROLL_GAP = 8;

const FILE_CONTAINER = '.file, .js-file, [data-tagsearch-path], [data-file-path], [class*="Diff-module"]';
/** Never offset by more than this, whatever we measure. */
export const MAX_OFFSET = 200;

const STICKY_CANDIDATES = [
  "header.AppHeader",
  ".AppHeader",
  ".js-header-wrapper",
  ".pr-toolbar",
  ".js-sticky",
  ".gh-header-sticky",
  "[data-sticky]",
  '[class*="sticky" i]',
  '[class*="Sticky"]',
].join(",");

export function prefersReducedMotion(win: Window): boolean {
  try {
    return !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Find the diff element for a file: GitHub's #diff-<sha256(path)> anchor first, then per-file data attributes. */
export function findDiffElement(doc: Document, path: string, anchor: string): HTMLElement | null {
  const byId = doc.getElementById(anchor);
  if (byId) {
    // Classic view: the id can sit on a tiny anchor; prefer the file container around it.
    return (byId.closest(".file, .js-file, [data-tagsearch-path]") as HTMLElement | null) ?? (byId as HTMLElement);
  }
  const named = doc.getElementsByName(anchor)[0] as HTMLElement | undefined;
  if (named) return (named.nextElementSibling as HTMLElement | null) ?? named;
  return byPathAttr(doc, path);
}

const PATH_ATTRS = ["data-tagsearch-path", "data-file-path", "data-path"];

/** First element whose per-file path attribute equals `path` (compared as strings, so any characters are safe). */
export function byPathAttr(root: ParentNode, path: string): HTMLElement | null {
  for (const a of PATH_ATTRS) {
    for (const el of root.querySelectorAll(`[${a}]`)) if (el.getAttribute(a) === path) return el as HTMLElement;
  }
  return null;
}

/** The file header inside a diff element (for the arrival flash), or the element itself. */
export function headerOf(el: HTMLElement): HTMLElement {
  return (el.querySelector('.file-header, [class*="FileHeader"], [class*="file-header"], [class*="DiffFileHeader"]') as HTMLElement | null) ?? el;
}

/**
 * Height covered by GitHub's sticky/fixed bars at the top of the viewport (header, PR toolbar, file tree bar).
 * Ignores the target itself and anything inside it, and our own widget host.
 */
export function stickyOffset(env: ScrollEnv, target?: Element | null, excludeId = "codesloth-widget-host"): number {
  // excludeId: the widget host (see HOST_ID in widget.ts).
  const { doc, win } = env;
  let bottom = 0;
  for (const el of doc.querySelectorAll(STICKY_CANDIDATES)) {
    if (el.id === excludeId || (target && (el === target || target.contains(el) || el.contains(target)))) continue;
    // Per-file sticky headers belong to other files and move away as we scroll; don't count them.
    if (el.closest(FILE_CONTAINER)) continue;
    const pos = win.getComputedStyle(el).position;
    if (pos !== "sticky" && pos !== "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0 || r.height > win.innerHeight / 2) continue;
    if (r.top > 2 || r.bottom <= 0) continue; // only bars pinned at the top
    bottom = Math.max(bottom, r.bottom);
  }
  return Math.min(MAX_OFFSET, Math.round(bottom));
}

/** Window scrollY that puts an element `rectTop` px from the viewport top just below `offset` px of sticky bars. */
export function scrollTopFor(rectTop: number, scrollY: number, offset: number, gap = SCROLL_GAP): number {
  return Math.max(0, Math.round(scrollY + rectTop - offset - gap));
}

/** Scroll an element below the sticky headers. Uses scroll-margin-top so nested scroll containers work too. */
export function scrollToElement(el: HTMLElement, env: ScrollEnv): void {
  const reduce = env.reducedMotion ?? prefersReducedMotion(env.win);
  const offset = stickyOffset(env, el);
  const prev = el.style.scrollMarginTop;
  el.style.scrollMarginTop = `${offset + SCROLL_GAP}px`;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  el.style.scrollMarginTop = prev;
}

/** Subtle ~1s outline fade on the file header. Skipped with reduced motion. Doesn't touch focus or classes. */
export function flash(el: HTMLElement, env: ScrollEnv): void {
  if (env.reducedMotion ?? prefersReducedMotion(env.win)) return;
  const h = headerOf(el);
  if (typeof h.animate !== "function") return;
  h.animate(
    [
      { boxShadow: "0 0 0 2px rgba(9,105,218,.85)", offset: 0 },
      { boxShadow: "0 0 0 2px rgba(9,105,218,.85)", offset: 0.3 },
      { boxShadow: "0 0 0 2px rgba(9,105,218,0)", offset: 1 },
    ],
    { duration: 1000, easing: "ease-out" },
  );
}

/** Resolve with the element once it shows up, or null after the timeout. */
export function waitForElement(env: ScrollEnv, find: () => HTMLElement | null): Promise<HTMLElement | null> {
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const Obs = (env.win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver ?? MutationObserver;
    const mo = new Obs(() => {
      const el = find();
      if (el) done(el);
    });
    const t = env.win.setTimeout(() => done(null), env.timeoutMs ?? 4000);
    function done(el: HTMLElement | null) {
      mo.disconnect();
      env.win.clearTimeout(t);
      resolve(el);
    }
    mo.observe(env.doc.documentElement, { childList: true, subtree: true });
  });
}

let generation = 0;

export type ScrollResult = "smooth" | "fallback" | "fallback-timeout" | "navigate" | "superseded";

/**
 * Bring a file's diff into view. `onFilesTab` false means a full navigation to the Files changed URL.
 * A newer call cancels a pending fallback wait.
 */
export async function scrollToDiff(path: string, anchor: string, filesUrl: string, onFilesTab: boolean, env: ScrollEnv): Promise<ScrollResult> {
  const gen = ++generation;
  if (!onFilesTab) {
    env.win.location.href = `${filesUrl}#${anchor}`;
    return "navigate";
  }
  const find = () => findDiffElement(env.doc, path, anchor);
  const el = find();
  if (el) {
    env.win.history.replaceState(env.win.history.state, "", `${env.win.location.pathname}${env.win.location.search}#${anchor}`);
    scrollToElement(el, env);
    flash(el, env);
    return "smooth";
  }
  // Virtualized: let GitHub's own anchor handling render and jump to it, then adjust smoothly.
  if (env.win.location.hash === `#${anchor}`) env.win.history.replaceState(env.win.history.state, "", env.win.location.pathname + env.win.location.search);
  env.win.location.hash = anchor;
  const later = await waitForElement(env, find);
  if (gen !== generation) return "superseded";
  if (!later) return "fallback-timeout";
  scrollToElement(later, env);
  flash(later, env);
  return "fallback";
}

/** On page load with a #diff-… hash (e.g. after navigating from another tab): adjust below sticky bars and flash. */
export async function settleInitialHash(env: ScrollEnv): Promise<boolean> {
  const hash = env.win.location.hash.slice(1);
  if (!/^diff-[0-9a-f]{64}$/.test(hash)) return false;
  const gen = generation;
  const el = await waitForElement(env, () => {
    const e = env.doc.getElementById(hash);
    return e ? ((e.closest(".file, .js-file, [data-tagsearch-path]") as HTMLElement | null) ?? (e as HTMLElement)) : null;
  });
  if (!el || gen !== generation) return false;
  scrollToElement(el, env);
  flash(el, env);
  return true;
}

/* ---------------- line jumps (risky-change line refs) ---------------- */

const NUM_CELL = "[data-line-number], td.blob-num, [class*='line-number' i], [class*='LineNumber']";

/**
 * A diff line's element. Classic view: GitHub's own `#diff-<sha256(path)>R<n>` / `L<n>` cell id (verified).
 * Fallbacks for the React view (not verified signed-in): a `data-line-anchor` with that id, then the line-number
 * cell whose number matches, taking the right-most number cell of its row for R and the left-most for L.
 */
export function findLineElement(doc: Document, fileEl: HTMLElement | null, anchor: string, side: "R" | "L", n: number): HTMLElement | null {
  const id = `${anchor}${side}${n}`;
  const byId = doc.getElementById(id);
  if (byId) return byId;
  for (const e of doc.querySelectorAll("[data-line-anchor]")) if (e.getAttribute("data-line-anchor") === id) return e as HTMLElement;
  if (!fileEl) return null;
  const want = String(n);
  for (const cell of fileEl.querySelectorAll(NUM_CELL)) {
    const num = (cell.getAttribute("data-line-number") ?? cell.textContent ?? "").trim();
    if (num !== want) continue;
    const row = cell.closest("tr, [role='row']") ?? cell.parentElement;
    const cells = row ? [...row.querySelectorAll(NUM_CELL)].filter((c) => /^\d+$/.test((c.getAttribute("data-line-number") ?? c.textContent ?? "").trim())) : [cell];
    if (cells.length < 2 || (side === "R" ? cells[cells.length - 1] === cell : cells[0] === cell)) return cell as HTMLElement;
  }
  return null;
}

export type LineResult = "line" | "file" | "navigate" | "missing" | "superseded";

/** Jump to one diff line: file first (smooth or GitHub's anchor fallback), then the line; else stay on the file. */
export async function scrollToLine(path: string, anchor: string, side: "R" | "L", n: number, filesUrl: string, onFilesTab: boolean, env: ScrollEnv): Promise<LineResult> {
  if (!onFilesTab) {
    env.win.location.href = `${filesUrl}#${anchor}${side}${n}`;
    return "navigate";
  }
  const file = await scrollToDiff(path, anchor, filesUrl, true, env);
  if (file === "superseded") return "superseded";
  const gen = generation;
  const fileEl = findDiffElement(env.doc, path, anchor);
  const line = await waitForElement({ ...env, timeoutMs: Math.min(env.timeoutMs ?? 2500, 2500) }, () => findLineElement(env.doc, findDiffElement(env.doc, path, anchor), anchor, side, n));
  if (gen !== generation) return "superseded";
  if (!line) return fileEl ? "file" : "missing";
  const row = (line.closest("tr, [role='row']") as HTMLElement | null) ?? line;
  env.win.history.replaceState(env.win.history.state, "", `${env.win.location.pathname}${env.win.location.search}#${anchor}${side}${n}`);
  const reduce = env.reducedMotion ?? prefersReducedMotion(env.win);
  row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  if (!reduce && typeof row.animate === "function")
    row.animate([{ backgroundColor: "rgba(212,167,44,.45)" }, { backgroundColor: "rgba(212,167,44,.45)", offset: 0.4 }, { backgroundColor: "rgba(212,167,44,0)" }], { duration: 1400, easing: "ease-out" });
  return "line";
}
