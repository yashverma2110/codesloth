import type { PRFile } from "../../../src/engine/types";

/**
 * Build a PRFile from patch lines ("+added", "-removed", " context"). One hunk unless a line is "@@" (new hunk,
 * optionally "@@ section text"). `start` sets the first old/new line numbers.
 */
export function pf(filename: string, status: PRFile["status"], lines: string[], opts: { start?: number; previous?: string } = {}): PRFile {
  const hunks: string[][] = [[]];
  const sections: string[] = [""];
  for (const l of lines) {
    if (l.startsWith("@@")) {
      hunks.push([]);
      sections.push(l.slice(2).trim());
    } else hunks[hunks.length - 1].push(l);
  }
  let o = status === "added" ? 0 : (opts.start ?? 1);
  let n = opts.start ?? 1;
  const out: string[] = [];
  let add = 0;
  let del = 0;
  hunks.forEach((h, i) => {
    if (!h.length) return;
    const oc = h.filter((l) => !l.startsWith("+")).length;
    const nc = h.filter((l) => !l.startsWith("-")).length;
    out.push(`@@ -${oc ? o : 0},${oc} +${n},${nc} @@${sections[i] ? " " + sections[i] : ""}`);
    out.push(...h);
    add += h.filter((l) => l.startsWith("+")).length;
    del += h.filter((l) => l.startsWith("-")).length;
    o += oc + 10;
    n += nc + 10;
  });
  return { filename, status, additions: add, deletions: del, changes: add + del, sha: "x" + filename.length, patch: out.join("\n"), ...(opts.previous ? { previous_filename: opts.previous } : {}) };
}

export const plus = (text: string) => text.split("\n").map((l) => "+" + l);
