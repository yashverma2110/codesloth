// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { type: string; [k: string]: unknown }[] = [];
let stored: unknown = null;
let prefs: Record<string, unknown> = {};
const ONE = { version: 1, totalCommits: 1, commits: [{ sha: "c0", message: "only", initials: "YV", date: "2026-10-09T11:19:00Z" }], files: { "src/a.ts": [{ c: 0, additions: 2, deletions: 0 }] }, notes: [] };
let history: unknown = ONE;
const replies: Record<string, (m: any) => unknown> = {
  "auth:status": () => ({ method: "pat", login: "yash" }),
  "widget:getPosition": () => stored,
  "widget:setPosition": (m) => ((stored = m.position), true),
  "reviewed:get": () => ({}),
  "reviewed:set": () => true,
  "prefs:get": (m) => prefs[m.key] ?? null,
  "prefs:set": (m) => ((prefs[m.key] = m.value), true),
  "graph:openTab": () => true,
  "history:get": () => history,
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
    // demo simulates a push after steps 1-2 were reviewed: 2 ticks are stale (kept, amber) and the banner shows
    expect(s.querySelector("li.file.chg .stale-ico")).not.toBeNull();
    expect((s.querySelector("li.file.chg .ftick") as HTMLInputElement).checked).toBe(true);
    expect(s.querySelector(".stalebar .msg")!.textContent).toBe("3 new commits changed 2 files you reviewed.");
    expect(s.querySelector(".sub")!.textContent).toContain("4 of 36 files reviewed · 2 stale");
    expect((s.querySelector(".bubble") as HTMLElement).classList.contains("stale")).toBe(false); // panel is open
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

  it("with 'Sync with GitHub Viewed' on, marking clicks GitHub's Viewed control; failures show a not-synced icon", async () => {
    prefs.syncViewed = true;
    // GitHub's classic file for src/a.ts with an unchecked Viewed checkbox; nothing rendered for b.ts
    const f = document.createElement("div");
    f.className = "file";
    f.setAttribute("data-tagsearch-path", "src/a.ts");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "viewed";
    f.append(cb);
    document.body.append(f);
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    const ft = s.querySelector('.ftick[data-path="src/a.ts"]') as HTMLInputElement;
    ft.checked = true;
    ft.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(cb.checked).toBe(true));
    // unmark unchecks it
    (s.querySelector('.ftick[data-path="src/a.ts"]') as HTMLInputElement).checked = false;
    s.querySelector('.ftick[data-path="src/a.ts"]')!.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(cb.checked).toBe(false));
    // a file GitHub hasn't rendered ends up flagged (after the wait times out)
    (s.querySelectorAll(".sh")[1] as HTMLButtonElement).click();
    const fb = s.querySelector('.ftick[data-path="src/ui/b.ts"]') as HTMLInputElement;
    fb.checked = true;
    fb.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(s.querySelector('.fbtn[data-path="src/ui/b.ts"] .unsync')).not.toBeNull(), { timeout: 6000 });
    expect(s.querySelector('.fbtn[data-path="src/ui/b.ts"] .unsync')!.getAttribute("title")).toMatch(/Not synced/);
    // never any write API from the extension
    expect(calls.every((c) => ["widget:getPosition", "auth:status", "analyze", "history:get", "reviewed:get", "reviewed:set", "prefs:get", "prefs:set"].includes(c.type))).toBe(true);
    f.remove();
    delete prefs.syncViewed;
  }, 10000);

  it("sync is off by default: GitHub's Viewed checkbox is left alone", async () => {
    const f = document.createElement("div");
    f.setAttribute("data-tagsearch-path", "src/a.ts");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "viewed";
    f.append(cb);
    document.body.append(f);
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelectorAll("li.file")).toHaveLength(1));
    (s.querySelector(".step.open .next") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(cb.checked).toBe(false);
    f.remove();
  });

  it("commit story: counts, latest line, chips, step line and a timeline for the selected file; loaded after the plan", async () => {
    history = {
      version: 1,
      totalCommits: 3,
      commits: [
        { sha: "aaaaaaa1", message: "feat: add a", login: "yv", name: "Yash Verma", initials: "YV", date: "2026-10-09T11:19:00Z" },
        { sha: "bbbbbbb2", message: "Address review comments", login: "yv", name: "Yash Verma", initials: "YV", date: "2026-10-10T11:19:00Z" },
        { sha: "ccccccc3", message: "refactor: rename", login: "yv", name: "Yash Verma", initials: "YV", date: "2026-10-11T10:11:29Z" },
      ],
      files: {
        "src/a.ts": [{ c: 0, additions: 2, deletions: 0 }, { c: 1, additions: 1, deletions: 1 }, { c: 2, additions: 3, deletions: 3 }],
        "src/ui/b.ts": [{ c: 2, additions: 1, deletions: 3 }],
        "src/ui/c.ts": [{ c: 0, additions: 0, deletions: 4 }],
      },
      notes: [],
    };
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelector(".fbtn .cm")).not.toBeNull());
    const hc = calls.find((c) => c.type === "history:get") as any;
    expect(hc.headSha).toBe("abcdef1234");
    expect(hc.paths).toEqual(["src/a.ts", "src/ui/b.ts", "src/ui/c.ts"]);
    expect(calls.findIndex((c) => c.type === "history:get")).toBeGreaterThan(calls.findIndex((c) => c.type === "analyze"));
    const a = s.querySelector('.fbtn[data-path="src/a.ts"]')!;
    expect(a.querySelector(".cm")!.textContent).toBe("3 commits");
    expect([...a.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["After review"]);
    expect(a.querySelector(".latest")!.textContent).toMatch(/^Latest: refactor: rename · /);
    expect(a.getAttribute("aria-label")).toContain("3 commits");
    expect(s.querySelector(".step.open .story")!.textContent).toMatch(/Touched in 3 of 3 commits/);
    expect(s.querySelectorAll(".step.open .sdots i.on")).toHaveLength(3);
    expect(s.querySelector(".tl")).toBeNull(); // only for the selected file
    (a as HTMLButtonElement).click();
    // collapsed by default: a toggle row, Latest stays visible, no commits listed
    const tog = s.querySelector("li.file.sel .tltog") as HTMLButtonElement;
    expect(tog.textContent).toContain("Commit history · 3");
    expect(tog.getAttribute("aria-expanded")).toBe("false");
    expect(tog.getAttribute("aria-controls")).toBe("prl-tl");
    expect(s.querySelector("#prl-tl")!.hasAttribute("hidden")).toBe(true);
    expect(s.querySelectorAll(".tl .tc")).toHaveLength(0);
    expect(s.querySelector("li.file.sel .latest")).not.toBeNull();
    const jumps = calls.filter((c) => c.type === "graph:jump").length;
    tog.click();
    expect(prefs.storyOpen).toBe(true);
    expect(s.querySelector("li.file.sel .tltog")!.getAttribute("aria-expanded")).toBe("true");
    expect(s.querySelector(".tlmore")).toBeNull(); // <= 3 commits: no show-all
    expect(calls.filter((c) => c.type === "graph:jump").length).toBe(jumps);
    const items = [...s.querySelectorAll(".tl .tc")];
    expect(items.map((i) => i.querySelector(".tmsg")!.textContent)).toEqual(["feat: add a", "Address review comments", "refactor: rename"]);
    expect(items[2].classList.contains("newest")).toBe(true);
    expect(items[2].textContent).toContain("newest");
    expect(items[1].textContent).toContain("After review");
    const link = items[0].querySelector("a.sha") as HTMLAnchorElement;
    expect(link.textContent).toBe("aaaaaaa");
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/7/commits/aaaaaaa1");
    expect(items[0].querySelector(".av")!.textContent).toBe("YV");
    expect(items[1].querySelector(".tmsg")!.getAttribute("title")).toBe("Address review comments");
    expect(s.querySelector("li.file.sel .latest")!.getAttribute("title")).toMatch(/^Latest: refactor: rename · /);
    expect(s.querySelector("li.file.sel .fname")!.getAttribute("title")).toBe("src/a.ts");
    // step 2: b.ts only in the newest commit -> Late change
    (s.querySelectorAll(".sh")[1] as HTMLButtonElement).click();
    const b = s.querySelector('.fbtn[data-path="src/ui/b.ts"]')!;
    expect(b.querySelector(".cm")!.textContent).toBe("1 commit");
    expect([...b.querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["Late change"]);
    history = ONE;
  });

  it("single-commit PRs hide the commit story; a failure only shows a note in the ⋯ menu", async () => {
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(calls.some((c) => c.type === "history:get")).toBe(true));
    (s.querySelector('.fbtn[data-path="src/a.ts"]') as HTMLButtonElement).click();
    expect(s.querySelector(".cm, .story, .tl, .latest")).toBeNull();
    w.unmount();
    document.getElementById("codesloth-widget-host")?.remove();
    replies["history:get"] = () => {
      throw new Error("rate limited");
    };
    const w2 = new Widget();
    await w2.mount();
    w2.setPr({ owner: "o", repo: "r", number: 8 });
    w2.toggle("bubble");
    const s2 = shadowOf();
    await vi.waitFor(() => expect(s2.querySelectorAll("li.file").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(s2.querySelector(".cm, .story, .tl")).toBeNull();
    (s2.querySelector(".hdr .icon") as HTMLButtonElement).click();
    expect(s2.querySelector(".menu")!.textContent).toContain("Commit story unavailable: rate limited");
    replies["history:get"] = () => history;
  });

  it("demo mode bundles a real commit story (fastapi/fastapi#16403)", async () => {
    replies["auth:status"] = () => ({ method: "none" });
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelector(".setup")).not.toBeNull());
    w.loadDemo(false);
    expect(s.querySelector(".step.open .story")!.textContent).toMatch(/Touched in 1 of 5 commits/);
    w.select("tests/test_telemetry/test_runtime.py");
    expect(s.querySelectorAll(".tl .tc")).toHaveLength(0); // collapsed by default
    (s.querySelector("li.file.sel .tltog") as HTMLButtonElement).click();
    expect(s.querySelectorAll(".tl .tc")).toHaveLength(3);
    expect(calls.some((c) => c.type === "history:get")).toBe(false);
    replies["auth:status"] = () => ({ method: "pat", login: "yash" });
  });

  it("timeline: latest 3 by default when expanded, Show all / Show fewer inline, state kept across files, toggle doesn't navigate or break j/k/n", async () => {
    const commits = Array.from({ length: 6 }, (_, i) => ({ sha: `sha${i}xxxxx`, message: `commit ${i}`, initials: "YV", date: `2026-10-0${i + 1}T00:00:00Z` }));
    history = {
      version: 1, totalCommits: 6, commits,
      files: { "src/a.ts": commits.map((_, c) => ({ c, additions: 1, deletions: 0 })), "src/ui/b.ts": [{ c: 1, additions: 1, deletions: 0 }, { c: 5, additions: 1, deletions: 0 }], "src/ui/c.ts": [] },
      notes: [],
    };
    prefs.storyOpen = true; // session pref: expanded
    const w = new Widget();
    await w.mount();
    w.setPr({ owner: "o", repo: "r", number: 7 });
    w.toggle("bubble");
    const s = shadowOf();
    await vi.waitFor(() => expect(s.querySelector(".fbtn .cm")).not.toBeNull());
    w.select("src/a.ts");
    const msgs = () => [...s.querySelectorAll(".tl .tc .tmsg")].map((m) => m.textContent);
    expect(msgs()).toEqual(["commit 3", "commit 4", "commit 5"]);
    expect(s.querySelector(".tl .tc.newest .tmsg")!.textContent).toBe("commit 5");
    const more = s.querySelector(".tlmore") as HTMLButtonElement;
    expect(more.textContent).toBe("+ 3 earlier commits · Show all 6");
    more.click();
    expect(msgs()).toEqual(["commit 0", "commit 1", "commit 2", "commit 3", "commit 4", "commit 5"]);
    expect(s.querySelector(".tlmore")!.textContent).toBe("Show fewer");
    (s.querySelector(".tlmore") as HTMLButtonElement).click();
    expect(msgs()).toHaveLength(3);
    // Enter/Space on the toggle are plain button activations; n/j/k still work from it
    const tog = s.querySelector("li.file.sel .tltog") as HTMLButtonElement;
    tog.focus();
    tog.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, composed: true }));
    expect(s.querySelector('.fbtn[aria-current="true"]')!.getAttribute("data-path")).toBe("src/ui/b.ts");
    // still expanded on the next file (global pref), showing its 2 commits without show-all
    expect(s.querySelector("li.file.sel .tltog")!.getAttribute("aria-expanded")).toBe("true");
    expect(msgs()).toEqual(["commit 1", "commit 5"]);
    expect(s.querySelector(".tlmore")).toBeNull();
    (s.querySelector("li.file.sel .tltog") as HTMLButtonElement).click();
    expect(prefs.storyOpen).toBe(false);
    expect(s.querySelectorAll(".tl .tc")).toHaveLength(0);
    history = ONE;
  });

  describe("stale reviews + restart", () => {
    const STALE = { v: 2, files: { "src/a.ts": { sha: "s0-old", at: "2026-10-10T00:00:00Z", headSha: "1234567" }, "src/ui/b.ts": { sha: "s2", at: "2026-10-10T00:00:00Z", headSha: "1234567" } } };
    let saved: any = null;
    const setup = async (state: unknown = STALE) => {
      saved = null;
      replies["reviewed:get"] = () => saved ?? JSON.parse(JSON.stringify(state));
      replies["reviewed:set"] = (m) => ((saved = m.value), true);
      replies["compare:get"] = () => ({ status: "ahead", aheadBy: 2 });
      const w = new Widget();
      await w.mount();
      w.setPr({ owner: "o", repo: "r", number: 7 });
      w.toggle("bubble");
      const s = shadowOf();
      await vi.waitFor(() => expect(s.querySelector(".stalebar .msg")?.textContent).toBe("2 new commits changed 1 file you reviewed."));
      return { w, s };
    };
    const restore = () => {
      replies["reviewed:get"] = () => ({});
      replies["reviewed:set"] = () => true;
      delete replies["compare:get"];
    };

    it("keeps stale ticks (amber ⚠), shows the banner with Show files, and a bubble dot while closed", async () => {
      const { w, s } = await setup();
      const cmp = calls.find((c) => c.type === "compare:get") as any;
      expect([cmp.base, cmp.head]).toEqual(["1234567", "abcdef1234"]);
      const row = s.querySelector('.fbtn[data-path="src/a.ts"]')!;
      expect(row.querySelector(".stale-ico")!.getAttribute("title")).toBe("Changed since you reviewed");
      expect((s.querySelector('.ftick[data-path="src/a.ts"]') as HTMLInputElement).checked).toBe(true);
      expect(s.querySelector(".sub")!.textContent).toContain("1 of 3 files reviewed · 1 stale");
      expect(s.querySelector('.step[data-layer="core"] .chg-ico')).not.toBeNull();
      const show = s.querySelector('.stalebar [data-act="show"]') as HTMLButtonElement;
      expect((s.querySelector("#prl-stale-list") as HTMLElement).hidden).toBe(true);
      show.click();
      expect((s.querySelector("#prl-stale-list") as HTMLElement).hidden).toBe(false);
      expect(s.querySelector("#prl-stale-list")!.textContent).toContain("a.ts");
      w.toggle("close");
      expect(s.querySelector(".bubble")!.classList.contains("stale")).toBe(true);
      w.toggle("bubble");
      expect(s.querySelector(".bubble")!.classList.contains("stale")).toBe(false);
      restore();
    });

    it("Untick changed files removes the stale ticks (and GitHub Viewed when synced, without double-toggling), then selects the first", async () => {
      prefs.syncViewed = true;
      const mkFile = (path: string, checked: boolean) => {
        const f = document.createElement("div");
        f.className = "file";
        f.setAttribute("data-tagsearch-path", path);
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.name = "viewed";
        cb.checked = checked;
        let clicks = 0;
        cb.addEventListener("click", () => clicks++);
        f.append(cb);
        document.body.append(f);
        return { f, cb, clicks: () => clicks };
      };
      const a = mkFile("src/a.ts", true);
      const { s } = await setup();
      (s.querySelector('.stalebar [data-act="untick"]') as HTMLButtonElement).click();
      expect(saved.files["src/a.ts"]).toBeUndefined();
      expect(saved.files["src/ui/b.ts"]).toBeDefined();
      expect(saved.ack).toBe("abcdef1234");
      expect(s.querySelector(".stalebar")).toBeNull();
      expect(s.querySelector('.fbtn[aria-current="true"]')!.getAttribute("data-path")).toBe("src/a.ts");
      await vi.waitFor(() => expect(a.cb.checked).toBe(false));
      expect(a.clicks()).toBe(1);
      a.f.remove();
      // GitHub already reset Viewed itself: nothing is clicked
      const a2 = mkFile("src/a.ts", false);
      const { s: s2 } = await setup();
      (s2.querySelector('.stalebar [data-act="untick"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
      expect(a2.clicks()).toBe(0);
      a2.f.remove();
      delete prefs.syncViewed;
      restore();
    });

    it("Keep my ticks accepts the new versions; dismiss hides it for this head only (persisted)", async () => {
      const { s } = await setup();
      (s.querySelector('.stalebar [data-act="keep"]') as HTMLButtonElement).click();
      expect(saved.files["src/a.ts"]).toMatchObject({ sha: "s1", headSha: "abcdef1234" });
      expect(s.querySelector(".stalebar")).toBeNull();
      expect(s.querySelector(".stale-ico")).toBeNull();
      restore();
      // dismiss
      const { s: s2 } = await setup();
      (s2.querySelector('.stalebar [data-act="dismiss"]') as HTMLButtonElement).click();
      expect(saved.ack).toBe("abcdef1234");
      expect(s2.querySelector(".stalebar")).toBeNull();
      expect(s2.querySelector(".stale-ico")).not.toBeNull(); // still amber
      // reopening the same PR/head: still dismissed
      document.getElementById("codesloth-widget-host")?.remove();
      const w3 = new Widget();
      await w3.mount();
      w3.setPr({ owner: "o", repo: "r", number: 7 });
      w3.toggle("bubble");
      const s3 = shadowOf();
      await vi.waitFor(() => expect(s3.querySelector(".stale-ico")).not.toBeNull());
      expect(s3.querySelector(".stalebar")).toBeNull();
      restore();
    });

    it("Restart review: tab-row button (Review tab only), inline confirm, clears all ticks and stale states, step 1 first file, Undo restores", async () => {
      const { s } = await setup();
      const btn = s.querySelector(".tabbar .restart") as HTMLButtonElement;
      expect(btn.hidden).toBe(false);
      expect(btn.textContent).toContain("Restart review");
      (s.querySelector("#prl-tab-graph") as HTMLButtonElement).click();
      expect(btn.hidden).toBe(true);
      (s.querySelector("#prl-tab-review") as HTMLButtonElement).click();
      expect(btn.hidden).toBe(false);
      btn.click();
      expect(s.querySelector(".restart-note .msg")!.textContent).toBe("Clear all 2 ticks for this PR?");
      expect(saved).toBeNull(); // nothing cleared yet
      (s.querySelector('.restart-note [data-act="cancel"]') as HTMLButtonElement).click();
      expect(s.querySelector(".restart-note")).toBeNull();
      btn.click();
      (s.querySelector('.restart-note [data-act="clear"]') as HTMLButtonElement).click();
      expect(saved.files).toEqual({});
      expect(s.querySelector(".stalebar, .stale-ico, .rev-ico")).toBeNull();
      expect(s.querySelector(".sub")!.textContent).toMatch(/Step 1 of 2\s*0 of 3 files reviewed$/);
      expect(s.querySelector('.step.open[data-layer="core"]')).not.toBeNull();
      expect(s.querySelector('.fbtn[aria-current="true"]')!.getAttribute("data-path")).toBe("src/a.ts");
      expect(s.querySelector(".restart-note.toast .msg")!.textContent).toBe("Cleared 2 ticks.");
      expect(btn.disabled).toBe(true);
      (s.querySelector('.restart-note [data-act="undo"]') as HTMLButtonElement).click();
      expect(Object.keys(saved.files).sort()).toEqual(["src/a.ts", "src/ui/b.ts"]);
      expect(s.querySelector(".stale-ico")).not.toBeNull();
      expect(s.querySelector(".restart-note")).toBeNull();
      // menu entry exists too
      (s.querySelector(".hdr .icon") as HTMLButtonElement).click();
      expect([...s.querySelectorAll(".menu button")].some((b) => /Restart review/.test(b.textContent!))).toBe(true);
      restore();
    });

    it("the Undo toast goes away after ~6 s", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { s } = await setup();
        (s.querySelector(".tabbar .restart") as HTMLButtonElement).click();
        (s.querySelector('.restart-note [data-act="clear"]') as HTMLButtonElement).click();
        expect(s.querySelector(".restart-note.toast")).not.toBeNull();
        vi.advanceTimersByTime(6100);
        expect(s.querySelector(".restart-note")).toBeNull();
      } finally {
        vi.useRealTimers();
        restore();
      }
    });

    it("demo: Restart review works and nothing is saved", async () => {
      replies["auth:status"] = () => ({ method: "none" });
      const w = new Widget();
      await w.mount();
      w.setPr({ owner: "o", repo: "r", number: 7 });
      w.toggle("bubble");
      const s = shadowOf();
      await vi.waitFor(() => expect(s.querySelector(".setup")).not.toBeNull());
      w.loadDemo(false);
      expect(s.querySelector(".stalebar")).not.toBeNull();
      (s.querySelector(".tabbar .restart") as HTMLButtonElement).click();
      (s.querySelector('.restart-note [data-act="clear"]') as HTMLButtonElement).click();
      expect(s.querySelector(".sub")!.textContent).toContain("0 of 36 files reviewed");
      expect(calls.some((c) => c.type === "reviewed:set")).toBe(false);
      replies["auth:status"] = () => ({ method: "pat", login: "yash" });
    });
  });
});
