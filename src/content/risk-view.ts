/** Risky-changes UI pieces for the Review tab: summary banner, step count, row chip, selected-file findings card. */
import type { LayerPlan } from "../engine/types";
import type { FileRisk } from "../engine/risk";
import type { Finding, Passed, Severity } from "../engine/risk/types";

export interface RiskView {
  byFile: ReadonlyMap<string, FileRisk>;
  passed: readonly Passed[];
  /** Show only risky files. */
  filter: boolean;
  listOpen: boolean;
  /** Status line shown at the bottom of the list (.codesloth.yml, files not checked). */
  notes?: string[];
  onFilter(on: boolean): void;
  onList(open: boolean): void;
  onSelect(path: string): void;
  onDismiss(f: Finding): void;
  onRestore(f: Finding): void;
  onLine(f: Finding, line: { side: "R" | "L"; n: number }): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export const SEV_LABEL: Record<Severity, string> = { high: "Likely breaking", medium: "Review carefully", low: "Worth a look" };
export const SEV_ICON: Record<Severity, string> = { high: "⛔", medium: "⚠", low: "ⓘ" };
const SEV_CLASS: Record<Severity, string> = { high: "high", medium: "med", low: "low" };

export const activeRisk = (r: RiskView | undefined, path: string): FileRisk | undefined => {
  const e = r?.byFile.get(path);
  return e && e.findings.length ? e : undefined;
};

/** Severity chip ("⚠ Review carefully"); the label hides in narrow panels, the icon and title stay. */
export function riskChip(sev: Severity, title: string): HTMLElement {
  return el("span", { class: `rchip ${SEV_CLASS[sev]}`, title }, el("span", { class: "ri", "aria-hidden": "true" }, SEV_ICON[sev]), el("span", { class: "rl" }, SEV_LABEL[sev]));
}

/** "⚠ 1" / "⛔ 2" next to a step's file count. */
export function stepRiskCount(r: RiskView | undefined, paths: string[]): HTMLElement | "" {
  const hits = paths.map((p) => activeRisk(r, p)).filter((x): x is FileRisk => !!x);
  if (!hits.length) return "";
  const worst: Severity = hits.some((h) => h.severity === "high") ? "high" : hits.some((h) => h.severity === "medium") ? "medium" : "low";
  return el("span", { class: `rcnt ${SEV_CLASS[worst]}`, title: `${hits.length} risky file${hits.length === 1 ? "" : "s"} in this step (worst: ${SEV_LABEL[worst].toLowerCase()})` }, `${SEV_ICON[worst]} ${hits.length}`);
}

export function riskBanner(plan: LayerPlan, r: RiskView): HTMLElement | null {
  const risky = [...r.byFile.entries()].filter(([, v]) => v.findings.length);
  if (!risky.length) return null;
  const high = risky.filter(([, v]) => v.severity === "high").length;
  const lowOnly = !high && risky.every(([, v]) => v.severity === "low");
  const stepOf = new Map<string, number>();
  plan.layers.forEach((l, i) => l.files.forEach((f) => stepOf.set(f.path, i)));
  risky.sort((a, b) => (a[1].severity === b[1].severity ? (stepOf.get(a[0]) ?? 0) - (stepOf.get(b[0]) ?? 0) : a[1].severity === "high" ? -1 : b[1].severity === "high" ? 1 : a[1].severity === "medium" ? -1 : 1));
  const filter = el("button", { type: "button", class: "pill" + (r.filter ? " on" : ""), "aria-pressed": String(r.filter), "data-act": "risk-filter", title: "Show only files with risky changes in the steps below" }, "Show only risky");
  filter.addEventListener("click", () => r.onFilter(!r.filter));
  const list = el("button", { type: "button", class: "pill", "aria-expanded": String(r.listOpen), "aria-controls": "prl-risk-list", "data-act": "risk-list" }, "List", el("span", { class: "pchev", "aria-hidden": "true" }, r.listOpen ? "⌃" : "⌄"));
  list.addEventListener("click", () => r.onList(!r.listOpen));
  const ul = el("ul", { class: "rlist", id: "prl-risk-list" });
  ul.hidden = !r.listOpen;
  for (const [path, v] of risky) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const b = el("button", { type: "button", class: "rrow", "data-path": path, title: `${path}\n${v.findings.map((f) => `${SEV_ICON[f.severity]} ${f.title}`).join("\n")}` }, riskChip(v.severity, SEV_LABEL[v.severity]), el("span", { class: "fname" }, name), el("span", { class: "muted st" }, `step ${(stepOf.get(path) ?? 0) + 1}`));
    b.addEventListener("click", () => r.onSelect(path));
    ul.append(el("li", {}, b));
  }
  for (const n of r.notes ?? []) ul.append(el("li", { class: "rnote muted" }, n));
  return el(
    "div",
    { class: "riskbar" + (high ? " high" : lowOnly ? " low" : ""), role: "region", "aria-label": "Risky changes", "data-tour": "risk" },
    el("div", { class: "rtx" }, el("span", { class: "ico", "aria-hidden": "true" }, high ? "⛔" : lowOnly ? "ⓘ" : "⚠"), el("b", {}, `Risky changes · ${risky.length}`), el("span", { class: "muted" }, high ? `${high} likely breaking` : lowOnly ? "low-level flags only" : "none likely breaking")),
    el("div", { class: "racts" }, filter, list),
    ul,
  );
}

