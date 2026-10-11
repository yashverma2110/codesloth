/** Reviewed-state model with "changed since reviewed" detection. Pure; unit-tested. */
import type { Layer, LayerPlan } from "../engine/types";

/** What a layer looked like when it was marked reviewed: path -> blob sha. */
export interface LayerSnapshot {
  at: string;
  headSha?: string;
  files: Record<string, string | null>;
}

/** layerId -> snapshot. Stored per PR (not per head SHA) so new pushes can be compared. */
export type ReviewState = Record<string, LayerSnapshot>;

export function snapshotLayer(layer: Layer, headSha?: string, at = new Date().toISOString()): LayerSnapshot {
  const files: Record<string, string | null> = {};
  for (const f of layer.files) files[f.path] = f.sha ?? null;
  return { at, headSha, files };
}

/** Files of a reviewed layer that differ from the snapshot (new, changed content, or moved out). */
export function changedSinceReviewed(layer: Layer, snap: LayerSnapshot | undefined): string[] {
  if (!snap) return [];
  const out: string[] = [];
  const now = new Set<string>();
  for (const f of layer.files) {
    now.add(f.path);
    if (!(f.path in snap.files) || snap.files[f.path] !== (f.sha ?? null)) out.push(f.path);
  }
  for (const p of Object.keys(snap.files)) if (!now.has(p)) out.push(p);
  return out;
}

export interface ReviewSummary {
  reviewedLayers: Set<string>;
  changedLayers: Set<string>;
  changedPaths: Set<string>;
  reviewedFiles: number;
  totalFiles: number;
}

export function summarize(plan: LayerPlan, state: ReviewState): ReviewSummary {
  const reviewedLayers = new Set<string>();
  const changedLayers = new Set<string>();
  const changedPaths = new Set<string>();
  let reviewedFiles = 0;
  for (const l of plan.layers) {
    const snap = state[l.id];
    if (!snap) continue;
    reviewedLayers.add(l.id);
    const ch = changedSinceReviewed(l, snap);
    if (ch.length) {
      changedLayers.add(l.id);
      ch.forEach((p) => changedPaths.add(p));
    }
    reviewedFiles += l.files.filter((f) => !ch.includes(f.path)).length;
  }
  return { reviewedLayers, changedLayers, changedPaths, reviewedFiles, totalFiles: plan.layers.reduce((s, l) => s + l.files.length, 0) };
}

/** Accept only well-formed snapshots (older versions stored booleans keyed by head SHA). */
export function normalizeReviewState(raw: unknown): ReviewState {
  const out: ReviewState = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === "object" && typeof (v as LayerSnapshot).at === "string" && (v as LayerSnapshot).files && typeof (v as LayerSnapshot).files === "object") {
      out[k] = v as LayerSnapshot;
    }
  }
  return out;
}

export function setReviewed(state: ReviewState, layer: Layer, reviewed: boolean, headSha?: string, at?: string): ReviewState {
  const next = { ...state };
  if (reviewed) next[layer.id] = snapshotLayer(layer, headSha, at);
  else delete next[layer.id];
  return next;
}
