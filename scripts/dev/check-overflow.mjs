// Regression check (headless Chrome, real layout): the Review panel must never overflow horizontally,
// even with very long commit messages and file names. Exit code 1 on any overflow.
// Usage: node scripts/dev/check-overflow.mjs [--shots <dir>]
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
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
    res.writeHead(200, { "content-type": "text/javascript" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = srv.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const cases = [];
for (const data of ["real", "stress"]) for (const vw of [320, 1280]) for (const forced of vw === 1280 ? [null, 640] : [null]) for (const theme of ["light", "dark"]) cases.push({ data, vw, forced, theme });
for (const c of cases) {
  const p = await browser.newPage();
  await p.setViewport({ width: c.vw, height: 900, deviceScaleFactor: 1 });
  p.on("pageerror", (e) => (console.error("pageerror", e.message), failures++));
  const pre = c.data === "stress" ? "stress-" : "";
  await p.goto(`http://localhost:${port}/?plan=/${pre}plan.json&history=/${pre}history.json`);
  await p.waitForFunction(() => window.__ready);
  if (c.theme === "dark") await p.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
  await p.evaluate(() => window.__w.toggle("bubble"));
  await p.waitForFunction(() => window.__shadow.querySelector(".tl, .fbtn .cm"), { timeout: 5000 });
  if (c.forced) await p.evaluate((w) => (window.__shadow.querySelector(".panel").style.width = w + "px"), c.forced);
  const path = c.data === "stress" ? longPath : target;
  await p.evaluate((path) => window.__w.select(path, true), path);
  await sleep(150);
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
    const clamp = [...s.querySelectorAll(".tmsg")].every((m) => m.getBoundingClientRect().height <= 2 * parseFloat(getComputedStyle(m).lineHeight || "18") + 2 && m.title);
    const latest = s.querySelector("li.file.sel .latest");
    return { bad: bad.slice(0, 6), scroll: [body.scrollWidth, body.clientWidth, body.scrollLeft], tl, clamp, latestOneLine: latest ? latest.getBoundingClientRect().height < 24 && !!latest.title : false, cta: !!s.querySelector(".step.open .next") };
  });
  const ok = !r.bad.length && r.scroll[0] <= r.scroll[1] && r.scroll[2] === 0 && r.tl > 1 && r.clamp && r.latestOneLine;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.data} vw=${c.vw}${c.forced ? ` panel=${c.forced}` : ""} ${c.theme}: scroll ${r.scroll.join("/")}, timeline ${r.tl}, clamp ${r.clamp}, latest ${r.latestOneLine}, cta ${r.cta}${r.bad.length ? "\n     " + r.bad.join("\n     ") : ""}`);
  if (shotsDir) await p.screenshot({ path: `${shotsDir}/${c.data}-${c.vw}${c.forced ? "-" + c.forced : ""}-${c.theme}.png` });
  await p.close();
}
await browser.close();
srv.close();
console.log(failures ? `${failures} failure(s)` : "no horizontal overflow");
process.exit(failures ? 1 : 0);
