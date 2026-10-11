/** The Review tab as a checklist of numbered steps (see docs/images/review-demo.png). */
import type { Layer, LayerFile, LayerPlan } from "../engine/types";
import { changedSinceReviewed, currentStep, groupByFolder, type ReviewState } from "./review-logic";

export interface ReviewHandlers {
  /** Step ids the user has expanded (the current step is added by default). */
  open: ReadonlySet<string>;
  onToggle(layer: Layer, reviewed: boolean): void;
  onJump(path: string): void;
  onOpen(layer: Layer, open: boolean): void;
  onMarkNext(layer: Layer): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export const STATUS_LABEL: Record<string, string> = {
  added: "New file",
  removed: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  modified: "Modified",
  changed: "Modified",
  unchanged: "Unchanged",
};
const statusClass = (s: LayerFile["status"]) => (s === "added" ? "new" : s === "removed" ? "del" : s === "renamed" || s === "copied" ? "ren" : "mod");

export function renderReview(plan: LayerPlan, state: ReviewState, h: ReviewHandlers): HTMLElement {
  const wrap = el("ol", { class: "steps", "aria-label": "Review steps" });
  const cur = currentStep(plan, state);
  plan.layers.forEach((l, i) => {
    const snap = state[l.id];
    const changed = changedSinceReviewed(l, snap);
    const done = !!snap && changed.length === 0;
    const isOpen = h.open.has(l.id);
    const bodyId = `prl-step-${i}`;
    const li = el("li", { class: ["step", done ? "done" : "", i === cur ? "current" : "", isOpen ? "open" : "", changed.length ? "changed" : ""].filter(Boolean).join(" "), "data-layer": l.id });
    if (i === 0) li.setAttribute("data-tour", "step");

    const num = el("span", { class: "num", "aria-hidden": "true" }, done ? "✓" : String(i + 1));
    const head = el(
      "button",
      { type: "button", class: "sh", "aria-expanded": String(isOpen), "aria-controls": bodyId, title: `${l.title}: ${l.description}` },
      num,
      el("span", { class: "h" }, el("span", { class: "sr" }, `Step ${i + 1}${done ? ", reviewed" : ""}${changed.length ? ", changed since reviewed" : ""}: `), l.title),
      changed.length ? el("span", { class: "chg-ico", title: "Changed since you reviewed it", "aria-hidden": "true" }, "⚠") : "",
      el("span", { class: "cnt" }, `${l.files.length} file${l.files.length === 1 ? "" : "s"}`),
      el("span", { class: "chev", "aria-hidden": "true" }, "›"),
    );
    head.addEventListener("click", () => h.onOpen(l, !isOpen));
    const cb = el("input", { type: "checkbox", class: "tick", title: "Mark step reviewed", "aria-label": `Mark step ${i + 1} reviewed` }) as HTMLInputElement;
    cb.checked = !!snap;
    if (!snap && !wrap.querySelector('[data-tour="check"]')) cb.setAttribute("data-tour", "check");
    cb.addEventListener("change", () => h.onToggle(l, cb.checked));
    li.append(el("div", { class: "srow" }, head, cb));

    if (isOpen) {
      const body = el("div", { class: "sbody", id: bodyId });
      body.append(el("p", { class: "why", ...(i === cur || !wrap.querySelector('[data-tour="why"]') ? { "data-tour": "why" } : {}) }, l.description));
      if (changed.length) {
        body.append(el("p", { class: "flag", role: "status", "data-tour": "changed" }, `⚠ ${changed.length === 1 ? "1 file changed" : `${changed.length} files changed`} since you reviewed this step.`));
      }
      const max = Math.max(1, ...l.files.map((f) => f.additions));
      for (const g of groupByFolder(l.files)) {
        if (g.dir) body.append(el("div", { class: "folder", title: g.dir }, g.dir));
        const ul = el("ul", { class: "files" });
        for (const f of g.files) {
          const isChg = changed.includes(f.path);
          const st = STATUS_LABEL[f.status] ?? "Modified";
          const bar = el("span", { class: "bar", "aria-hidden": "true" });
          bar.style.width = `${Math.max(2, Math.round((f.additions / max) * 40))}px`;
          const row = el(
            "li",
            { class: "file" + (isChg ? " chg" : ""), tabindex: "0", role: "button", "aria-label": `${f.path}, ${st.toLowerCase()}, ${f.additions} added, ${f.deletions} removed. ${f.reason}` },
            el("span", { class: `dot ${statusClass(f.status)}`, title: f.previousPath ? `${st} from ${f.previousPath}` : st, "aria-hidden": "true" }),
            el("span", { class: "fname" }, f.name),
            isChg ? el("span", { class: "chg-ico", title: "Changed since you reviewed it", "aria-hidden": "true" }, "⚠") : "",
            el("span", { class: "nums" }, bar, el("span", { class: "add" }, `+${f.additions}`), f.deletions > 0 ? el("span", { class: "del" }, `−${f.deletions}`) : ""),
            el("span", { class: "reason" }, f.reason),
          );
          if (!wrap.querySelector('[data-tour="file"]') && !body.querySelector('[data-tour="file"]')) row.setAttribute("data-tour", "file");
          const go = () => h.onJump(f.path);
          row.addEventListener("click", go);
          row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              go();
            }
          });
          ul.append(row);
        }
        body.append(ul);
      }
      if (!done) {
        const last = i === plan.layers.length - 1;
        const btn = el("button", { type: "button", class: "btn primary next", "data-tour": "next" }, last ? "Mark reviewed ✓" : "Mark step reviewed & next →");
        btn.addEventListener("click", () => h.onMarkNext(l));
        body.append(el("div", { class: "sfoot" }, btn));
      }
      li.append(body);
    }
    wrap.append(li);
  });
  return wrap;
}
