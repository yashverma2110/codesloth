import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DEFAULT_FONT_PREFS, diffCss, FONT_ORDER, fontFaceCss, FONTS, fontStack, fontVars, ligaturesOn, normalizeFontPrefs, SYSTEM_MONO, SYSTEM_UI, uiStack } from "../src/shared/fonts";
import manifest from "../public/manifest.json";

describe("code font settings", () => {
  it("defaults to the GitHub/system monospace stack with diffs untouched", () => {
    expect(normalizeFontPrefs({})).toEqual(DEFAULT_FONT_PREFS);
    expect(fontStack("default")).toBe(SYSTEM_MONO);
    expect(diffCss(DEFAULT_FONT_PREFS)).toBe("");
  });
  it("normalizes junk from storage", () => {
    expect(normalizeFontPrefs({ codeFont: "comic-sans", fontSize: 3, ligatures: "yes", diffFont: "true" })).toEqual(DEFAULT_FONT_PREFS);
    expect(normalizeFontPrefs({ codeFont: "iosevka", fontSize: "large", ligatures: false, diffFont: true, uiFont: false })).toEqual({ codeFont: "iosevka", fontSize: "large", ligatures: false, diffFont: true, uiFont: false });
  });
  it("ligatures: on by default for JetBrains Mono and Fira Code only, explicit toggle wins", () => {
    const p = (codeFont: any, ligatures: boolean | null = null) => ({ ...DEFAULT_FONT_PREFS, codeFont, ligatures });
    expect(ligaturesOn(p("jetbrains"))).toBe(true);
    expect(ligaturesOn(p("fira"))).toBe(true);
    expect(ligaturesOn(p("iosevka"))).toBe(false);
    expect(ligaturesOn(p("default"))).toBe(false);
    expect(ligaturesOn(p("fira", false))).toBe(false);
    expect(fontVars(p("fira", false))["--cs-lig"]).toBe("none");
  });
  it("prefixed family names fall back to the system stack", () => {
    expect(fontStack("jetbrains")).toBe(`"CodeSloth JetBrains Mono", ${SYSTEM_MONO}`);
    expect(fontVars({ ...DEFAULT_FONT_PREFS, fontSize: "large" })["--cs-zoom"]).toBe("1.12");
  });
  it("@font-face points only at bundled files that exist, each font folder has its OFL license", () => {
    const css = fontFaceCss((p) => `chrome-extension://x/${p}`);
    const urls = [...css.matchAll(/url\("chrome-extension:\/\/x\/([^"]+)"\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(9); // 3 fonts × 400/600 + OpenDyslexic Mono 400 + OpenDyslexic 400/700
    expect(css).not.toMatch(/https?:/);
    for (const u of urls) {
      expect(existsSync(`public/${u}`)).toBe(true);
      // Subset Latin fonts stay small; OpenDyslexic ships unsubset (Reserved Font Name), still well under 150 KB each.
      expect(statSync(`public/${u}`).size).toBeLessThan(u.includes("opendyslexic") ? 150_000 : 40_000);
    }
    for (const k of FONT_ORDER) if (FONTS[k].dir) expect(existsSync(`public/fonts/${FONTS[k].dir}/OFL.txt`)).toBe(true);
    expect(readFileSync("public/fonts/opendyslexic/OFL.txt", "utf8")).toMatch(/SIL Open Font License, Version 1\.1/);
  });
  it("OpenDyslexic: mono for code, proportional for all panel text, no ligatures", () => {
    const od = { ...DEFAULT_FONT_PREFS, codeFont: "opendyslexic" as const };
    expect(FONTS.opendyslexic.label).toBe("OpenDyslexic");
    expect(fontStack("opendyslexic")).toMatch(/^"CodeSloth OpenDyslexic Mono", /);
    expect(fontVars(od)["--cs-ui"]).toBe(SYSTEM_UI);
    expect(fontVars({ ...od, uiFont: true })["--cs-ui"]).toMatch(/^"CodeSloth OpenDyslexic", /);
    expect(ligaturesOn({ ...od, ligatures: true })).toBe(false);
    expect(FONTS.opendyslexic.hasLigatures).toBe(false);
    expect(fontFaceCss((p) => p)).toContain('font-family:"CodeSloth OpenDyslexic";font-style:normal;font-weight:700');
  });
  it("'Use for all panel text' applies the code font to UI text for any bundled font, never for GitHub default", () => {
    expect(uiStack({ ...DEFAULT_FONT_PREFS, codeFont: "jetbrains", uiFont: true })).toMatch(/^"CodeSloth JetBrains Mono", /);
    expect(uiStack({ ...DEFAULT_FONT_PREFS, codeFont: "default", uiFont: true })).toBe(SYSTEM_UI);
    expect(uiStack({ ...DEFAULT_FONT_PREFS, codeFont: "fira" })).toBe(SYSTEM_UI);
  });
  it("fonts are web-accessible to github.com only", () => {
    expect(manifest.web_accessible_resources).toEqual([{ resources: ["fonts/*/*.woff2"], matches: ["https://github.com/*"] }]);
  });
  it("diff stylesheet is scoped to diff cells and respects ligatures", () => {
    const css = diffCss({ codeFont: "fira", fontSize: "default", ligatures: null, diffFont: true, uiFont: false });
    expect(css).toMatch(/\.blob-code-inner/);
    expect(css).toMatch(/\.diff-text-inner/);
    expect(css).not.toMatch(/(^|,\s*)(body|pre|code)\s*[,{]/m);
    expect(css).toContain("font-variant-ligatures: normal");
    expect(diffCss({ codeFont: "fira", fontSize: "default", ligatures: false, diffFont: true, uiFont: false })).toContain("font-variant-ligatures: none");
    expect(diffCss({ codeFont: "fira", fontSize: "default", ligatures: null, diffFont: false, uiFont: false })).toBe("");
  });
});
