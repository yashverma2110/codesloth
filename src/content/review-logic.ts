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
}

export const emptyReview = (): ReviewState => ({ v: 2, files: {} });

export type FileReview = "none" | "reviewed" | "changed";

export function fileReview(state: ReviewState, f: Pick<LayerFile, "path" | "sha">): FileReview {
  const m = state.files[f.path];
  if (!m) return "none";
  return m.sha === (f.sha ?? null) ? "reviewed" : "changed";
}

export function setFilesReviewed(state: ReviewState, files: readonly Pick<LayerFile, "path" | "sha">[], reviewed: boolean, headSha?: string, at = new Date().toISOString()): ReviewState {
  const next: ReviewState = { v: 2, files: { ...state.files } };
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
  text: string;
  ratio: number;
}

export function progress(plan: LayerPlan, state: ReviewState): Progress {
  const s = summarize(plan, state);
  const cur = currentStep(plan, state);
  const steps = plan.layers.length;
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const text = cur < 0 ? `All ${files(s.totalFiles)} reviewed` : `Step ${cur + 1} of ${steps} · ${s.reviewedFiles} of ${files(s.totalFiles)} reviewed`;
  return { step: cur + 1, steps, reviewedFiles: s.reviewedFiles, totalFiles: s.totalFiles, text, ratio: s.totalFiles ? s.reviewedFiles / s.totalFiles : 0 };
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
