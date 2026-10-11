/** A deliberately small YAML subset parser for .codesloth.yml: nested maps, block and flow lists, flow maps, scalars. */

export type Y = string | number | boolean | null | Y[] | { [k: string]: Y };

function scalar(s: string): Y {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true" || t === "on" || t === "yes") return true;
  if (t === "false" || t === "off" || t === "no") return t === "off" ? "off" : false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t.startsWith("[") && t.endsWith("]")) return splitFlow(t.slice(1, -1)).map(scalar);
  if (t.startsWith("{") && t.endsWith("}")) {
    const o: Record<string, Y> = {};
    for (const part of splitFlow(t.slice(1, -1))) {
      const i = part.indexOf(":");
      if (i > 0) o[part.slice(0, i).trim().replace(/^["']|["']$/g, "")] = scalar(part.slice(i + 1));
    }
    return o;
  }
  return t;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let d = 0;
  let q = "";
  let cur = "";
  for (const ch of s) {
    if (q) {
      if (ch === q) q = "";
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") q = ch;
    if (ch === "[" || ch === "{") d++;
    if (ch === "]" || ch === "}") d--;
    if (ch === "," && d === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

const stripComment = (l: string) => {
  let q = "";
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i);
  }
  return l;
};

/** Parse; throws Error("line N: …") on input it doesn't understand. */
export function parseYaml(text: string): Y {
  const lines = text.split(/\r?\n/).map((raw, i) => ({ raw: stripComment(raw).replace(/\s+$/, ""), n: i + 1 })).filter((l) => l.raw.trim() && l.raw.trim() !== "---");
  let i = 0;
  const indentOf = (s: string) => s.length - s.trimStart().length;
  function block(indent: number): Y {
    if (i >= lines.length) return null;
    const first = lines[i].raw.trimStart();
    if (first.startsWith("- ") || first === "-") {
      const arr: Y[] = [];
      while (i < lines.length && indentOf(lines[i].raw) === indent && lines[i].raw.trimStart().startsWith("-")) {
        const rest = lines[i].raw.trimStart().slice(1).trim();
        i++;
        if (!rest) arr.push(block(i < lines.length ? indentOf(lines[i].raw) : indent + 2));
        else if (/^[\w.-]+\s*:(\s|$)/.test(rest) && !rest.startsWith("{")) {
          // "- key: v" map item
          const o: Record<string, Y> = {};
          const m = rest.match(/^([\w.-]+)\s*:\s*(.*)$/)!;
          o[m[1]] = m[2] ? scalar(m[2]) : block(i < lines.length ? indentOf(lines[i].raw) : indent + 4);
          while (i < lines.length && indentOf(lines[i].raw) > indent && !lines[i].raw.trimStart().startsWith("-")) {
            const mm = lines[i].raw.trim().match(/^([\w.-]+)\s*:\s*(.*)$/);
            if (!mm) throw new Error(`line ${lines[i].n}: expected "key: value"`);
            const ind = indentOf(lines[i].raw);
            i++;
            o[mm[1]] = mm[2] ? scalar(mm[2]) : block(i < lines.length ? Math.max(ind + 1, indentOf(lines[i].raw)) : ind + 2);
          }
          arr.push(o);
        } else arr.push(scalar(rest));
      }
      return arr;
    }
    const obj: Record<string, Y> = {};
    while (i < lines.length && indentOf(lines[i].raw) === indent) {
      const t = lines[i].raw.trim();
      const m = t.match(/^("[^"]+"|'[^']+'|[^:]+?)\s*:(?:\s+(.*))?$/);
      if (!m) throw new Error(`line ${lines[i].n}: expected "key: value"`);
      const key = m[1].replace(/^["']|["']$/g, "");
      i++;
      if (m[2] !== undefined && m[2] !== "") obj[key] = scalar(m[2]);
      else if (i < lines.length && indentOf(lines[i].raw) > indent) obj[key] = block(indentOf(lines[i].raw));
      else if (i < lines.length && indentOf(lines[i].raw) === indent && lines[i].raw.trimStart().startsWith("-")) obj[key] = block(indent);
      else obj[key] = null;
    }
    if (i < lines.length && indentOf(lines[i].raw) > indent) throw new Error(`line ${lines[i].n}: unexpected indentation`);
    return obj;
  }
  if (!lines.length) return null;
  const v = block(indentOf(lines[0].raw));
  if (i < lines.length) throw new Error(`line ${lines[i].n}: unexpected indentation`);
  return v;
}
