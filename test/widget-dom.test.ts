// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { type: string; [k: string]: unknown }[] = [];
let stored: unknown = null;
const replies: Record<string, (m: any) => unknown> = {
  "auth:status": () => ({ method: "pat", login: "yash" }),
  "widget:getPosition": () => stored,
  "widget:setPosition": (m) => ((stored = m.position), true),
  "reviewed:get": () => ({}),
  "reviewed:set": () => true,
  analyze: () => ({
    pr: { owner: "o", repo: "r", number: 7 },
    meta: { title: "Big change", headSha: "abcdef1234", baseSha: "b", changedFiles: 2, additions: 3, deletions: 1, htmlUrl: "", state: "open" },
    fromCache: false,
    plan: {
      version: 1, engineVersion: "t", warnings: [], stats: { files: 2, additions: 3, deletions: 1, edges: 1, contentsUsed: 0 },
      layers: [{ id: "core", index: 0, title: "Core", description: "d", stats: { files: 1, additions: 2, deletions: 0 }, files: [{ path: "src/a.ts", status: "added", additions: 2, deletions: 0, category: "source", reason: "used by b" }] }],
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
    expect(s.querySelector(".ltitle")?.textContent).toBe("Core");
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
});
