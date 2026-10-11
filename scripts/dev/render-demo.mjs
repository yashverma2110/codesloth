// Render the real widget headlessly (mocked chrome.runtime, real sample plans) to PNG frames.
// Usage: node scripts/dev/render-demo.mjs <outdir>
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { extname } from "node:path";

const out = process.argv[2] ?? ".tmp/render";
mkdirSync(out, { recursive: true });
mkdirSync(".tmp/harness", { recursive: true });
await build({ entryPoints: ["src/dev/harness.ts"], bundle: true, format: "esm", outfile: ".tmp/harness/harness.js", target: "chrome120", logLevel: "warning" });
const page0 = `<!doctype html><html data-color-mode="light"><head><meta charset="utf-8"><style>body{margin:0;font:14px -apple-system,sans-serif;background:#fff;color:#59636e}</style></head><body><p style="padding:16px">Headless render of the PR Layers widget (real code, real sample plan; chrome.runtime mocked).</p><script type="module" src="/.tmp/harness/harness.js"></script></body></html>`;
const srv = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page0);
  try {
    const body = readFileSync("." + u.pathname);
    res.writeHead(200, { "content-type": extname(u.pathname) === ".js" ? "text/javascript" : "application/json" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = srv.address().port;
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });

async function open(q, size = { width: 1280, height: 860 }) {
  const p = await browser.newPage();
  await p.setViewport({ ...size, deviceScaleFactor: 2 });
  p.on("pageerror", (e) => console.error("pageerror", e.message));
  await p.goto(`http://localhost:${port}/?${q}`);
  await p.waitForFunction(() => window.__ready);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (p, fn, ...a) => p.evaluate(fn, ...a);
const frames = [];
async function shot(p, name) {
  await sleep(250);
  const f = `${out}/${name}.png`;
  await p.screenshot({ path: f });
  frames.push(f);
  console.log("frame", f);
}

// 1) Review tab in demo mode (bundled fastapi sample) + the 5 tour steps.
{
  const p = await open("tour=1");
  await sh(p, () => window.__w.toggle("bubble"));
  await sleep(300);
  await shot(p, "01-setup");
  await sh(p, () => [...window.__shadow.querySelectorAll(".setup .btn")].find((b) => b.textContent === "Try demo").click());
  for (let i = 0; i < 5; i++) {
    await shot(p, `0${2 + i}-tour-${i + 1}`);
    await sh(p, () => [...window.__shadow.querySelectorAll(".tour-card button")].find((b) => /Next|Done/.test(b.textContent)).click());
  }
  await shot(p, "07-review");
  await sh(p, () => window.__shadow.querySelector("#prl-tab-graph").click());
  await shot(p, "08-graph-tab");
  await p.close();
}
// 2) Graph overlay for a bigger real PR (gitea), light + dark.
for (const theme of ["light", "dark"]) {
  const p = await open(`plan=/.tmp/gitea-plan.json`, { width: 1440, height: 960 });
  await sh(p, (t) => document.documentElement.setAttribute("data-color-mode", t), theme);
  if (theme === "dark") await sh(p, () => (document.body.style.background = "#0d1117"));
  await sh(p, () => window.__w.toggle("bubble"));
  await p.waitForFunction(() => window.__shadow.querySelectorAll("li.file").length > 0);
  await sh(p, () => window.__shadow.querySelector("#prl-tab-graph").click());
  await sleep(300);
  await sh(p, () => [...window.__shadow.querySelectorAll(".gv-bar button")].find((b) => /Expand/.test(b.textContent)).click());
  await sleep(400);
  await shot(p, `graph-gitea-${theme}`);
  if (theme === "light") {
    // hover a node to show neighbour highlighting
    const box = await sh(p, () => {
      const n = [...window.__shadow.querySelectorAll(".overlay .g-node")].find((x) => x.getAttribute("data-id").endsWith("models/actions/run.go")) ?? window.__shadow.querySelector(".overlay .g-node");
      const r = n.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await p.mouse.move(box.x, box.y);
    await shot(p, "graph-gitea-hover");
  }
  await p.close();
}
await browser.close();
srv.close();
console.log(JSON.stringify(frames));
