// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { type: string; [k: string]: unknown }[] = [];
let stored: unknown = null;
let prefs: Record<string, unknown> = {};
const replies: Record<string, (m: any) => unknown> = {
  "auth:status": () => ({ method: "pat", login: "yash" }),
  "widget:getPosition": () => stored,
  "widget:setPosition": (m) => ((stored = m.position), true),
  "reviewed:get": () => ({}),
  "reviewed:set": () => true,
  "prefs:get": (m) => prefs[m.key] ?? null,
  "prefs:set": (m) => ((prefs[m.key] = m.value), true),
  "graph:openTab": () => true,
  analyze: () => ({
    pr: { owner: "o", repo: "r", number: 7 },
    meta: { title: "Big change", headSha: "abcdef1234", baseSha: "b", changedFiles: 2, additions: 3, deletions: 1, htmlUrl: "", state: "open" },
    fromCache: false,
    plan: {
      version: 1, engineVersion: "t", warnings: [], stats: { files: 2, additions: 3, deletions: 1, edges: 1, contentsUsed: 0 },
      layers: [{ id: "core", index: 0, title: "Review this first", label: "Core", description: "As this file is imported by 1 other changed file", stats: { files: 1, additions: 2, deletions: 0 }, files: [{ path: "src/a.ts", sha: "s1", status: "added", additions: 2, deletions: 0, category: "source", reason: "used by b" }] }],
      edges: [],
    },
  }),
};

(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(async (m: any) => {
      calls.push(m);
      return { ok: true, data: await replies[m.type]?.(m) };
    }),
  },
};
(globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} };

const { Widget, HOST_ID } = await import("../src/content/widget");

function shadowOf(): ShadowRoot {
  // The widget uses a closed shadow root; reach it through the attachShadow spy for tests.
  return (window as any).__lastShadow;
}

