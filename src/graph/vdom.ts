/**
 * Tiny SVG/HTML tree used so the same rendering code can produce a string (static export, tests)
 * or real DOM nodes (in the page) without innerHTML. This keeps us clear of Trusted Types / CSP
 * sinks on github.com.
 */
export interface VNode {
  tag: string;
  attrs: Record<string, string | number | undefined>;
  children: (VNode | string)[];
}

export function h(tag: string, attrs: Record<string, string | number | undefined> = {}, ...children: (VNode | string | false | null | undefined)[]): VNode {
  return { tag, attrs, children: children.filter((c): c is VNode | string => c !== false && c !== null && c !== undefined) };
}

const escText = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const escAttr = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function toString(n: VNode | string): string {
  if (typeof n === "string") return escText(n);
  const a = Object.entries(n.attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escAttr(String(v))}"`)
    .join("");
  // <style> content must not be escaped.
  const inner = n.tag === "style" ? n.children.map((c) => (typeof c === "string" ? c : toString(c))).join("") : n.children.map(toString).join("");
  return `<${n.tag}${a}>${inner}</${n.tag}>`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function toDom(n: VNode | string, doc: Document = document): Node {
  if (typeof n === "string") return doc.createTextNode(n);
  const el = doc.createElementNS(SVG_NS, n.tag);
  for (const [k, v] of Object.entries(n.attrs)) if (v !== undefined && k !== "xmlns") el.setAttribute(k, String(v));
  for (const c of n.children) el.appendChild(toDom(c, doc));
  return el;
}
