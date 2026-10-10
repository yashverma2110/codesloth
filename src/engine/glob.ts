/** Minimal gitignore/gitattributes-style glob -> RegExp. Supports *, **, ?, leading "/", and patterns without "/" matching any basename. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  let anchored = false;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
  }
  if (p.endsWith("/")) p = p + "**";
  const hasSlash = p.includes("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "**/" or trailing "**"
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  if (!hasSlash && !anchored) return new RegExp("(?:^|/)" + re + "$");
  return new RegExp("^" + re + "(?:/.*)?$");
}

export interface GitAttributeRule {
  re: RegExp;
  pattern: string;
  generated: boolean | null; // true = linguist-generated, false = -linguist-generated / =false
  vendored: boolean | null;
}

/** Parse .gitattributes for linguist-generated / linguist-vendored. Later rules win (git semantics). */
export function parseGitAttributes(text: string): GitAttributeRule[] {
  const rules: GitAttributeRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    let generated: boolean | null = null;
    let vendored: boolean | null = null;
    for (const a of attrs) {
      if (a === "linguist-generated" || a === "linguist-generated=true") generated = true;
      else if (a === "-linguist-generated" || a === "linguist-generated=false") generated = false;
      else if (a === "linguist-vendored" || a === "linguist-vendored=true") vendored = true;
      else if (a === "-linguist-vendored" || a === "linguist-vendored=false") vendored = false;
    }
    if (generated === null && vendored === null) continue;
    rules.push({ re: globToRegExp(pattern), pattern, generated, vendored });
  }
  return rules;
}

export function matchGitAttributes(
  rules: GitAttributeRule[],
  path: string,
): { generated?: GitAttributeRule; vendored?: GitAttributeRule } {
  let generated: GitAttributeRule | undefined;
  let vendored: GitAttributeRule | undefined;
  for (const r of rules) {
    if (!r.re.test(path)) continue;
    if (r.generated !== null) generated = r.generated ? r : undefined;
    if (r.vendored !== null) vendored = r.vendored ? r : undefined;
  }
  return { generated, vendored };
}
