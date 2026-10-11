// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { findDiffElement, MAX_OFFSET, SCROLL_GAP, scrollToDiff, scrollTopFor, settleInitialHash, stickyOffset } from "../src/content/scroll";

const ANCHOR = "diff-" + "a".repeat(64);
const env = (over: Partial<{ reducedMotion: boolean; timeoutMs: number }> = {}) => ({ doc: document, win: window, ...over });

function rect(el: Element, top: number, height: number) {
  (el as HTMLElement).getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}
function sticky(cls: string, top: number, height: number, position = "sticky") {
  const e = document.createElement("div");
  e.className = cls;
  e.style.position = position;
  document.body.append(e);
  rect(e, top, height);
  return e;
}
function fileEl(path = "src/a.ts", withId = true) {
  const f = document.createElement("div");
  f.className = "file js-file";
  f.setAttribute("data-tagsearch-path", path);
  if (withId) f.id = ANCHOR;
  const h = document.createElement("div");
  h.className = "file-header";
  f.append(h);
  f.scrollIntoView = vi.fn();
  h.animate = vi.fn() as never;
  return { f, h };
}

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, "", "/o/r/pull/1/files");
  vi.useRealTimers();
});

describe("scroll offset", () => {
  it("scrollTopFor puts the element just below the sticky bars, never negative", () => {
    expect(scrollTopFor(500, 1000, 120)).toBe(1000 + 500 - 120 - SCROLL_GAP);
    expect(scrollTopFor(10, 0, 120)).toBe(0);
  });
  it("stickyOffset sums only bars pinned at the top, ignoring per-file sticky headers and the widget", () => {
    sticky("AppHeader", 0, 64, "fixed");
    sticky("pr-toolbar js-sticky", 0, 112);
    sticky("js-sticky", 300, 40); // not at the top
    const { f } = fileEl();
    const fh = document.createElement("div");
    fh.className = "sticky-file-header";
    fh.style.position = "sticky";
    f.append(fh);
    rect(fh, 0, 300);
    document.body.append(f);
    const host = sticky("js-sticky", 0, 500, "fixed");
    host.id = "codesloth-widget-host";
    expect(stickyOffset(env(), f)).toBe(112);
  });
  it("caps the offset", () => {
    sticky("js-sticky", 0, 380);
    expect(stickyOffset(env())).toBeLessThanOrEqual(MAX_OFFSET);
  });
});

describe("findDiffElement", () => {
  it("prefers the #diff-<sha> anchor's file container, then data attributes", () => {
    const { f } = fileEl("src/a.ts", false);
    const a = document.createElement("a");
    a.id = ANCHOR;
    f.prepend(a);
    document.body.append(f);
    expect(findDiffElement(document, "src/a.ts", ANCHOR)).toBe(f);
    a.remove();
    expect(findDiffElement(document, "src/a.ts", ANCHOR)).toBe(f);
    const r = document.createElement("div");
    r.setAttribute("data-file-path", 'we"ird.ts');
    document.body.append(r);
    expect(findDiffElement(document, 'we"ird.ts', "diff-x")).toBe(r);
  });
});

describe("scrollToDiff", () => {
  it("smooth-scrolls with a scroll-margin offset, sets the hash with replaceState, flashes the header", async () => {
    sticky("AppHeader", 0, 64, "fixed");
    const { f, h } = fileEl();
    document.body.append(f);
    let margin = "";
    (f.scrollIntoView as ReturnType<typeof vi.fn>).mockImplementation(() => (margin = f.style.scrollMarginTop));
    const rs = vi.spyOn(history, "replaceState");
    const res = await scrollToDiff("src/a.ts", ANCHOR, "https://github.com/o/r/pull/1/files", true, env({ reducedMotion: false }));
    expect(res).toBe("smooth");
    expect(f.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(margin).toBe(`${64 + SCROLL_GAP}px`);
    expect(f.style.scrollMarginTop).toBe(""); // restored
    expect(rs).toHaveBeenCalled();
    expect(location.hash).toBe(`#${ANCHOR}`);
    expect(h.animate).toHaveBeenCalledTimes(1);
    rs.mockRestore();
  });
  it("respects prefers-reduced-motion: instant scroll and no flash", async () => {
    const { f, h } = fileEl();
    document.body.append(f);
    const mm = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("reduce"), media: q }) as MediaQueryList);
    await scrollToDiff("src/a.ts", ANCHOR, "u", true, env());
    expect(f.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(h.animate).not.toHaveBeenCalled();
    mm.mockRestore();
  });
  it("falls back to the anchor when the file isn't rendered, then adjusts once it appears", async () => {
    const p = scrollToDiff("src/a.ts", ANCHOR, "u", true, env({ reducedMotion: false, timeoutMs: 2000 }));
    expect(location.hash).toBe(`#${ANCHOR}`); // GitHub's own anchor navigation renders the virtualized file
    const { f, h } = fileEl();
    document.body.append(f);
    expect(await p).toBe("fallback");
    expect(f.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(h.animate).toHaveBeenCalled();
  });
  it("gives up after the timeout, and a newer jump supersedes a pending one", async () => {
    expect(await scrollToDiff("src/x.ts", ANCHOR, "u", true, env({ timeoutMs: 30 }))).toBe("fallback-timeout");
    const first = scrollToDiff("src/x.ts", ANCHOR, "u", true, env({ timeoutMs: 500 }));
    const { f } = fileEl("src/b.ts", false);
    document.body.append(f);
    expect(await scrollToDiff("src/b.ts", "diff-" + "b".repeat(64), "u", true, env())).toBe("smooth");
    const late = fileEl("src/x.ts");
    document.body.append(late.f);
    expect(await first).toBe("superseded");
  });
  it("navigates to Files changed when on another PR tab", async () => {
    const win = { location: { href: "" } } as unknown as Window;
    expect(await scrollToDiff("src/a.ts", ANCHOR, "https://github.com/o/r/pull/1/files", false, { doc: document, win })).toBe("navigate");
    expect(win.location.href).toBe(`https://github.com/o/r/pull/1/files#${ANCHOR}`);
  });
  it("settles an initial #diff hash after load", async () => {
    history.replaceState(null, "", `/o/r/pull/1/files#${ANCHOR}`);
    const p = settleInitialHash(env({ reducedMotion: true, timeoutMs: 1000 }));
    const { f } = fileEl();
    document.body.append(f);
    expect(await p).toBe(true);
    expect(f.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });
});
