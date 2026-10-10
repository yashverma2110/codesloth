import { extractJsImports } from "./js";

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;

/** Extract the contents of every <script> / <script setup> block in a Vue SFC. */
export function extractVueScripts(sfc: string): { attrs: string; content: string }[] {
  const blocks: { attrs: string; content: string }[] = [];
  for (const m of sfc.matchAll(SCRIPT_RE)) blocks.push({ attrs: m[1] ?? "", content: m[2] ?? "" });
  return blocks;
}

/** Imports from all <script> blocks, plus <script src="..."> and <style src="..."> references. */
export function extractVueImports(sfc: string): string[] {
  const out = new Set<string>();
  for (const b of extractVueScripts(sfc)) {
    const src = SRC_ATTR_RE.exec(b.attrs);
    if (src) out.add(src[1]);
    for (const s of extractJsImports(b.content)) out.add(s);
  }
  for (const m of sfc.matchAll(/<style\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) out.add(m[1]);
  return [...out];
}
