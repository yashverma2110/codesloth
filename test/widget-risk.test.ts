// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const RED = JSON.parse(readFileSync("test/fixtures/risk/red-plan.json", "utf8"));
const calls: { type: string; [k: string]: any }[] = [];
let prefs: Record<string, unknown> = {};
let store: Record<string, unknown> = {};
let result: any = RED;
const replies: Record<string, (m: any) => unknown> = {
  "auth:status": () => ({ method: "pat", login: "yash" }),
  "widget:getPosition": () => null,
  "widget:setPosition": () => true,
  "reviewed:get": (m) => store[m.key] ?? {},
  "reviewed:set": (m) => ((store[m.key] = m.value), true),
  "prefs:get": (m) => prefs[m.key] ?? null,
  "prefs:set": (m) => ((prefs[m.key] = m.value), true),
  "history:get": () => null,
  analyze: () => ({ ...result, fromCache: true }),
};
(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(async (m: any) => {
      calls.push(m);
      return { ok: true, data: await replies[m.type]?.(m) };
    }),
    getURL: (p: string) => `chrome-extension://test/${p}`,
  },
};
(globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} };
const { Widget } = await import("../src/content/widget");
const shadowOf = (): ShadowRoot => (window as any).__lastShadow;
const MIG = "repository/migrations/002_create_quota_budgets.sql";

async function open() {
  const w = new Widget();
  await w.mount();
  w.setPr(RED.pr);
  w.toggle("bubble");
  const s = shadowOf();
  await vi.waitFor(() => expect(s.querySelector(".steps")).not.toBeNull());
  return { w, s };
}

