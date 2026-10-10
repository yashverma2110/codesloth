import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, minify: false, sourcemap: false, target: "chrome116", logLevel: "info", legalComments: "none" };
await build({ ...common, entryPoints: { background: "src/background/sw.ts" }, format: "esm", outdir: out });
await build({ ...common, entryPoints: { content: "src/content/content.ts" }, format: "iife", outdir: out });
await build({ ...common, entryPoints: { panel: "src/panel/panel.ts", onboarding: "src/options/onboarding.ts" }, format: "esm", outdir: out, splitting: false });

cpSync("public", out, { recursive: true });
for (const f of ["src/panel/panel.html", "src/panel/panel.css", "src/options/onboarding.html", "src/options/onboarding.css"]) {
  cpSync(f, `${out}/${f.split("/").pop()}`);
}
console.log("built ->", out);
