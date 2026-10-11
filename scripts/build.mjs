import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, minify: false, sourcemap: false, target: "chrome116", logLevel: "info", legalComments: "none" };
await build({ ...common, entryPoints: { background: "src/background/sw.ts" }, format: "esm", outdir: out });
await build({ ...common, entryPoints: { content: "src/content/content.ts" }, format: "iife", outdir: out });
await build({ ...common, entryPoints: { onboarding: "src/options/onboarding.ts" }, format: "esm", outdir: out, splitting: false });
await build({ ...common, entryPoints: { "graph-page": "src/graph-page/graph-page.ts" }, format: "esm", outdir: out, splitting: false });

cpSync("public", out, { recursive: true });
for (const f of ["src/options/onboarding.html", "src/options/onboarding.css", "src/graph-page/graph.html", "src/graph-page/graph.css"]) {
  cpSync(f, `${out}/${f.split("/").pop()}`);
}
console.log("built ->", out);
