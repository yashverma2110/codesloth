import type { PRRef } from "./messages";
import { prKey } from "./pr-url";

/** Storage key for a PR's "Not breaking" dismissals (stored through the reviewed:* messages). */
export const riskKey = (pr: PRRef) => `risk:${prKey(pr)}`;

export function normalizeDismissed(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === "string" && k.split("|").length === 3) out[k] = t;
  return out;
}

