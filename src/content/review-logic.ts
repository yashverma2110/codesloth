/** Per-file reviewed state with "changed since reviewed" detection. Pure; unit-tested. */
import type { Layer, LayerFile, LayerPlan } from "../engine/types";

/** What a file looked like when it was marked reviewed. */
export interface FileMark {
  /** Blob SHA at the time (the fingerprint); null when GitHub didn't give one. */
  sha: string | null;
  at: string;
  headSha?: string;
}

/** Stored per PR (not per head SHA) so new pushes can be compared. */
export interface ReviewState {
  v: 2;
  files: Record<string, FileMark>;
  /** Head SHA whose "new commits changed files you reviewed" banner was handled (acted on or dismissed). */
  ack?: string;
}

export const emptyReview = (): ReviewState => ({ v: 2, files: {} });

/** "changed" = stale: ticked, but the file's content changed since (new commits). The tick is kept until the user decides. */
export type FileReview = "none" | "reviewed" | "changed";

export function fileReview(state: ReviewState, f: Pick<LayerFile, "path" | "sha">): FileReview {
  const m = state.files[f.path];
  if (!m) return "none";
  return m.sha === (f.sha ?? null) ? "reviewed" : "changed";
}

export function setFilesReviewed(state: ReviewState, files: readonly Pick<LayerFile, "path" | "sha">[], reviewed: boolean, headSha?: string, at = new Date().toISOString()): ReviewState {
  const next: ReviewState = { ...state, v: 2, files: { ...state.files } };
  for (const f of files) {
    if (reviewed) next.files[f.path] = { sha: f.sha ?? null, at, headSha };
    else delete next.files[f.path];
  }
  return next;
}

export type StepReview = "none" | "partial" | "done";

export interface LayerReview {
  state: StepReview;
  reviewed: number;
  /** Files marked reviewed whose content changed since. */
  changed: string[];
}

export function layerReview(l: Layer, state: ReviewState): LayerReview {
  let reviewed = 0;
  const changed: string[] = [];
  for (const f of l.files) {
    const r = fileReview(state, f);
    if (r === "reviewed") reviewed++;
    else if (r === "changed") changed.push(f.path);
  }
  const st: StepReview = reviewed === l.files.length && l.files.length > 0 ? "done" : reviewed || changed.length ? "partial" : "none";
  return { state: st, reviewed, changed };
}

export interface ReviewSummary {
  /** Steps whose files are all reviewed. */
  reviewedLayers: Set<string>;
  changedLayers: Set<string>;
  changedPaths: Set<string>;
  reviewedPaths: Set<string>;
  reviewedFiles: number;
  totalFiles: number;
}

export function summarize(plan: LayerPlan, state: ReviewState): ReviewSummary {
  const out: ReviewSummary = { reviewedLayers: new Set(), changedLayers: new Set(), changedPaths: new Set(), reviewedPaths: new Set(), reviewedFiles: 0, totalFiles: 0 };
  for (const l of plan.layers) {
    const r = layerReview(l, state);
    if (r.state === "done") out.reviewedLayers.add(l.id);
    if (r.changed.length) out.changedLayers.add(l.id);
    r.changed.forEach((p) => out.changedPaths.add(p));
    for (const f of l.files) if (fileReview(state, f) === "reviewed") out.reviewedPaths.add(f.path);
    out.reviewedFiles += r.reviewed;
    out.totalFiles += l.files.length;
  }
  return out;
}

/**
 * Accept the v0.4.1 per-file format, and migrate v0.3/v0.4 per-layer snapshots
 * ({ layerId: { at, headSha, files: { path: sha } } }) into per-file marks with the same fingerprints.
 */
export function normalizeReviewState(raw: unknown): ReviewState {
  const out = emptyReview();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (r.v === 2 && r.files && typeof r.files === "object") {
    for (const [p, m] of Object.entries(r.files as Record<string, unknown>)) {
      const mm = m as FileMark | null;
      if (mm && typeof mm === "object" && typeof mm.at === "string" && (typeof mm.sha === "string" || mm.sha === null)) out.files[p] = { sha: mm.sha, at: mm.at, ...(mm.headSha ? { headSha: mm.headSha } : {}) };
    }
    if (typeof r.ack === "string") out.ack = r.ack;
    return out;
  }
  for (const v of Object.values(r)) {
    const snap = v as { at?: unknown; headSha?: unknown; files?: unknown } | null;
    if (!snap || typeof snap !== "object" || typeof snap.at !== "string" || !snap.files || typeof snap.files !== "object") continue;
    for (const [p, sha] of Object.entries(snap.files as Record<string, unknown>)) {
      if (typeof sha === "string" || sha === null) out.files[p] = { sha, at: snap.at, ...(typeof snap.headSha === "string" ? { headSha: snap.headSha } : {}) };
    }
  }
  return out;
}

