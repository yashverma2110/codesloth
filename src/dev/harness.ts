export {};
/**
 * Dev-only harness: mounts the real widget in a plain page with a mocked chrome.runtime so it can be
 * rendered headlessly (scripts/dev/render-demo.mjs). Not part of the extension bundle.
 */
const params = new URLSearchParams(location.search);
const planUrl = params.get("plan");
const prefs: Record<string, unknown> = { tourDone: params.get("tour") !== "1", storyOpen: params.get("story") === "1" };
const origAttach = HTMLElement.prototype.attachShadow;
HTMLElement.prototype.attachShadow = function (init) {
  const s = origAttach.call(this, init);
  (window as any).__shadow = s;
  return s;
};
const plan = planUrl ? await (await fetch(planUrl)).json() : null;
const historyUrl = params.get("history");
const history = historyUrl ? await (await fetch(historyUrl)).json() : null;
(globalThis as any).chrome = {
  runtime: {
    sendMessage: async (m: any) => {
      const r: Record<string, () => unknown> = {
        "auth:status": () => (plan ? { method: "pat", login: "demo" } : { method: "none" }),
        "widget:getPosition": () => ({ side: "right", top: 16 }),
        "widget:setPosition": () => true,
        "reviewed:get": () => ({}),
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