describe("Widget (DOM)", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
    calls.length = 0;
    stored = null;
    prefs = { tourDone: true };
    const orig = HTMLElement.prototype.attachShadow;
    HTMLElement.prototype.attachShadow = function (init) {
      const s = orig.call(this, init);
      (window as any).__lastShadow = s;
      return s;
    };
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("mounts on documentElement, toggles via bubble click, analyzes and renders layers", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    expect(document.getElementById(HOST_ID)?.parentElement).toBe(document.documentElement);
    const s = shadowOf();
    const bubble = s.querySelector(".bubble") as HTMLButtonElement;
    const panel = s.querySelector(".panel") as HTMLElement;
    expect(panel.hidden).toBe(true);
    bubble.click();
    expect(panel.hidden).toBe(false);
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    expect(calls.some((c) => c.type === "analyze")).toBe(true);
    expect(s.querySelector(".ltitle")?.textContent).toBe("Review this first Core");
    expect(s.querySelector(".lkind")?.textContent).toBe("Core");
    expect(s.querySelector(".desc")?.textContent).toBe("As this file is imported by 1 other changed file");
    bubble.click();
    expect(panel.hidden).toBe(true);
  });

  it("Esc and the close button close the panel", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    const s = shadowOf();
    const panel = s.querySelector(".panel") as HTMLElement;
    w.toggle("toolbar");
    expect(panel.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    w.toggle("shortcut");
    (s.querySelector(".x") as HTMLButtonElement).click();
    expect(panel.hidden).toBe(true);
  });

  it("a drag moves and snaps the bubble, persists the position, and is not treated as a click", async () => {
    const w = new Widget();
    await w.mount();
    const s = shadowOf();
    const bubble = s.querySelector(".bubble") as HTMLButtonElement;
    const panel = s.querySelector(".panel") as HTMLElement;
    (bubble as any).setPointerCapture = () => {};
    (bubble as any).releasePointerCapture = () => {};
    (bubble as any).hasPointerCapture = () => true;
    const ev = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
    bubble.dispatchEvent(ev("pointerdown", 1160, 750));
    bubble.dispatchEvent(ev("pointermove", 900, 600));
    bubble.dispatchEvent(ev("pointermove", 200, 300));
    bubble.dispatchEvent(ev("pointerup", 200, 300));
    bubble.click(); // the click that follows a drag must be ignored
    expect(panel.hidden).toBe(true);
    expect(stored).toMatchObject({ side: "left" });
    expect(bubble.style.left).toBe("16px");
    await new Promise((r) => setTimeout(r, 1));
    bubble.click();
    expect(panel.hidden).toBe(false);
  });

  it("shows the set-up prompt when there is no token, and never asks for the token", async () => {
    replies["auth:status"] = () => ({ method: "none" });
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelector(".setup")).not.toBeNull());
    expect(s.querySelector(".bubble")!.classList.contains("needs-setup")).toBe(true);
    (s.querySelector(".setup .btn") as HTMLButtonElement).click();
    expect(calls.some((c) => c.type === "openOnboarding")).toBe(true);
    expect(calls.some((c) => c.type === "analyze")).toBe(false);
    replies["auth:status"] = () => ({ method: "pat", login: "yash" });
  });

  it("unmount removes the host", async () => {
    const w = new Widget();
    await w.mount();
    w.unmount();
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it("has accessible tabs that switch with click and arrow keys and remember the choice", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    const list = s.querySelector('[role="tablist"]')!;
    const [review, graph] = [...s.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(review.getAttribute("aria-selected")).toBe("true");
    expect(review.getAttribute("aria-controls")).toBe("prl-pane-review");
    expect(graph.tabIndex).toBe(-1);
    graph.click();
    expect(graph.getAttribute("aria-selected")).toBe("true");
    expect((s.querySelector("#prl-pane-graph") as HTMLElement).hidden).toBe(false);
    expect((s.querySelector("#prl-pane-review") as HTMLElement).hidden).toBe(true);
    expect(prefs.view).toBe("graph");
    expect(s.querySelectorAll("#prl-pane-graph .g-node").length).toBe(1);
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(review.getAttribute("aria-selected")).toBe("true");
    expect(prefs.view).toBe("review");
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(graph.getAttribute("aria-selected")).toBe("true");
  });

  it("restores the saved view on mount", async () => {
    prefs.view = "graph";
    const w = new Widget();
    await w.mount();
    expect(shadowOf().querySelector("#prl-tab-graph")!.getAttribute("aria-selected")).toBe("true");
  });

  it("stores a per-PR snapshot when a layer is ticked", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    const cb = s.querySelector("details.layer input[type=checkbox]") as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    const set = calls.find((c) => c.type === "reviewed:set") as any;
    expect(set.key).toBe("o/r#7");
    expect(set.value.core.files).toEqual({ "src/a.ts": "s1" });
    expect(set.value.core.headSha).toBe("abcdef1234");
  });

  it("Try demo works without a token, shows the change flag and runs the 5-step tour once", async () => {
    replies["auth:status"] = () => ({ method: "none" });
    prefs = {};
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelector(".setup")).not.toBeNull());
    const demoBtn = [...s.querySelectorAll(".setup .btn")].find((b) => b.textContent === "Try demo") as HTMLButtonElement;
    demoBtn.click();
    expect(s.querySelector(".banner")!.textContent).toContain("fastapi/fastapi#16403");
    expect(s.querySelectorAll("details.layer").length).toBeGreaterThan(3);
    expect(s.querySelector('[data-tour="changed"]')).not.toBeNull();
    expect(s.querySelector("li.file.chg .badge")?.textContent).toBe("changed");
    await vi.waitFor(() => expect(s.querySelector(".tour-card")).not.toBeNull());
    const titles: string[] = [];
    for (let i = 0; i < 5; i++) {
      titles.push(s.querySelector(".tour-card h4")!.textContent!);
      const next = [...s.querySelectorAll(".tour-card button")].find((b) => /Next|Done/.test(b.textContent!)) as HTMLButtonElement;
      next.click();
    }
    expect(titles).toHaveLength(5);
    expect(titles[4]).toMatch(/Changed since/);
    expect(s.querySelector(".tour-card")).toBeNull();
    expect(prefs.tourDone).toBe(true);
    // ticking in demo mode is not persisted, and no GitHub analysis was requested
    const cb = s.querySelector('[data-tour="check"]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    expect(calls.some((c) => c.type === "reviewed:set")).toBe(false);
    expect(calls.some((c) => c.type === "analyze")).toBe(false);
    // '?' re-opens the tour
    (s.querySelector('.hdr .icon') as HTMLButtonElement).click();
    ([...s.querySelectorAll(".menu button")].find((b) => /tour/.test(b.textContent!)) as HTMLButtonElement).click();
    expect(s.querySelector(".tour-card")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.querySelector(".tour-card")).toBeNull();
    expect((s.querySelector(".panel") as HTMLElement).hidden).toBe(false);
    replies["auth:status"] = () => ({ method: "pat", login: "yash" });
  });

  it("Expand opens the graph overlay; Esc closes the overlay before the panel", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    (s.querySelector("#prl-tab-graph") as HTMLButtonElement).click();
    ([...s.querySelectorAll(".gv-bar button")].find((b) => /Expand/.test(b.textContent!)) as HTMLButtonElement).click();
    expect(s.querySelector(".overlay .g-node")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.querySelector(".overlay")).toBeNull();
    expect((s.querySelector(".panel") as HTMLElement).hidden).toBe(false);
    ([...s.querySelectorAll(".gv-bar button")].find((b) => /Tab/.test(b.textContent!)) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls.some((c) => c.type === "graph:openTab")).toBe(true));
  });
});
