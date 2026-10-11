/** The Review tab as a checklist of numbered steps with per-file review (see docs/images/review-demo.png). */
import type { Layer, LayerFile, LayerPlan } from "../engine/types";
import { ctaTarget, currentStep, fileReview, groupByFolder, isLastUnreviewed, layerReview, summarize, type ReviewState } from "./review-logic";

export interface ReviewHandlers {
  /** Step ids the user has expanded. */
  open: ReadonlySet<string>;
  /** Selected file path (highlighted, aria-current). */
  selected: string | null;
  onSelect(path: string): void;
  onToggleFile(file: LayerFile, reviewed: boolean): void;
  onToggleStep(layer: Layer, reviewed: boolean): void;
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
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

export function renderReview(plan: LayerPlan, state: ReviewState, h: ReviewHandlers): HTMLElement {
  const root = el("div", { class: "review" });
  const sum = summarize(plan, state);
  if (sum.totalFiles && sum.reviewedFiles === sum.totalFiles) {
    root.append(el("div", { class: "alldone", role: "status" }, el("span", { class: "ok", "aria-hidden": "true" }, "✓"), `All ${files(sum.totalFiles)} reviewed`));
  }
  const wrap = el("ol", { class: "steps", "aria-label": "Review steps" });
  const cur = currentStep(plan, state);
  plan.layers.forEach((l, i) => {
    const lr = layerReview(l, state);
    const done = lr.state === "done";
    const isOpen = h.open.has(l.id);
    const bodyId = `prl-step-${i}`;
    const li = el("li", { class: ["step", done ? "done" : "", lr.state === "partial" ? "partial" : "", i === cur ? "current" : "", isOpen ? "open" : "", lr.changed.length ? "changed" : ""].filter(Boolean).join(" "), "data-layer": l.id });
    if (i === 0) li.setAttribute("data-tour", "step");

    const num = el("span", { class: "num", "aria-hidden": "true" }, done ? "✓" : String(i + 1));
    const count = lr.state === "partial" ? `${lr.reviewed}/${l.files.length}` : files(l.files.length);
    const head = el(
      "button",
      { type: "button", class: "sh", "aria-expanded": String(isOpen), "aria-controls": bodyId, title: `${l.title}: ${l.description}` },
      num,
      el("span", { class: "h" }, el("span", { class: "sr" }, `Step ${i + 1}${done ? ", reviewed" : lr.state === "partial" ? `, ${lr.reviewed} of ${files(l.files.length)} reviewed` : ""}${lr.changed.length ? ", changed since reviewed" : ""}: `), l.title),
      lr.changed.length ? el("span", { class: "chg-ico", title: "Changed since you reviewed it", "aria-hidden": "true" }, "⚠") : "",
      el("span", { class: "cnt" }, count),
      el("span", { class: "chev", "aria-hidden": "true" }, "›"),
    );
    head.addEventListener("click", () => h.onOpen(l, !isOpen));
    const cb = el("input", { type: "checkbox", class: "tick", title: done ? "Unmark all files in this step" : "Mark all files in this step reviewed", "aria-label": `Mark all files in step ${i + 1} reviewed` }) as HTMLInputElement;
    cb.checked = done;
    cb.indeterminate = lr.state === "partial";
    if (lr.state === "partial") cb.setAttribute("aria-checked", "mixed");
    if (!done && !wrap.querySelector('[data-tour="check"]')) cb.setAttribute("data-tour", "check");
    cb.addEventListener("change", () => h.onToggleStep(l, !done));
    li.append(el("div", { class: "srow" }, head, cb));

    if (isOpen) {
      const body = el("div", { class: "sbody", id: bodyId });
      body.append(el("p", { class: "why", ...(!root.querySelector('[data-tour="why"]') ? { "data-tour": "why" } : {}) }, l.description));
      if (lr.changed.length) {
        body.append(el("p", { class: "flag", role: "status", "data-tour": "changed" }, `⚠ ${lr.changed.length === 1 ? "1 file changed" : `${lr.changed.length} files changed`} since you reviewed it.`));
      }
      const max = Math.max(1, ...l.files.map((f) => f.additions));
      for (const g of groupByFolder(l.files)) {
        if (g.dir) body.append(el("div", { class: "folder", title: g.dir }, g.dir));
        const ul = el("ul", { class: "files" });
        for (const f of g.files) {
          const fr = fileReview(state, f);
          const sel = h.selected === f.path;
          const st = STATUS_LABEL[f.status] ?? "Modified";
          const stTitle = f.previousPath ? `${st} from ${f.previousPath}` : st;
          const bar = el("span", { class: "bar", "aria-hidden": "true" });
          bar.style.width = `${Math.max(2, Math.round((f.additions / max) * 40))}px`;
          const icon =
            fr === "reviewed"
              ? el("span", { class: "rev-ico", title: `Reviewed · ${stTitle}`, "aria-hidden": "true" }, "✓")
              : el("span", { class: `dot ${statusClass(f.status)}`, title: stTitle, "aria-hidden": "true" });
          const btn = el(
            "button",
            {
              type: "button",
              class: "fbtn",
              "data-path": f.path,
              "aria-label": `${f.path}, ${st.toLowerCase()}${fr === "reviewed" ? ", reviewed" : fr === "changed" ? ", changed since reviewed" : ""}, ${f.additions} added, ${f.deletions} removed. ${f.reason}`,
              ...(sel ? { "aria-current": "true" } : {}),
            },
            icon,
            el("span", { class: "fname" }, f.name),
            fr === "changed" ? el("span", { class: "chg-ico", title: "Changed since you reviewed it", "aria-hidden": "true" }, "⚠") : "",
            el("span", { class: "nums" }, bar, el("span", { class: "add" }, `+${f.additions}`), f.deletions > 0 ? el("span", { class: "del" }, `−${f.deletions}`) : ""),
            el("span", { class: "reason" }, f.reason),
          );
          btn.addEventListener("click", () => h.onSelect(f.path));
          const ft = el("input", { type: "checkbox", class: "ftick", "data-path": f.path, title: fr === "reviewed" ? "Unmark reviewed" : "Mark reviewed", "aria-label": `Mark ${f.name} reviewed` }) as HTMLInputElement;
          ft.checked = fr === "reviewed";
          ft.addEventListener("change", () => h.onToggleFile(f, ft.checked));
          const row = el("li", { class: ["file", sel ? "sel" : "", fr === "reviewed" ? "rev" : "", fr === "changed" ? "chg" : ""].filter(Boolean).join(" ") }, btn, ft);
          if (!root.querySelector('[data-tour="file"]') && !body.querySelector('[data-tour="file"]')) row.setAttribute("data-tour", "file");
          ul.append(row);
        }
        body.append(ul);
      }
      const target = ctaTarget(plan, state, i, h.selected);
      if (target) {
        const last = isLastUnreviewed(plan, state, target.path);
        const name = target.path.slice(target.path.lastIndexOf("/") + 1);
        const btn = el("button", { type: "button", class: "btn primary next", "data-tour": "next", title: `Marks ${name} reviewed (shortcut: n)` }, last ? "Mark file as reviewed ✓" : "Mark file as reviewed & next →");
        btn.addEventListener("click", () => h.onMarkNext(l));
        body.append(el("div", { class: "sfoot" }, btn, el("div", { class: "hint" }, `For ${name} · n mark & next · j/k move`)));
      }
      li.append(body);
    }
    wrap.append(li);
  });
  root.append(wrap);
  return root;
}