describe("Risky changes (DOM)", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
    calls.length = 0;
    prefs = { tourDone: true };
    store = {};
    result = RED;
    history.replaceState(null, "", "/example/quota-service/pull/99/files");
    const orig = HTMLElement.prototype.attachShadow;
    HTMLElement.prototype.attachShadow = function (init) {
      const s = orig.call(this, init);
      (window as any).__lastShadow = s;
      return s;
    };
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("banner counts risky files and the worst level; List jumps to a file; steps show counts; rows show chips", async () => {
    const { s } = await open();
    const bar = s.querySelector(".riskbar")!;
    expect(bar.classList.contains("high")).toBe(true);
    expect(bar.querySelector(".rtx")!.textContent).toBe("⛔Risky changes · 76 likely breaking");
    const list = bar.querySelector('[data-act="risk-list"]') as HTMLButtonElement;
    expect(list.getAttribute("aria-expanded")).toBe("false");
    list.click();
    const rows = [...s.querySelectorAll(".rlist .rrow")];
    expect(rows.map((r) => r.querySelector(".fname")!.textContent)).toEqual(["quota.proto", "002_create_quota_budgets.sql", "004_quota_limits.sql", "http.go", "quota.go", "app.yaml", "queries.sql"]);
    expect(rows[6].querySelector(".rchip")!.textContent).toBe("⚠Review carefully");
    expect(s.querySelector(".rlist .rnote")!.textContent).toBe("Illustrative fixture (not a real PR).");
    (rows[3] as HTMLButtonElement).click();
    const sel = s.querySelector("li.file.sel")!;
    expect(sel.classList.contains("risk-high")).toBe(true);
    expect(sel.querySelector(".fbtn")!.getAttribute("aria-label")).toContain("likely breaking: Removes route DELETE /v1/private/allocation/:allocationId");
    expect(s.querySelector('[data-layer="contract"] .rcnt, .step .rcnt')!.textContent).toMatch(/^⛔ \d$/);
  });

  it("the selected file lists each finding with a line link, excerpt and why; the link scrolls to that diff line", async () => {
    const { w, s } = await open();
    w.select(MIG);
    const card = s.querySelector("li.file.sel .rcard")!;
    const fds = [...card.querySelectorAll(".fd")];
    expect(fds.map((f) => f.querySelector(".ft")!.textContent)).toEqual(["Edits a migration that's already on the base branch", "Drops a column"]);
    expect(fds[1].querySelector(".ex")!.textContent).toBe('ALTER TABLE "quotaBudgets" DROP COLUMN consumed;');
    expect(fds[1].querySelector(".lref")!.textContent).toBe("R5");
    // GitHub's classic diff for that file, with the line cell
    const hash = "diff-" + createHash("sha256").update(MIG).digest("hex");
    const file = document.createElement("div");
    file.className = "file";
    file.id = hash;
    file.scrollIntoView = vi.fn();
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.id = `${hash}R5`;
    tr.append(td);
    tr.scrollIntoView = vi.fn();
    file.append(tr);
    document.body.append(file);
    (fds[1].querySelector(".lref") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(location.hash).toBe(`#${hash}R5`));
    expect(tr.scrollIntoView).toHaveBeenCalled();
  });

  it("'Not breaking' dismisses one finding per PR + file + rule, persists it, and Undo brings it back", async () => {
    const { w, s } = await open();
    w.select(MIG);
    const dismiss = () => s.querySelector('li.file.sel .rcard .fd [data-act="dismiss"]') as HTMLButtonElement;
    dismiss().click();
    const set = calls.filter((c) => c.type === "reviewed:set" && c.key === "risk:example/quota-service#99").pop()!;
    expect(Object.keys(set.value)).toHaveLength(1);
    expect(Object.keys(set.value)[0]).toMatch(/^repository\/migrations\/002_create_quota_budgets\.sql\|sql\.migration-edited\|/);
    expect(s.querySelectorAll("li.file.sel .rcard > .fd")).toHaveLength(1);
    expect(s.querySelector("li.file.sel .rdis summary")!.textContent).toBe("Dismissed (1)");
    dismiss().click();
    // both dismissed: the row loses its flag, the banner drops to 6
    expect(s.querySelector("li.file.sel")!.className).not.toMatch(/risk-/);
    expect(s.querySelector(".riskbar b")!.textContent).toBe("Risky changes · 6");
    // a reload keeps it
    const again = await open();
    again.w.select(MIG);
    expect(again.s.querySelector("li.file.sel .rdis summary")!.textContent).toBe("Dismissed (2)");
    (again.s.querySelector('li.file.sel .rdis [data-act="restore"]') as HTMLButtonElement).click();
    expect(again.s.querySelectorAll("li.file.sel .rcard > .fd")).toHaveLength(1);
    expect(Object.keys(store["risk:example/quota-service#99"] as object)).toHaveLength(1);
  });

  it("Show only risky filters steps and files; r walks risky files in review order", async () => {
    const { s } = await open();
    const filter = s.querySelector('[data-act="risk-filter"]') as HTMLButtonElement;
    filter.click();
    expect(s.querySelector('[data-act="risk-filter"]')!.getAttribute("aria-pressed")).toBe("true");
    const shown = [...s.querySelectorAll("li.file .fbtn")].map((b) => b.getAttribute("data-path"));
    expect(shown).not.toContain("config/config.go");
    expect([...s.querySelectorAll("li.file")].every((f) => /risk-(high|medium)/.test(f.className))).toBe(true);
    const key = (k: string) => s.querySelector(".sh")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true }));
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      key("r");
      order.push(s.querySelector('[aria-current="true"]')!.getAttribute("data-path")!);
    }
    expect(new Set(order.slice(0, 7)).size).toBe(7);
    expect(order[7]).toBe(order[0]); // wraps
    expect(s.querySelector(".sfoot .hint")?.textContent).toContain("r next risky");
  });

  it("sensitivity and category settings apply; the ⋯ menu cycles sensitivity and saves it", async () => {
    prefs = { tourDone: true, riskSensitivity: "relaxed" };
    let { s } = await open();
    expect(s.querySelector(".riskbar b")!.textContent).toBe("Risky changes · 6"); // queries.sql (amber) hidden
    prefs = { tourDone: true, riskOff: ["sql"] };
    ({ s } = await open());
    expect(s.querySelector(".riskbar b")!.textContent).toBe("Risky changes · 4");
    prefs = { tourDone: true };
    ({ s } = await open());
    (s.querySelector(".hdr .icon[aria-haspopup]") as HTMLButtonElement).click();
    const item = [...s.querySelectorAll(".menu button")].find((b) => b.textContent!.startsWith("Risk sensitivity")) as HTMLButtonElement;
    expect(item.textContent).toBe("Risk sensitivity: Normal (click to change)");
    item.click();
    expect(prefs.riskSensitivity).toBe("strict");
  });

  it("no findings: no banner or chips; a failed risk pass is reported in the ⋯ menu", async () => {
    result = { ...RED, risk: { version: 1, findings: [], passed: [], notChecked: [], config: ".codesloth.yml: not found on the base branch" } };
    let { s } = await open();
    expect(s.querySelector(".riskbar")).toBeNull();
    expect(s.querySelector(".rchip")).toBeNull();
    (s.querySelector(".hdr .icon[aria-haspopup]") as HTMLButtonElement).click();
    expect([...s.querySelectorAll(".menu .meta")].map((m) => m.textContent)).toContain("Risky changes: .codesloth.yml: not found on the base branch");
    result = { ...RED, risk: undefined };
    ({ s } = await open());
    (s.querySelector(".hdr .icon[aria-haspopup]") as HTMLButtonElement).click();
    expect([...s.querySelectorAll(".menu .meta.warn")].map((m) => m.textContent).join("\n")).toContain("Risky changes: checks didn't run");
  });
});
