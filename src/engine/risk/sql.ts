/** SQL and migration rules. Statements come from the patch only (comments and string literals stripped). */
import type { PRFile } from "../types";
import { added, type HLine, type Hunk, newSide, oldSide, ref, removed, trimEx } from "./hunks";
import { isMigration, isQueryFile, isSchemaFile } from "./paths";
import type { Finding, Passed } from "./types";

export interface Stmt {
  /** Normalised text: comments removed, strings blanked, whitespace collapsed. */
  text: string;
  lines: HLine[];
  /** Contains at least one added (or, for old-side statements, removed) line. */
  changed: boolean;
}

/** Remove -- and block comments and blank string literal contents, per line (keeps line mapping). */
function cleanLines(lines: HLine[]): string[] {
  let inBlock = false;
  return lines.map((l) => {
    let s = l.text;
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (inBlock) {
        if (s[i] === "*" && s[i + 1] === "/") {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (s[i] === "/" && s[i + 1] === "*") {
        inBlock = true;
        i++;
        continue;
      }
      if (s[i] === "-" && s[i + 1] === "-") break;
      if (s[i] === "'") {
        const j = s.indexOf("'", i + 1);
        out += "''";
        i = j < 0 ? s.length : j;
        continue;
      }
      out += s[i];
    }
    return out;
  });
}

/** Split hunk lines into statements on ';'. `want` marks which line kind makes a statement "changed". */
export function statements(lines: HLine[], want: "+" | "-"): Stmt[] {
  const clean = cleanLines(lines);
  const out: Stmt[] = [];
  let buf: string[] = [];
  let ls: HLine[] = [];
  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push({ text, lines: ls, changed: ls.some((l) => l.kind === want) });
    buf = [];
    ls = [];
  };
  lines.forEach((l, i) => {
    const parts = clean[i].split(";");
    parts.forEach((p, k) => {
      if (p.trim()) {
        buf.push(p);
        if (!ls.includes(l)) ls.push(l);
      }
      if (k < parts.length - 1) flush();
    });
  });
  flush();
  return out;
}

