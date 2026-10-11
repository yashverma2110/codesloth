/** Data-layer and public-API rules for code files (Go, Python, JS/TS) and contract files (proto, GraphQL, OpenAPI, Prisma). */
import type { PRFile } from "../types";
import { added, type HLine, type Hunk, newSide, oldSide, ref, removed, trimEx } from "./hunks";
import { changedKeys } from "./config";
import type { Finding, RiskCategory } from "./types";

const mk = (category: RiskCategory, path: string, rule: string, severity: Finding["severity"], title: string, why: string, l?: HLine, extra: Partial<Finding> = {}): Finding => ({
  path,
  rule,
  category,
  severity,
  title,
  why,
  ...(l ? { line: ref(l), excerpt: trimEx(l.text) } : {}),
  ...extra,
});

export const DATA_LAYER = /(^|\/)(repositor(y|ies)|repos?|dao|daos|store|stores|storage|db|database|models?|entities|entity|persistence|dal|schemas?)\/|(^|\/)[^/]*(repository|repo|dao|store|model|entity)s?\.[a-z]+$/i;

/* ---------------- shared: balanced scanning ---------------- */

function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{<".includes(ch)) depth++;
    if (")]}>".includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Read a balanced (...) starting at text[i] === "(". Returns [inner, indexAfter] or null. */
function balanced(text: string, i: number, open = "(", close = ")"): [string, number] | null {
  if (text[i] !== open) return null;
  let d = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === open) d++;
    else if (text[j] === close && --d === 0) return [text.slice(i + 1, j), j + 1];
  }
  return null;
}

interface Side {
  text: string;
  /** Char offset of each line start. */
  starts: number[];
  lines: HLine[];
}
function side(lines: HLine[]): Side {
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.text.length + 1;
  }
  return { text: lines.map((l) => l.text).join("\n"), starts, lines };
}
function lineAt(s: Side, off: number): HLine {
  let lo = 0;
  for (let i = 0; i < s.starts.length; i++) if (s.starts[i] <= off) lo = i;
  return s.lines[lo];
}
function linesBetween(s: Side, a: number, b: number): HLine[] {
  return s.lines.filter((_, i) => s.starts[i] + s.lines[i].text.length >= a && s.starts[i] <= b);
}

/* ---------------- Go ---------------- */

/** Go parameter list -> type list ("a, b int, c string" -> ["int","int","string"]). */
export function goParamTypes(params: string): string[] {
  const parts = splitTop(params.replace(/\s+/g, " "));
  const named = parts.some((p) => /^[\w]+\s+\S/.test(p) && !/^(func|chan|map|struct|interface)\b/.test(p));
  if (!named) return parts.map((p) => p.replace(/\s+/g, ""));
  const out: string[] = [];
  let cur = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(/^(\w+)\s+(.+)$/);
    if (m) cur = m[2].replace(/\s+/g, "");
    out.unshift(cur);
  }
  return out;
}

export interface GoFunc {
  key: string;
  name: string;
  sig: string;
  pretty: string;
  line: HLine;
  touched: boolean;
}

