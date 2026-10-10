/** Remove Go comments (keeps string literals intact; raw strings with backticks handled). */
function stripGoComments(src: string): string {
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
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (q === '"' && src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) out += src[i++];
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Extract import paths from a Go file: single imports and grouped `import ( ... )` blocks, with aliases, `_` and `.`. */
export function extractGoImports(src: string): string[] {
  const code = stripGoComments(src);
  const out = new Set<string>();
  const block = /\bimport\s*\(([\s\S]*?)\)/g;
  for (const m of code.matchAll(block)) {
    for (const line of m[1].split("\n")) {
      const lm = /^\s*(?:[\w.]+\s+)?["`]([^"`]+)["`]/.exec(line);
      if (lm) out.add(lm[1]);
    }
  }
  const single = /\bimport\s+(?:[\w.]+\s+)?["`]([^"`]+)["`]/g;
  for (const m of code.matchAll(single)) out.add(m[1]);
  return [...out];
}

/** Package name from `package foo`. */
export function goPackageName(src: string): string | undefined {
  return /^\s*package\s+(\w+)/m.exec(stripGoComments(src))?.[1];
}

/** Top-level identifiers declared in Go source (funcs without receivers, types, vars, consts). */
export function goTopLevelDecls(src: string): string[] {
  const code = stripGoComments(src);
  const out = new Set<string>();
  for (const m of code.matchAll(/^func\s+([A-Za-z_]\w*)\s*[\[(]/gm)) out.add(m[1]);
  for (const m of code.matchAll(/^type\s+([A-Za-z_]\w*)\b/gm)) out.add(m[1]);
  for (const m of code.matchAll(/^(?:var|const)\s+([A-Za-z_]\w*)\b/gm)) out.add(m[1]);
  // grouped type/var/const blocks
  for (const m of code.matchAll(/^(?:type|var|const)\s*\(([\s\S]*?)^\)/gm)) {
    for (const lm of m[1].matchAll(/^\s*([A-Za-z_]\w*)\b/gm)) out.add(lm[1]);
  }
  out.delete("_");
  return [...out];
}

export { stripGoComments };
