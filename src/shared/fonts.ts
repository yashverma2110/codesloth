/**
 * Code font settings: bundled OFL fonts (public/fonts, WOFF2, 400 + 600, Latin), never loaded from the network.
 * Pure helpers (CSS strings, normalization) so they can be unit-tested; DOM injection lives in content/fonts-dom.ts.
 */
export type CodeFont = "default" | "jetbrains" | "fira" | "iosevka";
export type FontSize = "small" | "default" | "large";

export interface FontPrefs {
  codeFont: CodeFont;
  fontSize: FontSize;
  /** null = the font's default (on for JetBrains Mono and Fira Code). */
  ligatures: boolean | null;
  /** Also use the code font in GitHub's diff lines (best effort). Default off. */
  diffFont: boolean;
}

export const DEFAULT_FONT_PREFS: FontPrefs = { codeFont: "default", fontSize: "default", ligatures: null, diffFont: false };

export const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface FontInfo {
  label: string;
  /** Family name registered by CodeSloth (prefixed, so it never clashes with fonts the page or OS has). */
  family: string | null;
  dir: string | null;
  ligaturesByDefault: boolean;
}

export const FONTS: Record<CodeFont, FontInfo> = {
  default: { label: "GitHub default", family: null, dir: null, ligaturesByDefault: false },
  jetbrains: { label: "JetBrains Mono", family: "CodeSloth JetBrains Mono", dir: "jetbrains-mono", ligaturesByDefault: true },
  fira: { label: "Fira Code", family: "CodeSloth Fira Code", dir: "fira-code", ligaturesByDefault: true },
  iosevka: { label: "Iosevka", family: "CodeSloth Iosevka", dir: "iosevka", ligaturesByDefault: false },
};
export const FONT_ORDER: CodeFont[] = ["default", "jetbrains", "fira", "iosevka"];
export const SIZE_ORDER: FontSize[] = ["small", "default", "large"];
export const SIZE_LABEL: Record<FontSize, string> = { small: "Small", default: "Default", large: "Large" };
/** Scale applied to the panel's Review content and header. */
export const SIZE_ZOOM: Record<FontSize, number> = { small: 0.92, default: 1, large: 1.12 };

/** Preference keys (stored as `pref.<key>` in chrome.storage.local). */
export const FONT_PREF_KEYS = ["codeFont", "fontSize", "ligatures", "diffFont"] as const;

export function normalizeFontPrefs(raw: Partial<Record<(typeof FONT_PREF_KEYS)[number], unknown>>): FontPrefs {
  const f = raw.codeFont as CodeFont;
  const s = raw.fontSize as FontSize;
  return {
    codeFont: FONT_ORDER.includes(f) ? f : "default",
    fontSize: SIZE_ORDER.includes(s) ? s : "default",
    ligatures: typeof raw.ligatures === "boolean" ? raw.ligatures : null,
    diffFont: raw.diffFont === true,
  };
}

export function fontStack(font: CodeFont): string {
  const fam = FONTS[font].family;
  return fam ? `"${fam}", ${SYSTEM_MONO}` : SYSTEM_MONO;
}

export function ligaturesOn(p: FontPrefs): boolean {
  return p.ligatures ?? FONTS[p.codeFont].ligaturesByDefault;
}

/** @font-face rules for every bundled font (declared once at document level; shadow roots inherit them). */
export function fontFaceCss(url: (path: string) => string): string {
  const out: string[] = [];
  for (const k of FONT_ORDER) {
    const f = FONTS[k];
    if (!f.family || !f.dir) continue;
    for (const w of [400, 600])
      out.push(`@font-face{font-family:"${f.family}";font-style:normal;font-weight:${w};font-display:swap;src:url("${url(`fonts/${f.dir}/${f.dir}-${w}.woff2`)}") format("woff2");}`);
  }
  return out.join("\n");
}

/** CSS custom properties for the panel / graph. */
export function fontVars(p: FontPrefs): Record<string, string> {
  return { "--cs-mono": fontStack(p.codeFont), "--cs-lig": ligaturesOn(p) ? "normal" : "none", "--cs-zoom": String(SIZE_ZOOM[p.fontSize]) };
}

/** GitHub's diff code cells (classic + React Files changed). Best effort: these are GitHub's selectors, not ours. */
export const DIFF_SELECTORS = [
  ".blob-code",
  ".blob-code-inner",
  ".blob-num",
  "td.diff-text-cell",
  ".diff-text-inner",
  ".react-code-text",
  ".react-file-line",
  'table[data-diff-anchor] td code',
  'table[class*="DiffLines"] code',
];

/** Stylesheet for GitHub's diffs, or "" when off / default font. Scoped to diff cells only. */
export function diffCss(p: FontPrefs): string {
  if (!p.diffFont || p.codeFont === "default") return "";
  const sel = DIFF_SELECTORS.join(",\n");
  return `${sel} {\n  font-family: ${fontStack(p.codeFont)} !important;\n  font-variant-ligatures: ${ligaturesOn(p) ? "normal" : "none"} !important;\n  font-feature-settings: ${ligaturesOn(p) ? '"calt" 1' : '"calt" 0, "liga" 0'} !important;\n}`;
}
