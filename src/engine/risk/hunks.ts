/** Line-numbered view of a GitHub per-file patch. */

export interface HLine {
  kind: " " | "+" | "-";
  text: string;
  /** Old-file line number (context and removed lines). */
  old?: number;
  /** New-file line number (context and added lines). */
  new?: number;
}

export interface Hunk {
  /** Text after the second @@ (GitHub puts the enclosing function/section there). */
  section: string;
  lines: HLine[];
}

export function parseHunks(patch: string | undefined): Hunk[] {
  const out: Hunk[] = [];
  if (!patch) return out;
  let cur: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const raw of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      cur = { section: m[3] ?? "", lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur || raw.startsWith("\\ No newline")) continue;
    const c = raw[0];
    const text = raw.slice(1);
    if (c === "+") cur.lines.push({ kind: "+", text, new: n++ });
    else if (c === "-") cur.lines.push({ kind: "-", text, old: o++ });
    else cur.lines.push({ kind: " ", text, old: o++, new: n++ });
  }
  return out;
}

export const added = (hs: Hunk[]) => hs.flatMap((h) => h.lines.filter((l) => l.kind === "+"));
export const removed = (hs: Hunk[]) => hs.flatMap((h) => h.lines.filter((l) => l.kind === "-"));
/** The old (base) side of each hunk: context + removed. */
export const oldSide = (h: Hunk) => h.lines.filter((l) => l.kind !== "+");
/** The new (head) side of each hunk: context + added. */
export const newSide = (h: Hunk) => h.lines.filter((l) => l.kind !== "-");

export const trimEx = (s: string, max = 140) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/** Line ref for a hunk line: added/context -> R(new), removed -> L(old). */
export function ref(l: HLine): { side: "R" | "L"; n: number } {
  return l.kind === "-" ? { side: "L", n: l.old! } : { side: "R", n: l.new! };
}
