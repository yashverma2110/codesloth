export interface PyImport {
  /** Module path as written, including leading dots for relative imports, e.g. "..models.user" or "os.path". */
  module: string;
  /** Names imported via `from X import a, b` (empty for `import X`). */
  names: string[];
}

function stripPyComments(src: string): string {
  // Remove # comments outside strings (single-line strings only; good enough for import scanning).
  return src
    .split("\n")
    .map((line) => {
      let q: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === "\\") i++;
          else if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Join backslash continuations and parenthesised multi-line `from x import (...)`. */
function logicalLines(src: string): string[] {
  const lines = src.replace(/\\\r?\n/g, " ").split("\n");
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const l of lines) {
    buf += (buf ? " " : "") + l;
    for (const c of l) {
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function extractPythonImports(src: string): PyImport[] {
  const out: PyImport[] = [];
  for (const line of logicalLines(stripPyComments(src))) {
    const t = line.trim();
    let m = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(t);
    if (m) {
      const names = m[2]
        .replace(/[()]/g, " ")
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => s && s !== "*" && /^[A-Za-z_]\w*$/.test(s));
      out.push({ module: m[1], names });
      continue;
    }
    m = /^import\s+(.+)$/.exec(t);
    if (m) {
      for (const part of m[1].split(",")) {
        const mod = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_][\w.]*$/.test(mod)) out.push({ module: mod, names: [] });
      }
    }
  }
  return out;
}

/** Flatten to specifier strings ("module" or "module:name") for display/debug. */
export function pythonImportSpecifiers(src: string): string[] {
  return extractPythonImports(src).map((i) => (i.names.length ? `${i.module}:${i.names.join(",")}` : i.module));
}
