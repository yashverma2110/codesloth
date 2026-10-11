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
    rate: { remaining: 4998, limit: 5000, reset: 0 },
    plan: {
      version: 1, engineVersion: "t", warnings: ["1 file analysed from the diff only"], stats: { files: 3, additions: 11576, deletions: 49, edges: 1, contentsUsed: 0 },
      layers: [
        { id: "core", index: 0, title: "Start with the core code", label: "Core", description: "1 other changed file imports this.", stats: { files: 1, additions: 2, deletions: 0 }, files: [{ path: "src/a.ts", sha: "s1", status: "added", additions: 2, deletions: 0, category: "source", reason: "Imported by b.ts" }] },
        { id: "caller1", index: 1, title: "Then the code that uses it", label: "Callers 1", description: "This uses the changes you just reviewed.", stats: { files: 2, additions: 1, deletions: 3 }, files: [
          { path: "src/ui/b.ts", sha: "s2", status: "modified", additions: 1, deletions: 3, category: "source", reason: "Uses a.ts" },
          { path: "src/ui/c.ts", sha: "s3", status: "removed", additions: 0, deletions: 0, category: "source", reason: "Deleted" },
        ] },
      ],
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
    expect(s.querySelector(".step.open .sh .h")?.textContent).toBe("Step 1: Start with the core code");
    expect(s.querySelector(".step.open .why")?.textContent).toBe("1 other changed file imports this.");
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
    expect(s.querySelectorAll("#prl-pane-graph .g-node").length).toBe(3);
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

  it("the step checkbox marks all its files reviewed, with their blob SHAs, per PR", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    const cb = s.querySelector(".step .tick") as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    const set = calls.find((c) => c.type === "reviewed:set") as any;
    expect(set.key).toBe("o/r#7");
    expect(set.value.v).toBe(2);
    expect(Object.keys(set.value.files)).toEqual(["src/a.ts"]);
    expect(set.value.files["src/a.ts"].sha).toBe("s1");
    expect(set.value.files["src/a.ts"].headSha).toBe("abcdef1234");
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
    expect(s.querySelectorAll(".step").length).toBeGreaterThan(3);
    expect(s.querySelector('[data-tour="changed"]')).not.toBeNull();
    expect(s.querySelector("li.file.chg .chg-ico")).not.toBeNull();
    expect(s.querySelector(".step.current.changed.open")).not.toBeNull();
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

  it("renders the checklist: progress line, numbered steps, only the current step open, no codes", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    expect(s.querySelector(".plbl")?.textContent).toBe("Step 1 of 20 of 3 files reviewed");
    expect(s.querySelector(".pbar")?.getAttribute("aria-valuenow")).toBe("0");
    expect([...s.querySelectorAll(".num")].map((n) => n.textContent)).toEqual(["1", "2"]);
    const heads = [...s.querySelectorAll(".sh")] as HTMLButtonElement[];
    expect(heads.map((x) => x.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    expect(s.querySelector(".step:not(.open) .cnt")?.textContent).toBe("2 files");
    const panelText = (s.querySelector(".panel") as HTMLElement).textContent!;
    expect(panelText).not.toMatch(/\bL0\b|fresh @|API 4998|\+11576/);
    // open step 2 manually: folder shown once, status dots instead of letters, −N only when > 0
    heads[1].click();
    expect(s.querySelectorAll(".step.open")).toHaveLength(2);
    expect([...s.querySelectorAll('[data-layer="caller1"] .folder')].map((f) => f.textContent)).toEqual(["src/ui/"]);
    const rows = [...s.querySelectorAll('[data-layer="caller1"] li.file')];
    expect(rows.map((r) => r.querySelector(".fname")!.textContent)).toEqual(["b.ts", "c.ts"]);
    expect(rows.map((r) => r.querySelector(".dot")!.className)).toEqual(["dot mod", "dot del"]);
    expect(rows[0].querySelector(".dot")!.getAttribute("title")).toBe("Modified");
    expect(rows[0].querySelector(".nums .del")?.textContent).toBe("−3");
    expect(rows[1].querySelector(".nums .del")).toBeNull();
    expect(rows[0].querySelector(".fbtn")!.getAttribute("aria-label")).toContain("Uses a.ts");
    expect(rows[0].querySelector(".reason")?.textContent).toBe("Uses a.ts");
    // technical details live in the ⋯ menu
    (s.querySelector(".hdr .icon") as HTMLButtonElement).click();
    const menu = (s.querySelector(".menu") as HTMLElement).textContent!;
    expect(menu).toContain("Re-analyze");
    expect(menu).toContain("Head commit abcdef1 · fresh");
    expect(menu).toContain("GitHub API 4,998 / 5,000 left");
    expect(menu).toContain("3 files · +11,576 / −49 lines");
    expect(menu).toContain("analysed from the diff only");
  });

  it("clicking a file selects it (aria-current) and jumps; the file checkbox marks it; the step shows partial state", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    (s.querySelectorAll(".sh")[1] as HTMLButtonElement).click();
    const btn = () => s.querySelector('.fbtn[data-path="src/ui/b.ts"]') as HTMLButtonElement;
    btn().click();
    expect(btn().getAttribute("aria-current")).toBe("true");
    expect(btn().closest("li")!.classList.contains("sel")).toBe(true);
    expect(s.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    const ft = s.querySelector('.ftick[data-path="src/ui/b.ts"]') as HTMLInputElement;
    ft.checked = true;
    ft.dispatchEvent(new Event("change"));
    const row = btn().closest("li")!;
    expect(row.classList.contains("rev")).toBe(true);
    expect(row.querySelector(".rev-ico")?.textContent).toBe("✓");
    expect(row.querySelector(".dot")).toBeNull();
    const step = s.querySelector('[data-layer="caller1"]')!;
    expect(step.classList.contains("partial")).toBe(true);
    expect((step.querySelector(".tick") as HTMLInputElement).indeterminate).toBe(true);
    expect(step.querySelector(".cnt")?.textContent).toBe("1/2");
    expect(s.querySelector(".plbl")?.textContent).toBe("Step 1 of 21 of 3 files reviewed");
    // un-mark via the row checkbox; clicking a reviewed file still selects it
    btn().click();
    expect(btn().getAttribute("aria-current")).toBe("true");
    const ft2 = s.querySelector('.ftick[data-path="src/ui/b.ts"]') as HTMLInputElement;
    ft2.checked = false;
    ft2.dispatchEvent(new Event("change"));
    expect(btn().closest("li")!.classList.contains("rev")).toBe(false);
    expect(s.querySelector('[data-layer="caller1"]')!.classList.contains("partial")).toBe(false);
  });

  it("'Mark file as reviewed & next' walks file by file, across steps, to 'All N files reviewed'", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    const cta = () => s.querySelector(".step.open .next") as HTMLButtonElement;
    expect(cta().textContent).toBe("Mark file as reviewed & next →");
    cta().click(); // a.ts (no selection: first unreviewed) -> step 1 done, step 2 opens with b.ts selected
    expect(s.querySelector('[data-layer="core"]')!.className).toContain("done");
    expect(s.querySelector('[data-layer="core"]')!.classList.contains("open")).toBe(false);
    expect(s.querySelector('[data-layer="caller1"]')!.classList.contains("open")).toBe(true);
    expect(s.querySelector('[aria-current="true"]')?.getAttribute("data-path")).toBe("src/ui/b.ts");
    expect(s.querySelector(".plbl")?.textContent).toBe("Step 2 of 21 of 3 files reviewed");
    let set = calls.filter((c) => c.type === "reviewed:set").pop() as any;
    expect(Object.keys(set.value.files)).toEqual(["src/a.ts"]);
    cta().click(); // b.ts -> c.ts selected, same step
    expect(s.querySelector('[aria-current="true"]')?.getAttribute("data-path")).toBe("src/ui/c.ts");
    expect(s.querySelector('.fbtn[data-path="src/ui/b.ts"]')!.closest("li")!.classList.contains("rev")).toBe(true);
    expect(cta().textContent).toBe("Mark file as reviewed ✓");
    cta().click();
    expect(s.querySelector(".plbl")?.textContent).toBe("All 3 files reviewed");
    expect(s.querySelector(".alldone")?.textContent).toContain("All 3 files reviewed");
    expect(s.querySelectorAll(".step.open")).toHaveLength(0);
    set = calls.filter((c) => c.type === "reviewed:set").pop() as any;
    expect(Object.keys(set.value.files).sort()).toEqual(["src/a.ts", "src/ui/b.ts", "src/ui/c.ts"]);
  });

  it("n / j / k work only when focus is in the panel and not in a text field", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    // typing in GitHub's page does nothing
    const ta = document.createElement("textarea");
    document.body.append(ta);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true, composed: true }));
    expect(calls.some((c) => c.type === "reviewed:set")).toBe(false);
    ta.remove();
    const panel = s.querySelector(".panel") as HTMLElement;
    const key = (k: string, target: Element = s.querySelector(".sh")!) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true }));
    key("j");
    expect(s.querySelector('[aria-current="true"]')?.getAttribute("data-path")).toBe("src/a.ts");
    key("j");
    expect(s.querySelector('[aria-current="true"]')?.getAttribute("data-path")).toBe("src/ui/b.ts");
    key("k");
    expect(s.querySelector('[aria-current="true"]')?.getAttribute("data-path")).toBe("src/a.ts");
    key("n");
    expect(s.querySelector('.fbtn[data-path="src/a.ts"]')).toBeNull(); // step 1 done and collapsed
    expect(s.querySelector('[aria-current="true"]')?.getAttribute("data-path")).toBe("src/ui/b.ts");
    // a text input inside the panel (graph search) is ignored
    const input = document.createElement("input");
    input.type = "search";
    panel.append(input);
    key("n", input);
    expect(s.querySelector('[aria-current="true"]')?.getAttribute("data-path")).toBe("src/ui/b.ts");
  });
});
