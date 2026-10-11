/**
 * Optional, best-effort sync of the panel's "reviewed" ticks to GitHub's own per-file "Viewed" control,
 * by clicking that control in the page (classic and React Files changed views). No API calls of any kind:
 * GitHub's page does whatever it normally does when you click "Viewed" yourself.
 *
 * The control is found from the file (anchor id / per-file path attribute) and then by role/label,
 * not by GitHub's generated class names.
 */
import { byPathAttr, findDiffElement, waitForElement, type ScrollEnv } from "./scroll";

export type SyncResult = "ok" | "already" | "missing" | "failed";

export interface ViewedControl {
  el: HTMLElement;
  /** Current state as GitHub shows it. */
  isViewed(): boolean;
}

/** Is this element a per-file "Viewed" control? Checkbox named/labelled viewed, or a toggle button labelled viewed. */
function asControl(el: Element): ViewedControl | null {
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    const label = `${el.name} ${el.getAttribute("aria-label") ?? ""} ${el.closest("label")?.textContent ?? ""} ${el.className}`;
    if (!/viewed|reviewed-checkbox/i.test(label)) return null;
    return { el, isViewed: () => el.checked };
  }
  if (el instanceof HTMLButtonElement || el.getAttribute("role") === "checkbox" || el.getAttribute("role") === "switch") {
    const label = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`.trim();
    if (!/\bviewed\b/i.test(label)) return null;
    const stateAttr = el.hasAttribute("aria-pressed") ? "aria-pressed" : el.hasAttribute("aria-checked") ? "aria-checked" : null;
    if (!stateAttr) return null;
    return { el: el as HTMLElement, isViewed: () => el.getAttribute(stateAttr) === "true" };
  }
  return null;
}

const CANDIDATES = 'input[type="checkbox"], button[aria-pressed], button[aria-checked], [role="checkbox"], [role="switch"]';

function controlsIn(root: Element): ViewedControl[] {
  const out: ViewedControl[] = [];
  for (const el of root.querySelectorAll(CANDIDATES)) {
    const c = asControl(el);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Find the Viewed control for one file: start at the file's diff element and walk up until a container holds
 * exactly one Viewed control (stop if a container holds several, i.e. we've reached other files).
 */
export function findViewedControl(doc: Document, path: string, anchor: string): ViewedControl | null {
  const start = findDiffElement(doc, path, anchor) ?? byPathAttr(doc, path);
  let el: Element | null = start;
  for (let depth = 0; el && depth < 10; depth++, el = el.parentElement) {
    const cs = controlsIn(el);
    if (cs.length === 1) return cs[0];
    if (cs.length > 1) return null;
  }
  return null;
}

const tick = (win: Window, ms: number) => new Promise<void>((r) => win.setTimeout(r, ms));

/** After a click, wait until GitHub reflects the new state (up to `ms`). */
async function confirm(c: ViewedControl, want: boolean, win: Window, ms: number): Promise<boolean> {
  for (let t = 0; t <= ms; t += 50) {
    if (c.isViewed() === want) return true;
    await tick(win, 50);
  }
  return c.isViewed() === want;
}

export interface SyncEnv extends ScrollEnv {
  /** How long to wait for the control after clicking (ms). */
  confirmMs?: number;
}

/**
 * Make GitHub's Viewed state for `path` equal `want`. Clicks only when the state differs.
 * If the file isn't rendered (virtualized), waits for it (MutationObserver + timeout). Never throws.
 * The click itself happens synchronously when the control is already in the DOM.
 */
export function syncViewed(path: string, anchor: string, want: boolean, env: SyncEnv): Promise<SyncResult> {
  const act = async (c: ViewedControl): Promise<SyncResult> => {
    if (c.isViewed() === want) return "already";
    try {
      c.el.click();
    } catch {
      return "failed";
    }
    return (await confirm(c, want, env.win, env.confirmMs ?? 1500)) ? "ok" : "failed";
  };
  try {
    const now = findViewedControl(env.doc, path, anchor);
    if (now) return act(now);
    return waitForElement(env, () => findViewedControl(env.doc, path, anchor)?.el ?? null)
      .then((el) => {
        const c = el && findViewedControl(env.doc, path, anchor);
        return c ? act(c) : ("missing" as const);
      })
      .catch(() => "failed" as const);
  } catch {
    return Promise.resolve("failed");
  }
}

export const SYNC_MESSAGES: Record<"missing" | "failed", string> = {
  missing: "Not synced with GitHub's Viewed checkbox: couldn't find this file on the Files changed page (open that tab, or scroll to the file, then tick it again).",
  failed: "Not synced with GitHub's Viewed checkbox: GitHub didn't take the click. Use GitHub's own Viewed checkbox for this file.",
};
