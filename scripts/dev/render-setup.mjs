// Headless render of the real setup page (dist/onboarding.html) with a stubbed chrome.* API, Organisation tab open.
// Usage: npm run build && node scripts/dev/render-setup.mjs out.png [light|dark]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { chromium } from "playwright-core";

const out = process.argv[2] ?? ".tmp/setup-org.png";
const theme = process.argv[3] ?? "light";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const srv = createServer((req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname;
    const body = readFileSync("dist" + p);
    res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const page = await browser.newPage({ viewport: { width: 860, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.addInitScript(() => {
  const store = {};
  window.chrome = {
    runtime: { sendMessage: async (m) => (m.type === "auth:status" ? { ok: true, data: { method: "none" } } : { ok: true, data: null }), getURL: (p) => p },
    storage: { local: { get: async () => ({}), set: async (o) => Object.assign(store, o), remove: async () => {} } },
    tabs: { create: () => {} },
  };
});
await page.goto(`http://localhost:${srv.address().port}/onboarding.html`);
await page.click("#tab-org");
await page.waitForTimeout(200);
// Crop to step 1 (tabs, org steps, troubleshooting) and the start of step 2 with the privacy note.
const box = await page.evaluate(() => {
  const a = document.querySelector("h1").getBoundingClientRect();
  const b = document.querySelector("[data-privacy]:not(#current [data-privacy])").getBoundingClientRect();
  return { x: 0, y: Math.max(0, a.top + scrollY - 12), width: document.documentElement.clientWidth, height: b.bottom - a.top + 28 };
});
await page.screenshot({ path: out, fullPage: true, clip: box });
console.log("wrote", out, JSON.stringify(box));
await browser.close();
srv.close();
