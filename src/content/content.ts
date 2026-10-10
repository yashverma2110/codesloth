/**
 * Content script on github.com. Detects PR pages (GitHub is a SPA, so we watch URL changes),
 * mounts a small "Layers" button that opens the side panel, and handles "jump to file" requests
 * from the panel using GitHub's URL anchors (#diff-<sha256(path)>) rather than DOM selectors.
 * It never calls api.github.com; all API traffic goes through the service worker.
 */
import { diffAnchor, parsePrUrl } from "../shared/pr-url";
import type { TabMessage } from "../shared/messages";

const BTN_ID = "pr-layers-open-btn";
let lastUrl = "";

function ensureButton() {
  const pr = parsePrUrl(location.href);
  const existing = document.getElementById(BTN_ID);
  if (!pr) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const b = document.createElement("button");
  b.id = BTN_ID;
  b.type = "button";
  b.textContent = "☰ Layers";
  b.title = "Open PR Layers side panel";
  Object.assign(b.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483000",
    padding: "6px 12px",
    borderRadius: "16px",
    border: "1px solid rgba(31,35,40,.15)",
    background: "#1f883d",
    color: "#fff",
    font: "600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    cursor: "pointer",
    boxShadow: "0 1px 3px rgba(0,0,0,.2)",
  } satisfies Partial<CSSStyleDeclaration>);
  b.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openPanel" }).catch(() => {});
  });
  document.body.appendChild(b);
}

function onUrlMaybeChanged() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  ensureButton();
  chrome.runtime.sendMessage({ type: "pr:changed", pr: parsePrUrl(location.href), url: location.href }).catch(() => {});
}

async function jumpTo(path: string): Promise<boolean> {
  const anchor = await diffAnchor(path);
  const pr = parsePrUrl(location.href);
  if (!pr) return false;
  const onFiles = /\/pull\/\d+\/(files|changes)(\/|$)/.test(location.pathname);
  if (!onFiles) {
    location.href = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}/files#${anchor}`;
    return true;
  }
  // Setting the hash lets GitHub's own router expand/scroll to the file (works with virtualized diffs).
  if (location.hash === `#${anchor}`) history.replaceState(null, "", location.pathname + location.search);
  location.hash = anchor;
  const el = document.getElementById(anchor) ?? document.querySelector(`[data-tagsearch-path="${CSS.escape(path)}"]`);
  el?.scrollIntoView({ block: "start" });
  return true;
}

chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
  if (msg?.type === "jump") {
    jumpTo(msg.path).then(sendResponse, () => sendResponse(false));
    return true;
  }
  if (msg?.type === "whereAmI") {
    sendResponse({ url: location.href, pr: parsePrUrl(location.href) });
    return false;
  }
  return false;
});

document.addEventListener("turbo:load", onUrlMaybeChanged);
window.addEventListener("popstate", onUrlMaybeChanged);
setInterval(onUrlMaybeChanged, 1000);
onUrlMaybeChanged();
