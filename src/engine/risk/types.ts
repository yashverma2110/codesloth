/** Risky-changes findings: rule-based, explainable, computed from patch text, paths and statuses. */

export type Severity = "high" | "medium" | "low";
/** Settings toggle groups. */
export type RiskCategory = "sql" | "config" | "data" | "api" | "deps";

export interface Finding {
  path: string;
  /** Stable rule id, e.g. "sql.drop-column". */
  rule: string;
  category: RiskCategory;
  severity: Severity;
  /** Short label, e.g. "Drops a column". */
  title: string;
  /** Why it matters, one line. */
  why: string;
  /** Diff line: R = new file line (added/context), L = old file line (removed). */
  line?: { side: "R" | "L"; n: number };
  /** The matched code, one line, trimmed. */
  excerpt?: string;
  /** How the severity was adjusted, in words (e.g. "Go checks callers at compile time"). */
  adjust?: string[];
  /** More matched lines for the same finding (e.g. several new routes). */
  extraLines?: { side: "R" | "L"; n: number }[];
}

/** A rule that ran and passed, shown so a quiet file reads as checked. */
export interface Passed {
  path: string;
  rule: string;
  text: string;
}

export interface RiskReport {
  version: 1;
  findings: Finding[];
  passed: Passed[];
  /** Files that couldn't be checked (no patch from GitHub). */
  notChecked: string[];
  /** .codesloth.yml status line, e.g. "Loaded from main (2 rule overrides)". */
  config?: string;
  /** Sensitivity requested by .codesloth.yml (the stricter of this and the user's setting applies). */
  sensitivity?: "relaxed" | "normal" | "strict";
}

export interface RiskInput {
  files: import("../types").PRFile[];
  /** Head contents the analysis already fetched (path -> text). */
  contents?: Record<string, string>;
  /** Base-branch contents for schema files and other context (path -> text). */
  baseContents?: Record<string, string>;
  /** Base-branch listings of migration directories touched by the PR (dir -> file names). */
  baseDirs?: Record<string, string[]>;
  /** .codesloth.yml text from the base branch. */
  configText?: string;
  /** Number of changed files importing each file (from the layer engine's graph). */
  importers?: Record<string, number>;
}
