import config from "../../config/extension.config.json";
import { analyze, ENGINE_VERSION, filesNeedingContents } from "../engine/analyze";
import type { LayerPlan, PRFile } from "../engine/types";
import type { AnalyzeResult, PRMeta, PRRef, Request, Response, TabMessage } from "../shared/messages";
import { isAllowedSender, PREF_KEYS, SESSION_PREF_KEYS } from "../shared/messages";

/** Session-scoped prefs (e.g. timeline expanded) live in storage.session; the rest in storage.local. */
const prefArea = (key: string): chrome.storage.StorageArea => (SESSION_PREF_KEYS.includes(key) && chrome.storage.session ? chrome.storage.session : chrome.storage.local);
import { diffAnchor } from "../shared/pr-url";
import { parsePrUrl } from "../shared/pr-url";
import { clearToken, getStatus, getToken, saveToken, validateToken } from "./auth";
import { analysisKey, cacheClear, cacheGet, cachePut } from "./cache";
import { GitHubClient, GitHubError, pool } from "./github";
import { fetchHistory } from "./history-fetch";
import type { CommitHistory } from "../shared/history";

const HISTORY_VERSION = 1;

const client = new GitHubClient(getToken);
const ONBOARDING = "onboarding.html";

// Keep the token (and everything else in storage.local) out of content scripts entirely.
// Content scripts reach position / reviewed state through messages instead.
try {
  void chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" as chrome.storage.AccessLevel })?.catch?.(() => {});
} catch {
  /* older browsers: content scripts still never read storage */
}

const POSITION_KEY = "widget.position";
const REVIEWED_PREFIX = "reviewed:";

/** Open the onboarding/options page; openOptionsPage can be missing or fail in some Chromium forks. */
async function openOnboarding() {
  try {
    if (chrome.runtime.openOptionsPage) {
      await chrome.runtime.openOptionsPage();
      return;
    }
  } catch {
    /* fall through */
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING) });
}

/** Ask the content script in a tab to toggle the widget, injecting it first if the tab predates install. */
async function toggleInTab(tab: chrome.tabs.Tab | undefined, source: "toolbar" | "shortcut") {
  if ((await getStatus()).method === "none") return openOnboarding();
  if (!tab?.id || !parsePrUrl(tab.url)) {
    await chrome.action.setBadgeText({ tabId: tab?.id, text: "PR?" }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab?.id, text: "" }).catch(() => {}), 2000);
    return;
  }
  const msg: TabMessage = { type: "widget:toggle", source };
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      /* page not scriptable */
    }
  }
}

chrome.action.onClicked.addListener((tab) => void toggleInTab(tab, "toolbar"));
chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-widget") return;
  const t = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  await toggleInTab(t, "shortcut");
});

async function notifyGitHubTabs(msg: TabMessage) {
  const tabs = await chrome.tabs.query({ url: "https://github.com/*" });
  await Promise.all(tabs.map((t) => (t.id ? chrome.tabs.sendMessage(t.id, msg).catch(() => {}) : undefined)));
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await refreshBadge();
  if (details.reason === "install" || (await getStatus()).method === "none") {
    await openOnboarding();
  }
});
chrome.runtime.onStartup.addListener(refreshBadge);

