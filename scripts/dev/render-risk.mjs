// Headless renders of the v0.7.0 risky-changes UI (real widget code, mocked chrome.runtime).
// Usage: node scripts/dev/render-risk.mjs <outdir>
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";

const out = process.argv[2] ?? ".tmp/render-risk";
mkdirSync(out, { recursive: true });
mkdirSync(".tmp/harness", { recursive: true });
await build({ entryPoints: ["src/dev/harness.ts"], bundle: true, format: "esm", outfile: ".tmp/harness/harness.js", target: "chrome120", logLevel: "warning" });
const page = (mode) => `<!doctype html><html data-color-mode="${mode}"><head><meta charset="utf-8"><style>body{margin:0;font:14px -apple-system,sans-serif;background:${mode === "dark" ? "#0d1117" : "#fff"};color:#59636e}</style></head><body><script type="module" src="/.tmp/harness/harness.js"></script></body></html>`;
const srv = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page(u.searchParams.get("mode") ?? "light"));
  let body;
  try {
    body = readFileSync("." + u.pathname);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": u.pathname.endsWith(".js") ? "text/javascript" : u.pathname.endsWith(".woff2") ? "font/woff2" : "application/json" }).end(body);
}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(q, mode = "light", h = 1000) {
  const p = await browser.newPage({ viewport: { width: 1280, height: h }, deviceScaleFactor: 2 });
  p.on("pageerror", (e) => console.error("pageerror", e.message));
  await p.goto(`http://localhost:${port}/?mode=${mode}&${q}`);
  await p.waitForFunction(() => window.__ready);
  await p.evaluate(() => window.__w.toggle("bubble"));
  await sleep(300);
  return p;
}
async function shot(p, name) {
  await p.mouse.move(5, 5);
  await sleep(300);
  const box = await p.evaluate(() => {
    const r = window.__shadow.querySelector(".panel").getBoundingClientRect();
    return { x: r.x - 12, y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 };
  });
  await p.screenshot({ path: `${out}/${name}.png`, clip: box });
  console.log("frame", `${out}/${name}.png`);
}
// 1) Demo (fastapi/fastapi#16403): banner + list, _runtime.py selected with its findings.
for (const mode of ["light", "dark"]) {
  const p = await open("", mode, 1500);
  await p.evaluate(() => window.__w.loadDemo(false));
  await sleep(200);
  await p.evaluate(() => window.__shadow.querySelector('.stalebar [data-act="dismiss"]').click());
  await p.evaluate(() => window.__shadow.querySelector(".step.open .sh").click());
  await p.evaluate(() => window.__shadow.querySelector('[data-act="risk-list"]').click());
  await p.evaluate(() => window.__w.select("fastapi/telemetry/_runtime.py", true));
  await sleep(200);
  await p.evaluate(() => (window.__shadow.querySelector(".pane.body").scrollTop = 0));
  await shot(p, `review-demo-risk-${mode}`);
  await p.close();
}
// 2) Real public sample go-gitea/gitea#39426: the amber file selected, list open.
for (const mode of ["light", "dark"]) {
  const p = await open("plan=/test/fixtures/overflow/gitea-39426-plan.json&history=/test/fixtures/overflow/gitea-39426-history.json", mode, 1500);
  await p.waitForFunction(() => window.__shadow.querySelector(".riskbar"));
  await p.evaluate(() => window.__shadow.querySelector('[data-act="risk-list"]').click());
  await p.evaluate(() => window.__w.select("modules/hostmatcher/hostmatcher.go", true));
  await sleep(200);
  await p.evaluate(() => (window.__shadow.querySelector(".pane.body").scrollTop = 0));
  await shot(p, `risky-gitea-${mode}`);
  // filter on
  await p.evaluate(() => window.__shadow.querySelector('[data-act="risk-filter"]').click());
  await shot(p, `risky-gitea-filter-${mode}`);
  await p.close();
}
// 3) ILLUSTRATIVE red fixture: migration file selected; then the graph tab.
for (const mode of ["light", "dark"]) {
  const p = await open("plan=/test/fixtures/risk/red-plan.json", mode, 1500);
  await p.waitForFunction(() => window.__shadow.querySelector(".riskbar"));
  await p.evaluate(() => window.__shadow.querySelector('[data-act="risk-list"]').click());
  await p.evaluate(() => window.__w.select("repository/migrations/002_create_quota_budgets.sql", true));
  await sleep(200);
  await p.evaluate(() => (window.__shadow.querySelector(".pane.body").scrollTop = 0));
  await shot(p, `risky-red-${mode}`);
  await p.evaluate(() => window.__shadow.querySelector("#prl-tab-graph").click());
  await sleep(500);
  await shot(p, `risky-red-graph-${mode}`);
  await p.close();
}
await browser.close();
srv.close();
