import type { AnalyzeResult, AuthStatus, Broadcast, PRRef } from "../shared/messages";
import { send } from "../shared/messages";
import { parsePrUrl, prKey } from "../shared/pr-url";
import type { Layer } from "../engine/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let currentPr: PRRef | null = null;
let currentTabId: number | undefined;
let lastResult: AnalyzeResult | null = null;
let busy = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshAuth(): Promise<AuthStatus> {
  const s = await send<AuthStatus>({ type: "auth:status" });
  $("auth").textContent = s.method === "pat" ? `@${s.login ?? "token"} · read-only` : "no token";
  $("onboard").hidden = s.method !== "none";
  return s;
}

async function syncPr(url?: string) {
  const tab = await activeTab();
  currentTabId = tab?.id;
  const pr = parsePrUrl(url ?? tab?.url);
  const changed = !currentPr || !pr || prKey(pr) !== prKey(currentPr);
  currentPr = pr;
  ($("refresh") as HTMLButtonElement).disabled = !pr;
  $("prline").textContent = pr ? `${pr.owner}/${pr.repo} #${pr.number}` : "Open a pull request on github.com.";
  if (changed) {
    lastResult = null;
    $("layers").replaceChildren();
    $("warnings").replaceChildren();
    if (pr) void run(false);
  }
}

async function run(force: boolean) {
  if (!currentPr || busy) return;
  const auth = await refreshAuth();
  if (auth.method === "none") {
    $("status").textContent = "";
    return;
  }
  busy = true;
  ($("refresh") as HTMLButtonElement).disabled = true;
  $("status").textContent = "Analyzing…";
  const pr = currentPr;
  try {
    const res = await send<AnalyzeResult>({ type: "analyze", pr, force });
    if (!currentPr || prKey(currentPr) !== prKey(pr)) return;
    lastResult = res;
    await render(res);
    const r = res.rate ? ` · API ${res.rate.remaining}/${res.rate.limit}` : "";
    $("status").textContent = `${res.fromCache ? "cached" : "fresh"} @ ${res.meta.headSha.slice(0, 7)}${r}`;
  } catch (e) {
    const err = e as Error & { code?: string };
    $("status").replaceChildren(el("span", { class: "err" }, err.message));
    if (err.code === "no_token" || err.code === "unauthorized") $("onboard").hidden = false;
  } finally {
    busy = false;
    ($("refresh") as HTMLButtonElement).disabled = !currentPr;
    ($("refresh") as HTMLButtonElement).textContent = "Re-analyze";
  }
}

const reviewKey = (r: AnalyzeResult) => `reviewed:${prKey(r.pr)}@${r.meta.headSha}`;

async function render(res: AnalyzeResult) {
  $("prline").textContent = `${res.pr.owner}/${res.pr.repo} #${res.pr.number}: ${res.meta.title}`;
  const w = $("warnings");
  w.replaceChildren(
    el("div", { class: "muted" }, `${res.plan.stats.files} files · +${res.plan.stats.additions}/−${res.plan.stats.deletions} · ${res.plan.layers.length} layers · ${res.plan.stats.edges} dependency links`),
    ...res.plan.warnings.map((x) => el("div", { class: "warn" }, "⚠ " + x)),
  );
  const reviewed = ((await chrome.storage.local.get(reviewKey(res)))[reviewKey(res)] as Record<string, boolean> | undefined) ?? {};
  $("layers").replaceChildren(...res.plan.layers.map((l, i) => renderLayer(l, i, reviewed, res)));
}

function renderLayer(l: Layer, i: number, reviewed: Record<string, boolean>, res: AnalyzeResult) {
  const done = !!reviewed[l.id];
  const d = el("details", { class: "layer" + (done ? " done" : "") });
  if (!done && i < 2) d.setAttribute("open", "");
  const cb = el("input", { type: "checkbox", title: "Mark layer reviewed" }) as HTMLInputElement;
  cb.checked = done;
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", async () => {
    reviewed[l.id] = cb.checked;
    await chrome.storage.local.set({ [reviewKey(res)]: reviewed });
    d.classList.toggle("done", cb.checked);
    if (cb.checked) d.removeAttribute("open");
  });
  d.append(
    el(
      "summary",
      {},
      cb,
      el("span", { class: "idx" }, `L${i}`),
      el("span", { class: "title" }, l.title),
      el("span", { class: "stats" }, `${l.stats.files} · `, el("span", { class: "add" }, `+${l.stats.additions}`), " ", el("span", { class: "del" }, `−${l.stats.deletions}`)),
    ),
    el("div", { class: "desc" }, l.description),
  );
  const ul = el("ul", { class: "files" });
  for (const f of l.files) {
    const slash = f.path.lastIndexOf("/");
    const st = { added: "A", removed: "D", renamed: "R", modified: "M", copied: "C", changed: "M", unchanged: "·" }[f.status];
    const li = el(
      "li",
      { class: "file", title: f.previousPath ? `renamed from ${f.previousPath}` : f.path },
      el("div", { class: "path" }, el("span", { class: "st" }, st), el("span", { class: "dir" }, slash >= 0 ? f.path.slice(0, slash + 1) : ""), f.path.slice(slash + 1), " ", el("span", { class: "add" }, `+${f.additions}`), " ", el("span", { class: "del" }, `−${f.deletions}`)),
      el("div", { class: "reason" }, f.reason),
    );
    li.addEventListener("click", () => jump(f.path));
    ul.append(li);
  }
  d.append(ul);
  return d;
}

async function jump(path: string) {
  if (currentTabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(currentTabId, { type: "jump", path });
  } catch {
    // Content script not present (e.g. tab loaded before install): navigate directly.
    if (currentPr) {
      const { diffAnchor } = await import("../shared/pr-url");
      await chrome.tabs.update(currentTabId, { url: `https://github.com/${currentPr.owner}/${currentPr.repo}/pull/${currentPr.number}/files#${await diffAnchor(path)}` });
    }
  }
}

$("refresh").addEventListener("click", () => run(true));
$("setup").addEventListener("click", () => send({ type: "openOnboarding" }));

chrome.runtime.onMessage.addListener((msg: Broadcast, sender) => {
  if (msg?.type === "progress" && currentPr && prKey(msg.pr) === prKey(currentPr)) $("status").textContent = msg.text;
  if (msg?.type === "pr:changed" && sender.tab?.id === currentTabId) void syncPr(msg.url);
});
chrome.tabs.onActivated.addListener(() => void syncPr());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === currentTabId && info.url) void syncPr(info.url);
});
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && "auth.pat" in c) void refreshAuth().then(() => {
    if (currentPr && !lastResult) void run(false);
  });
});

void refreshAuth().then(() => syncPr());