async function refreshBadge() {
  const s = await getStatus();
  await chrome.action.setBadgeText({ text: s.method === "none" ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d1242f" });
  await chrome.action.setTitle({ title: s.method === "none" ? "PR Layers: set up a read-only token" : `PR Layers (@${s.login ?? "token set"})` });
}


interface CachedAnalysis {
  meta: PRMeta;
  files: PRFile[];
  contents: Record<string, string>;
  gitattributes?: string;
  goMods: Record<string, string>;
  plan: LayerPlan;
  engineVersion: string;
  at: number;
}

async function getRawCached(pr: PRRef, path: string, ref: string, blobSha?: string | null): Promise<string | undefined> {
  if (blobSha) {
    const hit = await cacheGet<string>("blobs", blobSha);
    if (hit !== undefined) return hit;
  }
  const text = await client.getRaw(pr, path, ref);
  if (text !== undefined && blobSha) await cachePut("blobs", blobSha, text);
  return text;
}

async function runAnalysis(pr: PRRef, force = false, tabId?: number): Promise<AnalyzeResult> {
  if (!(await getToken())) throw new GitHubError("No token set. Open setup to add a read-only token.", 401, "no_token");
  const progress = (text: string) => {
    if (tabId !== undefined) chrome.tabs.sendMessage(tabId, { type: "progress", pr, text } satisfies TabMessage).catch(() => {});
  };

  progress("Fetching PR…");
  const etagKey = `pr:${pr.owner}/${pr.repo}/${pr.number}`;
  const prev = await cacheGet<{ etag: string; meta: PRMeta }>("etags", etagKey);
  const r = await client.getPR(pr, force ? undefined : prev?.etag);
  const meta = r === "not-modified" ? prev!.meta : r.meta;
  if (r !== "not-modified" && r.etag) await cachePut("etags", etagKey, { etag: r.etag, meta });

  const key = analysisKey(pr.owner, pr.repo, pr.number, meta.headSha);
  if (!force) {
    const cached = await cacheGet<CachedAnalysis>("analysis", key);
    if (cached && cached.engineVersion === ENGINE_VERSION) return { pr, meta, plan: cached.plan, fromCache: true, rate: client.rate };
  }

  progress(`Listing ${meta.changedFiles} changed files…`);
  const { files, truncated } = await client.listFiles(pr, (n) => progress(`Listed ${n}/${meta.changedFiles} files…`));

  const want = filesNeedingContents(files, config.maxFilesToFetchContents);
  const contents: Record<string, string> = {};
  let done = 0;
  progress(`Reading ${want.length} files for imports…`);
  const shaOf = new Map(files.map((f) => [f.filename, f.sha]));
  await pool(want, config.contentFetchConcurrency, async (path) => {
    try {
      const t = await getRawCached(pr, path, meta.headSha, shaOf.get(path));
      if (t !== undefined) contents[path] = t;
    } catch (e) {
      if (e instanceof GitHubError && e.code.includes("rate_limited")) throw e;
    }
    done++;
    if (done % 10 === 0) progress(`Read ${done}/${want.length} files…`);
  });

  const gitattributes = await client.getRaw(pr, ".gitattributes", meta.headSha).catch(() => undefined);
  const goMods: Record<string, string> = {};
  if (files.some((f) => f.filename.endsWith(".go"))) {
    const paths = new Set(["go.mod", ...files.filter((f) => /(^|\/)go\.mod$/.test(f.filename) && f.status !== "removed").map((f) => f.filename)]);
    for (const p of paths) {
      const t = await client.getRaw(pr, p, meta.headSha).catch(() => undefined);
      if (t) goMods[p] = t;
    }
  }

  progress("Building layers…");
  const plan = analyze({ files, contents, gitattributes, goMods });
  if (truncated) plan.warnings.unshift(`GitHub's files API returns at most 3000 files; this PR has ${meta.changedFiles}. Layers cover the first 3000.`);
  if (want.length >= config.maxFilesToFetchContents)
    plan.warnings.push(`Read full contents for the first ${config.maxFilesToFetchContents} modified code files only (configurable).`);

  await cachePut<CachedAnalysis>("analysis", key, { meta, files, contents, gitattributes, goMods, plan, engineVersion: ENGINE_VERSION, at: Date.now() });
  return { pr, meta, plan, fromCache: false, rate: client.rate };
}

async function handle(msg: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const fromContent = !!sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""));
  switch (msg.type) {
    case "auth:status": {
      const s = await getStatus();
      // Content scripts get only what the UI needs: never the token or its hint.
      return fromContent ? { method: s.method, login: s.login } : s;
    }
    case "auth:validate":
      return validateToken(msg.token, msg.testRepo);
    case "auth:save": {
      const r = await saveToken(msg.token, msg.testRepo, msg.attested);
      if (r.saved) {
        await refreshBadge();
        await notifyGitHubTabs({ type: "auth:changed" });
      }
      return r;
    }
    case "auth:clear":
      await clearToken();
      await refreshBadge();
      await notifyGitHubTabs({ type: "auth:changed" });
      return true;
    case "openOnboarding":
      await openOnboarding();
      return true;
    case "analyze":
      return runAnalysis(msg.pr, msg.force, sender.tab?.id);
    case "widget:getPosition":
      return (await chrome.storage.local.get(POSITION_KEY))[POSITION_KEY] ?? null;
    case "widget:setPosition":
      await chrome.storage.local.set({ [POSITION_KEY]: msg.position });
      return true;
    case "reviewed:get": {
      const k = REVIEWED_PREFIX + msg.key;
      return (await chrome.storage.local.get(k))[k] ?? {};
    }
    case "reviewed:set":
      await chrome.storage.local.set({ [REVIEWED_PREFIX + msg.key]: msg.value });
      return true;
    case "prefs:get": {
      if (!PREF_KEYS.includes(msg.key)) throw new Error("Unknown preference");
      const k = `pref.${msg.key}`;
      return (await prefArea(msg.key).get(k))[k] ?? null;
    }
    case "prefs:set":
      if (!PREF_KEYS.includes(msg.key)) throw new Error("Unknown preference");
      await prefArea(msg.key).set({ [`pref.${msg.key}`]: msg.value });
      return true;
    case "history:get": {
      const key = `history:${HISTORY_VERSION}:${analysisKey(msg.pr.owner, msg.pr.repo, msg.pr.number, msg.headSha)}`;
      const hit = await cacheGet<CommitHistory>("analysis", key);
      if (hit) return hit;
      const h = await fetchHistory(client, msg.pr, msg.paths, { totalCommits: msg.commits, concurrency: config.contentFetchConcurrency });
      await cachePut("analysis", key, h);
      return h;
    }
    case "graph:openTab": {
      const q = new URLSearchParams({ owner: msg.pr.owner, repo: msg.pr.repo, number: String(msg.pr.number) });
      if (msg.headSha) q.set("sha", msg.headSha);
      if (msg.demo) q.set("demo", "1");
      if (sender.tab?.id !== undefined) q.set("tab", String(sender.tab.id));
      await chrome.tabs.create({ url: chrome.runtime.getURL(`graph.html?${q}`), index: sender.tab ? sender.tab.index + 1 : undefined });
      return true;
    }
    case "graph:getPlan": {
      const cached = await cacheGet<CachedAnalysis>("analysis", analysisKey(msg.pr.owner, msg.pr.repo, msg.pr.number, msg.headSha));
      if (!cached) throw new Error("No analysis cached for this PR yet. Open the PR and run PR Layers first.");
      return { pr: msg.pr, meta: cached.meta, plan: cached.plan, fromCache: true } satisfies AnalyzeResult;
    }
    case "graph:jump": {
      try {
        await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.tabs.sendMessage(msg.tabId, { type: "jump", path: msg.path } satisfies TabMessage);
      } catch {
        const url = `https://github.com/${msg.pr.owner}/${msg.pr.repo}/pull/${msg.pr.number}/files#${await diffAnchor(msg.path)}`;
        await chrome.tabs.create({ url });
      }
      return true;
    }
    case "cache:clear":
      await cacheClear();
      return true;
  }
}

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || !("type" in msg)) return false;
  // Only our own extension pages may use the full API; our content scripts get a small allow-list.
  if (!isAllowedSender(msg, sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
    sendResponse({ ok: false, error: "Not allowed", code: "forbidden_sender" } satisfies Response);
    return false;
  }
  handle(msg, sender).then(
    (data) => sendResponse({ ok: true, data } satisfies Response),
    (e: unknown) => {
      const err = e as GitHubError;
      sendResponse({ ok: false, error: err?.message ?? String(e), code: err?.code } satisfies Response);
    },
  );
  return true;
});
