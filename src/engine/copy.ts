/**
 * Reviewer-facing copy: layer headings say WHEN to review a layer, "because" lines say WHY, and
 * per-file reasons say how each file connects to the rest. Everything here is computed from the
 * plan's real data (counts, import graph, kinds of change); nothing is claimed that the graph
 * can't back up.
 */

const GENERIC = new Set(["__init__.py", "index.ts", "index.tsx", "index.js", "index.jsx", "index.vue", "main.go", "mod.rs", "types.ts", "utils.ts", "util.go", "doc.go"]);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** "1 file" / "3 files". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short, readable file label: basename, or parent/basename for generic names like __init__.py. */
export function fileLabel(p: string, all: readonly string[] = []): string {
  const b = base(p);
  const clash = all.some((q) => q !== p && base(q) === b);
  return (GENERIC.has(b) || clash) && p.includes("/") ? p.split("/").slice(-2).join("/") : b;
}

/** "a.py", "a.py and b.py", "a.py and 3 others". */
export function namesList(paths: readonly string[], label: (p: string) => string = (p) => fileLabel(p, paths)): string {
  const u = [...new Set(paths.map(label))];
  if (u.length === 0) return "";
  if (u.length === 1) return u[0];
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  return `${u[0]} and ${plural(u.length - 1, "other")}`;
}

/** "a", "a and b", "a, b and c". */
export function joinWords(words: readonly string[]): string {
  const u = [...new Set(words)];
  if (u.length <= 1) return u[0] ?? "";
  return `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
}

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export type ContractKind = "schema" | "query" | "migration" | "type" | "API contract";

/** What kind of contract a file is, from its classifier reason and path. */
export function contractKind(path: string, classifierReason: string): ContractKind {
  const r = classifierReason.toLowerCase();
  const p = path.toLowerCase();
  if (r.includes("migration")) return "migration";
  if (r.includes("protobuf") || r.includes("openapi") || r.includes("swagger")) return "API contract";
  if (r.includes("graphql")) return /schema|\.graphqls$/.test(p) ? "schema" : "query";
  if (r.includes("sql")) return /schema/.test(p) ? "schema" : "query";
  if (r.includes("typescript declaration") || r.includes("types/") || r.includes("type definitions")) return "type";
  return "schema";
}

const KIND_ORDER: ContractKind[] = ["schema", "query", "migration", "type", "API contract"];

/** "schema and query updates", "migration updates". */
export function contractKindsPhrase(kinds: readonly ContractKind[]): string {
  const sorted = KIND_ORDER.filter((k) => kinds.includes(k));
  return `${joinWords(sorted)} updates`;
}

/** "an API contract update" vs "a schema update". */
export function aKind(k: ContractKind): string {
  return `${/^[aeiouAEIOU]/.test(k) ? "an" : "a"} ${k} update`;
}

const LOCK_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|poetry\.lock|uv\.lock|pdm\.lock|pipfile\.lock|cargo\.lock|composer\.lock|gemfile\.lock)$/i;
export const isLockfile = (p: string) => LOCK_RE.test(p);

/** Ordered headings for successive caller levels. */
export const CALLER_HEADINGS = ["Then review these", "Review these after that", "Then these", "And finally these"];
