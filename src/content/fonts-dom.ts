/** Inject the bundled code fonts and the optional GitHub-diff stylesheet. */
import { diffCss, fontFaceCss, type FontPrefs } from "../shared/fonts";

export const FACES_ID = "codesloth-font-faces";
export const DIFF_ID = "codesloth-diff-font";

/**
 * @font-face is declared at document level, not inside the shadow root: Chrome doesn't reliably register
 * @font-face rules that live in a shadow tree, while document-level faces are usable from shadow content.
 * Family names are prefixed ("CodeSloth …"), so nothing on GitHub picks them up by accident.
 */
export function ensureFontFaces(doc: Document, url: (p: string) => string): void {
  if (doc.getElementById(FACES_ID)) return;
  const st = doc.createElement("style");
  st.id = FACES_ID;
  st.textContent = fontFaceCss(url);
  (doc.head ?? doc.documentElement).append(st);
}

/** Apply (or remove) the code font on GitHub's diff lines. Best effort, scoped to diff cells. */
export function applyDiffFont(doc: Document, p: FontPrefs | null): void {
  const css = p ? diffCss(p) : "";
  let st = doc.getElementById(DIFF_ID) as HTMLStyleElement | null;
  if (!css) {
    st?.remove();
    return;
  }
  if (!st) {
    st = doc.createElement("style");
    st.id = DIFF_ID;
    (doc.head ?? doc.documentElement).append(st);
  }
  if (st.textContent !== css) st.textContent = css;
}
