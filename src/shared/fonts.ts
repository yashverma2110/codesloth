/**
 * Code font settings: bundled OFL fonts (public/fonts, WOFF2, 400 + 600, Latin), never loaded from the network.
 * Pure helpers (CSS strings, normalization) so they can be unit-tested; DOM injection lives in content/fonts-dom.ts.
 */
export type CodeFont = "default" | "jetbrains" | "fira" | "iosevka" | "opendyslexic";
export type FontSize = "small" | "default" | "large";

export interface FontPrefs {
  codeFont: CodeFont;
  fontSize: FontSize;
  /** null = the font's default (on for JetBrains Mono and Fira Code). */
  ligatures: boolean | null;
  /** Also use the code font in GitHub's diff lines (best effort). Default off. */
  diffFont: boolean;
  /** Use the font for all panel text (headings, why-lines, reasons), not just code. Default off. */
  uiFont: boolean;
}

export const DEFAULT_FONT_PREFS: FontPrefs = { codeFont: "default", fontSize: "default", ligatures: null, diffFont: false, uiFont: false };

export const SYSTEM_UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
export const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export interface FontFace {
  family: string;
  weight: number;
  /** Path under the extension root. */
  file: string;
}

export interface FontInfo {
  label: string;
  /** Family name registered by CodeSloth (prefixed, so it never clashes with fonts the page or OS has). */
  family: string | null;
  /** Family for "Use for all panel text" when the font has a separate proportional cut (OpenDyslexic). */
  uiFamily?: string;
  dir: string | null;
  /** The font has ligature/contextual-alternate features worth toggling. */
  hasLigatures: boolean;
  ligaturesByDefault: boolean;
  faces: FontFace[];
}

const pair = (family: string, dir: string): FontFace[] => [400, 600].map((weight) => ({ family, weight, file: `fonts/${dir}/${dir}-${weight}.woff2` }));

export const FONTS: Record<CodeFont, FontInfo> = {
  default: { label: "GitHub default", family: null, dir: null, hasLigatures: false, ligaturesByDefault: false, faces: [] },
  jetbrains: { label: "JetBrains Mono", family: "CodeSloth JetBrains Mono", dir: "jetbrains-mono", hasLigatures: true, ligaturesByDefault: true, faces: pair("CodeSloth JetBrains Mono", "jetbrains-mono") },
  fira: { label: "Fira Code", family: "CodeSloth Fira Code", dir: "fira-code", hasLigatures: true, ligaturesByDefault: true, faces: pair("CodeSloth Fira Code", "fira-code") },
  iosevka: { label: "Iosevka", family: "CodeSloth Iosevka", dir: "iosevka", hasLigatures: true, ligaturesByDefault: false, faces: pair("CodeSloth Iosevka", "iosevka") },
  // OpenDyslexic Mono for code (only a Regular exists; bold is synthesized), proportional OpenDyslexic Regular + Bold
  // for "Use for all panel text". No ligatures. Files are not subset: OpenDyslexic has a Reserved Font Name.
  opendyslexic: {
    label: "OpenDyslexic",
    family: "CodeSloth OpenDyslexic Mono",
    uiFamily: "CodeSloth OpenDyslexic",
    dir: "opendyslexic",
    hasLigatures: false,
    ligaturesByDefault: false,
    faces: [
      { family: "CodeSloth OpenDyslexic Mono", weight: 400, file: "fonts/opendyslexic/opendyslexic-mono-400.woff2" },
      { family: "CodeSloth OpenDyslexic", weight: 400, file: "fonts/opendyslexic/opendyslexic-400.woff2" },
      { family: "CodeSloth OpenDyslexic", weight: 700, file: "fonts/opendyslexic/opendyslexic-700.woff2" },
    ],
  },
};
export const FONT_ORDER: CodeFont[] = ["default", "jetbrains", "fira", "iosevka", "opendyslexic"];
export const SIZE_ORDER: FontSize[] = ["small", "default", "large"];
export const SIZE_LABEL: Record<FontSize, string> = { small: "Small", default: "Default", large: "Large" };
/** Scale applied to the panel's Review content and header. */
export const SIZE_ZOOM: Record<FontSize, number> = { small: 0.92, default: 1, large: 1.12 };

/** Preference keys (stored as `pref.<key>` in chrome.storage.local). */
export const FONT_PREF_KEYS = ["codeFont", "fontSize", "ligatures", "diffFont", "uiFont"] as const;

export function normalizeFontPrefs(raw: Partial<Record<(typeof FONT_PREF_KEYS)[number], unknown>>): FontPrefs {
  const f = raw.codeFont as CodeFont;
  const s = raw.fontSize as FontSize;
  return {
    codeFont: FONT_ORDER.includes(f) ? f : "default",
    fontSize: SIZE_ORDER.includes(s) ? s : "default",
    ligatures: typeof raw.ligatures === "boolean" ? raw.ligatures : null,
    diffFont: raw.diffFont === true,
    uiFont: raw.uiFont === true,
  };
}

export function fontStack(font: CodeFont): string {
  const fam = FONTS[font].family;
  return fam ? `"${fam}", ${SYSTEM_MONO}` : SYSTEM_MONO;
}

export function ligaturesOn(p: FontPrefs): boolean {
  if (!FONTS[p.codeFont].hasLigatures) return false;
  return p.ligatures ?? FONTS[p.codeFont].ligaturesByDefault;
}

/** Stack for all panel text: the system UI font unless "Use for all panel text" is on with a bundled font. */
export function uiStack(p: FontPrefs): string {
  const f = FONTS[p.codeFont];
  if (!p.uiFont || !f.family) return SYSTEM_UI;
  return `"${f.uiFamily ?? f.family}", ${SYSTEM_UI}`;
}

/** @font-face rules for every bundled font (declared once at document level; shadow roots inherit them). */
export function fontFaceCss(url: (path: string) => string): string {
  const out: string[] = [];
  for (const k of FONT_ORDER)
    for (const face of FONTS[k].faces)
      out.push(`@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:swap;src:url("${url(face.file)}") format("woff2");}`);
  return out.join("\n");
}

/** CSS custom properties for the panel / graph. */
export function fontVars(p: FontPrefs): Record<string, string> {
  return { "--cs-mono": fontStack(p.codeFont), "--cs-ui": uiStack(p), "--cs-lig": ligaturesOn(p) ? "normal" : "none", "--cs-zoom": String(SIZE_ZOOM[p.fontSize]) };
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
