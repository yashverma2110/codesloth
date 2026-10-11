/** Risky-changes user settings (kept tiny: the settings page imports this without the rule engine). */
import type { RiskCategory } from "./types";

export type Sensitivity = "relaxed" | "normal" | "strict";
export const RISK_CATEGORIES: { id: RiskCategory; label: string }[] = [
  { id: "sql", label: "SQL & migrations" },
  { id: "config", label: "Config & infra" },
  { id: "data", label: "Data layer" },
  { id: "api", label: "API contracts" },
  { id: "deps", label: "Dependencies" },
];

export interface RiskPrefs {
  sensitivity: Sensitivity;
  /** Disabled categories. */
  off: RiskCategory[];
}
export const DEFAULT_RISK_PREFS: RiskPrefs = { sensitivity: "normal", off: [] };

export function normalizeRiskPrefs(sens: unknown, off: unknown): RiskPrefs {
  const s = sens === "relaxed" || sens === "strict" || sens === "normal" ? sens : "normal";
  const ids = new Set(RISK_CATEGORIES.map((c) => c.id));
  return { sensitivity: s, off: Array.isArray(off) ? (off.filter((x) => ids.has(x)) as RiskCategory[]) : [] };
}

