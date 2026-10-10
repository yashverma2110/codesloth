/** Remove JS/TS comments while preserving string and template literal contents. */
export function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (q !== "`" && src[i] === "\n") break; // unterminated, bail
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const STATIC_RE = /(?:^|[^.\w$])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g;
const CALL_RE =
  /(?:^|[^.\w$])(?:import|require|require\.resolve|jest\.mock|jest\.requireActual|vi\.mock|vi\.importActual|vi\.doMock|jest\.doMock)\s*\(\s*["']([^"'\n]+)["']\s*[,)]/g;

/** Replace the contents of string/template literals with "x" (same length) so code inside strings can't match. */
export function maskStrings(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < code.length && code[i] !== c && !(c !== "`" && code[i] === "\n")) {
        if (code[i] === "\\") {
          out += "xx";
          i += 2;
          continue;
        }
        out += code[i] === "\n" ? "\n" : "x";
        i++;
      }
      if (i < code.length) out += code[i++];
      continue;
    }
    out += c;
    i++;
  }
  return out.slice(0, code.length);
}

/** Extract import specifiers from JS/TS/JSX/TSX/Node (ESM + CommonJS + dynamic + test mocks). */
export function extractJsImports(src: string): string[] {
  const code = stripJsComments(src);
  const masked = maskStrings(code);
  const out = new Set<string>();
  for (const re of [STATIC_RE, CALL_RE]) {
    for (const m of masked.matchAll(re)) {
      // The specifier is the last quoted run in the match; read it from the unmasked code at the same offset.
      const end = m.index! + m[0].lastIndexOf(m[1]) ;
      out.add(code.slice(end, end + m[1].length));
    }
  }
  return [...out];
}