/** The step to work on now: the first with a file not reviewed (new or changed). -1 when all done. */
export function currentStep(plan: LayerPlan, state: ReviewState): number {
  return plan.layers.findIndex((l) => layerReview(l, state).state !== "done");
}

export interface FileRef {
  layer: number;
  file: number;
  path: string;
}

const unreviewed = (state: ReviewState, f: LayerFile) => fileReview(state, f) !== "reviewed";

/** First file to review in a step (null when the step is done). */
export function firstUnreviewed(plan: LayerPlan, state: ReviewState, layer: number): FileRef | null {
  const files = plan.layers[layer]?.files ?? [];
  const i = files.findIndex((f) => unreviewed(state, f));
  return i < 0 ? null : { layer, file: i, path: files[i].path };
}

/**
 * Where "Mark file as reviewed & next" goes after `from` is marked: the next unreviewed file in the same
 * step (wrapping), else the first unreviewed file of the next step that has one (wrapping). Null when all done.
 */
export function nextUnreviewed(plan: LayerPlan, state: ReviewState, from: FileRef): FileRef | null {
  const files = plan.layers[from.layer]?.files ?? [];
  for (let k = 1; k < files.length; k++) {
    const i = (from.file + k) % files.length;
    if (unreviewed(state, files[i])) return { layer: from.layer, file: i, path: files[i].path };
  }
  const n = plan.layers.length;
  for (let k = 1; k <= n; k++) {
    const r = firstUnreviewed(plan, state, (from.layer + k) % n);
    if (r && r.path !== from.path) return r;
  }
  return null;
}

export function locate(plan: LayerPlan, path: string): FileRef | null {
  for (let li = 0; li < plan.layers.length; li++) {
    const fi = plan.layers[li].files.findIndex((f) => f.path === path);
    if (fi >= 0) return { layer: li, file: fi, path };
  }
  return null;
}

/** All files in review order (for j/k). */
export function allFiles(plan: LayerPlan): FileRef[] {
  return plan.layers.flatMap((l, li) => l.files.map((f, fi) => ({ layer: li, file: fi, path: f.path })));
}

/** Is this the only file left to review in the whole PR? */
export function isLastUnreviewed(plan: LayerPlan, state: ReviewState, path: string): boolean {
  let left = 0;
  for (const l of plan.layers) for (const f of l.files) if (unreviewed(state, f) && f.path !== path) left++;
  return left === 0;
}

export interface Progress {
  step: number; // 1-based current step, or 0 when all files are reviewed
  steps: number;
  reviewedFiles: number;
  totalFiles: number;
  /** Ticked files whose content changed since (not counted as reviewed). */
  stale: number;
  text: string;
  ratio: number;
}

export function progress(plan: LayerPlan, state: ReviewState): Progress {
  const s = summarize(plan, state);
  const cur = currentStep(plan, state);
  const steps = plan.layers.length;
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const stale = s.changedPaths.size;
  const text = (cur < 0 ? `All ${files(s.totalFiles)} reviewed` : `Step ${cur + 1} of ${steps} · ${s.reviewedFiles} of ${files(s.totalFiles)} reviewed`) + (stale ? ` · ${stale} stale` : "");
  return { step: cur + 1, steps, reviewedFiles: s.reviewedFiles, totalFiles: s.totalFiles, stale, text, ratio: s.totalFiles ? s.reviewedFiles / s.totalFiles : 0 };
}

export interface FolderGroup<T extends { path: string }> {
  /** Folder with trailing slash ("" for the repo root). */
  dir: string;
  files: (T & { name: string })[];
}

/** Group files by folder, keeping first-appearance order, so the shared path is shown once. */
export function groupByFolder<T extends { path: string }>(files: readonly T[]): FolderGroup<T>[] {
  const out: FolderGroup<T>[] = [];
  const at = new Map<string, FolderGroup<T>>();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i >= 0 ? f.path.slice(0, i + 1) : "";
    let g = at.get(dir);
    if (!g) {
      g = { dir, files: [] };
      at.set(dir, g);
      out.push(g);
    }
    g.files.push({ ...f, name: f.path.slice(i + 1) });
  }
  return out;
}

/** The file "Mark file as reviewed & next" acts on in a step: the selected file if it's in the step and not yet reviewed, else the step's first unreviewed file. */
export function ctaTarget(plan: LayerPlan, state: ReviewState, layer: number, selected: string | null): FileRef | null {
  const files = plan.layers[layer]?.files ?? [];
  const si = selected ? files.findIndex((f) => f.path === selected) : -1;
  if (si >= 0 && fileReview(state, files[si]) !== "reviewed") return { layer, file: si, path: files[si].path };
  return firstUnreviewed(plan, state, layer);
}