/** Unquoted identifiers fold to lower case (Postgres); quoted ones keep their case. */
export const normTable = (t: string) => {
  const last = t.match(/(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)$/)?.[0] ?? t;
  return /^["`[]/.test(last) ? last.slice(1, -1) : last.toLowerCase();
};
const TABLE = String.raw`((?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)`;
const reCreate = new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}`, "i");

/** Tables created by CREATE TABLE anywhere in `text`. */
export function tablesIn(text: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(reCreate.source, "gi");
  for (const m of text.matchAll(re)) out.add(normTable(m[1]));
  return out;
}

export interface SqlCtx {
  /** Tables created by this PR (added lines). */
  createdInPr: Set<string>;
  /** Tables known to exist on the base branch (base schema contents, context/removed CREATE TABLEs). */
  baseTables: Set<string>;
  /** Schema text available for constraint checks (head schema files + base schema). */
  schemaText: string;
  /** The PR also changes migration files (then schema.sql DDL just mirrors them). */
  prHasMigrations: boolean;
  baseDirs: Record<string, string[]>;
  prPaths: Set<string>;
}

function existing(t: string, c: SqlCtx): { yes: boolean; assumed: boolean } {
  if (c.baseTables.has(t)) return { yes: true, assumed: false };
  if (c.createdInPr.has(t)) return { yes: false, assumed: false };
  return { yes: true, assumed: true };
}

/** First changed line of a statement matching `re`, else the first changed line. */
function at(s: Stmt, re: RegExp | null, kind: "+" | "-" = "+"): HLine {
  const changed = s.lines.filter((l) => l.kind === kind);
  return (re && changed.find((l) => re.test(l.text))) || changed[0] || s.lines[0];
}

const mk = (path: string, rule: string, severity: Finding["severity"], title: string, why: string, l?: HLine, extra: Partial<Finding> = {}): Finding => ({
  path,
  rule,
  category: "sql",
  severity,
  title,
  why,
  ...(l ? { line: ref(l), excerpt: trimEx(l.text) } : {}),
  ...extra,
});

/** Rules for one SQL statement (added side). `where` says what kind of file it's in. */
export function stmtRules(path: string, s: Stmt, c: SqlCtx, where: "migration" | "query" | "schema" | "code"): { findings: Finding[]; passed: Passed[] } {
  const f: Finding[] = [];
  const passed: Passed[] = [];
  const t = s.text;
  const T = (m: RegExpMatchArray | null) => (m ? normTable(m[1]) : "");
  const ddl = where !== "query";
  const assumedNote = (e: { assumed: boolean }, name: string) => (e.assumed ? `${name} isn't created in this PR, so it's assumed to exist.` : `${name} exists on the base branch.`);

  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+EXISTS\s+)?(\S+)/i))) {
    const kind = /TRUNCATE/i.test(m[1]) ? "Truncates a table" : /VIEW/i.test(m[1]) ? "Drops a view" : "Drops a table";
    f.push(mk(path, "sql.drop-table", "high", kind, "Data and every reader of it go away; can't be undone by a deploy rollback.", at(s, /DROP|TRUNCATE/i)));
  }
  if (ddl && /^ALTER\s+TABLE/i.test(t)) {
    const table = T(t.match(new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE}`, "i")));
    const ex = existing(table, c);
    if (/\bDROP\s+(?:COLUMN\s+)?(?!CONSTRAINT\b|INDEX\b|DEFAULT\b|NOT\b|PRIMARY\b|FOREIGN\b|KEY\b|CHECK\b|IDENTITY\b|EXPRESSION\b)(?:IF\s+EXISTS\s+)?["\w]/i.test(t))
      f.push(mk(path, "sql.drop-column", "high", "Drops a column", "Data loss, and running code that still reads or writes it fails until it's deployed.", at(s, /DROP/i)));
    if (/\bRENAME\s+(?:COLUMN\s+|CONSTRAINT\s+)?["\w]+\s+TO\b|\bRENAME\s+TO\b/i.test(t))
      f.push(mk(path, "sql.rename", "high", "Renames a table or column", "Code still using the old name breaks between the migration and the deploy.", at(s, /RENAME/i)));
    const ty = t.match(/\bALTER\s+(?:COLUMN\s+)?["\w]+\s+(?:SET\s+DATA\s+)?TYPE\s+([\w ]+?)(?:\s+USING|\s*,|$|\()/i) ?? t.match(/\bMODIFY\s+(?:COLUMN\s+)?["\w]+\s+([\w]+)/i);
    if (ty) {
      const widen = /^(BIGINT|INT8|TEXT|NUMERIC|DECIMAL|DOUBLE PRECISION|JSONB?|VARCHAR)$/i.test(ty[1].trim());
      f.push(mk(path, "sql.alter-type", widen ? "medium" : "high", "Changes a column type", widen ? `Widening to ${ty[1].trim()}; usually safe, but rewrites the table and changes generated types.` : `Converting to ${ty[1].trim()} can fail or truncate existing rows and rewrites the table.`, at(s, /TYPE|MODIFY/i)));
    }
    if (ex.yes && /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["\w]+\s+[^,]*\bNOT\s+NULL\b/i.test(t) && !/\bDEFAULT\b/i.test(t))
      f.push(mk(path, "sql.not-null-no-default", "high", "Adds a NOT NULL column without a default", `Fails on existing rows, and old code inserting without it breaks. ${assumedNote(ex, table)}`, at(s, /NOT\s+NULL/i)));
    if (/\bSET\s+NOT\s+NULL\b/i.test(t))
      f.push(mk(path, "sql.not-null-no-default", "high", "Makes a column NOT NULL", "Fails if any existing row is NULL; writers that omit it start failing.", at(s, /NOT\s+NULL/i)));
    if (ex.yes && /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?UNIQUE\b/i.test(t))
      f.push(mk(path, "sql.unique-added", "medium", "Adds a unique constraint to an existing table", `Fails if duplicates already exist; inserts that relied on duplicates start failing. ${assumedNote(ex, table)}`, at(s, /UNIQUE/i)));
    if (/\bDROP\s+CONSTRAINT\b/i.test(t))
      f.push(mk(path, "sql.index-dropped", "medium", "Drops a constraint", "Removes a guarantee other code may rely on (uniqueness, foreign keys, checks, ON CONFLICT targets).", at(s, /DROP\s+CONSTRAINT/i)));
    if (ex.yes && /\b(FOREIGN\s+KEY|REFERENCES)\b/i.test(t) && !/\bNOT\s+VALID\b/i.test(t) && where === "migration")
      f.push(mk(path, "sql.fk-added", "medium", "Adds a foreign key to an existing table", `Validates every existing row and locks both tables while it does. ${assumedNote(ex, table)}`, at(s, /REFERENCES|FOREIGN/i)));
  }
  if (ddl && (m = t.match(new RegExp(String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:\S+\s+)?ON\s+(?:ONLY\s+)?${TABLE}`, "i")))) {
    const table = normTable(m[3]);
    const ex = existing(table, c);
    if (ex.yes && m[1]) f.push(mk(path, "sql.unique-added", "medium", "Adds a unique index to an existing table", `Fails if duplicates already exist. ${assumedNote(ex, table)}`, at(s, /UNIQUE/i)));
    else if (ex.yes && !m[2] && where === "migration") f.push(mk(path, "sql.index-blocking", "medium", "Builds an index without CONCURRENTLY", `Blocks writes to ${table} while the index builds (Postgres). ${assumedNote(ex, table)}`, at(s, /INDEX/i)));
  }
  if (ddl && /^DROP\s+INDEX\b/i.test(t)) f.push(mk(path, "sql.index-dropped", "medium", "Drops an index", "Queries that relied on it get slower; if it was unique, duplicates become possible.", at(s, /DROP/i)));
  if (ddl && where === "migration" && (m = t.match(reCreate))) {
    const refs = [...t.matchAll(new RegExp(String.raw`\bREFERENCES\s+${TABLE}`, "gi"))].map((x) => normTable(x[1])).filter((x) => existing(x, c).yes && !c.createdInPr.has(x));
    if (refs.length) f.push(mk(path, "sql.fk-added", "low", `New table references existing ${refs[0]}`, "A new, empty table: validation is instant, but deletes on the referenced table now check it.", at(s, /REFERENCES/i)));
  }
  // Data changes
  const dml = t.match(new RegExp(String.raw`^(?:WITH\b.*?\)\s*)?(UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?${TABLE}`, "i"));
  if (dml) {
    const table = normTable(dml[2]);
    const verb = dml[1].toUpperCase().startsWith("UPDATE") ? "UPDATE" : "DELETE";
    const where_ = /\bWHERE\b/i.test(t) && !/\bWHERE\s+(1\s*=\s*1|TRUE)\s*($|;|RETURNING)/i.test(t);
    if (!where_) f.push(mk(path, "sql.unsafe-dml", "high", `${verb} with no WHERE`, `Touches every row in ${table}.`, at(s, new RegExp(verb, "i"))));
    else {
      const ex = existing(table, c);
      if (ex.yes && where !== "schema")
        f.push(mk(path, "sql.data-write-existing", "medium", where === "migration" ? "Changes data in an existing table" : "New write to an existing table", `${table} already holds data on the base branch. Has a WHERE${/\bAND\b/i.test(t) ? " with extra guards" : ""}. ${ex.assumed ? `(${table} isn't created in this PR, so it's assumed to exist.)` : ""}`.trim(), at(s, new RegExp(verb, "i"))));
    }
  }
  const ins = t.match(new RegExp(String.raw`^INSERT\s+INTO\s+${TABLE}`, "i"));
  if (ins) {
    const table = normTable(ins[1]);
    const oc = t.match(/\bON\s+CONFLICT\s*\(([^)]*)\)\s*DO\s+(UPDATE|NOTHING)/i);
    const ex = existing(table, c);
    if (oc && /UPDATE/i.test(oc[2]) && ex.yes && where !== "schema")
      f.push(mk(path, "sql.data-write-existing", "medium", "Upsert into an existing table", `ON CONFLICT … DO UPDATE overwrites existing rows in ${table}.`, at(s, /ON\s+CONFLICT/i)));
    if (oc) {
      const cols = oc[1].split(",").map((x) => x.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);
      const hit = uniqueMatching(c.schemaText, table, cols);
      if (hit === true || typeof hit === "string") passed.push({ path, rule: "sql.on-conflict-target", text: `ON CONFLICT target matches ${typeof hit === "string" ? hit : "a unique constraint"} on ${table}` });
      else if (hit === false) f.push(mk(path, "sql.on-conflict-target", "medium", "ON CONFLICT target has no matching unique constraint", `Postgres rejects the statement at runtime unless (${cols.join(", ")}) is unique on ${table}.`, at(s, /ON\s+CONFLICT/i)));
    }
  }
  return { findings: f, passed };
}

/**
 * Is there a PK/UNIQUE constraint or unique index on exactly `cols` for `table` in `schema`?
 * Returns the constraint name (or true), false when the table's definition was seen without one, null when unknown.
 */
export function uniqueMatching(schema: string, table: string, cols: string[]): string | boolean | null {
  if (!schema) return null;
  const want = [...cols].sort().join(",");
  const norm = (s: string) => s.split(",").map((x) => x.trim().replace(/["`]/g, "").toLowerCase().split(/\s+/)[0]).filter(Boolean).sort().join(",");
  let seen = false;
  const re = new RegExp(reCreate.source + String.raw`\s*\(`, "gi");
  for (const m of schema.matchAll(re)) {
    if (normTable(m[1]) !== table) continue;
    seen = true;
    // body up to the matching close paren
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < schema.length && depth; i++) depth += schema[i] === "(" ? 1 : schema[i] === ")" ? -1 : 0;
    const body = schema.slice(start, i - 1);
    for (const k of body.matchAll(/(?:CONSTRAINT\s+("?[\w]+"?)\s+)?(?:UNIQUE|PRIMARY\s+KEY)\s*\(([^)]*)\)/gi)) if (norm(k[2]) === want) return k[1]?.replace(/"/g, "") ?? true;
    if (cols.length === 1) {
      for (const line of body.split(/,(?![^(]*\))/)) {
        const w = line.trim().match(/^"?(\w+)"?\s+.*\b(UNIQUE|PRIMARY\s+KEY)\b/i);
        if (w && w[1].toLowerCase() === cols[0]) return true;
      }
    }
  }
  for (const m of schema.matchAll(new RegExp(String.raw`CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?)?\s*ON\s+(?:ONLY\s+)?${TABLE}\s*(?:USING\s+\w+\s*)?\(([^)]*)\)`, "gi"))) {
    if (normTable(m[2]) === table && norm(m[3]) === want) return m[1]?.replace(/"/g, "") ?? true;
  }
  return seen ? false : null;
}

/** sqlc-style named query blocks ("-- name: X :one") on one side of a hunk. */
function namedBlocks(lines: HLine[]): Map<string, { kind: string; text: string; line: HLine; touched: boolean }> {
  const out = new Map<string, { kind: string; text: string; line: HLine; touched: boolean }>();
  let cur: { name: string; kind: string; buf: string[]; line: HLine; touched: boolean } | null = null;
  const done = () => cur && out.set(cur.name, { kind: cur.kind, text: cur.buf.join(" ").replace(/\s+/g, " ").trim(), line: cur.line, touched: cur.touched });
  for (const l of lines) {
    const m = l.text.match(/^--\s*name:\s*(\w+)\s+(:\w+)/);
    if (m) {
      done();
      cur = { name: m[1], kind: m[2], buf: [], line: l, touched: l.kind !== " " };
      continue;
    }
    if (cur) {
      cur.buf.push(l.text.replace(/--.*$/, ""));
      if (l.kind !== " ") cur.touched = true;
    }
  }
  done();
  return out;
}

/** All SQL rules for one file. */
export function sqlFileRules(f: PRFile, hunks: Hunk[], c: SqlCtx, mig = isMigration(f.filename, f.patch)): { findings: Finding[]; passed: Passed[] } {
  const path = f.filename;
  const findings: Finding[] = [];
  const passed: Passed[] = [];
  const where: "migration" | "query" | "schema" = mig ? "migration" : isSchemaFile(path) ? "schema" : "query";

  if (mig) {
    if (f.status === "modified" || f.status === "renamed" || f.status === "removed" || f.status === "changed") {
      const first = added(hunks)[0] ?? removed(hunks)[0];
      findings.push(mk(path, "sql.migration-edited", "high", f.status === "removed" ? "Deletes a migration that's on the base branch" : f.status === "renamed" ? "Renames a migration that's on the base branch" : "Edits a migration that's already on the base branch", "Environments that already ran it won't run it again, so they drift from fresh ones. Add a new migration instead.", first, f.status === "renamed" ? { excerpt: `${f.previous_filename} → ${path}` } : {}));
    }
    if (f.status === "added") migrationShape(f, hunks, c, findings);
  }
  if (!/\.sql$/i.test(path)) return { findings, passed };

  if (where === "schema" && c.prHasMigrations) {
    passed.push({ path, rule: "sql.schema-mirror", text: "Schema changes mirror the migration files in this PR; checked there" });
  } else {
    for (const h of hunks) for (const s of statements(newSide(h), "+")) {
      if (!s.changed) continue;
      const r = stmtRules(path, s, c, where);
      findings.push(...r.findings);
      passed.push(...r.passed);
    }
  }
  if (where === "query" && f.status !== "added") {
    for (const h of hunks) {
      const before = namedBlocks(oldSide(h));
      const after = namedBlocks(newSide(h));
      for (const [name, b] of before) {
        const a = after.get(name);
        if (!a) {
          if (!removed(hunks).some((l) => l.text.match(new RegExp(String.raw`^--\s*name:\s*${name}\b`)))) continue;
          if (hunks.some((hh) => namedBlocks(newSide(hh)).has(name))) continue; // moved
          findings.push(mk(path, "sql.query-changed", "medium", `Removes query ${name}`, "The generated method disappears; Go/TS callers fail to compile, others fail at runtime.", b.line));
        } else if ((a.touched || b.touched) && (a.kind !== b.kind || a.text !== b.text)) {
          const l = newSide(h).find((x) => x.kind === "+" && x.new! >= a.line.new!) ?? a.line;
          findings.push(mk(path, "sql.query-changed", "medium", `Changes query ${name}`, a.kind !== b.kind ? `Result kind ${b.kind} → ${a.kind}: the generated signature changes.` : "Columns, parameters or filters changed: the generated method and its callers change.", l));
        }
      }
    }
  }
  return { findings, passed };
}

function migrationShape(f: PRFile, hunks: Hunk[], c: SqlCtx, out: Finding[]) {
  const path = f.filename;
  const dir = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const text = added(hunks).map((l) => l.text).join("\n");
  const base = c.baseDirs[dir];
  const num = (n: string) => (n.match(/^(\d+)/) ?? [])[1];
  const mine = num(name);
  if (base && mine) {
    const nums = base.map(num).filter((x): x is string => !!x);
    const max = nums.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).pop();
    if (max && BigInt(mine) < BigInt(max) && !base.includes(name))
      out.push(mk(path, "sql.migration-order", "medium", "New migration sorts before ones already on the base branch", `${name} comes before ${base.find((b) => num(b) === max)}; tools that only run "newer" migrations may skip it.`, added(hunks)[0]));
  }
  if (/\+goose\s+Up/i.test(text) && !/\+goose\s+Down/i.test(text))
    out.push(mk(path, "sql.down-missing", "medium", "No down migration", "This repo uses goose Up/Down blocks; this one has no Down, so it can't be rolled back.", added(hunks)[0]));
  if (/\.up\.sql$/i.test(name)) {
    const down = name.replace(/\.up\.sql$/i, ".down.sql");
    if (!c.prPaths.has(`${dir}/${down}`) && !(base ?? []).includes(down))
      out.push(mk(path, "sql.down-missing", "medium", "No down migration", `There's no ${down} next to it, so it can't be rolled back.`, added(hunks)[0]));
  }
  if (/\.py$/.test(name)) {
    const m = text.match(/def\s+downgrade\s*\([^)]*\)\s*(?:->\s*None)?\s*:\s*\n((?:[ \t]+.*\n?)+)/);
    if (m && m[1].split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#") && !s.startsWith('"""')).every((s) => s === "pass"))
      out.push(mk(path, "sql.down-missing", "medium", "Empty downgrade()", "The Alembic downgrade is just pass, so this migration can't be rolled back.", added(hunks).find((l) => /def\s+downgrade/.test(l.text))));
  }
}

/** SQL inside code string literals (added lines): only the destructive rules. */
export function sqlInCode(path: string, hunks: Hunk[], c: SqlCtx): Finding[] {
  const out: Finding[] = [];
  for (const h of hunks) {
    const lines = newSide(h);
    // collect string-literal segments that look like SQL
    const joined = lines.map((l) => l.text).join("\n");
    const re = /`([^`]*)`|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
    for (const m of joined.matchAll(re)) {
      const body = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (!/^(DROP\s+(TABLE|VIEW)|TRUNCATE|ALTER\s+TABLE|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b/i.test(body)) continue;
      const startLine = joined.slice(0, m.index).split("\n").length - 1;
      const endLine = startLine + m[0].split("\n").length - 1;
      const span = lines.slice(startLine, endLine + 1);
      if (!span.some((l) => l.kind === "+")) continue;
      const s: Stmt = { text: body.replace(/\s+/g, " "), lines: span, changed: true };
      const r = stmtRules(path, s, c, "code").findings.filter((x) => x.severity === "high");
      out.push(...r.map((x) => ({ ...x, rule: x.rule, title: `${x.title} (SQL in code)` })));
    }
  }
  return out;
}
