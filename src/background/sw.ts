import config from "../../config/extension.config.json";
import { analyze, ENGINE_VERSION, filesNeedingContents } from "../engine/analyze";
import type { LayerPlan, PRFile } from "../engine/types";
import type { AnalyzeResult, Broadcast, PRMeta, PRRef, Request, Response } from "../shared/messages";
import { clearToken, getStatus, getToken, saveToken, validateToken } from "./auth";
import { analysisKey, cacheClear, cacheGet, cachePut } from "./cache";
import { GitHubClient, GitHubError, pool } from "./github";

const client = new GitHubClient(getToken);
const ONBOARDING = "onboarding.html";

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async (details) => {
  await refreshBadge();
  if (details.reason === "install" || (await getStatus()).method === "none") {
    chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING) });
  }
});
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "auth.pat" in changes) refreshBadge();
});

async function refreshBadge() {
  const s = await getStatus();
  await chrome.action.setBadgeText({ text: s.method === "none" ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d1242f" });
  await chrome.action.setTitle({ title: s.method === "none" ? "PR Layers: set up a read-only token" : `PR Layers (@${s.login ?? "token set"})` });
}

function broadcast(msg: Broadcast) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // panel may be closed
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

async function runAnalysis(pr: PRRef, force = false): Promise<AnalyzeResult> {
  if (!(await getToken())) throw new GitHubError("No token set. Open setup to add a read-only token.", 401, "no_token");
  const progress = (text: string) => broadcast({ type: "progress", pr, text });

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
  switch (msg.type) {
    case "auth:status":
      return getStatus();
    case "auth:validate":
      return validateToken(msg.token, msg.testRepo);
    case "auth:save":
      return saveToken(msg.token, msg.testRepo, msg.attested);
    case "auth:clear":
      await clearToken();
      return true;
    case "openOnboarding":
      await chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING) });
      return true;
    case "analyze":
      return runAnalysis(msg.pr, msg.force);
    case "openPanel": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) throw new Error("No tab");
      await chrome.sidePanel.open({ tabId });
      return true;
    }
    case "cache:clear":
      await cacheClear();
      return true;
  }
}

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || !("type" in msg)) return false;
  if (["progress", "pr:changed"].includes((msg as { type: string }).type)) return false;
  // Only accept messages from our own extension pages / content scripts.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(
    (data) => sendResponse({ ok: true, data } satisfies Response),
    (e: unknown) => {
      const err = e as GitHubError;
      sendResponse({ ok: false, error: err?.message ?? String(e), code: err?.code } satisfies Response);
    },
  );
  return true;
});
