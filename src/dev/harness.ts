export {};
/**
 * Dev-only harness: mounts the real widget in a plain page with a mocked chrome.runtime so it can be
 * rendered headlessly (scripts/dev/render-demo.mjs). Not part of the extension bundle.
 */
const params = new URLSearchParams(location.search);
const planUrl = params.get("plan");
const prefs: Record<string, unknown> = { tourDone: params.get("tour") !== "1", storyOpen: params.get("story") === "1", codeFont: params.get("font"), fontSize: params.get("size"), uiFont: params.get("ui") === "1" };
const origAttach = HTMLElement.prototype.attachShadow;
HTMLElement.prototype.attachShadow = function (init) {
  const s = origAttach.call(this, init);
  (window as any).__shadow = s;
  return s;
};
const plan = planUrl ? await (await fetch(planUrl)).json() : null;
const historyUrl = params.get("history");
const history = historyUrl ? await (await fetch(historyUrl)).json() : null;
// ?stale=1: the first 6 files were reviewed at an older head; 2 of them changed since (simulated push).
function staleState() {
  const files = (plan?.plan.layers ?? []).flatMap((l: any) => l.files).slice(0, 6);
  const out: any = { v: 2, files: {} };
  files.forEach((f: any, i: number) => (out.files[f.path] = { sha: i < 2 ? "an-older-blob-sha" : f.sha, at: "2026-10-01T00:00:00Z", headSha: "1111111" }));
  return out;
}
(globalThis as any).chrome = {
  runtime: {
    getURL: (p: string) => `/public/${p}`,
    sendMessage: async (m: any) => {
      const r: Record<string, () => unknown> = {
        "auth:status": () => (plan ? { method: "pat", login: "demo" } : { method: "none" }),
        "widget:getPosition": () => ({ side: "right", top: 16 }),
        "widget:setPosition": () => true,
        "reviewed:get": () => (params.get("stale") === "1" ? staleState() : {}),
        "compare:get": () => ({ status: "ahead", aheadBy: 3 }),
        "reviewed:set": () => true,
        "prefs:get": () => prefs[m.key] ?? null,
        "prefs:set": () => ((prefs[m.key] = m.value), true),
        analyze: () => ({ ...plan, fromCache: true }),
        "history:get": () => history,
      };
      return { ok: true, data: r[m.type]?.() ?? null };
    },
  },
};
const { Widget } = await import("../content/widget");
const w = new Widget();
await w.mount();
if (plan) w.setPr(plan.pr);
(window as any).__w = w;
(window as any).__ready = true;
