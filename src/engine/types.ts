/** Shape of an entry from GET /repos/{owner}/{repo}/pulls/{n}/files */
export interface PRFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
  patch?: string;
}

export type Category =
  | "mechanical"
  | "contract"
  | "source"
  | "test"
  | "config"
  | "docs"
  | "generated";

export interface Classification {
  category: Category;
  /** Human-readable reason for the category. */
  reason: string;
  /** Sub-kind for UI hints, e.g. "lockfile", "rename-only", "formatting-only". */
  kind?: string;
}

export type Lang = "js" | "vue" | "go" | "python" | "other";

export interface FileNode {
  path: string;
  previousPath?: string;
  status: PRFile["status"];
  additions: number;
  deletions: number;
  blobSha: string | null;
  patchAvailable: boolean;
  lang: Lang;
  classification: Classification;
  /** Raw import specifiers found in the file (unresolved). */
  imports: string[];
  /** Changed files this file depends on (resolved). */
  dependsOn: string[];
  /** Changed files that depend on this file. */
  dependents: string[];
  /** For tests: the source file under test, if paired. */
  testSubject?: string;
}

export interface LayerFile {
  path: string;
  previousPath?: string;
  status: PRFile["status"];
  additions: number;
  deletions: number;
  category: Category;
  reason: string;
  /** Blob SHA at head (null for deletions / unknown); used for "changed since reviewed". */
  sha?: string | null;
  /** Visual group: "pkg:<dir>" for a multi-file Go package, "cycle:<n>" for an import cycle. */
  group?: string;
}

export interface PlanEdge {
  /** Importer (or test). */
  from: string;
  /** Imported file (or the test's subject). */
  to: string;
  kind: "import" | "test";
}

export interface Layer {
  id: string;
  index: number;
  /** When to review it, e.g. "Review this first", "Then review these", "Skim last". */
  title: string;
  /** Short name of the layer kind, e.g. "Contracts", "Core", "Callers 2", "Tests". */
  label: string;
  /** Why, from real plan data, e.g. "As these files are imported by 5 other changed files". */
  description: string;
  files: LayerFile[];
  stats: { files: number; additions: number; deletions: number };
}

export interface LayerPlan {
  version: 1;
  engineVersion: string;
  layers: Layer[];
  /** Dependency edges between changed files (importer -> imported) plus test -> subject pairings. */
  edges: PlanEdge[];
  warnings: string[];
  stats: { files: number; additions: number; deletions: number; edges: number; contentsUsed: number };
}

export interface AnalyzeInput {
  files: PRFile[];
  /** Full head contents for some files, keyed by path. Optional. */
  contents?: Record<string, string>;
  /** Root .gitattributes content at head, if fetched. */
  gitattributes?: string;
  /** go.mod files: path -> content (root or nested). */
  goMods?: Record<string, string>;
  /** tsconfig/jsconfig path aliases (week 2). */
}