/** Complete func declarations on one side of a hunk. */
export function goFuncs(lines: HLine[]): GoFunc[] {
  const s = side(lines);
  const out: GoFunc[] = [];
  const re = /^func\s+(?:\(\s*(?:\w+\s+)?\*?\s*([\w.]+)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\(/gm;
  for (const m of s.text.matchAll(re)) {
    const pOpen = m.index! + m[0].length - 1;
    const p = balanced(s.text, pOpen);
    if (!p) continue;
    // results: up to the opening brace on the same logical line
    const rest = s.text.slice(p[1]);
    const brace = rest.search(/\{\s*($|\n|\})/);
    if (brace < 0) continue;
    const results = rest.slice(0, brace).trim();
    const res = results.startsWith("(") ? goParamTypes(results.slice(1, -1)).join(",") : results.replace(/\s+/g, "");
    const sig = `(${goParamTypes(p[0]).join(",")})${res}`;
    const span = linesBetween(s, m.index!, p[1] + brace);
    out.push({ key: `${m[1] ? m[1].replace(/^\*/, "") + "." : ""}${m[2]}`, name: m[2], sig, pretty: `${m[2]}(${p[0].replace(/\s+/g, " ").trim()})${results ? " " + results.replace(/\s+/g, " ") : ""}`, line: span.find((l) => l.kind !== " ") ?? lineAt(s, m.index!), touched: span.some((l) => l.kind !== " ") });
  }
  return out;
}

interface Member {
  block: string;
  kind: "interface" | "struct";
  name: string;
  /** Normalised method signature or field type. */
  sig: string;
  tags: Record<string, string>;
  line: HLine;
}

function parseTags(t: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of t.matchAll(/(\w+):"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** Members of Go interface/struct blocks on one side of a hunk (uses the hunk section when the block opened above). */
function goMembers(lines: HLine[], section: string): Member[] {
  const out: Member[] = [];
  let block: { name: string; kind: "interface" | "struct" } | null = null;
  const sec = section.match(/^type\s+(\w+)\s+(interface|struct)\s*\{/);
  let depth = 0;
  // GitHub's hunk section is a guess at the enclosing block: trust it only if the hunk opens with members.
  const firstCode = lines.find((l) => l.text.trim());
  if (sec && firstCode && /^\s+\w/.test(firstCode.text) && !/^\s+(if|for|return|switch|case|var|defer|go|select|else|\w+\s*:?=)\b/.test(firstCode.text)) {
    block = { name: sec[1], kind: sec[2] as "interface" | "struct" };
    depth = 1;
  }
  for (const l of lines) {
    const t = l.text;
    const open = t.match(/^type\s+(\w+)(?:\[[^\]]*\])?\s+(interface|struct)\s*\{\s*$/);
    if (open) {
      block = { name: open[1], kind: open[2] as "interface" | "struct" };
      depth = 1;
      continue;
    }
    if (!block) continue;
    if (/^\}/.test(t)) {
      block = null;
      continue;
    }
    if (depth !== 1) continue;
    if (block.kind === "interface") {
      const m = t.match(/^\s+([A-Z]\w*)\s*\((.*)$/);
      if (!m) continue;
      const p = balanced("(" + m[2], 0);
      if (!p) continue;
      const results = ("(" + m[2]).slice(p[1]).trim();
      const res = results.startsWith("(") ? goParamTypes(results.slice(1, -1)).join(",") : results.replace(/\s+/g, "");
      out.push({ block: block.name, kind: "interface", name: m[1], sig: `(${goParamTypes(p[0]).join(",")})${res}`, tags: {}, line: l });
    } else {
      const m = t.match(/^\s+([A-Za-z_]\w*)\s+((?:\*|\[\d*\])*(?:map\[[^\]]+\][\w.*\[\]]+|func\(.*|chan\s+[\w.*]+|interface\s*\{\s*\}|struct\s*\{\s*\}|[\w.]+(?:\[[\w., *]+\])?))\s*(`[^`]*`)?\s*(\/\/.*)?$/);
      if (!m || /^(func|if|for|return|switch|case|var|const|defer|go|select|else|type)$/.test(m[1])) continue;
      out.push({ block: block.name, kind: "struct", name: m[1], sig: m[2].replace(/\s+/g, ""), tags: m[3] ? parseTags(m[3]) : {}, line: l });
    }
  }
  return out;
}

const WIRE_TAGS = ["json", "db", "bson", "yaml", "gorm", "form", "xml", "protobuf", "msgpack", "dynamodbav", "firestore"];

export function goRules(f: PRFile, hunks: Hunk[], allNewFuncs: Set<string>, dataLayer: boolean): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added") return out;
  const oldF = hunks.flatMap((h) => goFuncs(oldSide(h)));
  const newF = hunks.flatMap((h) => goFuncs(newSide(h)));
  const newBy = new Map(newF.map((x) => [x.key, x]));
  for (const o of oldF) {
    if (!/^[A-Z]/.test(o.name)) continue;
    const n = newBy.get(o.key);
    if (n) {
      if (n.sig !== o.sig && (n.touched || o.touched))
        out.push(mk("data", path, "dal.sig-changed", dataLayer ? "medium" : "low", `Exported func ${o.name} signature changed`, "Callers must change. Go checks them at compile time, so this can't break silently inside this repo.", n.line, { excerpt: `${trimEx(o.pretty, 90)}  →  ${trimEx(n.pretty, 90)}` }));
    } else if (o.touched && o.line.kind === "-" && !allNewFuncs.has(o.key)) {
      out.push(mk("data", path, "dal.removed", dataLayer ? "medium" : "low", `Removes exported func ${o.name}`, "Every caller must go; Go checks callers at compile time inside this repo, not in other repos.", o.line));
    }
  }
  // interfaces and structs
  const oldM = hunks.flatMap((h) => goMembers(oldSide(h), h.section));
  const newM = hunks.flatMap((h) => goMembers(newSide(h), h.section));
  const key = (m: Member) => `${m.block}.${m.name}`;
  const newMBy = new Map(newM.map((m) => [key(m), m]));
  const oldMBy = new Map(oldM.map((m) => [key(m), m]));
  const ifaceAdds = new Map<string, Member[]>();
  for (const n of newM) {
    if (n.kind !== "interface" || n.line.kind !== "+") continue;
    const o = oldMBy.get(key(n));
    if (!o) ifaceAdds.set(n.block, [...(ifaceAdds.get(n.block) ?? []), n]);
    else if (o.sig !== n.sig) out.push(mk("data", path, "dal.interface", "medium", `Interface ${n.block}: ${n.name} signature changed`, "Every implementation (including mocks and fakes) must change.", n.line));
  }
  for (const [block, ms] of ifaceAdds)
    out.push(mk("data", path, "dal.interface", "medium", ms.length === 1 ? `Interface ${block} gains ${ms[0].name}` : `Interface ${block} gains ${ms.length} methods`, `Other implementations (mocks, fakes) must add ${ms.length === 1 ? "it" : ms.slice(0, 3).map((m) => m.name).join(", ") + (ms.length > 3 ? "…" : "")}.`, ms[0].line));
  for (const o of oldM) {
    if (o.line.kind !== "-") continue;
    const n = newMBy.get(key(o));
    if (o.kind === "interface") {
      if (!n) out.push(mk("data", path, "dal.interface", "medium", `Interface ${o.block} loses ${o.name}`, "Callers using it through the interface must change.", o.line));
      continue;
    }
    if (!n) {
      if (/^[A-Z]/.test(o.name)) out.push(mk("data", path, "dal.field-changed", "medium", `Removes field ${o.block}.${o.name}`, Object.keys(o.tags).some((t) => WIRE_TAGS.includes(t)) ? `It was serialized (${Object.entries(o.tags).map(([k, v]) => `${k}:"${v}"`).join(" ")}); clients and stored data still carry it.` : "Code using it must change.", o.line));
      continue;
    }
    if (n.sig !== o.sig) out.push(mk("data", path, "dal.field-changed", "medium", `Field ${o.block}.${o.name}: ${o.sig} → ${n.sig}`, "Changes the stored/serialized shape and every use of the field.", n.line));
    for (const t of WIRE_TAGS) {
      const a = o.tags[t];
      const b = n.tags[t];
      if (a === b || (a === undefined && b === undefined)) continue;
      const name = (v?: string) => (v ?? "").split(",")[0];
      if (a !== undefined && b !== undefined && name(a) === name(b)) {
        out.push(mk("data", path, "dal.tag-changed", "medium", `${t} tag options on ${o.block}.${o.name}: "${a}" → "${b}"`, "Changes how the field is serialized (e.g. omitempty).", n.line));
      } else out.push(mk("data", path, "dal.tag-changed", "high", `${t} tag on ${o.block}.${o.name}: ${a === undefined ? "added" : `"${name(a)}"`} → ${b === undefined ? "removed" : `"${name(b)}"`}`, "Renames the field on the wire or in the database; the compiler won't catch clients or stored data using the old name.", n.line));
    }
  }
  return out;
}

/* ---------------- routes + middleware (Go, Python, JS/TS) ---------------- */

interface Route {
  method: string;
  path: string;
  via: string;
  line: HLine;
}

function groupPrefixes(text: string): Map<string, { parent: string; prefix: string }> {
  const g = new Map<string, { parent: string; prefix: string }>();
  for (const m of text.matchAll(/\b(\w+)\s*:?=\s*(\w+)\.(?:Group|Route|PathPrefix|Subrouter)\(\s*"([^"]*)"/g)) g.set(m[1], { parent: m[2], prefix: m[3] });
  for (const m of text.matchAll(/\b(\w+)\s*=\s*APIRouter\([^)]*prefix\s*=\s*["']([^"']*)["']/g)) g.set(m[1], { parent: "", prefix: m[2] });
  return g;
}
function fullPath(via: string, p: string, groups: Map<string, { parent: string; prefix: string }>): string {
  let prefix = "";
  let v: string | undefined = via;
  for (let i = 0; v && i < 6; i++) {
    const g = groups.get(v);
    if (!g) break;
    prefix = g.prefix + prefix;
    v = g.parent;
  }
  return (prefix + p).replace(/\/+/g, "/") || "/";
}

export function routesIn(lines: HLine[], lang: string): Route[] {
  const out: Route[] = [];
  for (const l of lines) {
    const t = l.text;
    let m: RegExpMatchArray | null;
    if (lang === "go" && (m = t.match(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]*)"/))) out.push({ method: m[2].toUpperCase().replace(/^HANDLE(FUNC)?$/, "ANY"), path: m[3], via: m[1], line: l });
    else if (lang === "python" && (m = t.match(/@(\w+)\.(get|post|put|patch|delete|route|api_route)\(\s*["']([^"']*)["'](.*)/))) {
      const methods = m[2] === "route" || m[2] === "api_route" ? (m[4].match(/methods\s*=\s*\[([^\]]*)\]/)?.[1].replace(/["'\s]/g, "").toUpperCase() ?? "GET") : m[2].toUpperCase();
      out.push({ method: methods, path: m[3], via: m[1], line: l });
    } else if (lang === "js" && (m = t.match(/\b(app|router|server|fastify|\w+Router)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]*)["'`]/))) out.push({ method: m[2].toUpperCase(), path: m[3], via: m[1], line: l });
    else if (lang === "js" && (m = t.match(/@(Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/))) out.push({ method: m[1].toUpperCase(), path: "/" + (m[2] ?? ""), via: "@nest", line: l });
  }
  return out;
}

export function routeRules(f: PRFile, hunks: Hunk[], lang: string, headText: string, publicPrefixes: string[]): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  const oldText = hunks.flatMap((h) => oldSide(h)).map((l) => l.text).join("\n");
  const newText = headText || hunks.flatMap((h) => newSide(h)).map((l) => l.text).join("\n");
  const gOld = groupPrefixes(oldText + "\n" + newText);
  const gNew = groupPrefixes(newText);
  const rem = routesIn(removed(hunks), lang).map((r) => ({ ...r, full: fullPath(r.via, r.path, gOld) }));
  const add = routesIn(added(hunks), lang).map((r) => ({ ...r, full: fullPath(r.via, r.path, gNew) }));
  const k = (r: { method: string; full: string }) => `${r.method} ${r.full}`;
  const addKeys = new Set(add.map(k));
  const remKeys = new Set(rem.map(k));
  const isPublic = (r: { full: string; via: string }) => publicPrefixes.some((p) => r.full.startsWith(p)) || /(^|\/)(public|external|webhooks?|open)(\/|$)/i.test(r.full) || /public/i.test(r.via);
  for (const r of rem) if (!addKeys.has(k(r))) out.push(mk("api", path, "api.route", "high", `Removes route ${r.method} ${r.full}`, "Clients calling it get 404s; the compiler and this repo's tests won't see them.", r.line));
  const newPublic = add.filter((r) => !remKeys.has(k(r)) && isPublic(r));
  const newOther = add.filter((r) => !remKeys.has(k(r)) && !isPublic(r));
  if (newPublic.length)
    out.push(mk("api", path, "api.route", "medium", newPublic.length === 1 ? `New public route ${newPublic[0].method} ${newPublic[0].full}` : `${newPublic.length} new public routes`, `Exposes ${newPublic.map((r) => `${r.method} ${r.full}`).slice(0, 3).join(", ")}${newPublic.length > 3 ? "…" : ""}; check auth, validation and rate limits.`, newPublic[0].line, newPublic.length > 1 ? { excerpt: trimEx(newPublic.map((r) => r.line.text.trim()).join("  ·  ")), extraLines: newPublic.slice(1).map((r) => ref(r.line)) } as Partial<Finding> : {}));
  if (newOther.length) out.push(mk("api", path, "api.route", "low", newOther.length === 1 ? `New route ${newOther[0].method} ${newOther[0].full}` : `${newOther.length} new routes`, "Additive.", newOther[0].line));
  // middleware (Go .Use / Express app.use without a path)
  if (lang === "go" || lang === "js") {
    const assigns = new Map<string, string>();
    for (const l of added(hunks)) {
      const m = l.text.match(/^\s*(\w+)\s*:?=\s*(.+?)\s*;?\s*$/);
      if (m) assigns.set(m[1], m[2]);
    }
    const subst = (s: string) => s.replace(/\b(\w+)\b/g, (w) => assigns.get(w) ?? w).replace(/\s+/g, "");
    const uses = (ls: HLine[]) => ls.flatMap((l) => {
      const m = l.text.match(/\b(\w+)\.(Use|use)\((?!\s*["'`])(.*)\)\s*;?\s*$/);
      return m ? [{ via: m[1], arg: m[3], l }] : [];
    });
    const ru = uses(removed(hunks));
    const au = uses(added(hunks));
    for (const a of au) {
      if (ru.some((r) => r.via === a.via && subst(r.arg) === subst(a.arg))) continue;
      const target = gNew.has(a.via) ? `${fullPath(a.via, "", gNew)} group` : a.via;
      const r = ru.find((x) => x.via === a.via);
      out.push(mk("api", path, "api.middleware", "medium", r ? `Changes middleware on ${target}` : `Adds middleware to ${target}`, /auth/i.test(a.arg) ? `Auth now applies to every route on ${target}${hadNoRoutes(target, oldText) ? "; the group had no routes on the base branch" : ""}.` : `Every route on ${target} now runs ${trimEx(a.arg, 50)}.`, a.l));
    }
    for (const r of ru) {
      if (au.some((a) => a.via === r.via)) continue;
      out.push(mk("api", path, "api.middleware", /auth/i.test(r.arg) ? "high" : "medium", `Removes middleware from ${r.via}`, /auth/i.test(r.arg) ? "Routes on it are no longer authenticated." : `${trimEx(r.arg, 50)} no longer runs.`, r.l));
    }
  }
  return out;
}

function hadNoRoutes(target: string, oldText: string): boolean {
  const prefix = target.replace(/ group$/, "");
  const g = groupPrefixes(oldText);
  const vars = [...g.entries()].filter(([, v]) => v.prefix === prefix).map(([k]) => k);
  if (!oldText.includes(`"${prefix}"`)) return false;
  return !vars.some((v) => new RegExp(String.raw`\b${v}\.(GET|POST|PUT|PATCH|DELETE|Any|Handle)`).test(oldText));
}

/* ---------------- Python ---------------- */

function pyRequired(params: string): string[] {
  return splitTop(params)
    .map((p) => p.replace(/:.*$/s, (x) => (x.includes("=") ? "=" : "")).trim())
    .filter((p) => p && !/^(self|cls)$/.test(p) && !p.startsWith("*") && p !== "/" && !p.includes("="));
}
function pyParams(params: string): string[] {
  return splitTop(params).map((p) => p.split(/[:=]/)[0].trim()).filter((p) => p && !/^(self|cls|\/|\*)$/.test(p));
}

export function pythonRules(f: PRFile, hunks: Hunk[], allNewDefs: Set<string>, dataLayer: boolean, headText: string): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added") return out;
  const defs = (lines: HLine[]) => {
    const s = side(lines);
    const res: { name: string; params: string; line: HLine; touched: boolean }[] = [];
    for (const m of s.text.matchAll(/^[ \t]*(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/gm)) {
      const p = balanced(s.text, m.index! + m[0].length - 1);
      if (!p || m[1].startsWith("_")) continue;
      const span = linesBetween(s, m.index!, p[1]);
      res.push({ name: m[1], params: p[0], line: span.find((l) => l.kind !== " ") ?? lineAt(s, m.index!), touched: span.some((l) => l.kind !== " ") });
    }
    return res;
  };
  const oldD = hunks.flatMap((h) => defs(oldSide(h)));
  const newD = new Map(hunks.flatMap((h) => defs(newSide(h))).map((d) => [d.name, d]));
  const shared = dataLayer;
  for (const o of oldD) {
    const n = newD.get(o.name);
    if (n) {
      if (!(n.touched || o.touched)) continue;
      const gone = pyParams(o.params).filter((p) => !pyParams(n.params).includes(p));
      const newReq = pyRequired(n.params).filter((p) => !pyParams(o.params).includes(p));
      if (gone.length || newReq.length)
        out.push(mk("data", path, "dal.sig-changed", shared ? "medium" : "low", `${o.name}() parameters changed`, `${gone.length ? `Removes ${gone.join(", ")}` : ""}${gone.length && newReq.length ? "; " : ""}${newReq.length ? `new required ${newReq.join(", ")}` : ""}. Python won't catch callers until they run.`, n.line));
    } else if (o.touched && o.line.kind === "-" && !allNewDefs.has(o.name)) out.push(mk("data", path, "dal.removed", shared ? "medium" : "low", `Removes ${o.name}()`, "Callers fail at runtime; Python has no compile step to catch them.", o.line));
  }
  // ORM columns
  const colRe = /^\s*(\w+)\s*(?::\s*[^=]+)?=\s*(?:db\.|sa\.|sqlalchemy\.)?(Column|mapped_column|relationship)\((.*)$/;
  const djRe = /^\s*(\w+)\s*=\s*models\.(\w+Field|ForeignKey|OneToOneField|ManyToManyField)\((.*)$/;
  const remC = removed(hunks).map((l) => ({ l, m: l.text.match(colRe) ?? l.text.match(djRe) })).filter((x) => x.m);
  const addC = added(hunks).map((l) => ({ l, m: l.text.match(colRe) ?? l.text.match(djRe) })).filter((x) => x.m);
  for (const r of remC) {
    const a = addC.find((x) => x.m![1] === r.m![1]);
    const django = /Field|ForeignKey/.test(r.m![2]);
    const rule = django ? "orm.django" : "orm.sqlalchemy";
    if (!a) {
      out.push(mk("data", path, rule, "high", `Removes model column ${r.m![1]}`, "The ORM stops reading/writing it; the column (and its data) usually get dropped by the next migration.", r.l));
      continue;
    }
    const was = r.m![3];
    const now = a.m![3];
    if (django ? /null\s*=\s*True/.test(was) && !/null\s*=\s*True/.test(now) && !/default\s*=/.test(now) : !/nullable\s*=\s*False/.test(was) && /nullable\s*=\s*False/.test(now) && !/(server_)?default\s*=/.test(now))
      out.push(mk("data", path, rule, "medium", `${r.m![1]} becomes NOT NULL`, "Existing NULL rows fail the migration; writers that omit it start failing.", a.l));
    const dbc = (s: string) => s.match(/(?:db_column|name)\s*=\s*["'](\w+)["']/)?.[1];
    if (dbc(was) !== dbc(now) && (dbc(was) || dbc(now))) out.push(mk("data", path, rule, "high", `${r.m![1]} maps to a different column`, `${dbc(was) ?? r.m![1]} → ${dbc(now) ?? a.m![1]}: existing data stays under the old name.`, a.l));
  }
  for (const r of removed(hunks)) {
    const m = r.text.match(/^\s*(__tablename__\s*=|db_table\s*=)\s*["'](\w+)["']/);
    if (!m) continue;
    const a = added(hunks).find((l) => l.text.includes(m[1].trim().split(/\s/)[0]));
    const nm = a?.text.match(/["'](\w+)["']/)?.[1];
    if (nm && nm !== m[2]) out.push(mk("data", path, "orm.sqlalchemy", "high", `Model table ${m[2]} → ${nm}`, "The ORM now reads a different table; existing rows stay in the old one.", a!));
  }
  // Pydantic models: removed fields
  if (/\bBaseModel\b/.test(headText) || hunks.some((h) => h.lines.some((l) => /\bBaseModel\b/.test(l.text)))) {
    const field = /^\s{4}(\w+)\s*:\s*[^=()]+?(\s*=.*)?$/;
    const addNames = new Set(added(hunks).map((l) => l.text.match(field)?.[1]).filter(Boolean));
    for (const r of removed(hunks)) {
      const m = r.text.match(field);
      if (m && !addNames.has(m[1]) && !/^(model_config|Config)$/.test(m[1])) out.push(mk("api", path, "orm.pydantic", "medium", `Removes model field ${m[1]}`, "Request/response shape changes; clients sending or reading it break.", r));
    }
  }
  return out;
}

/* ---------------- JS / TS ---------------- */

export function jsExportNames(lines: HLine[]): { name: string; line: HLine; params?: string }[] {
  const out: { name: string; line: HLine; params?: string }[] = [];
  for (const l of lines) {
    const m = l.text.match(/^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)(.*)$/) ?? l.text.match(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=(.*)$/);
    if (m) out.push({ name: m[1], line: l, params: m[2]?.match(/^\s*(?:<[^>]*>)?\s*\(([^)]*)\)/)?.[1] });
  }
  return out;
}

export function jsRules(f: PRFile, hunks: Hunk[], allNewExports: Set<string>, dataLayer: boolean, shared: boolean): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added") return out;
  const rem = jsExportNames(removed(hunks));
  const add = jsExportNames(added(hunks));
  const ts = /\.(tsx?|mts|cts|vue)$/.test(path);
  for (const r of rem) {
    const a = add.find((x) => x.name === r.name);
    if (a) {
      if (r.params !== undefined && a.params !== undefined && r.params.replace(/\s+/g, "") !== a.params.replace(/\s+/g, "") && (dataLayer || shared)) {
        const req = (p: string) => splitTop(p).filter((x) => !/[?=]/.test(x.split(":")[0]) && !x.includes("=") && !x.startsWith("...")).length;
        if (req(a.params) > req(r.params) || splitTop(a.params).length < splitTop(r.params).length)
          out.push(mk("data", path, "dal.sig-changed", ts && !shared ? "medium" : shared ? "high" : "medium", `Exported ${r.name}() parameters changed`, ts ? "TypeScript callers in this repo fail to compile; plain JS callers and other packages fail at runtime." : "JavaScript callers fail at runtime, not at build.", a.line, { excerpt: `(${trimEx(r.params, 60)}) → (${trimEx(a.params, 60)})` }));
      }
      continue;
    }
    if (allNewExports.has(r.name)) continue; // moved
    out.push(mk("api", path, "api.export", shared ? "high" : ts ? "low" : "medium", `Removes export ${r.name}`, shared ? "Other packages importing it break; they aren't in this PR." : ts ? "TypeScript importers in this repo fail to compile." : "Importers fail at runtime.", r.line));
  }
  // Prisma/TypeORM/Sequelize/Mongoose
  const all = hunks.flatMap((h) => h.lines).map((l) => l.text).join("\n");
  if (/@Entity\(|from\s+["']typeorm["']/.test(all)) {
    const prop = /^\s*(?:@\w+\([^)]*\)\s*)*(\w+)[!?]?\s*:\s*[\w<>[\]|. ]+;\s*$/;
    const addN = new Set(added(hunks).map((l) => l.text.match(prop)?.[1]).filter(Boolean));
    hunks.forEach((h) =>
      h.lines.forEach((l, i) => {
        if (l.kind !== "-") return;
        const m = l.text.match(prop);
        const dec = h.lines.slice(Math.max(0, i - 3), i).some((x) => /@(Column|PrimaryColumn|PrimaryGeneratedColumn|ManyToOne|OneToMany|JoinColumn)\b/.test(x.text));
        if (m && dec && !addN.has(m[1])) out.push(mk("data", path, "orm.typeorm", "high", `Removes entity column ${m[1]}`, "The ORM stops mapping it; synchronize or the next migration drops it.", l));
      }),
    );
  }
  if (/\bsequelize\b|DataTypes\./i.test(all) || /new\s+(mongoose\.)?Schema\(|mongoose\.model\(/.test(all)) {
    const mongoose = /Schema\(|mongoose/.test(all);
    for (const l of added(hunks)) {
      if (/allowNull\s*:\s*false/.test(l.text)) out.push(mk("data", path, "orm.sequelize", "medium", "Field becomes required (allowNull: false)", "Existing NULL rows and writers that omit it fail.", l));
      if (mongoose && /required\s*:\s*true/.test(l.text)) out.push(mk("data", path, "orm.mongoose", "medium", "Field becomes required", "Existing documents without it fail validation on save.", l));
      if (/unique\s*:\s*true/.test(l.text)) out.push(mk("data", path, mongoose ? "orm.mongoose" : "orm.sequelize", "medium", "Adds a unique index", "Fails to build if duplicates exist; inserts relying on duplicates fail.", l));
    }
    const field = /^\s*(\w+)\s*:\s*(\{|String|Number|Boolean|Date|\[|Schema\.Types|mongoose\.Schema\.Types|DataTypes\.)/;
    const addN = new Set(added(hunks).map((l) => l.text.match(field)?.[1]).filter(Boolean));
    for (const l of removed(hunks)) {
      const m = l.text.match(field);
      if (m && !addN.has(m[1]) && !/^(type|default|required|unique|ref|index|enum|validate|allowNull|defaultValue|references|primaryKey|autoIncrement)$/.test(m[1]))
        out.push(mk("data", path, mongoose ? "orm.mongoose" : "orm.sequelize", mongoose ? "medium" : "high", `Removes model field ${m[1]}`, mongoose ? "Existing documents keep it, but the app stops reading and writing it." : "The column stops being mapped; a later migration may drop it.", l));
    }
  }
  return out;
}

/* ---------------- contract files ---------------- */

export function prismaRules(f: PRFile, hunks: Hunk[]): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added") return out;
  const fields = (lines: HLine[], section: string) => {
    const res: { model: string; name: string; type: string; attrs: string; line: HLine }[] = [];
    let model = section.match(/^model\s+(\w+)/)?.[1] ?? "";
    for (const l of lines) {
      const o = l.text.match(/^(model|type|view)\s+(\w+)\s*\{/);
      if (o) {
        model = o[2];
        continue;
      }
      if (/^\}/.test(l.text)) {
        model = "";
        continue;
      }
      const m = l.text.match(/^\s+(\w+)\s+(\w+(?:\[\])?\??)\s*(.*)$/);
      if (model && m && !l.text.trim().startsWith("@@") && !l.text.trim().startsWith("//")) res.push({ model, name: m[1], type: m[2], attrs: m[3], line: l });
    }
    return res;
  };
  const o = hunks.flatMap((h) => fields(oldSide(h), h.section).filter((x) => x.line.kind === "-"));
  const n = hunks.flatMap((h) => fields(newSide(h), h.section));
  for (const r of o) {
    const a = n.find((x) => x.model === r.model && x.name === r.name);
    if (!a) {
      out.push(mk("data", path, "orm.prisma", "high", `Removes ${r.model}.${r.name}`, "Prisma migrate drops the column and its data.", r.line));
      continue;
    }
    if (r.type.endsWith("?") && !a.type.endsWith("?")) out.push(mk("data", path, "orm.prisma", "high", `${r.model}.${r.name} becomes required`, "Fails on existing NULL rows; writers that omit it fail.", a.line));
    else if (r.type.replace("?", "") !== a.type.replace("?", "")) out.push(mk("data", path, "orm.prisma", "high", `${r.model}.${r.name}: ${r.type} → ${a.type}`, "Changes the column type; existing data may not convert.", a.line));
    const map = (s: string) => s.match(/@map\(\s*"([^"]+)"/)?.[1];
    if (map(r.attrs) !== map(a.attrs)) out.push(mk("data", path, "orm.prisma", "high", `${r.model}.${r.name} maps to a different column`, "Existing data stays under the old column name.", a.line));
    if (!/@unique/.test(r.attrs) && /@unique/.test(a.attrs)) out.push(mk("data", path, "orm.prisma", "medium", `${r.model}.${r.name} becomes unique`, "Fails if duplicates exist.", a.line));
  }
  for (const l of removed(hunks)) {
    const m = l.text.match(/@@map\(\s*"([^"]+)"/);
    if (m && !added(hunks).some((a) => a.text.includes(`@@map("${m[1]}")`))) out.push(mk("data", path, "orm.prisma", "high", `Model table mapping changes from ${m[1]}`, "Prisma reads a different table; existing rows stay in the old one.", l));
  }
  return out;
}

export function protoRules(f: PRFile, hunks: Hunk[]): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added") return out;
  const fieldRe = /^\s*(?:repeated\s+|optional\s+|required\s+)?([\w.<>, ]+?)\s+(\w+)\s*=\s*(\d+)/;
  const ctx = (lines: HLine[], section: string) => {
    let msg = section.match(/^(?:message|enum)\s+(\w+)/)?.[1] ?? "";
    return lines.map((l) => {
      const o = l.text.match(/^\s*(message|enum)\s+(\w+)\s*\{/);
      if (o) msg = o[2];
      const m = l.text.match(fieldRe);
      return m && !/^\s*(option|reserved|rpc)\b/.test(l.text) ? { msg, type: m[1].trim(), name: m[2], num: m[3], line: l } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);
  };
  const o = hunks.flatMap((h) => ctx(oldSide(h), h.section).filter((x) => x.line.kind === "-"));
  const n = hunks.flatMap((h) => ctx(newSide(h), h.section));
  const reserved = added(hunks).filter((l) => /^\s*reserved\b/.test(l.text)).map((l) => l.text).join(" ");
  for (const r of o) {
    const byNum = n.find((x) => x.msg === r.msg && x.num === r.num);
    const byName = n.find((x) => x.msg === r.msg && x.name === r.name);
    if (byNum && byNum.name === r.name && byNum.type !== r.type) out.push(mk("api", path, "api.proto", "high", `${r.msg}.${r.name}: type ${r.type} → ${byNum.type}`, "Old clients decode it wrongly; field types can't change on the wire.", byNum.line));
    else if (byName && byName.num !== r.num) out.push(mk("api", path, "api.proto", "high", `${r.msg}.${r.name}: field number ${r.num} → ${byName.num}`, "The field number is the wire identity; old and new clients stop agreeing.", byName.line));
    else if (!byName && !byNum) {
      const res = new RegExp(String.raw`\b${r.num}\b|"${r.name}"`).test(reserved);
      out.push(mk("api", path, "api.proto", res ? "medium" : "high", `Removes ${r.msg}.${r.name} (= ${r.num})`, res ? "Reserved, so the number can't be reused; old clients still send it and it's ignored." : "Not reserved: the number can be reused later and old clients will mis-decode it.", r.line));
    } else if (byNum && byNum.name !== r.name) out.push(mk("api", path, "api.proto", "medium", `Renames ${r.msg}.${r.name} → ${byNum.name}`, "Binary-compatible, but JSON and generated code names change.", byNum.line));
  }
  for (const l of removed(hunks)) {
    const m = l.text.match(/^\s*rpc\s+(\w+)/);
    if (m && !added(hunks).some((a) => new RegExp(String.raw`^\s*rpc\s+${m[1]}\b`).test(a.text))) out.push(mk("api", path, "api.proto", "high", `Removes rpc ${m[1]}`, "Clients calling it get UNIMPLEMENTED.", l));
  }
  return out;
}

export function graphqlRules(f: PRFile, hunks: Hunk[]): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added") return out;
  const scan = (lines: HLine[], section: string) => {
    let type = section.match(/^(?:extend\s+)?(?:type|input|interface|enum)\s+(\w+)/)?.[1] ?? "";
    let input = /^\s*input\b/.test(section);
    return lines.map((l) => {
      const o = l.text.match(/^\s*(?:extend\s+)?(type|input|interface|enum)\s+(\w+)/);
      if (o) {
        type = o[2];
        input = o[1] === "input";
        return null;
      }
      const m = l.text.match(/^\s+(\w+)\s*(\([^)]*\))?\s*:\s*([\w[\]!]+)/);
      return m && type ? { type, input, name: m[1], ty: m[3], line: l } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);
  };
  const o = hunks.flatMap((h) => scan(oldSide(h), h.section).filter((x) => x.line.kind === "-"));
  const n = hunks.flatMap((h) => scan(newSide(h), h.section));
  for (const r of o) {
    const a = n.find((x) => x.type === r.type && x.name === r.name);
    if (!a) out.push(mk("api", path, "api.graphql", "high", `Removes ${r.type}.${r.name}`, "Queries selecting it fail validation.", r.line));
    else if (a.ty !== r.ty) {
      const stricter = !r.ty.endsWith("!") && a.ty.endsWith("!");
      out.push(mk("api", path, "api.graphql", r.input && stricter ? "high" : stricter ? "low" : "medium", `${r.type}.${r.name}: ${r.ty} → ${a.ty}`, r.input && stricter ? "Clients that omit it now get validation errors." : "Clients relying on the old type may break.", a.line));
    }
  }
  return out;
}

export function openapiRules(f: PRFile, hunks: Hunk[], headText: string): Finding[] {
  const path = f.filename;
  const out: Finding[] = [];
  if (f.status === "added" || !/^\s*["']?(openapi|swagger)["']?\s*:/m.test(headText + "\n" + hunks.flatMap((h) => h.lines).map((l) => l.text).join("\n"))) return out;
  const rem = hunks.flatMap((h) => changedKeys(path, oldSide(h), "-"));
  const add = new Set(hunks.flatMap((h) => changedKeys(path, newSide(h), "+")).map((k) => k.key));
  for (const r of rem) {
    if (add.has(r.key)) continue;
    const parts = r.key.split(".");
    const pi = parts.indexOf("paths");
    if (pi >= 0 && (parts.length === pi + 2 || (parts.length === pi + 3 && /^(get|post|put|patch|delete|head|options)$/.test(parts[pi + 2]))))
      out.push(mk("api", path, "api.openapi", "high", `Removes ${parts.length === pi + 2 ? "path" : "operation"} ${parts.slice(pi + 1).join(" ")}`, "Clients generated from this spec call something that no longer exists.", r.line));
    else if (parts.includes("properties") && parts[parts.length - 2] === "properties")
      out.push(mk("api", path, "api.openapi", "high", `Removes property ${parts.slice(-3).join(".").replace(".properties.", ".")}`, "Clients reading or sending it break.", r.line));
  }
  // newly required fields: list items added under a `required:` key
  hunks.forEach((h) => {
    let inReq = false;
    for (const l of newSide(h)) {
      if (/^\s*required\s*:\s*$/.test(l.text)) inReq = true;
      else if (!/^\s*-\s/.test(l.text)) inReq = false;
      else if (inReq && l.kind === "+") out.push(mk("api", path, "api.openapi", "high", `Makes ${l.text.replace(/^\s*-\s*/, "").trim()} required`, "Clients that don't send it now get 400s.", l));
    }
  });
  return out;
}

export function packageExportsRule(f: PRFile, hunks: Hunk[], shared: boolean): Finding[] {
  if (!/(^|\/)package\.json$/.test(f.filename) || f.status === "added") return [];
  const out: Finding[] = [];
  const keys = (ls: HLine[]) => ls.map((l) => ({ l, m: l.text.match(/^\s{2}"(main|module|types|typings|exports|bin)"\s*:\s*(.*?),?\s*$/) })).filter((x) => x.m);
  const rem = keys(removed(hunks));
  const add = keys(added(hunks));
  for (const r of rem) {
    const a = add.find((x) => x.m![1] === r.m![1]);
    if (a && a.m![2] === r.m![2]) continue;
    out.push(mk("api", f.filename, "api.export", shared ? "high" : "medium", `${a ? "Changes" : "Removes"} package.json "${r.m![1]}"`, "Changes what importers of this package resolve.", (a ?? r).l));
  }
  return out;
}
