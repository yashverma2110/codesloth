// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { findViewedControl, syncViewed } from "../src/content/viewed-sync";

const A = (c: string) => "diff-" + c.repeat(64);
const env = (over = {}) => ({ doc: document, win: window, confirmMs: 200, timeoutMs: 300, ...over });

/** Classic view: .file[data-tagsearch-path] with a "Viewed" checkbox in its header. */
function classic(path: string, anchor: string, checked = false) {
  const f = document.createElement("div");
  f.className = "file js-file";
  f.id = anchor;
  f.setAttribute("data-tagsearch-path", path);
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.name = "viewed";
  cb.checked = checked;
  label.append(cb, " Viewed");
  f.append(label);
  document.body.append(f);
  return cb;
}

/** React view: a region with the anchor id and a toggle button with aria-pressed; no stable classes. */
function react(path: string, anchor: string, pressed = false, works = true) {
  const region = document.createElement("div");
  region.setAttribute("role", "region");
  const hdr = document.createElement("div");
  hdr.id = anchor;
  const name = document.createElement("span");
  name.textContent = path;
  const btn = document.createElement("button");
  btn.setAttribute("aria-pressed", String(pressed));
  btn.setAttribute("aria-label", pressed ? "Viewed" : "Not Viewed");
  btn.textContent = "Viewed";
  if (works) btn.addEventListener("click", () => btn.setAttribute("aria-pressed", String(btn.getAttribute("aria-pressed") !== "true")));
  hdr.append(name);
  region.append(hdr, btn);
  document.body.append(region);
  return btn;
}

afterEach(() => document.body.replaceChildren());

describe("GitHub Viewed sync (DOM, best effort)", () => {
  it("finds the classic checkbox and the React toggle for the right file only", () => {
    const c1 = classic("a.ts", A("a"));
    classic("b.ts", A("b"));
    const r = react("c.ts", A("c"));
    expect(findViewedControl(document, "a.ts", A("a"))?.el).toBe(c1);
    expect(findViewedControl(document, "c.ts", A("c"))?.el).toBe(r);
    expect(findViewedControl(document, "zzz.ts", A("d"))).toBeNull();
  });

  it("checks only when not already checked, and unchecks on unmark", async () => {
    const cb = classic("a.ts", A("a"));
    let clicks = 0;
    cb.addEventListener("click", () => clicks++);
    expect(await syncViewed("a.ts", A("a"), true, env())).toBe("ok");
    expect(cb.checked).toBe(true);
    expect(await syncViewed("a.ts", A("a"), true, env())).toBe("already");
    expect(clicks).toBe(1);
    expect(await syncViewed("a.ts", A("a"), false, env())).toBe("ok");
    expect(cb.checked).toBe(false);
    const btn = react("c.ts", A("c"));
    expect(await syncViewed("c.ts", A("c"), true, env())).toBe("ok");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("waits for a virtualized file to mount, then clicks", async () => {
    const p = syncViewed("late.ts", A("e"), true, env({ timeoutMs: 1000 }));
    const btn = react("late.ts", A("e"));
    expect(await p).toBe("ok");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("reports missing after the timeout and failed when the click doesn't take; never throws", async () => {
    expect(await syncViewed("nope.ts", A("f"), true, env({ timeoutMs: 50 }))).toBe("missing");
    react("dead.ts", A("9"), false, false);
    expect(await syncViewed("dead.ts", A("9"), true, env())).toBe("failed");
  });

  it("refuses to guess when a container has several Viewed controls", () => {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-file-path", "x.ts");
    for (let i = 0; i < 2; i++) {
      const b = document.createElement("button");
      b.setAttribute("aria-pressed", "false");
      b.textContent = "Viewed";
      wrap.append(b);
    }
    document.body.append(wrap);
    expect(findViewedControl(document, "x.ts", A("0"))).toBeNull();
  });
});
