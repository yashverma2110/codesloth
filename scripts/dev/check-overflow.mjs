// Regression check (headless Chrome, real layout): the Review panel must never overflow horizontally,
// even with very long commit messages and file names. Exit code 1 on any overflow.
// Usage: node scripts/dev/check-overflow.mjs [--shots <dir>]
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";

const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
if (!existsSync(CHROME)) {
  console.log("SKIP: no Chrome at", CHROME);
  process.exit(0);
}
mkdirSync(".tmp/harness", { recursive: true });
await build({ entryPoints: ["src/dev/harness.ts"], bundle: true, format: "esm", outfile: ".tmp/harness/harness.js", target: "chrome120", logLevel: "warning" });

// Real data (go-gitea/gitea#39426, 40 commits, messages up to 76 chars) plus a stress variant.
const plan = JSON.parse(readFileSync("test/fixtures/overflow/gitea-39426-plan.json", "utf8"));
const history = JSON.parse(readFileSync("test/fixtures/overflow/gitea-39426-history.json", "utf8"));
const target = Object.entries(history.files).sort((a, b) => b[1].length - a[1].length)[0][0];
const stress = structuredClone({ plan, history });
const LONG_NAME = "a_really_really_long_file_name_without_any_breaks_that_keeps_going_and_going_v2_final.go";
const longPath = target.replace(/[^/]+$/, LONG_NAME);
for (const l of stress.plan.plan.layers) for (const f of l.files) if (f.path === target) f.path = longPath;
stress.history.files[longPath] = stress.history.files[target];
delete stress.history.files[target];
stress.history.commits[stress.history.files[longPath][0].c].message = "fix(document-analysis): degrade on unopenable PDFs, bound pageLimit, tidy comments and " + "x".repeat(140);
stress.history.commits.at(-1).message = "Supercalifragilisticexpialidocious_".repeat(8);
const files = {
  "/plan.json": JSON.stringify(plan),
  "/history.json": JSON.stringify(history),
  "/stress-plan.json": JSON.stringify(stress.plan),
  "/stress-history.json": JSON.stringify(stress.history),
};
const page0 = `<!doctype html><html data-color-mode="light"><head><meta charset="utf-8"><style>body{margin:0;font:14px -apple-system,sans-serif}</style></head><body><script type="module" src="/.tmp/harness/harness.js"></script></body></html>`;
const srv = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page0);
  if (files[u.pathname]) return res.writeHead(200, { "content-type": "application/json" }).end(files[u.pathname]);
  try {
    const body = readFileSync("." + u.pathname);
    res.writeHead(200, { "content-type": u.pathname.endsWith(".woff2") ? "font/woff2" : "text/javascript" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const cases = [];
for (const data of ["real", "stress"])
  for (const vw of [320, 1280])
    for (const forced of vw === 1280 ? [null, 640] : [null])
      for (const theme of ["light", "dark"]) {
        for (const story of ["collapsed", "expanded", "all"]) cases.push({ data, vw, forced, theme, story });
        // v0.6.2: stale banner (file list open) and the Restart review confirm, with the Restart button in the tab row
        for (const extra of ["banner", "confirm"]) cases.push({ data, vw, forced, theme, story: "expanded", extra });
        // v0.6.3: the "Aa" font popover open, on the Review and the Graph tab
        // v0.6.5: Graph tab: full panel height, opens on step 1 at a readable zoom, no arrowheads
        cases.push({ data, vw, forced, theme, story: "expanded", extra: "graph" });
        for (const extra of ["fontpop", "graph-fontpop"]) cases.push({ data, vw, forced, theme, story: "expanded", extra, font: "jetbrains", size: "large" });
      }
// v0.6.3: every bundled font at every size (light theme, both widths, worst-case data)
for (const font of ["default", "jetbrains", "fira", "iosevka", "opendyslexic"])
  for (const size of ["small", "default", "large"])
    for (const vw of [320, 1280])
      for (const data of ["real", "stress"]) {
        cases.push({ data, vw, forced: null, theme: "light", story: "expanded", font, size });
        // v0.6.6: "Use for all panel text" (headings, why-lines, reasons in the font too)
        if (font !== "default") cases.push({ data, vw, forced: null, theme: "light", story: "expanded", font, size, ui: true });
      }
for (const c of cases) {
  const p = await browser.newPage({ viewport: { width: c.vw, height: 900 }, deviceScaleFactor: 1 });
  p.on("pageerror", (e) => (console.error("pageerror", e.message), failures++));
  const pre = c.data === "stress" ? "stress-" : "";
  await p.goto(`http://localhost:${port}/?plan=/${pre}plan.json&history=/${pre}history.json&story=${c.story === "collapsed" ? 0 : 1}${c.extra === "banner" ? "&stale=1" : ""}${c.font ? `&font=${c.font}&size=${c.size}` : ""}${c.ui ? "&ui=1" : ""}`);
  await p.waitForFunction(() => window.__ready);
  if (c.theme === "dark") await p.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
  await p.evaluate(() => window.__w.toggle("bubble"));
  await p.waitForFunction(() => window.__shadow.querySelector(".tl, .fbtn .cm"), undefined, { timeout: 5000 });
  if (c.forced) await p.evaluate((w) => (window.__shadow.querySelector(".panel").style.width = w + "px"), c.forced);
  const path = c.data === "stress" ? longPath : target;
  await p.evaluate((path) => window.__w.select(path, true), path);
  if (c.story === "all") await p.evaluate(() => window.__shadow.querySelector(".tlmore").click());
  if (c.extra === "banner") {
    await p.waitForFunction(() => window.__shadow.querySelector(".stalebar"), undefined, { timeout: 5000 });
    await p.evaluate(() => window.__shadow.querySelector('.stalebar [data-act="show"]').click());
  }
  if (c.extra === "confirm") {
    await p.evaluate((path) => window.__w.select(path, true), path); // tick something so Restart is enabled
    await p.evaluate(() => window.__shadow.querySelector(".step.open .next").click());
    await p.evaluate(() => window.__shadow.querySelector(".tabbar .restart").click());
  }
  if (c.extra === "graph") {
    await p.evaluate(() => window.__shadow.querySelector("#prl-tab-graph").click());
    await sleep(300);
  }
  const graphOk = c.extra !== "graph" ? true : await p.evaluate(() => {
    const s = window.__shadow;
    const panel = s.querySelector(".panel");
    const canvas = s.querySelector(".gv-canvas").getBoundingClientRect();
    const m = /translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)/.exec(s.querySelector(".g-root").getAttribute("transform") ?? "");
    const band = s.querySelector(".g-band text").getBoundingClientRect();
    const fullHeight = Math.abs(panel.getBoundingClientRect().height - parseFloat(panel.style.maxHeight)) < 2;
    const r = { fullHeight, k: m ? +m[3] : 0, y: m ? +m[2] : NaN, bandVisible: band.top >= canvas.top - 1 && band.bottom <= canvas.bottom && band.left >= canvas.left - 1, markers: s.querySelectorAll(".gv marker, .gv [marker-end]").length, primary: !!s.querySelector(".gv-bar .gv-primary") };
    return r.fullHeight && r.k >= 0.7 && r.y === 0 && r.bandVisible && !r.markers && r.primary ? true : JSON.stringify(r);
  });
  if (c.extra?.endsWith("fontpop")) {
    if (c.extra === "graph-fontpop") await p.evaluate(() => window.__shadow.querySelector("#prl-tab-graph").click());
    await p.evaluate(() => window.__shadow.querySelector(".tabbar .fontbtn").click());
  }
  await p.evaluate(() => document.fonts.ready.then(() => true));
  await sleep(150);
  const fontOk = await p.evaluate(([font, ui]) => {
    const fam = { jetbrains: "CodeSloth JetBrains Mono", fira: "CodeSloth Fira Code", iosevka: "CodeSloth Iosevka", opendyslexic: "CodeSloth OpenDyslexic Mono" }[font];
    if (!fam) return true;
    const loaded = (f) => document.fonts.check(`12px "${f}"`) && [...document.fonts].some((x) => x.family.replace(/"/g, "") === f && x.status === "loaded");
    const s = window.__shadow;
    const code = loaded(fam) && getComputedStyle(s.querySelector(".fname")).fontFamily.includes(fam);
    const uiFam = font === "opendyslexic" ? "CodeSloth OpenDyslexic" : fam;
    const whyFam = getComputedStyle(s.querySelector(".why, .step .sh .h")).fontFamily;
    const uiOk = ui ? loaded(uiFam) && whyFam.startsWith(`"${uiFam}"`) : !whyFam.includes("CodeSloth");
    return code && uiOk;
  }, [c.font, !!c.ui]);
  const r = await p.evaluate(() => {
    const s = window.__shadow;
    const panel = s.querySelector(".panel").getBoundingClientRect();
    const body = s.querySelector(".pane.body");
    const bad = [];
    for (const e of s.querySelectorAll(".panel *")) {
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || e.closest("[hidden]")) continue;
      if (b.right > panel.right + 0.5 || b.left < panel.left - 0.5) bad.push(`${e.tagName.toLowerCase()}.${[...e.classList].join(".")} [${Math.round(b.left - panel.left)}..${Math.round(b.right - panel.left)}] of ${Math.round(panel.width)}`);
    }
    const tl = s.querySelectorAll(".tl .tc").length;
    const tog = s.querySelector("li.file.sel .tltog");
    const more = s.querySelector(".tlmore");
    const rs = s.querySelector(".tabbar .restart");
    const lbl = rs?.querySelector(".lbl");
    const state = {
      expanded: tog?.getAttribute("aria-expanded"),
      more: more?.textContent ?? null,
      restart: rs && !rs.hidden ? (lbl && getComputedStyle(lbl).display !== "none" ? "label" : "icon") : "hidden",
      banner: !!s.querySelector(".stalebar #prl-stale-list:not([hidden])"),
      confirm: !!s.querySelector(".restart-note [data-act=clear]"),
      fontBtn: (() => { const b = s.querySelector(".tabbar .fontbtn"); return !!b && b.getBoundingClientRect().width > 0; })(),
      fontPop: (() => { const fp = s.querySelector(".fontpop"); return !!fp && !fp.hidden && fp.querySelectorAll('[role="radio"]').length === 8 && fp.contains(s.activeElement); })(),
    };
    // Rects are in zoomed px (Large/Small text size uses CSS zoom), line-height is not.
    const zoom = parseFloat(getComputedStyle(s.querySelector(".review")).zoom) || 1;
    const clamp = [...s.querySelectorAll(".tmsg")].every((m) => m.getBoundingClientRect().height <= (2 * parseFloat(getComputedStyle(m).lineHeight || "18") + 2) * zoom && m.title);
    const latest = s.querySelector("li.file.sel .latest");
    // "← Previous" sits on the CTA's row, to its left; label or icon-only, never wrapping or overflowing.
    const nx = s.querySelector(".step.open .next");
    const pv = s.querySelector(".step.open .prev");
    const prev = !nx ? "n/a" : !pv ? "missing" : (() => {
      const a = pv.getBoundingClientRect(), b = nx.getBoundingClientRect(), row = pv.parentElement.getBoundingClientRect();
      const sameRow = Math.abs(a.top - b.top) < 2 && a.right <= b.left + 0.5 && a.left >= row.left - 0.5 && b.right <= row.right + 0.5;
      const l = pv.querySelector(".lbl");
      return sameRow ? (getComputedStyle(l).display === "none" ? "icon" : "label") : "broken";
    })();
    return { prev, state, bad: bad.slice(0, 6), scroll: [body.scrollWidth, body.clientWidth, body.scrollLeft], tl, clamp, latestOneLine: latest ? latest.getBoundingClientRect().height < 24 && !!latest.title : false, cta: !!s.querySelector(".step.open .next") };
  });
  const onGraph = c.extra === "graph-fontpop" || c.extra === "graph";
  const wantTl = c.extra === "confirm" || onGraph ? r.tl : { collapsed: 0, expanded: 3, all: 13 }[c.story];
  const wantMore = c.extra === "confirm" || onGraph ? r.state.more : { collapsed: null, expanded: "+ 10 earlier commits · Show all 13", all: "Show fewer" }[c.story];
  const panelW = c.forced ?? Math.min(400, c.vw - 32);
  const extraOk = r.state.restart === (onGraph ? "hidden" : panelW <= 320 ? "icon" : "label") && r.state.fontBtn && fontOk && (c.extra !== "banner" || r.state.banner) && (c.extra !== "confirm" || r.state.confirm) && (!c.extra?.endsWith("fontpop") || r.state.fontPop) && graphOk === true;
  const ok = extraOk && (onGraph || c.extra === "confirm" || r.prev === "label" || r.prev === "icon" || (r.prev === "n/a" && !r.cta)) && !r.bad.length && (onGraph || (r.scroll[0] <= r.scroll[1] && r.scroll[2] === 0)) && r.tl === wantTl && r.state.more === wantMore && (c.extra === "confirm" || onGraph || (r.state.expanded === String(c.story !== "collapsed") && r.latestOneLine)) && r.clamp;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.data} vw=${c.vw}${c.forced ? ` panel=${c.forced}` : ""} ${c.theme} ${c.extra ?? c.story}${c.font ? ` ${c.font}/${c.size}${c.ui ? "/ui" : ""}` : ""} restart=${r.state.restart} prev=${r.prev} font=${fontOk}${graphOk === true ? "" : ` graph=${graphOk}`}: scroll ${r.scroll.join("/")}, timeline ${r.tl}, clamp ${r.clamp}, latest ${r.latestOneLine}, cta ${r.cta}${r.bad.length ? "\n     " + r.bad.join("\n     ") : ""}`);
  if (shotsDir) await p.screenshot({ path: `${shotsDir}/${c.data}-${c.vw}${c.forced ? "-" + c.forced : ""}-${c.theme}-${c.extra ?? c.story}${c.font ? `-${c.font}-${c.size}${c.ui ? "-ui" : ""}` : ""}.png` });
  await p.close();
}
await browser.close();
srv.close();
console.log(failures ? `${failures} failure(s)` : "no horizontal overflow");
process.exit(failures ? 1 : 0);