const lineLabel = (l: { side: "R" | "L"; n: number }) => `${l.side}${l.n}`;

/** Findings for the selected file: one block per finding, passed checks, dismissed ones. */
export function findingsCard(path: string, fr: FileRisk | undefined, r: RiskView): HTMLElement | null {
  const passed = r.passed.filter((p) => p.path === path);
  if (!fr && !passed.length) return null;
  const card = el("div", { class: "rcard" + (fr?.findings.length ? ` ${SEV_CLASS[fr.severity]}` : ""), "aria-label": `Risk checks for ${path.slice(path.lastIndexOf("/") + 1)}` });
  for (const f of fr?.findings ?? []) card.append(findingBlock(f, r, false));
  for (const p of passed) card.append(el("p", { class: "rpass" }, el("span", { "aria-hidden": "true" }, "✓ "), `Checked: ${p.text}`));
  if (fr?.dismissed.length) {
    const d = el("details", { class: "rdis" }, el("summary", {}, `Dismissed (${fr.dismissed.length})`));
    for (const f of fr.dismissed) d.append(findingBlock(f, r, true));
    card.append(d);
  }
  return card;
}

function findingBlock(f: Finding, r: RiskView, dismissed: boolean): HTMLElement {
  const head = el("div", { class: "fh" }, el("span", { class: `ri ${SEV_CLASS[f.severity]}`, title: SEV_LABEL[f.severity], "aria-label": SEV_LABEL[f.severity] }, SEV_ICON[f.severity]), el("span", { class: "ft" }, f.title));
  for (const l of [f.line, ...(f.extraLines ?? [])].filter((x): x is { side: "R" | "L"; n: number } => !!x).slice(0, 4)) {
    const a = el("button", { type: "button", class: "lref", title: `Jump to line ${lineLabel(l)} in the diff (${l.side === "R" ? "new file" : "old file"})`, "aria-label": `Jump to ${l.side === "R" ? "new" : "old"} line ${l.n}` }, lineLabel(l));
    a.addEventListener("click", (e) => {
      e.stopPropagation();
      r.onLine(f, l);
    });
    head.append(a);
  }
  const b = el("div", { class: "fd" + (dismissed ? " gone" : ""), "data-rule": f.rule }, head);
  if (f.excerpt) b.append(el("code", { class: "ex", title: f.excerpt }, f.excerpt));
  b.append(el("p", { class: "fw" }, f.why));
  for (const a of f.adjust ?? []) b.append(el("p", { class: "fa muted" }, a));
  const act = el("button", { type: "button", class: "linkbtn", "data-act": dismissed ? "restore" : "dismiss", title: dismissed ? "Show this finding again" : `Hide this ${f.rule} finding on this file for this PR (comes back if the matched line changes)` }, dismissed ? "Undo" : "Not breaking");
  act.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dismissed) r.onRestore(f);
    else r.onDismiss(f);
  });
  b.append(el("div", { class: "fx" }, act, el("span", { class: "rule muted", title: "Rule id (configurable in .codesloth.yml)" }, f.rule)));
  return b;
}