/* ---------------- stale reviews (new commits after you reviewed) ---------------- */

/** Ticked files whose content changed since they were ticked, in review order. */
export function staleFiles(plan: LayerPlan, state: ReviewState): LayerFile[] {
  return plan.layers.flatMap((l) => l.files.filter((f) => fileReview(state, f) === "changed"));
}

/** The head SHA most stale ticks were made at (ties: the earliest-ticked), i.e. "since your review". */
export function reviewedAtHead(state: ReviewState, paths: readonly string[]): string | null {
  const count = new Map<string, { n: number; at: string }>();
  for (const p of paths) {
    const m = state.files[p];
    if (!m?.headSha) continue;
    const c = count.get(m.headSha) ?? { n: 0, at: m.at };
    c.n++;
    if (m.at < c.at) c.at = m.at;
    count.set(m.headSha, c);
  }
  let best: [string, { n: number; at: string }] | null = null;
  for (const e of count) if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && e[1].at < best[1].at)) best = e;
  return best?.[0] ?? null;
}

/** Show the banner? Only when something is stale and this head's banner wasn't handled yet. */
export function staleBannerVisible(plan: LayerPlan, state: ReviewState, headSha: string): boolean {
  return state.ack !== headSha && staleFiles(plan, state).length > 0;
}

/** "Untick changed files": drop the stale ticks; handled for this head. */
export function untickStale(plan: LayerPlan, state: ReviewState, headSha: string): ReviewState {
  return { ...setFilesReviewed(state, staleFiles(plan, state), false), ack: headSha };
}

/** "Keep my ticks": accept the new versions as reviewed (new fingerprints); handled for this head. */
export function keepStale(plan: LayerPlan, state: ReviewState, headSha: string, at = new Date().toISOString()): ReviewState {
  return { ...setFilesReviewed(state, staleFiles(plan, state), true, headSha, at), ack: headSha };
}

/** Dismiss the banner for this head: ticks stay stale (amber), the banner comes back only on a new push. */
export function dismissStale(state: ReviewState, headSha: string): ReviewState {
  return { ...state, files: { ...state.files }, ack: headSha };
}

/** "Restart review": no ticks, no stale states. */
export function clearReview(headSha?: string): ReviewState {
  return { v: 2, files: {}, ...(headSha ? { ack: headSha } : {}) };
}

/** Result of GET /compare/{base}...{head}, reduced. */
export interface CompareInfo {
  status: "ahead" | "behind" | "identical" | "diverged" | "missing";
  aheadBy: number;
}

/** Commit-story subset used here (structural, to keep this module free of history imports). */
interface HistoryLike {
  commits: { sha: string; message: string }[];
  files: Record<string, { c: number }[]>;
}

export interface StaleSummary {
  files: { path: string; commits: string[] }[];
  /** New commits since the review, when known. */
  newCommits: number | null;
  forcePushed: boolean;
  text: string;
}

/**
 * What to say about stale files. Commit counts come from the commit story when the reviewed head is in it,
 * else from the compare API; a diverged/missing compare means the branch was force-pushed. Which files are stale
 * always comes from the blob fingerprints.
 */
export function staleSummary(plan: LayerPlan, state: ReviewState, history?: HistoryLike | null, compare?: CompareInfo | null): StaleSummary {
  const stale = staleFiles(plan, state);
  const base = reviewedAtHead(state, stale.map((f) => f.path));
  const idx = base && history ? history.commits.findIndex((c) => c.sha === base) : -1;
  let newCommits: number | null = null;
  let forcePushed = false;
  if (idx >= 0 && history) newCommits = history.commits.length - 1 - idx;
  else if (compare && (compare.status === "ahead" || compare.status === "identical")) newCommits = compare.aheadBy;
  else if (compare && (compare.status === "diverged" || compare.status === "missing" || compare.status === "behind")) forcePushed = true;
  const files = stale.map((f) => ({ path: f.path, commits: idx >= 0 && history ? (history.files[f.path] ?? []).filter((t) => t.c > idx).map((t) => history.commits[t.c].message) : [] }));
  const m = stale.length;
  const mf = `${m} file${m === 1 ? "" : "s"} you reviewed`;
  const text = forcePushed
    ? `The PR was force-pushed; ${mf} changed.`
    : newCommits
      ? `${newCommits} new commit${newCommits === 1 ? "" : "s"} changed ${mf}.`
      : `New commits changed ${mf}.`;
  return { files, newCommits, forcePushed, text };
}
