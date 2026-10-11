/** The Review tab: ordered layers with reasons, reviewed checkboxes and change flags. */
import type { Layer, LayerPlan } from "../engine/types";
import { changedSinceReviewed, type ReviewState } from "./review-logic";

export interface ReviewHandlers {
  onToggle(layer: Layer, reviewed: boolean): void;
  onJump(path: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

const ST: Record<string, string> = { added: "A", removed: "D", renamed: "R", modified: "M", copied: "C", changed: "M", unchanged: "·" };

export function renderReview(plan: LayerPlan, state: ReviewState, h: ReviewHandlers): HTMLElement {
  const wrap = el("div", { class: "review" });
  let firstUnreviewedOpen = 0;
  plan.layers.forEach((l, i) => {
    const snap = state[l.id];
    const changed = changedSinceReviewed(l, snap);
    const done = !!snap && changed.length === 0;
    const d = el("details", { class: "layer" + (done ? " done" : "") + (changed.length ? " changed" : ""), "data-layer": l.id });
    if (i === 0) d.setAttribute("data-tour", "layer");
    if (!done && (firstUnreviewedOpen < 2 || changed.length)) {
      d.setAttribute("open", "");
      firstUnreviewedOpen++;
    }
    const cb = el("input", { type: "checkbox", title: "Mark layer reviewed", "aria-label": `Mark L${i} ${l.label ?? l.title} reviewed` }) as HTMLInputElement;
    cb.checked = !!snap;
    if (!snap && !wrap.querySelector('[data-tour="check"]')) cb.setAttribute("data-tour", "check");
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => h.onToggle(l, cb.checked));
    const summary = el(
      "summary",
      {},
      cb,
      el("span", { class: "idx" }, `L${i}`),
      el("span", { class: "ltitle" }, l.title, " ", el("span", { class: "lkind" }, l.label ?? "")),
      el("span", { class: "stats" }, `${l.stats.files} · `, el("span", { class: "add" }, `+${l.stats.additions}`), " ", el("span", { class: "del" }, `−${l.stats.deletions}`)),
    );
    d.append(summary, el("div", { class: "desc" }, l.description));
    if (changed.length) {
      const flag = el("div", { class: "flag", role: "status", "data-tour": "changed" }, changed.length === 1 ? "⚠ Changed since you reviewed it: 1 file. Re-check it, then tick the box again." : `⚠ Changed since you reviewed it: ${changed.length} files. Re-check them, then tick the box again.`);
      d.append(flag);
    }
    const ul = el("ul", { class: "files" });
    for (const f of l.files) {
      const slash = f.path.lastIndexOf("/");
      const isChanged = changed.includes(f.path);
      const li = el(
        "li",
        { class: "file" + (isChanged ? " chg" : ""), tabindex: "0", title: f.previousPath ? `renamed from ${f.previousPath}` : f.path },
        el(
          "div",
          { class: "path" },
          el("span", { class: "st" }, ST[f.status] ?? "M"),
          el("span", { class: "dir" }, slash >= 0 ? f.path.slice(0, slash + 1) : ""),
          f.path.slice(slash + 1),
          " ",
          el("span", { class: "add" }, `+${f.additions}`),
          " ",
          el("span", { class: "del" }, `−${f.deletions}`),
          isChanged ? el("span", { class: "badge" }, "changed") : "",
        ),
        el("div", { class: "reason" }, f.reason),
      );
      if (!wrap.querySelector('[data-tour="file"]') && i === 0) {
        li.setAttribute("data-tour", "file");
        (li.lastChild as HTMLElement).setAttribute("data-tour", "reason");
      }
      const go = () => h.onJump(f.path);
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
    wrap.append(d);
  });
  return wrap;
}
